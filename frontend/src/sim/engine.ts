import { RoadGraph, type DEdge } from './graph'
import { findRoute, type Algorithm, type RouteResult } from './routing'
import { hashSeed, nextRandom } from './rng'
import { demandProfile, hourAt } from './timeofday'
import { TransitSystem } from './transit'
import type {
  CityData, DispatchDecision, Incident, IncidentKind, Metrics, ScheduledEvent, Signal, SimParams, SimState,
  Substation, Unit, Vehicle, VehicleKind,
} from './types'

/** Fixed simulation step (s). Everything is deterministic for a given seed + event list. */
export const DT = 0.2
const VEH_LEN = 5.5
const IDM_A = 1.6
const IDM_B = 2.5
const SIGNAL_PENALTY = 8
const HISTORY_EVERY = 5
const MAX_HISTORY = 2400

const SCENE_TIME: Record<IncidentKind, number> = { accident: 150, medical: 120, fire: 240 }
/** share of trips that move to the road network when rail service is fully suspended */
const TRANSIT_SHIFT = 0.18

export function sectorOf(subs: { x: number; z: number }[], x: number, z: number): number {
  let best = 0
  let bd = Infinity
  subs.forEach((s, i) => {
    const d = Math.hypot(s.x - x, s.z - z)
    if (d < bd) {
      bd = d
      best = i
    }
  })
  return best
}

/** Readable substation names in the city's language ("Substation" alone → "Substation #2"). */
function substationName(raw: string, i: number, country: string) {
  const spanish = /colombia|m[eé]xico|espa|argentina|chile|per[uú]|ecuador|venezuela|bolivia|uruguay|paraguay/i.test(country)
  const word = spanish ? 'Subestación' : 'Substation'
  if (/^(substation|subestaci[oó]n)$/i.test(raw.trim())) return `${word} #${i + 1}`
  if (/substation|subestaci[oó]n/i.test(raw)) return raw.replace(/Subestacion/g, 'Subestación')
  return `${word} ${raw}`
}

export function fmtDuration(sec: number): string {
  if (!isFinite(sec)) return '—'
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
}

/**
 * Agent-based urban simulation of the Medellín digital twin.
 *
 *  - vehicles: Intelligent Driver Model car-following on a lane-level directed graph
 *  - routing: A* / Dijkstra on live or free-flow travel times
 *  - junctions: fixed-time, adaptive max-pressure or blackout (all-way stop) signals,
 *    with emergency pre-emption
 *  - emergencies: ETA-minimising dispatch of ambulances / fire trucks
 *  - power grid: substations with load, storm & overload hazard, repair crews
 *
 * The whole mutable state lives in `state` (plain data + typed arrays) so it can
 * be snapshotted with structuredClone for the Time Machine and replayed exactly.
 */
export class Simulation {
  readonly g: RoadGraph
  readonly transit: TransitSystem
  readonly data: CityData
  state!: SimState

  /** node → signal index (-1 = none) */
  readonly signalAt: Int32Array
  /** edge → approach group (0/1) at the signal ending it, -1 if none */
  readonly signalGroupOf: Int8Array
  readonly junction: Uint8Array
  readonly sectorOfNode: Uint8Array
  readonly baseLoad: number[]
  private signalTemplate: Signal[] = []
  private spawnCum: number[] = []
  private accidentCum: number[] = []
  private destNodes: number[] = []
  readonly unitHomes: { kind: 'ambulance' | 'fire'; node: number; name: string }[] = []
  readonly hospitalNodes: { node: number; name: string }[] = []

  // derived per step (not part of snapshots)
  private lanes = new Map<number, Vehicle[]>()
  private edgeQueue: Uint16Array
  private blockedS = new Map<number, number>()
  private tmpPos: [number, number, number] = [0, 0, 0]

  constructor(data: CityData, params: SimParams, events: ScheduledEvent[] = []) {
    this.data = data
    this.g = new RoadGraph(data)
    const g = this.g
    const nNodes = g.nodeX.length
    this.signalAt = new Int32Array(nNodes).fill(-1)
    this.signalGroupOf = new Int8Array(g.edges.length).fill(-1)
    this.junction = new Uint8Array(nNodes)
    this.edgeQueue = new Uint16Array(g.edges.length)

    const subs = data.pois.filter((p) => p.kind === 'substation')
    this.sectorOfNode = new Uint8Array(nNodes)
    for (let i = 0; i < nNodes; i++) {
      this.sectorOfNode[i] = sectorOf(subs, g.nodeX[i], g.nodeZ[i])
      if (g.inc[i].length + g.out[i].length >= 5) this.junction[i] = 1
    }
    this.baseLoad = subs.map(() => 0)
    for (const b of data.buildings) {
      const [x, z] = b.p[0]
      const area = Math.abs(b.p.reduce((acc, p, i) => {
        const q = b.p[(i + 1) % b.p.length]
        return acc + p[0] * q[1] - q[0] * p[1]
      }, 0)) / 2
      this.baseLoad[sectorOf(subs, x, z)] += (area * b.h) / 3.2 * 0.012 // ≈12 W/m² floor area → kW
    }

    this.buildSignals()

    // demand generators: longer, wider, more important roads attract more trips
    const w = { arterial: 2.2, collector: 1.5, local: 0.8 }
    let acc = 0
    let accA = 0
    for (const e of g.edges) {
      acc += e.len * e.lanes * w[e.cls]
      this.spawnCum.push(acc)
      accA += e.cls === 'local' ? 0 : e.len * e.lanes * (e.cls === 'arterial' ? 3 : 1)
      this.accidentCum.push(accA)
    }
    for (let i = 0; i < nNodes; i++) if (g.out[i].length && g.inc[i].length) this.destNodes.push(i)

    for (const p of data.pois) {
      if (p.kind === 'hospital' && !/mental|ips/i.test(p.name)) {
        const node = g.nearestNode(p.x, p.z)
        this.hospitalNodes.push({ node, name: p.name })
      }
    }
    for (const p of data.pois) {
      if (p.kind === 'fire') this.unitHomes.push({ kind: 'fire', node: g.nearestNode(p.x, p.z), name: p.name })
    }
    this.transit = new TransitSystem(data, Math.max(params.metro, 0.001))
    this.reset(params, events)
  }

  private buildSignals() {
    const g = this.g
    const order = [...Array(g.nodeX.length).keys()].sort((a, b) => {
      const na = g.inc[a].filter((e) => g.edges[e].cls !== 'local').length
      const nb = g.inc[b].filter((e) => g.edges[e].cls !== 'local').length
      return nb - na || a - b
    })
    const placed: number[] = []
    for (const node of order) {
      const inc = g.inc[node]
      const major = inc.filter((e) => g.edges[e].cls !== 'local')
      if (major.length < 2) continue
      const ref = g.edges[major[0]].endHeading
      const groups: [number[], number[]] = [[], []]
      for (const e of inc) {
        let d = Math.abs(g.edges[e].endHeading - ref) % Math.PI
        d = Math.min(d, Math.PI - d)
        groups[d < Math.PI / 4 ? 0 : 1].push(e)
      }
      const hasMajor = (gr: number[]) => gr.some((e) => g.edges[e].cls !== 'local')
      if (!hasMajor(groups[0]) || !hasMajor(groups[1])) continue
      if (placed.some((p) => Math.hypot(g.nodeX[p] - g.nodeX[node], g.nodeZ[p] - g.nodeZ[node]) < 32)) continue
      placed.push(node)
      this.signalAt[node] = this.signalTemplate.length
      groups.forEach((gr, gi) => gr.forEach((e) => (this.signalGroupOf[e] = gi)))
      this.signalTemplate.push({
        node, groups, phase: 0, pt: 0, clear: 0, preempt: -1, preemptUntil: 0, sector: this.sectorOfNode[node],
      })
    }
  }

  get signalCount() {
    return this.signalTemplate.length
  }

  reset(params: SimParams, events: ScheduledEvent[] = []) {
    const g = this.g
    const nE = g.edges.length
    const subsPoi = this.data.pois.filter((p) => p.kind === 'substation')
    const subs: Substation[] = subsPoi.map((p, i) => ({
      name: substationName(p.name, i, this.data.meta.country),
      x: p.x, z: p.z, capacity: this.baseLoad[i] * 1.22, load: this.baseLoad[i], online: true, repairAt: 0, failures: 0,
    }))
    const units: Unit[] = []
    for (const h of this.hospitalNodes) {
      for (let k = 0; k < params.ambulances; k++) {
        units.push({ id: units.length, kind: 'ambulance', home: h.node, name: `AMB-${units.length + 1} · ${h.name}`, status: 'idle', vehicle: -1 })
      }
    }
    for (const f of this.unitHomes) {
      for (let k = 0; k < 2; k++) {
        units.push({ id: units.length, kind: 'fire', home: f.node, name: `FIRE-${k + 1} · ${f.name}`, status: 'idle', vehicle: -1 })
      }
    }
    const edgeSpeed = new Float32Array(nE)
    const edgeMean = new Float32Array(nE)
    g.edges.forEach((e, i) => {
      edgeSpeed[i] = e.vfree
      edgeMean[i] = e.vfree
    })
    this.state = {
      t: 0, rng: hashSeed(params.seed), nextId: 1, params: { ...params }, vehicles: [],
      signals: this.signalTemplate.map((s, i) => ({ ...s, phase: (i % 2) as 0 | 1, pt: (i * 7) % 25 })),
      edgeSpeed, edgeMean, edgeVar: new Float32Array(nE).fill(4), edgeCount: new Uint16Array(nE),
      edgeAlertAt: new Float32Array(nE).fill(-1e9),
      incidents: [], units, subs, alerts: [], history: [], metrics: emptyMetrics(),
      arrivalsLog: [], tripLog: [], responseLog: [], events: [...events].sort((a, b) => a.t - b.t),
      rerouteQueue: [], nextAlertId: 1, removed: 0, arrivals: 0, transitHold: null, acc: { second: 0, sample: 0, spawnBudget: 0 },
    }
    // warm start: populate the network instantly so experiments begin in a loaded state
    this.syncTransit()
    const target = this.demandTarget()
    for (let i = 0; i < target; i++) this.spawnVehicle(true)
    this.alert('info', `Simulation initialised · seed ${params.seed} · ${params.vehicles} agents · ${this.signalCount} signalised junctions`)
  }

  // ───────────────────────────────────────── helpers
  private rand() {
    return nextRandom(this.state)
  }

  laneCount(e: DEdge) {
    return Math.max(1, Math.min(4, Math.round(e.lanes * this.state.params.capacity)))
  }

  weather() {
    return 1 - 0.35 * this.state.params.storm
  }

  isBlocked(edge: number) {
    return this.blockedS.has(edge)
  }

  /** live travel-time estimate used by connected (adaptive) agents and dispatch */
  liveCost = (edge: number) => {
    if (this.blockedS.has(edge)) return Infinity
    const e = this.g.edges[edge]
    return e.len / Math.max(1, this.state.edgeSpeed[edge]) + (this.signalGroupOf[edge] >= 0 ? SIGNAL_PENALTY : 0)
  }

  /** free-flow travel time — what a non-connected driver "knows" */
  staticCost = (edge: number) => {
    if (this.blockedS.has(edge)) return Infinity
    const e = this.g.edges[edge]
    return e.len / e.vfree + (this.signalGroupOf[edge] >= 0 ? SIGNAL_PENALTY : 0)
  }

  private emergencyCost = (edge: number) => {
    if (this.blockedS.has(edge)) return Infinity
    const e = this.g.edges[edge]
    return e.len / Math.max(4, Math.min(e.vfree * 1.35, this.state.edgeSpeed[edge] * 1.4))
  }

  route(from: number, to: number, cost: (e: number) => number, algorithm: Algorithm = 'astar', allow?: number): RouteResult {
    // emergency vehicles may exceed the speed limit, so their heuristic needs a higher bound
    const heuristicSpeed = this.g.maxSpeed * (cost === this.emergencyCost ? 1.4 : 1.15)
    return findRoute(this.g, from, to, { cost, algorithm, allow, heuristicSpeed })
  }

  routeCost(edges: number[], cost: (e: number) => number) {
    let c = 0
    for (const e of edges) c += cost(e)
    return c
  }

  private pickWeighted(cum: number[]) {
    const r = this.rand() * cum[cum.length - 1]
    let lo = 0
    let hi = cum.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cum[mid] < r) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  private logTo(v: Vehicle, msg: string) {
    v.log.push({ t: this.state.t, msg })
    if (v.log.length > 8) v.log.shift()
  }

  alert(level: 'info' | 'warn' | 'crit', msg: string, x?: number, z?: number) {
    const st = this.state
    st.alerts.push({ id: st.nextAlertId++, t: st.t, level, msg, x, z })
    if (st.alerts.length > 60) st.alerts.shift()
  }

  edgeName(edge: number) {
    const e = this.g.edges[edge]
    return e.name || (e.cls === 'local' ? 'local street' : `unnamed ${e.cls}`)
  }

  // ───────────────────────────────────────── agents
  private spawnVehicle(warm = false): Vehicle | null {
    const g = this.g
    const st = this.state
    for (let attempt = 0; attempt < 12; attempt++) {
      const eid = this.pickWeighted(this.spawnCum)
      if (this.blockedS.has(eid)) continue
      const e = g.edges[eid]
      const dest = this.destNodes[Math.floor(this.rand() * this.destNodes.length)]
      const d = Math.hypot(g.nodeX[dest] - g.nodeX[e.to], g.nodeZ[dest] - g.nodeZ[e.to])
      if (d < 600 || d > 2800) continue
      const kr = this.rand()
      const kind: VehicleKind = kr < 0.05 ? 'bus' : kr < 0.15 ? 'taxi' : 'car'
      const adaptive = this.rand() < st.params.smartNav
      const r = this.route(e.to, dest, adaptive ? this.liveCost : this.staticCost)
      if (!r.found) continue
      const v: Vehicle = {
        id: st.nextId++, kind, edge: eid, lane: Math.floor(this.rand() * this.laneCount(e)),
        s: warm ? this.rand() * e.len * 0.9 : 0, v: warm ? e.vfree * 0.5 : 2, route: [eid, ...r.edges], ri: 0, dest,
        born: st.t, strategy: adaptive ? 'adaptive' : 'static',
        headway: kind === 'bus' ? 1.9 : kind === 'taxi' ? 0.8 + this.rand() * 0.4 : 1.0 + this.rand() * 0.8,
        speedFactor: kind === 'bus' ? 0.78 : 0.86 + this.rand() * 0.24,
        stopped: 0, nextReroute: st.t + 30 + this.rand() * 60, dist: 0, reroutes: 0, log: [],
      }
      this.logTo(v, `Spawned on ${this.edgeName(eid)} · goal ${(d / 1000).toFixed(1)} km away · ${adaptive ? 'live-traffic navigation' : 'fixed shortest-time route'}`)
      st.vehicles.push(v)
      return v
    }
    return null
  }

  private chooseLane(edge: number): number {
    const e = this.g.edges[edge]
    let best = 0
    let bestTail = -1
    for (let l = 0; l < this.laneCount(e); l++) {
      const arr = this.lanes.get(edge * 4 + l)
      const tail = arr && arr.length ? arr[arr.length - 1].s : Infinity
      if (tail > bestTail) {
        bestTail = tail
        best = l
      }
    }
    return best
  }

  private tailOf(edge: number): Vehicle | undefined {
    const e = this.g.edges[edge]
    let worst: Vehicle | undefined
    let bestTail = -1
    for (let l = 0; l < this.laneCount(e); l++) {
      const arr = this.lanes.get(edge * 4 + l)
      if (!arr || !arr.length) return undefined // a free lane exists
      const tail = arr[arr.length - 1]
      if (tail.s > bestTail) {
        bestTail = tail.s
        worst = tail
      }
    }
    return worst
  }

  isGreen(edge: number): boolean {
    const si = this.signalAt[this.g.edges[edge].to]
    if (si < 0) return true
    const sig = this.state.signals[si]
    if (sig.clear > 0) return false
    return this.signalGroupOf[edge] === sig.phase
  }

  /** Re-plan an agent's remaining route. Returns the saving in seconds (or -1). */
  reroute(v: Vehicle, reason: string, force = false): number {
    const e = this.g.edges[v.edge]
    const cost = v.strategy === 'adaptive' || force ? this.liveCost : this.staticCost
    const r = this.route(e.to, v.dest, cost)
    if (!r.found) return -1
    const remaining = v.route.slice(v.ri + 1)
    const old = this.routeCost(remaining, this.liveCost)
    const gain = old - r.cost
    if (force || gain > Math.max(6, old * 0.1)) {
      v.route = [...v.route.slice(0, v.ri + 1), ...r.edges]
      v.reroutes++
      const via = r.edges.map((x) => this.g.edges[x].name).find((n) => n) ?? 'side streets'
      this.logTo(v, isFinite(gain)
        ? `${reason} → rerouted via ${via}: saves ${fmtDuration(gain)} (A*, ${r.expanded} nodes expanded)`
        : `${reason} → new route via ${via} (${fmtDuration(r.cost)} predicted, A*, ${r.expanded} nodes)`)
      return gain
    }
    return 0
  }

  // ───────────────────────────────────────── main loop
  step() {
    const st = this.state
    st.t += DT
    this.processEvents()
    this.refreshBlocked()
    this.bucket()
    this.updateSignals()
    this.moveVehicles()
    this.moveEmergency()
    this.processReroutes()
    if (st.vehicles.some((v) => v.edge < 0)) st.vehicles = st.vehicles.filter((v) => v.edge >= 0)
    // keep demand at the time-of-day target (surplus vehicles leave naturally as they arrive)
    const target = this.demandTarget()
    const busy = st.units.filter((u) => u.status === 'busy').length
    st.acc.spawnBudget = Math.min(10, st.acc.spawnBudget + DT * 6)
    while (st.vehicles.length - busy < target && st.acc.spawnBudget >= 1) {
      st.acc.spawnBudget -= 1
      if (!this.spawnVehicle()) break
    }
    st.acc.second += DT
    if (st.acc.second >= 1 - 1e-9) {
      st.acc.second -= 1
      this.everySecond()
    }
  }

  run(seconds: number) {
    const n = Math.round(seconds / DT)
    for (let i = 0; i < n; i++) this.step()
  }

  private processEvents() {
    const st = this.state
    while (st.events.length && st.events[0].t <= st.t) {
      const ev = st.events.shift()!
      switch (ev.type) {
        case 'block':
          this.createIncident('accident', ev.edge, ev.label, ev.duration)
          break
        case 'storm':
          st.params.storm = ev.intensity
          this.alert(ev.intensity > 0 ? 'warn' : 'info', ev.intensity > 0
            ? `Storm front reached the city · intensity ${(ev.intensity * 100).toFixed(0)}% · speeds −${(ev.intensity * 35).toFixed(0)}%`
            : 'Storm dissipated · normal driving conditions')
          break
        case 'trip':
          this.tripSubstation(ev.sub, ev.duration)
          break
        case 'medical': {
          const out = this.g.out[ev.node]
          if (out.length) this.createIncident('medical', out[0], ev.label)
          break
        }
        case 'demand':
          st.params.vehicles = ev.vehicles
          this.alert('info', `Traffic demand changed to ${ev.vehicles} vehicles`)
          break
        case 'metro':
          this.setMetro(ev.level, ev.label)
          break
      }
    }
  }

  private refreshBlocked() {
    this.blockedS.clear()
    for (const inc of this.state.incidents) {
      if (inc.blocks && inc.status !== 'resolved') this.blockedS.set(inc.edge, inc.s)
    }
  }

  private bucket() {
    const lanes = this.lanes
    lanes.clear()
    const st = this.state
    st.edgeCount.fill(0)
    this.edgeQueue.fill(0)
    for (const v of st.vehicles) {
      if (v.edge < 0) continue
      st.edgeCount[v.edge]++
      if (v.mission) continue
      if (v.v < 3) this.edgeQueue[v.edge]++
      const e = this.g.edges[v.edge]
      if (v.lane >= this.laneCount(e)) v.lane = this.laneCount(e) - 1
      const key = v.edge * 4 + v.lane
      const arr = lanes.get(key)
      if (arr) arr.push(v)
      else lanes.set(key, [v])
    }
    for (const arr of lanes.values()) if (arr.length > 1) arr.sort((a, b) => b.s - a.s || a.id - b.id)
  }

  private updateSignals() {
    const st = this.state
    const p = st.params
    for (const sig of st.signals) {
      if (sig.clear > 0) {
        sig.clear -= DT
        continue
      }
      sig.pt += DT
      if (sig.preempt >= 0) {
        if (st.t < sig.preemptUntil) {
          if (sig.phase !== sig.preempt) this.switchPhase(sig, 1.5)
          continue
        }
        sig.preempt = -1
      }
      const dark = !st.subs[sig.sector]?.online
      if (dark) {
        // blackout: drivers treat the junction as an all-way stop → short alternating turns
        if (sig.pt >= 4) this.switchPhase(sig, 2.5)
      } else if (p.signals === 'fixed') {
        if (sig.pt >= 30) this.switchPhase(sig, 4)
      } else if (sig.pt >= 7) {
        // max-pressure control: serve the approach with the larger stopped queue
        const pc = this.pressure(sig.groups[sig.phase])
        const po = this.pressure(sig.groups[1 - sig.phase])
        if ((po > pc * 1.3 + 1) || (pc === 0 && po > 0) || sig.pt >= 55) this.switchPhase(sig, 3)
      }
    }
  }

  private switchPhase(sig: Signal, clear: number) {
    sig.phase = (1 - sig.phase) as 0 | 1
    sig.pt = 0
    sig.clear = clear
  }

  private pressure(group: number[]) {
    let q = 0
    for (const e of group) q += this.edgeQueue[e]
    return q
  }

  private moveVehicles() {
    const g = this.g
    const st = this.state
    const weather = this.weather()
    const transitions: Vehicle[] = []
    for (const arr of this.lanes.values()) {
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i]
        const e = g.edges[v.edge]
        let v0 = e.vfree * v.speedFactor * weather
        let gap = Infinity
        let dv = 0
        const distEnd = e.len - v.s
        if (i > 0) {
          const leader = arr[i - 1]
          gap = leader.s - v.s - VEH_LEN
          dv = v.v - leader.v
        } else if (v.ri < v.route.length - 1) {
          const next = v.route[v.ri + 1]
          let stop = false
          if (!this.isGreen(v.edge)) stop = true
          else {
            if (this.blockedS.has(next) && distEnd < 45 && !v.force) {
              // non-connected drivers only learn about a blockage when they can see it
              if (this.reroute(v, `Blockage discovered on ${this.edgeName(next)}`, true) < 0) v.force = true
            }
            const nxt = v.route[v.ri + 1]
            const tail = this.tailOf(nxt)
            if (tail) {
              if (tail.s < VEH_LEN + 1) stop = true
              else {
                gap = distEnd + tail.s - VEH_LEN
                dv = v.v - tail.v
              }
            }
          }
          if (stop) {
            gap = distEnd - 1.5
            dv = v.v
          }
          if (this.junction[e.to] && this.signalAt[e.to] < 0 && distEnd < 25) v0 = Math.min(v0, 8)
        }
        const bs = this.blockedS.get(v.edge)
        if (bs !== undefined && v.s < bs) {
          const g2 = bs - v.s - 4
          if (g2 < gap) {
            gap = g2
            dv = v.v
          }
        }
        // Intelligent Driver Model
        const sStar = 2 + v.v * v.headway + (v.v * dv) / (2 * Math.sqrt(IDM_A * IDM_B))
        let a = IDM_A * (1 - Math.pow(v.v / Math.max(0.1, v0), 4) - Math.pow(Math.max(0, sStar) / Math.max(0.1, gap), 2))
        if (a < -9) a = -9
        v.v = Math.max(0, v.v + a * DT)
        let adv = v.v * DT
        if (adv > gap) {
          adv = Math.max(0, gap)
          v.v = Math.min(v.v, adv / DT)
        }
        v.s += adv
        v.dist += adv
        v.stopped = v.v < 0.3 ? v.stopped + DT : 0
        if (v.s >= e.len) transitions.push(v)
        else if (v.stopped > 240 && bs === undefined) {
          // gridlock breaker (as in SUMO's teleport): the trip is abandoned and counted
          v.edge = -1
          st.removed++
        }
      }
    }
    for (const v of transitions) this.advanceEdge(v)
  }

  private advanceEdge(v: Vehicle) {
    const st = this.state
    const e = this.g.edges[v.edge]
    if (v.ri >= v.route.length - 1) {
      // arrived
      st.arrivals++
      st.arrivalsLog.push(st.t)
      st.tripLog.push(st.t - v.born)
      if (st.tripLog.length > 80) st.tripLog.shift()
      v.edge = -1
      return
    }
    v.s -= e.len
    v.ri++
    v.edge = v.route[v.ri]
    v.lane = this.chooseLane(v.edge)
    const tail = this.tailOf(v.edge)
    if (tail && v.s > tail.s - VEH_LEN) v.s = Math.max(0, tail.s - VEH_LEN)
    const key = v.edge * 4 + v.lane
    const arr = this.lanes.get(key)
    if (arr) arr.push(v)
    else this.lanes.set(key, [v])
  }

  private moveEmergency() {
    const st = this.state
    const g = this.g
    const weather = this.weather()
    for (const v of st.vehicles) {
      const m = v.mission
      if (!m || v.edge < 0) continue
      const e = g.edges[v.edge]
      if (m.phase === 'onScene') {
        v.v = 0
        if (st.t >= m.until) this.leaveScene(v)
        continue
      }
      const density = Math.min(1, st.edgeCount[v.edge] / Math.max(1, (e.len * this.laneCount(e)) / 7))
      let target = e.vfree * 1.35 * weather * (1 - 0.55 * density)
      const distEnd = e.len - v.s
      if (v.ri < v.route.length - 1 && this.signalAt[e.to] >= 0) {
        const sig = st.signals[this.signalAt[e.to]]
        if (st.params.preemption && distEnd < 160) {
          sig.preempt = this.signalGroupOf[v.edge] as 0 | 1
          sig.preemptUntil = st.t + 4
        }
        if (!this.isGreen(v.edge) && distEnd < 30) target = Math.min(target, 5) // cautious crossing on red
      }
      v.v += Math.max(-4 * DT, Math.min(2.6 * DT, target - v.v))
      v.s += v.v * DT
      v.dist += v.v * DT
      if (m.phase === 'toScene' && v.edge === m.sceneEdge && v.s >= m.sceneS) {
        v.s = m.sceneS
        this.arriveScene(v)
        continue
      }
      while (v.edge >= 0 && v.s >= g.edges[v.edge].len) {
        if (v.ri >= v.route.length - 1) {
          if (m.phase === 'toScene') {
            v.s = g.edges[v.edge].len
            this.arriveScene(v)
          } else {
            const unit = st.units[m.unit]
            unit.status = 'idle'
            unit.vehicle = -1
            v.edge = -1
          }
          break
        }
        v.s -= g.edges[v.edge].len
        v.ri++
        v.edge = v.route[v.ri]
      }
    }
  }

  private processReroutes() {
    const st = this.state
    let budget = 18
    while (st.rerouteQueue.length && budget-- > 0) {
      const id = st.rerouteQueue.shift()!
      const v = st.vehicles.find((x) => x.id === id)
      if (!v || v.edge < 0 || v.mission) continue
      const forced = !!v.force
      v.force = false
      const gain = this.reroute(v, forced ? 'Live incident feed' : 'Periodic traffic check', forced)
      if (gain === 0 && !forced) this.logTo(v, 'Periodic traffic check → current route still optimal')
      v.nextReroute = st.t + 50 + this.rand() * 40
    }
  }

  // ───────────────────────────────────────── slow processes (1 Hz)
  private everySecond() {
    const st = this.state
    const g = this.g
    const weather = this.weather()
    // edge speed estimates (EMA) + anomaly baselines
    const vsum = new Float32Array(g.edges.length)
    for (const v of st.vehicles) if (v.edge >= 0 && !v.mission) vsum[v.edge] += v.v
    for (let i = 0; i < g.edges.length; i++) {
      const c = st.edgeCount[i]
      const free = g.edges[i].vfree * weather
      if (c > 0) st.edgeSpeed[i] += (vsum[i] / c - st.edgeSpeed[i]) * 0.3
      else st.edgeSpeed[i] += (free - st.edgeSpeed[i]) * 0.08
      const sp = st.edgeSpeed[i]
      const d = sp - st.edgeMean[i]
      st.edgeMean[i] += 0.01 * d
      st.edgeVar[i] = 0.99 * st.edgeVar[i] + 0.01 * d * d
    }
    if (Math.round(st.t) % 10 === 0) this.detectAnomalies()

    // adaptive agents periodically re-evaluate their route
    for (const v of st.vehicles) {
      if (v.strategy === 'adaptive' && !v.mission && v.edge >= 0 && st.t >= v.nextReroute) {
        v.nextReroute = st.t + 1e9
        st.rerouteQueue.push(v.id)
      }
    }

    this.updateGrid()

    // random emergencies (Poisson process)
    if (this.rand() < st.params.incidentRate / 3600) {
      const kr = this.rand()
      const kind: IncidentKind = kr < 0.5 ? 'accident' : kr < 0.88 ? 'medical' : 'fire'
      const edge = kind === 'accident' ? this.pickWeighted(this.accidentCum) : this.pickWeighted(this.spawnCum)
      this.createIncident(kind, edge)
    }
    this.dispatch()

    // resolve incidents whose scene work is done
    for (const inc of st.incidents) {
      if (inc.status === 'onScene' && st.t >= inc.arrivedAt + inc.clearAfter) this.resolveIncident(inc)
    }

    this.computeMetrics()
    st.acc.sample += 1
    if (st.acc.sample >= HISTORY_EVERY) {
      st.acc.sample = 0
      const m = st.metrics
      st.history.push({
        t: Math.round(st.t), speed: m.speed, congestion: m.congestion, throughput: m.throughput, co2: m.co2,
        power: m.power, response: m.response, trip: m.trip, vehicles: m.vehicles, stopped: m.stopped, riders: m.riders,
      })
      if (st.history.length > MAX_HISTORY) st.history.shift()
    }
  }

  private detectAnomalies() {
    const st = this.state
    // rate-limit: one anomaly alert per two simulated minutes city-wide
    if (st.alerts.some((a) => a.msg.startsWith('Anomalous') && a.t > st.t - 120)) return
    for (const e of this.g.edges) {
      if (e.cls === 'local' || st.edgeCount[e.id] < 3) continue
      const z = (st.edgeSpeed[e.id] - st.edgeMean[e.id]) / Math.sqrt(st.edgeVar[e.id] + 1)
      const cong = 1 - st.edgeSpeed[e.id] / e.vfree
      if (z < -3 && cong > 0.7 && st.t - st.edgeAlertAt[e.id] > 900 && st.t > 300) {
        st.edgeAlertAt[e.id] = st.t
        const [x, zz] = this.g.posAt(e, e.len / 2, 0, this.tmpPos)
        this.alert('warn', `Anomalous slowdown on ${this.edgeName(e.id)} · ${(st.edgeSpeed[e.id] * 3.6).toFixed(0)} km/h (z = ${z.toFixed(1)})`, x, zz)
        return // at most one anomaly alert per scan
      }
    }
  }

  private updateGrid() {
    const st = this.state
    const p = st.params
    for (let i = 0; i < st.subs.length; i++) {
      const s = st.subs[i]
      s.load = this.baseLoad[i] * p.powerDemand * (1 + 0.12 * p.storm) * (1 + 0.04 * Math.sin(st.t / 300 + i))
      if (s.online) {
        const overload = Math.max(0, s.load / s.capacity - 1)
        const hazard = p.storm * p.storm * 0.0022 + overload * 0.02
        if (this.rand() < hazard) {
          const cause = overload > 0 && overload * 0.02 > p.storm * p.storm * 0.0022 ? `overload (${(s.load / s.capacity * 100).toFixed(0)}% of capacity)` : 'storm damage'
          this.tripSubstation(i, (240 + this.rand() * 300) / (0.5 + 0.5 * p.repairCrews), cause)
        }
      } else if (st.t >= s.repairAt) {
        s.online = true
        this.alert('info', `${s.name} restored · power back in sector ${i + 1}`, s.x, s.z)
      }
    }
  }

  tripSubstation(i: number, duration: number, cause = 'manual trip') {
    const st = this.state
    const s = st.subs[i]
    if (!s || !s.online) return
    s.online = false
    s.failures++
    s.repairAt = st.t + duration
    const dark = st.signals.filter((g) => g.sector === i).length
    this.alert('crit', `${s.name} offline (${cause}) · sector ${i + 1} blackout · ${dark} signals dark · repair ETA ${fmtDuration(duration)}`, s.x, s.z)
  }

  createIncident(kind: IncidentKind, edge: number, label?: string, clearAfter?: number): Incident | null {
    const st = this.state
    const e = this.g.edges[edge]
    if (!e) return null
    if (kind === 'accident' && this.blockedS.has(edge)) return null
    const s = e.len * 0.55
    const [x, z] = this.g.posAt(e, s, 0, this.tmpPos)
    const inc: Incident = {
      id: st.incidents.length + 1, kind, edge, s, x, z, t: st.t, blocks: kind === 'accident',
      severity: kind === 'fire' ? 3 : kind === 'medical' ? 2 : (1 + Math.floor(this.rand() * 2)) as 1 | 2,
      status: 'pending', unit: -1, arrivedAt: 0, clearAfter: clearAfter ?? SCENE_TIME[kind],
      label: label ?? `${kind === 'accident' ? 'Collision' : kind === 'medical' ? 'Medical emergency' : 'Structure fire'} on ${this.edgeName(edge)}`,
    }
    st.incidents.push(inc)
    if (inc.blocks) {
      this.blockedS.set(edge, s)
      let informed = 0
      for (const v of st.vehicles) {
        if (v.strategy === 'adaptive' && !v.mission && v.edge >= 0 && v.route.indexOf(edge, v.ri + 1) > 0) {
          v.force = true
          st.rerouteQueue.unshift(v.id)
          informed++
        }
      }
      this.alert('crit', `${inc.label} · lane blocked · ${informed} connected agents rerouting`, x, z)
    } else {
      this.alert('warn', inc.label, x, z)
    }
    return inc
  }

  /** ETA-minimising assignment: each pending incident (most severe first) takes the
   *  available unit with the lowest A* travel time on the live network. */
  private dispatch() {
    const st = this.state
    const pending = st.incidents.filter((i) => i.status === 'pending').sort((a, b) => b.severity - a.severity || a.t - b.t)
    for (const inc of pending) {
      const need = inc.kind === 'fire' ? 'fire' : 'ambulance'
      const idle = st.units.filter((u) => u.kind === need && u.status === 'idle')
      if (!idle.length) continue
      const e = this.g.edges[inc.edge]
      const options = idle.map((u) => {
        const r = this.route(u.home, e.from, this.emergencyCost)
        return { u, r, eta: r.cost + inc.s / (e.vfree * 1.2) }
      }).filter((o) => o.r.found || o.u.home === e.from)
      if (!options.length) continue
      options.sort((a, b) => a.eta - b.eta)
      const best = options[0]
      const decision: DispatchDecision = {
        t: st.t, chosen: best.u.id, algorithm: 'A* on live travel times',
        candidates: options.slice(0, 5).map((o) => ({ unit: o.u.id, name: o.u.name, eta: o.eta, expanded: o.r.expanded })),
      }
      inc.dispatch = decision
      inc.status = 'responding'
      inc.unit = best.u.id
      best.u.status = 'busy'
      const route = [...best.r.edges, inc.edge]
      const v: Vehicle = {
        id: st.nextId++, kind: need, edge: route[0], lane: 0, s: 0, v: 4, route, ri: 0, dest: e.to, born: st.t,
        strategy: 'adaptive', headway: 0.8, speedFactor: 1.3, stopped: 0, nextReroute: 1e9, dist: 0, reroutes: 0, log: [],
        mission: { incident: inc.id, unit: best.u.id, phase: 'toScene', sceneEdge: inc.edge, sceneS: Math.max(0, inc.s - 8), until: 0 },
      }
      best.u.vehicle = v.id
      const alt = options[1]
      this.logTo(v, `Dispatched to ${inc.label}: ETA ${fmtDuration(best.eta)}${alt ? ` (next best ${fmtDuration(alt.eta)})` : ''} · A* ${best.r.expanded} nodes`)
      st.vehicles.push(v)
      this.alert('info', `${best.u.name} dispatched · ETA ${fmtDuration(best.eta)} · ${options.length} units evaluated`, inc.x, inc.z)
    }
  }

  private arriveScene(v: Vehicle) {
    const st = this.state
    const m = v.mission!
    const inc = st.incidents[m.incident - 1]
    m.phase = 'onScene'
    m.until = st.t + inc.clearAfter
    v.v = 0
    inc.status = 'onScene'
    inc.arrivedAt = st.t
    const rt = st.t - inc.t
    st.responseLog.push(rt)
    if (st.responseLog.length > 20) st.responseLog.shift()
    this.logTo(v, `On scene after ${fmtDuration(rt)}`)
  }

  private leaveScene(v: Vehicle) {
    const st = this.state
    const m = v.mission!
    const unit = st.units[m.unit]
    const e = this.g.edges[v.edge]
    const r = this.route(e.to, unit.home, this.emergencyCost)
    m.phase = 'return'
    if (!r.found) {
      unit.status = 'idle'
      unit.vehicle = -1
      v.edge = -1
      return
    }
    v.route = [v.edge, ...r.edges]
    v.ri = 0
    this.logTo(v, `Scene cleared → returning to base (${fmtDuration(r.cost)})`)
  }

  private resolveIncident(inc: Incident) {
    inc.status = 'resolved'
    this.alert('info', `${inc.label} cleared · response ${fmtDuration(inc.arrivedAt - inc.t)}`, inc.x, inc.z)
  }

  clearIncident(id: number) {
    const inc = this.state.incidents.find((i) => i.id === id)
    if (inc && inc.status !== 'resolved') {
      inc.status = 'resolved'
      this.alert('info', `${inc.label} manually cleared`, inc.x, inc.z)
    }
  }

  private computeMetrics() {
    const st = this.state
    let n = 0
    let speed = 0
    let delay = 0
    let stopped = 0
    let co2 = 0
    for (const v of st.vehicles) {
      if (v.edge < 0 || v.mission) continue
      const e = this.g.edges[v.edge]
      n++
      speed += v.v
      delay += Math.max(0, 1 - v.v / (e.vfree * v.speedFactor))
      if (v.v < 0.5) {
        stopped++
        co2 += 0.00028 // kg/s idling
      } else co2 += v.v * (v.kind === 'bus' ? 0.0009 : 0.00017) // kg per metre
    }
    while (st.arrivalsLog.length && st.arrivalsLog[0] < st.t - 300) st.arrivalsLog.shift()
    const totalLoad = st.subs.reduce((a, s) => a + s.load, 0) || 1
    const served = st.subs.reduce((a, s) => a + (s.online ? Math.min(s.load, s.capacity) : 0), 0)
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
    st.metrics = {
      t: st.t,
      vehicles: n,
      speed: n ? (speed / n) * 3.6 : 0,
      congestion: n ? delay / n : 0,
      stopped: n ? stopped / n : 0,
      throughput: (st.arrivalsLog.length * 3600) / Math.min(300, Math.max(30, st.t)),
      trip: mean(st.tripLog),
      co2: co2 * 3600,
      power: served / totalLoad,
      response: mean(st.responseLog),
      arrivals: st.arrivals,
      removed: st.removed,
      activeIncidents: st.incidents.filter((i) => i.status !== 'resolved').length,
      outages: st.subs.filter((s) => !s.online).length,
      riders: st.transitHold != null ? 0 : this.transit.ridersPerHour(this.secOfDay()),
      demandTarget: this.demandTarget(),
      hour: this.hour(),
      trainsInService: this.transit.lines.length ? this.transit.trains(this.transitSec()).length : 0,
    }
  }

  // ───────────────────────────────────────── time of day & rail transit
  hour() {
    return hourAt(this.state.params.startHour, this.state.t)
  }

  secOfDay() {
    return this.state.params.startHour * 3600 + this.state.t
  }

  /** clock used for train positions: frozen while service is suspended */
  transitSec() {
    return this.state.transitHold ?? this.secOfDay()
  }

  /** private vehicles the demand model wants on the road right now */
  demandTarget() {
    const p = this.state.params
    const base = p.dynamicDemand ? p.vehicles * demandProfile(this.hour()) : p.vehicles
    const level = this.state.transitHold != null ? 0 : p.metro
    const shift = this.transit.lines.length ? (1 - Math.min(1, level)) * TRANSIT_SHIFT : 0
    return Math.round(base * (1 + shift))
  }

  /** keep the timetable and the suspension clock consistent with params.metro */
  private syncTransit() {
    const st = this.state
    const level = st.params.metro
    if (level <= 0.001) {
      if (st.transitHold == null) st.transitHold = this.secOfDay()
    } else {
      st.transitHold = null
      if (Math.abs(this.transit.serviceLevel - level) > 1e-6) this.transit.buildTimetable(level)
    }
  }

  setMetro(level: number, label?: string) {
    if (!this.transit.lines.length) return
    const before = this.state.params.metro
    this.state.params.metro = Math.max(0, Math.min(1, level))
    this.syncTransit()
    if (Math.abs(before - this.state.params.metro) < 1e-6) return
    const shift = Math.round((1 - this.state.params.metro) * TRANSIT_SHIFT * 100)
    this.alert(level <= 0.001 ? 'crit' : 'info', label ?? (level <= 0.001
      ? `Rail service suspended · trains held at their positions · ~${shift}% of riders move to the roads`
      : `Rail service at ${Math.round(level * 100)}% of normal frequency${shift ? ` · ~${shift}% of riders move to the roads` : ''}`))
  }

  // ───────────────────────────────────────── public API
  snapshot(): SimState {
    return structuredClone(this.state)
  }

  restore(s: SimState) {
    this.state = structuredClone(s)
    this.syncTransit()
    this.refreshBlocked()
    this.bucket()
  }

  setParams(patch: Partial<SimParams>) {
    const { metro, ...rest } = patch
    Object.assign(this.state.params, rest)
    if (metro !== undefined) this.setMetro(metro)
  }

  addEvent(ev: ScheduledEvent) {
    this.state.events.push(ev)
    this.state.events.sort((a, b) => a.t - b.t)
  }

  vehiclePosition(v: Vehicle, extra = 0, out: [number, number, number] = [0, 0, 0]) {
    const e = this.g.edges[v.edge]
    return this.g.posAt(e, Math.min(e.len, v.s + extra), v.mission ? 0 : v.lane, out)
  }

  /** ETA of every ambulance/fire unit to an edge on the live network (what dispatch would see). */
  unitEtas(edge: number, kind: 'ambulance' | 'fire' = 'ambulance') {
    const e = this.g.edges[edge]
    return this.state.units.filter((u) => u.kind === kind).map((u) => {
      const r = this.route(u.home, e.from, this.emergencyCost)
      return { unit: u, eta: r.found ? r.cost + (e.len * 0.55) / (e.vfree * 1.2) : Infinity, expanded: r.expanded, edges: r.edges }
    }).sort((a, b) => a.eta - b.eta)
  }

  /** Compare A* and Dijkstra between two nodes on the live network (for explainability). */
  compareAlgorithms(from: number, to: number) {
    const t0 = performance.now()
    const a = this.route(from, to, this.liveCost, 'astar')
    const t1 = performance.now()
    const d = this.route(from, to, this.liveCost, 'dijkstra')
    const t2 = performance.now()
    return { astar: { ...a, ms: t1 - t0 }, dijkstra: { ...d, ms: t2 - t1 } }
  }
}

function emptyMetrics(): Metrics {
  return {
    t: 0, speed: 0, congestion: 0, throughput: 0, co2: 0, power: 1, response: 0, trip: 0, vehicles: 0, stopped: 0,
    arrivals: 0, removed: 0, activeIncidents: 0, outages: 0, riders: 0, demandTarget: 0, hour: 7, trainsInService: 0,
  }
}
