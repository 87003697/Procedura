## Articulation (motion-aware mode)

This run feeds a downstream motion/articulation pipeline. Each element may additionally include an OPTIONAL `"motion"` object describing how the part moves once assembled:

```
"motion": {"moving": true|false,
           "jointType": "revolute"|"prismatic"|"spherical"|"fixed",
           "parent": "<name of the EARLIER part it moves relative to>",
           "axis": "X"|"Y"|"Z" (world axis of the joint after placement),
           "role": "<short: wheel | turret_yaw | hinge_door | arm_segment | ...>",
           "limitHint": "continuous"|"small"|"medium"|"wide"}
```

Rules:
- Include `"motion"` only where articulation is real. Omit it for plainly static parts.
- A part that MOVES relative to its neighbour must be its OWN part — never fold a rotating/sliding part into a static parent part.
- Each repeated moving copy (4 wheels, 6 legs) is its OWN plan part — never one looped part.
- `"parent"` must name an earlier part in the list. Do NOT invent coordinates anywhere — every motion field is categorical.
