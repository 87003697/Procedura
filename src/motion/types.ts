export type MotionJointType =
  | "fixed"
  | "revolute"
  | "prismatic"
  | "spherical"
  | "distance"
  | "d6"
  | "gear"
  | "rack_and_pinion"
  | "mimic";

export type MotionRigidBodyKind = "dynamic" | "kinematic" | "static";

export type MotionCollisionApproximation =
  | "none"
  | "convexHull"
  | "convexDecomposition"
  | "boundingCube"
  | "boundingSphere"
  | "meshSimplification"
  | "sdf";

export type MotionAxis = "X" | "Y" | "Z";

/**
 * Joint drive spec. Gains and force bounds are SI, sized per RADIAN for
 * angular joints: stiffness N*m/rad (linear: N/m), damping N*m*s/rad (linear:
 * N*s/m), maxForce N*m (linear: N). The USD exporter converts angular gains to
 * stage torque per degree ((PI/180)/metersPerUnit^2) and forces to stage
 * units; URDF gets SI directly. targetPosition stays degrees (angular) or
 * model units (linear); targetVelocity deg/s or model-units/s.
 */
export interface MotionDriveSpec {
  targetPosition?: number;
  targetVelocity?: number;
  stiffness?: number;
  damping?: number;
  maxForce?: number;
  type?: "force" | "acceleration";
}

export interface MotionLimitSpec {
  lower?: number;
  upper?: number;
  low?: number;
  high?: number;
}

export interface MotionD6AxisSpec {
  limit?: MotionLimitSpec;
  drive?: MotionDriveSpec;
}

export interface MotionJointPhysxSpec {
  armature?: number;
  jointFriction?: number;
  maxJointVelocity?: number;
  excludeFromArticulation?: boolean;
}

/** Physics material for a link's collision geometry. */
export interface MotionMaterialSpec {
  staticFriction?: number;
  dynamicFriction?: number;
  restitution?: number;
}

/** Spherical-joint cone limits, in degrees. */
export interface MotionConeSpec {
  angle0: number;
  angle1: number;
}

/** Mimic coupling on a revolute/prismatic joint: this joint follows referenceJoint. */
export interface MotionMimicSpec {
  referenceJoint: string;
  /** follower = gearing * reference + offset. Defaults to 1. */
  gearing?: number;
  offset?: number;
  /** Constraint solver stiffness in Hz; must be positive. Default 50. */
  naturalFrequency?: number;
  /** 1 = critically damped. Default 1. */
  dampingRatio?: number;
}

export interface MotionLinkSpec {
  name: string;
  /** Top-level SCAD module names that form this simulated rigid link. */
  parts?: string[];
  rigidBody?: MotionRigidBodyKind;
  /** Mass in kg. Wins over density when both are present. */
  mass?: number;
  /** Density in kg/m^3; exporters convert to stage units. */
  density?: number;
  /** Center of mass in model units, assembly frame. */
  centerOfMass?: [number, number, number];
  /** Diagonal inertia in kg*m^2; normally omitted (PhysX computes from geometry). */
  diagonalInertia?: [number, number, number];
  /** Principal axes quaternion [w,x,y,z] for diagonalInertia. */
  principalAxes?: [number, number, number, number];
  collision?: MotionCollisionApproximation;
  material?: MotionMaterialSpec;
}

export interface MotionJointSpec {
  name: string;
  type: MotionJointType;
  parent?: string;
  child: string;
  /** Revolute/prismatic primary axis. Defaults to Z. */
  axis?: MotionAxis;
  /** Joint frames. Defaults to zero-offset identity frames. */
  localPos0?: [number, number, number];
  localRot0?: [number, number, number, number];
  localPos1?: [number, number, number];
  localRot1?: [number, number, number, number];
  limit?: MotionLimitSpec;
  drive?: MotionDriveSpec;
  /** Max actuator force/torque. SI: N*m for angular joints, N for linear; exporters convert. URDF effort; default drive maxForce. */
  effortLimit?: number;
  /** Max joint velocity (deg/s or model-units/s). URDF velocity; default physx maxJointVelocity. */
  velocityLimit?: number;
  /** Spherical cone limits, degrees. */
  cone?: MotionConeSpec;
  /** Mimic coupling for revolute/prismatic joints (PhysxMimicJointAPI / URDF <mimic>). */
  mimic?: MotionMimicSpec;
  /** D6 axis data, keyed by USD Physics axis names. */
  d6?: Partial<Record<"transX" | "transY" | "transZ" | "rotX" | "rotY" | "rotZ", MotionD6AxisSpec>>;
  /** Distance-joint range, in model units (= stage units; written unconverted). */
  minDistance?: number;
  maxDistance?: number;
  /** Gear/rack constituent joints: joint0/joint1 name existing revolute (and, for rack, prismatic) joints. */
  joint0?: string;
  joint1?: string;
  /** Legacy coupled-joint metadata; joint0/gearing aliases. */
  referenceJoint?: string;
  ratio?: number;
  physx?: MotionJointPhysxSpec;
}

export interface MotionPlan {
  version: 1;
  name?: string;
  rootLink?: string;
  fixedBase?: boolean;
  metersPerUnit?: number;
  defaultCollision?: MotionCollisionApproximation;
  /** Enable articulation self-collision (physxArticulation:enabledSelfCollisions). Default false. */
  selfCollision?: boolean;
  links: MotionLinkSpec[];
  joints: MotionJointSpec[];
}

export interface MotionValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const JOINT_TYPES = new Set<MotionJointType>([
  "fixed", "revolute", "prismatic", "spherical", "distance",
  "d6", "gear", "rack_and_pinion", "mimic",
]);

const BODY_TYPES = new Set<MotionRigidBodyKind>(["dynamic", "kinematic", "static"]);

const COLLISION_TYPES = new Set<MotionCollisionApproximation>([
  "none", "convexHull", "convexDecomposition", "boundingCube",
  "boundingSphere", "meshSimplification", "sdf",
]);

const AXES = new Set<MotionAxis>(["X", "Y", "Z"]);

export function createDefaultMotionPlan(args: {
  name?: string;
  partNames: string[];
  fixedBase?: boolean;
  metersPerUnit?: number;
  defaultCollision?: MotionCollisionApproximation;
}): MotionPlan {
  const links = args.partNames.map((name) => ({
    name,
    parts: [name],
    rigidBody: "dynamic" as const,
    collision: args.defaultCollision ?? "convexHull",
  }));
  const rootLink = links[0]?.name ?? "root";
  const joints = links.slice(1).map((link) => ({
    name: `${rootLink}_to_${link.name}_fixed`,
    type: "fixed" as const,
    parent: rootLink,
    child: link.name,
  }));
  return {
    version: 1,
    ...(args.name !== undefined ? { name: args.name } : {}),
    rootLink,
    fixedBase: args.fixedBase ?? true,
    metersPerUnit: args.metersPerUnit ?? 0.001,
    defaultCollision: args.defaultCollision ?? "convexHull",
    links,
    joints,
  };
}

export function normalizeMotionPlan(input: unknown, fallbackParts: string[]): MotionPlan {
  const raw = isRecord(input) ? input : {};
  const linksRaw = Array.isArray(raw["links"]) ? raw["links"] : [];
  const links: MotionLinkSpec[] = linksRaw
    .filter(isRecord)
    .map((item) => {
      const name = String(item["name"] ?? "").trim();
      const parts = Array.isArray(item["parts"])
        ? item["parts"].map(String).map((s) => s.trim()).filter(Boolean)
        : undefined;
      const rigidBody = BODY_TYPES.has(item["rigidBody"] as MotionRigidBodyKind)
        ? item["rigidBody"] as MotionRigidBodyKind
        : undefined;
      const collision = COLLISION_TYPES.has(item["collision"] as MotionCollisionApproximation)
        ? item["collision"] as MotionCollisionApproximation
        : undefined;
      return {
        name,
        ...(parts !== undefined ? { parts } : {}),
        ...(rigidBody !== undefined ? { rigidBody } : {}),
        ...(finitePositive(item["mass"]) ? { mass: item["mass"] as number } : {}),
        ...(finitePositive(item["density"]) ? { density: item["density"] as number } : {}),
        ...(vec3(item["centerOfMass"]) ? { centerOfMass: vec3(item["centerOfMass"])! } : {}),
        ...(vec3(item["diagonalInertia"]) ? { diagonalInertia: vec3(item["diagonalInertia"])! } : {}),
        ...(quat(item["principalAxes"]) ? { principalAxes: quat(item["principalAxes"])! } : {}),
        ...(collision !== undefined ? { collision } : {}),
        ...(material(item["material"]) ? { material: material(item["material"])! } : {}),
      };
    })
    .filter((link) => link.name.length > 0);

  const jointsRaw = Array.isArray(raw["joints"]) ? raw["joints"] : [];
  const joints: MotionJointSpec[] = jointsRaw
    .filter(isRecord)
    .map((item) => normalizeJoint(item))
    .filter((joint): joint is MotionJointSpec => joint !== null);

  const defaultCollision = COLLISION_TYPES.has(raw["defaultCollision"] as MotionCollisionApproximation)
    ? raw["defaultCollision"] as MotionCollisionApproximation
    : "convexHull";

  const plan: MotionPlan = links.length > 0
    ? {
        version: 1,
        ...(typeof raw["name"] === "string" ? { name: raw["name"] } : {}),
        ...(typeof raw["rootLink"] === "string" ? { rootLink: raw["rootLink"] } : {}),
        ...(typeof raw["fixedBase"] === "boolean" ? { fixedBase: raw["fixedBase"] } : {}),
        ...(typeof raw["metersPerUnit"] === "number" ? { metersPerUnit: raw["metersPerUnit"] } : {}),
        ...(typeof raw["selfCollision"] === "boolean" ? { selfCollision: raw["selfCollision"] } : {}),
        defaultCollision,
        links,
        joints,
      }
    : createDefaultMotionPlan({
        partNames: fallbackParts,
        fixedBase: typeof raw["fixedBase"] === "boolean" ? raw["fixedBase"] : true,
        metersPerUnit: typeof raw["metersPerUnit"] === "number" ? raw["metersPerUnit"] : 0.001,
        defaultCollision,
      });

  return applyMotionDefaults(plan);
}

export function validateMotionPlan(plan: MotionPlan, availableParts: string[]): MotionValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const linkNames = new Set<string>();
  const partNames = new Set(availableParts);

  if (plan.version !== 1) errors.push(`motion plan version must be 1`);
  if (plan.links.length === 0) errors.push(`motion plan must contain at least one link`);

  const dynamicLinks = new Set<string>();
  for (const link of plan.links) {
    if (!isIdentifier(link.name)) errors.push(`link name is not a valid USD identifier: ${link.name}`);
    if (linkNames.has(link.name)) errors.push(`duplicate link: ${link.name}`);
    linkNames.add(link.name);
    if ((link.rigidBody ?? "dynamic") === "dynamic") dynamicLinks.add(link.name);
    if (link.parts && link.parts.length === 0) errors.push(`link ${link.name} has an empty parts array`);
    for (const part of link.parts ?? [link.name]) {
      if (!partNames.has(part)) warnings.push(`link ${link.name} references unknown SCAD part: ${part}`);
    }
    if (link.mass !== undefined && link.mass <= 0) errors.push(`link ${link.name} mass must be positive`);
    if (link.density !== undefined && link.density <= 0) errors.push(`link ${link.name} density must be positive`);
    if ((link.rigidBody ?? "dynamic") === "dynamic" && (link.collision ?? plan.defaultCollision ?? "convexHull") === "none") {
      warnings.push(`link ${link.name}: collision "none" (raw trimesh) is not simulable on a dynamic body in PhysX; exporter upgrades it to convexHull`);
    }
    if (link.material) {
      for (const [key, value] of Object.entries(link.material)) {
        if (typeof value === "number" && (value < 0 || !Number.isFinite(value))) {
          errors.push(`link ${link.name} material ${key} must be a non-negative number`);
        }
      }
    }
  }

  if (plan.rootLink && !linkNames.has(plan.rootLink)) {
    errors.push(`rootLink does not match any link: ${plan.rootLink}`);
  }

  const jointNames = new Set<string>();
  const jointByName = new Map<string, MotionJointSpec>();
  for (const joint of plan.joints) {
    if (!isIdentifier(joint.name)) errors.push(`joint name is not a valid USD identifier: ${joint.name}`);
    if (jointNames.has(joint.name)) errors.push(`duplicate joint: ${joint.name}`);
    jointNames.add(joint.name);
    jointByName.set(joint.name, joint);
    if (!JOINT_TYPES.has(joint.type)) errors.push(`unsupported joint type for ${joint.name}: ${joint.type}`);
    if (joint.parent && !linkNames.has(joint.parent)) errors.push(`joint ${joint.name} parent link not found: ${joint.parent}`);
    if (!linkNames.has(joint.child)) errors.push(`joint ${joint.name} child link not found: ${joint.child}`);
    if (joint.parent && joint.parent === joint.child) errors.push(`joint ${joint.name} parent and child are the same link`);
    if (joint.axis && !AXES.has(joint.axis)) errors.push(`joint ${joint.name} axis must be X, Y, or Z`);

    const low = joint.limit?.lower ?? joint.limit?.low;
    const high = joint.limit?.upper ?? joint.limit?.high;
    if (low !== undefined && high !== undefined && low > high) {
      errors.push(`joint ${joint.name} limit lower (${low}) exceeds upper (${high})`);
    }
    if (joint.effortLimit !== undefined && joint.effortLimit <= 0) errors.push(`joint ${joint.name} effortLimit must be positive`);
    if (joint.velocityLimit !== undefined && joint.velocityLimit <= 0) errors.push(`joint ${joint.name} velocityLimit must be positive`);

    if (joint.cone) {
      if (joint.type !== "spherical") warnings.push(`joint ${joint.name}: cone limits only apply to spherical joints`);
      if (joint.cone.angle0 < 0 || joint.cone.angle1 < 0) errors.push(`joint ${joint.name} cone angles must be non-negative`);
    }
    if (joint.type === "spherical" && joint.drive) {
      warnings.push(`joint ${joint.name}: spherical joints are not directly driven in Isaac/PhysX; use D6 or serial revolutes for actuation`);
    }
    if (joint.type === "distance" && !joint.physx?.excludeFromArticulation) {
      warnings.push(`joint ${joint.name}: distance joints are not articulation joints; exporter marks it as a regular joint`);
    }
    if (joint.type === "d6" && !joint.physx?.excludeFromArticulation) {
      for (const axis of ["transX", "transY", "transZ"] as const) {
        const lim = joint.d6?.[axis]?.limit;
        const dLow = lim?.lower ?? lim?.low;
        const dHigh = lim?.upper ?? lim?.high;
        if (dLow !== 0 || dHigh !== 0) {
          warnings.push(`joint ${joint.name}: Isaac articulations require D6 linear axis ${axis} to be locked; set low/high to 0 or exclude from articulation`);
        }
      }
    }
    if (joint.mimic) {
      if (joint.type !== "revolute" && joint.type !== "prismatic") {
        errors.push(`joint ${joint.name}: mimic coupling requires a revolute or prismatic joint`);
      }
      if (joint.mimic.referenceJoint === joint.name) {
        errors.push(`joint ${joint.name}: mimic referenceJoint cannot be the joint itself`);
      }
      if (!joint.limit) {
        warnings.push(`joint ${joint.name}: mimic joints need limits covering gearing x reference limits (PhysX mimic rule)`);
      }
    }
  }

  // Reference checks that need the full joint map.
  for (const joint of plan.joints) {
    if (joint.mimic) {
      const reference = jointByName.get(joint.mimic.referenceJoint);
      if (!reference) {
        errors.push(`joint ${joint.name}: mimic referenceJoint not found: ${joint.mimic.referenceJoint}`);
      } else if (!reference.limit) {
        warnings.push(`joint ${joint.name}: mimic reference joint ${reference.name} has no limits (PhysX mimic rule)`);
      }
    }
    if (joint.type === "gear" || joint.type === "rack_and_pinion") {
      const j0 = joint.joint0 ?? joint.referenceJoint;
      const j1 = joint.joint1;
      if (!j0) {
        warnings.push(`joint ${joint.name}: ${joint.type} has no joint0/referenceJoint; PhysX will not enforce the coupling`);
      } else if (!jointByName.has(j0)) {
        errors.push(`joint ${joint.name}: joint0 not found: ${j0}`);
      } else if (jointByName.get(j0)!.type !== "revolute") {
        errors.push(`joint ${joint.name}: joint0 must be a revolute joint`);
      }
      if (j1 !== undefined) {
        if (!jointByName.has(j1)) {
          errors.push(`joint ${joint.name}: joint1 not found: ${j1}`);
        } else {
          const expected = joint.type === "gear" ? "revolute" : "prismatic";
          if (jointByName.get(j1)!.type !== expected) {
            errors.push(`joint ${joint.name}: joint1 must be a ${expected} joint`);
          }
        }
      } else {
        warnings.push(`joint ${joint.name}: ${joint.type} has no joint1; exporter will try to infer it from the child link`);
      }
      if (!joint.physx?.excludeFromArticulation) {
        warnings.push(`joint ${joint.name}: ${joint.type} couplings close a kinematic loop; exporter excludes them from the articulation`);
      }
    }
    if (joint.type === "mimic") {
      warnings.push(`joint ${joint.name}: legacy joint type "mimic" — use a revolute/prismatic joint with a "mimic" field instead`);
      if (!joint.referenceJoint) warnings.push(`joint ${joint.name}: coupled joint has no referenceJoint metadata`);
    }
  }

  checkArticulationTopology(plan, linkNames, errors, warnings);

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Articulation joints (fixed/revolute/prismatic/spherical/d6 not excluded from
 * the articulation) must form a tree over the links: no cycles, no link with
 * two parents. gear/rack/distance joints are coupling constraints, not tree edges.
 */
function checkArticulationTopology(
  plan: MotionPlan,
  linkNames: Set<string>,
  errors: string[],
  warnings: string[],
): void {
  const TREE_TYPES = new Set<MotionJointType>(["fixed", "revolute", "prismatic", "spherical", "d6", "mimic"]);
  const parentOf = new Map<string, string>();
  const adjacency = new Map<string, string[]>();
  for (const joint of plan.joints) {
    if (!TREE_TYPES.has(joint.type) || joint.physx?.excludeFromArticulation) continue;
    if (!joint.parent || !linkNames.has(joint.parent) || !linkNames.has(joint.child)) continue;
    if (parentOf.has(joint.child)) {
      errors.push(
        `link ${joint.child} has multiple articulation parents (${parentOf.get(joint.child)} and ${joint.parent}); ` +
        `mark one joint physx.excludeFromArticulation to close the loop outside the articulation`,
      );
      continue;
    }
    parentOf.set(joint.child, joint.parent);
    const list = adjacency.get(joint.parent) ?? [];
    list.push(joint.child);
    adjacency.set(joint.parent, list);
  }

  // Cycle detection: follow parent pointers from every link.
  for (const link of linkNames) {
    const seen = new Set<string>([link]);
    let cursor = parentOf.get(link);
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        errors.push(
          `articulation joints form a cycle involving link ${cursor}; ` +
          `mark the loop-closing joint physx.excludeFromArticulation`,
        );
        return;
      }
      seen.add(cursor);
      cursor = parentOf.get(cursor);
    }
  }

  const root = plan.rootLink;
  if (root && linkNames.has(root) && linkNames.size > 1) {
    const reachable = new Set<string>([root]);
    const queue = [root];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const child of adjacency.get(current) ?? []) {
        if (!reachable.has(child)) {
          reachable.add(child);
          queue.push(child);
        }
      }
    }
    for (const link of linkNames) {
      if (!reachable.has(link)) {
        warnings.push(`link ${link} is not connected to rootLink ${root} by articulation joints; it will simulate as a free rigid body`);
      }
    }
  }
}

function applyMotionDefaults(plan: MotionPlan): MotionPlan {
  const defaultCollision = plan.defaultCollision ?? "convexHull";
  const links = plan.links.map((link) => ({
    ...link,
    parts: link.parts && link.parts.length > 0 ? link.parts : [link.name],
    rigidBody: link.rigidBody ?? "dynamic",
    collision: link.collision ?? defaultCollision,
  }));
  // Frames default to the shared world-anchor convention: a missing side
  // mirrors the provided one instead of collapsing to the assembly origin.
  const joints = plan.joints.map((joint) => ({
    ...joint,
    axis: joint.axis ?? defaultAxisFor(joint.type),
    localPos0: joint.localPos0 ?? joint.localPos1 ?? [0, 0, 0],
    localRot0: normalizeQuat(joint.localRot0 ?? joint.localRot1) ?? [1, 0, 0, 0],
    localPos1: joint.localPos1 ?? joint.localPos0 ?? [0, 0, 0],
    localRot1: normalizeQuat(joint.localRot1 ?? joint.localRot0) ?? [1, 0, 0, 0],
  }));
  return {
    ...plan,
    rootLink: plan.rootLink ?? links[0]?.name,
    fixedBase: plan.fixedBase ?? true,
    metersPerUnit: plan.metersPerUnit ?? 0.001,
    defaultCollision,
    selfCollision: plan.selfCollision ?? false,
    links,
    joints,
  };
}

function normalizeJoint(item: Record<string, unknown>): MotionJointSpec | null {
  const name = String(item["name"] ?? "").trim();
  const child = String(item["child"] ?? "").trim();
  let type = item["type"] as MotionJointType;
  if (!name || !child || !JOINT_TYPES.has(type)) return null;
  const parent = typeof item["parent"] === "string" ? item["parent"].trim() : undefined;
  const axis = AXES.has(item["axis"] as MotionAxis) ? item["axis"] as MotionAxis : undefined;

  let mimic = mimicSpec(item["mimic"]);
  // Legacy "mimic" joint type: convert to a revolute joint carrying a mimic
  // coupling, whether the reference comes from the legacy referenceJoint field
  // or a new-style mimic object.
  if (type === "mimic") {
    if (mimic) {
      type = "revolute";
    } else if (typeof item["referenceJoint"] === "string" && item["referenceJoint"]) {
      type = "revolute";
      mimic = {
        referenceJoint: item["referenceJoint"],
        ...(typeof item["ratio"] === "number" ? { gearing: item["ratio"] } : {}),
      };
    }
  }

  const joint: MotionJointSpec = {
    name,
    type,
    ...(parent ? { parent } : {}),
    child,
    ...(axis !== undefined ? { axis } : {}),
    ...(vec3(item["localPos0"]) ? { localPos0: vec3(item["localPos0"])! } : {}),
    ...(quat(item["localRot0"]) ? { localRot0: quat(item["localRot0"])! } : {}),
    ...(vec3(item["localPos1"]) ? { localPos1: vec3(item["localPos1"])! } : {}),
    ...(quat(item["localRot1"]) ? { localRot1: quat(item["localRot1"])! } : {}),
    ...(limit(item["limit"]) ? { limit: limit(item["limit"])! } : {}),
    ...(drive(item["drive"]) ? { drive: drive(item["drive"])! } : {}),
    ...(finitePositive(item["effortLimit"]) ? { effortLimit: item["effortLimit"] as number } : {}),
    ...(finitePositive(item["velocityLimit"]) ? { velocityLimit: item["velocityLimit"] as number } : {}),
    ...(cone(item["cone"]) ? { cone: cone(item["cone"])! } : {}),
    ...(mimic ? { mimic } : {}),
    ...(typeof item["minDistance"] === "number" ? { minDistance: item["minDistance"] } : {}),
    ...(typeof item["maxDistance"] === "number" ? { maxDistance: item["maxDistance"] } : {}),
    ...(typeof item["joint0"] === "string" && item["joint0"] ? { joint0: item["joint0"] } : {}),
    ...(typeof item["joint1"] === "string" && item["joint1"] ? { joint1: item["joint1"] } : {}),
    ...(typeof item["referenceJoint"] === "string" && item["referenceJoint"] ? { referenceJoint: item["referenceJoint"] } : {}),
    ...(typeof item["ratio"] === "number" ? { ratio: item["ratio"] } : {}),
    ...(physx(item["physx"]) ? { physx: physx(item["physx"])! } : {}),
  };
  if (isRecord(item["d6"])) {
    const d6: MotionJointSpec["d6"] = {};
    for (const key of ["transX", "transY", "transZ", "rotX", "rotY", "rotZ"] as const) {
      const raw = item["d6"][key];
      if (!isRecord(raw)) continue;
      d6[key] = {
        ...(limit(raw["limit"]) ? { limit: limit(raw["limit"])! } : {}),
        ...(drive(raw["drive"]) ? { drive: drive(raw["drive"])! } : {}),
      };
    }
    joint.d6 = d6;
  }
  return joint;
}

function defaultAxisFor(type: MotionJointType): MotionAxis | undefined {
  return type === "revolute" || type === "prismatic" ? "Z" : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function finitePositive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function vec3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  if (!value.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return [value[0]!, value[1]!, value[2]!];
}

function quat(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  if (!value.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return [value[0]!, value[1]!, value[2]!, value[3]!];
}

function normalizeQuat(
  value: [number, number, number, number] | undefined,
): [number, number, number, number] | undefined {
  if (!value) return undefined;
  const len = Math.hypot(value[0], value[1], value[2], value[3]);
  if (!Number.isFinite(len) || len < 1e-9) return [1, 0, 0, 0];
  return [value[0] / len, value[1] / len, value[2] / len, value[3] / len];
}

function limit(value: unknown): MotionLimitSpec | null {
  if (!isRecord(value)) return null;
  const out: MotionLimitSpec = {};
  if (typeof value["lower"] === "number") out.lower = value["lower"];
  if (typeof value["upper"] === "number") out.upper = value["upper"];
  if (typeof value["low"] === "number") out.low = value["low"];
  if (typeof value["high"] === "number") out.high = value["high"];
  return Object.keys(out).length ? out : null;
}

function drive(value: unknown): MotionDriveSpec | null {
  if (!isRecord(value)) return null;
  const out: MotionDriveSpec = {};
  if (typeof value["targetPosition"] === "number") out.targetPosition = value["targetPosition"];
  if (typeof value["targetVelocity"] === "number") out.targetVelocity = value["targetVelocity"];
  if (typeof value["stiffness"] === "number") out.stiffness = value["stiffness"];
  if (typeof value["damping"] === "number") out.damping = value["damping"];
  if (typeof value["maxForce"] === "number") out.maxForce = value["maxForce"];
  if (value["type"] === "force" || value["type"] === "acceleration") out.type = value["type"];
  return Object.keys(out).length ? out : null;
}

function physx(value: unknown): MotionJointPhysxSpec | null {
  if (!isRecord(value)) return null;
  const out: MotionJointPhysxSpec = {};
  if (typeof value["armature"] === "number") out.armature = value["armature"];
  if (typeof value["jointFriction"] === "number") out.jointFriction = value["jointFriction"];
  if (typeof value["maxJointVelocity"] === "number") out.maxJointVelocity = value["maxJointVelocity"];
  if (typeof value["excludeFromArticulation"] === "boolean") out.excludeFromArticulation = value["excludeFromArticulation"];
  return Object.keys(out).length ? out : null;
}

function material(value: unknown): MotionMaterialSpec | null {
  if (!isRecord(value)) return null;
  const out: MotionMaterialSpec = {};
  if (typeof value["staticFriction"] === "number") out.staticFriction = value["staticFriction"];
  if (typeof value["dynamicFriction"] === "number") out.dynamicFriction = value["dynamicFriction"];
  if (typeof value["restitution"] === "number") out.restitution = value["restitution"];
  return Object.keys(out).length ? out : null;
}

function cone(value: unknown): MotionConeSpec | null {
  if (!isRecord(value)) return null;
  const angle0 = value["angle0"];
  const angle1 = value["angle1"];
  if (typeof angle0 !== "number" || typeof angle1 !== "number") return null;
  if (!Number.isFinite(angle0) || !Number.isFinite(angle1)) return null;
  return { angle0, angle1 };
}

function mimicSpec(value: unknown): MotionMimicSpec | null {
  if (!isRecord(value)) return null;
  const referenceJoint = typeof value["referenceJoint"] === "string" ? value["referenceJoint"].trim() : "";
  if (!referenceJoint) return null;
  return {
    referenceJoint,
    ...(typeof value["gearing"] === "number" && Number.isFinite(value["gearing"]) ? { gearing: value["gearing"] } : {}),
    ...(typeof value["offset"] === "number" && Number.isFinite(value["offset"]) ? { offset: value["offset"] } : {}),
    ...(finitePositive(value["naturalFrequency"]) ? { naturalFrequency: value["naturalFrequency"] as number } : {}),
    ...(finitePositive(value["dampingRatio"]) ? { dampingRatio: value["dampingRatio"] as number } : {}),
  };
}
