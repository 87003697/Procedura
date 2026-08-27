"""Hardcore PBR render of a multi-part painted assembly (Cycles).

Invoked as:
    blender --background --python scripts/_render_pbr_blender.py -- \
        --spec spec.json --out <dir> [--hdri studio.exr] [--z-up] \
        [--samples 200] [--size 768] [--gpu] [--views isometric,front,...]

spec.json:
  { "parts": [ { "stl": "...", "name": "fuselage",
                 "color": [r,g,b], "metalness": 0..1, "roughness": 0..1,
                 "clearcoat": 0..1, "wear": 0..1, "dirt": 0..1, "emission": 0..1 }, ... ] }

Each part becomes a full procedural Principled-BSDF shader:
  - base colour / metalness / roughness (+ noise variation + micro-bump)
  - CLEARCOAT for painted / glossy finishes
  - WEAR: edge chipping (Pointiness mask × noise) blends the surface toward bare
    worn metal and raises metalness on the exposed edges
  - DIRT: ambient-occlusion mask darkens + roughens crevices (grime build-up)
  - EMISSION for glowing parts

Two contracts worth knowing before editing the shader graph:
  1. spec colours are sRGB (paint.ts emits hex/255) but every Cycles colour
     socket is LINEAR — everything user-facing goes through srgb_to_linear(),
     and hard-coded weathering swatches that get MIXED with the base go through
     lin4(). Mixing the two spaces makes grime brighter than the paint.
  2. every weathering layer is GATED on its artist parameter and scales from 0:
     at wear=0, dirt=0 the part must render as clean paint. Layers opt out by
     raising _Skip, which is silent; a real node-API break still prints.

Shading is angle-limited (--smooth-angle, default 30 deg), NOT blanket-smooth:
these are welded CSG meshes, so averaging normals across every sharp edge makes
flat panels shade as triangle-diagonal wedges and box corners look melted.

Lit by a studio HDRI (environment) for real reflections, with a clean studio
backdrop shown only to camera rays (Light Path trick) so the product reads on a
soft seamless background. Renders with denoising + AgX view transform.

Camera framing is kept identical to _render_parts_color_blender.py.
Output files: <out>/pbr-<view>.png
"""
import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

# scripts/_blender_gpu.py is a sibling of this script; Blender does not put the
# script's own directory on sys.path when invoked with --python.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _blender_gpu import enable_gpu  # noqa: E402


# ───────────────────────── args ─────────────────────────

def parse_args():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--spec", required=True, help="JSON spec with per-part materials")
    p.add_argument("--out", required=True)
    p.add_argument("--hdri", default="", help="Environment .exr for lighting/reflections")
    p.add_argument("--samples", type=int, default=200)
    p.add_argument("--size", type=int, default=768)
    p.add_argument("--z-up", action="store_true", dest="z_up")
    p.add_argument("--gpu", action="store_true")
    p.add_argument("--no-floor", action="store_true", dest="no_floor")
    p.add_argument("--bg", type=float, default=0.9, help="Studio backdrop value 0..1")
    p.add_argument("--hdri-strength", type=float, default=0.55,
                   help="Environment reflection/ambient strength (soft-box lights do the shaping).")
    p.add_argument("--exposure", type=float, default=0.0)
    p.add_argument("--tone", default="AgX",
                   help="View transform: AgX | Filmic | 'Khronos PBR Neutral' | Standard.")
    p.add_argument("--no-comp", action="store_true", dest="no_comp",
                   help="Disable the bloom/contrast/vignette compositor.")
    p.add_argument("--out-prefix", default="pbr")
    p.add_argument("--views", default="isometric,front,right,top")
    p.add_argument("--edge-bevel", type=float, default=0.006, dest="edge_bevel",
                   help="Shader-bevel radius in normalized units (the model is scaled to "
                        "span 2.0), giving sharp CSG edges a machined fillet that catches "
                        "a highlight. 0 disables. Above ~0.012 the form starts to soften.")
    p.add_argument("--bevel-samples", type=int, default=4, dest="bevel_samples")
    p.add_argument("--key-hard", type=float, default=0.4, dest="key_hard",
                   help="Scale the soft-box SIZES (wattage unchanged). <1 = harder, more "
                        "directional light, which separates planes and makes edge "
                        "highlights and surface relief read. 1.0 = the old very soft rig.")
    p.add_argument("--smooth-angle", type=float, default=30.0, dest="smooth_angle",
                   help="Crease angle (deg) below which normals are averaged. "
                        "Keeps $fn cylinders round while panel edges stay sharp.")
    return p.parse_args(argv)


def clamp01(x):
    return max(0.0, min(1.0, float(x)))


def srgb_to_linear(c):
    """paint.ts emits hex/255 sRGB floats; Cycles' colour sockets are LINEAR.

    Feeding the sRGB value straight in renders every part ~3.8x too bright at
    roughly half the requested chroma (#51594e read back as #6e7470).
    """
    c = clamp01(c)
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lin4(r, g, b):
    """An eyeballed sRGB weathering colour as a linear RGBA socket value.

    The weathering constants below are authored the way a human reads a swatch
    (sRGB). They get MIXED with the linearised base colour, so they have to be
    linearised too — otherwise, for any base darker than about #3f3f3f, 'grime'
    at 0.05 is BRIGHTER than the paint it is supposed to dirty and weathering
    lightens the crevices instead of darkening them.
    """
    return (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b), 1.0)


class _Skip(Exception):
    """A layer opting out because its parameter is zero — not a failure."""


def sin(node, names, value):
    """Set an input default by trying several socket names (version-proof)."""
    if isinstance(names, str):
        names = [names]
    for n in names:
        if n in node.inputs:
            try:
                node.inputs[n].default_value = value
                return True
            except Exception:
                pass
    return False


# ───────────────────────── materials ─────────────────────────

def build_material(name, spec, edge_bevel=0.0, bevel_samples=4):
    r, g, b = (srgb_to_linear(c) for c in spec.get("color", [0.7, 0.7, 0.7])[:3])
    metal = clamp01(spec.get("metalness", 0.0))
    rough = clamp01(spec.get("roughness", 0.5))
    clear = clamp01(spec.get("clearcoat", 0.0))
    wear = clamp01(spec.get("wear", 0.0))
    dirt = clamp01(spec.get("dirt", 0.0))
    emis = clamp01(spec.get("emission", 0.0))
    mat_class = str(spec.get("material", "")).lower()

    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nodes, links = nt.nodes, nt.links
    bsdf = nodes.get("Principled BSDF")

    # ---- GLASS: a transmissive shader, and none of the weathering stack ----
    # The material class used to be dropped at the TS boundary, so Transmission
    # was never set anywhere and every canopy, lens and sensor cover rendered as
    # an OPAQUE slab — then had scratches, dust, grunge and panel-line grime
    # layered onto it, which is what made glass read as scuffed plastic. Glass
    # gets its own short path: tint, transmission, real IOR, and a clean surface.
    if mat_class == "glass":
        sin(bsdf, "Base Color", (r, g, b, 1.0))
        sin(bsdf, "Metallic", 0.0)
        sin(bsdf, "Roughness", rough)
        sin(bsdf, "IOR", 1.5)
        if not sin(bsdf, ["Transmission Weight", "Transmission"], 1.0):
            print(f"[pbr] {name}: no Transmission socket; glass stays opaque", flush=True)
        # A coat over glass is double specular; only honour an explicit one.
        sin(bsdf, ["Coat Weight", "Clearcoat"], clear * 0.5)
        sin(bsdf, ["Coat Roughness", "Clearcoat Roughness"], 0.03)
        if emis > 0.001:
            sin(bsdf, "Emission Color", (r, g, b, 1.0))
            sin(bsdf, "Emission Strength", emis * 4.0)
        return mat

    sin(bsdf, "IOR", 1.45)
    sin(bsdf, ["Coat Weight", "Clearcoat"], clear)
    sin(bsdf, ["Coat Roughness", "Clearcoat Roughness"], 0.06)
    sin(bsdf, ["Specular IOR Level", "Specular"], 0.5)

    try:
        # ---- shared detail noise (object space so it sticks to the part) ----
        texco = nodes.new("ShaderNodeTexCoord")
        nz = nodes.new("ShaderNodeTexNoise")
        # Detail is deliberately LOW. The finest octave of a fBm noise sits near
        # Scale * 2**Detail; at Detail 8 that was ~3600 cycles per unit, i.e. about
        # 0.1 px on a 2-unit model — pure aliasing grit that costs samples and that
        # the denoiser then smears. Detail 2 keeps the octaves resolvable.
        nz.inputs["Scale"].default_value = 14.0
        nz.inputs["Detail"].default_value = 2.0
        nz.inputs["Roughness"].default_value = 0.65
        links.new(texco.outputs["Object"], nz.inputs["Vector"])

        # finer noise for surface micro-texture / bump
        nz2 = nodes.new("ShaderNodeTexNoise")
        nz2.inputs["Scale"].default_value = 52.0
        nz2.inputs["Detail"].default_value = 2.0
        links.new(texco.outputs["Object"], nz2.inputs["Vector"])

        color_src = None
        base_rgb = nodes.new("ShaderNodeRGB")
        base_rgb.outputs[0].default_value = (r, g, b, 1.0)
        color_src = base_rgb.outputs[0]

        # roughness: base ± noise variation
        rmap = nodes.new("ShaderNodeMapRange")
        rmap.inputs["To Min"].default_value = max(0.03, rough - 0.10)
        rmap.inputs["To Max"].default_value = min(1.0, rough + 0.10)
        links.new(nz.outputs["Fac"], rmap.inputs["Value"])
        rough_src = rmap.outputs["Result"]

        bump_strength = 0.05 + 0.25 * dirt + 0.30 * wear
        metal_linked = False

        # ---- EDGE BEVEL: rounded-edge shading + machined catch-light ----
        # CSG geometry has perfectly sharp 90-degree edges, so they catch no
        # highlight and the parts read as untextured CG. ShaderNodeBevel shades
        # them as if they carried a small fillet WITHOUT touching the geometry.
        # Built here rather than at the end of the normal chain because the WEAR
        # block below consumes its mask; `bevel_norm` is fed into the bump chain
        # further down, so one Bevel node serves both purposes.
        edge_mask = None
        bevel_norm = None
        if edge_bevel > 1e-6:
            try:
                bev = nodes.new("ShaderNodeBevel")
                bev.samples = max(2, bevel_samples)
                bev.inputs["Radius"].default_value = edge_bevel
                bevel_norm = bev.outputs["Normal"]
                # dot(bevelled, true) reads 1.0 on a flat face and dips at every
                # real edge and hole rim. Unlike Pointiness — which measures 0.70
                # on a flat CSG face and so saturates any fixed ramp across the
                # whole part — this is tessellation-independent.
                egeo = nodes.new("ShaderNodeNewGeometry")
                edot = nodes.new("ShaderNodeVectorMath"); edot.operation = "DOT_PRODUCT"
                links.new(bev.outputs["Normal"], edot.inputs[0])
                links.new(egeo.outputs["True Normal"], edot.inputs[1])
                emap = nodes.new("ShaderNodeMapRange")
                emap.inputs["From Min"].default_value = 0.90
                emap.inputs["From Max"].default_value = 0.999
                emap.inputs["To Min"].default_value = 1.0
                emap.inputs["To Max"].default_value = 0.0
                links.new(edot.outputs["Value"], emap.inputs["Value"])
                edge_mask = emap.outputs["Result"]

                # A real corner is smoother and a touch lighter than the face:
                # paint thins and burnishes there. Keep it a hairline, not a halo.
                esub = nodes.new("ShaderNodeMath"); esub.operation = "MULTIPLY"
                esub.inputs[1].default_value = 0.14
                links.new(edge_mask, esub.inputs[0])
                erough = nodes.new("ShaderNodeMath"); erough.operation = "SUBTRACT"
                erough.use_clamp = True
                links.new(rough_src, erough.inputs[0])
                links.new(esub.outputs["Value"], erough.inputs[1])
                rough_src = erough.outputs["Value"]

                elift = nodes.new("ShaderNodeMath"); elift.operation = "MULTIPLY"
                elift.inputs[1].default_value = 0.10
                links.new(edge_mask, elift.inputs[0])
                ecol = nodes.new("ShaderNodeMixRGB")
                ecol.blend_type = "SCREEN"
                ecol.inputs["Color2"].default_value = (0.35, 0.35, 0.35, 1.0)
                links.new(elift.outputs["Value"], ecol.inputs["Fac"])
                links.new(color_src, ecol.inputs["Color1"])
                color_src = ecol.outputs["Color"]
            except Exception as e:
                print(f"[pbr] edge bevel unavailable ({e}); skipping", flush=True)
                edge_mask = bevel_norm = None

        # ---- DIRT: grime in occluded crevices ----
        if dirt > 0.001:
            ao = nodes.new("ShaderNodeAmbientOcclusion")
            ao.inputs["Distance"].default_value = 0.12  # ~6% of the normalized model
            ao.samples = 8
            # Sample about the TRUE geometric normal: the shading normal is
            # angle-smoothed, and letting the mask follow it prints one dark
            # stripe per tessellation facet on every cylinder.
            dgeo = nodes.new("ShaderNodeNewGeometry")
            links.new(dgeo.outputs["True Normal"], ao.inputs["Normal"])
            occl = nodes.new("ShaderNodeMath"); occl.operation = "SUBTRACT"
            occl.inputs[0].default_value = 1.0
            links.new(ao.outputs["AO"], occl.inputs[1])
            dfac = nodes.new("ShaderNodeMath"); dfac.operation = "MULTIPLY"
            dfac.inputs[1].default_value = dirt
            links.new(occl.outputs["Value"], dfac.inputs[0])
            grime = nodes.new("ShaderNodeMixRGB")
            grime.inputs["Color2"].default_value = lin4(0.05, 0.043, 0.035)
            links.new(dfac.outputs["Value"], grime.inputs["Fac"])
            links.new(color_src, grime.inputs["Color1"])
            color_src = grime.outputs["Color"]
            # roughen the grime
            rmul = nodes.new("ShaderNodeMath"); rmul.operation = "MULTIPLY"
            rmul.inputs[1].default_value = 0.45
            links.new(dfac.outputs["Value"], rmul.inputs[0])
            radd = nodes.new("ShaderNodeMath"); radd.operation = "ADD"; radd.use_clamp = True
            links.new(rough_src, radd.inputs[0]); links.new(rmul.outputs["Value"], radd.inputs[1])
            rough_src = radd.outputs["Value"]

        # ---- WEAR: edge chipping → bare worn metal ----
        if wear > 0.001:
            if edge_mask is not None:
                wear_base = edge_mask       # chipping on the actual edges/rims
            else:
                geo = nodes.new("ShaderNodeNewGeometry")
                ramp = nodes.new("ShaderNodeValToRGB")
                ramp.color_ramp.elements[0].position = 0.44
                ramp.color_ramp.elements[1].position = 0.58
                links.new(geo.outputs["Pointiness"], ramp.inputs["Fac"])
                wear_base = ramp.outputs["Color"]
            # patchy: edge mask × noise lifted to [0.55,1] so edges stay worn
            nlift = nodes.new("ShaderNodeMapRange")
            nlift.inputs["To Min"].default_value = 0.55
            nlift.inputs["To Max"].default_value = 1.0
            links.new(nz.outputs["Fac"], nlift.inputs["Value"])
            patch = nodes.new("ShaderNodeMath"); patch.operation = "MULTIPLY"
            links.new(wear_base, patch.inputs[0])
            links.new(nlift.outputs["Result"], patch.inputs[1])
            wfac = nodes.new("ShaderNodeMath"); wfac.operation = "MULTIPLY"
            # A hairline bevel mask needs no de-rating; the Pointiness fallback
            # does, because its ramp saturates over the whole face.
            wfac.inputs[1].default_value = min(
                1.0, wear * (1.5 if edge_mask is not None else 0.6))
            links.new(patch.outputs["Value"], wfac.inputs[0])
            # colour → dark worn steel
            wcol = nodes.new("ShaderNodeMixRGB")
            wcol.inputs["Color2"].default_value = lin4(0.26, 0.24, 0.22)
            links.new(wfac.outputs["Value"], wcol.inputs["Fac"])
            links.new(color_src, wcol.inputs["Color1"])
            color_src = wcol.outputs["Color"]
            # metalness → mix(metal, 1, wfac)
            inv = nodes.new("ShaderNodeMath"); inv.operation = "SUBTRACT"
            inv.inputs[0].default_value = 1.0
            links.new(wfac.outputs["Value"], inv.inputs[1])
            ma = nodes.new("ShaderNodeMath"); ma.operation = "MULTIPLY"
            ma.inputs[1].default_value = metal
            links.new(inv.outputs["Value"], ma.inputs[0])
            msum = nodes.new("ShaderNodeMath"); msum.operation = "ADD"
            links.new(ma.outputs["Value"], msum.inputs[0])
            links.new(wfac.outputs["Value"], msum.inputs[1])
            if metal > 0.5:      # never lift a declared non-metal toward metalness
                links.new(msum.outputs["Value"], bsdf.inputs["Metallic"])
                metal_linked = True

        if not metal_linked:
            sin(bsdf, "Metallic", metal)

        # ---- surface normal: micro bump + fine SCRATCHES (chained) ----
        micro = nodes.new("ShaderNodeBump")
        micro.inputs["Strength"].default_value = bump_strength
        links.new(nz2.outputs["Fac"], micro.inputs["Height"])
        if bevel_norm is not None:
            links.new(bevel_norm, micro.inputs["Normal"])   # bump rides the fillet

        # Scratches: object coords stretched along one axis so noise reads as
        # fine lines — directional (brushed) on metals, finer scuffs otherwise.
        smap = nodes.new("ShaderNodeMapping")
        smap.inputs["Scale"].default_value = (1.0, 45.0, 45.0) if metal > 0.5 else (22.0, 22.0, 22.0)
        links.new(texco.outputs["Object"], smap.inputs["Vector"])
        scr = nodes.new("ShaderNodeTexNoise")
        scr.inputs["Scale"].default_value = 12.0
        scr.inputs["Detail"].default_value = 3.0
        links.new(smap.outputs["Vector"], scr.inputs["Vector"])
        # sharpen the streaks into distinct scratch lines
        scr_c = nodes.new("ShaderNodeMapRange")
        scr_c.inputs["From Min"].default_value = 0.38
        scr_c.inputs["From Max"].default_value = 0.62
        links.new(scr.outputs["Fac"], scr_c.inputs["Value"])
        scr_bump = nodes.new("ShaderNodeBump")
        scr_bump.inputs["Strength"].default_value = (0.22 if metal > 0.5 else 0.14)
        links.new(scr_c.outputs["Result"], scr_bump.inputs["Height"])
        links.new(micro.outputs["Normal"], scr_bump.inputs["Normal"])   # chain micro → scratch
        last_norm = scr_bump.outputs["Normal"]

        # Cross-hatch scratches on metals: a second streak set, orthogonal.
        if metal > 0.5:
            smap2 = nodes.new("ShaderNodeMapping")
            smap2.inputs["Scale"].default_value = (45.0, 1.0, 45.0)
            links.new(texco.outputs["Object"], smap2.inputs["Vector"])
            scr2 = nodes.new("ShaderNodeTexNoise")
            scr2.inputs["Scale"].default_value = 12.0; scr2.inputs["Detail"].default_value = 3.0
            links.new(smap2.outputs["Vector"], scr2.inputs["Vector"])
            scr2_c = nodes.new("ShaderNodeMapRange")
            scr2_c.inputs["From Min"].default_value = 0.40; scr2_c.inputs["From Max"].default_value = 0.60
            links.new(scr2.outputs["Fac"], scr2_c.inputs["Value"])
            scr2_bump = nodes.new("ShaderNodeBump")
            scr2_bump.inputs["Strength"].default_value = 0.14
            links.new(scr2_c.outputs["Result"], scr2_bump.inputs["Height"])
            links.new(last_norm, scr2_bump.inputs["Normal"])
            last_norm = scr2_bump.outputs["Normal"]

        # Speckle / pitting: fine voronoi specks → tiny pits (bump) + dark chips (albedo).
        try:
            if wear <= 0.001:
                raise _Skip("wear=0")
            pit = nodes.new("ShaderNodeTexVoronoi")
            pit.inputs["Scale"].default_value = 48.0
            links.new(texco.outputs["Object"], pit.inputs["Vector"])
            pmask = nodes.new("ShaderNodeMapRange")
            pmask.inputs["From Min"].default_value = 0.0; pmask.inputs["From Max"].default_value = 0.10
            pmask.inputs["To Min"].default_value = 1.0; pmask.inputs["To Max"].default_value = 0.0
            links.new(pit.outputs["Distance"], pmask.inputs["Value"])
            pit_bump = nodes.new("ShaderNodeBump")
            pit_bump.inputs["Strength"].default_value = 0.14
            links.new(pmask.outputs["Result"], pit_bump.inputs["Height"])
            links.new(last_norm, pit_bump.inputs["Normal"])
            last_norm = pit_bump.outputs["Normal"]
            pfac = nodes.new("ShaderNodeMath"); pfac.operation = "MULTIPLY"
            pfac.inputs[1].default_value = 0.6 * wear
            links.new(pmask.outputs["Result"], pfac.inputs[0])
            pchip = nodes.new("ShaderNodeMixRGB")
            pchip.inputs["Color2"].default_value = lin4(0.14, 0.12, 0.10)
            links.new(pfac.outputs["Value"], pchip.inputs["Fac"])
            links.new(color_src, pchip.inputs["Color1"])
            color_src = pchip.outputs["Color"]
        except _Skip:
            pass          # parameter is zero: layer intentionally absent
        except Exception as e:
            print(f"[pbr] speckle FAILED: {e}", flush=True)

        links.new(last_norm, bsdf.inputs["Normal"])

        # ---- grunge mottle: low-freq blotches → subtle albedo + roughness ----
        try:
            if dirt <= 0.001:
                raise _Skip("dirt=0")
            vor = nodes.new("ShaderNodeTexVoronoi")
            vor.inputs["Scale"].default_value = 3.5
            links.new(texco.outputs["Object"], vor.inputs["Vector"])
            gfac = nodes.new("ShaderNodeMath"); gfac.operation = "MULTIPLY"
            gfac.inputs[1].default_value = 0.74 * dirt
            links.new(vor.outputs["Distance"], gfac.inputs[0])
            grunge = nodes.new("ShaderNodeMixRGB")
            grunge.inputs["Color2"].default_value = lin4(0.27, 0.25, 0.22)
            links.new(gfac.outputs["Value"], grunge.inputs["Fac"])
            links.new(color_src, grunge.inputs["Color1"])
            color_src = grunge.outputs["Color"]
            # grunge also roughens the blotches (matte weathered patches)
            grm = nodes.new("ShaderNodeMath"); grm.operation = "MULTIPLY"; grm.inputs[1].default_value = 0.35
            links.new(gfac.outputs["Value"], grm.inputs[0])
            gra = nodes.new("ShaderNodeMath"); gra.operation = "ADD"; gra.use_clamp = True
            links.new(rough_src, gra.inputs[0]); links.new(grm.outputs["Value"], gra.inputs[1])
            rough_src = gra.outputs["Value"]
        except _Skip:
            pass          # parameter is zero: layer intentionally absent
        except Exception as e:
            print(f"[pbr] grunge FAILED: {e}", flush=True)

        # ---- panel-line grime: tight AO → crisp dark seams / recesses ----
        try:
            if dirt <= 0.001:
                raise _Skip("dirt=0")
            pao = nodes.new("ShaderNodeAmbientOcclusion")
            pao.inputs["Distance"].default_value = 0.04
            pao.samples = 8
            pao.only_local = True          # tight seam detail is intra-part
            pgeo = nodes.new("ShaderNodeNewGeometry")
            links.new(pgeo.outputs["True Normal"], pao.inputs["Normal"])
            pinv = nodes.new("ShaderNodeMath"); pinv.operation = "SUBTRACT"; pinv.inputs[0].default_value = 1.0
            links.new(pao.outputs["AO"], pinv.inputs[1])
            pf = nodes.new("ShaderNodeMath"); pf.operation = "MULTIPLY"; pf.inputs[1].default_value = 0.9 * dirt
            links.new(pinv.outputs["Value"], pf.inputs[0])
            pmix = nodes.new("ShaderNodeMixRGB")
            pmix.inputs["Color2"].default_value = lin4(0.05, 0.045, 0.04)
            links.new(pf.outputs["Value"], pmix.inputs["Fac"])
            links.new(color_src, pmix.inputs["Color1"])
            color_src = pmix.outputs["Color"]
        except _Skip:
            pass          # parameter is zero: layer intentionally absent
        except Exception as e:
            print(f"[pbr] panel-line FAILED: {e}", flush=True)

        # ---- settled dust on up-facing surfaces (Geometry Normal.Z) ----
        try:
            if dirt <= 0.001:
                raise _Skip("dirt=0")
            geo2 = nodes.new("ShaderNodeNewGeometry")
            sep = nodes.new("ShaderNodeSeparateXYZ")
            links.new(geo2.outputs["Normal"], sep.inputs["Vector"])
            dz = nodes.new("ShaderNodeMapRange")
            dz.inputs["From Min"].default_value = 0.4; dz.inputs["From Max"].default_value = 0.92
            links.new(sep.outputs["Z"], dz.inputs["Value"])
            dn = nodes.new("ShaderNodeTexNoise"); dn.inputs["Scale"].default_value = 2.5
            links.new(texco.outputs["Object"], dn.inputs["Vector"])
            dfac = nodes.new("ShaderNodeMath"); dfac.operation = "MULTIPLY"
            links.new(dz.outputs["Result"], dfac.inputs[0]); links.new(dn.outputs["Fac"], dfac.inputs[1])
            dstr = nodes.new("ShaderNodeMath"); dstr.operation = "MULTIPLY"; dstr.inputs[1].default_value = 0.36 * dirt
            links.new(dfac.outputs["Value"], dstr.inputs[0])
            dust = nodes.new("ShaderNodeMixRGB")
            dust.inputs["Color2"].default_value = lin4(0.62, 0.60, 0.55)   # pale settled dust
            links.new(dstr.outputs["Value"], dust.inputs["Fac"])
            links.new(color_src, dust.inputs["Color1"])
            color_src = dust.outputs["Color"]
            drm = nodes.new("ShaderNodeMath"); drm.operation = "MULTIPLY"; drm.inputs[1].default_value = 0.5
            links.new(dstr.outputs["Value"], drm.inputs[0])
            dra = nodes.new("ShaderNodeMath"); dra.operation = "ADD"; dra.use_clamp = True
            links.new(rough_src, dra.inputs[0]); links.new(drm.outputs["Value"], dra.inputs[1])
            rough_src = dra.outputs["Value"]
        except _Skip:
            pass          # parameter is zero: layer intentionally absent
        except Exception as e:
            print(f"[pbr] dust FAILED: {e}", flush=True)

        # ---- vertical grime streaks (gravity) ----
        try:
            if dirt <= 0.001:
                raise _Skip("dirt=0")
            vmap = nodes.new("ShaderNodeMapping")
            vmap.inputs["Scale"].default_value = (7.0, 7.0, 0.5)   # stretch along Z → vertical runs
            links.new(texco.outputs["Object"], vmap.inputs["Vector"])
            vn = nodes.new("ShaderNodeTexNoise"); vn.inputs["Scale"].default_value = 6.0; vn.inputs["Detail"].default_value = 2.0
            links.new(vmap.outputs["Vector"], vn.inputs["Vector"])
            vc = nodes.new("ShaderNodeMapRange"); vc.inputs["From Min"].default_value = 0.55; vc.inputs["From Max"].default_value = 0.78
            links.new(vn.outputs["Fac"], vc.inputs["Value"])
            vstr = nodes.new("ShaderNodeMath"); vstr.operation = "MULTIPLY"; vstr.inputs[1].default_value = 0.22 * dirt
            links.new(vc.outputs["Result"], vstr.inputs[0])
            streak = nodes.new("ShaderNodeMixRGB")
            streak.inputs["Color2"].default_value = lin4(0.28, 0.25, 0.22)
            links.new(vstr.outputs["Value"], streak.inputs["Fac"])
            links.new(color_src, streak.inputs["Color1"])
            color_src = streak.outputs["Color"]
        except _Skip:
            pass          # parameter is zero: layer intentionally absent
        except Exception as e:
            print(f"[pbr] streaks FAILED: {e}", flush=True)

        # Deliberately NO Anisotropic: there are no UVs on CSG imports, so Cycles'
        # fallback tangent is a radial field about each part's own Z axis, and high
        # anisotropy stamps a pinwheel plus an axis pinch onto every flat metal
        # panel. The brushed read comes from the directional scratch bump above.

        links.new(color_src, bsdf.inputs["Base Color"])
        links.new(rough_src, bsdf.inputs["Roughness"])
    except Exception as e:
        # Any node-API hiccup → fall back to a flat-but-correct Principled.
        print(f"[pbr] material '{name}' advanced graph failed ({e}); using flat PBR", flush=True)
        sin(bsdf, "Base Color", (r, g, b, 1.0))
        sin(bsdf, "Metallic", metal)
        sin(bsdf, "Roughness", rough)

    if emis > 0.001:
        sin(bsdf, "Emission Color", (r, g, b, 1.0))
        sin(bsdf, "Emission Strength", emis * 4.0)

    return mat


# ───────────────────────── scene ─────────────────────────

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_mesh(path, z_up, smooth_angle=30.0):
    ext = Path(path).suffix.lower()
    if ext == ".obj":
        if z_up:
            bpy.ops.wm.obj_import(filepath=path, forward_axis="Y", up_axis="Z")
        else:
            bpy.ops.wm.obj_import(filepath=path)
    elif ext == ".stl":
        bpy.ops.wm.stl_import(filepath=path)
    else:
        raise SystemExit(f"Unsupported extension: {ext}")
    objs = [o for o in bpy.context.selected_objects if o.type == "MESH"]
    # CAD shading: average normals ONLY across edges softer than `smooth_angle`,
    # so $fn cylinders read round while box/panel edges stay razor sharp.
    #
    # Blanket `poly.use_smooth = True` (what this used to do) averages normals
    # straight across every sharp CSG edge of a vertex-welded mesh, which is what
    # made flat panels shade as triangle-diagonal wedges and box corners melt.
    # mesh.use_auto_smooth was removed in 4.1, and bpy.ops.object.shade_auto_smooth()
    # returns {'CANCELLED'} under --background (its node group lives in the
    # essentials asset library) WITHOUT raising — so shade_smooth_by_angle is the
    # only headless-safe route on 4.5.
    if objs:
        try:
            bpy.ops.object.select_all(action="DESELECT")
            for o in objs:
                o.select_set(True)
            bpy.context.view_layer.objects.active = objs[0]
            res = bpy.ops.object.shade_smooth_by_angle(
                angle=math.radians(smooth_angle), keep_sharp_edges=True)
            if "FINISHED" not in res:
                raise RuntimeError(f"operator returned {res!r}")
        except Exception as e:
            # Flat is the safe fallback: crisp, just facetted on curves.
            print(f"[pbr] angle smoothing unavailable ({e}); shading flat", flush=True)
            for o in objs:
                for poly in o.data.polygons:
                    poly.use_smooth = False
    return objs


def compute_bbox(objs):
    corners = []
    for o in objs:
        for v in o.bound_box:
            corners.append(o.matrix_world @ Vector(v))
    lo = Vector((min(v.x for v in corners), min(v.y for v in corners), min(v.z for v in corners)))
    hi = Vector((max(v.x for v in corners), max(v.y for v in corners), max(v.z for v in corners)))
    return lo, hi


def setup_world(hdri_path, strength, bg_val):
    """Environment for reflections + ambient. HDRI (dimmed — the soft-boxes do the
    key shaping) shown to reflections; a soft VERTICAL GRADIENT studio sweep shown
    to camera rays (brighter low, darker high) for a premium seamless backdrop."""
    world = bpy.data.worlds.new("Studio")
    bpy.context.scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputWorld")

    env_bg = nt.nodes.new("ShaderNodeBackground")
    env_bg.inputs["Strength"].default_value = strength
    if hdri_path and Path(hdri_path).exists():
        env = nt.nodes.new("ShaderNodeTexEnvironment")
        env.image = bpy.data.images.load(hdri_path)
        mapping = nt.nodes.new("ShaderNodeMapping")
        mapping.inputs["Rotation"].default_value[2] = math.radians(120.0)
        texco = nt.nodes.new("ShaderNodeTexCoord")
        nt.links.new(texco.outputs["Generated"], mapping.inputs["Vector"])
        nt.links.new(mapping.outputs["Vector"], env.inputs["Vector"])
        nt.links.new(env.outputs["Color"], env_bg.inputs["Color"])
    else:
        env_bg.inputs["Color"].default_value = (0.5, 0.52, 0.55, 1.0)

    # Camera-ray backdrop: soft vertical gradient (studio sweep).
    tex = nt.nodes.new("ShaderNodeTexCoord")
    grad = nt.nodes.new("ShaderNodeTexGradient")
    grad.gradient_type = "LINEAR"
    gmap = nt.nodes.new("ShaderNodeMapping")
    gmap.inputs["Rotation"].default_value[1] = math.radians(90.0)  # vertical
    nt.links.new(tex.outputs["Window"], gmap.inputs["Vector"])
    nt.links.new(gmap.outputs["Vector"], grad.inputs["Vector"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = (bg_val * 0.7, bg_val * 0.72, bg_val * 0.78, 1.0)
    ramp.color_ramp.elements[1].position = 1.0
    ramp.color_ramp.elements[1].color = (bg_val, bg_val, bg_val, 1.0)
    nt.links.new(grad.outputs["Color"], ramp.inputs["Fac"])
    cam_bg = nt.nodes.new("ShaderNodeBackground")
    nt.links.new(ramp.outputs["Color"], cam_bg.inputs["Color"])
    cam_bg.inputs["Strength"].default_value = 1.0

    lp = nt.nodes.new("ShaderNodeLightPath")
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(lp.outputs["Is Camera Ray"], mix.inputs["Fac"])
    nt.links.new(env_bg.outputs["Background"], mix.inputs[1])  # non-camera → HDRI reflections
    nt.links.new(cam_bg.outputs["Background"], mix.inputs[2])  # camera → gradient sweep
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])


def _area_light(name, loc, target, size, energy, color):
    """A soft-box: rectangular area light aimed at `target`."""
    data = bpy.data.lights.new(name, type="AREA")
    data.shape = "RECTANGLE"
    data.size = size
    data.size_y = size
    data.energy = energy
    data.color = color
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = loc
    direction = (Vector(target) - Vector(loc)).normalized()
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    return obj


def setup_studio_lights(lo, hi, key_hard=1.0):
    """Three-point SOFT-BOX rig (big area lights) sized to the model — warm key,
    cool fill, bright rim — for flattering soft highlights and gentle shadows."""
    center = (lo + hi) * 0.5
    d = max((hi - lo).length, 1e-3)
    tgt = (center.x, center.y, center.z)
    # Key — big, high, front-right, warm.
    _area_light("Key", (center.x + d * 0.7, center.y - d * 1.2, center.z + d * 1.3),
                tgt, size=d * 1.7 * key_hard, energy=d * d * 12.0, color=(1.0, 0.96, 0.9))
    # Fill — broad, front-left, cool, softer.
    _area_light("Fill", (center.x - d * 1.3, center.y - d * 0.5, center.z + d * 0.7),
                tgt, size=d * 2.4, energy=d * d * 4.0, color=(0.9, 0.94, 1.0))
    # Rim — behind + above, bright, to pop the silhouette.
    _area_light("Rim", (center.x, center.y + d * 1.3, center.z + d * 1.4),
                tgt, size=d * 1.2 * key_hard, energy=d * d * 9.0, color=(1.0, 1.0, 1.0))


def add_floor(lo, hi):
    """Large glossy studio floor at the model's base — contact shadow + soft
    reflection (the reflection is a big part of the premium product look)."""
    span = max((hi - lo).length, 1e-3)
    # Sit the plane a hair BELOW the model so the two are not coplanar (shadow
    # acne). Note this offset is ~400x smaller than the crevice-AO distance, so
    # it does NOT stop the floor from contributing to that mask — see the
    # only_local note on the crevice AO in build_material().
    bpy.ops.mesh.primitive_plane_add(size=span * 16.0, location=(0, 0, lo.z - span * 1e-4))
    floor = bpy.context.object
    mat = bpy.data.materials.new("Floor")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    sin(bsdf, "Base Color", (0.9, 0.9, 0.92, 1.0))
    sin(bsdf, "Roughness", 0.28)          # glossy → soft mirror reflection
    sin(bsdf, "Metallic", 0.0)
    sin(bsdf, ["Specular IOR Level", "Specular"], 0.6)
    floor.data.materials.append(mat)
    return floor


def setup_compositing(scene, enable=True):
    """Post: subtle fog-glow bloom on highlights + gentle contrast/saturation +
    a soft vignette — the difference between a 'CG' frame and a photographic one."""
    if not enable:
        return
    try:
        scene.use_nodes = True
        nt = scene.node_tree
        for n in list(nt.nodes):
            nt.nodes.remove(n)
        rl = nt.nodes.new("CompositorNodeRLayers")
        cur = rl.outputs["Image"]

        glare = nt.nodes.new("CompositorNodeGlare")
        glare.glare_type = "FOG_GLOW"
        glare.quality = "HIGH"
        glare.threshold = 1.1
        glare.mix = -0.82           # mostly original + a touch of bloom
        try: glare.size = 7
        except Exception: pass
        nt.links.new(cur, glare.inputs["Image"]); cur = glare.outputs["Image"]

        bc = nt.nodes.new("CompositorNodeBrightContrast")
        try: bc.inputs["Contrast"].default_value = 0.0
        except Exception: pass
        nt.links.new(cur, bc.inputs["Image"]); cur = bc.outputs["Image"]

        hs = nt.nodes.new("CompositorNodeHueSat")
        try: hs.inputs["Saturation"].default_value = 1.0
        except Exception: pass
        nt.links.new(cur, hs.inputs["Image"]); cur = hs.outputs["Image"]

        # Soft vignette: feathered ellipse mask → darken edges gently.
        try:
            mask = nt.nodes.new("CompositorNodeEllipseMask")
            mask.width = 1.15; mask.height = 1.15
            blur = nt.nodes.new("CompositorNodeBlur")
            blur.filter_type = "FAST_GAUSS"; blur.size_x = 180; blur.size_y = 180
            nt.links.new(mask.outputs["Mask"], blur.inputs["Image"])
            vramp = nt.nodes.new("CompositorNodeValToRGB")
            vramp.color_ramp.elements[0].color = (0.82, 0.82, 0.82, 1.0)  # edge dim
            vramp.color_ramp.elements[1].color = (1.0, 1.0, 1.0, 1.0)     # center
            nt.links.new(blur.outputs["Image"], vramp.inputs["Fac"])
            mul = nt.nodes.new("CompositorNodeMixRGB")
            mul.blend_type = "MULTIPLY"; mul.inputs[0].default_value = 1.0
            nt.links.new(cur, mul.inputs[1])
            nt.links.new(vramp.outputs["Image"], mul.inputs[2])
            cur = mul.outputs["Image"]
        except Exception as e:
            print(f"[pbr] vignette skipped: {e}", flush=True)

        comp = nt.nodes.new("CompositorNodeComposite")
        nt.links.new(cur, comp.inputs["Image"])
    except Exception as e:
        print(f"[pbr] compositing skipped: {e}", flush=True)


def setup_render(size, samples, use_gpu, exposure, tone="AgX"):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    try:
        scene.cycles.denoiser = "OPENIMAGEDENOISE"
    except Exception:
        pass
    scene.cycles.use_adaptive_sampling = True
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False
    scene.render.use_persistent_data = True
    # View transform: requested first (default AgX — filmic highlight rolloff,
    # the photographic look), then graceful fallbacks.
    for vt in (tone, "AgX", "Filmic", "Khronos PBR Neutral", "Standard"):
        try:
            scene.view_settings.view_transform = vt
            break
        except TypeError:
            continue
    try:
        scene.view_settings.look = "None"
    except Exception:
        pass
    scene.view_settings.exposure = exposure

    enable_gpu(scene, use_gpu)


# ───────────── camera fits (identical framing to parts-color) ─────────────

def fit_persp_to_mesh(objs, cam_dir_norm, fov_deg, padding=1.06):
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
        chunks.append((np.concatenate([local, ones], axis=1) @ M.T)[:, :3])
    if not chunks:
        return 0.1, Vector((0, 0, 0))
    V = np.concatenate(chunks, axis=0)
    xc = np.array([x_cam.x, x_cam.y, x_cam.z], dtype=np.float32)
    yc = np.array([y_cam.x, y_cam.y, y_cam.z], dtype=np.float32)
    dc = np.array([cam_dir.x, cam_dir.y, cam_dir.z], dtype=np.float32)
    vx, vy, rz = V @ xc, V @ yc, V @ dc
    P_x = float((vx + ht * rz).max()); Q_x = float((vx - ht * rz).min())
    P_y = float((vy + ht * rz).max()); Q_y = float((vy - ht * rz).min())
    d = max((P_x - Q_x) / (2 * ht), (P_y - Q_y) / (2 * ht), float(rz.max()) + 1e-3, 0.1)
    aim = x_cam * ((P_x + Q_x) / 2) + y_cam * ((P_y + Q_y) / 2)
    return d * padding, aim


def fit_ortho_to_mesh(objs, cam_dir_norm, padding=1.06):
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
        chunks.append((np.concatenate([local, ones], axis=1) @ M.T)[:, :3])
    if not chunks:
        return 1.0, Vector((0, 0, 0)), 1.0
    V = np.concatenate(chunks, axis=0)
    xc = np.array([x_cam.x, x_cam.y, x_cam.z], dtype=np.float32)
    yc = np.array([y_cam.x, y_cam.y, y_cam.z], dtype=np.float32)
    dc = np.array([cam_dir.x, cam_dir.y, cam_dir.z], dtype=np.float32)
    vx, vy, rz = V @ xc, V @ yc, V @ dc
    P_x, Q_x = float(vx.max()), float(vx.min())
    P_y, Q_y = float(vy.max()), float(vy.min())
    span = max(P_x - Q_x, P_y - Q_y, 1e-3)
    aim = x_cam * ((P_x + Q_x) / 2) + y_cam * ((P_y + Q_y) / 2)
    distance = (float(rz.max()) - float(rz.min())) + span + 1e-3
    return distance, aim, span * padding


def place_camera(pos_norm, objs, fov_deg=42.0, ortho=False):
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
    cam_data.clip_start = 1e-3
    cam_data.clip_end = 1e6
    scene = bpy.context.scene
    rx, ry = scene.render.resolution_x, scene.render.resolution_y
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


# ───────────────────────── main ─────────────────────────

def main():
    args = parse_args()
    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    spec = json.loads(Path(args.spec).read_text())
    parts = spec.get("parts", [])
    if not parts:
        raise SystemExit("spec has no parts")

    reset_scene()

    all_objs = []
    for part in parts:
        objs = import_mesh(str(Path(part["stl"]).resolve()), args.z_up, args.smooth_angle)
        mat = build_material(part.get("name", "part"), part,
                             edge_bevel=args.edge_bevel,
                             bevel_samples=args.bevel_samples)
        for o in objs:
            o.data.materials.clear()
            o.data.materials.append(mat)
        all_objs.extend(objs)
    if not all_objs:
        raise SystemExit("no meshes imported")

    # Centre, normalize to ~2 units, sit on the floor, then BAKE the transform
    # into mesh data — so procedural textures (Object coords) and AO ray
    # distances live in one consistent normalized space regardless of the
    # model's mm scale (otherwise grime/wear are invisible on a 100 mm model).
    lo, hi = compute_bbox(all_objs)
    center = (lo + hi) * 0.5
    for o in all_objs:
        o.matrix_world = Matrix.Translation(-center) @ o.matrix_world
    bpy.context.view_layer.update()
    lo, hi = compute_bbox(all_objs)
    maxdim = max((hi - lo).x, (hi - lo).y, (hi - lo).z, 1e-6)
    for o in all_objs:
        o.matrix_world = Matrix.Scale(2.0 / maxdim, 4) @ o.matrix_world
    bpy.context.view_layer.update()
    lo, hi = compute_bbox(all_objs)
    for o in all_objs:
        o.matrix_world = Matrix.Translation((0, 0, -lo.z)) @ o.matrix_world
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action="DESELECT")
    for o in all_objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = all_objs[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.context.view_layer.update()
    lo, hi = compute_bbox(all_objs)

    setup_world(args.hdri, args.hdri_strength, args.bg)
    setup_studio_lights(lo, hi, args.key_hard)
    if not args.no_floor:
        add_floor(lo, hi)
    setup_render(args.size, args.samples, args.gpu, args.exposure, args.tone)
    setup_compositing(bpy.context.scene, enable=not args.no_comp)

    _tilt = 0.2679
    all_angles = {
        "front": (0, -1, 0), "back": (0, 1, 0), "left": (-1, 0, 0), "right": (1, 0, 0),
        "top": (0, 0, 1), "bottom": (0, 0, -1),
        "isometric": (1, -1, 1), "iso-FL-top": (-1, -1, 1), "iso-BR-top": (1, 1, 1),
        "iso-BL-top": (-1, 1, 1), "iso-FR-bot": (1, -1, -1), "iso-FL-bot": (-1, -1, -1),
        "iso-BR-bot": (1, 1, -1), "iso-BL-bot": (-1, 1, -1),
        "front-right": (1, -1, 0), "front-left": (-1, -1, 0),
        "back-right": (1, 1, 0), "back-left": (-1, 1, 0),
        "front-low": (0, -1, -_tilt), "front-high": (0, -1, _tilt),
    }
    ortho_views = {"front", "back", "left", "right", "top", "bottom"}
    wanted = [v.strip() for v in args.views.split(",") if v.strip()]
    unknown = [v for v in wanted if v not in all_angles]
    if unknown:
        raise SystemExit(f"Unknown view names: {unknown}")

    scene = bpy.context.scene
    for name in wanted:
        cam = place_camera(all_angles[name], all_objs, ortho=(name in ortho_views))
        scene.camera = cam
        scene.render.filepath = str(out_dir / f"{args.out_prefix}-{name}.png")
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(cam, do_unlink=True)
        print(f"[pbr] {name}: {scene.render.filepath}", flush=True)


if __name__ == "__main__":
    main()
