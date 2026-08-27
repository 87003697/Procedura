#!/usr/bin/env python3
"""Headless Isaac Sim validation harness for Procedura motion assets.

Runs under Isaac Sim's python.sh:

  cd $PROCEDURA_ISAACSIM_PATH && ./python.sh isaac_validate.py \
      --usd /path/to/final_motion.usda --report /path/to/isaac_validation.json

Phases:
  1. schemaAudit   (required)    pxr traversal of physics schemas.
  2. assetRules    (best-effort) omni.asset_validator.core ValidationEngine.
  3. simulation    (required)    play the timeline, step N frames, watch the articulation.
  4. actuation     (required with --hints) per-joint drive sweep in an isolated
                                 zero-gravity, root-pinned regime.
  5. contacts      (advisory)    PhysX contact-report scan at rest + during sweeps.
  6. mobility      (advisory)    wheeled-base drive test on the ground plane.
  7. urdfRoundTrip (best-effort) re-import the exported URDF, only with --urdf.

--hints PATH points at a JSON file the pipeline derives from the MotionPlan:
  { "rootLink": str, "fixedBase": bool,
    "drivenJoints": [{"name", "mode": "position"|"velocity", "lower", "upper",
                      "targetVelocity"}],
    "wheelJoints": [str], "mimicJoints": [{"follower","reference","gearing","offset"}] }
Angles in hints are DEGREES (the Isaac tensor API speaks radians). Without
--hints the new phases record {"skipped": true} and nothing else changes.

--frames-dir PATH enables RGB frame capture (rest pose, sweep limit poses,
mobility end pose) via an omni.replicator.core rgb annotator.

The report JSON is always written (flush + fsync) BEFORE SimulationApp.close(),
because Isaac exits via os._exit(). Exit code 0 means "report written" even when
the validation itself failed; nonzero means the report could not be written.
"""

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import time
import traceback

parser = argparse.ArgumentParser(description="Procedura motion asset validation in headless Isaac Sim")
parser.add_argument("--usd", required=True, help="Path to the USD(A) asset to validate")
parser.add_argument("--report", required=True, help="Path to write the JSON validation report")
parser.add_argument("--steps", type=int, default=120, help="Simulation frames to run (default 120)")
parser.add_argument("--urdf", default=None, help="Optional URDF path for the round-trip import phase")
parser.add_argument("--hints", default=None, help="Optional JSON with driven-joint/wheel/mimic hints from the MotionPlan")
parser.add_argument("--frames-dir", default=None, help="Optional directory: capture RGB frames of swept poses into it")
parser.add_argument("--videos-dir", default=None, help="Optional directory: record MP4 clips of the joint sweeps and mobility drive (needs ffmpeg)")
args, _unknown = parser.parse_known_args()

T_START = time.time()

# SimulationApp must be created before any omni.* / kit-pxr import.
from isaacsim import SimulationApp  # noqa: E402

app = SimulationApp({"headless": True})

STARTUP_SEC = time.time() - T_START

# Angular velocity explosion threshold: 5e4 deg/s.
MAX_ANGULAR_VEL_DEG = 5.0e4
# Velocity growth ratio (first quarter -> last quarter) considered unstable.
GROWTH_RATIO = 1.0e3
# Fixed-base root drift limit as a fraction of the model diagonal.
FIXED_DRIFT_FRAC = 0.01
# Free-base root drift limit in model diagonals.
FREE_DRIFT_DIAGONALS = 5.0
# DOF limit escape tolerance as a fraction of the limit range.
LIMIT_TOLERANCE_FRAC = 0.05
# Actuation sweep: a position-driven joint must traverse this fraction of its
# commanded lower->upper range to pass.
SWEEP_MIN_RANGE_FRACTION = 0.5
# Actuation sweep: nominal frames to hold each commanded target (adaptive: the
# sweep exits early once the target is reached, and gives up after 240 frames).
SWEEP_NOMINAL_FRAMES = 90
SWEEP_MAX_FRAMES = 240
# Velocity-mode check: final |velocity| must reach this fraction of the command.
VELOCITY_MIN_FRACTION = 0.3
VELOCITY_SWEEP_FRAMES = 60
DEFAULT_SWEEP_VELOCITY = 180.0  # deg/s (or model units/s for prismatic DOFs)
# Mimic follower tracking tolerance (degrees).
MIMIC_TRACKING_TOLERANCE_DEG = 10.0
# Mobility: required root XY displacement as a fraction of the model diagonal.
MOBILITY_MIN_DIAGONAL_FRACTION = 0.02
MOBILITY_DRIVE_FRAMES = 180
MOBILITY_SETTLE_FRAMES = 30
# Contact scan: frames of the passive phase scanned for rest contacts, and the
# cap on reported contact-pair list lengths.
REST_CONTACT_FRAMES = 30
CONTACT_LIST_CAP = 40
# Frame capture: resolution, total budget, camera placement.
FRAME_RESOLUTION = (768, 576)
FRAME_BUDGET = 16
CAMERA_DIRECTION = (1.0, -1.0, 0.6)  # normalized below; 3/4 view
CAMERA_DISTANCE_DIAGONALS = 1.6
# Video capture: every VIDEO_FRAME_STRIDE-th sim step becomes one video frame
# (60 fps sim / stride 2 -> 30 fps real-time playback), capped per clip and in
# total clip count. Mobility uses a wider framing so the travel stays in view.
VIDEO_FRAME_STRIDE = 2
VIDEO_FPS = 30
VIDEO_MAX_FRAMES = 360
VIDEO_MIN_FRAMES = 8
VIDEO_BUDGET = 10
MOBILITY_CAMERA_DISTANCE_DIAGONALS = 2.4

VALID_APPROXIMATIONS = {
    "none", "convexHull", "convexDecomposition", "boundingCube",
    "boundingSphere", "meshSimplification", "sdf", "triangleMesh",
}

# Asset-rule checkers that encode Omniverse publishing/folder-layout conventions
# (folder named after the robot, no authored attrs outside a base layer, packaged
# thumbnails, ...). They can never pass for a standalone exported .usda and say
# nothing about simulability, so they are excluded from the assetRules phase.
SKIPPED_RULE_NAMES = {"RobotNaming", "CleanFolder", "NoOverrides", "ThumbnailExists"}

report = {
    "ok": False,
    "usdPath": os.path.abspath(args.usd),
    "urdfPath": os.path.abspath(args.urdf) if args.urdf else None,
    "phases": {},
    "errors": [],
    "warnings": [],
    "timings": {"startupSec": round(STARTUP_SEC, 2), "totalSec": 0.0, "phases": {}},
}

hints = None
if args.hints:
    try:
        with open(args.hints) as f:
            hints = json.load(f)
    except Exception as exc:
        report["warnings"].append(f"could not read --hints {args.hints}: {exc}; running without hints")

if args.frames_dir:
    report["frames"] = []
if args.videos_dir:
    report["videos"] = []


def record_phase_seconds(name, t_start):
    report["timings"]["phases"][name] = round(time.time() - t_start, 2)


def write_report_and_exit(exit_code):
    report["timings"]["totalSec"] = round(time.time() - T_START, 2)
    try:
        report_dir = os.path.dirname(os.path.abspath(args.report))
        os.makedirs(report_dir, exist_ok=True)
        with open(args.report, "w") as f:
            json.dump(report, f, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
    except Exception:
        traceback.print_exc()
        sys.stdout.flush()
        sys.stderr.flush()
        try:
            app.close()
        finally:
            os._exit(1)
    print(f"[isaac_validate] report written to {args.report} (ok={report['ok']})")
    sys.stdout.flush()
    sys.stderr.flush()
    try:
        app.close()
    finally:
        os._exit(exit_code)


try:
    import numpy as np
    import omni.timeline
    import omni.usd
    from isaacsim.core.utils.extensions import enable_extension
    from isaacsim.core.utils.stage import is_stage_loading
    from pxr import Gf, PhysicsSchemaTools, PhysxSchema, Sdf, Usd, UsdGeom, UsdLux, UsdPhysics

    # ------------------------------------------------------------------
    # Open the stage.
    # ------------------------------------------------------------------
    usd_path = os.path.abspath(args.usd)
    if not os.path.isfile(usd_path):
        raise FileNotFoundError(f"USD asset not found: {usd_path}")

    ctx = omni.usd.get_context()

    def open_stage_fresh():
        """(Re-)open the source stage; edits from a previous regime are dropped."""
        opened_ = ctx.open_stage(usd_path)
        for _ in range(10):
            app.update()
        while is_stage_loading():
            app.update()
        stage_ = ctx.get_stage()
        if not opened_ or stage_ is None:
            raise RuntimeError(f"Failed to open stage: {usd_path}")
        return stage_

    stage = open_stage_fresh()

    # ------------------------------------------------------------------
    # Phase 1: schemaAudit (required).
    # ------------------------------------------------------------------
    t_phase = time.time()
    audit_errors = []
    audit_warnings = []
    articulation_root_paths = []
    rigid_body_paths = []
    joint_count = 0
    world_fixed_joint = False
    # Link adjacency for the contact scan: pairs of body paths that share a
    # joint, plus bodies joined directly to the world (single-target joints).
    joint_adjacent_pairs = set()
    world_joined_bodies = set()

    meters_per_unit = UsdGeom.GetStageMetersPerUnit(stage)
    try:
        kilograms_per_unit = UsdPhysics.GetStageKilogramsPerUnit(stage)
    except Exception:
        kilograms_per_unit = None

    def _subtree_has_collision(prim):
        for p in Usd.PrimRange(prim):
            if p.HasAPI(UsdPhysics.CollisionAPI):
                return True
        return False

    for prim in stage.Traverse():
        if prim.HasAPI(UsdPhysics.ArticulationRootAPI):
            articulation_root_paths.append(str(prim.GetPath()))

        if prim.HasAPI(UsdPhysics.RigidBodyAPI):
            rigid_body_paths.append(str(prim.GetPath()))
            rb = UsdPhysics.RigidBodyAPI(prim)
            enabled = rb.GetRigidBodyEnabledAttr().Get()
            kinematic = rb.GetKinematicEnabledAttr().Get()
            dynamic = (enabled is None or enabled) and not kinematic
            if dynamic and not _subtree_has_collision(prim):
                audit_errors.append(
                    f"dynamic rigid body {prim.GetPath()} has no collision prim in its subtree"
                )

        if prim.HasAPI(UsdPhysics.MeshCollisionAPI):
            approx = UsdPhysics.MeshCollisionAPI(prim).GetApproximationAttr().Get()
            if approx is not None and str(approx) not in VALID_APPROXIMATIONS:
                audit_errors.append(
                    f"collision prim {prim.GetPath()} has invalid approximation token: {approx}"
                )

        if prim.IsA(UsdPhysics.Joint):
            joint_count += 1
            joint = UsdPhysics.Joint(prim)
            body0 = joint.GetBody0Rel().GetTargets()
            body1 = joint.GetBody1Rel().GetTargets()
            for rel_name, targets in (("body0", body0), ("body1", body1)):
                for target in targets:
                    if not stage.GetPrimAtPath(target).IsValid():
                        audit_errors.append(
                            f"joint {prim.GetPath()} {rel_name} target does not resolve: {target}"
                        )
            if len(body0) == 0 and len(body1) == 0:
                audit_errors.append(f"joint {prim.GetPath()} has neither body0 nor body1 targets")
            if prim.IsA(UsdPhysics.FixedJoint) and (len(body0) == 0 or len(body1) == 0):
                world_fixed_joint = True
            if len(body0) > 0 and len(body1) > 0:
                for t0 in body0:
                    for t1 in body1:
                        joint_adjacent_pairs.add(frozenset((str(t0), str(t1))))
            elif len(body0) + len(body1) == 1:
                world_joined_bodies.add(str((list(body0) + list(body1))[0]))

            limit_pairs = []
            if prim.IsA(UsdPhysics.RevoluteJoint):
                j = UsdPhysics.RevoluteJoint(prim)
                limit_pairs.append((j.GetLowerLimitAttr().Get(), j.GetUpperLimitAttr().Get()))
            elif prim.IsA(UsdPhysics.PrismaticJoint):
                j = UsdPhysics.PrismaticJoint(prim)
                limit_pairs.append((j.GetLowerLimitAttr().Get(), j.GetUpperLimitAttr().Get()))
            for lower, upper in limit_pairs:
                if lower is not None and upper is not None and lower > upper:
                    audit_errors.append(
                        f"joint {prim.GetPath()} limit lower ({lower}) exceeds upper ({upper})"
                    )

    if len(articulation_root_paths) == 0:
        audit_errors.append("no UsdPhysics.ArticulationRootAPI prim found in the stage")

    gravity_magnitude = None
    for prim in stage.Traverse():
        if prim.IsA(UsdPhysics.Scene):
            g = UsdPhysics.Scene(prim).GetGravityMagnitudeAttr().Get()
            if g is not None:
                gravity_magnitude = float(g)
            break
    if (
        gravity_magnitude is not None
        and 5.0 <= gravity_magnitude <= 15.0
        and meters_per_unit < 0.01
    ):
        audit_warnings.append(
            f"gravityMagnitude {gravity_magnitude} looks like m/s^2 on a stage with metersPerUnit "
            f"{meters_per_unit} (stage-unit gravity should be ~{9.81 / meters_per_unit:.0f}); "
            "this is the legacy 1000x-weak-gravity bug"
        )

    report["phases"]["schemaAudit"] = {
        "ok": len(audit_errors) == 0,
        "errors": audit_errors,
        "warnings": audit_warnings,
        "stats": {
            "links": len(rigid_body_paths),
            "joints": joint_count,
            "articulationRoots": len(articulation_root_paths),
            "metersPerUnit": meters_per_unit,
            "kilogramsPerUnit": kilograms_per_unit,
            "gravityMagnitude": gravity_magnitude,
            "worldFixedJoint": world_fixed_joint,
        },
    }
    record_phase_seconds("schemaAudit", t_phase)

    # ------------------------------------------------------------------
    # Shared helpers for the simulation/actuation/contacts/mobility phases.
    # ------------------------------------------------------------------
    timeline = omni.timeline.get_timeline_interface()

    def compute_stage_bbox(stage_):
        """Return (center, diagonal, min_z) of the stage-wide default bbox."""
        bbox_cache = UsdGeom.BBoxCache(Usd.TimeCode.Default(), [UsdGeom.Tokens.default_])
        bound = bbox_cache.ComputeWorldBound(stage_.GetPseudoRoot())
        box_range = bound.ComputeAlignedRange()
        if box_range.IsEmpty():
            return None, 0.0, None
        size = box_range.GetSize()
        diag = float(math.sqrt(size[0] ** 2 + size[1] ** 2 + size[2] ** 2))
        mid = box_range.GetMidpoint()
        return (float(mid[0]), float(mid[1]), float(mid[2])), diag, float(box_range.GetMin()[2])

    def add_ground_plane(stage_, diag, ground_min_z):
        """Static ground cube just below the model (in-memory only)."""
        half_extent = max(diag * 10.0, 1.0)
        thickness = max(diag * 0.01, 0.01)
        top_z = ground_min_z - diag * 0.005
        ground = UsdGeom.Cube.Define(stage_, "/World/proceduraGroundPlane")
        xform = UsdGeom.Xformable(ground.GetPrim())
        xform.AddTranslateOp().Set(Gf.Vec3d(0.0, 0.0, top_z - thickness))
        xform.AddScaleOp().Set(Gf.Vec3f(half_extent, half_extent, thickness))
        UsdPhysics.CollisionAPI.Apply(ground.GetPrim())
        return {"topZ": round(top_z, 6), "halfExtent": round(half_extent, 6)}

    def warm_up_articulation(root_path_, frames=60):
        """Wrap root_path as an Articulation, play, and wait for the physics
        tensor entity. Returns the Articulation or None (timeline left playing)."""
        from isaacsim.core.experimental.prims import Articulation

        robot_ = Articulation(root_path_)
        timeline.play()
        for _ in range(frames):
            app.update()
            try:
                if robot_.is_physics_tensor_entity_valid():
                    return robot_
            except Exception:
                pass
        return None

    # ---- Contact scan machinery (omni.physx immediate contact-report API).
    contact_stats = {"events": 0, "pollErrors": 0}
    rest_contact_pairs = {}    # pairKey -> {"bodyA","bodyB","adjacent"}
    sweep_contact_pairs = {}   # (joint, pairKey) -> {"joint","bodyA","bodyB","adjacent"}
    _physx_sim = None
    _contact_lost_type = None
    try:
        from omni.physx.bindings._physx import ContactEventType as _ContactEventType

        _contact_lost_type = _ContactEventType.CONTACT_LOST
    except Exception:
        pass

    def apply_contact_report_apis(stage_):
        """PhysxContactReportAPI (threshold 0) on every link rigid body."""
        applied = 0
        for body_path in rigid_body_paths:
            prim_ = stage_.GetPrimAtPath(body_path)
            if not prim_.IsValid():
                continue
            api = PhysxSchema.PhysxContactReportAPI.Apply(prim_)
            api.CreateThresholdAttr().Set(0.0)
            applied += 1
        return applied

    def bodies_adjacent(path_a, path_b):
        if frozenset((path_a, path_b)) in joint_adjacent_pairs:
            return True
        # Two bodies each joined directly to the world count as adjacent too.
        return path_a in world_joined_bodies and path_b in world_joined_bodies

    def poll_contacts(sweep_joint=None):
        """Read this step's contact report; record link-link pairs (ground ignored)."""
        try:
            from omni.physx import get_physx_simulation_interface

            iface = get_physx_simulation_interface()
            result = iface.get_contact_report()
            headers = result[0] if isinstance(result, tuple) else result
        except Exception:
            contact_stats["pollErrors"] += 1
            return
        for header in headers:
            try:
                if _contact_lost_type is not None and header.type == _contact_lost_type:
                    continue
                actor0 = str(PhysicsSchemaTools.intToSdfPath(header.actor0))
                actor1 = str(PhysicsSchemaTools.intToSdfPath(header.actor1))
            except Exception:
                continue
            contact_stats["events"] += 1
            if "proceduraGroundPlane" in actor0 or "proceduraGroundPlane" in actor1:
                continue
            key = tuple(sorted((actor0, actor1)))
            record = {
                "bodyA": key[0].rsplit("/", 1)[-1],
                "bodyB": key[1].rsplit("/", 1)[-1],
                "adjacent": bodies_adjacent(key[0], key[1]),
            }
            if sweep_joint is None:
                rest_contact_pairs.setdefault(key, record)
            else:
                sweep_contact_pairs.setdefault((sweep_joint, key), {"joint": sweep_joint, **record})

    # ---- Frame capture (omni.replicator.core rgb annotator; PIL PNG writes).
    class FrameCapturer:
        def __init__(self, frames_dir):
            self.dir = os.path.abspath(frames_dir)
            self.frames = []
            self.warnings = []
            self.enabled = True
            self._rep = None
            self._annot = None
            self._rp = None
            self._session = 0
            try:
                os.makedirs(self.dir, exist_ok=True)
                import omni.replicator.core as rep

                self._rep = rep
            except Exception as exc:
                self.enabled = False
                self.warnings.append(f"frame capture unavailable (omni.replicator.core): {exc}")

        def open_session(self, stage_, center_, diag):
            """One camera + render product at a 3/4 view of the bbox center."""
            if not self.enabled or len(self.frames) >= FRAME_BUDGET:
                return
            try:
                # Legible captures need a light; the exported asset has none.
                if not stage_.GetPrimAtPath("/World/proceduraDomeLight").IsValid():
                    dome = UsdLux.DomeLight.Define(stage_, "/World/proceduraDomeLight")
                    dome.CreateIntensityAttr(1000.0)
                direction = np.array(CAMERA_DIRECTION, dtype=float)
                direction /= np.linalg.norm(direction)
                eye = np.array(center_, dtype=float) + direction * diag * CAMERA_DISTANCE_DIAGONALS
                self._session += 1
                cam_prim = self._rep.functional.create.camera(
                    position=tuple(float(v) for v in eye),
                    look_at=tuple(float(v) for v in center_),
                    clipping_range=(max(0.1, diag * 0.005), max(1000.0, diag * 20.0)),
                    name=f"proceduraValidationCam{self._session}",
                    parent="/World",
                )
                self._rp = self._rep.create.render_product(
                    str(cam_prim.GetPath()), resolution=FRAME_RESOLUTION,
                )
                self._annot = self._rep.annotators.get("rgb")
                self._annot.attach(self._rp)
            except Exception as exc:
                self.warnings.append(f"camera session failed: {exc}")
                self.close_session()

        def capture(self, filename, label):
            if not self.enabled or self._annot is None or len(self.frames) >= FRAME_BUDGET:
                return
            try:
                data = None
                for attempt in range(24):
                    app.update()
                    data = self._annot.get_data()
                    if isinstance(data, dict):
                        data = data.get("data")
                    if data is not None and getattr(data, "size", 0) > 0:
                        if attempt >= 2 and (int(np.asarray(data).max()) > 0 or attempt >= 11):
                            break
                if data is None or getattr(data, "size", 0) == 0:
                    self.warnings.append(f"no rgb data for {filename}")
                    return
                arr = np.asarray(data)
                if arr.ndim == 3 and arr.shape[2] >= 3:
                    arr = arr[:, :, :3]
                from PIL import Image

                path = os.path.join(self.dir, filename)
                Image.fromarray(arr.astype(np.uint8)).save(path)
                self.frames.append({"path": path, "label": label})
            except Exception as exc:
                self.warnings.append(f"frame capture {filename} failed: {exc}")

        def close_session(self):
            try:
                if self._annot is not None:
                    self._annot.detach()
            except Exception:
                pass
            try:
                if self._rp is not None:
                    self._rp.destroy()
            except Exception:
                pass
            self._annot = None
            self._rp = None

    capturer = FrameCapturer(args.frames_dir) if args.frames_dir else None

    # ---- Video capture: PNG sequences grabbed from the FrameCapturer's live
    # annotator during sweep/mobility stepping, encoded to MP4 with ffmpeg.
    class VideoRecorder:
        def __init__(self, videos_dir, frame_capturer):
            self.dir = os.path.abspath(videos_dir)
            self.videos = []
            self.warnings = []
            self.capturer = frame_capturer
            self.ffmpeg = shutil.which("ffmpeg")
            self.enabled = frame_capturer is not None and frame_capturer.enabled
            if self.ffmpeg is None:
                self.enabled = False
                self.warnings.append("video capture unavailable: ffmpeg not found on PATH")
            self._seq_dir = None
            self._name = None
            self._label = None
            self._count = 0
            self._step = 0
            if self.enabled:
                os.makedirs(self.dir, exist_ok=True)

        def begin_clip(self, name, label):
            if not self.enabled or len(self.videos) >= VIDEO_BUDGET:
                return
            if self.capturer is None or self.capturer._annot is None:
                return
            self._seq_dir = os.path.join(self.dir, f"_seq_{name}")
            os.makedirs(self._seq_dir, exist_ok=True)
            self._name = name
            self._label = label
            self._count = 0
            self._step = 0

        def tick(self):
            """Grab one frame every VIDEO_FRAME_STRIDE sim steps while a clip is open."""
            if self._seq_dir is None or self._count >= VIDEO_MAX_FRAMES:
                return
            self._step += 1
            if self._step % VIDEO_FRAME_STRIDE != 0:
                return
            try:
                annot = self.capturer._annot if self.capturer is not None else None
                if annot is None:
                    return
                data = annot.get_data()
                if isinstance(data, dict):
                    data = data.get("data")
                if data is None or getattr(data, "size", 0) == 0:
                    return
                arr = np.asarray(data)
                if arr.ndim == 3 and arr.shape[2] >= 3:
                    arr = arr[:, :, :3]
                from PIL import Image

                Image.fromarray(arr.astype(np.uint8)).save(
                    os.path.join(self._seq_dir, f"{self._count:05d}.png"),
                )
                self._count += 1
            except Exception as exc:
                self.warnings.append(f"video frame grab failed ({self._name}): {exc}")
                self._seq_dir = None

        def end_clip(self):
            seq_dir, name, label, count = self._seq_dir, self._name, self._label, self._count
            self._seq_dir = None
            self._name = None
            self._label = None
            self._count = 0
            if seq_dir is None or name is None:
                return
            try:
                if count >= VIDEO_MIN_FRAMES:
                    out_path = os.path.join(self.dir, f"{name}.mp4")
                    proc = subprocess.run(
                        [
                            self.ffmpeg, "-y",
                            "-framerate", str(VIDEO_FPS),
                            "-i", os.path.join(seq_dir, "%05d.png"),
                            "-c:v", "libx264", "-pix_fmt", "yuv420p",
                            "-crf", "23", "-movflags", "+faststart",
                            out_path,
                        ],
                        capture_output=True,
                        timeout=180,
                    )
                    if proc.returncode == 0 and os.path.isfile(out_path):
                        self.videos.append({"path": out_path, "label": label})
                    else:
                        tail = (proc.stderr or b"").decode(errors="replace")[-300:]
                        self.warnings.append(f"ffmpeg failed for {name}: {tail}")
                elif count > 0:
                    self.warnings.append(f"clip {name} dropped: only {count} frames captured")
            except Exception as exc:
                self.warnings.append(f"video encode failed ({name}): {exc}")
            finally:
                shutil.rmtree(seq_dir, ignore_errors=True)

    recorder = (
        VideoRecorder(args.videos_dir, capturer)
        if args.videos_dir and capturer is not None
        else None
    )

    # ------------------------------------------------------------------
    # Phase 2: assetRules (best-effort).
    # ------------------------------------------------------------------
    t_phase = time.time()
    try:
        enable_extension("omni.asset_validator.core")
        try:
            enable_extension("isaacsim.asset.validation")
        except Exception as exc:  # extra physics/joint/robot rules are optional
            report["warnings"].append(f"assetRules: isaacsim.asset.validation not enabled: {exc}")
        app.update()

        from omni.asset_validator.core import IssueSeverity, ValidationEngine, ValidationRulesRegistry

        # Enable only the Isaac Sim physics/joint/robot rule categories: the full
        # default registry includes Omniverse publishing conventions (NoOverrides,
        # ThumbnailExists, CleanFolder, ...) that fail every self-contained asset.
        engine = ValidationEngine(init_rules=False)
        enabled_rules = 0
        skipped_rules = []
        for category in ValidationRulesRegistry.categories():
            if not str(category).startswith("IsaacSim."):
                continue
            for rule in ValidationRulesRegistry.rules(category):
                if getattr(rule, "__name__", "") in SKIPPED_RULE_NAMES:
                    skipped_rules.append(rule.__name__)
                    continue
                engine.enable_rule(rule)
                enabled_rules += 1
        if enabled_rules == 0:
            raise RuntimeError("no IsaacSim.* validation rule categories registered")

        try:
            issues = engine.validate(stage)
        except Exception:
            issues = engine.validate(usd_path)

        issue_records = []
        error_issue_count = 0
        for issue in issues:
            severity = getattr(issue.severity, "name", str(issue.severity)).lower()
            if issue.severity in (IssueSeverity.ERROR, IssueSeverity.FAILURE):
                error_issue_count += 1
            rule = issue.rule
            rule_name = getattr(rule, "__name__", str(rule)) if rule is not None else None
            issue_records.append({
                "severity": severity,
                "rule": rule_name,
                "message": issue.message,
                "prim": str(issue.at) if issue.at is not None else None,
            })
        report["phases"]["assetRules"] = {
            "ok": error_issue_count == 0,
            "rulesEnabled": enabled_rules,
            "rulesSkipped": skipped_rules,
            "issues": issue_records,
        }
    except Exception as exc:
        report["phases"]["assetRules"] = {
            "skipped": True,
            "reason": f"ValidationEngine unavailable: {exc}",
        }
    record_phase_seconds("assetRules", t_phase)

    # ------------------------------------------------------------------
    # Phase 3: simulation (required).
    # ------------------------------------------------------------------
    t_phase = time.time()
    sim_errors = []
    sim_warnings = []
    sim = {
        "ok": False,
        "framesRun": 0,
        "nanDetected": False,
        "maxLinearVelocity": 0.0,
        "maxAngularVelocity": 0.0,
        "rootDrift": 0.0,
        "dofCount": 0,
        "joints": [],
        "errors": sim_errors,
        "warnings": sim_warnings,
    }

    # Model diagonal from a stage-wide bbox (stage units == model units).
    diagonal = 0.0
    min_z = None
    bbox_center = None
    try:
        bbox_center, diagonal, min_z = compute_stage_bbox(stage)
    except Exception as exc:
        sim_warnings.append(f"could not compute model bbox diagonal: {exc}")
    sim["modelDiagonal"] = diagonal

    # Static ground plane just below the model: without one, floating-base
    # assets free-fall forever, which is indistinguishable from a blowup.
    # Edited in memory only; the source .usda is not modified.
    if diagonal > 0 and min_z is not None:
        try:
            sim["groundPlane"] = add_ground_plane(stage, diagonal, min_z)
        except Exception as exc:
            sim_warnings.append(f"could not add ground plane: {exc}")

    # Contact scan (advisory): report APIs must exist before the timeline plays.
    if hints is not None:
        try:
            apply_contact_report_apis(stage)
        except Exception as exc:
            sim_warnings.append(f"could not apply contact-report APIs: {exc}")

    if len(articulation_root_paths) == 0:
        sim_errors.append("no articulation root in the stage; nothing to simulate")
    else:
        root_path = articulation_root_paths[0]
        robot = None
        try:
            from isaacsim.core.experimental.prims import Articulation

            robot = Articulation(root_path)
        except Exception as exc:
            sim_errors.append(
                f"Isaac could not wrap {root_path} as an Articulation: {exc}"
            )

        timeline.play()

        if robot is not None:
            # Warm-up frames: wait for the physics tensor entity to become valid.
            tensor_ready = False
            for _ in range(30):
                app.update()
                try:
                    if robot.is_physics_tensor_entity_valid():
                        tensor_ready = True
                        break
                except Exception:
                    pass
            if not tensor_ready:
                sim_errors.append(
                    f"physics tensor entity for {root_path} never became valid; "
                    "Isaac cannot simulate the articulation"
                )
                robot = None

        if robot is not None:
            dof_names = list(robot.dof_names or [])
            dof_count = int(robot.num_dofs or 0)
            sim["dofCount"] = dof_count
            rot_mask = np.array(
                [getattr(t, "name", str(t)).endswith("Rotation") for t in (robot.dof_types or [])],
                dtype=bool,
            )
            if rot_mask.shape[0] != dof_count:
                rot_mask = np.zeros(dof_count, dtype=bool)

            lower_limits = upper_limits = None
            try:
                lower_wp, upper_wp = robot.get_dof_limits()
                lower_limits = lower_wp.numpy()[0].astype(float)
                upper_limits = upper_wp.numpy()[0].astype(float)
            except Exception as exc:
                sim_warnings.append(f"could not read DOF limits: {exc}")

            nan_found = False
            max_lin_vel = 0.0
            max_ang_vel_deg = 0.0
            max_drift = 0.0
            initial_positions = None
            final_positions = None
            initial_root = None
            prev_root = None
            frame_peak_vels = []
            frames_run = 0
            dt = 1.0 / 60.0

            for _frame in range(max(1, args.steps)):
                app.update()
                frames_run += 1
                if hints is not None and frames_run <= REST_CONTACT_FRAMES:
                    poll_contacts()

                positions = robot.get_dof_positions().numpy()[0].astype(float)
                velocities = robot.get_dof_velocities().numpy()[0].astype(float)
                root_pos_wp, root_quat_wp = robot.get_world_poses()
                root_pos = root_pos_wp.numpy()[0].astype(float)
                root_quat = root_quat_wp.numpy()[0].astype(float)

                if (
                    np.isnan(positions).any() or np.isnan(velocities).any()
                    or np.isnan(root_pos).any() or np.isnan(root_quat).any()
                ):
                    nan_found = True
                    sim_errors.append(f"NaN detected in articulation state at frame {frames_run}")
                    break

                if initial_positions is None:
                    initial_positions = positions.copy()
                    initial_root = root_pos.copy()
                final_positions = positions

                abs_vel = np.abs(velocities)
                frame_peak_vels.append(float(abs_vel.max()) if abs_vel.size else 0.0)
                if abs_vel.size:
                    if rot_mask.any():
                        max_ang_vel_deg = max(max_ang_vel_deg, float(np.degrees(abs_vel[rot_mask].max())))
                    if (~rot_mask).any():
                        max_lin_vel = max(max_lin_vel, float(abs_vel[~rot_mask].max()))
                if prev_root is not None:
                    root_speed = float(np.linalg.norm(root_pos - prev_root)) / dt
                    max_lin_vel = max(max_lin_vel, root_speed)
                prev_root = root_pos
                max_drift = max(max_drift, float(np.linalg.norm(root_pos - initial_root)))

            sim["framesRun"] = frames_run
            sim["nanDetected"] = nan_found
            sim["maxLinearVelocity"] = round(max_lin_vel, 6)
            sim["maxAngularVelocity"] = round(max_ang_vel_deg, 6)
            sim["rootDrift"] = round(max_drift, 6)

            if not nan_found:
                if max_ang_vel_deg > MAX_ANGULAR_VEL_DEG:
                    sim_errors.append(
                        f"unstable: max angular DOF velocity {max_ang_vel_deg:.1f} deg/s exceeds "
                        f"{MAX_ANGULAR_VEL_DEG:.0f} deg/s"
                    )
                quarter = max(1, len(frame_peak_vels) // 4)
                if len(frame_peak_vels) >= 4:
                    first_q = max(frame_peak_vels[:quarter])
                    last_q = max(frame_peak_vels[-quarter:])
                    if first_q > 1e-6 and last_q / first_q > GROWTH_RATIO:
                        sim_errors.append(
                            f"unstable: peak DOF velocity grew {last_q / first_q:.0f}x between the "
                            "first and last quarter of the run"
                        )
                if diagonal > 0.0:
                    if world_fixed_joint and max_drift > FIXED_DRIFT_FRAC * diagonal:
                        sim_errors.append(
                            f"fixed-base root drifted {max_drift:.3f} units "
                            f"(> {FIXED_DRIFT_FRAC * 100:.0f}% of model diagonal {diagonal:.3f})"
                        )
                    elif not world_fixed_joint and max_drift > FREE_DRIFT_DIAGONALS * diagonal:
                        sim_errors.append(
                            f"fell/blew up: free-base root drifted {max_drift:.3f} units "
                            f"(> {FREE_DRIFT_DIAGONALS:.0f}x model diagonal {diagonal:.3f})"
                        )

                for i in range(dof_count):
                    name = dof_names[i] if i < len(dof_names) else f"dof_{i}"
                    is_rot = bool(rot_mask[i]) if i < rot_mask.shape[0] else False
                    init_val = float(initial_positions[i]) if initial_positions is not None else 0.0
                    final_val = float(final_positions[i]) if final_positions is not None else 0.0
                    if is_rot:
                        init_val = math.degrees(init_val)
                        final_val = math.degrees(final_val)
                    within = True
                    if lower_limits is not None and i < lower_limits.shape[0]:
                        lo = float(lower_limits[i])
                        hi = float(upper_limits[i])
                        if is_rot:
                            lo = math.degrees(lo)
                            hi = math.degrees(hi)
                        if math.isfinite(lo) and math.isfinite(hi) and abs(lo) < 1e6 and abs(hi) < 1e6:
                            tol = LIMIT_TOLERANCE_FRAC * max(abs(hi - lo), 1e-9)
                            if final_val < lo - tol or final_val > hi + tol:
                                within = False
                                sim_warnings.append(
                                    f"DOF {name} final position {final_val:.3f} escaped limits "
                                    f"[{lo:.3f}, {hi:.3f}] (5% tolerance)"
                                )
                    sim["joints"].append({
                        "name": name,
                        "initialPosition": round(init_val, 4),
                        "finalPosition": round(final_val, 4),
                        "withinLimits": within,
                    })

        # Frame capture: settled rest pose (still playing so RTX renders).
        if capturer is not None and bbox_center is not None and diagonal > 0:
            capturer.open_session(stage, bbox_center, diagonal)
            capturer.capture("rest.png", "passive rest pose (settled)")
            capturer.close_session()

        timeline.stop()
        app.update()

    sim["ok"] = len(sim_errors) == 0 and sim["framesRun"] > 0 and not sim["nanDetected"]
    report["phases"]["simulation"] = sim
    record_phase_seconds("simulation", t_phase)

    # ------------------------------------------------------------------
    # Phase 4: actuation (required when --hints is given).
    # Isolated regime: fresh stage, zero gravity, no ground plane, root pinned.
    # ------------------------------------------------------------------
    t_phase = time.time()
    if hints is None:
        report["phases"]["actuation"] = {"skipped": True, "reason": "no hints"}
    elif len(articulation_root_paths) == 0:
        report["phases"]["actuation"] = {
            "skipped": True, "reason": "no articulation root in the stage",
        }
    else:
        act_errors = []
        act_warnings = []
        actuation = {
            "ok": False,
            "joints": [],
            "mimics": [],
            "errors": act_errors,
            "warnings": act_warnings,
        }
        try:
            art_root = articulation_root_paths[0]
            stage = open_stage_fresh()

            # Zero gravity so drives fight nothing but inertia.
            gravity_zeroed = False
            for prim in stage.Traverse():
                if prim.IsA(UsdPhysics.Scene):
                    UsdPhysics.Scene(prim).GetGravityMagnitudeAttr().Set(0.0)
                    gravity_zeroed = True
            if not gravity_zeroed:
                act_warnings.append("no UsdPhysics.Scene prim; gravity could not be zeroed")

            # Pin a floating base with an in-memory world fixed joint. Links
            # carry identity Xforms (meshes world-baked), so identity joint
            # frames hold the root exactly at its authored pose.
            root_link_name = hints.get("rootLink")
            if not hints.get("fixedBase"):
                pin_target = None
                if root_link_name:
                    candidate = f"{art_root}/Links/{root_link_name}"
                    if stage.GetPrimAtPath(candidate).IsValid():
                        pin_target = candidate
                if pin_target is None and rigid_body_paths:
                    pin_target = rigid_body_paths[0]
                    act_warnings.append(
                        f"root link {root_link_name!r} not found; pinned {pin_target} instead"
                    )
                if pin_target is not None:
                    pin = UsdPhysics.FixedJoint.Define(stage, "/World/proceduraRootPin")
                    pin.CreateBody1Rel().SetTargets([Sdf.Path(pin_target)])

            apply_contact_report_apis(stage)

            robot = warm_up_articulation(art_root)
            if robot is None:
                act_errors.append(
                    "physics tensor entity never became valid in the actuation regime"
                )
            else:
                if capturer is not None and bbox_center is not None and diagonal > 0:
                    capturer.open_session(stage, bbox_center, diagonal)
                dof_names = list(robot.dof_names or [])
                name_to_index = {n: i for i, n in enumerate(dof_names)}
                rot_flags = [
                    getattr(t, "name", str(t)).endswith("Rotation")
                    for t in (robot.dof_types or [])
                ]
                initial_dof_positions = robot.get_dof_positions().numpy()[0].astype(float)

                def is_rotational(idx):
                    return rot_flags[idx] if idx < len(rot_flags) else True

                def to_internal(value, idx):
                    return math.radians(value) if is_rotational(idx) else value

                def from_internal(value, idx):
                    return math.degrees(value) if is_rotational(idx) else value

                def dof_position(idx):
                    return float(robot.get_dof_positions().numpy()[0][idx])

                def dof_velocity(idx):
                    return float(robot.get_dof_velocities().numpy()[0][idx])

                def hold_target(idx, target_internal, range_internal, joint_name):
                    """Command a position target and step until reached/stalled."""
                    robot.set_dof_position_targets(
                        np.array([[target_internal]], dtype=np.float32), dof_indices=[idx],
                    )
                    tolerance = max(
                        math.radians(0.5) if is_rotational(idx) else 1e-4,
                        0.01 * abs(range_internal),
                    )
                    history = []
                    pos = dof_position(idx)
                    for step in range(SWEEP_MAX_FRAMES):
                        app.update()
                        if recorder is not None:
                            recorder.tick()
                        poll_contacts(sweep_joint=joint_name)
                        pos = dof_position(idx)
                        history.append(pos)
                        if abs(pos - target_internal) <= tolerance:
                            break
                        if (
                            step >= SWEEP_NOMINAL_FRAMES
                            and len(history) > 30
                            and abs(history[-1] - history[-31])
                            < 0.005 * max(abs(range_internal), 1e-9)
                        ):
                            break  # stalled: drive cannot make further progress
                        if math.isnan(pos):
                            break
                    return pos

                position_sweep_results = {}  # joint name -> reached upper (deg/units)

                for driven in hints.get("drivenJoints", []):
                    name = driven.get("name")
                    mode = driven.get("mode")
                    idx = name_to_index.get(name)
                    if idx is None:
                        actuation["joints"].append({
                            "name": name,
                            "mode": mode,
                            "ok": False,
                            "note": "joint has no DOF in the simulated articulation",
                        })
                        continue

                    if mode == "position":
                        lower = driven.get("lower")
                        upper = driven.get("upper")
                        if lower is None or upper is None:
                            actuation["joints"].append({
                                "name": name,
                                "mode": "position",
                                "skipped": True,
                                "note": "no limits (continuous joint); position sweep skipped",
                            })
                            continue
                        range_internal = to_internal(upper, idx) - to_internal(lower, idx)
                        if recorder is not None:
                            recorder.begin_clip(
                                f"sweep_{name}",
                                f"{name} swept {lower} -> {upper}",
                            )
                        reached_low_internal = hold_target(
                            idx, to_internal(lower, idx), range_internal, name,
                        )
                        reached_low = from_internal(reached_low_internal, idx)
                        if capturer is not None:
                            capturer.capture(
                                f"sweep_{name}_low.png", f"{name} held at lower limit ({lower})",
                            )
                        reached_high_internal = hold_target(
                            idx, to_internal(upper, idx), range_internal, name,
                        )
                        reached_high = from_internal(reached_high_internal, idx)
                        if recorder is not None:
                            recorder.end_clip()
                        if capturer is not None:
                            capturer.capture(
                                f"sweep_{name}_high.png", f"{name} held at upper limit ({upper})",
                            )
                        commanded_range = upper - lower
                        range_fraction = 0.0
                        if abs(commanded_range) > 1e-9:
                            range_fraction = (reached_high - reached_low) / commanded_range
                        position_sweep_results[name] = reached_high
                        actuation["joints"].append({
                            "name": name,
                            "mode": "position",
                            "lower": lower,
                            "upper": upper,
                            "reachedLow": round(reached_low, 3),
                            "reachedHigh": round(reached_high, 3),
                            "rangeFraction": round(range_fraction, 4),
                            "ok": range_fraction >= SWEEP_MIN_RANGE_FRACTION,
                        })

                        # Mimic tracking: followers of this joint, read while the
                        # reference is held at its upper limit.
                        for mimic in hints.get("mimicJoints", []):
                            if mimic.get("reference") != name:
                                continue
                            follower_idx = name_to_index.get(mimic.get("follower"))
                            if follower_idx is None:
                                actuation["mimics"].append({
                                    "follower": mimic.get("follower"),
                                    "reference": name,
                                    "skipped": True,
                                    "reason": "follower has no DOF in the articulation",
                                })
                                continue
                            gearing = mimic.get("gearing", 1.0)
                            offset = mimic.get("offset", 0.0)
                            expected = gearing * reached_high + offset
                            actual = from_internal(dof_position(follower_idx), follower_idx)
                            actuation["mimics"].append({
                                "follower": mimic.get("follower"),
                                "reference": name,
                                "expected": round(expected, 3),
                                "actual": round(actual, 3),
                                "trackingOk": abs(actual - expected) <= MIMIC_TRACKING_TOLERANCE_DEG,
                            })

                        # Return to the initial pose so later sweeps start clean.
                        robot.set_dof_position_targets(
                            np.array([[initial_dof_positions[idx]]], dtype=np.float32),
                            dof_indices=[idx],
                        )
                        for _ in range(30):
                            app.update()
                            poll_contacts(sweep_joint=name)

                    elif mode == "velocity":
                        commanded = driven.get("targetVelocity")
                        if commanded is None:
                            commanded = DEFAULT_SWEEP_VELOCITY
                        robot.set_dof_velocity_targets(
                            np.array([[to_internal(commanded, idx)]], dtype=np.float32),
                            dof_indices=[idx],
                        )
                        for _ in range(VELOCITY_SWEEP_FRAMES):
                            app.update()
                            poll_contacts(sweep_joint=name)
                        final_velocity = from_internal(dof_velocity(idx), idx)
                        final_position = from_internal(dof_position(idx), idx)
                        entry = {
                            "name": name,
                            "mode": "velocity",
                            "commandedVelocity": commanded,
                            "finalVelocity": round(final_velocity, 3),
                            "ok": abs(final_velocity) >= VELOCITY_MIN_FRACTION * abs(commanded),
                        }
                        # A limited joint driven at constant velocity saturates at
                        # its limit and reads ~0 velocity; that is a responsive
                        # joint, not a dead drive.
                        lower = driven.get("lower")
                        upper = driven.get("upper")
                        if not entry["ok"] and lower is not None and upper is not None:
                            boundary = upper if commanded > 0 else lower
                            limit_range = abs(upper - lower)
                            if abs(final_position - boundary) <= 0.1 * max(limit_range, 1e-9):
                                entry["ok"] = True
                                entry["note"] = "saturated at its limit while velocity-driven"
                        actuation["joints"].append(entry)
                        robot.set_dof_velocity_targets(
                            np.array([[0.0]], dtype=np.float32), dof_indices=[idx],
                        )
                        for _ in range(10):
                            app.update()
                            poll_contacts(sweep_joint=name)

                    else:
                        actuation["joints"].append({
                            "name": name,
                            "mode": mode,
                            "skipped": True,
                            "note": f"unknown drive mode {mode!r}",
                        })

                # Mimic pairs whose reference was never position-swept.
                checked_refs = set(position_sweep_results.keys())
                recorded_followers = {m.get("follower") for m in actuation["mimics"]}
                for mimic in hints.get("mimicJoints", []):
                    if mimic.get("follower") in recorded_followers:
                        continue
                    if mimic.get("reference") not in checked_refs:
                        actuation["mimics"].append({
                            "follower": mimic.get("follower"),
                            "reference": mimic.get("reference"),
                            "skipped": True,
                            "reason": "reference joint is not position-driven; tracking not swept",
                        })

                if capturer is not None:
                    capturer.close_session()

            timeline.stop()
            app.update()
        except Exception:
            tb_act = traceback.format_exc()
            print(tb_act, file=sys.stderr)
            act_errors.append(f"actuation phase exception: {tb_act.splitlines()[-1]}")
            if capturer is not None:
                capturer.close_session()
            try:
                timeline.stop()
            except Exception:
                pass

        swept = [e for e in actuation["joints"] if not e.get("skipped")]
        mimics_checked = [m for m in actuation["mimics"] if not m.get("skipped")]
        actuation["ok"] = (
            len(act_errors) == 0
            and all(e.get("ok") for e in swept)
            and all(m.get("trackingOk") for m in mimics_checked)
        )
        report["phases"]["actuation"] = actuation
    record_phase_seconds("actuation", t_phase)

    # ------------------------------------------------------------------
    # Phase 5: contacts (advisory; never gates top-level ok).
    # Assembled from the passive-phase rest scan + actuation sweep scans.
    # ------------------------------------------------------------------
    if hints is None:
        report["phases"]["contacts"] = {"skipped": True, "reason": "no hints"}
    else:
        rest_records = list(rest_contact_pairs.values())
        sweep_records = list(sweep_contact_pairs.values())
        non_adjacent_rest = sum(1 for r in rest_records if not r["adjacent"])
        non_adjacent_sweep = sum(1 for r in sweep_records if not r["adjacent"])
        contacts_phase = {
            "ok": non_adjacent_rest == 0,
            "restContacts": rest_records[:CONTACT_LIST_CAP],
            "sweepContacts": sweep_records[:CONTACT_LIST_CAP],
            "nonAdjacentRestCount": non_adjacent_rest,
            "nonAdjacentSweepCount": non_adjacent_sweep,
            "totalContactEvents": contact_stats["events"],
            "warnings": [],
        }
        if contact_stats["pollErrors"] > 0:
            contacts_phase["warnings"].append(
                f"contact-report polling failed {contact_stats['pollErrors']} times"
            )
        if non_adjacent_rest > 0:
            contacts_phase["warnings"].append(
                f"{non_adjacent_rest} non-adjacent link pair(s) in contact at rest"
            )
        report["phases"]["contacts"] = contacts_phase

    # ------------------------------------------------------------------
    # Phase 6: mobility (advisory; wheeled floating-base drive test).
    # ------------------------------------------------------------------
    t_phase = time.time()
    if hints is None:
        report["phases"]["mobility"] = {"skipped": True, "reason": "no hints"}
    elif hints.get("fixedBase"):
        report["phases"]["mobility"] = {"skipped": True, "reason": "fixed-base asset"}
    elif not hints.get("wheelJoints"):
        report["phases"]["mobility"] = {"skipped": True, "reason": "no wheel joints"}
    elif len(articulation_root_paths) == 0:
        report["phases"]["mobility"] = {
            "skipped": True, "reason": "no articulation root in the stage",
        }
    else:
        mob_warnings = []
        mobility = {
            "ok": False,
            "baseDisplacement": 0.0,
            "diagonalFraction": 0.0,
            "commandedWheels": [],
            "warnings": mob_warnings,
        }
        try:
            art_root = articulation_root_paths[0]
            stage = open_stage_fresh()
            if diagonal > 0 and min_z is not None:
                add_ground_plane(stage, diagonal, min_z)
            else:
                mob_warnings.append("no bbox; mobility test ran without a ground plane")

            robot = warm_up_articulation(art_root)
            if robot is None:
                mob_warnings.append(
                    "physics tensor entity never became valid in the mobility regime"
                )
            else:
                dof_names = list(robot.dof_names or [])
                name_to_index = {n: i for i, n in enumerate(dof_names)}
                rot_flags = [
                    getattr(t, "name", str(t)).endswith("Rotation")
                    for t in (robot.dof_types or [])
                ]
                wheel_indices = []
                for wheel in hints.get("wheelJoints", []):
                    idx = name_to_index.get(wheel)
                    if idx is None:
                        mob_warnings.append(f"wheel joint {wheel} has no DOF; not commanded")
                        continue
                    wheel_indices.append(idx)
                    mobility["commandedWheels"].append(wheel)

                if len(wheel_indices) == 0:
                    mob_warnings.append("no wheel joint resolved to a DOF; nothing commanded")
                else:
                    # A wider-framed session covers the whole drive for video.
                    if capturer is not None and bbox_center is not None and diagonal > 0:
                        capturer.open_session(
                            stage, bbox_center,
                            diagonal * (MOBILITY_CAMERA_DISTANCE_DIAGONALS / CAMERA_DISTANCE_DIAGONALS),
                        )
                        if recorder is not None:
                            recorder.begin_clip(
                                "mobility",
                                f"mobility: {len(wheel_indices)} wheels driven at "
                                f"{DEFAULT_SWEEP_VELOCITY:.0f} deg/s",
                            )
                    for _ in range(MOBILITY_SETTLE_FRAMES):
                        app.update()
                        if recorder is not None:
                            recorder.tick()
                    start_pos = robot.get_world_poses()[0].numpy()[0].astype(float)

                    targets = np.array(
                        [[
                            math.radians(DEFAULT_SWEEP_VELOCITY)
                            if (i < len(rot_flags) and rot_flags[i]) else DEFAULT_SWEEP_VELOCITY
                            for i in wheel_indices
                        ]],
                        dtype=np.float32,
                    )
                    robot.set_dof_velocity_targets(targets, dof_indices=wheel_indices)
                    for _ in range(MOBILITY_DRIVE_FRAMES):
                        app.update()
                        if recorder is not None:
                            recorder.tick()
                    end_pos = robot.get_world_poses()[0].numpy()[0].astype(float)
                    if recorder is not None:
                        recorder.end_clip()

                    displacement = float(np.linalg.norm((end_pos - start_pos)[:2]))
                    mobility["baseDisplacement"] = round(displacement, 4)
                    if diagonal > 0:
                        fraction = displacement / diagonal
                        mobility["diagonalFraction"] = round(fraction, 5)
                        mobility["ok"] = fraction >= MOBILITY_MIN_DIAGONAL_FRACTION
                    else:
                        mobility["ok"] = displacement > 0

                    if capturer is not None and bbox_center is not None and diagonal > 0:
                        # Re-aim at where the base actually ended up for the still.
                        capturer.close_session()
                        delta = (end_pos - start_pos).tolist()
                        moved_center = [bbox_center[k] + delta[k] for k in range(3)]
                        capturer.open_session(stage, moved_center, diagonal)
                        capturer.capture("mobility_end.png", "mobility test end pose")
                        capturer.close_session()

            timeline.stop()
            app.update()
        except Exception:
            tb_mob = traceback.format_exc()
            print(tb_mob, file=sys.stderr)
            mob_warnings.append(f"mobility phase exception: {tb_mob.splitlines()[-1]}")
            if recorder is not None:
                recorder.end_clip()
            if capturer is not None:
                capturer.close_session()
            try:
                timeline.stop()
            except Exception:
                pass
        report["phases"]["mobility"] = mobility
    record_phase_seconds("mobility", t_phase)

    # Frame capture results (advisory; failures were downgraded to warnings).
    if capturer is not None:
        report["frames"] = capturer.frames
        for warning in capturer.warnings:
            report["warnings"].append(f"frames: {warning}")
    if recorder is not None:
        report["videos"] = recorder.videos
        for warning in recorder.warnings:
            report["warnings"].append(f"videos: {warning}")

    # ------------------------------------------------------------------
    # Phase 7: urdfRoundTrip (best-effort, only with --urdf).
    # ------------------------------------------------------------------
    t_phase = time.time()
    if args.urdf:
        urdf_errors = []
        urdf_warnings = []
        try:
            urdf_path = os.path.abspath(args.urdf)
            if not os.path.isfile(urdf_path):
                raise FileNotFoundError(f"URDF not found: {urdf_path}")

            import omni.kit.app

            enable_extension("isaacsim.asset.importer.urdf")
            ext_manager = omni.kit.app.get_app().get_extension_manager()
            for ext in ("omni.scene.optimizer.core", "isaacsim.robot.schema"):
                try:
                    ext_manager.set_extension_enabled_immediate(ext, True)
                except Exception as exc:
                    urdf_warnings.append(f"could not enable {ext}: {exc}")
            app.update()

            from isaacsim.asset.importer.urdf.impl import URDFImporter, URDFImporterConfig

            out_dir = os.path.join(os.path.dirname(os.path.abspath(args.report)), "urdf_roundtrip")
            os.makedirs(out_dir, exist_ok=True)
            config = URDFImporterConfig(urdf_path=urdf_path, usd_path=out_dir)
            importer = URDFImporter(config)
            imported_usd = importer.import_urdf()
            if not imported_usd or not os.path.isfile(imported_usd):
                raise RuntimeError(f"URDF import produced no USD file (got: {imported_usd})")

            imported_stage = Usd.Stage.Open(imported_usd)
            if imported_stage is None:
                raise RuntimeError(f"could not open imported USD: {imported_usd}")
            has_articulation = any(
                p.HasAPI(UsdPhysics.ArticulationRootAPI) for p in imported_stage.Traverse()
            )
            if not has_articulation:
                urdf_errors.append(
                    f"imported USD {imported_usd} contains no ArticulationRootAPI prim"
                )
            report["phases"]["urdfRoundTrip"] = {
                "ok": len(urdf_errors) == 0,
                "importedUsd": imported_usd,
                "errors": urdf_errors,
                "warnings": urdf_warnings,
            }
        except Exception as exc:
            urdf_errors.append(f"URDF round-trip failed: {exc}")
            report["phases"]["urdfRoundTrip"] = {
                "ok": False,
                "errors": urdf_errors,
                "warnings": urdf_warnings,
            }
        record_phase_seconds("urdfRoundTrip", t_phase)

    # ------------------------------------------------------------------
    # Aggregate.
    # ------------------------------------------------------------------
    phases = report["phases"]
    ok = True
    for name in ("schemaAudit", "simulation"):
        phase = phases.get(name)
        if phase is None or phase.get("skipped") or not phase.get("ok"):
            ok = False
    asset_rules = phases.get("assetRules")
    if asset_rules is not None and not asset_rules.get("skipped") and not asset_rules.get("ok"):
        ok = False
    urdf_phase = phases.get("urdfRoundTrip")
    if urdf_phase is not None and not urdf_phase.get("skipped") and not urdf_phase.get("ok"):
        ok = False
    # Actuation is required whenever hints were given (i.e. it was not skipped).
    actuation_phase = phases.get("actuation")
    if actuation_phase is not None and not actuation_phase.get("skipped") and not actuation_phase.get("ok"):
        ok = False
    # contacts and mobility are advisory: they never gate ok.
    for advisory_name in ("contacts", "mobility"):
        advisory = phases.get(advisory_name)
        if advisory is not None and not advisory.get("skipped") and not advisory.get("ok"):
            report["warnings"].append(
                f"{advisory_name}: advisory check failed (does not gate ok)"
            )
    report["ok"] = ok

    for name, phase in phases.items():
        if phase.get("skipped"):
            report["warnings"].append(f"{name}: skipped — {phase.get('reason', 'unknown')}")
            continue
        for err in phase.get("errors", []):
            report["errors"].append(f"{name}: {err}")
        for warn in phase.get("warnings", []):
            report["warnings"].append(f"{name}: {warn}")
        if name == "assetRules":
            for issue in phase.get("issues", []):
                line = f"assetRules: [{issue['severity']}] {issue['rule']}: {issue['message']}"
                if issue["severity"] in ("error", "failure"):
                    report["errors"].append(line)
                else:
                    report["warnings"].append(line)

    write_report_and_exit(0)

except SystemExit:
    raise
except Exception:
    tb = traceback.format_exc()
    print(tb, file=sys.stderr)
    report["ok"] = False
    report["errors"].append(f"harness exception: {tb}")
    write_report_and_exit(0)
