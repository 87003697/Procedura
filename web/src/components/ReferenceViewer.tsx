import { useEffect, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Bounds, OrbitControls } from "@react-three/drei";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import * as THREE from "three";

import { ErrorState, Spinner } from "./ui.tsx";

function CanonicalMesh({ handle }: { handle: string }) {
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const material = useMemo(
    () => new THREE.MeshStandardMaterial({
      color: "#b4bac2",
      roughness: 0.58,
      metalness: 0.08,
      flatShading: true,
      side: THREE.DoubleSide,
    }),
    [],
  );

  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => {
    const controller = new AbortController();
    setGeometry((current) => {
      current?.dispose();
      return null;
    });
    setError(null);
    fetch("/api/reference/mesh?handle=" + encodeURIComponent(handle), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(response.status + " " + response.statusText);
        return response.arrayBuffer();
      })
      .then((bytes) => {
        const next = new STLLoader().parse(bytes);
        next.rotateX(-Math.PI / 2);
        next.computeBoundingBox();
        const center = next.boundingBox?.getCenter(new THREE.Vector3());
        if (center) next.translate(-center.x, -center.y, -center.z);
        next.computeVertexNormals();
        setGeometry(next);
      })
      .catch((cause: unknown) => {
        if ((cause as Error).name !== "AbortError") setError((cause as Error).message);
      });
    return () => controller.abort();
  }, [handle]);
  useEffect(() => () => geometry?.dispose(), [geometry]);

  if (error) return <ErrorState message={error} />;
  if (!geometry) return <Spinner />;
  return (
    <Canvas camera={{ position: [60, 45, 60], fov: 40, near: 0.01, far: 100000 }} className="h-full w-full">
      <color attach="background" args={["#eef0f3"]} />
      <ambientLight intensity={1.4} />
      <directionalLight position={[3, 4, 5]} intensity={2} />
      <Bounds fit clip observe margin={1.2}>
        <mesh geometry={geometry} material={material} />
      </Bounds>
      <OrbitControls makeDefault />
    </Canvas>
  );
}

export function ReferenceViewer({ handle, className }: { handle: string; className?: string }) {
  return <div className={className}><CanonicalMesh key={handle} handle={handle} /></div>;
}
