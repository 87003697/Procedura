"""Render AO-only multi-angle views of a mesh using Blender Cycles.

Invoked as:
    blender --background --python scripts/_render_ao_blender.py -- \
        --mesh <path> --out <dir> [--z-up] [--samples N] [--size S] [--ao-dist D]

Setup matches the classic "matte white + world AO" look:
  - Principled BSDF, white, roughness 1.0, no specular (diffuse only)
  - World shader: Ambient Occlusion -> Background -> World Output
  - Cycles renderer, denoising on
"""
import argparse
import math
import os
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

# scripts/_blender_gpu.py is a sibling of this script; Blender does not put the
# script's own directory on sys.path when invoked with --python.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _blender_gpu import enable_gpu  # noqa: E402


def parse_args():
    argv = sys.argv
    argv = argv[argv.index("--") + 1 :] if "--" in argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--mesh", default=None,
                   help="Single mesh path — rendered uniform grey AO. "
                        "Mutually exclusive with --meshes.")
    p.add_argument("--meshes", nargs="+", default=None,
                   help="Per-part coloured meshes as '<path>:<r>,<g>,<b>' tokens "
                        "(RGB in 0..1). Each part is AO-shaded then tinted by its "
                        "colour. Mutually exclusive with --mesh.")
    p.add_argument("--out", required=True)
    p.add_argument("--out-prefix", default="ao", dest="out_prefix",
                   help="Output filename prefix: '<prefix>-<view>.png'. Default 'ao'.")
    p.add_argument("--samples", type=int, default=128)
    p.add_argument("--size", type=int, default=1024)
    p.add_argument("--z-up", action="store_true", dest="z_up")
    p.add_argument("--ao-dist", type=float, default=0.0,
                   help="AO distance in world units; 0 = auto (20%% bbox diagonal)")
    p.add_argument("--ao-samples", type=int, default=16,
                   help="Secondary AO ray samples per shading sample")
    p.add_argument("--bg", type=float, default=0.92,
                   help="Background value 0..1")
    p.add_argument("--mode", default="emission", choices=("emission", "world-ao"),
                   help="'emission' = AO-in-material (reliable); "
                        "'world-ao' = user-described AO-node-in-world + matte white")
    p.add_argument("--shading", default="ao", choices=("ao", "normal"),
                   help="'ao' = the standard matte-white ambient-occlusion look "
                        "(default; unchanged). 'normal' = camera-space normals "
                        "as colour, i.e. a normal-map render: no lighting, no AO "
                        "rays, image is a pure function of surface orientation. "
                        "Used to judge SHAPE without the AO/line-art appearance "
                        "confound, and it renders much faster.")
    p.add_argument("--edges", action="store_true",
                   help="Overlay Freestyle line art (silhouette + crease + border)")
    p.add_argument("--edge-mode", default="freestyle", dest="edge_mode",
                   choices=("freestyle", "compositor"),
                   help="'freestyle' = stroke-based line art (highest quality, "
                        "CPU-heavy per frame); 'compositor' = Sobel edges from "
                        "the normal+depth passes (near-free per frame — use for "
                        "--sweep video renders on heavy meshes).")
    p.add_argument("--edge-normal-thresh", type=float, default=3.0,
                   dest="edge_normal_thresh",
                   help="compositor mode: Sobel magnitude on the normal pass "
                        "above which a crease edge is drawn")
    p.add_argument("--edge-depth-thresh", type=float, default=0.08,
                   dest="edge_depth_thresh",
                   help="compositor mode: Sobel magnitude on the normalised "
                        "depth pass above which an occlusion edge is drawn")
    p.add_argument("--edge-thickness", type=float, default=1.5, dest="edge_thickness")
    p.add_argument("--edge-dilate", type=int, default=0, dest="edge_dilate",
                   help="compositor mode only: grow the edge mask by N pixels "
                        "so strokes read at video scale (Sobel edges are 1px "
                        "regardless of resolution). 0 = off.")
    p.add_argument("--edge-crease", type=float, default=140.0, dest="edge_crease",
                   help="Crease angle in degrees; edges with dihedral < this are drawn")
    p.add_argument("--gpu", action="store_true")
    p.add_argument("--decimate-above", type=int, default=0, dest="decimate_above",
                   help="If the imported mesh(es) exceed this total vertex count, "
                        "add a collapse Decimate modifier (render-time only, never "
                        "written to disk) so Freestyle's edge view-map doesn't OOM "
                        "on 100k-500k-tri native meshes (TRELLIS/Hunyuan/UltraShape). "
                        "0 = off (default; CAD meshes stay well under any threshold).")
    p.add_argument("--rot-z", type=float, default=0.0, dest="rot_z",
                   help="Rotate the imported mesh around Z (degrees) before "
                        "rendering. Useful when the model's 'front' axis "
                        "doesn't match the script's -Y front-view convention.")
    p.add_argument("--views", default="isometric,front,right,top",
                   help="Comma-separated subset of the named views to render "
                        "(see all_angles in main(): 6 faces, 8 iso corners, "
                        "4 diagonals, 2 tilts). Default: isometric,front,right,top.")
    p.add_argument("--sweep", default=None,
                   help="Turntable sweep (model yaw in degrees): 'START:END:FRAMES' "
                        "or a waypoint path 'W0,W1,...:FRAMES' (e.g. '0,-45,45:151'). "
                        "Renders FRAMES stills '<prefix>-sweep-f####.png' by orbiting "
                        "the camera of the FIRST --views entry around Z, smoothstep-"
                        "eased per segment (zero yaw velocity at every waypoint). One "
                        "fixed camera distance fits every frame (no zoom breathing). "
                        "Replaces the normal per-view stills.")
    return p.parse_args(argv)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def parse_mesh_spec(token: str):
    """Parse a '<mesh_path>:<r>,<g>,<b>' token into (path, (r, g, b))."""
    if ":" not in token:
        raise SystemExit(f"--meshes token missing ':rgb': {token!r}")
    path, rgb = token.rsplit(":", 1)
    parts = rgb.split(",")
    if len(parts) != 3:
        raise SystemExit(f"--meshes RGB must be 'r,g,b': {token!r}")
    return path, (float(parts[0]), float(parts[1]), float(parts[2]))


def import_mesh(path: str, z_up: bool):
    # Snapshot existing objects so we can return ONLY the meshes this import
    # added — critical when loading several part meshes in turn (otherwise we
    # would re-return every previously-imported object each call).
    before = set(bpy.data.objects)
    ext = Path(path).suffix.lower()
    if ext == ".obj":
        # For trimesh-exported Z-up OBJ, set axes so no rotation is applied.
        if z_up:
            bpy.ops.wm.obj_import(filepath=path, forward_axis="Y", up_axis="Z")
        else:
            bpy.ops.wm.obj_import(filepath=path)
    elif ext == ".stl":
        bpy.ops.wm.stl_import(filepath=path)
    elif ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    else:
        raise SystemExit(f"Unsupported extension: {ext}")
    objs = [o for o in bpy.data.objects if o not in before and o.type == "MESH"]
    if not objs:
        raise SystemExit(f"No meshes imported from {path}")
    return objs


def compute_bbox(objs):
    corners = []
    for o in objs:
        for v in o.bound_box:
            corners.append(o.matrix_world @ Vector(v))
    lo = Vector((min(v.x for v in corners),
                 min(v.y for v in corners),
                 min(v.z for v in corners)))
    hi = Vector((max(v.x for v in corners),
                 max(v.y for v in corners),
                 max(v.z for v in corners)))
    return lo, hi


def center_objects(objs, center):
    for o in objs:
        o.location -= center
    # Force matrix_world to reflect the new o.location immediately. Without
    # this, subsequent code that reads o.matrix_world (like the camera-fit
    # pass) sees the stale pre-centering transform and mis-frames the mesh.
    bpy.context.view_layer.update()


def make_ao_emission_material(distance: float, samples: int, rgb=None):
    """AO → (× colour) → Emission → Output.

    With `rgb=None` the emitted pixel equals the raw AO factor (grey), the
    classic matte-AO look. With an `rgb` tint the AO factor is multiplied by
    the part colour, so each part keeps its crevice/contact shading but reads
    in its own hue (occluded areas darken toward black, exposed areas toward
    the full colour). The multiply is an explicit Vector Math node so the
    result is independent of the AO node's own colour-input semantics.
    """
    mat = bpy.data.materials.new(name="AOEmit")
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    ao = nt.nodes.new("ShaderNodeAmbientOcclusion")
    ao.samples = samples
    ao.only_local = False
    ao.inside = False
    ao.inputs["Distance"].default_value = distance
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Strength"].default_value = 1.0
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    if rgb is None:
        nt.links.new(ao.outputs["Color"], em.inputs["Color"])
    else:
        mul = nt.nodes.new("ShaderNodeVectorMath")
        mul.operation = "MULTIPLY"
        mul.inputs[1].default_value = (rgb[0], rgb[1], rgb[2])
        nt.links.new(ao.outputs["Color"], mul.inputs[0])
        nt.links.new(mul.outputs["Vector"], em.inputs["Color"])
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    return mat


def make_matte_white_material():
    """Classic user-described setup: Principled BSDF, white, roughness 1."""
    mat = bpy.data.materials.new(name="MatteWhite")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (1.0, 1.0, 1.0, 1.0)
    bsdf.inputs["Roughness"].default_value = 1.0
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = 0.0
    for key in ("Specular IOR Level", "Specular"):
        if key in bsdf.inputs:
            bsdf.inputs[key].default_value = 0.0
            break
    return mat


def make_normal_material():
    """Camera-space normals as colour — a "normal map" render.

    Geometry.Normal is world-space, so it is transformed into camera space
    before the [-1,1] -> [0,1] remap; without that the colours rotate with the
    camera and two views of the same surface disagree. Emission means no
    lighting, no AO rays and no view-dependent shading: the image is a pure
    function of surface orientation, which is the point of using it to judge
    shape. It also renders far faster than the AO+Freestyle rig.
    """
    mat = bpy.data.materials.new(name="NormalMap")
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    xf = nt.nodes.new("ShaderNodeVectorTransform")
    xf.vector_type = "VECTOR"
    xf.convert_from = "WORLD"
    xf.convert_to = "CAMERA"
    mul = nt.nodes.new("ShaderNodeVectorMath")
    mul.operation = "MULTIPLY"
    mul.inputs[1].default_value = (0.5, 0.5, 0.5)
    add = nt.nodes.new("ShaderNodeVectorMath")
    add.operation = "ADD"
    add.inputs[1].default_value = (0.5, 0.5, 0.5)
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Strength"].default_value = 1.0
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(geo.outputs["Normal"], xf.inputs["Vector"])
    nt.links.new(xf.outputs["Vector"], mul.inputs[0])
    nt.links.new(mul.outputs["Vector"], add.inputs[0])
    nt.links.new(add.outputs["Vector"], em.inputs["Color"])
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    return mat


def assign_material(objs, mat):
    for o in objs:
        o.data.materials.clear()
        o.data.materials.append(mat)


def setup_world_flat(value: float):
    """Flat white-ish world. For emission-AO materials the world is mostly
    irrelevant (material emits its own color), but a light-gray background
    reads well in the final image."""
    world = bpy.data.worlds.new("FlatWorld")
    bpy.context.scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Color"].default_value = (value, value, value, 1.0)
    bg.inputs["Strength"].default_value = 1.0
    out = nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])


def setup_world_ao(ao_dist: float, ao_samples: int):
    """Alternative world route: AO shader plugged directly into background.
    Pairs with a matte-white material instead of emission."""
    world = bpy.data.worlds.new("AOWorld")
    bpy.context.scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    ao = nt.nodes.new("ShaderNodeAmbientOcclusion")
    ao.samples = ao_samples
    ao.only_local = False
    ao.inside = False
    ao.inputs["Distance"].default_value = ao_dist
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = 1.0
    out = nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(ao.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])


def setup_freestyle(thickness: float, crease_deg: float):
    """Enable Freestyle line art on top of Cycles render."""
    scene = bpy.context.scene
    scene.render.use_freestyle = True
    scene.render.line_thickness_mode = "ABSOLUTE"
    scene.render.line_thickness = thickness

    vl = scene.view_layers[0]
    vl.use_freestyle = True
    vl.freestyle_settings.crease_angle = math.radians(crease_deg)

    fs = vl.freestyle_settings
    if len(fs.linesets) == 0:
        fs.linesets.new("LineSet")
    ls = fs.linesets[0]
    ls.select_silhouette = True
    ls.select_crease = True
    ls.select_border = True
    ls.select_contour = True
    ls.select_external_contour = True
    ls.select_edge_mark = False

    style = ls.linestyle
    if style is None:
        style = bpy.data.linestyles.new("EdgeStyle")
        ls.linestyle = style
    style.color = (0.0, 0.0, 0.0)
    style.alpha = 1.0
    style.thickness = thickness


def _comp_abs_channel_sum(nt, img_out):
    """Σ|channel| of a compositor colour socket — sign-safe edge magnitude
    (Sobel output is signed per channel; a plain RGB→BW average could cancel)."""
    sep = nt.nodes.new("CompositorNodeSeparateColor")
    nt.links.new(img_out, sep.inputs["Image"])
    total = None
    for ch in ("Red", "Green", "Blue"):
        a = nt.nodes.new("CompositorNodeMath")
        a.operation = "ABSOLUTE"
        nt.links.new(sep.outputs[ch], a.inputs[0])
        if total is None:
            total = a
        else:
            s = nt.nodes.new("CompositorNodeMath")
            s.operation = "ADD"
            nt.links.new(total.outputs[0], s.inputs[0])
            nt.links.new(a.outputs[0], s.inputs[1])
            total = s
    return total.outputs[0]


def _comp_ramp(nt, val_out, t0: float, t1: float):
    """Clamped linear ramp t0→0, t1→1 — a soft threshold so edge pixels keep
    some anti-aliasing instead of a hard binary mask."""
    mr = nt.nodes.new("CompositorNodeMapRange")
    mr.use_clamp = True
    nt.links.new(val_out, mr.inputs["Value"])
    mr.inputs["From Min"].default_value = t0
    mr.inputs["From Max"].default_value = t1
    return mr.outputs["Value"]


def setup_compositor_edges(depth_scale: float,
                           normal_thresh: float = 3.0,
                           depth_thresh: float = 0.08,
                           dilate: int = 0):
    """Screen-space line art: Sobel on the normal pass (creases) + Sobel on the
    clamped/normalised depth pass (silhouettes & occlusion boundaries),
    multiplied into the image as black strokes.

    Freestyle recomputes its view map on the CPU every frame — minutes per
    frame on multi-million-triangle CAD meshes — while these passes fall out
    of the render for free, so this is the edge mode for --sweep videos.
    `depth_scale` must comfortably exceed the farthest visible depth (e.g.
    camera distance + bbox diagonal); background depth clamps to it, keeping
    the mask deterministic across frames (no per-frame auto-normalise flicker).
    """
    scene = bpy.context.scene
    vl = scene.view_layers[0]
    vl.use_pass_normal = True
    vl.use_pass_z = True
    scene.use_nodes = True
    nt = scene.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    rl = nt.nodes.new("CompositorNodeRLayers")

    # Crease edges: normals change abruptly across a hard edge. The soft
    # threshold sits above the facet-to-facet normal steps of tessellated
    # curved surfaces (a few degrees) but below real creases (≳45°).
    sob_n = nt.nodes.new("CompositorNodeFilter")
    sob_n.filter_type = "SOBEL"
    nt.links.new(rl.outputs["Normal"], sob_n.inputs["Image"])
    n_mag = _comp_abs_channel_sum(nt, sob_n.outputs["Image"])
    n_mask = _comp_ramp(nt, n_mag, normal_thresh * 0.7, normal_thresh * 1.3)

    # Silhouette / occlusion edges: depth discontinuities. Clamp-then-divide
    # by the fixed depth_scale (background depth is huge).
    clamp = nt.nodes.new("CompositorNodeMath")
    clamp.operation = "MINIMUM"
    clamp.inputs[1].default_value = depth_scale
    depth_sock = rl.outputs["Depth" if "Depth" in rl.outputs else "Z"]
    nt.links.new(depth_sock, clamp.inputs[0])
    div = nt.nodes.new("CompositorNodeMath")
    div.operation = "DIVIDE"
    div.inputs[1].default_value = depth_scale
    nt.links.new(clamp.outputs[0], div.inputs[0])
    sob_d = nt.nodes.new("CompositorNodeFilter")
    sob_d.filter_type = "SOBEL"
    nt.links.new(div.outputs[0], sob_d.inputs["Image"])
    d_mag = _comp_abs_channel_sum(nt, sob_d.outputs["Image"])
    d_mask = _comp_ramp(nt, d_mag, depth_thresh * 0.7, depth_thresh * 1.3)

    mask = nt.nodes.new("CompositorNodeMath")
    mask.operation = "MAXIMUM"
    nt.links.new(n_mask, mask.inputs[0])
    nt.links.new(d_mask, mask.inputs[1])
    mask_out = mask.outputs[0]

    # Sobel strokes are one pixel wide whatever the resolution, so on a video
    # frame they read far thinner than the Freestyle lines of the still
    # previews — and thinner still once a part shrinks in frame (an explode
    # pulling back, a small component). Dilating the mask is the compositor
    # equivalent of Freestyle's line thickness.
    if dilate > 0:
        grow = nt.nodes.new("CompositorNodeDilateErode")
        grow.mode = "DISTANCE"
        grow.distance = int(dilate)
        nt.links.new(mask_out, grow.inputs[0])
        mask_out = grow.outputs[0]

    # Stamp the edges in as black: mix image → black by the edge mask.
    mix = nt.nodes.new("CompositorNodeMixRGB")
    mix.blend_type = "MIX"
    mix.inputs[2].default_value = (0.0, 0.0, 0.0, 1.0)
    nt.links.new(mask_out, mix.inputs["Fac"])
    nt.links.new(rl.outputs["Image"], mix.inputs[1])

    out = nt.nodes.new("CompositorNodeComposite")
    nt.links.new(mix.outputs["Image"], out.inputs["Image"])


def setup_line_art(thickness: float, crease_deg: float):
    """[Experimental — currently broken: bake is slow and strokes don't
    render reliably. Kept for future reference.] Create a GP object with
    a scene-wide Line Art modifier. See git history for the bake attempt.
    """
    scene = bpy.context.scene
    scene.render.use_freestyle = False
    for vl in scene.view_layers:
        vl.use_freestyle = False

    bpy.ops.object.grease_pencil_add(type="LINEART_SCENE")
    gp_obj = bpy.context.object

    lineart_mod = None
    for m in gp_obj.modifiers:
        if m.type == "GREASE_PENCIL_LINEART":
            lineart_mod = m
            break
    if lineart_mod is None:
        return gp_obj

    lineart_mod.use_contour = True
    lineart_mod.use_loose = False
    lineart_mod.use_crease = True
    lineart_mod.crease_threshold = math.radians(180.0 - crease_deg)
    lineart_mod.use_material = False
    lineart_mod.use_edge_mark = False
    lineart_mod.use_intersection = True
    lineart_mod.thickness = int(max(1, round(thickness)))

    gp_data = gp_obj.data
    if len(gp_data.materials) > 0:
        mat = gp_data.materials[0]
        ink = mat.grease_pencil
        ink.color = (0.0, 0.0, 0.0, 1.0)
        ink.show_stroke = True
        ink.show_fill = False
    return gp_obj


def bake_line_art(gp_obj):
    """Evaluate the Line Art modifier for the current camera and store the
    resulting strokes in GP frames. Must be called AFTER the camera is
    positioned, BEFORE render.render, because Line Art output is
    camera-dependent (silhouettes shift with view direction).
    """
    if gp_obj is None:
        return
    # Select only the GP object and make it active, then bake all its
    # Line Art modifiers into strokes on the current frame.
    for o in bpy.context.scene.objects:
        o.select_set(False)
    gp_obj.select_set(True)
    bpy.context.view_layer.objects.active = gp_obj
    try:
        # Clear any previous bake so successive views don't stack strokes.
        bpy.ops.object.lineart_clear()
    except Exception:
        pass
    try:
        bpy.ops.object.lineart_bake_strokes()
    except Exception as e:
        print(f"[line_art] bake failed: {type(e).__name__}: {e}", flush=True)


def setup_render(size: int, samples: int, use_gpu: bool):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.cycles.preview_samples = samples
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.render.film_transparent = False
    # Reuse BVH/scene graph across renders — only the camera moves between
    # views, so Cycles can skip the per-frame rebuild. Official Cycles
    # feature (docs.blender.org → render/cycles/render_settings/performance).
    scene.render.use_persistent_data = True

    enable_gpu(scene, use_gpu)


def fit_distance_to_mesh(objs, cam_dir_norm, fov_deg: float, padding: float = 1.05):
    """Compute the camera aim point and distance so the full mesh silhouette
    is visible and tightly framed under a perspective projection.

    Perspective-correct fit (every vertex considered, no sampling):
      For each vertex v with screen-plane coords (vx, vy) = (v·x_cam, v·y_cam)
      and depth component rz = v·cam_dir, the perspective constraint that v
      remains inside the frustum with half-FOV tan ht and camera looking at
      aim `(cx·x_cam + cy·y_cam)` from distance d is:

          |vx - cx| <= ht * (d - rz)    and    |vy - cy| <= ht * (d - rz)

      Rearranging the x constraint across all vertices gives a closed form
      for the tightest (d, cx) that admits every vertex:

          d_x = (P_x - Q_x) / (2·ht),    cx = (P_x + Q_x) / 2
          where P_x = max_v(vx + ht·rz),  Q_x = min_v(vx - ht·rz)

      Same for y. Final d is max(d_x, d_y) (the binding axis saturates the
      frame; the other has slack, and the midpoint aim is still optimal).

    Full-vertex numpy pass — no subsampling — so no silhouette extreme is
    ever missed and the mesh is guaranteed to fit entirely inside the frame
    (with a small safety `padding`, default 5%).

    Returns (distance, aim_point) — aim_point lives in the plane through
    the world origin perpendicular to cam_dir, so shifting it doesn't change
    per-vertex depth.
    """
    import numpy as np

    cam_dir = Vector(cam_dir_norm).normalized()
    world_up = Vector((0, 0, 1))
    if abs(cam_dir.dot(world_up)) > 0.99:
        world_up = Vector((0, 1, 0))
    x_cam = world_up.cross(cam_dir).normalized()
    y_cam = cam_dir.cross(x_cam).normalized()
    ht = math.tan(math.radians(fov_deg / 2))

    # Gather every vertex in world space. numpy + foreach_get is fast even
    # for meshes with hundreds of thousands of vertices.
    chunks = []
    for o in objs:
        n = len(o.data.vertices)
        if n == 0:
            continue
        flat = np.empty(n * 3, dtype=np.float32)
        o.data.vertices.foreach_get("co", flat)
        local = flat.reshape(-1, 3)
        M = np.array(o.matrix_world, dtype=np.float32)  # 4x4
        ones = np.ones((n, 1), dtype=np.float32)
        world = (np.concatenate([local, ones], axis=1) @ M.T)[:, :3]
        chunks.append(world)
    if not chunks:
        return 0.1, Vector((0, 0, 0))
    V = np.concatenate(chunks, axis=0)

    xc = np.array([x_cam.x, x_cam.y, x_cam.z], dtype=np.float32)
    yc = np.array([y_cam.x, y_cam.y, y_cam.z], dtype=np.float32)
    dc = np.array([cam_dir.x, cam_dir.y, cam_dir.z], dtype=np.float32)
    vx = V @ xc
    vy = V @ yc
    rz = V @ dc

    P_x = float((vx + ht * rz).max())
    Q_x = float((vx - ht * rz).min())
    P_y = float((vy + ht * rz).max())
    Q_y = float((vy - ht * rz).min())

    d_x = (P_x - Q_x) / (2.0 * ht)
    d_y = (P_y - Q_y) / (2.0 * ht)
    # Safety: camera must be strictly in front of the closest vertex.
    rz_max = float(rz.max())
    d = max(d_x, d_y, rz_max + 1e-3, 0.1)

    cx = (P_x + Q_x) / 2.0
    cy = (P_y + Q_y) / 2.0

    aim = x_cam * cx + y_cam * cy
    return d * padding, aim


def fit_ortho_to_mesh(objs, cam_dir_norm, padding: float = 1.05):
    """Orthographic counterpart of `fit_distance_to_mesh`.

    For an ortho camera there is no FOV — the projected silhouette is just
    the AABB of the mesh in the screen-plane basis (x_cam, y_cam). We
    compute that AABB, set the centre as the aim point, and return Blender's
    `ortho_scale` (longest projected axis × padding). The camera distance
    is placed comfortably outside the mesh along `cam_dir` so the clip
    range is never the binding constraint.
    """
    import numpy as np

    cam_dir = Vector(cam_dir_norm).normalized()
    world_up = Vector((0, 0, 1))
    if abs(cam_dir.dot(world_up)) > 0.99:
        world_up = Vector((0, 1, 0))
    x_cam = world_up.cross(cam_dir).normalized()
    y_cam = cam_dir.cross(x_cam).normalized()

    chunks = []
    for o in objs:
        n = len(o.data.vertices)
        if n == 0:
            continue
        flat = np.empty(n * 3, dtype=np.float32)
        o.data.vertices.foreach_get("co", flat)
        local = flat.reshape(-1, 3)
        M = np.array(o.matrix_world, dtype=np.float32)
        ones = np.ones((n, 1), dtype=np.float32)
        world = (np.concatenate([local, ones], axis=1) @ M.T)[:, :3]
        chunks.append(world)
    if not chunks:
        return 1.0, Vector((0, 0, 0)), 1.0
    V = np.concatenate(chunks, axis=0)

    xc = np.array([x_cam.x, x_cam.y, x_cam.z], dtype=np.float32)
    yc = np.array([y_cam.x, y_cam.y, y_cam.z], dtype=np.float32)
    dc = np.array([cam_dir.x, cam_dir.y, cam_dir.z], dtype=np.float32)
    vx = V @ xc
    vy = V @ yc
    rz = V @ dc

    P_x, Q_x = float(vx.max()), float(vx.min())
    P_y, Q_y = float(vy.max()), float(vy.min())
    rz_max = float(rz.max())
    rz_min = float(rz.min())

    span = max(P_x - Q_x, P_y - Q_y, 1e-3)
    ortho_scale = span * padding
    cx = (P_x + Q_x) / 2.0
    cy = (P_y + Q_y) / 2.0
    aim = x_cam * cx + y_cam * cy

    distance = (rz_max - rz_min) + span + 1e-3
    return distance, aim, ortho_scale


def place_camera(pos_norm, objs, fov_deg: float = 45.0, ortho: bool = False):
    """Place a camera using the same screen-plane basis the fit computed.

    We set matrix_world directly (rather than delegating to `to_track_quat`)
    so Blender renders the frame in the exact basis (x_cam, y_cam) that
    `fit_distance_to_mesh` framed against. Otherwise, for oblique views
    (e.g. isometric) Blender's auto `to_track_quat("-Z", "Y")` picks a
    different screen-up axis than our fit — leaving part of the silhouette
    clipped off-frame.

    When `ortho=True` an orthographic projection is used (no FOV); the
    framing comes from `fit_ortho_to_mesh` and is the tightest AABB-aligned
    fit around the mesh silhouette. Use this for engineering elevations
    (front / right / top) where parallel edges should stay parallel.
    """
    cam_dir = Vector(pos_norm).normalized()

    if ortho:
        distance, aim, ortho_scale = fit_ortho_to_mesh(objs, pos_norm)
    else:
        distance, aim = fit_distance_to_mesh(objs, pos_norm, fov_deg)

    # Rebuild our screen basis the same way the fit did.
    world_up = Vector((0, 0, 1))
    if abs(cam_dir.dot(world_up)) > 0.99:
        world_up = Vector((0, 1, 0))
    x_cam = world_up.cross(cam_dir).normalized()
    y_cam = cam_dir.cross(x_cam).normalized()

    cam_data = bpy.data.cameras.new("Cam")
    # Clip planes FITTED to the shot, not 1e-3..1e6.
    #
    # Blender's stock clip_end (100 m) IS too small here — OpenSCAD meshes are
    # in mm, so a 1.5 m robot is 1500 units with the camera ~2500 out, and the
    # default far plane silently clipped it to a black render. The fix for that
    # was 1e6, which overshot in the other direction.
    #
    # That default spans 1e9, and a perspective depth buffer is distributed as
    # ~1/z, so essentially all of its precision sits in the first fraction of a
    # unit and the model lands in depth values that barely differ. EEVEE shades
    # entirely in screen space and reads that buffer, so its occlusion had
    # nothing to resolve: the isometric came out flat, with tyre tread and rim
    # detail erased, while the six ORTHOGRAPHIC views were fine because ortho
    # depth is linear. Cycles ray-traces and never reads it, which is why only
    # EEVEE showed the fault.
    #
    # Fitting to the camera distance costs nothing (measured 3.34s vs 3.25s) and
    # clips nothing: silhouette coverage moved by <=24 px out of 176k-437k.
    _span = max(distance, 1e-3)
    cam_data.clip_start = max(1e-4, _span * 0.01)
    cam_data.clip_end = _span * 10.0
    # Match sensor aspect to render aspect so cam.angle applies symmetrically.
    # Blender's default sensor is 36×24 (aspect 1.5). With a square render and
    # sensor_fit='AUTO', Blender would treat cam.angle as horizontal FOV only
    # and derive a narrower vertical FOV — breaking our fit's assumption that
    # both axes share the same tan(fov/2). Matching sensor to image aspect
    # guarantees symmetric horizontal/vertical FOV.
    scene = bpy.context.scene
    rx = scene.render.resolution_x
    ry = scene.render.resolution_y
    if rx > 0 and ry > 0:
        cam_data.sensor_width = 32.0
        cam_data.sensor_height = 32.0 * (ry / rx)
    cam_data.sensor_fit = "HORIZONTAL"
    if ortho:
        cam_data.type = "ORTHO"
        cam_data.ortho_scale = ortho_scale
    else:
        cam_data.lens_unit = "FOV"
        cam_data.angle = math.radians(fov_deg)
    cam_obj = bpy.data.objects.new("Cam", cam_data)
    bpy.context.collection.objects.link(cam_obj)

    loc = aim + cam_dir * distance
    # Columns of the rotation part are the camera's local X, Y, Z axes in
    # world coords. Blender cameras look along local -Z, so local Z = cam_dir.
    cam_obj.matrix_world = Matrix((
        (x_cam.x, y_cam.x, cam_dir.x, loc.x),
        (x_cam.y, y_cam.y, cam_dir.y, loc.y),
        (x_cam.z, y_cam.z, cam_dir.z, loc.z),
        (0.0, 0.0, 0.0, 1.0),
    ))
    return cam_obj


# ── turntable sweep ─────────────────────────────────────────────────────────
#
# A sweep orbits the camera around world Z at a FIXED distance with the aim
# pinned at the origin (the mesh is bbox-centred there). Per-frame refits
# would re-tighten the framing every frame and the video would "breathe";
# instead we compute, once, the smallest distance that keeps the whole mesh
# in frame at EVERY yaw angle of the sweep.

def sweep_screen_basis(cam_dir):
    """Screen-plane basis (x_cam, y_cam) for a camera direction — the same
    convention `fit_distance_to_mesh` / `place_camera` use."""
    world_up = Vector((0, 0, 1))
    if abs(cam_dir.dot(world_up)) > 0.99:
        world_up = Vector((0, 1, 0))
    x_cam = world_up.cross(cam_dir).normalized()
    y_cam = cam_dir.cross(x_cam).normalized()
    return x_cam, y_cam


def gather_world_vertices(objs):
    """All mesh vertices in world space as one (N,3) float32 array."""
    import numpy as np

    chunks = []
    for o in objs:
        n = len(o.data.vertices)
        if n == 0:
            continue
        flat = np.empty(n * 3, dtype=np.float32)
        o.data.vertices.foreach_get("co", flat)
        local = flat.reshape(-1, 3)
        M = np.array(o.matrix_world, dtype=np.float32)
        ones = np.ones((n, 1), dtype=np.float32)
        chunks.append((np.concatenate([local, ones], axis=1) @ M.T)[:, :3])
    if not chunks:
        return None
    return np.concatenate(chunks, axis=0)


def fit_sweep_distance(V, cam_dir, fov_deg: float):
    """Minimum perspective camera distance with the aim FIXED at the origin.

    With aim at origin the frustum constraint per vertex is
    |vx| <= ht*(d - rz)  →  d >= rz + |vx|/ht (same for y), so the tight
    distance is the max over vertices — no aim-recentring freedom, which is
    exactly what keeps consecutive sweep frames rigid.
    """
    import numpy as np

    x_cam, y_cam = sweep_screen_basis(cam_dir)
    ht = math.tan(math.radians(fov_deg / 2))
    vx = V @ np.array([x_cam.x, x_cam.y, x_cam.z], dtype=np.float32)
    vy = V @ np.array([y_cam.x, y_cam.y, y_cam.z], dtype=np.float32)
    rz = V @ np.array([cam_dir.x, cam_dir.y, cam_dir.z], dtype=np.float32)
    d_x = float((rz + np.abs(vx) / ht).max())
    d_y = float((rz + np.abs(vy) / ht).max())
    return max(d_x, d_y, float(rz.max()) + 1e-3, 0.1)


def place_camera_fixed(cam_dir, distance: float, fov_deg: float = 45.0):
    """Perspective camera at `cam_dir * distance` aimed at the origin.
    Mirrors `place_camera`'s matrix/sensor setup, minus the per-view fit."""
    x_cam, y_cam = sweep_screen_basis(cam_dir)

    cam_data = bpy.data.cameras.new("Cam")
    # Clip planes FITTED to the shot, not 1e-3..1e6.
    #
    # That default spans 1e9, and a perspective depth buffer is distributed as
    # ~1/z, so essentially all of its precision sits in the first fraction of a
    # unit and the model lands in depth values that barely differ. EEVEE shades
    # entirely in screen space and reads that buffer, so its occlusion had
    # nothing to resolve: the isometric came out flat, with tyre tread and rim
    # detail erased, while the six ORTHOGRAPHIC views were fine because ortho
    # depth is linear. Cycles ray-traces and never reads it, which is why only
    # EEVEE showed the fault.
    #
    # Fitting to the camera distance costs nothing (measured 3.34s vs 3.25s) and
    # clips nothing: silhouette coverage moved by <=24 px out of 176k-437k.
    _span = max(distance, 1e-3)
    cam_data.clip_start = max(1e-4, _span * 0.01)
    cam_data.clip_end = _span * 10.0
    scene = bpy.context.scene
    rx = scene.render.resolution_x
    ry = scene.render.resolution_y
    if rx > 0 and ry > 0:
        cam_data.sensor_width = 32.0
        cam_data.sensor_height = 32.0 * (ry / rx)
    cam_data.sensor_fit = "HORIZONTAL"
    cam_data.lens_unit = "FOV"
    cam_data.angle = math.radians(fov_deg)
    cam_obj = bpy.data.objects.new("Cam", cam_data)
    bpy.context.collection.objects.link(cam_obj)

    loc = cam_dir * distance
    cam_obj.matrix_world = Matrix((
        (x_cam.x, y_cam.x, cam_dir.x, loc.x),
        (x_cam.y, y_cam.y, cam_dir.y, loc.y),
        (x_cam.z, y_cam.z, cam_dir.z, loc.z),
        (0.0, 0.0, 0.0, 1.0),
    ))
    return cam_obj


def _smoothstep(t: float) -> float:
    return t * t * (3.0 - 2.0 * t)


def sweep_schedule(spec: str):
    """Parse a '--sweep' spec into the eased per-frame yaw list.

    Formats:
      'START:END:FRAMES'    — one eased segment.
      'W0,W1,...:FRAMES'    — waypoint path (e.g. '0,-45,45:151').

    Transition frames are allocated to segments proportionally to arc length
    (which also equalises peak angular velocity across segments), and each
    segment is smoothstep-eased — yaw velocity is zero at every waypoint, so
    the start, every turnaround, and the end all read as natural camera moves
    rather than mechanical constant-rate spin.
    """
    parts = spec.split(":")
    try:
        if len(parts) == 3:
            waypoints = [float(parts[0]), float(parts[1])]
            nframes = int(parts[2])
        elif len(parts) == 2:
            waypoints = [float(w) for w in parts[0].split(",")]
            nframes = int(parts[1])
        else:
            raise ValueError
    except ValueError:
        raise SystemExit("--sweep must be 'START:END:FRAMES' or "
                         f"'W0,W1,...:FRAMES', got {spec!r}")
    if len(waypoints) < 2 or nframes < 2:
        raise SystemExit("--sweep needs >= 2 waypoints and >= 2 frames")

    seg_lens = [abs(b - a) for a, b in zip(waypoints, waypoints[1:])]
    total = sum(seg_lens)
    if total <= 0:
        raise SystemExit("--sweep waypoints have zero total travel")

    # Frame 0 is waypoint 0; the remaining nframes-1 transition frames are
    # split across segments (each gets at least 1).
    trans = nframes - 1
    alloc = []
    remaining = trans
    for idx, L in enumerate(seg_lens):
        segs_after = len(seg_lens) - idx - 1
        n = remaining if segs_after == 0 else round(trans * L / total)
        n = max(1, min(n, remaining - segs_after))
        alloc.append(n)
        remaining -= n

    thetas = [waypoints[0]]
    for (a, b), n in zip(zip(waypoints, waypoints[1:]), alloc):
        for i in range(1, n + 1):
            thetas.append(a + (b - a) * _smoothstep(i / n))
    return thetas


def run_sweep(args, out_dir, objs, base_dir):
    """Render a '<prefix>-sweep-f####.png' frame sequence orbiting `base_dir`."""
    thetas = sweep_schedule(args.sweep)

    V = gather_world_vertices(objs)
    if V is None:
        raise SystemExit("sweep: scene has no vertices")

    # Model yaw +θ == camera azimuth −θ; the video reads as the MODEL turning.
    dirs = [
        (Matrix.Rotation(math.radians(-t), 3, "Z") @ base_dir).normalized()
        for t in thetas
    ]
    distance = max(fit_sweep_distance(V, d, 45.0) for d in dirs) * 1.05

    if args.edges and args.edge_mode == "compositor":
        diag = float(((V.max(axis=0) - V.min(axis=0)) ** 2).sum() ** 0.5)
        setup_compositor_edges(distance + diag,
                               normal_thresh=args.edge_normal_thresh,
                               depth_thresh=args.edge_depth_thresh,
                               dilate=args.edge_dilate)

    scene = bpy.context.scene
    for i, d in enumerate(dirs):
        cam = place_camera_fixed(d, distance)
        scene.camera = cam
        scene.render.filepath = str(out_dir / f"{args.out_prefix}-sweep-f{i:04d}.png")
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(cam, do_unlink=True)
        print(f"[{args.out_prefix}] sweep f{i:04d} yaw={thetas[i]:+7.2f}: "
              f"{scene.render.filepath}", flush=True)


def main():
    args = parse_args()
    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    reset_scene()

    # Load geometry — either one mesh (uniform grey AO) or a set of per-part
    # coloured meshes. `loaded` pairs each part's object list with its tint
    # (None = uncoloured); materials are built after we know the scene scale.
    if args.meshes:
        loaded = []
        for spec in args.meshes:
            path, rgb = parse_mesh_spec(spec)
            loaded.append((import_mesh(str(Path(path).resolve()), args.z_up), rgb))
    elif args.mesh:
        loaded = [(import_mesh(str(Path(args.mesh).resolve()), args.z_up), None)]
    else:
        raise SystemExit("provide --mesh <path> or --meshes <path:r,g,b> ...")
    objs = [o for grp, _ in loaded for o in grp]

    # Cap Freestyle's edge-view-map cost on very high-poly native meshes: a
    # collapse Decimate modifier renders the reduced mesh but leaves the file on
    # disk untouched (so downstream geometry metrics still see the full mesh).
    if args.decimate_above > 0:
        nv = sum(len(o.data.vertices) for o in objs)
        if nv > args.decimate_above:
            ratio = args.decimate_above / float(nv)
            for o in objs:
                md = o.modifiers.new("ao_decimate", "DECIMATE")
                md.decimate_type = "COLLAPSE"
                md.ratio = ratio

    if args.rot_z:
        rot = Matrix.Rotation(math.radians(args.rot_z), 4, "Z")
        for o in objs:
            o.matrix_world = rot @ o.matrix_world
        bpy.context.view_layer.update()

    lo, hi = compute_bbox(objs)
    center = (lo + hi) * 0.5
    center_objects(objs, center)
    size_vec = hi - lo
    diag = size_vec.length or 1.0

    ao_dist = args.ao_dist if args.ao_dist > 0 else diag * 0.40

    # world-ao is a single-mesh-only legacy route; any coloured render uses the
    # emission route so the AO factor can be tinted per part.
    if args.shading == "normal":
        assign_material(objs, make_normal_material())
        setup_world_flat(0.0)
    elif args.mode == "world-ao" and not args.meshes:
        assign_material(objs, make_matte_white_material())
        setup_world_ao(ao_dist, args.ao_samples)
    else:
        for grp, rgb in loaded:
            assign_material(grp, make_ao_emission_material(ao_dist, args.ao_samples, rgb))
        setup_world_flat(args.bg)
    setup_render(args.size, args.samples, args.gpu)
    if args.edges and args.edge_mode == "freestyle":
        setup_freestyle(args.edge_thickness, args.edge_crease)

    # Blender is Z-up. Front = looking along -Y, top = looking along +Z.
    # Isometric camera sits at (+X, -Y, +Z) so the -Y face (the object's
    # front, per Procedura's coordinate convention) is directly visible to the viewer.
    # This matches the standard engineering isometric convention and the
    # expectation that an "iso hero shot" shows the front + right + top
    # of the object. Cameras placed at (1, 1, 1) look at the back-right
    # octant, which makes -Y project to screen-left and reads as "off".
    # Camera DIRECTION per named view (object → camera; normalised below).
    # The 20-view catalog the refine loop multi-selects from. KEEP IN SYNC with
    # VIEW_CATALOG in src/render/views.ts and _render_parts_color_blender.py.
    # -Y is the object's front (see note above); +Z is up; +X is right.
    _tilt = 0.2679  # tan(15°) — for the front-low / front-high hero tilts
    all_angles = {
        # 6 orthographic faces
        "front":       (0, -1, 0),
        "back":        (0, 1, 0),
        "left":        (-1, 0, 0),
        "right":       (1, 0, 0),
        "top":         (0, 0, 1),
        "bottom":      (0, 0, -1),
        # 8 isometric corners (perspective 3/4)
        "isometric":   (1, -1, 1),
        "iso-FL-top":  (-1, -1, 1),
        "iso-BR-top":  (1, 1, 1),
        "iso-BL-top":  (-1, 1, 1),
        "iso-FR-bot":  (1, -1, -1),
        "iso-FL-bot":  (-1, -1, -1),
        "iso-BR-bot":  (1, 1, -1),
        "iso-BL-bot":  (-1, 1, -1),
        # 4 eye-level diagonals (two adjacent faces, no vertical tilt)
        "front-right": (1, -1, 0),
        "front-left":  (-1, -1, 0),
        "back-right":  (1, 1, 0),
        "back-left":   (-1, 1, 0),
        # 2 front hero tilts (~15° below / above the horizon)
        "front-low":   (0, -1, -_tilt),
        "front-high":  (0, -1, _tilt),
    }
    wanted = [v.strip() for v in args.views.split(",") if v.strip()]
    unknown = [v for v in wanted if v not in all_angles]
    if unknown:
        raise SystemExit(f"Unknown view names: {unknown}. "
                         f"Known: {list(all_angles)}")
    angles = [(name, all_angles[name]) for name in wanted]

    if args.sweep:
        name, pos = angles[0]
        run_sweep(args, out_dir, objs, Vector(pos).normalized())
        return

    # Engineering elevations use orthographic projection (parallel edges
    # stay parallel, no perspective foreshortening — easier to read shapes
    # and proportions). The oblique hero shots stay perspective so they
    # still give a sense of depth.
    ortho_views = {"front", "back", "left", "right", "top", "bottom"}

    if args.edges and args.edge_mode == "compositor":
        # Per-view fits vary the camera distance; 6× the bbox diagonal safely
        # exceeds the farthest visible depth for every catalog view.
        setup_compositor_edges(diag * 6.0,
                               normal_thresh=args.edge_normal_thresh,
                               depth_thresh=args.edge_depth_thresh,
                               dilate=args.edge_dilate)

    scene = bpy.context.scene
    for name, pos in angles:
        cam = place_camera(pos, objs, ortho=(name in ortho_views))
        scene.camera = cam
        scene.render.filepath = str(out_dir / f"{args.out_prefix}-{name}.png")
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(cam, do_unlink=True)
        print(f"[{args.out_prefix}] {name}: {scene.render.filepath}", flush=True)


if __name__ == "__main__":
    main()
