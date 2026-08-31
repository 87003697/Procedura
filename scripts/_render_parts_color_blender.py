"""Render per-part-coloured multi-angle views of a multi-mesh assembly.

Invoked as:
    tools/blender/blender --background --python scripts/_render_parts_color_blender.py -- \\
        --meshes part_a.stl:0.85,0.25,0.25 part_b.stl:0.30,0.65,0.80 ... \\
        --out <dir> [--z-up] [--samples N] [--size S]

Each mesh is loaded as its own Blender object with a Principled BSDF material
tinted to the given RGB triple. The scene uses a soft three-point lighting
rig and a near-white world background, so the colours are the dominant cue
and shading reads cleanly as solid plastic / matte paint.

Camera framing matches `_render_ao_blender.py` (shared view catalog):
  - orthographic faces (front/back/left/right/top/bottom) = tight AABB-fit
  - iso corners / diagonals / tilts = perspective (FOV-fit, 45° lens, 3/4 view)

So the output set is directly comparable to the AO renders.
"""
import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

# scripts/_blender_gpu.py is a sibling of this script; Blender does not put the
# script's own directory on sys.path when invoked with --python.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _blender_gpu import enable_gpu  # noqa: E402


# --------- args ----------------------------------------------------------


def parse_args():
    argv = sys.argv
    argv = argv[argv.index("--") + 1 :] if "--" in argv else []
    p = argparse.ArgumentParser()
    p.add_argument(
        "--meshes", nargs="+", required=True,
        help="One or more '<mesh_path>:<r>,<g>,<b>' tokens (RGB in 0..1).",
    )
    p.add_argument("--out", required=True)
    p.add_argument("--samples", type=int, default=64)
    p.add_argument("--size", type=int, default=640)
    p.add_argument("--z-up", action="store_true", dest="z_up")
    p.add_argument("--gpu", action="store_true")
    p.add_argument("--engine", default="cycles", choices=("cycles", "eevee"),
                   help="'cycles' = path traced (default, unchanged). 'eevee' = "
                        "EEVEE Next rasteriser with raytraced shadows + Fast GI: "
                        "~2.8x cheaper PER VIEW at 512px, but it resolves fine "
                        "crevice detail less crisply, so it is a placement-render "
                        "trade, not a quality-render one.")
    p.add_argument(
        "--views", default="isometric,front,right,top",
        help="Comma-separated subset of the named views to render (see "
             "all_angles in main(): 6 faces, 8 iso corners, 4 diagonals, "
             "2 tilts). Default: isometric,front,right,top.",
    )
    p.add_argument("--edges", action="store_true",
                   help="Overlay Freestyle line art (silhouette + crease).")
    p.add_argument("--edge-thickness", type=float, default=1.2,
                   dest="edge_thickness")
    p.add_argument("--sweep", default=None,
                   help="Turntable sweep 'START:END:FRAMES' or waypoint path "
                        "'W0,W1,...:FRAMES' (model yaw in degrees, smoothstep-"
                        "eased per segment). Renders 'color-sweep-f####.png' "
                        "stills orbiting the FIRST --views entry around Z with "
                        "one fixed fitted camera distance. Replaces the normal "
                        "per-view stills. Semantics match _render_ao_blender.py.")
    p.add_argument("--build", action="store_true",
                   help="Sequential-assembly render: hold ONE fixed camera "
                        "(fitted to the FULL model, aimed along the FIRST "
                        "--views entry) and reveal one --meshes part per frame "
                        "in the order given. Emits 'color-build-f####.png' — "
                        "frame k shows parts 0..k. Replaces the per-view "
                        "stills; combine downstream into a build-up video.")
    return p.parse_args(argv)


def parse_mesh_spec(token: str):
    """'<path>:r,g,b' (flat colour) or '<path>:r,g,b,rough,metal' (PBR).

    Returns (path, (r, g, b), rough_or_None, metal_or_None)."""
    if ":" not in token:
        raise SystemExit(f"--meshes token missing ':rgb': {token!r}")
    path, rgb = token.rsplit(":", 1)
    parts = rgb.split(",")
    if len(parts) not in (3, 5):
        raise SystemExit(
            f"--meshes spec must be 'r,g,b' or 'r,g,b,rough,metal': {token!r}"
        )
    color = (float(parts[0]), float(parts[1]), float(parts[2]))
    rough = float(parts[3]) if len(parts) == 5 else None
    metal = float(parts[4]) if len(parts) == 5 else None
    return path, color, rough, metal


# --------- scene setup ---------------------------------------------------


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_mesh(path: str, z_up: bool):
    ext = Path(path).suffix.lower()
    if ext == ".obj":
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
    # Return any meshes that were newly added on this import.
    return [o for o in bpy.context.selected_objects if o.type == "MESH"]


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
    bpy.context.view_layer.update()


def make_colored_material(rgb: tuple[float, float, float],
                          rough: float = None, metal: float = None):
    """Principled BSDF with a tinted base color. When roughness/metalness are
    supplied (paint stage's PBR materials) they override the flat-plastic
    defaults, so metals read shiny and rubber reads matte."""
    r, g, b = rgb
    roughness = 0.55 if rough is None else max(0.0, min(1.0, rough))
    metalness = 0.0 if metal is None else max(0.0, min(1.0, metal))
    mat = bpy.data.materials.new(name=f"PartMat_{r:.2f}_{g:.2f}_{b:.2f}")
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (r, g, b, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = metalness
    for key in ("Specular IOR Level", "Specular"):
        if key in bsdf.inputs:
            bsdf.inputs[key].default_value = 0.4
            break
    return mat


def setup_world(value: float = 0.92):
    """Near-white world background — colours are the primary cue."""
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


def setup_lights(scene_diag: float):
    """Soft three-point rig sized to the scene diagonal."""
    # Key light — warm, above and forward of camera.
    bpy.ops.object.light_add(type="AREA", location=(scene_diag, -scene_diag, scene_diag))
    key = bpy.context.object
    key.data.energy = scene_diag * scene_diag * 6
    key.data.size = scene_diag * 1.5
    key.data.color = (1.0, 0.97, 0.92)

    # Fill — cooler, opposite side.
    bpy.ops.object.light_add(type="AREA", location=(-scene_diag, scene_diag * 0.5, scene_diag * 0.6))
    fill = bpy.context.object
    fill.data.energy = scene_diag * scene_diag * 2.5
    fill.data.size = scene_diag * 1.8
    fill.data.color = (0.92, 0.95, 1.0)

    # Rim — backlight to separate silhouettes from the bright world.
    bpy.ops.object.light_add(type="AREA", location=(0, scene_diag * 1.4, scene_diag * 1.2))
    rim = bpy.context.object
    rim.data.energy = scene_diag * scene_diag * 3
    rim.data.size = scene_diag * 1.2
    rim.data.color = (1.0, 1.0, 1.0)


def setup_eevee(scene, samples: int):
    """EEVEE Next, configured as close to the Cycles look as it gets.

    Fast GI is what supplies the contact/crevice shading; it is OFF by default,
    which is why a plain EEVEE render reads noticeably flatter than Cycles. Even
    with it on, fine detail resolves less crisply — see --engine's help.
    """
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    ee = scene.eevee
    # TAA samples are anti-aliasing, not light paths, so they are cheap; spend
    # more than the Cycles sample count rather than fewer.
    ee.taa_render_samples = max(samples, 64)
    for attr, val in (("use_raytracing", True), ("use_shadows", True)):
        if hasattr(ee, attr):
            setattr(ee, attr, val)
    rt = getattr(ee, "ray_tracing_options", None)
    if rt is not None:
        for attr, val in (("use_denoise", True), ("resolution_scale", "1"),
                          ("screen_trace_quality", 1.0)):
            if hasattr(rt, attr):
                try:
                    setattr(rt, attr, val)
                except Exception:
                    pass
    if hasattr(ee, "use_fast_gi"):
        ee.use_fast_gi = True
        for attr, val in (("fast_gi_method", "GLOBAL_ILLUMINATION"),
                          ("fast_gi_resolution", "1"), ("fast_gi_ray_count", 4),
                          ("fast_gi_step_count", 32)):
            if hasattr(ee, attr):
                try:
                    setattr(ee, attr, val)
                except Exception:
                    pass


def setup_render(size: int, samples: int, use_gpu: bool, engine: str = "cycles"):
    scene = bpy.context.scene
    if engine == "eevee":
        setup_eevee(scene, samples)
    else:
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
    scene.render.use_persistent_data = True

    enable_gpu(scene, use_gpu)


def setup_freestyle(thickness: float):
    scene = bpy.context.scene
    scene.render.use_freestyle = True
    scene.render.line_thickness_mode = "ABSOLUTE"
    scene.render.line_thickness = thickness
    vl = scene.view_layers[0]
    vl.use_freestyle = True
    vl.freestyle_settings.crease_angle = math.radians(140.0)
    fs = vl.freestyle_settings
    if len(fs.linesets) == 0:
        fs.linesets.new("LineSet")
    ls = fs.linesets[0]
    ls.select_silhouette = True
    ls.select_crease = True
    ls.select_border = True
    ls.select_contour = True
    ls.select_external_contour = True
    style = ls.linestyle
    if style is None:
        style = bpy.data.linestyles.new("EdgeStyle")
        ls.linestyle = style
    style.color = (0.0, 0.0, 0.0)
    style.alpha = 1.0
    style.thickness = thickness


# --------- camera fits (perspective + orthographic) -----------------------


def fit_persp_to_mesh(objs, cam_dir_norm, fov_deg: float, padding: float = 1.05):
    """Perspective-fit distance + aim. Mirrors `_render_ao_blender.fit_distance_to_mesh`."""
    import numpy as np
    cam_dir = Vector(cam_dir_norm).normalized()
    world_up = Vector((0, 0, 1))
    if abs(cam_dir.dot(world_up)) > 0.99:
        world_up = Vector((0, 1, 0))
    x_cam = world_up.cross(cam_dir).normalized()
    y_cam = cam_dir.cross(x_cam).normalized()
    ht = math.tan(math.radians(fov_deg / 2))

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
    rz_max = float(rz.max())
    d = max(d_x, d_y, rz_max + 1e-3, 0.1)
    cx = (P_x + Q_x) / 2.0
    cy = (P_y + Q_y) / 2.0
    aim = x_cam * cx + y_cam * cy
    return d * padding, aim


def fit_ortho_to_mesh(objs, cam_dir_norm, padding: float = 1.05):
    """Orthographic-fit. Mirrors `_render_ao_blender.fit_ortho_to_mesh`."""
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
    rz_max, rz_min = float(rz.max()), float(rz.min())

    span = max(P_x - Q_x, P_y - Q_y, 1e-3)
    ortho_scale = span * padding
    cx = (P_x + Q_x) / 2.0
    cy = (P_y + Q_y) / 2.0
    aim = x_cam * cx + y_cam * cy
    distance = (rz_max - rz_min) + span + 1e-3
    return distance, aim, ortho_scale


def place_camera(pos_norm, objs, fov_deg: float = 45.0, ortho: bool = False):
    cam_dir = Vector(pos_norm).normalized()
    if ortho:
        distance, aim, ortho_scale = fit_ortho_to_mesh(objs, pos_norm)
    else:
        distance, aim = fit_persp_to_mesh(objs, pos_norm, fov_deg)

    world_up = Vector((0, 0, 1))
    if abs(cam_dir.dot(world_up)) > 0.99:
        world_up = Vector((0, 1, 0))
    x_cam = world_up.cross(cam_dir).normalized()
    y_cam = cam_dir.cross(x_cam).normalized()

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
    if ortho:
        cam_data.type = "ORTHO"
        cam_data.ortho_scale = ortho_scale
    else:
        cam_data.lens_unit = "FOV"
        cam_data.angle = math.radians(fov_deg)
    cam_obj = bpy.data.objects.new("Cam", cam_data)
    bpy.context.collection.objects.link(cam_obj)

    loc = aim + cam_dir * distance
    cam_obj.matrix_world = Matrix((
        (x_cam.x, y_cam.x, cam_dir.x, loc.x),
        (x_cam.y, y_cam.y, cam_dir.y, loc.y),
        (x_cam.z, y_cam.z, cam_dir.z, loc.z),
        (0.0, 0.0, 0.0, 1.0),
    ))
    return cam_obj


# --------- main ----------------------------------------------------------


def main():
    args = parse_args()
    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    reset_scene()

    # Import every mesh with its colour. We accumulate one Blender object
    # (or set thereof) per mesh-spec, each with its own material. Per-spec
    # groups are kept in `part_groups` (build mode reveals them one at a time).
    all_objs: list = []
    part_groups: list = []
    for spec in args.meshes:
        path, rgb, rough, metal = parse_mesh_spec(spec)
        new_objs = import_mesh(str(Path(path).resolve()), args.z_up)
        mat = make_colored_material(rgb, rough, metal)
        for o in new_objs:
            o.data.materials.clear()
            o.data.materials.append(mat)
        all_objs.extend(new_objs)
        part_groups.append(new_objs)
    if not all_objs:
        raise SystemExit("no meshes imported")

    # Centre the combined assembly on its bbox midpoint so the camera fit
    # is symmetric, then size the lights to the scene diagonal.
    lo, hi = compute_bbox(all_objs)
    center = (lo + hi) * 0.5
    center_objects(all_objs, center)
    size_vec = hi - lo
    scene_diag = max(size_vec.length, 1e-3)

    setup_world(value=0.95)
    setup_lights(scene_diag)
    setup_render(args.size, args.samples, args.gpu, args.engine)
    if args.edges:
        setup_freestyle(args.edge_thickness)

    # Camera DIRECTION per named view (object → camera; normalised in
    # place_camera). The 20-view catalog the refine loop multi-selects from.
    # KEEP IN SYNC with VIEW_CATALOG in src/render/views.ts and
    # _render_ao_blender.py. -Y is the object's front; +Z up; +X right.
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
    ortho_views = {"front", "back", "left", "right", "top", "bottom"}

    wanted = [v.strip() for v in args.views.split(",") if v.strip()]
    unknown = [v for v in wanted if v not in all_angles]
    if unknown:
        raise SystemExit(
            f"Unknown view names: {unknown}. Known: {list(all_angles)}"
        )
    angles = [(name, all_angles[name]) for name in wanted]

    scene = bpy.context.scene

    if args.build:
        # Sequential-assembly render: ONE fixed camera fitted to the FULL model
        # (bbox is visibility-independent, so framing never breathes), aimed
        # along the first requested view. Reveal one part per frame in the
        # order the meshes were given (= the SCAD assembly / build order).
        name, pos = angles[0]
        cam = place_camera(pos, all_objs, ortho=(name in ortho_views))
        scene.camera = cam
        for o in all_objs:
            o.hide_render = True
        n = len(part_groups)
        for k in range(n):
            for o in part_groups[k]:
                o.hide_render = False
            scene.render.filepath = str(out_dir / f"color-build-f{k:04d}.png")
            bpy.ops.render.render(write_still=True)
            print(f"[parts-color] build f{k:04d}: {k + 1}/{n} parts visible",
                  flush=True)
        bpy.data.objects.remove(cam, do_unlink=True)
        return

    if args.sweep:
        # The sweep machinery (eased schedule, fixed-distance fit, origin-aimed
        # camera) lives in the AO render script — import it as a sibling module
        # rather than duplicating; both scripts already share their conventions.
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from _render_ao_blender import (
            fit_sweep_distance, gather_world_vertices,
            place_camera_fixed, sweep_schedule,
        )

        _, pos = angles[0]
        base_dir = Vector(pos).normalized()
        thetas = sweep_schedule(args.sweep)
        V = gather_world_vertices(all_objs)
        if V is None:
            raise SystemExit("sweep: scene has no vertices")
        # Model yaw +θ == camera azimuth −θ (matches _render_ao_blender).
        dirs = [
            (Matrix.Rotation(math.radians(-t), 3, "Z") @ base_dir).normalized()
            for t in thetas
        ]
        distance = max(fit_sweep_distance(V, d, 45.0) for d in dirs) * 1.05
        for i, d in enumerate(dirs):
            cam = place_camera_fixed(d, distance)
            scene.camera = cam
            scene.render.filepath = str(out_dir / f"color-sweep-f{i:04d}.png")
            bpy.ops.render.render(write_still=True)
            bpy.data.objects.remove(cam, do_unlink=True)
            print(f"[parts-color] sweep f{i:04d} yaw={thetas[i]:+7.2f}: "
                  f"{scene.render.filepath}", flush=True)
        return

    for name, pos in angles:
        cam = place_camera(pos, all_objs, ortho=(name in ortho_views))
        scene.camera = cam
        scene.render.filepath = str(out_dir / f"color-{name}.png")
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(cam, do_unlink=True)
        print(f"[parts-color] {name}: {scene.render.filepath}", flush=True)


if __name__ == "__main__":
    main()
