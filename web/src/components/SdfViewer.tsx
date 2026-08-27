import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { useReducedMotion } from "motion/react";
import {
  ArrowsClockwiseIcon as ArrowsClockwise,
  WarningCircleIcon as WarningCircle,
} from "@phosphor-icons/react";

import type { CsgCoverage } from "../../shared/types.ts";
import type { GlslResult } from "../lib/csgGlsl.ts";
import { cx, Spinner } from "./ui.tsx";

const VERT = /* glsl */ `
varying vec3 vWorld;
void main(){
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

function buildFragment(mapSrc: string, radius: number): string {
  return /* glsl */ `
precision highp float;
varying vec3 vWorld;
uniform vec3 uCam;
uniform vec3 uLightDir;
${mapSrc}

// OpenSCAD models are Z-up; the rest of the app shows Y-up (the mesh viewer
// rotates the geometry). Raymarch in world (Y-up) space but evaluate the SDF in
// model (Z-up) space so the SDF and mesh views match. world->model = +90° about X.
float scene(vec3 p){ return map(vec3(p.x, -p.z, p.y)); }

vec3 calcNormal(vec3 p){
  float e = ${(radius * 0.0008).toFixed(6)};
  vec2 k = vec2(1.0,-1.0);
  return normalize(
    k.xyy*scene(p+k.xyy*e) + k.yyx*scene(p+k.yyx*e) +
    k.yxy*scene(p+k.yxy*e) + k.xxx*scene(p+k.xxx*e));
}

float ao(vec3 p, vec3 n){
  float occ = 0.0, sca = 1.0;
  for(int i=0;i<5;i++){
    float h = 0.01 + 0.12*float(i)/4.0;
    float d = scene(p + n*h*${radius.toFixed(3)});
    occ += (h*${radius.toFixed(3)} - d)*sca;
    sca *= 0.85;
  }
  return clamp(1.0 - 1.5*occ/${radius.toFixed(3)}, 0.0, 1.0);
}

void main(){
  vec3 ro = uCam;
  vec3 rd = normalize(vWorld - uCam);
  float t = 0.0;
  float tmax = ${(radius * 6.0).toFixed(3)};
  bool hit = false;
  for(int i=0;i<160;i++){
    vec3 p = ro + rd*t;
    float d = scene(p);
    if(d < ${(radius * 0.0006).toFixed(6)}){ hit = true; break; }
    t += d;
    if(t > tmax) break;
  }
  if(!hit) discard;
  vec3 p = ro + rd*t;
  vec3 n = calcNormal(p);
  float diff = clamp(dot(n, normalize(uLightDir)), 0.0, 1.0);
  float a = ao(p, n);
  vec3 base = vec3(0.77, 0.80, 0.84);
  vec3 col = base * (0.30 + 0.70*diff) * (0.45 + 0.55*a);
  col += vec3(0.04) * pow(clamp(1.0+dot(rd,n),0.0,1.0), 2.0); // rim
  gl_FragColor = vec4(pow(col, vec3(0.4545)), 1.0);
}`;
}

function SdfMesh({
  frag,
  radius,
  center,
}: {
  frag: string;
  radius: number;
  center: [number, number, number];
}) {
  const matRef = useRef<THREE.ShaderMaterial>(null);

  const uniforms = useMemo(
    () => ({
      uCam: { value: new THREE.Vector3() },
      uLightDir: { value: new THREE.Vector3(0.5, 0.8, 0.6).normalize() },
    }),
    [],
  );

  // The SDF (map) lives in true world coordinates already — the Y-up→Z-up map
  // is linear so the model sits at its real location. We only need the box (the
  // ray-seeding backfaces) centered on the model so it actually surrounds it,
  // and the camera fed in as a uniform. Spin is handled by OrbitControls
  // autoRotate around the model center, so the geometry never moves.
  useFrame(({ camera }) => {
    if (matRef.current) (matRef.current.uniforms.uCam!.value as THREE.Vector3).copy(camera.position);
  });

  const s = radius * 2.6;
  return (
    <mesh position={center}>
      <boxGeometry args={[s, s, s]} />
      <shaderMaterial
        ref={matRef}
        vertexShader={VERT}
        fragmentShader={frag}
        uniforms={uniforms}
        side={THREE.BackSide}
        transparent
      />
    </mesh>
  );
}

export function SdfViewer({
  gen,
  coverage,
  loading,
  className,
}: {
  gen: GlslResult;
  coverage: CsgCoverage;
  loading: boolean;
  className?: string;
}) {
  const [spin, setSpin] = useState(false);
  const reduce = useReducedMotion();

  const frag = useMemo(() => (gen.ok ? buildFragment(gen.mapBody, gen.radius) : null), [gen]);

  return (
    <div className={cx("relative grid-backdrop overflow-hidden", className)}>
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-bg/40 backdrop-blur-[1px]">
          <Spinner size={22} />
        </div>
      )}

      {frag && gen.ok ? (
        <Canvas
          dpr={[1, 2]}
          gl={{ antialias: true, alpha: true }}
          camera={{
            position: [
              gen.center[0] + gen.radius * 1.9,
              gen.center[1] + gen.radius * 1.4,
              gen.center[2] + gen.radius * 1.9,
            ],
            fov: 40,
            near: Math.max(0.01, gen.radius * 0.02),
            far: gen.radius * 40,
          }}
        >
          <SdfMesh frag={frag} radius={gen.radius} center={gen.center} />
          <OrbitControls
            makeDefault
            enableDamping
            dampingFactor={0.08}
            target={gen.center}
            autoRotate={spin && !reduce}
            autoRotateSpeed={1.2}
          />
        </Canvas>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <WarningCircle size={24} className="text-warn" />
          <div className="text-[13px] text-muted">{gen.reason ?? "could not build SDF"}</div>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-3">
        <div className="pointer-events-auto rounded-md border border-line bg-panel/85 px-2.5 py-1.5 font-mono text-[10.5px] leading-tight text-muted backdrop-blur">
          <div className="text-accent">SDF preview · {Math.round(coverage.fidelity * 100)}% exact</div>
          <div>{coverage.nodes} nodes · GPU raymarched</div>
        </div>
        <div className="pointer-events-auto flex items-center gap-1 rounded-md border border-line bg-panel/85 p-1 backdrop-blur">
          <button
            onClick={() => setSpin((v) => !v)}
            disabled={!!reduce}
            title={reduce ? "auto-rotate disabled (reduced motion)" : "auto-rotate"}
            aria-pressed={spin}
            className={cx(
              "flex size-7 items-center justify-center rounded-md transition-colors",
              reduce ? "cursor-not-allowed text-faint/40" : spin ? "bg-accent/15 text-accent" : "text-muted hover:bg-elevated hover:text-ink",
            )}
          >
            <ArrowsClockwise size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
