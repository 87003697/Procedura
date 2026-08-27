"""Render ONE clip per asset in which every joint moves at once.

`isaac_validate.py` sweeps one joint at a time, because that is what a verdict
needs: a joint that fails is named. A reader wants the opposite — a single clip
where the whole mechanism is alive — so this script drives every position DOF
along a phase-offset sinusoid and spins every velocity DOF, recording one MP4.

It runs the same isolated regime the actuation phase uses (fresh stage, zero
gravity, root pinned), so joints fight nothing but inertia and nothing falls
over while all of it moves. Frames come from the same omni.replicator.core rgb
annotator, encoded with the system ffmpeg.

Run it under $PROCEDURA_ISAACSIM_PATH/python.sh, with LD_LIBRARY_PATH pointed at
the bundled nvjitlink dir — see src/motion/isaac.ts for why.

    python.sh src/motion/isaac_demo.py --usd final_motion.usda \
        --hints isaac_hints.json --out motion/isaac_videos/all_joints.mp4
"""

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
import traceback

parser = argparse.ArgumentParser(description="Procedura all-joints motion clip in headless Isaac Sim")
parser.add_argument("--usd", required=True, help="Path to the USD(A) asset to drive")
parser.add_argument("--hints", required=True, help="isaac_hints.json from the MotionPlan")
parser.add_argument("--out", required=True, help="Path of the MP4 to write")
parser.add_argument("--seconds", type=float, default=8.0, help="Clip length (default 8)")
parser.add_argument("--fps", type=int, default=30, help="Playback frame rate (default 30)")
parser.add_argument("--stride", type=int, default=2, help="Sim steps per captured frame (default 2)")
parser.add_argument("--period", type=float, default=4.0, help="Seconds per joint cycle (default 4)")
parser.add_argument("--amplitude", type=float, default=0.45,
                    help="Fraction of each joint's range to sweep, per side (default 0.45)")
parser.add_argument("--wheel-speed", type=float, default=180.0, help="deg/s for velocity DOFs")
parser.add_argument("--poster", default=None, help="Optional PNG path for the last frame")
parser.add_argument("--kinematic", action="store_true",
                    help="Set joint STATE each frame instead of drive targets: shows the planned "
                         "kinematics with no reaction torques, so nothing drifts")
args, _unknown = parser.parse_known_args()

T_START = time.time()

# SimulationApp must be created before any omni.* / kit-pxr import.
from isaacsim import SimulationApp  # noqa: E402

app = SimulationApp({"headless": True})

RESOLUTION = (768, 576)
CAMERA_DIRECTION = (1.0, -1.0, 0.6)   # 3/4 view, matching the validator's framing
CAMERA_DISTANCE_DIAGONALS = 1.7
WARMUP_FRAMES = 60
# Ease the sinusoid in from the rest pose so the first frame is not a jolt.
EASE_SECONDS = 0.6

result = {"ok": False, "out": os.path.abspath(args.out), "frames": 0, "drivenDofs": 0,
          "warnings": [], "errors": []}


def finish(code):
    print(json.dumps(result, indent=1), flush=True)
    sys.stdout.flush()
    try:
        app.close()
    except Exception:
        pass
    # Isaac exits via os._exit; anything after app.close() may never run.
    os._exit(code)


try:
    import numpy as np
    import omni.timeline
    import omni.usd
    from isaacsim.core.utils.stage import is_stage_loading
    from pxr import Sdf, Usd, UsdGeom, UsdLux, UsdPhysics

    usd_path = os.path.abspath(args.usd)
    if not os.path.isfile(usd_path):
        raise FileNotFoundError(f"USD asset not found: {usd_path}")
    hints = json.load(open(args.hints))

    ctx = omni.usd.get_context()
    if not ctx.open_stage(usd_path):
        raise RuntimeError(f"Failed to open stage: {usd_path}")
    for _ in range(10):
        app.update()
    while is_stage_loading():
        app.update()
    stage = ctx.get_stage()

    # ---- bbox for camera framing -------------------------------------
    cache = UsdGeom.BBoxCache(Usd.TimeCode.Default(), [UsdGeom.Tokens.default_])
    rng = cache.ComputeWorldBound(stage.GetPseudoRoot()).ComputeAlignedRange()
    size = rng.GetSize()
    diagonal = float(math.sqrt(size[0] ** 2 + size[1] ** 2 + size[2] ** 2))
    mid = rng.GetMidpoint()
    center = (float(mid[0]), float(mid[1]), float(mid[2]))

    # ---- isolated regime: zero gravity, root pinned -------------------
    for prim in stage.Traverse():
        if prim.IsA(UsdPhysics.Scene):
            UsdPhysics.Scene(prim).GetGravityMagnitudeAttr().Set(0.0)

    art_root = None
    for prim in stage.Traverse():
        if prim.HasAPI(UsdPhysics.ArticulationRootAPI):
            art_root = str(prim.GetPath())
            break
    if art_root is None:
        raise RuntimeError("no articulation root in the stage")

    if not hints.get("fixedBase"):
        root_link = hints.get("rootLink")
        pin_target = f"{art_root}/Links/{root_link}" if root_link else None
        if pin_target and stage.GetPrimAtPath(pin_target).IsValid():
            # The joint must live INSIDE the articulation. Authored under
            # /World it is a loop closure solved with finite stiffness, and with
            # twenty joints swinging at once the reaction torques visibly walk
            # the base around; authored under the articulation it is what PhysX
            # calls a fixed base, and the root does not move at all.
            pin = UsdPhysics.FixedJoint.Define(stage, f"{art_root}/Joints/proceduraRootPin")
            pin.CreateBody1Rel().SetTargets([Sdf.Path(pin_target)])
            result["rootPin"] = pin_target
        else:
            result["warnings"].append(f"root link {root_link!r} not found; base left free")

    if not stage.GetPrimAtPath("/World/proceduraDemoLight").IsValid():
        UsdLux.DomeLight.Define(stage, "/World/proceduraDemoLight").CreateIntensityAttr(1000.0)

    # ---- articulation -------------------------------------------------
    from isaacsim.core.experimental.prims import Articulation

    timeline = omni.timeline.get_timeline_interface()
    robot = Articulation(art_root)
    timeline.play()
    for _ in range(WARMUP_FRAMES):
        app.update()
        try:
            if robot.is_physics_tensor_entity_valid():
                break
        except Exception:
            pass
    if not robot.is_physics_tensor_entity_valid():
        raise RuntimeError("physics tensor entity never became valid")

    dof_names = list(robot.dof_names or [])
    name_to_index = {n: i for i, n in enumerate(dof_names)}
    rot_flags = [getattr(t, "name", str(t)).endswith("Rotation") for t in (robot.dof_types or [])]
    start = robot.get_dof_positions().numpy()[0].astype(float)

    # The world fixed joint alone does not hold every asset still: with twenty
    # joints swinging at once the reaction torques walk the base around, and the
    # clip reads as tumbling rather than articulating. Re-assert the root pose
    # each step so the camera sees only the mechanism.
    root_pos, root_quat = (t.numpy().copy() for t in robot.get_world_poses())
    zero3 = np.zeros((1, 3), dtype=np.float32)
    hold_enabled = [True]

    def hold_root():
        """Re-pin the root. set_velocities wants linear and angular separately
        in this API version; older ones take one (N,6) array."""
        if not hold_enabled[0]:
            return
        try:
            robot.set_world_poses(root_pos, root_quat)
            try:
                robot.set_velocities(zero3, zero3)
            except TypeError:
                robot.set_velocities(np.zeros((1, 6), dtype=np.float32))
        except Exception as exc:
            result["warnings"].append(f"root hold failed, base left free: {exc}")
            hold_enabled[0] = False

    def to_internal(value, idx):
        """Plan units (deg / model units) -> PhysX units (rad / model units)."""
        return math.radians(value) if (rot_flags[idx] if idx < len(rot_flags) else True) else value

    # A mimic follower is driven by PhysX off its reference; commanding it too
    # fights the coupling, so it is left out of the driven set.
    followers = {m.get("follower") for m in (hints.get("mimicJoints") or [])}

    swing, spin = [], []
    for j in hints.get("drivenJoints") or []:
        idx = name_to_index.get(j.get("name"))
        if idx is None or j.get("name") in followers:
            continue
        if j.get("mode") == "position" and j.get("lower") is not None and j.get("upper") is not None:
            lo, hi = to_internal(float(j["lower"]), idx), to_internal(float(j["upper"]), idx)
            if hi <= lo:
                continue
            # Oscillate about the pose the asset was AUTHORED in, not about the
            # centre of each joint's range: a rest pose is rarely mid-range, so
            # centring on the range throws every part somewhere else on frame one
            # and the object stops looking like itself. The centre is nudged only
            # as far as the limits demand to fit the swing.
            amp = (hi - lo) * args.amplitude
            centre = min(max(float(start[idx]), lo + amp), hi - amp)
            swing.append((idx, centre, amp))
        elif j.get("mode") == "velocity":
            speed = j.get("targetVelocity") or args.wheel_speed
            spin.append((idx, to_internal(float(speed), idx)))
    result["drivenDofs"] = len(swing) + len(spin)
    if not swing and not spin:
        raise RuntimeError("no drivable DOFs in the hints")

    # Phase-offset each joint so the mechanism reads as alive rather than as one
    # rigid pump; the golden angle spreads N phases evenly for any N.
    phases = [2.0 * math.pi * ((i * 0.6180339887) % 1.0) for i in range(len(swing))]

    if spin:
        idxs = [i for i, _ in spin]
        robot.set_dof_velocity_targets(
            np.array([[v for _, v in spin]], dtype=np.float32), dof_indices=idxs)

    # ---- camera + capture ---------------------------------------------
    import omni.replicator.core as rep

    direction = np.array(CAMERA_DIRECTION, dtype=float)
    direction /= np.linalg.norm(direction)
    eye = np.array(center, dtype=float) + direction * diagonal * CAMERA_DISTANCE_DIAGONALS
    cam = rep.functional.create.camera(
        position=tuple(float(v) for v in eye), look_at=center,
        clipping_range=(max(0.1, diagonal * 0.005), max(1000.0, diagonal * 20.0)),
        name="proceduraDemoCam", parent="/World")
    render_product = rep.create.render_product(str(cam.GetPath()), resolution=RESOLUTION)
    annot = rep.annotators.get("rgb")
    annot.attach(render_product)

    from PIL import Image

    tmp = tempfile.mkdtemp(prefix="procedura_demo_")
    total_frames = int(args.seconds * args.fps)
    dt = 1.0 / (args.fps * args.stride)
    written = 0
    for frame in range(total_frames):
        t = frame / float(args.fps)
        ease = min(1.0, t / EASE_SECONDS) if EASE_SECONDS > 0 else 1.0
        if swing:
            targets, idxs = [], []
            for (idx, mid_v, amp), phase in zip(swing, phases):
                target = mid_v + ease * amp * math.sin(2.0 * math.pi * t / args.period + phase)
                # Ease from wherever the joint actually rests toward the orbit.
                targets.append(start[idx] * (1.0 - ease) + target * ease)
                idxs.append(idx)
            arr = np.array([targets], dtype=np.float32)
            if args.kinematic:
                # Drive targets make the links accelerate, and the reaction
                # torques of twenty joints swinging together overwhelm the base
                # constraint. Writing the joint STATE instead poses the asset
                # exactly as planned, which is what a viewer is being shown.
                robot.set_dof_positions(arr, dof_indices=idxs)
                robot.set_dof_velocities(np.zeros_like(arr), dof_indices=idxs)
            else:
                robot.set_dof_position_targets(arr, dof_indices=idxs)
        for _ in range(args.stride):
            hold_root()
            app.update()
        data = annot.get_data()
        if isinstance(data, dict):
            data = data.get("data")
        if data is None or getattr(data, "size", 0) == 0:
            continue
        arr = np.asarray(data)
        if arr.ndim == 3 and arr.shape[2] >= 3:
            arr = arr[:, :, :3]
        img = Image.fromarray(arr.astype(np.uint8))
        img.save(os.path.join(tmp, f"f_{written:04d}.png"))
        written += 1
        now_p, now_q = (t.numpy() for t in robot.get_world_poses())
        drift = float(np.linalg.norm(now_p[0] - root_pos[0]))
        dot = abs(float(np.dot(now_q[0], root_quat[0])))
        tilt = math.degrees(2.0 * math.acos(min(1.0, dot)))
        result["rootDrift"] = max(result.get("rootDrift", 0.0), round(drift, 3))
        result["rootTiltDeg"] = max(result.get("rootTiltDeg", 0.0), round(tilt, 2))
    result["frames"] = written

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError("ffmpeg not found on PATH")
    if written < 8:
        raise RuntimeError(f"only {written} frames captured")
    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    proc = subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-framerate", str(args.fps),
         "-i", os.path.join(tmp, "f_%04d.png"),
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", os.path.abspath(args.out)],
        capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr.strip()[-400:]}")
    if args.poster:
        shutil.copy(os.path.join(tmp, f"f_{written - 1:04d}.png"), args.poster)
    shutil.rmtree(tmp, ignore_errors=True)

    result["ok"] = True
    result["seconds"] = round(time.time() - T_START, 1)
    finish(0)

except Exception as exc:  # noqa: BLE001 - the wrapper reads this off stdout
    result["errors"].append(f"{type(exc).__name__}: {exc}")
    result["traceback"] = traceback.format_exc()[-1500:]
    finish(1)
