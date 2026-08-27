import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { MotionJointSpec, MotionJointType, MotionLinkSpec, MotionPlan } from "./types.ts";
import type { MotionLinkMesh, UsdMeshData } from "./usda.ts";

/**
 * Deterministic URDF exporter for a MotionPlan + world-baked link meshes.
 *
 * Conventions:
 * - Plan spatial values are model units (stage metersPerUnit, default 0.001),
 *   angles degrees, mass kg, density kg/m^3, inertia kg*m^2. Plan effort
 *   values (effortLimit, drive.maxForce) are already SI (N*m for angular
 *   joints, N for linear) and pass through to <limit effort> unchanged.
 *   URDF output is SI: meters, radians, kg, kg*m^2.
 * - Meshes are world-baked with identity link Xforms; joint frames are shared
 *   world anchors (localPos0 == localPos1). The root link frame is the
 *   assembly origin; every other link frame sits at its tree joint's anchor.
 * - spherical/d6/distance joints degrade to fixed; gear/rack_and_pinion and
 *   excludeFromArticulation joints are skipped (URDF cannot express loop
 *   closures). Links unreachable from the root are attached to it with a
 *   synthesized fixed joint (URDF requires a single tree).
 */

export interface WriteMotionUrdfOpts {
  urdfDir: string;
  plan: MotionPlan;
  linkMeshes: MotionLinkMesh[];
  name?: string;
}

export interface WriteMotionUrdfResult {
  urdfPath: string;
  meshDir: string;
  warnings: string[];
}

type UrdfJointType = "fixed" | "revolute" | "continuous" | "prismatic";

interface TreeEdge {
  joint: MotionJointSpec;
  parent: string;
  child: string;
  urdfType: UrdfJointType;
  degradedFrom?: MotionJointType;
  synthesized?: boolean;
}

interface SkippedJoint {
  joint: MotionJointSpec;
  reason: string;
}

type Vec3 = [number, number, number];

const MIN_INERTIA = 1e-6;
const BBOX_FILL_FACTOR = 0.4;
const DEFAULT_EFFORT = 1000;
const DEFAULT_VELOCITY = 100;

export function writeMotionUrdf(opts: WriteMotionUrdfOpts): WriteMotionUrdfResult {
  const plan = opts.plan;
  if (plan.links.length === 0) throw new Error("writeMotionUrdf: motion plan has no links");
  const warnings: string[] = [];
  const metersPerUnit = plan.metersPerUnit ?? 0.001;

  const meshDir = join(opts.urdfDir, "meshes");
  mkdirSync(meshDir, { recursive: true });

  const robotName = safeUrdfName(opts.name ?? plan.name ?? "robot");
  const urdfPath = join(opts.urdfDir, `${robotName}.urdf`);

  const linkByName = new Map<string, MotionLinkSpec>();
  for (const link of plan.links) linkByName.set(link.name, link);
  const meshByLink = new Map<string, UsdMeshData>();
  for (const linkMesh of opts.linkMeshes) meshByLink.set(linkMesh.link.name, linkMesh.mesh);

  let root = plan.links[0]!.name;
  if (plan.rootLink !== undefined) {
    if (linkByName.has(plan.rootLink)) {
      root = plan.rootLink;
    } else {
      warnings.push(`rootLink ${plan.rootLink} does not match any link; using ${root} as the URDF root`);
    }
  }

  const joints = plan.joints.map(normalizeLegacyMimicJoint);
  const { edges, skipped, synthesized } = buildTree(plan, joints, linkByName, root, warnings);

  // Link frame origins in model units (world anchors).
  const frames = new Map<string, Vec3>();
  frames.set(root, [0, 0, 0]);
  for (const link of plan.links) {
    if (link.name === root) continue;
    const edge = edges.get(link.name);
    frames.set(link.name, edge?.joint.localPos0 ?? [0, 0, 0]);
  }

  // Per-link OBJ meshes, expressed in the link frame, in meters.
  const meshFileByLink = new Map<string, string>();
  for (const link of plan.links) {
    const mesh = meshByLink.get(link.name);
    if (!mesh || mesh.points.length === 0) {
      warnings.push(`link ${link.name} has no compiled mesh; URDF link has no visual/collision geometry`);
      continue;
    }
    const fileName = `${safeUrdfName(link.name)}.obj`;
    writeObjMesh(join(meshDir, fileName), mesh, frames.get(link.name) ?? [0, 0, 0], metersPerUnit, link.name);
    meshFileByLink.set(link.name, fileName);
  }

  // Fallback travel range (meters) for prismatic joints without plan limits:
  // the whole model's bbox diagonal, floored at 0.1 m. Without explicit
  // lower/upper, URDF consumers default both to 0 and freeze the DOF.
  const allPoints = opts.linkMeshes.flatMap((linkMesh) => linkMesh.mesh.points);
  let fallbackTravelM = 0.1;
  if (allPoints.length > 0) {
    const bbox = computeBbox(allPoints);
    const diagonalM = Math.hypot(
      (bbox.max[0] - bbox.min[0]) * metersPerUnit,
      (bbox.max[1] - bbox.min[1]) * metersPerUnit,
      (bbox.max[2] - bbox.min[2]) * metersPerUnit,
    );
    if (Number.isFinite(diagonalM)) fallbackTravelM = Math.max(diagonalM, 0.1);
  }

  const edgeByJointName = new Map<string, TreeEdge>();
  for (const edge of edges.values()) edgeByJointName.set(edge.joint.name, edge);
  const skippedByJoint = new Map<MotionJointSpec, string>();
  for (const entry of skipped) skippedByJoint.set(entry.joint, entry.reason);

  const xml = new XmlWriter();
  xml.line(`<?xml version="1.0"?>`);
  xml.open(`<robot name="${esc(robotName)}">`);

  if (plan.fixedBase) xml.line(`<link name="world"/>`);
  for (const link of plan.links) {
    writeLinkXml(xml, link, meshByLink.get(link.name), meshFileByLink.get(link.name), frames.get(link.name) ?? [0, 0, 0], metersPerUnit);
  }

  if (plan.fixedBase) {
    xml.open(`<joint name="world_to_${esc(safeUrdfName(root))}" type="fixed">`);
    xml.line(`<origin xyz="0 0 0" rpy="0 0 0"/>`);
    xml.line(`<parent link="world"/>`);
    xml.line(`<child link="${esc(safeUrdfName(root))}"/>`);
    xml.close(`</joint>`);
  }

  for (const joint of joints) {
    const edge = edges.get(joint.child);
    if (edge && edge.joint === joint) {
      writeJointXml(xml, edge, frames, metersPerUnit, edgeByJointName, fallbackTravelM, warnings);
    } else {
      const reason = skippedByJoint.get(joint) ?? "not part of the articulation tree";
      xml.line(comment(`joint "${joint.name}" (${joint.type}) skipped: ${reason}`));
    }
  }
  for (const edge of synthesized) {
    xml.line(comment(`link "${edge.child}" is unreachable from root "${root}"; attached with a synthesized fixed joint`));
    writeJointXml(xml, edge, frames, metersPerUnit, edgeByJointName, fallbackTravelM, warnings);
  }

  xml.close(`</robot>`);
  writeFileSync(urdfPath, xml.toString(), "utf8");

  return { urdfPath, meshDir, warnings };
}

/** Legacy joint type "mimic": treat as a revolute joint carrying a mimic coupling. */
function normalizeLegacyMimicJoint(joint: MotionJointSpec): MotionJointSpec {
  if (joint.type !== "mimic") return joint;
  const mimic = joint.mimic ?? (joint.referenceJoint !== undefined
    ? {
        referenceJoint: joint.referenceJoint,
        ...(joint.ratio !== undefined ? { gearing: joint.ratio } : {}),
      }
    : undefined);
  return { ...joint, type: "revolute", ...(mimic !== undefined ? { mimic } : {}) };
}

function buildTree(
  plan: MotionPlan,
  joints: MotionJointSpec[],
  linkByName: Map<string, MotionLinkSpec>,
  root: string,
  warnings: string[],
): { edges: Map<string, TreeEdge>; skipped: SkippedJoint[]; synthesized: TreeEdge[] } {
  const edges = new Map<string, TreeEdge>();
  const skipped: SkippedJoint[] = [];

  const skip = (joint: MotionJointSpec, reason: string): void => {
    skipped.push({ joint, reason });
    warnings.push(`joint ${joint.name} (${joint.type}) skipped in URDF: ${reason}`);
  };

  for (const joint of joints) {
    if (joint.type === "gear" || joint.type === "rack_and_pinion") {
      skip(joint, `URDF cannot express ${joint.type} couplings (kinematic loop closure)`);
      continue;
    }
    if (joint.physx?.excludeFromArticulation) {
      skip(joint, "excluded from the articulation (loop-closure joint); URDF cannot express loop closures");
      continue;
    }
    if (joint.parent === undefined || !linkByName.has(joint.parent)) {
      skip(joint, `parent link ${joint.parent ?? "(none)"} not found`);
      continue;
    }
    if (!linkByName.has(joint.child)) {
      skip(joint, `child link ${joint.child} not found`);
      continue;
    }
    if (joint.parent === joint.child) {
      skip(joint, "parent and child are the same link");
      continue;
    }
    if (joint.child === root) {
      skip(joint, `child ${joint.child} is the root link`);
      continue;
    }
    const existing = edges.get(joint.child);
    if (existing) {
      skip(joint, `link ${joint.child} already has articulation parent ${existing.parent}`);
      continue;
    }

    let urdfType: UrdfJointType;
    let degradedFrom: MotionJointType | undefined;
    if (joint.type === "spherical" || joint.type === "d6" || joint.type === "distance") {
      urdfType = "fixed";
      degradedFrom = joint.type;
      warnings.push(`joint ${joint.name} (${joint.type}) degraded to fixed in URDF: URDF cannot express ${joint.type} joints`);
    } else if (joint.type === "fixed") {
      urdfType = "fixed";
    } else if (joint.type === "prismatic") {
      urdfType = "prismatic";
    } else {
      // revolute: no limit at all means a free-spinning continuous joint.
      const low = joint.limit?.lower ?? joint.limit?.low;
      const high = joint.limit?.upper ?? joint.limit?.high;
      urdfType = low === undefined && high === undefined ? "continuous" : "revolute";
    }
    edges.set(joint.child, {
      joint,
      parent: joint.parent,
      child: joint.child,
      urdfType,
      ...(degradedFrom !== undefined ? { degradedFrom } : {}),
    });
  }

  // URDF requires a single tree: attach unreachable links to the root with
  // synthesized fixed joints, breaking any cycles disconnected from the root.
  const synthesized: TreeEdge[] = [];
  let reachable = reachableFrom(root, edges);
  while (reachable.size < plan.links.length) {
    const unreachable = plan.links.filter((link) => !reachable.has(link.name));
    let candidate = unreachable.find((link) => !edges.has(link.name));
    if (candidate === undefined) {
      candidate = unreachable[0]!;
      const dropped = edges.get(candidate.name)!;
      edges.delete(candidate.name);
      skip(dropped.joint, "dropped to break an articulation cycle unreachable from the root");
    }
    warnings.push(`link ${candidate.name} is not reachable from root ${root} by tree joints; attached to root with a synthesized fixed joint`);
    const syntheticJoint: MotionJointSpec = {
      name: `orphan_${safeUrdfName(candidate.name)}_fixed`,
      type: "fixed",
      parent: root,
      child: candidate.name,
      localPos0: [0, 0, 0],
    };
    const edge: TreeEdge = { joint: syntheticJoint, parent: root, child: candidate.name, urdfType: "fixed", synthesized: true };
    edges.set(candidate.name, edge);
    synthesized.push(edge);
    reachable = reachableFrom(root, edges);
  }

  return { edges, skipped, synthesized };
}

function reachableFrom(root: string, edges: Map<string, TreeEdge>): Set<string> {
  const children = new Map<string, string[]>();
  for (const edge of edges.values()) {
    const list = children.get(edge.parent) ?? [];
    list.push(edge.child);
    children.set(edge.parent, list);
  }
  const reachable = new Set<string>([root]);
  const queue: string[] = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of children.get(current) ?? []) {
      if (!reachable.has(child)) {
        reachable.add(child);
        queue.push(child);
      }
    }
  }
  return reachable;
}

function writeLinkXml(
  xml: XmlWriter,
  link: MotionLinkSpec,
  mesh: UsdMeshData | undefined,
  meshFile: string | undefined,
  frame: Vec3,
  metersPerUnit: number,
): void {
  xml.open(`<link name="${esc(safeUrdfName(link.name))}">`);

  const bbox = mesh !== undefined && mesh.points.length > 0 ? computeBbox(mesh.points) : undefined;
  const bboxCenter: Vec3 = bbox !== undefined
    ? [(bbox.min[0] + bbox.max[0]) / 2, (bbox.min[1] + bbox.max[1]) / 2, (bbox.min[2] + bbox.max[2]) / 2]
    : [0, 0, 0];
  const dimsM: Vec3 = bbox !== undefined
    ? [
        (bbox.max[0] - bbox.min[0]) * metersPerUnit,
        (bbox.max[1] - bbox.min[1]) * metersPerUnit,
        (bbox.max[2] - bbox.min[2]) * metersPerUnit,
      ]
    : [0, 0, 0];
  const bboxVolumeM3 = dimsM[0] * dimsM[1] * dimsM[2];

  let mass = link.mass;
  if (mass === undefined && link.density !== undefined && bboxVolumeM3 > 0) {
    // Bbox volume overestimates the enclosed solid; apply a fill factor.
    mass = link.density * bboxVolumeM3 * BBOX_FILL_FACTOR;
  }
  if (mass === undefined || !Number.isFinite(mass) || mass <= 0) mass = 1;

  let ixx: number;
  let iyy: number;
  let izz: number;
  if (link.diagonalInertia !== undefined) {
    [ixx, iyy, izz] = link.diagonalInertia;
  } else {
    // Solid-box approximation from the mesh bbox.
    ixx = (mass / 12) * (dimsM[1] * dimsM[1] + dimsM[2] * dimsM[2]);
    iyy = (mass / 12) * (dimsM[0] * dimsM[0] + dimsM[2] * dimsM[2]);
    izz = (mass / 12) * (dimsM[0] * dimsM[0] + dimsM[1] * dimsM[1]);
  }
  ixx = Math.max(ixx, MIN_INERTIA);
  iyy = Math.max(iyy, MIN_INERTIA);
  izz = Math.max(izz, MIN_INERTIA);

  const com = link.centerOfMass ?? bboxCenter;
  const comLocalM: Vec3 = [
    (com[0] - frame[0]) * metersPerUnit,
    (com[1] - frame[1]) * metersPerUnit,
    (com[2] - frame[2]) * metersPerUnit,
  ];

  // diagonalInertia is expressed in the principal-axes frame; carry that
  // rotation on the inertial origin so URDF interprets the diagonal correctly.
  const inertialRpy: Vec3 = link.diagonalInertia !== undefined && link.principalAxes !== undefined
    ? quatToRpy(link.principalAxes)
    : [0, 0, 0];

  xml.open(`<inertial>`);
  xml.line(`<origin xyz="${vec3Attr(comLocalM)}" rpy="${vec3Attr(inertialRpy)}"/>`);
  xml.line(`<mass value="${fmt(mass)}"/>`);
  xml.line(`<inertia ixx="${fmt(ixx)}" ixy="0" ixz="0" iyy="${fmt(iyy)}" iyz="0" izz="${fmt(izz)}"/>`);
  xml.close(`</inertial>`);

  if (meshFile !== undefined) {
    for (const tag of ["visual", "collision"] as const) {
      xml.open(`<${tag}>`);
      xml.open(`<geometry>`);
      xml.line(`<mesh filename="meshes/${esc(meshFile)}"/>`);
      xml.close(`</geometry>`);
      xml.close(`</${tag}>`);
    }
  }

  xml.close(`</link>`);
}

function writeJointXml(
  xml: XmlWriter,
  edge: TreeEdge,
  frames: Map<string, Vec3>,
  metersPerUnit: number,
  edgeByJointName: Map<string, TreeEdge>,
  fallbackTravelM: number,
  warnings: string[],
): void {
  const joint = edge.joint;
  if (edge.degradedFrom !== undefined) {
    xml.line(comment(`joint "${joint.name}" (${edge.degradedFrom}) degraded to fixed: URDF cannot express ${edge.degradedFrom} joints`));
  }

  const parentFrame = frames.get(edge.parent) ?? [0, 0, 0];
  const childFrame = frames.get(edge.child) ?? [0, 0, 0];
  const originM: Vec3 = [
    (childFrame[0] - parentFrame[0]) * metersPerUnit,
    (childFrame[1] - parentFrame[1]) * metersPerUnit,
    (childFrame[2] - parentFrame[2]) * metersPerUnit,
  ];

  xml.open(`<joint name="${esc(safeUrdfName(joint.name))}" type="${edge.urdfType}">`);
  xml.line(`<origin xyz="${vec3Attr(originM)}" rpy="0 0 0"/>`);
  xml.line(`<parent link="${esc(safeUrdfName(edge.parent))}"/>`);
  xml.line(`<child link="${esc(safeUrdfName(edge.child))}"/>`);

  const movable = edge.urdfType !== "fixed";
  if (movable) {
    const angular = edge.urdfType === "revolute" || edge.urdfType === "continuous";
    xml.line(`<axis xyz="${vec3Attr(jointAxisVector(joint))}"/>`);

    const effort = joint.effortLimit ?? joint.drive?.maxForce;
    if (effort === undefined) {
      warnings.push(`joint ${joint.name}: no effortLimit or drive.maxForce; defaulting URDF effort to ${DEFAULT_EFFORT}`);
    }
    const effortValue = effort ?? DEFAULT_EFFORT;
    const velocityRaw = joint.velocityLimit ?? joint.physx?.maxJointVelocity ?? DEFAULT_VELOCITY;
    const velocityValue = angular ? degToRad(velocityRaw) : velocityRaw * metersPerUnit;

    let limitAttrs = "";
    if (edge.urdfType === "revolute") {
      const low = joint.limit?.lower ?? joint.limit?.low ?? 0;
      const high = joint.limit?.upper ?? joint.limit?.high ?? 0;
      limitAttrs = ` lower="${fmt(degToRad(low))}" upper="${fmt(degToRad(high))}"`;
    } else if (edge.urdfType === "prismatic") {
      const low = joint.limit?.lower ?? joint.limit?.low;
      const high = joint.limit?.upper ?? joint.limit?.high;
      if (low === undefined && high === undefined) {
        // URDF consumers default missing lower/upper to 0, freezing the DOF.
        warnings.push(`prismatic joint ${joint.name} has no limits; URDF defaults to ±${fmt(fallbackTravelM)} m travel`);
        limitAttrs = ` lower="${fmt(-fallbackTravelM)}" upper="${fmt(fallbackTravelM)}"`;
      } else {
        if (low !== undefined) limitAttrs += ` lower="${fmt(low * metersPerUnit)}"`;
        if (high !== undefined) limitAttrs += ` upper="${fmt(high * metersPerUnit)}"`;
      }
    }
    xml.line(`<limit${limitAttrs} effort="${fmt(effortValue)}" velocity="${fmt(velocityValue)}"/>`);

    if (joint.mimic !== undefined) {
      const refName = joint.mimic.referenceJoint;
      const refEdge = edgeByJointName.get(refName);
      if (refEdge === undefined || refEdge.urdfType === "fixed") {
        warnings.push(
          `joint ${joint.name}: mimic reference joint ${refName} was ` +
          `${refEdge === undefined ? "skipped" : "degraded to fixed"} in URDF; <mimic> omitted`,
        );
        xml.line(comment(`mimic of "${refName}" omitted: reference joint is not a movable URDF joint`));
      } else {
        // Plan mimic semantics are follower = gearing * reference + offset in
        // SOURCE units (degrees for angular, model units for linear); URDF
        // mimic is rad/m, so fold the follower/reference unit scales into the
        // multiplier. Same-type pairs are numerically unchanged.
        const refAngular = refEdge.urdfType === "revolute" || refEdge.urdfType === "continuous";
        const kFollower = angular ? Math.PI / 180 : metersPerUnit;
        const kReference = refAngular ? Math.PI / 180 : metersPerUnit;
        const multiplier = (joint.mimic.gearing ?? 1) * (kFollower / kReference);
        let mimicAttrs = ` joint="${esc(safeUrdfName(refName))}" multiplier="${fmt(multiplier)}"`;
        if (joint.mimic.offset !== undefined) {
          const offset = angular ? degToRad(joint.mimic.offset) : joint.mimic.offset * metersPerUnit;
          mimicAttrs += ` offset="${fmt(offset)}"`;
        }
        xml.line(`<mimic${mimicAttrs}/>`);
      }
    }
  }

  xml.close(`</joint>`);
}

/** World axis vector: joint.axis unit vector rotated by localRot0 [w,x,y,z]. */
function jointAxisVector(joint: MotionJointSpec): Vec3 {
  const unit: Vec3 = joint.axis === "X" ? [1, 0, 0] : joint.axis === "Y" ? [0, 1, 0] : [0, 0, 1];
  const rotated = rotateByQuat(joint.localRot0 ?? [1, 0, 0, 0], unit);
  const length = Math.hypot(rotated[0], rotated[1], rotated[2]);
  if (!Number.isFinite(length) || length < 1e-9) return unit;
  return [rotated[0] / length, rotated[1] / length, rotated[2] / length];
}

function rotateByQuat(q: [number, number, number, number], v: Vec3): Vec3 {
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

function writeObjMesh(
  path: string,
  mesh: UsdMeshData,
  frame: Vec3,
  metersPerUnit: number,
  linkName: string,
): void {
  const lines: string[] = [`# Procedura URDF mesh for link ${linkName} (meters, link frame)`];
  for (const point of mesh.points) {
    lines.push(
      `v ${fmt((point[0] - frame[0]) * metersPerUnit)}` +
      ` ${fmt((point[1] - frame[1]) * metersPerUnit)}` +
      ` ${fmt((point[2] - frame[2]) * metersPerUnit)}`,
    );
  }
  const counts = mesh.faceVertexCounts.length > 0
    ? mesh.faceVertexCounts
    : new Array<number>(Math.floor(mesh.faceVertexIndices.length / 3)).fill(3);
  let cursor = 0;
  for (const count of counts) {
    const face: number[] = [];
    for (let k = 0; k < count; k++) face.push((mesh.faceVertexIndices[cursor + k] ?? 0) + 1);
    cursor += count;
    if (face.length >= 3) lines.push(`f ${face.join(" ")}`);
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

function computeBbox(points: Array<Vec3>): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const point of points) {
    for (let i = 0; i < 3; i++) {
      if (point[i]! < min[i]!) min[i] = point[i]!;
      if (point[i]! > max[i]!) max[i] = point[i]!;
    }
  }
  return { min, max };
}

function degToRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Quaternion [w,x,y,z] to URDF rpy: ZYX extrinsic roll-pitch-yaw, radians. */
function quatToRpy(q: [number, number, number, number]): Vec3 {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!Number.isFinite(len) || len < 1e-9) return [0, 0, 0];
  const w = q[0] / len;
  const x = q[1] / len;
  const y = q[2] / len;
  const z = q[3] / len;
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const sinPitch = 2 * (w * y - z * x);
  const pitch = Math.abs(sinPitch) >= 1 ? Math.sign(sinPitch) * (Math.PI / 2) : Math.asin(sinPitch);
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return [roll, pitch, yaw];
}

function vec3Attr(value: Vec3): string {
  return `${fmt(value[0])} ${fmt(value[1])} ${fmt(value[2])}`;
}

function fmt(value: number): string {
  if (!Number.isFinite(value)) return "0";
  // toFixed switches to exponent notation at |v| >= 1e21; the trailing-zero
  // strip would corrupt it (e.g. "1e+30" -> "1e+3").
  if (Math.abs(value) >= 1e21) return String(value);
  const fixed = value.toFixed(9).replace(/\.?0+$/, "");
  return fixed === "" || fixed === "-0" ? "0" : fixed;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function comment(text: string): string {
  return `<!-- ${text.replace(/--/g, "- -")} -->`;
}

function safeUrdfName(value: string): string {
  const s = value.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+/, "");
  if (!s) return "unnamed";
  return /^[A-Za-z_]/.test(s) ? s : `n_${s}`;
}

class XmlWriter {
  private lines: string[] = [];
  private level = 0;

  line(text: string): void {
    this.lines.push(`${"  ".repeat(this.level)}${text}`);
  }

  open(text: string): void {
    this.line(text);
    this.level += 1;
  }

  close(text: string): void {
    this.level = Math.max(0, this.level - 1);
    this.line(text);
  }

  toString(): string {
    return this.lines.join("\n") + "\n";
  }
}
