import { writeFileSync } from "node:fs";

import type { STLMesh } from "../mesh/stl.ts";
import type {
  MotionCollisionApproximation,
  MotionD6AxisSpec,
  MotionDriveSpec,
  MotionJointSpec,
  MotionLimitSpec,
  MotionLinkSpec,
  MotionPlan,
} from "./types.ts";

export interface UsdMeshData {
  points: Array<[number, number, number]>;
  faceVertexCounts: number[];
  faceVertexIndices: number[];
}

export interface MotionLinkMesh {
  link: MotionLinkSpec;
  mesh: UsdMeshData;
  stlPath?: string;
  objPath?: string;
}

export interface WriteMotionUsdaOpts {
  path: string;
  plan: MotionPlan;
  linkMeshes: MotionLinkMesh[];
  warnings?: string[];
}

const POINT_PRECISION = 6;
/** Golden angle in degrees; steps link hues so neighbours stay distinguishable. */
const GOLDEN_ANGLE_DEG = 137.50776405003785;

interface LinkWriteOpts {
  defaultCollision: MotionCollisionApproximation;
  rootPath: string;
  metersPerUnit: number;
  warnings: string[];
}

interface JointWriteContext {
  rootPath: string;
  plan: MotionPlan;
  jointByName: Map<string, MotionJointSpec>;
  warnings: string[];
}

export function meshToUsdMeshData(mesh: STLMesh): UsdMeshData {
  const points: Array<[number, number, number]> = [];
  const faceVertexCounts: number[] = [];
  const faceVertexIndices: number[] = [];
  const dedup = new Map<string, number>();

  for (let tri = 0; tri < mesh.triCount; tri++) {
    const base = tri * 9;
    faceVertexCounts.push(3);
    for (let k = 0; k < 3; k++) {
      const i = base + k * 3;
      const p: [number, number, number] = [
        mesh.vertices[i] ?? 0,
        mesh.vertices[i + 1] ?? 0,
        mesh.vertices[i + 2] ?? 0,
      ];
      const key = pointKey(p);
      let idx = dedup.get(key);
      if (idx === undefined) {
        idx = points.length;
        dedup.set(key, idx);
        points.push(p);
      }
      faceVertexIndices.push(idx);
    }
  }

  return { points, faceVertexCounts, faceVertexIndices };
}

/**
 * Authors the USD Physics articulation layer. Returns authoring warnings
 * (unresolvable gear/rack hinge references, mimic reference lookups, collision
 * approximation upgrades); the caller may fold them into its own warning list.
 */
export function writeMotionUsda(opts: WriteMotionUsdaOpts): string[] {
  const writer = new UsdaWriter();
  const authoringWarnings: string[] = [];
  const plan = opts.plan;
  const metersPerUnit = plan.metersPerUnit ?? 0.001;
  const robotName = safeUsdIdentifier(plan.name ?? "ProceduraRobot");
  const rootPath = `/World/${robotName}`;

  writer.line("#usda 1.0");
  writer.line("(");
  writer.indent();
  writer.line(`defaultPrim = "World"`);
  writer.line(`metersPerUnit = ${num(metersPerUnit)}`);
  writer.line(`kilogramsPerUnit = 1`);
  writer.line(`upAxis = "Z"`);
  writer.dedent();
  writer.line(")");
  writer.line("");

  if (opts.warnings && opts.warnings.length > 0) {
    for (const warning of opts.warnings) writer.line(`# warning: ${warning.replace(/\n/g, " ")}`);
    writer.line("");
  }

  // Isaac robot-schema metadata on the default prim so the asset passes the
  // sim-ready RobotSchema validation rules.
  openPrim(writer, `def Xform "World"`, ["IsaacRobotAPI"]);
  const linkTargets = opts.linkMeshes.map((lm) => `<${rootPath}/Links/${safeUsdIdentifier(lm.link.name)}>`);
  const jointTargets = [
    ...(plan.fixedBase && plan.rootLink ? [`<${rootPath}/Joints/world_to_${safeUsdIdentifier(plan.rootLink)}>`] : []),
    ...plan.joints.map((joint) => `<${rootPath}/Joints/${safeUsdIdentifier(joint.name)}>`),
  ];
  writer.line(`prepend rel isaac:physics:robotLinks = [${linkTargets.join(", ")}]`);
  writer.line(`prepend rel isaac:physics:robotJoints = [${jointTargets.join(", ")}]`);
  writer.line("");
  writer.open(`def PhysicsScene "physicsScene"`);
  writer.line(`vector3f physics:gravityDirection = (0, 0, -1)`);
  // Gravity is expressed in stage units: 9.81 m/s^2 -> 9810 mm/s^2 on a mm stage.
  writer.line(`float physics:gravityMagnitude = ${num(9.81 / metersPerUnit)}`);
  writer.close();
  writer.line("");

  const isArticulation = plan.links.length > 1;
  openPrim(
    writer,
    `def Xform "${robotName}"`,
    isArticulation ? ["PhysicsArticulationRootAPI", "PhysxArticulationAPI"] : [],
  );
  if (isArticulation) {
    writer.line(`bool physxArticulation:enabledSelfCollisions = ${(plan.selfCollision ?? false) ? "true" : "false"}`);
  }

  const materialLinks = plan.links.filter((link) => link.material !== undefined);
  if (materialLinks.length > 0) {
    writeMaterials(writer, materialLinks);
    writer.line("");
  }

  const linkOpts: LinkWriteOpts = {
    defaultCollision: plan.defaultCollision ?? "convexHull",
    rootPath,
    metersPerUnit,
    warnings: authoringWarnings,
  };
  writer.open(`def Scope "Links"`);
  opts.linkMeshes.forEach((linkMesh, index) => {
    writeLink(writer, linkMesh, index, linkOpts);
  });
  writer.close();
  writer.line("");

  const jointCtx: JointWriteContext = {
    rootPath,
    plan,
    jointByName: new Map(plan.joints.map((joint) => [joint.name, joint])),
    warnings: authoringWarnings,
  };
  writer.open(`def Scope "Joints"`);
  if (plan.fixedBase && plan.rootLink) {
    writeWorldFixedJoint(writer, plan.rootLink, rootPath);
  }
  for (const joint of plan.joints) {
    writeJoint(writer, joint, jointCtx);
  }
  writer.close();
  writer.close();
  writer.close();

  writeFileSync(opts.path, writer.toString(), "utf8");
  return authoringWarnings;
}

function writeMaterials(writer: UsdaWriter, links: MotionLinkSpec[]): void {
  writer.open(`def Scope "PhysicsMaterials"`);
  for (const link of links) {
    const material = link.material;
    if (!material) continue;
    openPrim(writer, `def Material "mat_${safeUsdIdentifier(link.name)}"`, ["PhysicsMaterialAPI"]);
    if (material.staticFriction !== undefined) writer.line(`float physics:staticFriction = ${num(material.staticFriction)}`);
    if (material.dynamicFriction !== undefined) writer.line(`float physics:dynamicFriction = ${num(material.dynamicFriction)}`);
    if (material.restitution !== undefined) writer.line(`float physics:restitution = ${num(material.restitution)}`);
    writer.close();
  }
  writer.close();
}

function writeLink(
  writer: UsdaWriter,
  linkMesh: MotionLinkMesh,
  index: number,
  opts: LinkWriteOpts,
): void {
  const link = linkMesh.link;
  const schemas = link.rigidBody === "static"
    ? []
    : ["PhysicsRigidBodyAPI", "PhysicsMassAPI"];

  openPrim(writer, `def Xform "${safeUsdIdentifier(link.name)}"`, schemas);
  if (link.rigidBody !== "static") {
    writer.line(`bool physics:rigidBodyEnabled = true`);
    writer.line(`rel physics:simulationOwner = </World/physicsScene>`);
    if (link.rigidBody === "kinematic") writer.line(`bool physics:kinematicEnabled = true`);
    // Isaac's sim-ready rules require explicit mass AND diagonal inertia on every
    // rigid body; fill physically-plausible bbox-based values when the plan omits them.
    const bbox = meshBBox(linkMesh.mesh);
    const effectiveMass = link.mass ?? densityDerivedMass(link.density, bbox, opts.metersPerUnit) ?? 1;
    writer.line(`float physics:mass = ${num(effectiveMass)}`);
    if (link.density !== undefined) {
      // kg/m^3 -> kg/unit^3 (informational; explicit mass wins in PhysX).
      writer.line(`float physics:density = ${numPrecise(link.density * opts.metersPerUnit ** 3)}`);
    }
    const centerOfMass = link.centerOfMass ?? bbox?.center;
    if (centerOfMass !== undefined) {
      // Model (stage) units.
      writer.line(`point3f physics:centerOfMass = ${tuple3(centerOfMass)}`);
    }
    if (link.diagonalInertia !== undefined) {
      // kg*m^2 -> kg*unit^2.
      const scale = 1 / (opts.metersPerUnit ** 2);
      const inertia = link.diagonalInertia;
      writer.line(
        `float3 physics:diagonalInertia = (${numPrecise(inertia[0] * scale)}, ${numPrecise(inertia[1] * scale)}, ${numPrecise(inertia[2] * scale)})`,
      );
    } else {
      // Solid-box approximation about the bbox centre, directly in stage units.
      const size = bbox?.size ?? [1, 1, 1];
      const ix = (effectiveMass / 12) * (size[1] ** 2 + size[2] ** 2);
      const iy = (effectiveMass / 12) * (size[0] ** 2 + size[2] ** 2);
      const iz = (effectiveMass / 12) * (size[0] ** 2 + size[1] ** 2);
      writer.line(
        `float3 physics:diagonalInertia = (${numPrecise(Math.max(ix, 1e-9))}, ${numPrecise(Math.max(iy, 1e-9))}, ${numPrecise(Math.max(iz, 1e-9))})`,
      );
    }
    if (link.principalAxes !== undefined) {
      writer.line(`quatf physics:principalAxes = ${quat(link.principalAxes)}`);
    }
  }

  const requested = link.collision ?? opts.defaultCollision;
  let approximation: MotionCollisionApproximation = requested;
  if (requested === "none" && (link.rigidBody ?? "dynamic") === "dynamic") {
    // Raw trimesh is not simulable on dynamic bodies in PhysX.
    approximation = "convexHull";
    opts.warnings.push(
      `link ${link.name}: collision "none" is not simulable on a dynamic body; authored "convexHull" instead`,
    );
  }

  const meshSchemas = ["PhysicsCollisionAPI", "PhysicsMeshCollisionAPI"];
  if (link.material !== undefined) meshSchemas.push("MaterialBindingAPI");
  openPrim(writer, `def Mesh "mesh"`, meshSchemas);
  writer.line(`uniform token subdivisionScheme = "none"`);
  writer.line(`bool physics:collisionEnabled = true`);
  writer.line(`uniform token physics:approximation = "${approximation}"`);
  if (link.material !== undefined) {
    writer.line(`rel material:binding:physics = <${opts.rootPath}/PhysicsMaterials/mat_${safeUsdIdentifier(link.name)}>`);
  }
  writer.line(`color3f[] primvars:displayColor = [${tuple3(linkDisplayColor(index))}]`);
  writer.line(`point3f[] points = ${points(linkMesh.mesh.points)}`);
  writer.line(`int[] faceVertexCounts = ${ints(linkMesh.mesh.faceVertexCounts)}`);
  writer.line(`int[] faceVertexIndices = ${ints(linkMesh.mesh.faceVertexIndices)}`);
  writer.close();
  writer.close();
}

interface MeshBBox {
  center: [number, number, number];
  size: [number, number, number];
}

function meshBBox(mesh: UsdMeshData): MeshBBox | undefined {
  if (mesh.points.length === 0) return undefined;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of mesh.points) {
    for (let i = 0; i < 3; i++) {
      if (p[i]! < min[i]!) min[i] = p[i]!;
      if (p[i]! > max[i]!) max[i] = p[i]!;
    }
  }
  return {
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

/** Mass in kg from density (kg/m^3) x bbox volume x 0.4 fill factor (matches the URDF exporter). */
function densityDerivedMass(
  density: number | undefined,
  bbox: MeshBBox | undefined,
  metersPerUnit: number,
): number | undefined {
  if (density === undefined || bbox === undefined) return undefined;
  const volumeM3 = bbox.size[0] * bbox.size[1] * bbox.size[2] * metersPerUnit ** 3;
  const mass = density * volumeM3 * 0.4;
  return mass > 0 ? mass : undefined;
}

function writeWorldFixedJoint(writer: UsdaWriter, rootLink: string, rootPath: string): void {
  writer.open(`def PhysicsFixedJoint "world_to_${safeUsdIdentifier(rootLink)}"`);
  writer.line(`rel physics:body1 = <${rootPath}/Links/${safeUsdIdentifier(rootLink)}>`);
  writeFrameAttrs(writer, {
    localPos0: [0, 0, 0],
    localRot0: [1, 0, 0, 0],
    localPos1: [0, 0, 0],
    localRot1: [1, 0, 0, 0],
  });
  writer.close();
}

function writeJoint(writer: UsdaWriter, joint: MotionJointSpec, ctx: JointWriteContext): void {
  if (joint.type === "gear" || joint.type === "rack_and_pinion") {
    writeGearOrRackJoint(writer, joint, ctx);
    return;
  }
  const primType = jointPrimType(joint.type);
  const schemas = jointApiSchemas(joint, ctx);
  openPrim(writer, `def ${primType} "${safeUsdIdentifier(joint.name)}"`, schemas);
  if (joint.parent) writer.line(`rel physics:body0 = <${ctx.rootPath}/Links/${safeUsdIdentifier(joint.parent)}>`);
  writer.line(`rel physics:body1 = <${ctx.rootPath}/Links/${safeUsdIdentifier(joint.child)}>`);
  writeFrameAttrs(writer, joint);
  if (joint.type === "revolute" || joint.type === "prismatic" || joint.type === "spherical") {
    writer.line(`uniform token physics:axis = "${joint.axis ?? "Z"}"`);
  }
  writeSpecializedJointAttrs(writer, joint);
  // A mimic follower is actuated by the constraint itself; an additional drive
  // (even a maxForce-only one) or a joint velocity limit fights the coupling
  // and stalls it short of the target, so both are suppressed on USD-coupled
  // followers (the URDF export still carries effort/velocity limits).
  const suppressDrive = mimicSupportedInUsd(joint, ctx, true);
  if (suppressDrive && (joint.drive !== undefined || joint.effortLimit !== undefined)) {
    ctx.warnings.push(
      `joint ${joint.name}: drive/effortLimit on a mimic follower is not authored in USD; the mimic constraint actuates it`,
    );
  }
  if (suppressDrive && (joint.velocityLimit !== undefined || joint.physx?.maxJointVelocity !== undefined)) {
    ctx.warnings.push(
      `joint ${joint.name}: maxJointVelocity on a mimic follower is not authored in USD; it stalls the coupling`,
    );
  }
  writeDriveAndLimitAttrs(writer, joint, ctx.plan.metersPerUnit ?? 0.001, suppressDrive);
  writeMimicAttrs(writer, joint, ctx);
  writePhysxAttrs(writer, joint, suppressDrive ? { skipMaxJointVelocity: true } : undefined);
  if (!suppressDrive) writeVelocityLimitAttr(writer, joint);
  writeCoupledMetadata(writer, joint);
  writer.close();
}

function writeGearOrRackJoint(writer: UsdaWriter, joint: MotionJointSpec, ctx: JointWriteContext): void {
  const isGear = joint.type === "gear";
  const primType = isGear ? "PhysxPhysicsGearJoint" : "PhysxPhysicsRackAndPinionJoint";
  const schemas = hasPhysxJointAttrs(joint) ? ["PhysxJointAPI"] : [];
  openPrim(writer, `def ${primType} "${safeUsdIdentifier(joint.name)}"`, schemas);
  if (joint.parent) writer.line(`rel physics:body0 = <${ctx.rootPath}/Links/${safeUsdIdentifier(joint.parent)}>`);
  writer.line(`rel physics:body1 = <${ctx.rootPath}/Links/${safeUsdIdentifier(joint.child)}>`);
  writeFrameAttrs(writer, joint);

  const hinge0 = resolveNamedJoint(joint.joint0 ?? joint.referenceJoint, joint, isGear ? "hinge0" : "hinge", ctx);
  const secondType = isGear ? "revolute" as const : "prismatic" as const;
  const hinge1 = joint.joint1 !== undefined
    ? resolveNamedJoint(joint.joint1, joint, isGear ? "hinge1" : "prismatic", ctx)
    : inferJointByChild(secondType, joint, ctx);

  if (isGear) {
    if (hinge0) writer.line(`rel physics:hinge0 = <${jointPrimPath(hinge0.name, ctx)}>`);
    if (hinge1) writer.line(`rel physics:hinge1 = <${jointPrimPath(hinge1.name, ctx)}>`);
    writer.line(`float physics:gearRatio = ${num(joint.ratio ?? 1)}`);
  } else {
    if (hinge0) writer.line(`rel physics:hinge = <${jointPrimPath(hinge0.name, ctx)}>`);
    if (hinge1) writer.line(`rel physics:prismatic = <${jointPrimPath(hinge1.name, ctx)}>`);
    writer.line(`float physics:ratio = ${num(joint.ratio ?? 1)}`);
  }

  // Gear/rack couplings close kinematic loops; they are never articulation joints.
  writer.line(`uniform bool physics:excludeFromArticulation = true`);
  writePhysxAttrs(writer, joint, { skipExcludeFromArticulation: true });
  writeVelocityLimitAttr(writer, joint);
  writeCoupledMetadata(writer, joint);
  writer.close();
}

function resolveNamedJoint(
  name: string | undefined,
  owner: MotionJointSpec,
  role: string,
  ctx: JointWriteContext,
): MotionJointSpec | undefined {
  if (name === undefined || name.length === 0) {
    ctx.warnings.push(`joint ${owner.name}: ${owner.type} has no joint reference for ${role}; rel not authored`);
    return undefined;
  }
  const found = ctx.jointByName.get(name);
  if (!found) {
    ctx.warnings.push(`joint ${owner.name}: ${role} reference joint not found in plan: ${name}`);
    return undefined;
  }
  return found;
}

function inferJointByChild(
  type: "revolute" | "prismatic",
  owner: MotionJointSpec,
  ctx: JointWriteContext,
): MotionJointSpec | undefined {
  const found = ctx.plan.joints.find((candidate) => candidate.type === type && candidate.child === owner.child);
  if (!found) {
    ctx.warnings.push(
      `joint ${owner.name}: could not infer a ${type} joint on child link ${owner.child} for the ${owner.type} coupling; rel not authored`,
    );
    return undefined;
  }
  return found;
}

function jointPrimPath(jointName: string, ctx: JointWriteContext): string {
  return `${ctx.rootPath}/Joints/${safeUsdIdentifier(jointName)}`;
}

function openPrim(writer: UsdaWriter, head: string, apiSchemas: string[]): void {
  if (apiSchemas.length === 0) {
    writer.open(head);
    return;
  }
  writer.line(`${head} (`);
  writer.indent();
  writer.line(`prepend apiSchemas = [${apiSchemas.map((schema) => `"${schema}"`).join(", ")}]`);
  writer.dedent();
  writer.line(")");
  writer.line("{");
  writer.indent();
}

function writeFrameAttrs(writer: UsdaWriter, joint: Pick<MotionJointSpec, "localPos0" | "localRot0" | "localPos1" | "localRot1">): void {
  writer.line(`point3f physics:localPos0 = ${tuple3(joint.localPos0 ?? [0, 0, 0])}`);
  writer.line(`quatf physics:localRot0 = ${quat(joint.localRot0 ?? [1, 0, 0, 0])}`);
  writer.line(`point3f physics:localPos1 = ${tuple3(joint.localPos1 ?? [0, 0, 0])}`);
  writer.line(`quatf physics:localRot1 = ${quat(joint.localRot1 ?? [1, 0, 0, 0])}`);
}

function writeSpecializedJointAttrs(writer: UsdaWriter, joint: MotionJointSpec): void {
  if (joint.type === "revolute" || joint.type === "prismatic") {
    const low = limitLow(joint.limit);
    const high = limitHigh(joint.limit);
    if (low !== undefined) writer.line(`float physics:lowerLimit = ${num(low)}`);
    if (high !== undefined) writer.line(`float physics:upperLimit = ${num(high)}`);
  }
  if (joint.type === "spherical" && joint.cone) {
    writer.line(`float physics:coneAngle0Limit = ${num(joint.cone.angle0)}`);
    writer.line(`float physics:coneAngle1Limit = ${num(joint.cone.angle1)}`);
  }
  if (joint.type === "distance") {
    if (joint.minDistance !== undefined) writer.line(`float physics:minDistance = ${num(joint.minDistance)}`);
    if (joint.maxDistance !== undefined) writer.line(`float physics:maxDistance = ${num(joint.maxDistance)}`);
    // Distance joints are never articulation joints; excluding them here keeps
    // the PhysX articulation parser from erroring on the closed loop.
    if (joint.physx?.excludeFromArticulation === undefined) {
      writer.line(`uniform bool physics:excludeFromArticulation = true`);
    }
  }
}

function writeDriveAndLimitAttrs(
  writer: UsdaWriter,
  joint: MotionJointSpec,
  metersPerUnit: number,
  suppressDrive = false,
): void {
  if (joint.type === "revolute") {
    if (!suppressDrive) writeDrive(writer, "angular", driveWithEffortLimit(joint), metersPerUnit);
    writeLimit(writer, "angular", joint.limit);
    writeJointState(writer, "angular");
  } else if (joint.type === "prismatic") {
    writeDrive(writer, "linear", driveWithEffortLimit(joint), metersPerUnit);
    writeLimit(writer, "linear", joint.limit);
    writeJointState(writer, "linear");
  } else if (joint.type === "d6") {
    for (const axis of ["transX", "transY", "transZ", "rotX", "rotY", "rotZ"] as const) {
      const spec: MotionD6AxisSpec | undefined = joint.d6?.[axis];
      writeDrive(writer, axis, spec?.drive, metersPerUnit);
      writeLimit(writer, axis, spec?.limit);
    }
  } else if (joint.type === "mimic") {
    // Legacy coupled-joint fallback: generic PhysicsJoint with an angular drive.
    writeDrive(writer, "angular", joint.drive, metersPerUnit);
  }
}

/** effortLimit fills in drive maxForce when the drive does not set one itself. */
function driveWithEffortLimit(joint: MotionJointSpec): MotionDriveSpec | undefined {
  if (joint.effortLimit !== undefined && joint.drive?.maxForce === undefined) {
    return { ...joint.drive, maxForce: joint.effortLimit };
  }
  return joint.drive;
}

/**
 * PhysicsDriveAPI is a multiple-apply schema with property prefix "drive", so
 * attributes are drive:<instance>:physics:*. Plan drive gains/forces are SI
 * (angular: N*m/rad, N*m*s/rad, N*m; linear: N/m, N*s/m, N); USD wants stage
 * units — angular torque = kg*unit^2/s^2 per DEGREE, linear force = kg*unit/s^2
 * (linear stiffness/damping are kg/s^2, kg/s: scale-free). Targets stay
 * unconverted (degrees / model units by convention).
 */
function writeDrive(
  writer: UsdaWriter,
  instance: string,
  drive: MotionDriveSpec | undefined,
  metersPerUnit: number,
): void {
  if (!drive) return;
  const angular = instance === "angular" || instance.startsWith("rot");
  const gainScale = angular ? (Math.PI / 180) / metersPerUnit ** 2 : 1;
  const forceScale = angular ? 1 / metersPerUnit ** 2 : 1 / metersPerUnit;
  if (drive.targetPosition !== undefined) writer.line(`float drive:${instance}:physics:targetPosition = ${num(drive.targetPosition)}`);
  if (drive.targetVelocity !== undefined) writer.line(`float drive:${instance}:physics:targetVelocity = ${num(drive.targetVelocity)}`);
  if (drive.stiffness !== undefined) writer.line(`float drive:${instance}:physics:stiffness = ${numPrecise(drive.stiffness * gainScale)}`);
  if (drive.damping !== undefined) writer.line(`float drive:${instance}:physics:damping = ${numPrecise(drive.damping * gainScale)}`);
  if (drive.maxForce !== undefined) writer.line(`float drive:${instance}:physics:maxForce = ${numPrecise(drive.maxForce * forceScale)}`);
  if (drive.type !== undefined) writer.line(`uniform token drive:${instance}:physics:type = "${drive.type}"`);
}

/**
 * Initial joint state: the assembled pose is by definition position 0 with the
 * mechanism at rest (drives pull toward their targets after the sim starts).
 */
function writeJointState(writer: UsdaWriter, instance: "angular" | "linear"): void {
  writer.line(`float state:${instance}:physics:position = 0`);
  writer.line(`float state:${instance}:physics:velocity = 0`);
}

/** PhysicsLimitAPI is a multiple-apply schema: attributes are limit:<instance>:physics:low/high. */
function writeLimit(writer: UsdaWriter, instance: string, limit: MotionLimitSpec | undefined): void {
  const low = limitLow(limit);
  const high = limitHigh(limit);
  if (low !== undefined) writer.line(`float limit:${instance}:physics:low = ${num(low)}`);
  if (high !== undefined) writer.line(`float limit:${instance}:physics:high = ${num(high)}`);
}

function writeMimicAttrs(writer: UsdaWriter, joint: MotionJointSpec, ctx: JointWriteContext): void {
  if (!joint.mimic || !mimicSupportedInUsd(joint, ctx, false)) return;
  const token = jointAxisToken(joint);
  const reference = ctx.jointByName.get(joint.mimic.referenceJoint);
  writer.line(`rel physxMimicJoint:${token}:referenceJoint = <${jointPrimPath(joint.mimic.referenceJoint, ctx)}>`);
  writer.line(`token physxMimicJoint:${token}:referenceJointAxis = "${jointAxisToken(reference)}"`);
  // PhysX formulates the coupling as position + gearing*reference + offset = 0,
  // i.e. follower = -gearing*reference - offset. The plan convention is
  // follower = gearing*reference + offset, so both coefficients are negated.
  writer.line(`float physxMimicJoint:${token}:gearing = ${num(-(joint.mimic.gearing ?? 1))}`);
  writer.line(`float physxMimicJoint:${token}:offset = ${num(-(joint.mimic.offset ?? 0))}`);
  // PhysX requires a positive natural frequency for the mimic constraint solver;
  // dampingRatio 1 = critically damped coupling.
  writer.line(`float physxMimicJoint:${token}:naturalFrequency = ${num(joint.mimic.naturalFrequency ?? 50)}`);
  writer.line(`float physxMimicJoint:${token}:dampingRatio = ${num(joint.mimic.dampingRatio ?? 1)}`);
}

/**
 * PhysxMimicJointAPI instances (and referenceJointAxis tokens) only cover the
 * angular DOFs rotX/rotY/rotZ, so prismatic followers or references cannot be
 * coupled in USD; the URDF export still carries the <mimic> tag for them.
 */
function mimicSupportedInUsd(joint: MotionJointSpec, ctx: JointWriteContext, silent: boolean): boolean {
  if (!joint.mimic) return false;
  const warn = (message: string) => {
    if (!silent) ctx.warnings.push(message);
  };
  if (joint.type !== "revolute") {
    warn(
      `joint ${joint.name}: PhysX mimic couplings only support revolute followers; ` +
      `the USD export omits this coupling (URDF still carries it)`,
    );
    return false;
  }
  const reference = ctx.jointByName.get(joint.mimic.referenceJoint);
  if (!reference) {
    warn(`joint ${joint.name}: mimic referenceJoint not found in plan: ${joint.mimic.referenceJoint}`);
    return false;
  }
  if (reference.type !== "revolute") {
    warn(
      `joint ${joint.name}: PhysX mimic couplings only support revolute reference joints; ` +
      `the USD export omits this coupling (URDF still carries it)`,
    );
    return false;
  }
  return true;
}

/** PhysX mimic axis token for a revolute/prismatic joint; defaults to rotZ. */
function jointAxisToken(joint: MotionJointSpec | undefined): string {
  if (!joint) return "rotZ";
  if (joint.type === "prismatic") return `trans${joint.axis ?? "Z"}`;
  if (joint.type === "revolute") return `rot${joint.axis ?? "Z"}`;
  return "rotZ";
}

function writePhysxAttrs(
  writer: UsdaWriter,
  joint: MotionJointSpec,
  opts?: { skipExcludeFromArticulation?: boolean; skipMaxJointVelocity?: boolean },
): void {
  const physx = joint.physx;
  if (!physx) return;
  if (physx.armature !== undefined) writer.line(`float physxJoint:armature = ${num(physx.armature)}`);
  if (physx.jointFriction !== undefined) writer.line(`float physxJoint:jointFriction = ${num(physx.jointFriction)}`);
  if (physx.maxJointVelocity !== undefined && !opts?.skipMaxJointVelocity) {
    writer.line(`float physxJoint:maxJointVelocity = ${num(physx.maxJointVelocity)}`);
  }
  if (physx.excludeFromArticulation !== undefined && !opts?.skipExcludeFromArticulation) {
    // excludeFromArticulation is a UsdPhysicsJoint built-in, not a PhysxJointAPI attr.
    writer.line(`uniform bool physics:excludeFromArticulation = ${physx.excludeFromArticulation ? "true" : "false"}`);
  }
}

/** PhysxJointAPI defines only armature/jointFriction/maxJointVelocity. */
function hasPhysxJointAttrs(joint: MotionJointSpec): boolean {
  return joint.physx?.armature !== undefined
    || joint.physx?.jointFriction !== undefined
    || joint.physx?.maxJointVelocity !== undefined
    || joint.velocityLimit !== undefined;
}

/** velocityLimit fills in physxJoint:maxJointVelocity when physx does not set one. */
function writeVelocityLimitAttr(writer: UsdaWriter, joint: MotionJointSpec): void {
  if (joint.velocityLimit !== undefined && joint.physx?.maxJointVelocity === undefined) {
    writer.line(`float physxJoint:maxJointVelocity = ${num(joint.velocityLimit)}`);
  }
}

function writeCoupledMetadata(writer: UsdaWriter, joint: MotionJointSpec): void {
  if (joint.type !== "gear" && joint.type !== "rack_and_pinion" && joint.type !== "mimic") return;
  writer.line(`custom string procedura:jointType = "${joint.type}"`);
  if (joint.referenceJoint) writer.line(`custom string procedura:referenceJoint = "${joint.referenceJoint}"`);
  if (joint.ratio !== undefined) writer.line(`custom float procedura:ratio = ${num(joint.ratio)}`);
}

function jointPrimType(type: MotionJointSpec["type"]): string {
  switch (type) {
    case "fixed": return "PhysicsFixedJoint";
    case "revolute": return "PhysicsRevoluteJoint";
    case "prismatic": return "PhysicsPrismaticJoint";
    case "spherical": return "PhysicsSphericalJoint";
    case "distance": return "PhysicsDistanceJoint";
    case "gear": return "PhysxPhysicsGearJoint";
    case "rack_and_pinion": return "PhysxPhysicsRackAndPinionJoint";
    case "d6":
    case "mimic":
      return "PhysicsJoint";
  }
}

function jointApiSchemas(joint: MotionJointSpec, ctx: JointWriteContext): string[] {
  const schemas: string[] = [];
  const suppressDrive = mimicSupportedInUsd(joint, ctx, true);
  if (joint.type === "revolute") {
    if (joint.limit) schemas.push("PhysicsLimitAPI:angular");
    if ((joint.drive || joint.effortLimit !== undefined) && !suppressDrive) schemas.push("PhysicsDriveAPI:angular");
    schemas.push("PhysicsJointStateAPI:angular");
  } else if (joint.type === "prismatic") {
    if (joint.limit) schemas.push("PhysicsLimitAPI:linear");
    if (joint.drive || joint.effortLimit !== undefined) schemas.push("PhysicsDriveAPI:linear");
    schemas.push("PhysicsJointStateAPI:linear");
  } else if (joint.type === "d6") {
    for (const axis of ["transX", "transY", "transZ", "rotX", "rotY", "rotZ"] as const) {
      const spec = joint.d6?.[axis];
      if (spec?.limit) schemas.push(`PhysicsLimitAPI:${axis}`);
      if (spec?.drive) schemas.push(`PhysicsDriveAPI:${axis}`);
    }
  } else if (joint.type === "mimic" && joint.drive) {
    schemas.push("PhysicsDriveAPI:angular");
  }
  if (suppressDrive) {
    schemas.push(`PhysxMimicJointAPI:${jointAxisToken(joint)}`);
    // Velocity limits are suppressed on mimic followers, so PhysxJointAPI is
    // only needed for the remaining attrs.
    if (joint.physx?.armature !== undefined || joint.physx?.jointFriction !== undefined) {
      schemas.push("PhysxJointAPI");
    }
  } else if (hasPhysxJointAttrs(joint)) {
    schemas.push("PhysxJointAPI");
  }
  return schemas;
}

function limitLow(limit: MotionLimitSpec | undefined): number | undefined {
  return limit?.lower ?? limit?.low;
}

function limitHigh(limit: MotionLimitSpec | undefined): number | undefined {
  return limit?.upper ?? limit?.high;
}

/** Deterministic per-link viewport colour: golden-angle hue stepped by index. */
function linkDisplayColor(index: number): [number, number, number] {
  const hue = (index * GOLDEN_ANGLE_DEG) % 360;
  return hslToRgb(hue, 0.65, 0.55);
}

function hslToRgb(hueDeg: number, saturation: number, lightness: number): [number, number, number] {
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hp = ((hueDeg % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = lightness - c / 2;
  return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
}

function points(values: Array<[number, number, number]>): string {
  return `[${values.map(tuple3).join(", ")}]`;
}

function ints(values: number[]): string {
  return `[${values.join(", ")}]`;
}

function tuple3(value: [number, number, number]): string {
  return `(${num(value[0])}, ${num(value[1])}, ${num(value[2])})`;
}

function quat(value: [number, number, number, number]): string {
  return `(${num(value[0])}, ${num(value[1])}, ${num(value[2])}, ${num(value[3])})`;
}

function num(value: number): string {
  if (!Number.isFinite(value)) return "0";
  // toFixed switches to exponent notation at |v| >= 1e21; the trailing-zero
  // strip would then corrupt the exponent, so emit those verbatim.
  if (Math.abs(value) >= 1e21) return String(value);
  const fixed = value.toFixed(POINT_PRECISION);
  return fixed.replace(/\.?0+$/, "") || "0";
}

/**
 * Formatter for converted physical quantities (density, inertia) that can be
 * far below the fixed-decimal precision of num(); keeps 6 significant digits.
 */
function numPrecise(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  if (Math.abs(value) >= 1e-3) return num(value);
  return String(Number(value.toPrecision(6)));
}

function pointKey(value: [number, number, number]): string {
  return `${num(value[0])}|${num(value[1])}|${num(value[2])}`;
}

function safeUsdIdentifier(value: string): string {
  const s = value.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+/, "");
  if (!s) return "prim";
  return /^[A-Za-z_]/.test(s) ? s : `p_${s}`;
}

class UsdaWriter {
  private lines: string[] = [];
  private level = 0;

  indent(): void { this.level += 1; }
  dedent(): void { this.level = Math.max(0, this.level - 1); }

  line(text = ""): void {
    if (!text) {
      this.lines.push("");
      return;
    }
    this.lines.push(`${"    ".repeat(this.level)}${text}`);
  }

  open(text: string): void {
    this.line(text);
    this.line("{");
    this.indent();
  }

  close(): void {
    this.dedent();
    this.line("}");
  }

  toString(): string {
    return this.lines.join("\n") + "\n";
  }
}
