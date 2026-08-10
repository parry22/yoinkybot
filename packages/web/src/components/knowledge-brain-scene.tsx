"use client";

import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { KnowledgeObjectView } from "@yoink/backend/web";

export type BrainNode = {
  id: string;
  title: string;
  type: string;
  position: [number, number, number];
  color: string;
};

const NODE_COLORS = ["#1677d2", "#8f5ae8", "#d36944", "#23956c", "#2d8ab6"];

function hash(str: string) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function buildBrainNodes(objects: KnowledgeObjectView[], allowDemoNodes = false): BrainNode[] {
  const demoSource = [
    { id: "demo-1", title: "Pricing objection", objectType: "objection" },
    { id: "demo-2", title: "Founder story", objectType: "story" },
    { id: "demo-3", title: "ROI claim", objectType: "claim" },
    { id: "demo-4", title: "Customer proof", objectType: "proof" },
    { id: "demo-5", title: "Market signal", objectType: "market_signal" },
    { id: "demo-6", title: "Capability", objectType: "capability" },
    { id: "demo-7", title: "Insight", objectType: "insight" },
    { id: "demo-8", title: "Framework", objectType: "framework" },
  ] as Array<Pick<KnowledgeObjectView, "id" | "title" | "objectType">>;

  const source = objects.length > 0 ? objects : allowDemoNodes ? demoSource : [];
  if (source.length === 0) return [];

  const count = Math.min(source.length, 28);
  const golden = Math.PI * (3 - Math.sqrt(5));

  return source.slice(0, count).map((object, index) => {
    const y = 1 - (index / Math.max(count - 1, 1)) * 2;
    const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * index + (hash(object.id) % 40) / 120;
    const r = 2.0 + (hash(object.title) % 20) / 100;
    const x = Math.cos(theta) * radiusAtY * r;
    const z = Math.sin(theta) * radiusAtY * r * 1.05;
    const yy = y * r * 0.9 + 0.1;
    return {
      id: object.id,
      title: object.title,
      type: object.objectType,
      position: [x, yy, z] as [number, number, number],
      color: NODE_COLORS[index % NODE_COLORS.length],
    };
  });
}

function KnowledgeBrain() {
  const group = useRef<THREE.Group>(null);
  const { scene } = useGLTF("/models/brain.glb");

  const prepared = useMemo(() => {
    const root = scene.clone(true);
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.material = new THREE.MeshStandardMaterial({
        color: new THREE.Color("#dceafb"),
        emissive: new THREE.Color("#8fc4f4"),
        emissiveIntensity: 0.24,
        roughness: 0.68,
        metalness: 0.05,
        wireframe: false,
        transparent: true,
        opacity: 0.9,
      });
    });

    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    root.position.sub(center);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    root.scale.setScalar(3.5 / maxDim);
    return root;
  }, [scene]);

  const core = useMemo(() => {
    const root = prepared.clone(true);
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.material = new THREE.MeshStandardMaterial({
        color: new THREE.Color("#eef5fe"),
        emissive: new THREE.Color("#b9d9f6"),
        emissiveIntensity: 0.08,
        roughness: 0.85,
        metalness: 0.02,
        transparent: true,
        opacity: 0.5,
      });
    });
    root.scale.multiplyScalar(0.985);
    return root;
  }, [prepared]);

  useFrame((_, delta) => {
    if (!group.current) return;
    group.current.rotation.y += delta * 0.18;
  });

  return (
    <group ref={group}>
      <primitive object={prepared} />
      <primitive object={core} />
    </group>
  );
}

function GlowDot({ node }: { node: BrainNode }) {
  const ref = useRef<THREE.Group>(null);
  const phase = useMemo(() => (hash(node.id) % 1000) / 160, [node.id]);

  useFrame((state) => {
    if (!ref.current) return;
    const pulse = 0.85 + Math.sin(state.clock.elapsedTime * 1.6 + phase) * 0.2;
    ref.current.scale.setScalar(pulse);
  });

  return (
    <group ref={ref} position={node.position}>
      <mesh>
        <sphereGeometry args={[0.045, 16, 16]} />
        <meshStandardMaterial
          color={node.color}
          emissive={node.color}
          emissiveIntensity={1.8}
          roughness={0.2}
          metalness={0.1}
        />
      </mesh>
      <mesh scale={2.8}>
        <sphereGeometry args={[0.045, 12, 12]} />
        <meshBasicMaterial color={node.color} transparent opacity={0.18} depthWrite={false} />
      </mesh>
    </group>
  );
}

function Scene({ nodes }: { nodes: BrainNode[] }) {
  return (
    <>
      <color attach="background" args={["#f7f8fc"]} />
      <fog attach="fog" args={["#f7f8fc", 8, 18]} />
      <ambientLight intensity={1.35} />
      <pointLight position={[0, 2.5, 3]} intensity={1.1} color="#9fc9f4" distance={18} />
      <pointLight position={[-3, -1, -2]} intensity={0.45} color="#cbb8f4" distance={14} />
      <pointLight position={[3, 1, -1]} intensity={0.35} color="#b5ddd4" distance={12} />

      <group position={[0, -0.1, 0]}>
        <KnowledgeBrain />
        {nodes.slice(0, 14).map((node) => (
          <GlowDot key={node.id} node={node} />
        ))}
      </group>

      <OrbitControls enablePan={false} enableZoom={false} enableRotate={false} target={[0, 0.05, 0]} />
    </>
  );
}

export function KnowledgeBrainCanvas({ nodes }: { nodes: BrainNode[] }) {
  return (
    <Canvas
      dpr={[1, 1.6]}
      camera={{ position: [0.15, 0.35, 5.2], fov: 38, near: 0.1, far: 40 }}
      gl={{ antialias: true, alpha: false, toneMapping: THREE.ACESFilmicToneMapping }}
      style={{ width: "100%", height: "100%", pointerEvents: "none" }}
    >
      <Scene nodes={nodes} />
    </Canvas>
  );
}

useGLTF.preload("/models/brain.glb");
