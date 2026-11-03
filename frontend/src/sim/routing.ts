import type { RoadGraph } from './graph'

export type Algorithm = 'astar' | 'dijkstra'

export interface RouteResult {
  edges: number[]
  /** total cost in seconds of travel time */
  cost: number
  /** nodes popped from the priority queue — proxy for computational effort */
  expanded: number
  algorithm: Algorithm
  found: boolean
}

export interface RouteOptions {
  algorithm?: Algorithm
  /** travel time (s) of an edge; return Infinity to forbid it */
  cost: (edge: number) => number
  /** speed used by the A* heuristic — must be ≥ any achievable speed to stay admissible */
  heuristicSpeed?: number
  /** allow this specific edge even if cost() forbids it (emergency access to a blocked scene) */
  allow?: number
}

/** Binary min-heap keyed by priority, storing node ids. */
class Heap {
  private ids: number[] = []
  private pr: number[] = []
  get size() {
    return this.ids.length
  }
  push(id: number, p: number) {
    const { ids, pr } = this
    let i = ids.length
    ids.push(id)
    pr.push(p)
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (pr[parent] <= p) break
      ids[i] = ids[parent]
      pr[i] = pr[parent]
      i = parent
    }
    ids[i] = id
    pr[i] = p
  }
  pop(): number {
    const { ids, pr } = this
    const top = ids[0]
    const lastId = ids.pop()!
    const lastP = pr.pop()!
    if (ids.length > 0) {
      let i = 0
      const n = ids.length
      while (true) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && pr[c + 1] < pr[c]) c++
        if (pr[c] >= lastP) break
        ids[i] = ids[c]
        pr[i] = pr[c]
        i = c
      }
      ids[i] = lastId
      pr[i] = lastP
    }
    return top
  }
}

/** Shortest travel-time path between two nodes using A* (Euclidean / max-speed
 *  heuristic, admissible) or plain Dijkstra. Both return the same optimal cost;
 *  A* expands far fewer nodes, which the UI reports as evidence. */
export function findRoute(g: RoadGraph, from: number, to: number, opts: RouteOptions): RouteResult {
  const algorithm = opts.algorithm ?? 'astar'
  const n = g.nodeX.length
  // scratch buffers are reused between searches; a generation stamp replaces clearing them
  if (!scratch || scratch.dist.length !== n) {
    scratch = { dist: new Float64Array(n), via: new Int32Array(n), stamp: new Uint32Array(n), closed: new Uint32Array(n), gen: 0 }
  }
  const s = scratch
  const gen = ++s.gen
  const dist = {
    get: (i: number) => (s.stamp[i] === gen ? s.dist[i] : Infinity),
    set: (i: number, d: number, e: number) => {
      s.stamp[i] = gen
      s.dist[i] = d
      s.via[i] = e
    },
  }
  const via = s.via
  const hs = opts.heuristicSpeed ?? g.maxSpeed * 1.15
  const tx = g.nodeX[to]
  const tz = g.nodeZ[to]
  const h = algorithm === 'astar' ? (i: number) => Math.hypot(g.nodeX[i] - tx, g.nodeZ[i] - tz) / hs : () => 0

  const heap = new Heap()
  dist.set(from, 0, -1)
  heap.push(from, h(from))
  let expanded = 0
  while (heap.size > 0) {
    const u = heap.pop()
    if (s.closed[u] === gen) continue
    s.closed[u] = gen
    expanded++
    if (u === to) break
    const du = dist.get(u)
    for (const eid of g.out[u]) {
      const e = g.edges[eid]
      if (s.closed[e.to] === gen) continue
      let c = opts.cost(eid)
      if (!isFinite(c)) {
        if (eid !== opts.allow) continue
        c = e.len / e.vfree
      }
      const nd = du + c
      if (nd < dist.get(e.to)) {
        dist.set(e.to, nd, eid)
        heap.push(e.to, nd + h(e.to))
      }
    }
  }
  if (!isFinite(dist.get(to))) return { edges: [], cost: Infinity, expanded, algorithm, found: false }
  const edges: number[] = []
  for (let v = to; v !== from; ) {
    const eid = via[v]
    edges.push(eid)
    v = g.edges[eid].from
  }
  edges.reverse()
  return { edges, cost: dist.get(to), expanded, algorithm, found: true }
}

let scratch: { dist: Float64Array; via: Int32Array; stamp: Uint32Array; closed: Uint32Array; gen: number } | null = null
