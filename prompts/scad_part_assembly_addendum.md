ASSEMBLY — make this part actually MATE, not just overlap:

Connectivity requires a ≥0.5 mm overlap, but a production part *joins* its neighbour through a real interface. Where this part meets an already-built neighbour, reproduce the matching mating feature so the two seat like a manufactured product — WITHOUT changing the faithful size/aspect/pose above (those still win; the interface is added at the contact, not by resizing the part).

- **Shared nominal.** Read the neighbour's relevant dimension from the SCAD-so-far buffer and reuse that SAME value here. Cut the FEMALE feature at nominal + clearance and the MALE feature at nominal − clearance — never invent two independent numbers for the two halves, or they won't fit.
- **Lead-in chamfer.** Put a small chamfer/taper on every pin/peg tip and every hole/slot mouth so the part self-centres as it seats. (The helper modules already do this.)
- **Locate, then fasten — separate jobs.** Use a snug register (peg/socket, boss/recess, tab/slot, a locating pin) to fix position, and looser clearance holes to bolt/screw. Don't force one feature to do both.
- **Prefer an integral interlock** (snap tab, press-fit boss, tab-and-slot) over a separate floating fastener when the reference allows — fewer loose pieces. Do NOT merge this part into its neighbour to achieve that; it stays its own part.
- **Key it if it's directional.** If the reference shows the part can only go one way, add a small asymmetry (offset pin, single chamfered corner, blocking rib) so it can't seat backwards.

Helper modules are available in the build (call them; the fit/clearance is handled for you — do not redefine them):
- `asm_peg(d,len)` / `asm_socket(d,depth,cls)` — a locating pin/peg and its bore (subtract the socket). Share `d`.
- `asm_bolt_hole(m,depth,cbore)` / `asm_bolt_circle(bcd,count,m,depth)` — clearance hole(s) for an M`m` screw (subtract).
- `asm_boss(od,screw_d,height)` — a screw boss/standoff (union on).
- `asm_snap_tab(width,length,thick)` / `asm_snap_window(width,length,thick)` — a cantilever snap and its catch window.
- `asm_tab(width,thick,length)` / `asm_slot(width,thick,depth,cls)` — a keyed alignment tab and its slot.
- `cls` fit ∈ `"clearance"` (moves), `"location"` (snug), `"press"` (interference), `"snap"`.

Male features (`asm_peg`/`asm_boss`/`asm_snap_tab`/`asm_tab`) are solids to `union()` onto the part; female features (`asm_socket`/`asm_bolt_*`/`asm_snap_window`/`asm_slot`) are negative tools to `difference()` out. You may also model the interface by hand — but keep the shared-nominal + lead-in rules. Custom helpers still go in the HELPERS block; the four-block format is unchanged.
