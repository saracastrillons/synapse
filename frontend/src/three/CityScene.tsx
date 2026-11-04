import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { runtime } from '../runtime'
import { useUI } from '../store'
import { LabelProjector } from '../ui/Labels'
import { Transit } from './Transit'
import { daylight } from '../sim/timeofday'
import { buildBuildingGeometry, buildRoadGeometry, buildingFrag, buildingVert, flowFrag, flowVert, routeGeometry } from './cityGeometry'

const FOG = new THREE.Color('#03050b')
const tmp: [number, number, number] = [0, 0, 0]

// ───────────────────────────────────────────── ground
const groundFrag = /* glsl */ `
  uniform vec2 uExtent;
  uniform float uDay;
  varying vec3 vW;
  void main() {
    vec2 p = vW.xz;
    vec2 g1 = abs(fract(p / 50.0 - 0.5) - 0.5) / fwidth(p / 50.0);
    vec2 g2 = abs(fract(p / 250.0 - 0.5) - 0.5) / fwidth(p / 250.0);
    float l1 = 1.0 - min(min(g1.x, g1.y), 1.0);
    float l2 = 1.0 - min(min(g2.x, g2.y), 1.0);
    vec2 q = abs(p) / uExtent;
    float inside = 1.0 - smoothstep(0.95, 1.08, max(q.x, q.y));
    float edge = smoothstep(0.985, 1.0, max(q.x, q.y)) * (1.0 - smoothstep(1.0, 1.006, max(q.x, q.y)));
    float d = length(p) / 4200.0;
    vec3 col = vec3(0.012, 0.02, 0.04) + vec3(0.02, 0.08, 0.14) * l1 * 0.35 * inside + vec3(0.05, 0.2, 0.35) * l2 * 0.4;
    col += vec3(0.1, 0.6, 0.9) * edge * 0.7;
    col = mix(col, vec3(0.012, 0.02, 0.045), smoothstep(0.3, 1.0, d));
    col *= 1.0 + 1.6 * uDay;
    gl_FragColor = vec4(col, 1.0);
  }`
const groundVert = /* glsl */ `
  varying vec3 vW;
  void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`

function Ground() {
  const ext = runtime.data.meta.extent
  const mat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: groundVert, fragmentShader: groundFrag,
    uniforms: { uExtent: { value: new THREE.Vector2(ext.halfWidth, ext.halfHeight) }, uDay: DAY },
  }), [ext])
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 5) return
    handleMapClick(e.point.x, e.point.z)
  }
  return (
    <mesh rotation-x={-Math.PI / 2} material={mat} onClick={onClick}>
      <planeGeometry args={[16000, 16000]} />
    </mesh>
  )
}

function handleMapClick(x: number, z: number) {
  const ui = useUI.getState()
  const sim = runtime.sim
  if (ui.tool === 'select') {
    let best = -1
    let bd = 28
    for (const v of sim.state.vehicles) {
      if (v.edge < 0) continue
      const [vx, vz] = sim.vehiclePosition(v, 0, tmp)
      const d = Math.hypot(vx - x, vz - z)
      if (d < bd) {
        bd = d
        best = v.id
      }
    }
    useUI.setState({ selected: best >= 0 ? best : null, follow: best >= 0 ? ui.follow : false })
    runtime.publish(true)
    return
  }
  // nearest road segment for incident tools
  const g = sim.g
  let best = -1
  let bd = 40
  for (const e of g.edges) {
    for (let i = 0; i + 3 < e.pts.length; i += 2) {
      const ax = e.pts[i], az = e.pts[i + 1], bx = e.pts[i + 2], bz = e.pts[i + 3]
      const dx = bx - ax, dz = bz - az
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)))
      // prefer the carriageway on the clicked side
      const px = ax + dx * t - dz / Math.hypot(dx, dz) * 4
      const pz = az + dz * t + dx / Math.hypot(dx, dz) * 4
      const d = Math.hypot(px - x, pz - z)
      if (d < bd) {
        bd = d
        best = e.id
      }
    }
  }
  if (best < 0) return
  const kind = ui.tool === 'block' ? 'accident' : ui.tool === 'medical' ? 'medical' : 'fire'
  sim.createIncident(kind, best)
  runtime.publish(true)
}

// ───────────────────────────────────────── roads (congestion-coloured)
function Roads() {
  const sim = runtime.sim
  const { geo, start, count } = useMemo(() => buildRoadGeometry(sim.g, (e) => sim.g.edges[e].lanes), [sim])
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, transparent: true, opacity: 0.95 }), [])
  const last = useRef(0)
  const free = useMemo(() => new THREE.Color('#0b4f78'), [])
  const mid = useMemo(() => new THREE.Color('#f59e0b'), [])
  const jam = useMemo(() => new THREE.Color('#ff2d55'), [])
  const blocked = useMemo(() => new THREE.Color('#ff0033'), [])
  useFrame(({ clock }) => {
    if (clock.elapsedTime - last.current < 0.5) return
    last.current = clock.elapsedTime
    const st = sim.state
    const col = geo.getAttribute('color') as THREE.BufferAttribute
    const arr = col.array as Float32Array
    const c = new THREE.Color()
    const blockedEdges = new Set(st.incidents.filter((i) => i.blocks && i.status !== 'resolved').map((i) => i.edge))
    for (const e of sim.g.edges) {
      const cong = st.edgeCount[e.id] > 0 ? Math.max(0, Math.min(1, 1 - st.edgeSpeed[e.id] / e.vfree)) : 0
      if (blockedEdges.has(e.id)) c.copy(blocked).multiplyScalar(1.6 + Math.sin(clock.elapsedTime * 6) * 0.6)
      else if (cong < 0.45) c.copy(free).lerp(mid, cong / 0.45 * 0.6)
      else c.copy(mid).lerp(jam, (cong - 0.45) / 0.55).multiplyScalar(1 + cong * 0.8)
      const bright = e.cls === 'arterial' ? 1.25 : e.cls === 'collector' ? 1 : 0.7
      for (let k = 0; k < count[e.id]; k++) {
        const o = (start[e.id] + k) * 3
        arr[o] = c.r * bright
        arr[o + 1] = c.g * bright
        arr[o + 2] = c.b * bright
      }
    }
    col.needsUpdate = true
  })
  return <mesh geometry={geo} material={mat} />
}

// ───────────────────────────────────────── buildings
function Buildings() {
  const visible = useUI((s) => s.layers.buildings)
  const geo = useMemo(() => buildBuildingGeometry(runtime.data), [])
  const mat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: buildingVert, fragmentShader: buildingFrag, side: THREE.DoubleSide,
    uniforms: {
      uPowered: { value: new THREE.Vector4(1, 1, 1, 1) }, uTime: { value: 0 }, uFog: { value: FOG },
      uFogNear: { value: 1800 }, uFogFar: { value: 5200 }, uStorm: { value: 0 }, uDay: DAY,
    },
  }), [])
  useFrame(({ clock }) => {
    const subs = runtime.sim.state.subs
    const p = mat.uniforms.uPowered.value as THREE.Vector4
    const target = [0, 1, 2, 3].map((i) => (subs[i] ? (subs[i].online ? 1 : 0) : 1))
    p.set(p.x + (target[0] - p.x) * 0.08, p.y + (target[1] - p.y) * 0.08, p.z + (target[2] - p.z) * 0.08, p.w + (target[3] - p.w) * 0.08)
    mat.uniforms.uTime.value = clock.elapsedTime
  })
  return <mesh geometry={geo} material={mat} visible={visible} />
}

// ───────────────────────────────────────── vehicles
const MAX_VEH = 3200
function Vehicles() {
  const ref = useRef<THREE.InstancedMesh>(null)
  const halo = useRef<THREE.InstancedMesh>(null)
  const geo = useMemo(() => new THREE.BoxGeometry(4.4, 1.5, 2), [])
  const haloGeo = useMemo(() => new THREE.PlaneGeometry(9, 4.5).rotateX(-Math.PI / 2), [])
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false }), [])
  const haloMat = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending }), [])
  const m4 = useMemo(() => new THREE.Matrix4(), [])
  const q = useMemo(() => new THREE.Quaternion(), [])
  const p = useMemo(() => new THREE.Vector3(), [])
  const s = useMemo(() => new THREE.Vector3(), [])
  const c = useMemo(() => new THREE.Color(), [])
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), [])
  const palette = useMemo(() => ({
    static: new THREE.Color('#5ed3f3').multiplyScalar(1.3),
    adaptive: new THREE.Color('#b9a6ff').multiplyScalar(1.6),
    bus: new THREE.Color('#fbbf24').multiplyScalar(1.6),
    taxi: new THREE.Color('#fde047').multiplyScalar(1.5),
    fire: new THREE.Color('#ff7a1a').multiplyScalar(2.4),
    selected: new THREE.Color('#ffffff').multiplyScalar(3),
  }), [])

  useFrame(({ clock }) => {
    const mesh = ref.current
    const hm = halo.current
    if (!mesh || !hm) return
    const sim = runtime.sim
    const sel = useUI.getState().selected
    const alpha = runtime.alpha
    let i = 0
    for (const v of sim.state.vehicles) {
      if (v.edge < 0 || i >= MAX_VEH) continue
      const [x, z, h] = sim.vehiclePosition(v, v.v * alpha, tmp)
      const big = v.kind === 'bus' ? 2.3 : v.mission ? 1.5 : 1
      const isSel = v.id === sel
      p.set(x, 0.9 * (v.kind === 'bus' ? 1.5 : 1), z)
      q.setFromAxisAngle(up, -h)
      s.set(big * (isSel ? 1.4 : 1), (v.kind === 'bus' ? 1.6 : 1) * (isSel ? 1.4 : 1), (v.kind === 'bus' ? 1.25 : 1) * (isSel ? 1.4 : 1))
      m4.compose(p, q, s)
      mesh.setMatrixAt(i, m4)
      p.y = 0.2
      s.set(big * (isSel ? 2.5 : 1), 1, isSel ? 2.5 : 1)
      m4.compose(p, q, s)
      hm.setMatrixAt(i, m4)
      if (isSel) c.copy(palette.selected)
      else if (v.kind === 'ambulance') c.set(Math.sin(clock.elapsedTime * 14 + v.id) > 0 ? '#ff1f4b' : '#3b82f6').multiplyScalar(3)
      else if (v.kind === 'fire') c.copy(palette.fire)
      else if (v.kind === 'bus') c.copy(palette.bus)
      else if (v.kind === 'taxi') c.copy(palette.taxi)
      else c.copy(v.strategy === 'adaptive' ? palette.adaptive : palette.static)
      if (!v.mission && v.v < 0.5 && !isSel) c.lerp(new THREE.Color('#ff3355').multiplyScalar(1.6), 0.55)
      mesh.setColorAt(i, c)
      hm.setColorAt(i, c)
      i++
    }
    mesh.count = i
    hm.count = i
    mesh.instanceMatrix.needsUpdate = true
    hm.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    if (hm.instanceColor) hm.instanceColor.needsUpdate = true
  })
  return (
    <>
      <instancedMesh ref={ref} args={[geo, mat, MAX_VEH]} frustumCulled={false} />
      <instancedMesh ref={halo} args={[haloGeo, haloMat, MAX_VEH]} frustumCulled={false} />
    </>
  )
}

// ───────────────────────────────────────── signals
function Signals() {
  const visible = useUI((s) => s.layers.signals)
  const ref = useRef<THREE.InstancedMesh>(null)
  const sim = runtime.sim
  const heads = useMemo(() => {
    const out: { edge: number; sig: number; x: number; z: number }[] = []
    sim.state.signals.forEach((sg, si) => {
      for (const grp of sg.groups) for (const e of grp) {
        const edge = sim.g.edges[e]
        const [x, z] = sim.g.posAt(edge, Math.max(0, edge.len - 3), edge.twoWay ? edge.lanes : 0, tmp)
        out.push({ edge: e, sig: si, x, z })
      }
    })
    return out
  }, [sim])
  const geo = useMemo(() => new THREE.SphereGeometry(1.6, 10, 10), [])
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false }), [])
  const c = useMemo(() => new THREE.Color(), [])
  useEffect(() => {
    const m4 = new THREE.Matrix4()
    heads.forEach((h, i) => ref.current?.setMatrixAt(i, m4.makeTranslation(h.x, 5, h.z)))
    if (ref.current) ref.current.instanceMatrix.needsUpdate = true
  }, [heads])
  useFrame(({ clock }) => {
    const mesh = ref.current
    if (!mesh || !visible) return
    const st = sim.state
    heads.forEach((h, i) => {
      const sg = st.signals[h.sig]
      const dark = !st.subs[sg.sector]?.online
      if (dark) c.set('#f59e0b').multiplyScalar(Math.sin(clock.elapsedTime * 5) > 0 ? 2.2 : 0.15)
      else if (sg.clear > 0) c.set('#ff3b3b').multiplyScalar(2)
      else if (sim.signalGroupOf[h.edge] === sg.phase) c.set(sg.preempt >= 0 ? '#ffffff' : '#22ff88').multiplyScalar(2.4)
      else c.set('#ff2244').multiplyScalar(2)
      mesh.setColorAt(i, c)
    })
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  })
  return <instancedMesh ref={ref} args={[geo, mat, heads.length]} visible={visible} />
}

// ───────────────────────────────────────── points of interest
const POI_STYLE: Record<string, { color: string; h: number }> = {
  hospital: { color: '#ff4d6d', h: 70 },
  fire: { color: '#ff8a1a', h: 60 },
  police: { color: '#60a5fa', h: 40 },
  substation: { color: '#a78bfa', h: 90 },
}

function Pois() {
  const live = useUI((s) => s.live)
  const pois = runtime.data.pois
  const subs = live?.subs ?? []
  return (
    <>
      {pois.map((p, i) => {
        const st = POI_STYLE[p.kind]
        const sub = p.kind === 'substation' ? subs.find((s) => Math.abs(s.x - p.x) < 1 && Math.abs(s.z - p.z) < 1) : undefined
        const offline = sub && !sub.online
        const color = offline ? '#ff1f4b' : st.color
        return (
          <group key={i} position={[p.x, 0, p.z]}>
            <mesh position={[0, st.h / 2, 0]}>
              <cylinderGeometry args={[0.6, 2.6, st.h, 12, 1, true]} />
              <meshBasicMaterial color={color} transparent opacity={0.45} toneMapped={false} side={THREE.DoubleSide} depthWrite={false} blending={THREE.AdditiveBlending} />
            </mesh>
            <PulseRing color={color} radius={p.kind === 'substation' ? 22 : 12} speed={offline ? 2.5 : 0.6} />
          </group>
        )
      })}
    </>
  )
}

function PulseRing({ color, radius, speed }: { color: string; radius: number; speed: number }) {
  const ref = useRef<THREE.Mesh>(null)
  useFrame(({ clock }) => {
    if (!ref.current) return
    const k = (clock.elapsedTime * speed) % 1
    ref.current.scale.setScalar(0.3 + k)
    ;(ref.current.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.8
  })
  return (
    <mesh ref={ref} rotation-x={-Math.PI / 2} position-y={0.4}>
      <ringGeometry args={[radius * 0.86, radius, 48]} />
      <meshBasicMaterial color={color} transparent toneMapped={false} depthWrite={false} />
    </mesh>
  )
}

// ───────────────────────────────────────── incidents
function Incidents() {
  const live = useUI((s) => s.live)
  const active = (live?.incidents ?? []).filter((i) => i.status !== 'resolved')
  return (
    <>
      {active.map((inc) => {
        const color = inc.kind === 'accident' ? '#ff1f4b' : inc.kind === 'fire' ? '#ff7a1a' : '#f472b6'
        return (
          <group key={inc.id} position={[inc.x, 0, inc.z]}>
            <PulseRing color={color} radius={38} speed={1.2} />
            <PulseRing color={color} radius={16} speed={2} />
            <mesh position-y={45}>
              <cylinderGeometry args={[1.2, 1.2, 90, 8, 1, true]} />
              <meshBasicMaterial color={color} transparent opacity={0.8} toneMapped={false} />
            </mesh>
          </group>
        )
      })}
    </>
  )
}

// ───────────────────────────────────────── routes (emergency + selected agent + copilot highlights)
function FlowLine({ geometry, color, speed = 1.2 }: { geometry: THREE.BufferGeometry; color: string; speed?: number }) {
  const mat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: flowVert, fragmentShader: flowFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uSpeed: { value: speed } },
  }), [color, speed])
  useFrame(({ clock }) => (mat.uniforms.uTime.value = clock.elapsedTime))
  const line = useMemo(() => new THREE.Line(geometry, mat), [geometry, mat])
  return <primitive object={line} />
}

function Routes() {
  const routes = useUI((s) => s.layers.routes)
  const selected = useUI((s) => s.selected)
  const highlight = useUI((s) => s.highlight)
  const live = useUI((s) => s.live)
  const sim = runtime.sim
  // rebuild ~5 Hz with the live view
  const lines = useMemo(() => {
    void live
    const out: { key: string; geo: THREE.BufferGeometry; color: string }[] = []
    if (routes) {
      for (const v of sim.state.vehicles) {
        if (!v.mission || v.edge < 0 || v.mission.phase === 'onScene') continue
        out.push({ key: `m${v.id}`, geo: routeGeometry(sim.g, v.route.slice(v.ri), v.s, 3), color: v.kind === 'fire' ? '#ff8a1a' : '#ff2d55' })
      }
    }
    if (selected != null) {
      const v = sim.state.vehicles.find((x) => x.id === selected)
      if (v && v.edge >= 0) out.push({ key: `s${v.id}`, geo: routeGeometry(sim.g, v.route.slice(v.ri), v.s, 3.4), color: '#c4b5fd' })
    }
    return out
  }, [live, routes, selected, sim])
  const hl = useMemo(() => (highlight ? highlight.edges.map((e) => routeGeometry(sim.g, [e], 0, 4)) : []), [highlight, sim])
  useEffect(() => () => lines.forEach((l) => l.geo.dispose()), [lines])
  return (
    <>
      {lines.map((l) => <FlowLine key={l.key} geometry={l.geo} color={l.color} />)}
      {hl.map((g, i) => <FlowLine key={`h${i}`} geometry={g} color={highlight!.color} speed={0.6} />)}
    </>
  )
}

// ───────────────────────────────────────── congestion heatmap
const heatVert = /* glsl */ `
  attribute float aW;
  varying float vW;
  void main() {
    vW = aW;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // edges without a queue get no sprite at all (otherwise 10k faint blobs tint the whole city)
    gl_PointSize = aW < 0.01 ? 0.0 : (40.0 + aW * 110.0) * (700.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }`
const heatFrag = /* glsl */ `
  varying float vW;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    vec3 col = mix(vec3(1.0, 0.55, 0.1), vec3(1.0, 0.1, 0.3), vW);
    gl_FragColor = vec4(col * a * (0.25 + vW * 0.6), a * 0.5);
  }`

function Heatmap() {
  const visible = useUI((s) => s.layers.heatmap)
  const sim = runtime.sim
  const n = sim.g.edges.length
  const { points, geo } = useMemo(() => {
    const pos = new Float32Array(n * 3)
    sim.g.edges.forEach((e, i) => {
      const [x, z] = sim.g.posAt(e, e.len / 2, 0, tmp)
      pos.set([x, 6, z], i * 3)
    })
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('aW', new THREE.BufferAttribute(new Float32Array(n), 1))
    const mat = new THREE.ShaderMaterial({ vertexShader: heatVert, fragmentShader: heatFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    return { points: new THREE.Points(geo, mat), geo }
  }, [sim, n])
  const last = useRef(0)
  useFrame(({ clock }) => {
    if (!visible || clock.elapsedTime - last.current < 0.6) return
    last.current = clock.elapsedTime
    const st = sim.state
    const w = geo.getAttribute('aW') as THREE.BufferAttribute
    const arr = w.array as Float32Array
    // only queues matter: weight = delay × vehicles, ignore empty or flowing edges
    for (let i = 0; i < n; i++) {
      const e = sim.g.edges[i]
      const cong = 1 - st.edgeSpeed[i] / e.vfree
      const c = st.edgeCount[i]
      arr[i] = c >= 3 && cong > 0.45 ? Math.min(1, (cong - 0.45) * 1.4 * Math.min(1, c / 10)) : 0
    }
    w.needsUpdate = true
    // hide zero-weight points by drawing order: cheap enough to let the shader fade them
    ;(points.material as THREE.ShaderMaterial).visible = true
  })
  return <primitive object={points} visible={visible} />
}

// ───────────────────────────────────────── power grid layer
function Grid() {
  const visible = useUI((s) => s.layers.grid)
  const live = useUI((s) => s.live)
  const sim = runtime.sim
  const geos = useMemo(() => {
    return sim.state.subs.map((sub, si) => {
      const pts: number[] = []
      for (const sg of sim.state.signals) {
        if (sg.sector !== si) continue
        pts.push(sub.x, 30, sub.z, sim.g.nodeX[sg.node], 2, sim.g.nodeZ[sg.node])
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
      return g
    })
  }, [sim])
  if (!visible) return null
  return (
    <>
      {geos.map((g, i) => (
        <lineSegments key={i} geometry={g}>
          <lineBasicMaterial color={live?.subs[i]?.online === false ? '#ff1f4b' : ['#a78bfa', '#22d3ee', '#34d399', '#fbbf24'][i % 4]} transparent opacity={0.35} toneMapped={false} />
        </lineSegments>
      ))}
    </>
  )
}

// ───────────────────────────────────────── weather
function Weather() {
  // storm events change the engine params directly, so read them from the published live view
  const storm = useUI((s) => (s.live ? runtime.sim.state.params.storm : 0))
  const light = useRef<THREE.AmbientLight>(null)
  const N = 9000
  const rain = useMemo(() => {
    const pos = new Float32Array(N * 6)
    for (let i = 0; i < N; i++) {
      const x = (Math.random() - 0.5) * 3600
      const z = (Math.random() - 0.5) * 3600
      const y = Math.random() * 900
      pos.set([x, y, z, x + 2, y - 18, z + 1], i * 6)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uAmt: { value: 0 } },
      vertexShader: `uniform float uTime; varying float vA; void main(){ vec3 p = position; p.y = mod(p.y - uTime * 420.0, 900.0); vA = p.y / 900.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(p,1.0);} `,
      fragmentShader: `uniform float uAmt; varying float vA; void main(){ gl_FragColor = vec4(vec3(0.55,0.75,1.0) * 0.5, 0.35 * uAmt * (0.3 + vA)); }`,
    })
    return new THREE.LineSegments(g, m)
  }, [])
  const flash = useRef(0)
  useFrame(({ clock }, dt) => {
    const m = rain.material as THREE.ShaderMaterial
    m.uniforms.uTime.value = clock.elapsedTime
    m.uniforms.uAmt.value += (storm - m.uniforms.uAmt.value) * 0.05
    if (storm > 0.3 && Math.random() < dt * storm * 0.25) flash.current = 1
    flash.current = Math.max(0, flash.current - dt * 3)
    if (light.current) light.current.intensity = 0.25 + flash.current * 3 * (Math.random() > 0.3 ? 1 : 0.2)
  })
  return (
    <>
      <ambientLight ref={light} intensity={0.25} color="#9db4ff" />
      <primitive object={rain} visible={storm > 0.01} />
    </>
  )
}

// ───────────────────────────────────────── camera
function CameraRig() {
  const controls = useRef<OrbitControlsImpl>(null)
  const { camera } = useThree()
  const focus = useUI((s) => s.focus)
  const intro = useRef(0)
  const goal = useRef<{ target: THREE.Vector3; pos: THREE.Vector3 } | null>(null)
  useEffect(() => {
    camera.position.set(0, 4200, 600)
    camera.lookAt(0, 0, 0)
    ;(camera as THREE.PerspectiveCamera).far = 20000
    camera.updateProjectionMatrix()
    intro.current = 0
  }, [camera])
  useEffect(() => {
    if (!focus || !controls.current) return
    const d = focus.dist ?? 700
    const dir = camera.position.clone().sub(controls.current.target).normalize()
    goal.current = { target: new THREE.Vector3(focus.x, 0, focus.z), pos: new THREE.Vector3(focus.x, 0, focus.z).add(dir.multiplyScalar(d)) }
  }, [focus, camera])
  useFrame((_, dt) => {
    const c = controls.current
    if (!c) return
    if (intro.current < 1) {
      intro.current = Math.min(1, intro.current + dt / 3.5)
      const e = 1 - Math.pow(1 - intro.current, 3)
      camera.position.lerpVectors(new THREE.Vector3(0, 4200, 600), new THREE.Vector3(1250, 1150, 1650), e)
      c.target.set(0, 0, 0)
    } else if (goal.current) {
      c.target.lerp(goal.current.target, 0.07)
      camera.position.lerp(goal.current.pos, 0.07)
      if (camera.position.distanceTo(goal.current.pos) < 2) goal.current = null
    }
    const { follow, selected } = useUI.getState()
    if (follow && selected != null) {
      const v = runtime.sim.state.vehicles.find((x) => x.id === selected)
      if (v && v.edge >= 0) {
        const [x, z] = runtime.sim.vehiclePosition(v, v.v * runtime.alpha, tmp)
        const delta = new THREE.Vector3(x, 0, z).sub(c.target)
        c.target.add(delta.multiplyScalar(0.15))
        camera.position.add(delta)
      }
    }
    c.update()
  })
  return (
    <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.08} maxPolarAngle={1.32} minDistance={60} maxDistance={6000}
      screenSpacePanning={false} zoomSpeed={0.9} />
  )
}

// ───────────────────────────────────────── day / night
/** shared uniform: 0 night … 1 daylight (driven by the simulated clock) */
const DAY = { value: 0 }
const NIGHT_SKY = new THREE.Color('#03050b')
const DAY_SKY = new THREE.Color('#0f1a33')

function DayNight() {
  const { scene } = useThree()
  const sun = useRef<THREE.DirectionalLight>(null)
  useFrame(() => {
    const target = daylight(runtime.sim.hour())
    DAY.value += (target - DAY.value) * 0.05
    const sky = scene.background instanceof THREE.Color ? scene.background : null
    if (sky) sky.lerpColors(NIGHT_SKY, DAY_SKY, DAY.value)
    FOG.lerpColors(NIGHT_SKY, DAY_SKY, DAY.value)
    if (scene.fog) scene.fog.color.copy(FOG)
    if (sun.current) sun.current.intensity = 0.6 + 1.1 * DAY.value
  })
  return <directionalLight ref={sun} position={[600, 1200, 400]} intensity={0.6} color="#c7d2fe" />
}

function SimDriver() {
  useFrame((_, dt) => runtime.frame(dt))
  return null
}

export function CityScene() {
  return (
    <>
      <color attach="background" args={['#03050b']} />
      <fog attach="fog" args={[FOG, 1800, 5200]} />
      <DayNight />
      <SimDriver />
      <LabelProjector />
      <CameraRig />
      <Weather />
      <Ground />
      <Roads />
      <Transit />
      <Buildings />
      <Heatmap />
      <Grid />
      <Signals />
      <Vehicles />
      <Routes />
      <Pois />
      <Incidents />
    </>
  )
}
