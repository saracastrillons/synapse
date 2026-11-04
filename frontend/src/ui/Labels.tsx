import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { runtime } from '../runtime'
import { useUI } from '../store'

/**
 * Screen-space labels for the 3D city. React renders plain DOM nodes in the HUD
 * with their world anchor in data attributes; <LabelProjector/> (inside the
 * canvas) projects them every frame and writes the transform directly, so no
 * React work happens per frame and nothing is portalled into the WebGL tree.
 */
const POI_COLORS: Record<string, string> = { hospital: '#ff4d6d', fire: '#ff8a1a', police: '#60a5fa', substation: '#a78bfa' }
const POI_H: Record<string, number> = { hospital: 70, fire: 60, police: 40, substation: 90 }

export function CityLabels() {
  const show = useUI((s) => s.layers.labels)
  const live = useUI((s) => s.live)
  if (!show || !live) return null
  const pois = runtime.data.pois.filter((p) => p.kind !== 'police')
  const sys = runtime.sim.transit
  const stations: { name: string; x: number; y: number; z: number; lines: { ref: string; colour: string }[]; planned?: boolean }[] = []
  sys.lines.forEach((l, li) => l.stations.forEach((st) => {
    const [x, e, z] = sys.posAt(li, st.s)
    const near = stations.find((o) => Math.hypot(o.x - x, o.z - z) < 140)
    if (near) {
      if (!near.lines.some((r) => r.ref === l.ref)) near.lines.push({ ref: l.ref, colour: l.colour })
    } else stations.push({ name: st.name, x, y: (e > 0.01 ? 2 + e * 9.5 : 0.3) + 16, z, lines: [{ ref: l.ref, colour: l.colour }] })
  }))
  for (const l of sys.planned) {
    const cum = [0]
    for (let i = 1; i < l.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(l.pts[i][0] - l.pts[i - 1][0], l.pts[i][1] - l.pts[i - 1][1]))
    for (const st of l.stations) {
      const i = Math.max(0, cum.findIndex((c) => c >= st.s) - 1)
      const p = l.pts[i]
      stations.push({ name: st.name, x: p[0], y: (p[2] > 0 ? 11.5 : 0.3) + 16, z: p[1], lines: [{ ref: l.ref, colour: '#f59e0b' }], planned: true } as (typeof stations)[number])
    }
  }
  const railDown = live.metrics && runtime.sim.state.transitHold != null
  const incidents = live.incidents.filter((i) => i.status !== 'resolved')
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
      {pois.map((p, i) => {
        const sub = p.kind === 'substation' ? live.subs.find((s) => Math.abs(s.x - p.x) < 1 && Math.abs(s.z - p.z) < 1) : undefined
        const off = sub && !sub.online
        const color = off ? '#ff1f4b' : POI_COLORS[p.kind]
        return (
          <div key={`p${i}`} className="label3d" data-anchor="" data-x={p.x} data-y={POI_H[p.kind] + 6} data-z={p.z}
            style={{ position: 'absolute', left: 0, top: 0, borderColor: color + '88', opacity: 0 }}>
            <span style={{ color }}>●</span> {sub?.name ?? p.name}
            <small>{off ? 'OFFLINE · sector blackout' : sub ? `load ${(sub.load / sub.capacity * 100).toFixed(0)}%` : p.kind === 'hospital' ? 'hospital · ambulance base' : 'fire station'}</small>
          </div>
        )
      })}
      {stations.map((st) => (
        <div key={`s${st.name}`} className="label3d station" data-anchor="" data-x={st.x} data-y={st.y} data-z={st.z}
          style={{ position: 'absolute', left: 0, top: 0, opacity: 0 }}>
          {st.lines.map((l) => <span key={l.ref} className="line-badge" style={{ background: l.colour }}>{l.ref}</span>)} {st.name}
          <small>{st.planned ? 'under construction · not in service' : railDown ? 'service suspended' : 'station'}</small>
        </div>
      ))}
      {incidents.map((inc) => {
        const color = inc.kind === 'accident' ? '#ff1f4b' : inc.kind === 'fire' ? '#ff7a1a' : '#f472b6'
        return (
          <div key={`i${inc.id}`} className="label3d" data-anchor="" data-x={inc.x} data-y={100} data-z={inc.z}
            style={{ position: 'absolute', left: 0, top: 0, borderColor: color, opacity: 0, fontWeight: 600 }}>
            <span style={{ color }}>▲</span> {inc.label}
            <small>{inc.status === 'pending' ? 'awaiting unit' : inc.status === 'responding' ? 'unit en route' : 'unit on scene'}</small>
          </div>
        )
      })}
    </div>
  )
}

const v = new THREE.Vector3()
export function LabelProjector() {
  const { camera, size } = useThree()
  useFrame(() => {
    // incidents are rendered last in the DOM; place them first so they win collisions
    const els = [...document.querySelectorAll<HTMLElement>('[data-anchor]')].reverse()
    // HUD panels are translucent glass: treat them as obstacles so labels never bleed through
    const placed: [number, number, number, number][] = [...document.querySelectorAll('.side, .topbar, .tm, .tools, .inspector, .rail, .toasts > *, .modal-back')]
      .map((o) => o.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => [r.left, r.top, r.right, r.bottom])
    els.forEach((el) => {
      v.set(Number(el.dataset.x), Number(el.dataset.y), Number(el.dataset.z))
      const dist = camera.position.distanceTo(v)
      v.project(camera)
      let visible = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1
      const x = ((v.x + 1) / 2) * size.width
      const y = ((1 - v.y) / 2) * size.height
      const scale = Math.max(0.7, Math.min(1.15, 1600 / dist))
      if (visible) {
        // greedy declutter: hide a label whose box overlaps one already shown
        const w = el.offsetWidth * scale
        const h = el.offsetHeight * scale
        const box: [number, number, number, number] = [x - w / 2, y - h, x + w / 2, y]
        if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) visible = false
        else placed.push(box)
      }
      el.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px) scale(${scale})`
      el.style.opacity = visible ? String(Math.max(0, Math.min(1, 1.6 - dist / 3500))) : '0'
    })
  })
  return null
}
