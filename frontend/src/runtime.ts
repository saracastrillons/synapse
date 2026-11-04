import { DT, Simulation } from './sim/engine'
import type { ExperimentResult, ExperimentSpec } from './sim/experiment'
import { SCENARIOS, scenarioById, setScenarioCity } from './sim/scenarios'
import { cityById, type CityConfig } from './sim/cities'
import type { CityData, ScheduledEvent, SimParams, SimState } from './sim/types'
import { DEFAULT_PARAMS } from './sim/types'
import { useUI, type LiveView } from './store'

export interface GlobeData {
  points: number[]
  coast: number[][]
}

const SNAPSHOT_EVERY = 20
// ≈0.9 MB each → ~70 MB worst case, whatever the session length
const MAX_SNAPSHOTS = 80
const DENSE_RECENT = 30
const BRANCH_COLORS = ['#22d3ee', '#f472b6', '#fbbf24', '#34d399', '#a78bfa']

/** Owns the live simulation, the Time Machine snapshots and the experiment worker.
 *  Lives outside React; the UI reads a throttled `LiveView` from the store. */
class Runtime {
  data!: CityData
  city: CityConfig = cityById('medellin')
  globe!: GlobeData
  sim!: Simulation
  acc = 0
  snapshots: { t: number; state: SimState }[] = []
  private lastPublish = 0
  private worker?: Worker
  private jobs = new Map<number, { resolve: (r: ExperimentResult[]) => void; onProgress?: (p: number, label: string) => void }>()
  private jobId = 1
  branchId = 1

  private loading?: Promise<void>

  /** Idempotent: React StrictMode mounts effects twice in development. */
  load(log: (s: string) => void) {
    this.loading ??= this.doLoad(log)
    return this.loading
  }

  private async doLoad(log: (s: string) => void) {
    log(`Linking to OpenStreetMap extract · ${this.city.name} ${this.city.area.split(' · ')[0]}`)
    const [data, globe] = await Promise.all([
      fetchJson(`${import.meta.env.BASE_URL}data/${this.city.id}.json`),
      fetchJson(`${import.meta.env.BASE_URL}data/globe.json`),
    ])
    this.data = data
    this.globe = globe
    setScenarioCity(this.city, data)
    log(`Road graph: ${data.roads.nodes.length.toLocaleString()} junctions · ${data.roads.edges.length.toLocaleString()} segments`)
    log(`Built environment: ${data.buildings.length.toLocaleString()} structures · ${data.pois.length} critical facilities`)
    await new Promise((r) => setTimeout(r, 30))
    this.sim = new Simulation(data, useUI.getState().params)
    log(`Agent engine online · ${this.sim.state.vehicles.length} autonomous agents · ${this.sim.signalCount} signals`)
    this.worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (ev) => {
      const m = ev.data
      if (m.type === 'progress') this.jobs.get(m.id)?.onProgress?.(m.progress, m.label)
      if (m.type === 'done') {
        this.jobs.get(m.id)?.resolve(m.results)
        this.jobs.delete(m.id)
      }
    }
    this.worker.postMessage({ type: 'init', data })
    log('Experiment worker ready · deterministic replays enabled')
    this.takeSnapshot()
    this.publish(true)
  }

  /** Switch the twin to another city: new dataset, engine, worker data and scenarios. */
  async loadCity(id: string) {
    const city = cityById(id)
    if (city.id === this.city.id && this.data) return
    const data: CityData = await fetchJson(`${import.meta.env.BASE_URL}data/${city.id}.json`)
    this.city = city
    this.data = data
    setScenarioCity(city, data)
    const ui = useUI.getState()
    const params = { ...DEFAULT_PARAMS, seed: ui.params.seed }
    this.sim = new Simulation(data, params)
    this.worker?.postMessage({ type: 'init', data })
    this.snapshots = []
    this.acc = 0
    this.branchId = 1
    this.takeSnapshot()
    useUI.setState({ cityId: city.id, scenarioId: 'baseline', params, branches: [], selected: null, follow: false, highlight: null, chat: [] })
    this.publish(true)
  }

  // ───────────────────────────── live loop
  frame(dt: number) {
    const ui = useUI.getState()
    if (!this.sim || ui.paused) return
    this.acc += Math.min(dt, 0.1) * ui.speed
    let n = 0
    while (this.acc >= DT && n < 300) {
      this.sim.step()
      this.acc -= DT
      n++
      const last = this.snapshots[this.snapshots.length - 1]
      if (!last || this.sim.state.t - last.t >= SNAPSHOT_EVERY - 1e-6) this.takeSnapshot()
    }
    if (n === 300) this.acc = 0
    this.publish()
  }

  /** fraction of a step not yet simulated, in seconds — used to extrapolate motion smoothly */
  get alpha() {
    return this.acc
  }

  private takeSnapshot() {
    const state = this.sim.snapshot()
    // decision logs are descriptive only (they never feed back into the simulation): keep the latest few
    for (const v of state.vehicles) if (v.log.length > 2) v.log = v.log.slice(-2)
    this.snapshots.push({ t: state.t, state })
    // Bounded memory: recent history stays dense; older snapshots are thinned by removing the one
    // whose neighbours are closest together, so spacing grows smoothly with age.
    while (this.snapshots.length > MAX_SNAPSHOTS) {
      let drop = 1
      let best = Infinity
      for (let i = 1; i < this.snapshots.length - DENSE_RECENT; i++) {
        const gap = this.snapshots[i + 1].t - this.snapshots[i - 1].t
        if (gap < best) {
          best = gap
          drop = i
        }
      }
      this.snapshots.splice(drop, 1)
    }
  }

  publish(force = false) {
    const now = performance.now()
    if (!force && now - this.lastPublish < 200) return
    this.lastPublish = now
    const st = this.sim.state
    const ui = useUI.getState()
    let adaptive = 0, stat = 0, bus = 0, taxi = 0, emergency = 0, reroutes = 0
    for (const v of st.vehicles) {
      if (v.mission) emergency++
      else if (v.strategy === 'adaptive') adaptive++
      else stat++
      if (v.kind === 'bus') bus++
      if (v.kind === 'taxi') taxi++
      reroutes += v.reroutes
    }
    const hist = st.history.slice(-24)
    let slope = 0
    if (hist.length >= 24 && st.t > 240) {
      const n = hist.length
      const mx = hist.reduce((a, h) => a + h.t, 0) / n
      const my = hist.reduce((a, h) => a + h.congestion, 0) / n
      const num = hist.reduce((a, h) => a + (h.t - mx) * (h.congestion - my), 0)
      const den = hist.reduce((a, h) => a + (h.t - mx) ** 2, 0) || 1
      slope = num / den
    }
    const live: LiveView = {
      t: st.t,
      metrics: { ...st.metrics },
      history: st.history.slice(),
      alerts: st.alerts.slice(),
      incidents: st.incidents.map((i) => ({ ...i })),
      subs: st.subs.map((s) => ({ ...s })),
      units: st.units.map((u) => ({ ...u })),
      agents: { adaptive, static: stat, bus, taxi, emergency, reroutes },
      forecast: { slope, in10: Math.max(0, Math.min(1, st.metrics.congestion + slope * 600 * 0.6)) },
    }
    if (ui.selected != null) {
      const v = st.vehicles.find((x) => x.id === ui.selected)
      if (v && v.edge >= 0) {
        let remaining = this.sim.g.edges[v.edge].len - v.s
        for (let i = v.ri + 1; i < v.route.length; i++) remaining += this.sim.g.edges[v.route[i]].len
        const eta = this.sim.routeCost(v.route.slice(v.ri + 1), this.sim.liveCost) + (this.sim.g.edges[v.edge].len - v.s) / Math.max(1, v.v)
        const inc = v.mission ? st.incidents[v.mission.incident - 1] : undefined
        live.selected = {
          id: v.id, kind: v.kind, strategy: v.strategy, speed: v.v * 3.6, street: this.sim.edgeName(v.edge), remaining, eta,
          dist: v.dist, age: st.t - v.born, headway: v.headway, speedFactor: v.speedFactor, reroutes: v.reroutes,
          stopped: v.stopped, log: v.log.slice().reverse(),
          mission: v.mission && inc ? `${v.mission.phase === 'toScene' ? 'Responding to' : v.mission.phase === 'onScene' ? 'On scene at' : 'Returning from'} ${inc.label}` : undefined,
        }
      } else if (!v) {
        useUI.setState({ selected: null, follow: false })
      }
    }
    useUI.setState({ live })
  }

  // ───────────────────────────── scenario control
  scenarioEvents(id: string): ScheduledEvent[] {
    const sc = scenarioById(id) ?? SCENARIOS[0]
    return sc.events({ g: this.sim.g, data: this.data, city: this.city, subs: this.sim.state.subs })
  }

  scenarioParams(id: string, base: SimParams = DEFAULT_PARAMS): SimParams {
    const sc = scenarioById(id) ?? SCENARIOS[0]
    return { ...base, ...sc.params }
  }

  loadScenario(id: string, params: SimParams) {
    this.sim.reset(params, this.scenarioEvents(id))
    this.snapshots = []
    this.acc = 0
    this.branchId = 1
    this.takeSnapshot()
    useUI.setState({ scenarioId: id, params: { ...params }, branches: [], selected: null, follow: false, highlight: null })
    this.publish(true)
  }

  applyParams(patch: Partial<SimParams>) {
    this.sim.setParams(patch)
    useUI.setState({ params: { ...this.sim.state.params } })
    this.publish(true)
  }

  focusSub(i: number) {
    const s = this.sim.state.subs[i]
    if (s) useUI.getState().focusOn(s.x, s.z, 750)
  }

  // ───────────────────────────── Time Machine
  rewind(t: number) {
    const snap = [...this.snapshots].reverse().find((s) => s.t <= t + 1e-6)
    if (!snap) return
    const ui = useUI.getState()
    const st = this.sim.state
    const branches = ui.branches.length
      ? [...ui.branches]
      : [{ id: 0, name: 'Timeline A', color: BRANCH_COLORS[0], forkT: 0, history: [] as typeof st.history }]
    branches[branches.length - 1] = { ...branches[branches.length - 1], history: st.history.slice() }
    const next = this.branchId++
    branches.push({ id: next, name: `Timeline ${String.fromCharCode(65 + next)}`, color: BRANCH_COLORS[next % BRANCH_COLORS.length], forkT: snap.t, history: [] })
    this.sim.restore(snap.state)
    this.snapshots = this.snapshots.filter((s) => s.t <= snap.t + 1e-6)
    this.acc = 0
    useUI.setState({ branches: branches.slice(-4), params: { ...this.sim.state.params } })
    this.sim.alert('info', `Time Machine · rewound to ${clock(snap.t)} · new branch "${branches[branches.length - 1].name}" — change a decision and compare`)
    this.publish(true)
  }

  // ───────────────────────────── experiments
  runExperiments(specs: ExperimentSpec[], onProgress?: (p: number, label: string) => void): Promise<ExperimentResult[]> {
    const id = this.jobId++
    return new Promise((resolve) => {
      this.jobs.set(id, { resolve, onProgress })
      this.worker!.postMessage({ type: 'run', id, specs })
    })
  }
}

async function fetchJson(url: string) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`)
  return r.json()
}

export const runtime = new Runtime()

/** hh:mm:ss of the simulated clock (the start hour is a simulation parameter) */
export function clock(t: number, start = (runtime?.sim?.state.params.startHour ?? 7) * 3600) {
  const s = Math.floor(start + t) % 86400
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
