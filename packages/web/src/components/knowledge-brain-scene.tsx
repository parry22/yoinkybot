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

const NODE_COLORS = ["#3df0ff", "#5b8cff", "#7a5cff", "#2ee6a6", "#4ecbff"];

function hash(str: string) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function buildBrainNodes(objects: KnowledgeObjectView[]): BrainNode[] {
  const source =
    objects.length > 0
      ? objects
      : ([
          { id: "demo-1", title: "Pricing objection", objectType: "objection" },
          { id: "demo-2", title: "Founder story", objectType: "story" },
          { id: "demo-3", title: "ROI claim", objectType: "claim" },
          { id: "demo-4", title: "Customer proof", objectType: "proof" },
          { id: "demo-5", title: "Market signal", objectType: "market_signal" },
          { id: "demo-6", title: "Capability", objectType: "capability" },
          { id: "demo-7", title: "Insight", objectType: "insight" },
          { id: "demo-8", title: "Framework", objectType: "framework" },
        ] as Array<Pick<KnowledgeObjectView, "id" | "title" | "objectType">>);

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

function NeonBrain() {
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
        color: new THREE.Color("#061428"),
        emissive: new THREE.Color("#1a7dff"),
        emissiveIntensity: 1.35,
        roughness: 0.35,
        metalness: 0.55,
        wireframe: true,
        transparent: true,
        opacity: 0.92,
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
        color: new THREE.Color("#03101f"),
        emissive: new THREE.Color("#0b4db8"),
        emissiveIntensity: 0.55,
        roughness: 0.8,
        metalness: 0.2,
        transparent: true,
        opacity: 0.55,
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
      <color attach="background" args={["#02060d"]} />
      <fog attach="fog" args={["#02060d", 8, 18]} />
      <ambientLight intensity={0.15} />
      <pointLight position={[0, 2.5, 3]} intensity={1.4} color="#3aa0ff" distance={18} />
      <pointLight position={[-3, -1, -2]} intensity={0.7} color="#6a5cff" distance={14} />
      <pointLight position={[3, 1, -1]} intensity={0.55} color="#2ee6ff" distance={12} />

      <group position={[0, -0.1, 0]}>
        <NeonBrain />
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
