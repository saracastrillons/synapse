import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Stars } from '@react-three/drei'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { runtime } from '../runtime'
import { useUI } from '../store'

const R = 100

export const HUBS: { name: string; lat: number; lon: number; active?: boolean; note?: string }[] = [
  { name: 'Medellín', lat: 6.25, lon: -75.569, active: true, note: 'Live twin · Centro' },
  { name: 'Bogotá', lat: 4.711, lon: -74.072, note: 'Queued' },
  { name: 'Ciudad de México', lat: 19.433, lon: -99.133, note: 'Queued' },
  { name: 'São Paulo', lat: -23.55, lon: -46.633, note: 'Queued' },
  { name: 'New York', lat: 40.713, lon: -74.006, note: 'Queued' },
  { name: 'Madrid', lat: 40.417, lon: -3.704, note: 'Queued' },
  { name: 'London', lat: 51.507, lon: -0.128, note: 'Queued' },
  { name: 'Lagos', lat: 6.524, lon: 3.379, note: 'Queued' },
  { name: 'Dubai', lat: 25.205, lon: 55.271, note: 'Queued' },
  { name: 'Singapore', lat: 1.352, lon: 103.82, note: 'Queued' },
  { name: 'Tokyo', lat: 35.676, lon: 139.65, note: 'Queued' },
  { name: 'Sydney', lat: -33.869, lon: 151.21, note: 'Queued' },
]

export function latLon(lat: number, lon: number, r = R) {
  const phi = ((90 - lat) * Math.PI) / 180
  const theta = ((lon + 180) * Math.PI) / 180
  return new THREE.Vector3(-r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta))
}

const dotVert = /* glsl */ `
  uniform float uTime;
  attribute float aRand;
  varying float vFacing;
  varying float vLat;
  varying float vTw;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normalize(position));
    vFacing = dot(n, normalize(-mv.xyz));
    vLat = position.y / ${R.toFixed(1)};
    vTw = 0.65 + 0.35 * sin(uTime * 1.7 + aRand * 40.0);
    gl_PointSize = 2.2 * (300.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }`
const dotFrag = /* glsl */ `
  varying float vFacing;
  varying float vLat;
  varying float vTw;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.1, d) * smoothstep(-0.15, 0.35, vFacing);
    vec3 col = mix(vec3(0.13, 0.83, 0.93), vec3(0.65, 0.55, 0.98), smoothstep(-0.6, 0.9, vLat));
    gl_FragColor = vec4(col * (1.2 + vTw * 0.6), a * vTw);
  }`

const atmoVert = /* glsl */ `
  varying vec3 vN;
  varying vec3 vP;
  void main() {
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vP = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }`
const atmoFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform float uPower;
  uniform float uStrength;
  varying vec3 vN;
  varying vec3 vP;
  void main() {
    float f = 1.0 - abs(dot(normalize(vN), normalize(-vP)));
    float i = pow(f, uPower) * uStrength;
    gl_FragColor = vec4(uColor * i, i);
  }`

const arcVert = /* glsl */ `
  attribute float aT;
  varying float vT;
  void main() { vT = aT; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`
const arcFrag = /* glsl */ `
  uniform float uTime;
  uniform float uOffset;
  uniform vec3 uColor;
  varying float vT;
  void main() {
    float head = fract(uTime * 0.25 + uOffset);
    float d = vT - head;
    float trail = smoothstep(-0.25, 0.0, d) * (1.0 - smoothstep(0.0, 0.02, d));
    float base = 0.12;
    gl_FragColor = vec4(uColor * (base + trail * 2.5), base + trail);
  }`

function Arc({ to, offset, color }: { to: THREE.Vector3; offset: number; color: string }) {
  const from = useMemo(() => latLon(6.25, -75.569), [])
  const { geometry, material } = useMemo(() => {
    const mid = from.clone().add(to).multiplyScalar(0.5)
    const lift = 1 + from.distanceTo(to) / (R * 2.4)
    mid.normalize().multiplyScalar(R * lift)
    const curve = new THREE.QuadraticBezierCurve3(from.clone().multiplyScalar(1.01), mid, to.clone().multiplyScalar(1.01))
    const pts = curve.getPoints(90)
    const geometry = new THREE.BufferGeometry().setFromPoints(pts)
    geometry.setAttribute('aT', new THREE.Float32BufferAttribute(pts.map((_, i) => i / (pts.length - 1)), 1))
    const material = new THREE.ShaderMaterial({
      vertexShader: arcVert, fragmentShader: arcFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uOffset: { value: offset }, uColor: { value: new THREE.Color(color) } },
    })
    return { geometry, material }
  }, [from, to, offset, color])
  useFrame(({ clock }) => (material.uniforms.uTime.value = clock.elapsedTime))
  return <primitive object={new THREE.Line(geometry, material)} />
}

function Satellite({ radius, speed, tilt, phase }: { radius: number; speed: number; tilt: number; phase: number }) {
  const ref = useRef<THREE.Mesh>(null)
  const ring = useMemo(() => {
    const pts = new THREE.EllipseCurve(0, 0, radius, radius).getPoints(160).map((p) => new THREE.Vector3(p.x, 0, p.y))
    return new THREE.BufferGeometry().setFromPoints(pts)
  }, [radius])
  useFrame(({ clock }) => {
    const a = clock.elapsedTime * speed + phase
    ref.current?.position.set(Math.cos(a) * radius, 0, Math.sin(a) * radius)
  })
  return (
    <group rotation={[tilt, phase, tilt * 0.4]}>
      <primitive object={new THREE.LineLoop(ring, new THREE.LineBasicMaterial({ color: '#3b5bdb', transparent: true, opacity: 0.18 }))} />
      <mesh ref={ref}>
        <sphereGeometry args={[0.9, 12, 12]} />
        <meshBasicMaterial color="#c4b5fd" toneMapped={false} />
      </mesh>
    </group>
  )
}

function Beacon({ hub }: { hub: (typeof HUBS)[number] }) {
  const pos = useMemo(() => latLon(hub.lat, hub.lon, R * 1.003), [hub])
  const ring = useRef<THREE.Mesh>(null)
  const quat = useMemo(() => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), pos.clone().normalize()), [pos])
  const beamQuat = useMemo(() => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), pos.clone().normalize()), [pos])
  useFrame(({ clock }) => {
    if (!ring.current) return
    const k = (clock.elapsedTime * 0.8) % 1
    ring.current.scale.setScalar(1 + k * (hub.active ? 4 : 2))
    ;(ring.current.material as THREE.MeshBasicMaterial).opacity = (1 - k) * (hub.active ? 0.9 : 0.4)
  })
  const color = hub.active ? '#22d3ee' : '#8b9cc8'
  return (
    <group position={pos}>
      <mesh quaternion={quat} ref={ring}>
        <ringGeometry args={[0.9, 1.15, 40]} />
        <meshBasicMaterial color={color} transparent side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
      <mesh quaternion={quat}>
        <circleGeometry args={[hub.active ? 0.8 : 0.45, 24]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
      {hub.active && (
        <mesh quaternion={beamQuat} position={pos.clone().normalize().multiplyScalar(6)}>
          <cylinderGeometry args={[0.12, 0.5, 12, 12, 1, true]} />
          <meshBasicMaterial color="#22d3ee" transparent opacity={0.55} toneMapped={false} side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  )
}

export function GlobeScene() {
  const globe = runtime.globe
  const mode = useUI((s) => s.mode)
  const controls = useRef<OrbitControlsImpl>(null)
  const { camera, size } = useThree()
  const t0 = useRef<number | null>(null)
  const startPos = useRef(new THREE.Vector3())

  const dots = useMemo(() => {
    const n = globe.points.length / 2
    const pos = new Float32Array(n * 3)
    const rnd = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const v = latLon(globe.points[i * 2], globe.points[i * 2 + 1], R * 1.001)
      pos.set([v.x, v.y, v.z], i * 3)
      rnd[i] = Math.random()
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1))
    const m = new THREE.ShaderMaterial({
      vertexShader: dotVert, fragmentShader: dotFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 } },
    })
    return new THREE.Points(g, m)
  }, [globe])

  const coast = useMemo(() => {
    const segs: number[] = []
    for (const ring of globe.coast) {
      for (let i = 0; i + 3 < ring.length; i += 2) {
        const a = latLon(ring[i], ring[i + 1], R * 1.002)
        const b = latLon(ring[i + 2], ring[i + 3], R * 1.002)
        segs.push(a.x, a.y, a.z, b.x, b.y, b.z)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3))
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#38bdf8', transparent: true, opacity: 0.32 }))
  }, [globe])

  const graticule = useMemo(() => {
    const segs: number[] = []
    for (let lat = -60; lat <= 60; lat += 30) {
      for (let lon = -180; lon < 180; lon += 3) {
        const a = latLon(lat, lon, R * 1.0005)
        const b = latLon(lat, lon + 3, R * 1.0005)
        segs.push(a.x, a.y, a.z, b.x, b.y, b.z)
      }
    }
    for (let lon = -180; lon < 180; lon += 30) {
      for (let lat = -84; lat < 84; lat += 3) {
        const a = latLon(lat, lon, R * 1.0005)
        const b = latLon(lat + 3, lon, R * 1.0005)
        segs.push(a.x, a.y, a.z, b.x, b.y, b.z)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3))
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#1e3a8a', transparent: true, opacity: 0.25 }))
  }, [])

  const atmo = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: atmoVert, fragmentShader: atmoFrag, transparent: true, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false,
    uniforms: { uColor: { value: new THREE.Color('#22d3ee') }, uPower: { value: 5.0 }, uStrength: { value: 1.5 } },
  }), [])
  const rim = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: atmoVert, fragmentShader: atmoFrag, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    uniforms: { uColor: { value: new THREE.Color('#6d5dfc') }, uPower: { value: 3.0 }, uStrength: { value: 0.9 } },
  }), [])

  useEffect(() => {
    // portrait screens see less horizontally: back off so the whole planet fits
    const aspect = size.width / Math.max(1, size.height)
    camera.position.copy(latLon(18, -60, R * 3.1 * Math.max(1, 1.25 / aspect)))
    camera.lookAt(0, 0, 0)
  }, [camera, size.width, size.height])

  useFrame(({ clock }, dt) => {
    ;(dots.material as THREE.ShaderMaterial).uniforms.uTime.value = clock.elapsedTime
    if (mode !== 'descending') {
      t0.current = null
      return
    }
    if (t0.current === null) {
      t0.current = clock.elapsedTime
      startPos.current.copy(camera.position)
    }
    const k = Math.min(1, (clock.elapsedTime - t0.current) / 3.2)
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
    const target = latLon(6.25, -75.569, 1).normalize()
    const dir = startPos.current.clone().normalize().lerp(target, e).normalize()
    const dist = THREE.MathUtils.lerp(startPos.current.length(), R * 1.04, e)
    camera.position.copy(dir.multiplyScalar(dist))
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
    void dt
    if (k >= 1) useUI.setState({ mode: 'city' })
  })

  const hubs = useMemo(() => HUBS.map((h) => ({ ...h, v: latLon(h.lat, h.lon) })), [])

  return (
    <>
      <color attach="background" args={['#02040a']} />
      <Stars radius={600} depth={200} count={6000} factor={6} saturation={0.4} fade speed={0.6} />
      <ambientLight intensity={0.4} />
      <mesh>
        <sphereGeometry args={[R * 0.995, 96, 96]} />
        <meshBasicMaterial color="#040816" />
      </mesh>
      <mesh material={rim}>
        <sphereGeometry args={[R, 96, 96]} />
      </mesh>
      <mesh material={atmo} scale={1.13}>
        <sphereGeometry args={[R, 96, 96]} />
      </mesh>
      <primitive object={graticule} />
      <primitive object={coast} />
      <primitive object={dots} />
      {hubs.map((h) => <Beacon key={h.name} hub={h} />)}
      {hubs.slice(1).map((h, i) => <Arc key={h.name} to={h.v} offset={i * 0.137} color={i % 2 ? '#a78bfa' : '#22d3ee'} />)}
      <Satellite radius={R * 1.35} speed={0.18} tilt={0.5} phase={0} />
      <Satellite radius={R * 1.55} speed={-0.12} tilt={-0.9} phase={2} />
      <Satellite radius={R * 1.25} speed={0.25} tilt={1.2} phase={4} />
      <OrbitControls ref={controls} enabled={mode === 'globe'} enablePan={false} minDistance={R * 1.6} maxDistance={R * 9}
        autoRotate={mode === 'globe'} autoRotateSpeed={0.35} rotateSpeed={0.5} enableDamping />
    </>
  )
}
