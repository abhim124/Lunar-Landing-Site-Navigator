'use client';

/**
 * Immersive 3D-first Moon scene.
 *
 * Frame: +Y north, −Y south pole, +Z sub-Earth (0°,0°), +X 90°E. The Moon never rotates;
 * the camera orbits. Surface textures are looked up per fragment from the selenographic
 * direction (see lunarMaterial.ts), so globe and polar cap share one seamless mapping.
 */

import { Suspense, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Html, Line, OrbitControls, Stars } from '@react-three/drei';

import { useCurrentEphemeris } from '@/hooks/useCurrentEphemeris';
import { isAbortError, errorMessage } from '@/lib/api';
import {
  DEG2RAD,
  azElToDirection,
  clamp,
  greatCircleDestination,
  latLonToVec3,
  stereoInverse,
  stereoRho,
  vec3ToLatLon,
} from '@/lib/geo';
import { createLunarMaterial, createLunarUniforms, type LunarUniforms } from '@/lib/lunarMaterial';
import { CURATED_SITES } from '@/lib/siteRegistry';
import {
  CAP_EDGE_LAT_DEG,
  GLOBE_SOUTH_LIMIT_DEG,
  filteredElevationAtStereo,
  loadPolarHeightmap,
  radiusForElevation,
  surfaceRadius,
  useTerrainVersion,
} from '@/lib/terrainHeight';
import { OVERLAY_LAYERS, loadCgiMoonKitTexture, loadOverlayTexture, loadPsrMaskTexture } from '@/lib/wmtsTileLoader';
import { SEARCH_RADIUS_KM, useMissionStore } from '@/store/useMissionStore';

const INITIAL_CAMERA: [number, number, number] = [0, -2.55, 1.3];
const INITIAL_TARGET = new THREE.Vector3(0, -0.42, 0);
const CLICK_TOLERANCE_PX = 4;
const FLY_DISTANCE = 0.075;
const Y_UP = new THREE.Vector3(0, 1, 0);

export default function LunarGlobe() {
  return (
    <div className="absolute inset-0">
      <Canvas
        shadows
        dpr={[1, 2]}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        camera={{ fov: 38, near: 0.01, far: 300, position: INITIAL_CAMERA }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.1;
          gl.shadowMap.type = THREE.PCFSoftShadowMap;
        }}
      >
        <color attach="background" args={['#020308']} />
        <Suspense fallback={null}>
          <SceneContents />
        </Suspense>
      </Canvas>
    </div>
  );
}

function SceneContents() {
  const uniforms = useLunarSurfaceUniforms();
  return (
    <>
      <ambientLight intensity={0.05} />
      {/* faint earthshine so permanently shadowed regions read as dark, not void */}
      <hemisphereLight args={['#9db8ff', '#05060a', 0.05]} />
      <SunLight />
      <MoonBody uniforms={uniforms} />
      <SitePins />
      <LandingBeacon />
      <SunEarthVectors />
      <Stars radius={90} depth={40} count={5000} factor={3} saturation={0} fade speed={0.25} />
      <CameraRig />
    </>
  );
}

/* ═══════════════════════ Textures / overlay uniforms ═══════════════════════ */

function useLunarSurfaceUniforms(): LunarUniforms {
  const uniforms = useMemo(createLunarUniforms, []);
  const gl = useThree((s) => s.gl);
  const activeLayer = useMissionStore((s) => s.activeLayer);
  const setSceneStatus = useMissionStore((s) => s.setSceneStatus);
  const overlayTarget = useRef(0);

  // CGI Moon Kit base colour (NASA SVS JPEG → local copy → procedural).
  useEffect(() => {
    let alive = true;
    loadCgiMoonKitTexture(gl.capabilities.getMaxAnisotropy()).then(({ texture, origin }) => {
      if (!alive) return;
      uniforms.uBaseMap.value = texture;
      uniforms.uHasBase.value = 1;
      setSceneStatus({ baseTexture: origin });
    });
    return () => {
      alive = false;
    };
  }, [gl, uniforms, setSceneStatus]);

  // LOLA heightmap (rebuilds the cap via the terrain version counter).
  useEffect(() => {
    let alive = true;
    loadPolarHeightmap().then((mode) => alive && setSceneStatus({ heightmap: mode === 'lola' ? 'lola' : 'synthetic' }));
    return () => {
      alive = false;
    };
  }, [setSceneStatus]);

  // Always-on permanently-shadowed-region outline (PGDA LPSR + 500 m buffer).
  const psrTarget = useRef(0);
  useEffect(() => {
    let alive = true;
    loadPsrMaskTexture(gl.capabilities.getMaxAnisotropy())
      .then(({ texture, boundsM }) => {
        if (!alive) return;
        uniforms.uPsrMap.value = texture;
        uniforms.uPsrBounds.value.set(...boundsM);
        psrTarget.current = 1;
      })
      .catch(() => {
        /* backend offline: the globe still works without the PSR outline */
      });
    return () => {
      alive = false;
    };
  }, [gl, uniforms]);

  // Moon Trek WMTS overlay.
  useEffect(() => {
    if (activeLayer === 'BASE_CGI') {
      overlayTarget.current = 0;
      setSceneStatus({ overlay: 'idle', overlayDetail: null });
      return;
    }
    const cfg = OVERLAY_LAYERS[activeLayer];
    const ctrl = new AbortController();
    overlayTarget.current = 0;
    setSceneStatus({ overlay: 'loading', overlayDetail: `${cfg.label}: loading…` });
    loadOverlayTexture(activeLayer, {
      signal: ctrl.signal,
      anisotropy: gl.capabilities.getMaxAnisotropy(),
      onProgress: (done, total) =>
        !ctrl.signal.aborted && setSceneStatus({ overlayDetail: `${cfg.label}: ${done}/${total} tiles` }),
    })
      .then((res) => {
        if (ctrl.signal.aborted) return;
        uniforms.uOverlayMap.value = res.texture;
        uniforms.uSpBounds.value.set(...res.boundsM);
        uniforms.uOverlayMaxLat.value = -65;
        uniforms.uOverlayEmissive.value = cfg.emissive;
        overlayTarget.current = cfg.opacity;
        setSceneStatus({ overlay: 'ready', overlayDetail: `${cfg.label} · ${res.detail}` });
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        setSceneStatus({ overlay: 'error', overlayDetail: `${cfg.label}: ${errorMessage(err)}` });
      });
    return () => ctrl.abort();
  }, [activeLayer, gl, uniforms, setSceneStatus]);

  useFrame((_, dt) => {
    const u = uniforms.uOverlayMix;
    u.value += (overlayTarget.current - u.value) * (1 - Math.exp(-dt * 4));
    const p = uniforms.uPsrMix;
    p.value += (psrTarget.current - p.value) * (1 - Math.exp(-dt * 4));
  });

  return uniforms;
}

/* ═══════════════════════ Moon body: globe + displaced polar cap ═══════════════════════ */

/**
 * Polar cap 75°S→90°S built on a polar grid in stereographic (x, y): uniform ground spacing,
 * no UV seam, no pole singularity. Heights are box-prefiltered to each ring's vertex spacing
 * (radial vs. tangential, whichever is coarser) so sub-grid terrain detail cannot alias into moiré.
 */
function buildPolarCapGeometry(rings: number, segments: number): THREE.BufferGeometry {
  const rhoEdge = stereoRho(CAP_EDGE_LAT_DEG);
  const radialStep = rhoEdge / rings;
  const positions = new Float32Array((1 + rings * segments) * 3);
  const r0 = radiusForElevation(filteredElevationAtStereo(0, 0, radialStep), -90);
  positions[0] = 0;
  positions[1] = -r0;
  positions[2] = 0;
  for (let i = 1; i <= rings; i++) {
    const rho = rhoEdge * (i / rings);
    const footprint = Math.max(radialStep, (2 * Math.PI * rho) / segments);
    for (let j = 0; j < segments; j++) {
      const θ = (j / segments) * Math.PI * 2;
      const x = rho * Math.sin(θ);
      const y = rho * Math.cos(θ);
      const { lat, lon } = stereoInverse(x, y);
      const p = latLonToVec3(lat, lon, radiusForElevation(filteredElevationAtStereo(x, y, footprint), lat));
      const o = (1 + (i - 1) * segments + j) * 3;
      positions[o] = p[0];
      positions[o + 1] = p[1];
      positions[o + 2] = p[2];
    }
  }
  const ring = (i: number, j: number) => 1 + (i - 1) * segments + (j % segments);
  const indices = new Uint32Array(segments * 3 + (rings - 1) * segments * 6);
  let k = 0;
  // Winding is CCW seen from outside (from −Y looking up).
  for (let j = 0; j < segments; j++) {
    indices[k++] = 0;
    indices[k++] = ring(1, j + 1);
    indices[k++] = ring(1, j);
  }
  for (let i = 1; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = ring(i, j);
      const b = ring(i, j + 1);
      const c = ring(i + 1, j);
      const d = ring(i + 1, j + 1);
      indices[k++] = a;
      indices[k++] = d;
      indices[k++] = c;
      indices[k++] = a;
      indices[k++] = b;
      indices[k++] = d;
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setIndex(new THREE.BufferAttribute(indices, 1));
  geom.computeVertexNormals();
  geom.computeBoundingSphere();
  return geom;
}

function MoonBody({ uniforms }: { uniforms: LunarUniforms }) {
  const selectCustomSite = useMissionStore((s) => s.selectCustomSite);
  const terrainVersion = useTerrainVersion();
  const down = useRef<{ x: number; y: number } | null>(null);

  const globeMaterial = useMemo(() => createLunarMaterial(uniforms), [uniforms]);
  const capMaterial = useMemo(() => {
    const m = createLunarMaterial(uniforms);
    m.polygonOffset = true; // wins the depth test in the thin overlap band with the globe
    m.polygonOffsetFactor = -1;
    m.polygonOffsetUnits = -2;
    return m;
  }, [uniforms]);
  const globeGeometry = useMemo(
    () => new THREE.SphereGeometry(1, 384, 192, 0, Math.PI * 2, 0, (90 - GLOBE_SOUTH_LIMIT_DEG) * DEG2RAD),
    [],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const capGeometry = useMemo(() => buildPolarCapGeometry(256, 896), [terrainVersion]);

  useEffect(() => () => capGeometry.dispose(), [capGeometry]);
  useEffect(
    () => () => {
      globeGeometry.dispose();
      globeMaterial.dispose();
      capMaterial.dispose();
    },
    [globeGeometry, globeMaterial, capMaterial],
  );

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    down.current = { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY };
  };
  const onPointerUp = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation(); // the nearest hit (cap or globe) handles it once
    const start = down.current;
    down.current = null;
    if (!start || e.nativeEvent.button !== 0) return;
    const moved = Math.hypot(e.nativeEvent.clientX - start.x, e.nativeEvent.clientY - start.y);
    if (moved >= CLICK_TOLERANCE_PX) return; // that was an orbit drag, not a pick
    const { lat, lon } = vec3ToLatLon(e.point.x, e.point.y, e.point.z);
    selectCustomSite(lat, lon);
  };

  return (
    <group onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
      <mesh geometry={globeGeometry} material={globeMaterial} receiveShadow />
      <mesh geometry={capGeometry} material={capMaterial} castShadow receiveShadow />
    </group>
  );
}

/* ═══════════════════════ Sun light (ephemeris-driven) ═══════════════════════ */

function SunLight() {
  const { sunDir } = useCurrentEphemeris();
  const selected = useMissionStore((s) => s.selectedSite);
  const camera = useThree((s) => s.camera);
  const light = useRef<THREE.DirectionalLight>(null);
  const target = useMemo(() => new THREE.Object3D(), []);
  const smoothedDir = useRef(new THREE.Vector3(...sunDir));
  const lastHalf = useRef(0);
  const focus = useMemo(
    () => new THREE.Vector3(...(selected ? latLonToVec3(selected.lat, selected.lon, 1) : [0, -1, 0])),
    [selected],
  );
  const desired = useMemo(() => new THREE.Vector3(), []);

  useFrame((_, dt) => {
    const L = light.current;
    if (!L) return;
    desired.set(sunDir[0], sunDir[1], sunDir[2]);
    smoothedDir.current.lerp(desired, 1 - Math.exp(-dt * 10)).normalize();
    target.position.lerp(focus, 1 - Math.exp(-dt * 3));
    target.updateMatrixWorld();
    L.position.copy(target.position).addScaledVector(smoothedDir.current, 3);

    // Fit the shadow frustum to what the camera can see around the focus point.
    const dist = camera.position.distanceTo(target.position);
    const half = clamp(dist * 0.6, 0.015, 0.5);
    if (Math.abs(half - lastHalf.current) / half > 0.08) {
      const cam = L.shadow.camera;
      cam.left = -half;
      cam.right = half;
      cam.top = half;
      cam.bottom = -half;
      cam.near = 1.5;
      cam.far = 4.5;
      cam.updateProjectionMatrix();
      // Polar sunlight is always grazing (≤ ~1.6° elevation), so the normal offset must clear
      // several shadow texels or tessellated slopes alias into diagonal acne stripes.
      L.shadow.normalBias = half * 0.02;
      lastHalf.current = half;
    }
  });

  return (
    <>
      <primitive object={target} />
      <directionalLight
        ref={light}
        target={target}
        color="#fff4e6"
        intensity={3.2}
        castShadow
        shadow-mapSize-width={4096}
        shadow-mapSize-height={4096}
        shadow-bias={-0.0008}
      />
    </>
  );
}

/* ═══════════════════════ Curated mission pins ═══════════════════════ */

function SitePins() {
  const selectCuratedSite = useMissionStore((s) => s.selectCuratedSite);
  const selectedId = useMissionStore((s) => s.selectedSite?.regionId ?? null);
  const terrainVersion = useTerrainVersion();
  const camera = useThree((s) => s.camera);
  const pinRefs = useRef<(HTMLDivElement | null)[]>([]);
  const tmp = useMemo(() => new THREE.Vector3(), []);

  const positions = useMemo(
    () => CURATED_SITES.map((s) => latLonToVec3(s.lat, s.lon, surfaceRadius(s.lat, s.lon, 0.0012))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [terrainVersion],
  );

  // Horizon culling + zoom-dependent labels, written straight to the DOM (no React re-render per frame).
  useFrame(() => {
    for (let i = 0; i < positions.length; i++) {
      const el = pinRefs.current[i];
      if (!el) continue;
      const p = positions[i];
      tmp.set(camera.position.x - p[0], camera.position.y - p[1], camera.position.z - p[2]);
      const dist = tmp.length();
      const r = Math.hypot(p[0], p[1], p[2]);
      const facing = (tmp.x * p[0] + tmp.y * p[1] + tmp.z * p[2]) / (dist * r);
      const visible = facing > 0.03 ? '1' : '0';
      const near = dist < 0.75 ? '1' : '0';
      if (el.dataset.visible !== visible) el.dataset.visible = visible;
      if (el.dataset.near !== near) el.dataset.near = near;
    }
  });

  return (
    <>
      {CURATED_SITES.map((site, i) => {
        const benchmark = site.category === 'BENCHMARK';
        return (
          <Html key={site.id} position={positions[i]} center zIndexRange={[20, 0]}>
            <div
              ref={(el) => {
                pinRefs.current[i] = el;
              }}
              data-visible="1"
              data-near="0"
              data-selected={selectedId === site.id ? '1' : '0'}
              className="group relative flex items-center transition-opacity duration-200 data-[visible=0]:pointer-events-none data-[visible=0]:opacity-0"
            >
              <button
                type="button"
                onClick={() => selectCuratedSite(site.id)}
                aria-label={`Select ${site.name}`}
                title={site.name}
                className="relative grid h-4 w-4 cursor-pointer place-items-center"
              >
                <span
                  className={`absolute inset-0 rounded-full opacity-50 group-hover:animate-ping ${
                    benchmark ? 'bg-sky-400/50' : 'bg-violet-400/50'
                  }`}
                />
                <span
                  className={`h-2 w-2 rounded-full ring-2 ring-slate-950 group-data-[selected=1]:h-2.5 group-data-[selected=1]:w-2.5 ${
                    benchmark ? 'bg-sky-300' : 'bg-violet-300'
                  }`}
                />
              </button>
              <span className="pointer-events-none absolute left-5 whitespace-nowrap rounded-md bg-slate-950/85 px-1.5 py-0.5 text-[10px] font-medium text-slate-200 opacity-0 ring-1 ring-slate-700/70 transition-opacity group-hover:opacity-100 group-data-[near=1]:opacity-100 group-data-[selected=1]:opacity-100">
                {site.shortName}
                {site.isApproxCoord && <span className="ml-1 text-amber-300/80">≈</span>}
              </span>
            </div>
          </Html>
        );
      })}
    </>
  );
}

/* ═══════════════════════ Landing beacon + 5 km search ring ═══════════════════════ */

const RING_SEGMENTS = 128;

function LandingBeacon() {
  const selected = useMissionStore((s) => s.selectedSite);
  const terrainVersion = useTerrainVersion();
  const group = useRef<THREE.Group>(null);
  const pulse = useRef<THREE.Mesh>(null);
  const current = useRef<THREE.Vector3 | null>(null);
  const lastRingKey = useRef('');
  const tmpTarget = useMemo(() => new THREE.Vector3(), []);

  const ringLine = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array((RING_SEGMENTS + 1) * 3), 3));
    const mat = new THREE.LineBasicMaterial({ color: '#38bdf8', transparent: true, opacity: 0.9 });
    const line = new THREE.Line(geom, mat);
    line.frustumCulled = false;
    return line;
  }, []);
  useEffect(
    () => () => {
      ringLine.geometry.dispose();
      (ringLine.material as THREE.Material).dispose();
    },
    [ringLine],
  );

  useEffect(() => {
    if (!selected) current.current = null;
  }, [selected]);

  useFrame((state, dt) => {
    if (!selected || !group.current) return;
    tmpTarget.set(...latLonToVec3(selected.lat, selected.lon, 1));
    if (!current.current) current.current = tmpTarget.clone();
    else current.current.lerp(tmpTarget, 1 - Math.exp(-dt * 3.5)).normalize(); // "Relocate Lander" glide

    const { lat, lon } = vec3ToLatLon(current.current.x, current.current.y, current.current.z);
    const r = surfaceRadius(lat, lon);
    group.current.position.copy(current.current).multiplyScalar(r);
    group.current.quaternion.setFromUnitVectors(Y_UP, current.current);
    const camDist = state.camera.position.distanceTo(group.current.position);
    group.current.scale.setScalar(clamp(camDist * 0.06, 0.0006, 0.09));

    if (pulse.current) {
      const t = (state.clock.elapsedTime % 1.6) / 1.6;
      pulse.current.scale.setScalar(1 + t * 2.2);
      (pulse.current.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - t);
    }

    // Terrain-draped 5 km search ring (geodesic circle), rebuilt only when the centre moves.
    const key = `${lat.toFixed(6)},${lon.toFixed(6)},${terrainVersion}`;
    if (key !== lastRingKey.current) {
      lastRingKey.current = key;
      const attr = ringLine.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let k = 0; k <= RING_SEGMENTS; k++) {
        const d = greatCircleDestination(lat, lon, (k / RING_SEGMENTS) * 360, SEARCH_RADIUS_KM * 1000);
        const p = latLonToVec3(d.lat, d.lon, surfaceRadius(d.lat, d.lon, 0.00012));
        attr.setXYZ(k, p[0], p[1], p[2]);
      }
      attr.needsUpdate = true;
      ringLine.geometry.computeBoundingSphere();
    }
  });

  if (!selected) return null;
  return (
    <>
      <group ref={group}>
        <mesh position={[0, 0.5, 0]}>
          <cylinderGeometry args={[0.012, 0.012, 1, 8]} />
          <meshBasicMaterial color="#7dd3fc" toneMapped={false} transparent opacity={0.85} />
        </mesh>
        <mesh position={[0, 1.04, 0]}>
          <octahedronGeometry args={[0.07, 0]} />
          <meshBasicMaterial color="#e0f2fe" toneMapped={false} />
        </mesh>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
          <circleGeometry args={[0.09, 32]} />
          <meshBasicMaterial color="#38bdf8" toneMapped={false} transparent opacity={0.9} />
        </mesh>
        <mesh ref={pulse} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]}>
          <ringGeometry args={[0.16, 0.2, 48]} />
          <meshBasicMaterial color="#38bdf8" toneMapped={false} transparent opacity={0.7} side={THREE.DoubleSide} />
        </mesh>
      </group>
      <primitive object={ringLine} />
    </>
  );
}

/* ═══════════════════════ Topocentric Sun / Earth vectors ═══════════════════════ */

function SunEarthVectors() {
  const selected = useMissionStore((s) => s.selectedSite);
  const minEl = useMissionStore((s) => s.minEarthElevationDeg);
  const { ephem } = useCurrentEphemeris();
  const group = useRef<THREE.Group>(null);
  const terrainVersion = useTerrainVersion();

  const origin = useMemo(
    () => (selected ? latLonToVec3(selected.lat, selected.lon, surfaceRadius(selected.lat, selected.lon, 0.0003)) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, terrainVersion],
  );

  useFrame((state) => {
    if (!group.current || !origin) return;
    const d = state.camera.position.distanceTo(group.current.position);
    group.current.scale.setScalar(clamp(d * 0.32, 0.004, 0.5));
  });

  if (!selected || !ephem || !origin) return null;
  const sunDir = azElToDirection(selected.lat, selected.lon, ephem.sunAzDeg, ephem.sunElDeg);
  const earthDir = azElToDirection(selected.lat, selected.lon, ephem.earthAzDeg, ephem.earthElDeg);
  const sunLit = ephem.sunVisibleFraction > 0.01;
  const earthOk = ephem.earthAboveCutoff;

  return (
    <group ref={group} position={origin}>
      <Line points={[[0, 0, 0], sunDir]} color={sunLit ? '#fbbf24' : '#78716c'} lineWidth={2} transparent opacity={0.95} />
      <mesh position={sunDir}>
        <sphereGeometry args={[0.03, 16, 16]} />
        <meshBasicMaterial color={sunLit ? '#fde68a' : '#a8a29e'} toneMapped={false} />
      </mesh>
      <Html position={sunDir} zIndexRange={[21, 0]} style={{ pointerEvents: 'none' }}>
        <div className="ml-2 whitespace-nowrap rounded bg-slate-950/80 px-1.5 py-0.5 font-mono text-[10px] text-amber-200 ring-1 ring-amber-500/30">
          ☉ {ephem.sunElDeg.toFixed(2)}° · {(ephem.sunVisibleFraction * 100).toFixed(0)}% disk
        </div>
      </Html>

      <Line
        points={[[0, 0, 0], earthDir]}
        color={earthOk ? '#38bdf8' : '#f43f5e'}
        lineWidth={2}
        dashed={!earthOk}
        dashSize={0.05}
        gapSize={0.035}
        transparent
        opacity={0.95}
      />
      <mesh position={earthDir}>
        <sphereGeometry args={[0.035, 16, 16]} />
        <meshBasicMaterial color={earthOk ? '#7dd3fc' : '#fda4af'} toneMapped={false} />
      </mesh>
      <Html position={earthDir} zIndexRange={[21, 0]} style={{ pointerEvents: 'none' }}>
        <div className="ml-2 whitespace-nowrap rounded bg-slate-950/80 px-1.5 py-0.5 font-mono text-[10px] text-sky-200 ring-1 ring-sky-500/30">
          ⊕ {ephem.earthElDeg.toFixed(2)}° {earthOk ? '· link' : ephem.earthVisible ? `· < ${minEl}° cutoff` : '· occulted'}
        </div>
      </Html>
    </group>
  );
}

/* ═══════════════════════ Camera: orbit + fly-to + near-plane management ═══════════════════════ */

function CameraRig() {
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const flyTo = useMissionStore((s) => s.flyTo);
  const hasSelection = useMissionStore((s) => s.selectedSite !== null);
  const [autoRotate, setAutoRotate] = useState(true);
  const anim = useRef<{ target: THREE.Vector3; position: THREE.Vector3; started: number } | null>(null);
  const clock = useThree((s) => s.clock);

  useEffect(() => {
    if (!flyTo) return;
    setAutoRotate(false);
    if (flyTo.kind === 'overview') {
      anim.current = { target: INITIAL_TARGET.clone(), position: new THREE.Vector3(...INITIAL_CAMERA), started: clock.elapsedTime };
      return;
    }
    const n = new THREE.Vector3(...latLonToVec3(flyTo.lat, flyTo.lon, 1));
    const point = n.clone().multiplyScalar(surfaceRadius(flyTo.lat, flyTo.lon));
    // Keep the user's current viewing side, but look mostly down the local vertical.
    const view = camera.position.clone().sub(point).normalize();
    const dir = n.clone().multiplyScalar(0.72).addScaledVector(view, 0.28).normalize();
    anim.current = {
      target: point,
      position: point.clone().addScaledVector(dir, FLY_DISTANCE),
      started: clock.elapsedTime,
    };
  }, [flyTo, camera, clock]);

  useFrame((state, dt) => {
    const c = controls.current;
    if (!c) return;

    if (anim.current) {
      const k = 1 - Math.exp(-dt * 2.8);
      c.target.lerp(anim.current.target, k);
      camera.position.lerp(anim.current.position, k);
      const done =
        c.target.distanceTo(anim.current.target) < 1e-4 && camera.position.distanceTo(anim.current.position) < 5e-4;
      if (done || state.clock.elapsedTime - anim.current.started > 4) anim.current = null;
    }

    // Never let the camera sink below the (exaggerated) terrain.
    const len = camera.position.length();
    const ll = vec3ToLatLon(camera.position.x, camera.position.y, camera.position.z);
    const floor = surfaceRadius(ll.lat, ll.lon) + 0.0015;
    if (len < floor) camera.position.multiplyScalar(floor / len);

    // Precision: scale the near plane with altitude, and the orbit feel with zoom.
    const altitude = Math.max(camera.position.length() - 1, 1e-4);
    const near = clamp(altitude * 0.2, 2e-5, 0.5);
    if (Math.abs(near - camera.near) / camera.near > 0.15) {
      camera.near = near;
      camera.updateProjectionMatrix();
    }
    const dist = camera.position.distanceTo(c.target);
    c.rotateSpeed = clamp(dist * 0.3, 0.06, 0.55);
    c.zoomSpeed = clamp(dist * 0.6, 0.4, 1.0);
    c.panSpeed = clamp(dist * 0.6, 0.05, 1.0);
    c.minDistance = c.target.length() < 0.9 ? 1.1 : 0.004;
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      target={INITIAL_TARGET}
      enableDamping
      dampingFactor={0.08}
      maxDistance={9}
      autoRotate={autoRotate && !hasSelection}
      autoRotateSpeed={0.35}
      onStart={() => {
        anim.current = null;
        setAutoRotate(false);
      }}
    />
  );
}
