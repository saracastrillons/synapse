import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { runtime } from '../runtime'
import { MODES } from '../sim/transit'
import type { TransitLineData } from '../sim/types'

/** Height of the track for an interpolated elevation value (-1 tunnel · 0 grade · 1 viaduct). */
export const trackY = (e: number) => (e > 0.01 ? 2 + e * 9.5 : e < -0.01 ? 0.3 : 0.32)
const DECK_HALF = 4.6
const TRACK_OFFSET = 2.1

function lineColor(l: TransitLineData) {
  return new THREE.Color(l.colour)
}

/** Concrete deck for viaduct sections, rails for at-grade sections, a dashed trace for tunnels. */
function Guideway({ index }: { index: number }) {
  const sys = runtime.sim.transit
  const line = sys.lines[index]
  const { deck, pillars, rails, tunnel } = useMemo(() => {
    const deckPos: number[] = []
    const deckIdx: number[] = []
    const pillarAt: [number, number, number][] = []
    const railPts: number[] = []
    const tunnelPts: number[] = []
    const step = 8
    let lastPillar = -1e9
    for (let s = 0; s <= line.len; s += step) {
      const sNext = Math.min(line.len, s + step)
      const [x0, e0, z0] = sys.posAt(index, s)
      const [x1, e1, z1] = sys.posAt(index, sNext)
      const y0 = trackY(e0)
      const y1 = trackY(e1)
      if (e0 > 0.01 || e1 > 0.01) {
        const [lx0, , lz0] = sys.posAt(index, s, -DECK_HALF)
        const [rx0, , rz0] = sys.posAt(index, s, DECK_HALF)
        const [lx1, , lz1] = sys.posAt(index, sNext, -DECK_HALF)
        const [rx1, , rz1] = sys.posAt(index, sNext, DECK_HALF)
        const v = deckPos.length / 3
        deckPos.push(lx0, y0, lz0, rx0, y0, rz0, lx1, y1, lz1, rx1, y1, rz1)
        deckIdx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3)
        if (s - lastPillar >= 32 && e0 > 0.5) {
          pillarAt.push([x0, y0, z0])
          lastPillar = s
        }
      }
      if (e0 < -0.01 && e1 < -0.01) tunnelPts.push(x0, 0.35, z0, x1, 0.35, z1)
      else {
        for (const off of [-TRACK_OFFSET - 0.75, -TRACK_OFFSET + 0.75, TRACK_OFFSET - 0.75, TRACK_OFFSET + 0.75]) {
          const [ax, , az] = sys.posAt(index, s, off)
          const [bx, , bz] = sys.posAt(index, sNext, off)
          railPts.push(ax, y0 + 0.25, az, bx, y1 + 0.25, bz)
        }
      }
      if (sNext >= line.len) break
    }
    const deck = new THREE.BufferGeometry()
    deck.setAttribute('position', new THREE.Float32BufferAttribute(deckPos, 3))
    deck.setIndex(deckIdx)
    deck.computeVertexNormals()
    const rails = new THREE.BufferGeometry()
    rails.setAttribute('position', new THREE.Float32BufferAttribute(railPts, 3))
    const tunnel = new THREE.BufferGeometry()
    tunnel.setAttribute('position', new THREE.Float32BufferAttribute(tunnelPts, 3))
    return { deck, pillars: pillarAt, rails, tunnel }
  }, [sys, index, line.len])

  const pillarRef = useRef<THREE.InstancedMesh>(null)
  const pillarGeo = useMemo(() => new THREE.CylinderGeometry(0.9, 1.1, 1, 10), [])
  useEffect(() => {
    const m = pillarRef.current
    if (!m) return
    const m4 = new THREE.Matrix4()
    pillars.forEach(([x, y, z], i) => m.setMatrixAt(i, m4.compose(new THREE.Vector3(x, y / 2, z), new THREE.Quaternion(), new THREE.Vector3(1, y, 1))))
    m.instanceMatrix.needsUpdate = true
  }, [pillars])

  const color = lineColor(line)
  return (
    <group>
      <mesh geometry={deck}>
        <meshBasicMaterial color="#1a2238" side={THREE.DoubleSide} />
      </mesh>
      {pillars.length > 0 && (
        <instancedMesh ref={pillarRef} args={[pillarGeo, undefined, pillars.length]}>
          <meshBasicMaterial color="#232c45" />
        </instancedMesh>
      )}
      <lineSegments geometry={rails}>
        <lineBasicMaterial color={color.clone().multiplyScalar(1.6)} toneMapped={false} transparent opacity={0.9} />
      </lineSegments>
      <lineSegments geometry={tunnel}>
        <lineBasicMaterial color={color} toneMapped={false} transparent opacity={0.35} />
      </lineSegments>
    </group>
  )
}

/** Platforms with a glowing edge in the line colour. */
function Stations() {
  const sys = runtime.sim.transit
  const items = useMemo(() => sys.lines.flatMap((l, li) => l.stations.map((st) => {
    const [x, e, z, h] = sys.posAt(li, st.s)
    const len = l.mode === 'tram' ? 30 : 64
    return { key: `${li}-${st.name}`, x, y: trackY(e), z, h, len, color: l.colour, underground: e < -0.5 }
  })), [sys])
  return (
    <>
      {items.map((it) => (
        <group key={it.key} position={[it.x, it.y, it.z]} rotation-y={-it.h}>
          <mesh position-y={it.underground ? 0.2 : 0.6}>
            <boxGeometry args={[it.len, it.underground ? 0.4 : 1.2, it.underground ? 6 : 14]} />
            <meshBasicMaterial color={it.underground ? it.color : '#26314f'} transparent={it.underground} opacity={it.underground ? 0.35 : 1} toneMapped={false} />
          </mesh>
          {!it.underground && (
            <lineSegments position-y={1.25}>
              <edgesGeometry args={[new THREE.BoxGeometry(it.len, 0.1, 14)]} />
              <lineBasicMaterial color={new THREE.Color(it.color).multiplyScalar(2)} toneMapped={false} />
            </lineSegments>
          )}
        </group>
      ))}
    </>
  )
}

const MAX_CARS = 480

/** Trains: one instance per car, following the track geometry through curves. */
function Trains() {
  const sys = runtime.sim.transit
  const body = useRef<THREE.InstancedMesh>(null)
  const glow = useRef<THREE.InstancedMesh>(null)
  const ghost = useRef<THREE.InstancedMesh>(null)
  const bodyGeo = useMemo(() => new THREE.BoxGeometry(1, 3.4, 2.9), [])
  const glowGeo = useMemo(() => new THREE.BoxGeometry(1, 0.7, 3.05), [])
  const colors = useMemo(() => sys.lines.map((l) => new THREE.Color(l.colour)), [sys])
  const m4 = useMemo(() => new THREE.Matrix4(), [])
  const q = useMemo(() => new THREE.Quaternion(), [])
  const p = useMemo(() => new THREE.Vector3(), [])
  const sc = useMemo(() => new THREE.Vector3(), [])
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), [])
  const white = useMemo(() => new THREE.Color('#dbe4ff'), [])
  const c = useMemo(() => new THREE.Color(), [])

  useFrame(() => {
    const b = body.current
    const g = glow.current
    const gh = ghost.current
    if (!b || !g || !gh) return
    const sim = runtime.sim
    const held = sim.state.transitHold != null
    const sec = sim.transitSec() + (held ? 0 : runtime.alpha)
    let i = 0
    let j = 0
    for (const tr of sys.trains(sec)) {
      const line = sys.lines[tr.line]
      const spec = MODES[line.mode]
      const sign = tr.dir === 0 ? 1 : -1
      const off = tr.dir === 0 ? TRACK_OFFSET : -TRACK_OFFSET
      for (let k = 0; k < spec.cars; k++) {
        const s = tr.s - sign * (k * spec.carLength + spec.carLength / 2)
        if (s < 0 || s > line.len) continue
        const [x, e, z, h] = sys.posAt(tr.line, s, off)
        const y = trackY(e) + 0.25 + 1.75
        q.setFromAxisAngle(up, -h)
        p.set(x, y, z)
        sc.set(spec.carLength - 1.4, 1, 1)
        m4.compose(p, q, sc)
        if (e < -0.5) {
          if (j < MAX_CARS) {
            gh.setMatrixAt(j, m4)
            gh.setColorAt(j, c.copy(colors[tr.line]).multiplyScalar(1.4))
            j++
          }
          continue
        }
        if (i >= MAX_CARS) continue
        b.setMatrixAt(i, m4)
        b.setColorAt(i, c.copy(white).lerp(colors[tr.line], 0.18))
        p.y = y + 0.35
        m4.compose(p, q, sc)
        g.setMatrixAt(i, m4)
        g.setColorAt(i, c.copy(colors[tr.line]).multiplyScalar(held ? 0.6 : 2.4))
        i++
      }
    }
    b.count = i
    g.count = i
    gh.count = j
    for (const m of [b, g, gh]) {
      m.instanceMatrix.needsUpdate = true
      if (m.instanceColor) m.instanceColor.needsUpdate = true
    }
  })
  return (
    <>
      <instancedMesh ref={body} args={[bodyGeo, undefined, MAX_CARS]} frustumCulled={false}>
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={glow} args={[glowGeo, undefined, MAX_CARS]} frustumCulled={false}>
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={ghost} args={[bodyGeo, undefined, MAX_CARS]} frustumCulled={false}>
        <meshBasicMaterial toneMapped={false} transparent opacity={0.35} depthWrite={false} />
      </instancedMesh>
    </>
  )
}

/** A line still under construction: bare viaduct with hazard-orange edges, no trains. */
function Works({ line }: { line: TransitLineData }) {
  const { deck, edges, pillars } = useMemo(() => {
    const cum = [0]
    for (let i = 1; i < line.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(line.pts[i][0] - line.pts[i - 1][0], line.pts[i][1] - line.pts[i - 1][1]))
    const deckPos: number[] = []
    const deckIdx: number[] = []
    const edgePts: number[] = []
    const pil: [number, number, number][] = []
    for (let i = 0; i < line.pts.length - 1; i++) {
      const a = line.pts[i]
      const b = line.pts[i + 1]
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
      const nx = -(b[1] - a[1]) / d
      const nz = (b[0] - a[0]) / d
      const ya = trackY(Math.max(0, a[2]))
      const yb = trackY(Math.max(0, b[2]))
      const v = deckPos.length / 3
      deckPos.push(a[0] - nx * DECK_HALF, ya, a[1] - nz * DECK_HALF, a[0] + nx * DECK_HALF, ya, a[1] + nz * DECK_HALF,
        b[0] - nx * DECK_HALF, yb, b[1] - nz * DECK_HALF, b[0] + nx * DECK_HALF, yb, b[1] + nz * DECK_HALF)
      deckIdx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3)
      for (const side of [-1, 1]) edgePts.push(a[0] + side * nx * DECK_HALF, ya + 0.6, a[1] + side * nz * DECK_HALF, b[0] + side * nx * DECK_HALF, yb + 0.6, b[1] + side * nz * DECK_HALF)
      if (Math.floor(cum[i + 1] / 40) !== Math.floor(cum[i] / 40) && a[2] > 0.5) pil.push([a[0], ya, a[1]])
    }
    const deck = new THREE.BufferGeometry()
    deck.setAttribute('position', new THREE.Float32BufferAttribute(deckPos, 3))
    deck.setIndex(deckIdx)
    const edges = new THREE.BufferGeometry()
    edges.setAttribute('position', new THREE.Float32BufferAttribute(edgePts, 3))
    new THREE.LineSegments(edges).computeLineDistances()
    return { deck, edges, pillars: pil }
  }, [line])
  return (
    <group>
      <mesh geometry={deck}>
        <meshBasicMaterial color="#2a2a33" side={THREE.DoubleSide} transparent opacity={0.85} />
      </mesh>
      <lineSegments geometry={edges}>
        <lineDashedMaterial color="#f59e0b" dashSize={6} gapSize={5} toneMapped={false} />
      </lineSegments>
      {pillars.map(([x, y, z], i) => (
        <mesh key={i} position={[x, y / 2, z]}>
          <cylinderGeometry args={[0.9, 1.1, y, 8]} />
          <meshBasicMaterial color="#3a3a46" />
        </mesh>
      ))}
    </group>
  )
}

export function Transit() {
  const sys = runtime.sim.transit
  if (!sys.lines.length && !sys.planned.length) return null
  return (
    <group>
      {sys.lines.map((_, i) => <Guideway key={i} index={i} />)}
      {sys.planned.map((l) => <Works key={l.id} line={l} />)}
      {sys.lines.length > 0 && <Stations />}
      {sys.lines.length > 0 && <Trains />}
    </group>
  )
}
