# Archived octree-mapping prototypes

These files preserve superseded experiment utilities and are not part of the active validation workflow.

- `build_mapping_correction.py` is the archived legacy producer: it consumes the `multiview-direction.json` part-summary contract and emits a schema-v1 correction packet.
- `apply_mapping_correction.ts` is the archived legacy consumer: it applies that schema-v1 packet to assembly placements.

The current Mapping Agent emits schema-v5 region feedback rather than schema-v1 correction packets, so both prototypes are retained only for historical reproduction.
