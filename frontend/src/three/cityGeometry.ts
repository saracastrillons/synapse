import * as THREE from 'three'
import { LANE_WIDTH, type RoadGraph } from '../sim/graph'
import { sectorOf } from '../sim/engine'
import type { CityData } from '../sim/types'

/** Road ribbons: one strip per directed edge (two-way streets get one strip per side),
 *  so congestion can be coloured per direction. */
export function buildRoadGeometry(g: RoadGraph, laneCount: (e: number) => number) {
  const pos: number[] = []
  const idx: number[] = []
  const start = new Int32Array(g.edges.length)
  const count = new Int32Array(g.edges.length)
  for (const e of g.edges) {
    const lanes = laneCount(e.id)
    const inner = e.twoWay ? 0.35 : -(lanes * LANE_WIDTH) / 2
    const outer = e.twoWay ? lanes * LANE_WIDTH : (lanes * LANE_WIDTH) / 2
    const n = e.pts.length / 2
    start[e.id] = pos.length / 3
    count[e.id] = n * 2
    const y = e.cls === 'arterial' ? 0.12 : e.cls === 'collector' ? 0.09 : 0.06
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1)
      const b = Math.min(n - 1, i + 1)
      let dx = e.pts[b * 2] - e.pts[a * 2]
      let dz = e.pts[b * 2 + 1] - e.pts[a * 2 + 1]
      const l = Math.hypot(dx, dz) || 1
      dx /= l
      dz /= l
      const x = e.pts[i * 2]
      const z = e.pts[i * 2 + 1]
      pos.push(x - dz * inner, y, z + dx * inner, x - dz * outer, y, z + dx * outer)
      if (i > 0) {
        const v = start[e.id] + i * 2
        idx.push(v - 2, v - 1, v, v - 1, v + 1, v)
      }
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3))
  geo.setIndex(idx)
  return { geo, start, count }
}

export const buildingVert = /* glsl */ `
  attribute vec2 aWall;
  attribute float aH;
  attribute float aSector;
  attribute float aSeed;
  attribute float aRoof;
  varying vec2 vWall;
  varying float vH;
  varying float vSector;
  varying float vSeed;
  varying float vRoof;
  varying vec3 vN;
  varying float vDepth;
  varying vec3 vWorld;
  void main() {
    vWall = aWall; vH = aH; vSector = aSector; vSeed = aSeed; vRoof = aRoof;
    vN = normal;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mv = viewMatrix * wp;
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`

export const buildingFrag = /* glsl */ `
  uniform vec4 uPowered;
  uniform float uTime;
  uniform vec3 uFog;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uStorm;
  uniform float uDay;
  varying vec2 vWall;
  varying float vH;
  varying float vSector;
  varying float vSeed;
  varying float vRoof;
  varying vec3 vN;
  varying float vDepth;
  varying vec3 vWorld;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main() {
    float powered = vSector < 0.5 ? uPowered.x : vSector < 1.5 ? uPowered.y : vSector < 2.5 ? uPowered.z : uPowered.w;
    vec3 light = normalize(vec3(0.4, 0.8, 0.3));
    float diff = 0.35 + 0.65 * max(0.0, dot(normalize(vN), light));
    float hk = clamp(vH / 70.0, 0.0, 1.0);
    vec3 base = mix(vec3(0.035, 0.05, 0.10), vec3(0.07, 0.10, 0.19), hk) * diff * (1.0 + 1.3 * uDay);
    vec3 col = base;
    if (vRoof > 0.5) {
      col = vec3(0.045, 0.065, 0.12);
      vec2 gp = fract(vWorld.xz / 6.0);
      float gl = step(0.96, max(gp.x, gp.y));
      col += vec3(0.05, 0.25, 0.35) * gl * 0.25;
    } else {
      // window grid: floors every 3.3 m, bays every 3.2 m
      vec2 cell = vec2(floor(vWall.x / 3.2), floor(vWall.y / 3.3));
      vec2 f = vec2(fract(vWall.x / 3.2), fract(vWall.y / 3.3));
      float win = step(0.18, f.x) * step(f.x, 0.82) * step(0.28, f.y) * step(f.y, 0.78);
      float r = hash(cell + vSeed * 17.0);
      // fewer windows are lit in daylight
      float lit = step(0.5 + 0.38 * uDay, r) * step(1.0, vWall.y) * step(vWall.y, vH - 0.8);
      float flick = 0.85 + 0.15 * sin(uTime * (0.5 + r * 3.0) + r * 40.0);
      vec3 wc = mix(vec3(1.0, 0.72, 0.38), vec3(0.45, 0.85, 1.0), step(0.78, r));
      col += wc * win * lit * flick * 0.85 * powered;
      // emergency lighting during blackout
      col += vec3(0.6, 0.05, 0.08) * win * step(0.94, r) * (1.0 - powered) * (0.6 + 0.4 * sin(uTime * 2.0 + r * 9.0));
      // glowing crown on the top edge
      float crown = smoothstep(vH - 0.9, vH - 0.1, vWall.y);
      col += mix(vec3(0.95, 0.15, 0.25), vec3(0.15, 0.75, 0.95), powered) * crown * (0.35 + 0.4 * hk);
      // ground bounce
      col += vec3(0.05, 0.12, 0.25) * (1.0 - smoothstep(0.0, 8.0, vWall.y)) * 0.6;
    }
    float fog = smoothstep(uFogNear, uFogFar, vDepth);
    col = mix(col, uFog, fog);
    gl_FragColor = vec4(col, 1.0);
  }`

/** Extruded buildings merged into a single geometry, with per-vertex attributes the
 *  shader uses for windows, crowns and per-sector blackouts. */
export function buildBuildingGeometry(data: CityData) {
  const subs = data.pois.filter((p) => p.kind === 'substation')
  const pos: number[] = []
  const nor: number[] = []
  const wall: number[] = []
  const hgt: number[] = []
  const sec: number[] = []
  const seed: number[] = []
  const roof: number[] = []
  const idx: number[] = []
  let v = 0
  data.buildings.forEach((b, bi) => {
    let pts = b.p.map(([x, z]) => new THREE.Vector2(x, z))
    if (THREE.ShapeUtils.isClockWise(pts)) pts = pts.reverse()
    const h = b.h
    const s = sectorOf(subs, pts[0].x, pts[0].y)
    const sd = (bi * 0.6180339) % 1
    let u = 0
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]
      const c = pts[(i + 1) % pts.length]
      const len = a.distanceTo(c)
      const nx = c.y - a.y
      const nz = -(c.x - a.x)
      const nl = Math.hypot(nx, nz) || 1
      // shape is CCW in (x, z): the outward normal is the right-hand side of each edge
      const n = [nx / nl, 0, nz / nl]
      pos.push(a.x, 0, a.y, c.x, 0, c.y, c.x, h, c.y, a.x, h, a.y)
      for (let k = 0; k < 4; k++) nor.push(...n)
      wall.push(u, 0, u + len, 0, u + len, h, u, h)
      for (let k = 0; k < 4; k++) {
        hgt.push(h)
        sec.push(s)
        seed.push(sd)
        roof.push(0)
      }
      idx.push(v, v + 2, v + 1, v, v + 3, v + 2)
      v += 4
      u += len
    }
    const tris = THREE.ShapeUtils.triangulateShape(pts, [])
    const base = v
    for (const p of pts) {
      pos.push(p.x, h, p.y)
      nor.push(0, 1, 0)
      wall.push(0, h)
      hgt.push(h)
      sec.push(s)
      seed.push(sd)
      roof.push(1)
      v++
    }
    for (const t of tris) idx.push(base + t[0], base + t[2], base + t[1])
  })
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  geo.setAttribute('aWall', new THREE.Float32BufferAttribute(wall, 2))
  geo.setAttribute('aH', new THREE.Float32BufferAttribute(hgt, 1))
  geo.setAttribute('aSector', new THREE.Float32BufferAttribute(sec, 1))
  geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1))
  geo.setAttribute('aRoof', new THREE.Float32BufferAttribute(roof, 1))
  geo.setIndex(idx)
  geo.computeBoundingSphere()
  return geo
}

export const flowVert = /* glsl */ `
  attribute float aT;
  varying float vT;
  void main() { vT = aT; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`

export const flowFrag = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uSpeed;
  varying float vT;
  void main() {
    float dash = fract(vT / 18.0 - uTime * uSpeed);
    float a = 0.35 + 0.65 * smoothstep(0.55, 1.0, dash);
    gl_FragColor = vec4(uColor * (0.8 + a * 1.6), a);
  }`

/** Polyline along a list of edges (from s0 on the first), with arc-length attribute for flowing dashes. */
export function routeGeometry(g: RoadGraph, edges: number[], s0 = 0, y = 2.2) {
  const pts: number[] = []
  const ts: number[] = []
  let acc = 0
  let px = NaN
  let pz = NaN
  const tmp: [number, number, number] = [0, 0, 0]
  edges.forEach((eid, k) => {
    const e = g.edges[eid]
    const startS = k === 0 ? s0 : 0
    const steps = Math.max(2, Math.ceil((e.len - startS) / 12))
    for (let i = 0; i <= steps; i++) {
      const s = startS + ((e.len - startS) * i) / steps
      const [x, z] = g.posAt(e, s, 0, tmp)
      if (!isNaN(px)) acc += Math.hypot(x - px, z - pz)
      px = x
      pz = z
      pts.push(x, y, z)
      ts.push(acc)
    }
  })
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  geo.setAttribute('aT', new THREE.Float32BufferAttribute(ts, 1))
  return geo
}
