// ============================================================================
// lib/assembly.scad — production-level assembly-interface helpers
// ----------------------------------------------------------------------------
// Injected into the incremental build seed only in assembly-aware mode
// (--assembly / PROCEDURA_INCREMENTAL_ASSEMBLY). Gives the per-part generator a
// shared vocabulary of MATING FEATURES so two parts fit like a real product
// instead of merely overlapping.
//
// The one rule that makes generated parts actually assemble: every male/female
// pair is cut from ONE shared nominal dimension plus a signed FIT offset — never
// model the two halves from two independent literals. Read the neighbour's
// nominal from the SCAD-so-far buffer and reuse it here.
//
// Clearances are FDM-tuned (PROCEDURA_ASSEMBLY_PROCESS=fdm): larger than machined
// so parts don't weld solid or rattle when 3D-printed.
//
// CONVENTION
//   * MALE / additive solids  (asm_peg, asm_boss, asm_snap_tab, asm_tab)
//       -> union() them onto the part.
//   * FEMALE / negative tools  (asm_socket, asm_bolt_hole, asm_bolt_circle,
//       asm_snap_window, asm_slot)
//       -> subtract:  difference() { my_body(); asm_socket(...); }
//   * Every male tip and female mouth carries a LEAD-IN CHAMFER so the part
//     self-centres as it seats — the single cheapest thing that makes a
//     generated part assemble. Keep it; do not model bare cylinders.
//   * $fn is inherited from the build (set globally); do not override it here.
// ============================================================================

// NOTE: the fit/size FUNCTIONS live at the BOTTOM of this file, after the
// modules. OpenSCAD hoists all defs, so order is irrelevant — but keeping the
// first top-level definition a MODULE means that when this library is inlined
// into the build seed, the function bodies never land in the seed's "params"
// region (which is scanned as `name = value` globals), so nothing here is ever
// mistaken for a build parameter.

// ---- pin / peg ↔ socket ----------------------------------------------------
// MALE peg, base at origin, growing +Z, with a chamfered self-centring tip.
// Pair with asm_socket(d, ...) cut from the SAME d.
module asm_peg(d, len) {
    lead = asm_lead(d);
    union() {
        cylinder(h = max(0.01, len - lead), d = d);
        translate([0, 0, len - lead])
            cylinder(h = lead, d1 = d, d2 = max(0.2, d - 2 * lead));
    }
}

// FEMALE socket NEGATIVE tool. Bore = d + fit; mouth flares for lead-in.
// Drill downward into a body whose top face sits at z = depth.
module asm_socket(d, depth, cls = "location") {
    bore = d + 2 * asm_fit(cls);
    lead = asm_lead(bore);
    union() {
        translate([0, 0, -0.01]) cylinder(h = depth + 0.02, d = bore);
        translate([0, 0, depth - lead])
            cylinder(h = lead + 0.01, d1 = bore, d2 = bore + 2 * lead);
    }
}

// ---- fasteners -------------------------------------------------------------
// Single clearance-hole NEGATIVE tool for a metric screw, drilled downward from
// the z=0 top face to z=-depth, with a lead-in funnel and optional counterbore
// for a socket-head cap screw.
module asm_bolt_hole(m, depth, cbore = false, cbore_d = 0, cbore_depth = 0) {
    cd   = asm_bolt_clear_d(m);
    lead = 0.6;
    cbd  = cbore_d     > 0 ? cbore_d     : cd + m;   // head pocket
    cbh  = cbore_depth > 0 ? cbore_depth : m;
    union() {
        translate([0, 0, -depth]) cylinder(h = depth + 0.02, d = cd);
        // entry funnel (countersink lead-in) at the top face
        translate([0, 0, -lead]) cylinder(h = lead + 0.01, d1 = cd, d2 = cd + 2 * lead);
        if (cbore) translate([0, 0, -cbh]) cylinder(h = cbh + 0.02, d = cbd);
    }
}

// Bolt-circle pattern of clearance holes (NEGATIVE tool). `count` holes evenly
// on a circle of diameter `bcd`, rotated by `phase` degrees; drilled downward.
module asm_bolt_circle(bcd, count, m, depth, phase = 0, cbore = false) {
    for (i = [0 : max(1, count) - 1])
        rotate([0, 0, phase + i * 360 / max(1, count)])
            translate([bcd / 2, 0, 0])
                asm_bolt_hole(m, depth, cbore);
}

// MALE standoff / mounting boss (solid) with a screw bore differenced and a
// filleted base. Union onto a wall; screw drives into the bore from +Z.
module asm_boss(od, screw_d, height, cls = "press", fillet = 1) {
    difference() {
        union() {
            cylinder(h = height, d = od);
            cylinder(h = fillet, d1 = od + 2 * fillet, d2 = od);   // base fillet ring
        }
        translate([0, 0, -0.01])
            cylinder(h = height + 0.02, d = screw_d + 2 * asm_fit(cls));
    }
}

// ---- snap fit --------------------------------------------------------------
// MALE cantilever snap tab (solid). Beam of section thick(X) × width(Z=extrude)
// growing +Y (length); hook bump of `hook` faces +X near the tip, with a
// ramped lead-in so it deflects on insertion and latches behind the ledge.
module asm_snap_tab(width, length, thick, hook = 1.2) {
    linear_extrude(height = width)
        polygon([
            [0, 0],
            [thick, 0],
            [thick, length - 2 * hook],
            [thick + hook, length - hook],   // catch ledge
            [thick, length],                 // ramped tip (lead-in)
            [0, length],
        ]);
}

// FEMALE catch window (NEGATIVE tool) for a snap tab: a through pocket sized
// tab + `gap` all round so the hook clears on insertion and latches.
module asm_snap_window(width, length, thick, gap = 0.3) {
    translate([-gap, -gap, -gap])
        cube([thick + 2 * gap, length + 2 * gap, width + 2 * gap]);
}

// ---- tab / slot (planar keyed alignment) -----------------------------------
// MALE locating tab (solid): rectangular projection width(X) × thick(Y) growing
// +Z (length), with a chamfered tip that self-centres into a slot.
module asm_tab(width, thick, length, chamfer = 0.8) {
    ch = min(chamfer, min(width, thick) / 2 - 0.05);
    hull() {
        linear_extrude(height = 0.01) square([width, thick]);
        translate([ch, ch, length - 0.01])
            linear_extrude(height = 0.01) square([width - 2 * ch, thick - 2 * ch]);
    }
}

// FEMALE slot (NEGATIVE tool) sized tab + fit, with a funnel mouth at z=depth.
module asm_slot(width, thick, depth, cls = "location") {
    g    = asm_fit(cls);
    lead = 0.6;
    union() {
        translate([-g, -g, -0.01]) cube([width + 2 * g, thick + 2 * g, depth + 0.02]);
        translate([0, 0, depth - lead])
            hull() {
                translate([-g, -g, 0])
                    linear_extrude(height = 0.01) square([width + 2 * g, thick + 2 * g]);
                translate([-g - lead, -g - lead, lead])
                    linear_extrude(height = 0.01)
                        square([width + 2 * g + 2 * lead, thick + 2 * g + 2 * lead]);
            }
    }
}

// ---- fit / size functions (kept last; see NOTE at top) ---------------------
// Per-side offset in mm applied to the FEMALE feature (added to the shared
// nominal). Positive = clearance (gap); negative = interference (press).
//   clearance : free-moving slip fit (guides, shafts that must rotate/slide)
//   location  : snug hand-press register (locating pins/pegs, seams)
//   press     : interference (dowels, heat-set bushings — needs force/heat)
//   snap      : working gap for a flexing catch to clear then latch
function asm_fit(cls) =
    cls == "clearance" ? 0.25 :
    cls == "location"  ? 0.15 :
    cls == "press"     ? -0.05 :
    cls == "snap"      ? 0.20 :
    0.15;

// ISO-273-style clearance-hole diameter (normal series) for a metric screw M<m>.
function asm_bolt_clear_d(m) =
    m <= 2  ? m + 0.4 :
    m <= 3  ? m + 0.6 :
    m <= 6  ? m + 0.8 :
    m <= 12 ? m + 1.0 :
              m + 1.5;

// Lead-in chamfer size for a mouth / tip of diameter d (min 0.6 mm).
function asm_lead(d) = max(0.6, 0.15 * d);
