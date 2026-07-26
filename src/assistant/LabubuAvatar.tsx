import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Component, type ReactNode, useEffect, useRef, useState } from 'react';
import type { Group, Mesh } from 'three';
import type { AssistantMood } from './types';

interface LabubuAvatarProps {
  readonly mood: AssistantMood;
  readonly reduceMotion: boolean;
  readonly forceFallback?: boolean;
}

interface CanvasBoundaryProps {
  readonly fallback: ReactNode;
  readonly children: ReactNode;
}

class CanvasBoundary extends Component<CanvasBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const canCreateWebGLContext = () => {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
};

function LabubuModel({ mood, reduceMotion }: Omit<LabubuAvatarProps, 'forceFallback'>) {
  const rootRef = useRef<Group>(null);
  const mouthRef = useRef<Mesh>(null);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    if (reduceMotion || mood === 'idle') {
      if (rootRef.current) {
        rootRef.current.position.y = 0;
        rootRef.current.rotation.z = 0;
      }
      if (mouthRef.current) mouthRef.current.scale.y = 0.46;
    }
    invalidate();
  }, [invalidate, mood, reduceMotion]);

  useFrame(({ clock }) => {
    if (reduceMotion || mood === 'idle') return;
    const elapsed = clock.getElapsedTime();
    if (rootRef.current) {
      const pace = mood === 'listening' ? 4.2 : mood === 'thinking' ? 2.4 : 5.2;
      rootRef.current.position.y = Math.sin(elapsed * pace) * 0.045;
      rootRef.current.rotation.z = Math.sin(elapsed * pace * 0.55) * 0.035;
    }
    if (mouthRef.current) {
      const openness = mood === 'speaking' ? 0.62 + Math.sin(elapsed * 11) * 0.2 : 0.46;
      mouthRef.current.scale.y = Math.max(0.28, openness);
    }
  });

  const fur = mood === 'error' ? '#c78f82' : mood === 'listening' ? '#a7e9d7' : '#b8a58e';
  const face = '#e8cdb1';

  return (
    <group ref={rootRef} rotation={[0.04, -0.18, 0]} scale={0.86}>
      <mesh position={[-0.62, 1.04, 0]} rotation={[0, 0, 0.2]}>
        <capsuleGeometry args={[0.23, 0.85, 8, 20]} />
        <meshStandardMaterial color={fur} roughness={0.98} />
      </mesh>
      <mesh position={[0.62, 1.04, 0]} rotation={[0, 0, -0.2]}>
        <capsuleGeometry args={[0.23, 0.85, 8, 20]} />
        <meshStandardMaterial color={fur} roughness={0.98} />
      </mesh>
      <mesh position={[0, 0.46, 0]} scale={[1.05, 1.08, 0.9]}>
        <sphereGeometry args={[0.82, 28, 22]} />
        <meshStandardMaterial color={fur} roughness={1} />
      </mesh>
      <mesh position={[0, 0.38, 0.66]} scale={[0.78, 0.72, 0.22]}>
        <sphereGeometry args={[0.75, 28, 20]} />
        <meshStandardMaterial color={face} roughness={0.82} />
      </mesh>
      <mesh position={[-0.29, 0.58, 0.89]} scale={[1, 1.25, 0.7]}>
        <sphereGeometry args={[0.09, 18, 14]} />
        <meshStandardMaterial color="#171c20" roughness={0.35} />
      </mesh>
      <mesh position={[0.29, 0.58, 0.89]} scale={[1, 1.25, 0.7]}>
        <sphereGeometry args={[0.09, 18, 14]} />
        <meshStandardMaterial color="#171c20" roughness={0.35} />
      </mesh>
      <mesh ref={mouthRef} position={[0, 0.22, 0.91]} scale={[1, 0.46, 0.42]}>
        <sphereGeometry args={[0.33, 24, 16]} />
        <meshStandardMaterial color="#24181a" roughness={0.55} />
      </mesh>
      {[-0.2, -0.1, 0, 0.1, 0.2].map((x) => (
        <mesh key={x} position={[x, 0.34 - Math.abs(x) * 0.16, 1.035]} scale={[0.72, 0.65, 0.5]}>
          <coneGeometry args={[0.07, 0.16, 4]} />
          <meshStandardMaterial color="#fff9e9" roughness={0.72} />
        </mesh>
      ))}
      <mesh position={[0, -0.62, -0.02]} scale={[0.7, 0.92, 0.6]}>
        <sphereGeometry args={[0.69, 24, 18]} />
        <meshStandardMaterial color={fur} roughness={1} />
      </mesh>
      <mesh position={[-0.5, -1.08, 0.06]} rotation={[0, 0, 0.1]}>
        <capsuleGeometry args={[0.16, 0.48, 6, 14]} />
        <meshStandardMaterial color={fur} roughness={1} />
      </mesh>
      <mesh position={[0.5, -1.08, 0.06]} rotation={[0, 0, -0.1]}>
        <capsuleGeometry args={[0.16, 0.48, 6, 14]} />
        <meshStandardMaterial color={fur} roughness={1} />
      </mesh>
    </group>
  );
}

function AvatarFallback({ mood }: { readonly mood: AssistantMood }) {
  return (
    <span className={`assistant-avatar-fallback assistant-avatar-fallback--${mood}`} aria-hidden="true">
      <span className="assistant-avatar-fallback__ear assistant-avatar-fallback__ear--left" />
      <span className="assistant-avatar-fallback__ear assistant-avatar-fallback__ear--right" />
      <span className="assistant-avatar-fallback__face">
        <span className="assistant-avatar-fallback__eyes">••</span>
        <span className="assistant-avatar-fallback__smile">▾▾▾▾▾</span>
      </span>
    </span>
  );
}

export function LabubuAvatar({ mood, reduceMotion, forceFallback = false }: LabubuAvatarProps) {
  const fallback = <AvatarFallback mood={mood} />;
  const [webGLAvailable] = useState(() => !forceFallback && canCreateWebGLContext());
  if (!webGLAvailable) return fallback;
  const animated = !reduceMotion && mood !== 'idle';

  return (
    <CanvasBoundary fallback={fallback}>
      <span className="assistant-avatar-canvas" aria-hidden="true">
        <Canvas
          aria-hidden="true"
          camera={{ position: [0, 0.08, 4.2], fov: 38 }}
          dpr={[1, 1.5]}
          frameloop={animated ? 'always' : 'demand'}
          gl={{ alpha: true, antialias: true, powerPreference: 'low-power' }}
        >
          <ambientLight intensity={1.35} />
          <directionalLight position={[2.5, 4, 4]} intensity={2.1} color="#fff4d6" />
          <directionalLight position={[-3, 1, 2]} intensity={0.8} color="#7ee8db" />
          <LabubuModel mood={mood} reduceMotion={reduceMotion} />
        </Canvas>
      </span>
    </CanvasBoundary>
  );
}
