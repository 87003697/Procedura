import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Bounds, OrbitControls, useBounds } from "@react-three/drei";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import * as THREE from "three";
import { motion, useReducedMotion } from "motion/react";
import {
  ArrowsClockwiseIcon as ArrowsClockwise,
  ArrowsCounterClockwiseIcon as ArrowsCounterClockwise,
  CubeIcon,
  CubeTransparentIcon as CubeTransparent,
} from "@phosphor-icons/react";

import { fileUrl } from "../api.ts";
import { cx, ErrorState, Spinner } from "./ui.tsx";

/** A mid grey reads against the light stage and still shows its facets. */
const MODEL_COLOR = "#b4bac2";
const MODEL_DIM_COLOR = "#d9dce0";

interface Stats {
  triangles: number;
  size: [number, number, number];
  /** Per-material groups in a painted model (0 for a plain mesh). */
  materials: number;
}

/** What the viewer is showing: one merged geometry (plain mesh, highlightable)
 *  or a whole Group carrying per-part materials (the painted deliverable). */
type Loaded =
  | { kind: "geometry"; geometry: THREE.BufferGeometry }
  | { kind: "group"; group: THREE.Group };

function statsOfGeometry(geo: THREE.BufferGeometry): Stats {
  geo.computeBoundingBox();
  const bb = geo.boundingBox ?? new THREE.Box3();
  const s = new THREE.Vector3();
  bb.getSize(s);
  const pos = geo.getAttribute("position");
  return { triangles: pos ? pos.count / 3 : 0, size: [s.x, s.y, s.z], materials: 0 };
}

function statsOfGroup(group: THREE.Group): Stats {
  const box = new THREE.Box3().setFromObject(group);
  const s = new THREE.Vector3();
  box.getSize(s);
  let tris = 0;
  const mats = new Set<string>();
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      const m = o as THREE.Mesh;
      const pos = m.geometry.getAttribute("position");
      tris += pos ? pos.count / 3 : 0;
      const ms = Array.isArray(m.material) ? m.material : [m.material];
      for (const mm of ms) mats.add(mm.name || mm.uuid);
    }
  });
  return { triangles: tris, size: [s.x, s.y, s.z], materials: mats.size };
}

/** Parse an MTL sidecar into PBR materials. Only the keys the pipeline writes
 *  matter: Kd (sRGB base colour), Pr (roughness), Pm (metalness), d (alpha).
 *  Three's MTLLoader would hand back Phong and drop Pr/Pm, so we build the
 *  standard materials ourselves. */
function parseMtl(text: string): Map<string, THREE.MeshStandardMaterial> {
  const out = new Map<string, THREE.MeshStandardMaterial>();
  let cur: THREE.MeshStandardMaterial | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [k, ...rest] = line.split(/\s+/);
    if (k === "newmtl") {
      cur = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.6, metalness: 0 });
      cur.name = rest.join(" ");
      out.set(cur.name, cur);
    } else if (!cur) {
      continue;
    } else if (k === "Kd" && rest.length >= 3) {
      cur.color.setRGB(Number(rest[0]), Number(rest[1]), Number(rest[2]), THREE.SRGBColorSpace);
    } else if (k === "Pr") {
      cur.roughness = THREE.MathUtils.clamp(Number(rest[0]), 0.05, 1);
    } else if (k === "Pm") {
      cur.metalness = THREE.MathUtils.clamp(Number(rest[0]), 0, 1);
    } else if (k === "d") {
      const a = Number(rest[0]);
      if (Number.isFinite(a) && a < 1) {
        cur.transparent = true;
        cur.opacity = a;
      }
    }
  }
  return out;
}

/** Strip an OBJ mesh's geometry down to positions so meshes from one file
 *  always merge (OBJLoader only adds normal/uv attributes when the file has
 *  them, and the merge refuses mismatched attribute sets). */
function positionsOnly(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const pos = geo.getAttribute("position");
  g.setAttribute("position", pos.clone());
  return g;
}

async function fetchText(path: string, signal: AbortSignal): Promise<string> {
  const r = await fetch(fileUrl(path), { signal });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.text();
}

async function fetchBuffer(path: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const r = await fetch(fileUrl(path), { signal });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.arrayBuffer();
}

/** Load a mesh artifact by extension. A `.obj` with an `mtlPath` becomes a
 *  Group with one standard material per `usemtl`; anything else collapses to a
 *  single geometry. Models are Z-up (OpenSCAD / Blender); three is Y-up. */
async function loadModel(path: string, mtlPath: string | null, signal: AbortSignal): Promise<Loaded> {
  // A `?v=` cache-buster may ride along on live paths; it is not part of the extension.
  const ext = path.split("?")[0]!.toLowerCase().split(".").pop();
  if (ext === "stl") {
    const geo = new STLLoader().parse(await fetchBuffer(path, signal));
    geo.rotateX(-Math.PI / 2);
    return { kind: "geometry", geometry: geo };
  }
  if (ext !== "obj") throw new Error(`unsupported mesh type .${ext}`);

  const [objText, mtlText] = await Promise.all([
    fetchText(path, signal),
    mtlPath ? fetchText(mtlPath, signal).catch(() => null) : Promise.resolve(null),
  ]);
  const group = new OBJLoader().parse(objText);

  if (mtlText) {
    const mats = parseMtl(mtlText);
    const fallback = new THREE.MeshStandardMaterial({ color: MODEL_COLOR, flatShading: true, roughness: 0.62 });
    group.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh) return;
      const m = o as THREE.Mesh;
      // OBJLoader names each placeholder material after its `usemtl`.
      const swap = (mm: THREE.Material) => mats.get(mm.name) ?? fallback;
      m.material = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material);
      m.geometry.computeVertexNormals();
    });
    group.rotateX(-Math.PI / 2);
    group.updateMatrixWorld(true);
    return { kind: "group", group };
  }

  const parts: THREE.BufferGeometry[] = [];
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) parts.push(positionsOnly((o as THREE.Mesh).geometry));
  });
  if (parts.length === 0) throw new Error("OBJ has no faces");
  const merged = parts.length === 1 ? parts[0]! : mergeGeometries(parts, false);
  if (!merged) throw new Error("could not merge OBJ groups");
  merged.rotateX(-Math.PI / 2);
  return { kind: "geometry", geometry: merged };
}

function Model({
  geometry,
  wireframe,
  dimmed = false,
}: {
  geometry: THREE.BufferGeometry;
  wireframe: boolean;
  dimmed?: boolean;
}) {
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(dimmed ? MODEL_DIM_COLOR : MODEL_COLOR),
        metalness: 0.08,
        roughness: dimmed ? 0.9 : 0.58,
        flatShading: true,
        wireframe,
        transparent: dimmed,
        opacity: dimmed ? 0.5 : 1,
      }),
    [wireframe, dimmed],
  );
  useEffect(() => () => material.dispose(), [material]);
  return <mesh geometry={geometry} material={material} />;
}

/** The painted deliverable, rendered with its own per-part materials. */
function PaintedModel({ group, wireframe }: { group: THREE.Group; wireframe: boolean }) {
  useEffect(() => {
    group.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh) return;
      const ms = (o as THREE.Mesh).material;
      for (const m of Array.isArray(ms) ? ms : [ms]) (m as THREE.MeshStandardMaterial).wireframe = wireframe;
    });
  }, [group, wireframe]);
  return <primitive object={group} />;
}

// Accent-glowing overlay of the parameter's affected part meshes, drawn on top
// of the dimmed base mesh. Geometries are cached by path (re-touch is instant).
const partGeoCache = new Map<string, THREE.BufferGeometry>();

function HighlightParts({ paths, offset }: { paths: string[]; offset: [number, number, number] }) {
  const [geos, setGeos] = useState<THREE.BufferGeometry[]>([]);
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color("#3d9bff"),
        emissive: new THREE.Color("#0a5bcc"),
        emissiveIntensity: 0.45,
        metalness: 0.1,
        roughness: 0.45,
        flatShading: true,
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);

  useEffect(() => {
    let cancelled = false;
    const ctrls: AbortController[] = [];
    Promise.all(
      paths.map(async (p) => {
        const cached = partGeoCache.get(p);
        if (cached) return cached;
        const ctrl = new AbortController();
        ctrls.push(ctrl);
        const buf = await fetchBuffer(p, ctrl.signal);
        // Keep parts in the SAME raw (rotated, un-centered) world space as the
        // base mesh before its centering shift; the group below applies the
        // base's offset so parts land in their true positions on the model.
        const geo = new STLLoader().parse(buf);
        geo.rotateX(-Math.PI / 2);
        geo.computeVertexNormals();
        partGeoCache.set(p, geo);
        return geo;
      }),
    )
      .then((gs) => !cancelled && setGeos(gs.filter(Boolean) as THREE.BufferGeometry[]))
      .catch(() => {
        /* a missing part just isn't highlighted */
      });
    return () => {
      cancelled = true;
      ctrls.forEach((c) => c.abort());
    };
  }, [paths]);

  return (
    <group position={[-offset[0], -offset[1], -offset[2]]}>
      {geos.map((g, i) => (
        <mesh key={i} geometry={g} material={material} renderOrder={2} />
      ))}
    </group>
  );
}

// When `fitTrigger` changes, refresh bounds + clip planes AND reframe the
// camera. When `clipTrigger` changes (a keep-view swap), refresh bounds + clip
// only — so a resized model never clips, but the camera stays where the user
// left it. `bounds` is intentionally omitted from the deps: it is a stable
// imperative handle and including it would refit on unrelated re-renders.
function Refitter({ fitTrigger, clipTrigger }: { fitTrigger: number; clipTrigger: number }) {
  const bounds = useBounds();
  useEffect(() => {
    bounds.refresh().clip().fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitTrigger]);
  useEffect(() => {
    if (clipTrigger > 0) bounds.refresh().clip();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipTrigger]);
  return null;
}

export function MeshViewer({
  path,
  mtlPath = null,
  className,
  keepView = false,
  previewMode = false,
  highlightPaths,
  keepLastOnError = false,
}: {
  /** `.obj` or `.stl`, root-relative. */
  path: string | null;
  /** Material sidecar for a painted `.obj`; renders per-part colours. */
  mtlPath?: string | null;
  className?: string;
  /** When true, swapping `path` updates the mesh in place without reframing the
   *  camera (used during live customizer drags). The first mesh still fits. */
  keepView?: boolean;
  /** True while the current `path` is a coarse drag preview. A full-quality
   *  (non-preview) swap may reframe if the model drifted far out of view; a
   *  preview swap never does (so dragging stays steady). */
  previewMode?: boolean;
  /** When set (non-empty), the base mesh dims and these per-part STL paths are
   *  overlaid in the accent colour — the geometry a touched parameter affects. */
  highlightPaths?: string[];
  /** Live previews reload a file that is being rewritten; a half-written read
   *  should keep showing the last good model instead of an error. */
  keepLastOnError?: boolean;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [wireframe, setWireframe] = useState(false);
  const [spin, setSpin] = useState(false);
  const [refit, setRefit] = useState(0);
  const [clipTick, setClipTick] = useState(0);
  const framedRef = useRef(false);
  const framedExtentRef = useRef(0);
  const baseOffsetRef = useRef<[number, number, number]>([0, 0, 0]);
  const keepViewRef = useRef(keepView);
  keepViewRef.current = keepView;
  const previewModeRef = useRef(previewMode);
  previewModeRef.current = previewMode;
  const reduce = useReducedMotion();
  const controls = useRef<React.ComponentRef<typeof OrbitControls>>(null);
  const isStl = !!path && path.split("?")[0]!.toLowerCase().endsWith(".stl");

  useEffect(() => {
    if (!path) {
      setLoaded(null);
      setStats(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    loadModel(path, mtlPath, ctrl.signal)
      .then((model) => {
        if (cancelled) return;
        // Centre at the origin and remember the shift so highlight overlays
        // (which share the raw space) can apply the SAME offset.
        let st: Stats;
        if (model.kind === "geometry") {
          const geo = model.geometry;
          geo.computeBoundingBox();
          const c = new THREE.Vector3();
          geo.boundingBox!.getCenter(c);
          baseOffsetRef.current = [c.x, c.y, c.z];
          geo.translate(-c.x, -c.y, -c.z);
          geo.computeVertexNormals();
          st = statsOfGeometry(geo);
        } else {
          const box = new THREE.Box3().setFromObject(model.group);
          const c = new THREE.Vector3();
          box.getCenter(c);
          baseOffsetRef.current = [c.x, c.y, c.z];
          model.group.position.set(-c.x, -c.y, -c.z);
          model.group.updateMatrixWorld(true);
          st = statsOfGroup(model.group);
        }
        setStats(st);
        setLoaded(model);
        // Camera policy. First mesh (or non-keepView): frame it. In keepView
        // mode, keep the user's view across swaps — EXCEPT when a full-quality
        // (non-preview) result has drifted far out of the framed bounds (e.g.
        // a slider moved the model from 100mm to 250mm tall): reframe once so
        // the result isn't half off-screen. Preview swaps never reframe.
        const extent = Math.max(...st.size) || 1;
        const r = extent / (framedExtentRef.current || extent);
        const drifted = r > 1.3 || r < 0.77;
        if (keepViewRef.current && framedRef.current && (previewModeRef.current || !drifted)) {
          setClipTick((n) => n + 1);
        } else {
          setRefit((n) => n + 1);
          framedRef.current = true;
          framedExtentRef.current = extent;
        }
      })
      .catch((e: unknown) => {
        if (cancelled || (e as Error).name === "AbortError") return;
        if (keepLastOnError && loadedRef.current) return;
        setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [path, mtlPath, keepLastOnError]);
  const loadedRef = useRef<Loaded | null>(null);
  loadedRef.current = loaded;

  // Dispose whatever we stop showing.
  useEffect(
    () => () => {
      if (!loaded) return;
      if (loaded.kind === "geometry") loaded.geometry.dispose();
      else
        loaded.group.traverse((o) => {
          if (!(o as THREE.Mesh).isMesh) return;
          const m = o as THREE.Mesh;
          m.geometry.dispose();
          for (const mm of Array.isArray(m.material) ? m.material : [m.material]) mm.dispose();
        });
    },
    [loaded],
  );

  if (!path) {
    return (
      <div className={cx("grid-backdrop flex items-center justify-center", className)}>
        <div className="text-[13px] text-faint">no mesh for this stage</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className={cx("grid-backdrop", className)}>
        <ErrorState message={`could not load mesh: ${error}`} />
      </div>
    );
  }

  const highlighting = !!highlightPaths?.length && loaded?.kind === "geometry";

  return (
    <div className={cx("relative grid-backdrop overflow-hidden", className)}>
      {loading && !loaded && (
        <div className="absolute inset-0 z-10 flex items-center justify-center">
          <Spinner size={22} />
        </div>
      )}

      {loaded && (
        <motion.div initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.35, ease: "easeOut" }} className="absolute inset-0">
        <Canvas
          dpr={[1, 2]}
          gl={{ antialias: true, alpha: true }}
          camera={{ position: [60, 45, 60], fov: 40, near: 0.01, far: 100000 }}
        >
          <ambientLight intensity={0.55} />
          <hemisphereLight args={["#ffffff", "#9aa1a9", 0.85]} />
          <directionalLight position={[50, 80, 40]} intensity={1.35} castShadow />
          <directionalLight position={[-40, -20, -50]} intensity={0.4} />
          <Bounds fit clip observe margin={1.25}>
            <Refitter fitTrigger={refit} clipTrigger={clipTick} />
            {loaded.kind === "geometry" ? (
              <Model geometry={loaded.geometry} wireframe={wireframe} dimmed={highlighting} />
            ) : (
              <PaintedModel group={loaded.group} wireframe={wireframe} />
            )}
          </Bounds>
          {highlighting && <HighlightParts paths={highlightPaths!} offset={baseOffsetRef.current} />}
          <OrbitControls
            ref={controls}
            makeDefault
            enableDamping
            dampingFactor={0.08}
            autoRotate={spin && !reduce}
            autoRotateSpeed={1.1}
          />
        </Canvas>
        </motion.div>
      )}

      {/* viewer toolbar */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-3">
        {stats && (
          <div className="pointer-events-auto rounded-lg bg-panel/80 px-2.5 py-1.5 font-mono text-[10.5px] leading-tight text-muted shadow-[var(--shadow-card)] backdrop-blur-xl">
            <div className="text-ink">
              {stats.triangles.toLocaleString()} tris
              {stats.materials > 0 && <span className="text-muted"> · {stats.materials} materials</span>}
            </div>
            <div>
              {stats.size.map((v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2))).join(" × ")}
              {isStl ? " mm" : ""}
            </div>
          </div>
        )}
        <div className="pointer-events-auto flex items-center gap-0.5 rounded-full bg-panel/80 p-1 shadow-[var(--shadow-card)] backdrop-blur-xl">
          <ViewerButton active={wireframe} onClick={() => setWireframe((v) => !v)} title="wireframe">
            {wireframe ? <CubeIcon size={15} /> : <CubeTransparent size={15} />}
          </ViewerButton>
          <ViewerButton
            active={spin}
            disabled={!!reduce}
            onClick={() => setSpin((v) => !v)}
            title={reduce ? "auto-rotate disabled (reduced motion)" : "auto-rotate"}
          >
            <ArrowsClockwise size={15} />
          </ViewerButton>
          <ViewerButton onClick={() => setRefit((n) => n + 1)} title="refit view">
            <ArrowsCounterClockwise size={15} />
          </ViewerButton>
        </div>
      </div>
    </div>
  );
}

function ViewerButton({
  children,
  onClick,
  active,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cx(
        "flex size-7 items-center justify-center rounded-full transition-colors",
        disabled
          ? "cursor-not-allowed text-faint/40"
          : active
            ? "bg-accent text-accent-ink"
            : "text-muted hover:bg-elevated hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

/** The mesh file a stage should show: the OBJ is the default deliverable, the
 *  STL only exists when a run opted in. */
export function meshPathOf(a: { objPath: string | null; stlPath: string | null } | null | undefined): string | null {
  return a?.objPath ?? a?.stlPath ?? null;
}
