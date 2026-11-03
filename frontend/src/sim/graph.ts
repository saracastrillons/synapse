import type { CityData, RoadClass } from './types'

export const LANE_WIDTH = 3.3

export interface DEdge {
  id: number
  from: number
  to: number
  len: number
  lanes: number
  /** free-flow speed, m/s */
  vfree: number
  cls: RoadClass
  name: string
  twoWay: boolean
  /** flat polyline [x0, z0, x1, z1, …] */
  pts: number[]
  /** cumulative length at each polyline vertex */
  cum: number[]
  /** heading (radians) of the last segment — used to group signal approaches */
  endHeading: number
  /** index of the source OSM way segment, shared by both directions */
  raw: number
}

/** Directed road network built from the OSM-derived dataset. */
export class RoadGraph {
  readonly nodeX: Float64Array
  readonly nodeZ: Float64Array
  readonly edges: DEdge[] = []
  readonly out: number[][]
  readonly inc: number[][]
  readonly maxSpeed: number
  private grid = new Map<string, number[]>()
  private static CELL = 80

  constructor(data: CityData) {
    const n = data.roads.nodes.length
    this.nodeX = new Float64Array(n)
    this.nodeZ = new Float64Array(n)
    data.roads.nodes.forEach(([x, z], i) => {
      this.nodeX[i] = x
      this.nodeZ[i] = z
      const key = this.cellKey(x, z)
      const bucket = this.grid.get(key)
      if (bucket) bucket.push(i)
      else this.grid.set(key, [i])
    })
    this.out = Array.from({ length: n }, () => [])
    this.inc = Array.from({ length: n }, () => [])

    data.roads.edges.forEach((r, raw) => {
      const flat = r.pts.flat()
      this.addEdge(r.a, r.b, flat, r, raw)
      if (!r.oneway) {
        const rev: number[] = []
        for (let i = r.pts.length - 1; i >= 0; i--) rev.push(r.pts[i][0], r.pts[i][1])
        this.addEdge(r.b, r.a, rev, r, raw)
      }
    })
    this.maxSpeed = Math.max(...this.edges.map((e) => e.vfree))
  }

  private addEdge(from: number, to: number, pts: number[], r: CityData['roads']['edges'][number], raw: number) {
    const cum = [0]
    for (let i = 2; i < pts.length; i += 2) {
      cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]))
    }
    const k = pts.length
    const e: DEdge = {
      id: this.edges.length, from, to, len: Math.max(1, cum[cum.length - 1]), lanes: Math.max(1, Math.min(4, r.lanes)),
      vfree: (r.speed / 3.6) * 0.8, cls: r.cls, name: r.name, twoWay: !r.oneway, pts, cum,
      endHeading: Math.atan2(pts[k - 1] - pts[k - 3], pts[k - 2] - pts[k - 4]), raw,
    }
    this.edges.push(e)
    this.out[from].push(e.id)
    this.inc[to].push(e.id)
  }

  private cellKey(x: number, z: number) {
    return `${Math.floor(x / RoadGraph.CELL)},${Math.floor(z / RoadGraph.CELL)}`
  }

  nearestNode(x: number, z: number): number {
    let best = -1
    let bestD = Infinity
    for (let r = 0; r < 12 && best < 0; r++) {
      const cx = Math.floor(x / RoadGraph.CELL)
      const cz = Math.floor(z / RoadGraph.CELL)
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          for (const i of this.grid.get(`${cx + dx},${cz + dz}`) ?? []) {
            if (this.out[i].length === 0 || this.inc[i].length === 0) continue
            const d = Math.hypot(this.nodeX[i] - x, this.nodeZ[i] - z)
            if (d < bestD) {
              bestD = d
              best = i
            }
          }
        }
      }
    }
    return best
  }

  /** Point at arc length s on edge e, shifted to the given lane. Returns [x, z, heading]. */
  posAt(e: DEdge, s: number, lane: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
    const { pts, cum } = e
    s = Math.max(0, Math.min(e.len, s))
    let lo = 0
    let hi = cum.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (cum[mid] <= s) lo = mid
      else hi = mid
    }
    const segLen = cum[hi] - cum[lo] || 1
    const t = (s - cum[lo]) / segLen
    const x0 = pts[lo * 2], z0 = pts[lo * 2 + 1], x1 = pts[hi * 2], z1 = pts[hi * 2 + 1]
    const dx = (x1 - x0) / segLen
    const dz = (z1 - z0) / segLen
    const offset = e.twoWay ? LANE_WIDTH * (lane + 0.5) : LANE_WIDTH * (lane - (e.lanes - 1) / 2)
    // right-hand perpendicular in the x/z plane (Colombia drives on the right)
    out[0] = x0 + (x1 - x0) * t - dz * offset
    out[1] = z0 + (z1 - z0) * t + dx * offset
    out[2] = Math.atan2(dz, dx)
    return out
  }

  /** Longest directed edge whose street name contains `name` (deterministic pick for scenarios). */
  findEdgeByName(name: string, near?: [number, number]): number {
    let best = -1
    let score = -Infinity
    const needle = name.toLowerCase()
    for (const e of this.edges) {
      if (!e.name.toLowerCase().includes(needle)) continue
      let sc = e.len
      if (near) {
        const mx = e.pts[Math.floor(e.pts.length / 4) * 2]
        const mz = e.pts[Math.floor(e.pts.length / 4) * 2 + 1]
        sc = e.len - Math.hypot(mx - near[0], mz - near[1]) * 0.5
      }
      if (sc > score) {
        score = sc
        best = e.id
      }
    }
    return best
  }
}
