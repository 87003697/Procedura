/**
 * CSG IR → GLSL sphere-tracing shader.
 *
 * Walks the flattened CSG tree from /api/csg and emits a `map(p)` function whose
 * value is a signed distance to the model. The algebra:
 *   union        = min(a,b)
 *   intersection = max(a,b)
 *   difference   = max(a, -b)
 *   transform    = inverse-transform the sample point (÷ largest singular value
 *                  for non-uniform scale, to stay conservative / Lipschitz-safe)
 *   hull         = approximated as a smooth-min blend (exact only for simple
 *                  cases; flagged via coverage upstream)
 *   rotate_extrude = revolve a 2D profile SDF at (length(p.xz), p.y)
 *   linear_extrude = extrude a 2D profile SDF along y
 *
 * 2D leaves (circle/square/polygon) get a 2D SDF used only inside an extrude.
 * The generator is defensive: unknown/empty nodes return a large distance so
 * they simply don't contribute. The result is exact for the analytic subset and
 * a labelled approximation otherwise — never the source of truth.
 */

import type { CsgNode } from "../../shared/types.ts";

const FAR = "1e9";
const MAX_EXPR_NODES = 6000; // GLSL safety ceiling; beyond this we bail to mesh

export interface GlslResult {
  ok: boolean;
  /** the full shader source up to and including `float map(vec3 p)` */
  mapBody: string;
  /** world-space (Y-up) bounding radius for camera + ray bounds */
  radius: number;
  /** world-space (Y-up) center of the model's bounding box */
  center: [number, number, number];
  reason?: string;
}

function invert(m: number[]): number[] | null {
  // general 4x4 inverse (Laplace); fine for the handful of transforms per node
  const inv = new Array(16).fill(0);
  const a = m;
  inv[0] = a[5]! * a[10]! * a[15]! - a[5]! * a[11]! * a[14]! - a[9]! * a[6]! * a[15]! + a[9]! * a[7]! * a[14]! + a[13]! * a[6]! * a[11]! - a[13]! * a[7]! * a[10]!;
  inv[4] = -a[4]! * a[10]! * a[15]! + a[4]! * a[11]! * a[14]! + a[8]! * a[6]! * a[15]! - a[8]! * a[7]! * a[14]! - a[12]! * a[6]! * a[11]! + a[12]! * a[7]! * a[10]!;
  inv[8] = a[4]! * a[9]! * a[15]! - a[4]! * a[11]! * a[13]! - a[8]! * a[5]! * a[15]! + a[8]! * a[7]! * a[13]! + a[12]! * a[5]! * a[11]! - a[12]! * a[7]! * a[9]!;
  inv[12] = -a[4]! * a[9]! * a[14]! + a[4]! * a[10]! * a[13]! + a[8]! * a[5]! * a[14]! - a[8]! * a[6]! * a[13]! - a[12]! * a[5]! * a[10]! + a[12]! * a[6]! * a[9]!;
  inv[1] = -a[1]! * a[10]! * a[15]! + a[1]! * a[11]! * a[14]! + a[9]! * a[2]! * a[15]! - a[9]! * a[3]! * a[14]! - a[13]! * a[2]! * a[11]! + a[13]! * a[3]! * a[10]!;
  inv[5] = a[0]! * a[10]! * a[15]! - a[0]! * a[11]! * a[14]! - a[8]! * a[2]! * a[15]! + a[8]! * a[3]! * a[14]! + a[12]! * a[2]! * a[11]! - a[12]! * a[3]! * a[10]!;
  inv[9] = -a[0]! * a[9]! * a[15]! + a[0]! * a[11]! * a[13]! + a[8]! * a[1]! * a[15]! - a[8]! * a[3]! * a[13]! - a[12]! * a[1]! * a[11]! + a[12]! * a[3]! * a[9]!;
  inv[13] = a[0]! * a[9]! * a[14]! - a[0]! * a[10]! * a[13]! - a[8]! * a[1]! * a[14]! + a[8]! * a[2]! * a[13]! + a[12]! * a[1]! * a[10]! - a[12]! * a[2]! * a[9]!;
  inv[2] = a[1]! * a[6]! * a[15]! - a[1]! * a[7]! * a[14]! - a[5]! * a[2]! * a[15]! + a[5]! * a[3]! * a[14]! + a[13]! * a[2]! * a[7]! - a[13]! * a[3]! * a[6]!;
  inv[6] = -a[0]! * a[6]! * a[15]! + a[0]! * a[7]! * a[14]! + a[4]! * a[2]! * a[15]! - a[4]! * a[3]! * a[14]! - a[12]! * a[2]! * a[7]! + a[12]! * a[3]! * a[6]!;
  inv[10] = a[0]! * a[5]! * a[15]! - a[0]! * a[7]! * a[13]! - a[4]! * a[1]! * a[15]! + a[4]! * a[3]! * a[13]! + a[12]! * a[1]! * a[7]! - a[12]! * a[3]! * a[5]!;
  inv[14] = -a[0]! * a[5]! * a[14]! + a[0]! * a[6]! * a[13]! + a[4]! * a[1]! * a[14]! - a[4]! * a[2]! * a[13]! - a[12]! * a[1]! * a[6]! + a[12]! * a[2]! * a[5]!;
  inv[3] = -a[1]! * a[6]! * a[11]! + a[1]! * a[7]! * a[10]! + a[5]! * a[2]! * a[11]! - a[5]! * a[3]! * a[10]! - a[9]! * a[2]! * a[7]! + a[9]! * a[3]! * a[6]!;
  inv[7] = a[0]! * a[6]! * a[11]! - a[0]! * a[7]! * a[10]! - a[4]! * a[2]! * a[11]! + a[4]! * a[3]! * a[10]! + a[8]! * a[2]! * a[7]! - a[8]! * a[3]! * a[6]!;
  inv[11] = -a[0]! * a[5]! * a[11]! + a[0]! * a[7]! * a[9]! + a[4]! * a[1]! * a[11]! - a[4]! * a[3]! * a[9]! - a[8]! * a[1]! * a[7]! + a[8]! * a[3]! * a[5]!;
  inv[15] = a[0]! * a[5]! * a[10]! - a[0]! * a[6]! * a[9]! - a[4]! * a[1]! * a[10]! + a[4]! * a[2]! * a[9]! + a[8]! * a[1]! * a[6]! - a[8]! * a[2]! * a[5]!;
  let det = a[0]! * inv[0] + a[1]! * inv[4] + a[2]! * inv[8] + a[3]! * inv[12];
  if (Math.abs(det) < 1e-12) return null;
  det = 1 / det;
  return inv.map((x) => x * det);
}

/** Largest singular value of the 3x3 linear part (≈ max scale factor). */
function maxScale(m: number[]): number {
  // column norms are a cheap upper bound on σ_max for typical CAD transforms
  const cols = [
    Math.hypot(m[0]!, m[4]!, m[8]!),
    Math.hypot(m[1]!, m[5]!, m[9]!),
    Math.hypot(m[2]!, m[6]!, m[10]!),
  ];
  return Math.max(1e-6, ...cols);
}

function glslMat(m: number[]): string {
  // GLSL mat4 is column-major; m is row-major → transpose on emit
  const t = [
    m[0], m[4], m[8], m[12],
    m[1], m[5], m[9], m[13],
    m[2], m[6], m[10], m[14],
    m[3], m[7], m[11], m[15],
  ];
  return `mat4(${t.map((x) => f(x!)).join(",")})`;
}

function f(n: number): string {
  if (!Number.isFinite(n)) return "0.0";
  const s = n.toFixed(5);
  return s.includes(".") ? s : s + ".0";
}

// ── hull-of-balls extraction ─────────────────────────────────────────────────
// OpenSCAD's dominant rounding idiom is hull() over circles (2D) or spheres
// (3D), often far apart. A smooth-min only blends shapes within ~k, so it tears
// far-apart shapes into disconnected blobs. The convex hull of balls in convex
// position (which hull() output always is) is EXACTLY the union of the pairwise
// round-cones (tapered capsules) between them — so we render hull that way.

const IDENT16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** row-major 4x4 multiply a*b. */
function mat4mul(a: number[], b: number[]): number[] {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[r * 4 + k]! * b[k * 4 + c]!;
      o[r * 4 + c] = s;
    }
  return o;
}

interface Ball3 {
  c: [number, number, number];
  r: number;
}
interface Ball2 {
  c: [number, number];
  r: number;
}

/** Extract a (center, radius) ball if `node` reduces to a transformed sphere. */
function extractBall3(node: CsgNode, m: number[]): Ball3 | null {
  switch (node.op) {
    case "transform":
      return extractBall3(node.child, mat4mul(m, node.m));
    case "group":
    case "union":
      return node.children.length === 1 ? extractBall3(node.children[0]!, m) : null;
    case "sphere":
      return { c: [m[3]!, m[7]!, m[11]!], r: node.r * maxScale(m) };
    default:
      return null;
  }
}

/** Extract a 2D disk if `node` reduces to a transformed circle/tiny square. */
function extractDisk2(node: CsgNode, m: number[]): Ball2 | null {
  switch (node.op) {
    case "transform":
      return extractDisk2(node.child, mat4mul(m, node.m));
    case "group":
    case "union":
      return node.children.length === 1 ? extractDisk2(node.children[0]!, m) : null;
    case "circle": {
      const sc = Math.max(Math.hypot(m[0]!, m[4]!), Math.hypot(m[1]!, m[5]!), 1e-6);
      return { c: [m[3]!, m[7]!], r: node.r * sc };
    }
    case "square": {
      // tiny squares act as hull points; use half the smaller side as radius
      const cx = m[0]! * (node.center ? 0 : node.size[0] / 2) + m[1]! * (node.center ? 0 : node.size[1] / 2) + m[3]!;
      const cy = m[4]! * (node.center ? 0 : node.size[0] / 2) + m[5]! * (node.center ? 0 : node.size[1] / 2) + m[7]!;
      return { c: [cx, cy], r: Math.max(0.0, Math.min(node.size[0], node.size[1]) / 2) };
    }
    default:
      return null;
  }
}

/** Flatten union/group children of a hull into a flat operand list. */
function hullOperands(node: CsgNode): CsgNode[] {
  if (node.op === "group" || node.op === "union") return node.children.flatMap(hullOperands);
  return [node];
}

// ── generator: one GLSL function per node (no statement-expressions in GLSL) ──

interface Gen {
  fns: string[];
  count: number;
  overflow: boolean;
  reach: number;
  polyArities: Set<number>;
  usesCap3: boolean;
  usesCap2: boolean;
}

/** Emit a GLSL function `float nodeN(vec3 p)` and return its name. */
function genNode(node: CsgNode, g: Gen): string {
  if (g.overflow) return "nodeFar";
  if (++g.count > MAX_EXPR_NODES) {
    g.overflow = true;
    return "nodeFar";
  }
  const id = g.count;
  const name = `node${id}`;
  let body: string;

  switch (node.op) {
    case "sphere":
      body = `return length(p)-${f(node.r)};`;
      g.reach = Math.max(g.reach, node.r);
      break;
    case "cube": {
      const h: [number, number, number] = [node.size[0] / 2, node.size[1] / 2, node.size[2] / 2];
      const pp = node.center ? "p" : `p-vec3(${f(h[0])},${f(h[1])},${f(h[2])})`;
      body = `return sdBox(${pp}, vec3(${f(h[0])},${f(h[1])},${f(h[2])}));`;
      g.reach = Math.max(g.reach, Math.hypot(...node.size));
      break;
    }
    case "cylinder": {
      const zc = node.center ? "p.z" : `p.z-${f(node.h / 2)}`;
      if (Math.abs(node.r1 - node.r2) < 1e-6) {
        body = `return sdCyl(vec3(p.xy, ${zc}), ${f(node.r1)}, ${f(node.h / 2)});`;
      } else {
        body = `return sdCone(vec3(p.xy, ${zc}), ${f(node.r1)}, ${f(node.r2)}, ${f(node.h / 2)});`;
      }
      g.reach = Math.max(g.reach, node.h + Math.max(node.r1, node.r2));
      break;
    }
    case "transform": {
      const inv = invert(node.m);
      if (!inv) {
        body = `return ${FAR};`;
        break;
      }
      const sigma = maxScale(node.m);
      const child = genNode(node.child, g);
      body = `vec3 q = (${glslMat(inv)} * vec4(p,1.0)).xyz; return ${child}(q)*${f(sigma)};`;
      g.reach += Math.hypot(node.m[3]!, node.m[7]!, node.m[11]!);
      break;
    }
    case "group":
    case "union": {
      const cs = node.children.map((c) => genNode(c, g));
      body = cs.length ? `return ${cs.map((c) => `${c}(p)`).reduce((a, b) => `min(${a}, ${b})`)};` : `return ${FAR};`;
      break;
    }
    case "intersection": {
      const cs = node.children.map((c) => genNode(c, g));
      body = cs.length ? `return ${cs.map((c) => `${c}(p)`).reduce((a, b) => `max(${a}, ${b})`)};` : `return ${FAR};`;
      break;
    }
    case "difference": {
      const cs = node.children.map((c) => genNode(c, g));
      if (!cs.length) {
        body = `return ${FAR};`;
        break;
      }
      const [first, ...rest] = cs;
      const expr = rest.reduce((acc, r) => `max(${acc}, -${r}(p))`, `${first}(p)`);
      body = `return ${expr};`;
      break;
    }
    case "hull": {
      // Prefer exact hull-of-spheres (union of pairwise round-cones); only fall
      // back to smooth-min when an operand isn't a sphere.
      const ops = node.children.flatMap(hullOperands);
      const balls = ops.map((o) => extractBall3(o, IDENT16));
      if (ops.length >= 2 && ops.length <= 16 && balls.every((b): b is Ball3 => b !== null)) {
        g.usesCap3 = true;
        const segs: string[] = [];
        for (let i = 0; i < balls.length; i++)
          for (let j = i + 1; j < balls.length; j++) {
            const a = balls[i]!;
            const b = balls[j]!;
            segs.push(
              `rcone(p, vec3(${f(a.c[0])},${f(a.c[1])},${f(a.c[2])}), vec3(${f(b.c[0])},${f(b.c[1])},${f(b.c[2])}), ${f(a.r)}, ${f(b.r)})`,
            );
          }
        body = `return ${segs.reduce((x, y) => `min(${x}, ${y})`)};`;
      } else {
        const cs = node.children.map((c) => genNode(c, g));
        body = cs.length
          ? `return ${cs.map((c) => `${c}(p)`).reduce((a, b) => `smin(${a}, ${b}, 1.5)`)};`
          : `return ${FAR};`;
      }
      break;
    }
    case "rotate_extrude": {
      const prof = profileFn(node.child, g);
      body = prof
        ? `return ${prof}(vec2(length(p.xy), p.z));`
        : `return ${FAR};`;
      break;
    }
    case "linear_extrude": {
      const prof = profileFn(node.child, g);
      const zc = node.center ? "p.z" : `p.z-${f(node.height / 2)}`;
      body = prof
        ? `float d2 = ${prof}(p.xy); vec2 w = vec2(d2, abs(${zc})-${f(node.height / 2)}); return min(max(w.x,w.y),0.0)+length(max(w,0.0));`
        : `return ${FAR};`;
      break;
    }
    default:
      body = `return ${FAR};`;
  }
  g.fns.push(`float ${name}(vec3 p){ ${body} }`);
  return name;
}

/** Emit a GLSL `float profN(vec2 q)` for a 2D profile, return its name. */
function profileFn(node: CsgNode, g: Gen): string | null {
  const expr = profExpr(node, g, "q");
  if (expr == null) return null;
  const name = `prof${++g.count}`;
  g.fns.push(`float ${name}(vec2 q){ return ${expr}; }`);
  return name;
}

/** 2D profile SDF as an expression in the point `pt` (a vec2 expression). The
 *  point is threaded explicitly so nested transforms compose correctly. */
function profExpr(node: CsgNode, g: Gen, pt: string): string | null {
  switch (node.op) {
    case "circle":
      return `length(${pt})-${f(node.r)}`;
    case "square": {
      const off = node.center ? pt : `${pt}-vec2(${f(node.size[0] / 2)},${f(node.size[1] / 2)})`;
      return `sdBox2(${off}, vec2(${f(node.size[0] / 2)},${f(node.size[1] / 2)}))`;
    }
    case "polygon": {
      const k = node.points.length;
      if (k < 3 || k > 48) return null;
      g.polyArities.add(k);
      const pts = node.points.map((p) => `vec2(${f(p[0])},${f(p[1])})`).join(",");
      return `sdPoly${k}(${pt}, ${pts})`;
    }
    case "group":
    case "union": {
      const cs = node.children.map((c) => profExpr(c, g, pt)).filter((x): x is string => x != null);
      return cs.length ? cs.reduce((a, b) => `min(${a},${b})`) : null;
    }
    case "intersection": {
      const cs = node.children.map((c) => profExpr(c, g, pt)).filter((x): x is string => x != null);
      return cs.length ? cs.reduce((a, b) => `max(${a},${b})`) : null;
    }
    case "difference": {
      const cs = node.children.map((c) => profExpr(c, g, pt)).filter((x): x is string => x != null);
      if (!cs.length) return null;
      const [first, ...rest] = cs;
      return rest.reduce((acc, r) => `max(${acc}, -(${r}))`, `(${first})`);
    }
    case "hull": {
      // Exact 2D hull-of-disks = union of pairwise round-cones (this is the
      // mug-wall idiom: hull(circle, circle, tiny-square, tiny-square)). Far
      // -apart operands that smin would tear apart connect correctly here.
      const ops = node.children.flatMap(hullOperands);
      const disks = ops.map((o) => extractDisk2(o, IDENT16));
      if (ops.length >= 2 && ops.length <= 16 && disks.every((d): d is Ball2 => d !== null)) {
        g.usesCap2 = true;
        const segs: string[] = [];
        for (let i = 0; i < disks.length; i++)
          for (let j = i + 1; j < disks.length; j++) {
            const a = disks[i]!;
            const b = disks[j]!;
            segs.push(
              `rcone2(${pt}, vec2(${f(a.c[0])},${f(a.c[1])}), vec2(${f(b.c[0])},${f(b.c[1])}), ${f(a.r)}, ${f(b.r)})`,
            );
          }
        return segs.reduce((x, y) => `min(${x},${y})`);
      }
      const cs = node.children.map((c) => profExpr(c, g, pt)).filter((x): x is string => x != null);
      return cs.length ? cs.reduce((a, b) => `smin(${a},${b},0.4)`) : null;
    }
    case "transform": {
      // A 2D profile may carry a multmatrix (rim circles are translated). Apply
      // the inverse affine (2x2 + translation) to the point before the child.
      const inv = invert(node.m);
      if (!inv) return null;
      const qx = `(${f(inv[0]!)}*(${pt}).x+${f(inv[1]!)}*(${pt}).y+${f(inv[3]!)})`;
      const qy = `(${f(inv[4]!)}*(${pt}).x+${f(inv[5]!)}*(${pt}).y+${f(inv[7]!)})`;
      return profExpr(node.child, g, `vec2(${qx},${qy})`);
    }
    default:
      return null;
  }
}

/** GLSL helpers shared by all generated shaders. */
function helpers(polyArities: Set<number>, usesCap3: boolean, usesCap2: boolean): string {
  const polys = [...polyArities]
    .map((k) => {
      const args = Array.from({ length: k }, (_, i) => `vec2 v${i}`).join(", ");
      // generic polygon distance (IQ), unrolled per-arity
      const lines: string[] = [`float d = dot(q-v0, q-v0); float s = 1.0; vec2 e, w; float b;`];
      for (let i = 0; i < k; i++) {
        const j = (i + 1) % k;
        lines.push(
          `e = v${j}-v${i}; w = q-v${i}; b = clamp(dot(w,e)/max(dot(e,e),1e-9),0.0,1.0);` +
            ` vec2 pq${i} = w - e*b; d = min(d, dot(pq${i},pq${i}));` +
            ` bvec3 c${i} = bvec3(q.y>=v${i}.y, q.y<v${j}.y, e.x*w.y>e.y*w.x);` +
            ` if(all(c${i})||all(not(c${i}))) s=-s;`,
        );
      }
      lines.push(`return s*sqrt(d);`);
      return `float sdPoly${k}(vec2 q, ${args}){ ${lines.join(" ")} }`;
    })
    .join("\n");
  // 3D round-cone (tapered capsule) between balls a,b — IQ. Union of these over
  // a hull's ball pairs == the convex hull of the balls.
  const cap3 = usesCap3
    ? `
float rcone(vec3 p, vec3 a, vec3 b, float r1, float r2){
  vec3  ba = b - a; float l2 = dot(ba,ba); float rr = r1 - r2;
  float a2 = l2 - rr*rr; float il2 = 1.0/max(l2,1e-9);
  vec3  pa = p - a; float y = dot(pa,ba); float z = y - l2;
  vec3  xv = pa*l2 - ba*y; float x2 = dot(xv,xv);
  float y2 = y*y*l2; float z2 = z*z*l2;
  float k = sign(rr)*rr*rr*x2;
  if(sign(z)*a2*z2 > k) return sqrt(x2+z2)*il2 - r2;
  if(sign(y)*a2*y2 < k) return sqrt(x2+y2)*il2 - r1;
  return (sqrt(x2*a2*il2)+y*rr)*il2 - r1;
}`
    : "";
  // 2D round-cone, same algebra in the plane (used inside revolve/extrude).
  const cap2 = usesCap2
    ? `
float rcone2(vec2 p, vec2 a, vec2 b, float r1, float r2){
  vec2  ba = b - a; float l2 = dot(ba,ba); float rr = r1 - r2;
  float a2 = l2 - rr*rr; float il2 = 1.0/max(l2,1e-9);
  vec2  pa = p - a; float y = dot(pa,ba); float z = y - l2;
  vec2  xv = pa*l2 - ba*y; float x2 = dot(xv,xv);
  float y2 = y*y*l2; float z2 = z*z*l2;
  float k = sign(rr)*rr*rr*x2;
  if(sign(z)*a2*z2 > k) return sqrt(x2+z2)*il2 - r2;
  if(sign(y)*a2*y2 < k) return sqrt(x2+y2)*il2 - r1;
  return (sqrt(x2*a2*il2)+y*rr)*il2 - r1;
}`
    : "";
  return `
float sdBox(vec3 p, vec3 b){ vec3 q=abs(p)-b; return length(max(q,0.0))+min(max(q.x,max(q.y,q.z)),0.0); }
float sdBox2(vec2 p, vec2 b){ vec2 q=abs(p)-b; return length(max(q,0.0))+min(max(q.x,q.y),0.0); }
float sdCyl(vec3 p, float r, float h){ vec2 d=vec2(length(p.xy)-r, abs(p.z)-h); return min(max(d.x,d.y),0.0)+length(max(d,0.0)); }
float sdCone(vec3 p, float r1, float r2, float h){ float rr=length(p.xy); float t=clamp((p.z+h)/(2.0*h),0.0,1.0); float r=mix(r1,r2,t); vec2 d=vec2(rr-r, abs(p.z)-h); return min(max(d.x,d.y),0.0)+length(max(d,0.0)); }
float smin(float a, float b, float k){ float h=clamp(0.5+0.5*(b-a)/k,0.0,1.0); return mix(b,a,h)-k*h*(1.0-h); }
float nodeFar(vec3 p){ return ${FAR}; }${cap3}${cap2}
${polys}
`;
}

// ── bounding box (model Z-up space) — for camera framing, not rendering ───────

const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** row-major 4x4 multiply: a*b. */
function mul4(a: number[], b: number[]): number[] {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[r * 4 + k]! * b[k * 4 + c]!;
      o[r * 4 + c] = s;
    }
  return o;
}

interface Box {
  min: [number, number, number];
  max: [number, number, number];
}

function emptyBox(): Box {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}
function expand(b: Box, p: [number, number, number]) {
  for (let i = 0; i < 3; i++) {
    if (p[i]! < b.min[i]!) b.min[i] = p[i]!;
    if (p[i]! > b.max[i]!) b.max[i] = p[i]!;
  }
}
function valid(b: Box): boolean {
  return b.min.every(Number.isFinite) && b.max.every(Number.isFinite) && b.max[0]! >= b.min[0]!;
}

/** Transform the 8 corners of a local [lo,hi] AABB by row-major M into world b. */
function addBox(b: Box, m: number[], lo: [number, number, number], hi: [number, number, number]) {
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? hi[0]! : lo[0]!;
    const y = i & 2 ? hi[1]! : lo[1]!;
    const z = i & 4 ? hi[2]! : lo[2]!;
    expand(b, [
      m[0]! * x + m[1]! * y + m[2]! * z + m[3]!,
      m[4]! * x + m[5]! * y + m[6]! * z + m[7]!,
      m[8]! * x + m[9]! * y + m[10]! * z + m[11]!,
    ]);
  }
}

/** 2D bbox of a profile (x,y) under accumulated 4x4 M (z treated as 0). */
function bounds2(node: CsgNode, m: number[], out: { lo: [number, number]; hi: [number, number] }) {
  const add = (lx: number, ly: number, hx: number, hy: number) => {
    for (let i = 0; i < 4; i++) {
      const x = i & 1 ? hx : lx;
      const y = i & 2 ? hy : ly;
      const wx = m[0]! * x + m[1]! * y + m[3]!;
      const wy = m[4]! * x + m[5]! * y + m[7]!;
      if (wx < out.lo[0]) out.lo[0] = wx;
      if (wy < out.lo[1]) out.lo[1] = wy;
      if (wx > out.hi[0]) out.hi[0] = wx;
      if (wy > out.hi[1]) out.hi[1] = wy;
    }
  };
  switch (node.op) {
    case "circle":
      add(-node.r, -node.r, node.r, node.r);
      break;
    case "square": {
      const [w, h] = node.size;
      if (node.center) add(-w / 2, -h / 2, w / 2, h / 2);
      else add(0, 0, w, h);
      break;
    }
    case "polygon":
      for (const p of node.points) add(p[0], p[1], p[0], p[1]);
      break;
    case "transform":
      bounds2(node.child, mul4(m, node.m), out);
      break;
    case "group":
    case "union":
    case "intersection":
    case "difference":
    case "hull":
      for (const c of node.children) bounds2(c, m, out);
      break;
  }
}

function profileBox(node: CsgNode): { lo: [number, number]; hi: [number, number] } | null {
  const out = { lo: [Infinity, Infinity] as [number, number], hi: [-Infinity, -Infinity] as [number, number] };
  bounds2(node, IDENT, out);
  return Number.isFinite(out.lo[0]) && out.hi[0] >= out.lo[0] ? out : null;
}

/** Accumulate the model-space (Z-up) AABB of the CSG tree. */
function bounds3(node: CsgNode, m: number[], b: Box): void {
  switch (node.op) {
    case "sphere":
      addBox(b, m, [-node.r, -node.r, -node.r], [node.r, node.r, node.r]);
      break;
    case "cube": {
      const [w, d, h] = node.size;
      if (node.center) addBox(b, m, [-w / 2, -d / 2, -h / 2], [w / 2, d / 2, h / 2]);
      else addBox(b, m, [0, 0, 0], [w, d, h]);
      break;
    }
    case "cylinder": {
      const r = Math.max(node.r1, node.r2);
      if (node.center) addBox(b, m, [-r, -r, -node.h / 2], [r, r, node.h / 2]);
      else addBox(b, m, [-r, -r, 0], [r, r, node.h]);
      break;
    }
    case "transform":
      bounds3(node.child, mul4(m, node.m), b);
      break;
    case "rotate_extrude": {
      const pb = profileBox(node.child);
      if (pb) {
        const R = Math.max(Math.abs(pb.lo[0]), Math.abs(pb.hi[0]));
        addBox(b, m, [-R, -R, pb.lo[1]], [R, R, pb.hi[1]]);
      }
      break;
    }
    case "linear_extrude": {
      const pb = profileBox(node.child);
      if (pb) {
        const z0 = node.center ? -node.height / 2 : 0;
        const z1 = node.center ? node.height / 2 : node.height;
        addBox(b, m, [pb.lo[0], pb.lo[1], z0], [pb.hi[0], pb.hi[1], z1]);
      }
      break;
    }
    case "group":
    case "union":
    case "intersection":
    case "hull":
    case "minkowski":
      for (const c of node.children) bounds3(c, m, b);
      break;
    case "difference":
      // bbox is bounded by the first child (the positive solid)
      if (node.children[0]) bounds3(node.children[0], m, b);
      break;
  }
}

export function generateSdf(tree: CsgNode): GlslResult {
  const g: Gen = {
    fns: [],
    count: 0,
    overflow: false,
    reach: 0,
    polyArities: new Set(),
    usesCap3: false,
    usesCap2: false,
  };
  const root = genNode(tree, g);
  if (g.overflow) {
    return {
      ok: false,
      mapBody: "",
      radius: 0,
      center: [0, 0, 0],
      reason: `model too large for SDF preview (>${MAX_EXPR_NODES} nodes)`,
    };
  }

  // Real model-space (Z-up) AABB → world (Y-up) center + radius for framing.
  const box = emptyBox();
  bounds3(tree, IDENT, box);
  let center: [number, number, number] = [0, 0, 0];
  let radius: number;
  if (valid(box)) {
    const cm: [number, number, number] = [
      (box.min[0]! + box.max[0]!) / 2,
      (box.min[1]! + box.max[1]!) / 2,
      (box.min[2]! + box.max[2]!) / 2,
    ];
    const diag = Math.hypot(box.max[0]! - box.min[0]!, box.max[1]! - box.min[1]!, box.max[2]! - box.min[2]!);
    radius = Math.max(1, diag / 2);
    // model Z-up → world Y-up: (x,y,z) → (x, z, -y)
    center = [cm[0], cm[2], -cm[1]];
  } else {
    radius = Math.max(1, g.reach * 1.6); // fallback if bbox couldn't be computed
  }

  const src = `${helpers(g.polyArities, g.usesCap3, g.usesCap2)}\n${g.fns.join("\n")}\nfloat map(vec3 p){ return ${root}(p); }`;
  return { ok: true, mapBody: src, radius, center };
}
