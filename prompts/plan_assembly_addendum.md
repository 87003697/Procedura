## Assembly interfaces (assembly-aware mode)

This run feeds a downstream assembly/verification step. Each element may additionally include an OPTIONAL `"assembly"` object describing HOW this part mechanically joins the earlier part it attaches to:

```
"assembly": {"partner": "<name of the EARLIER part this one mates to>",
             "mate": "bolt_pattern"|"peg_socket"|"seat_face"|"snap_tab"|"tab_slot"|"flange"|"lip_rabbet"|"key"|"press_fit",
             "fit": "clearance"|"location"|"press"|"snap",
             "role": "<short: mount bracket to base | cap on housing | ...>",
             "count": <integer, e.g. number of bolts or tabs>,
             "fasten": "screw"|"snap"|"dowel"|"none"}
```

Rules:
- Include `"assembly"` where a part joins an earlier part through a REAL mechanical interface (a bolted flange, a peg into a socket, a snap cap, a bracket screwed to a wall). Omit it for parts that simply blend into or abut a surface with no distinct joint.
- `"partner"` MUST name a part earlier in the list (it has to exist before this part can mate to it).
- Choose the `"mate"` and `"fit"` that match what the reference shows; prefer an integral interlock (snap_tab, tab_slot, press_fit) over a separate fastener when plausible — but NEVER merge two parts into one to achieve that; each stays its own part.
- Everything is CATEGORICAL. Do NOT invent coordinates, sizes, or dimensions anywhere — the geometry is measured later.
