import { Simulation } from './engine'
import type { CityData, Sample, ScheduledEvent, SimParams } from './types'

export interface ExperimentSpec {
  label: string
  params: SimParams
  events: ScheduledEvent[]
  /** simulated seconds */
  duration: number
}

export interface ExperimentSummary {
  speed: number
  congestion: number
  throughput: number
  trip: number
  co2: number
  power: number
  response: number
  responses: number
  removed: number
  arrivals: number
  reroutes: number
}

export interface ExperimentResult {
  label: string
  seed: number
  params: SimParams
  summary: ExperimentSummary
  history: Sample[]
  wallMs: number
}

export const KPI_META: Record<keyof Omit<ExperimentSummary, 'responses' | 'reroutes'>, { label: string; unit: string; better: 'up' | 'down'; fmt: (v: number) => string }> = {
  speed: { label: 'Mean speed', unit: 'km/h', better: 'up', fmt: (v) => v.toFixed(1) },
  congestion: { label: 'Delay index', unit: '%', better: 'down', fmt: (v) => (v * 100).toFixed(1) },
  throughput: { label: 'Trips completed', unit: '/h', better: 'up', fmt: (v) => v.toFixed(0) },
  trip: { label: 'Mean trip time', unit: 's', better: 'down', fmt: (v) => v.toFixed(0) },
  co2: { label: 'CO₂ emissions', unit: 'kg/h', better: 'down', fmt: (v) => v.toFixed(0) },
  power: { label: 'Power served', unit: '%', better: 'up', fmt: (v) => (v * 100).toFixed(1) },
  response: { label: 'Emergency response', unit: 's', better: 'down', fmt: (v) => (v ? v.toFixed(0) : '—') },
  removed: { label: 'Abandoned trips', unit: '', better: 'down', fmt: (v) => v.toFixed(0) },
  arrivals: { label: 'Arrivals', unit: '', better: 'up', fmt: (v) => v.toFixed(0) },
}

/** Runs one headless experiment. Reuses `sim` (graph is expensive to rebuild). */
export function runExperiment(sim: Simulation, spec: ExperimentSpec, onProgress?: (p: number) => void): ExperimentResult {
  const t0 = performance.now()
  sim.reset(spec.params, spec.events)
  const chunk = 30
  for (let t = 0; t < spec.duration; t += chunk) {
    sim.run(Math.min(chunk, spec.duration - t))
    onProgress?.(Math.min(1, (t + chunk) / spec.duration))
  }
  const st = sim.state
  const warm = st.history.filter((h) => h.t >= 60)
  const mean = (k: keyof Sample) => (warm.length ? warm.reduce((a, h) => a + h[k], 0) / warm.length : 0)
  const responses = st.incidents.filter((i) => i.arrivedAt > 0).map((i) => i.arrivedAt - i.t)
  return {
    label: spec.label,
    seed: spec.params.seed,
    params: spec.params,
    history: st.history,
    wallMs: performance.now() - t0,
    summary: {
      speed: mean('speed'),
      congestion: mean('congestion'),
      throughput: (st.arrivals * 3600) / spec.duration,
      trip: st.tripLog.length ? st.tripLog.reduce((a, b) => a + b, 0) / st.tripLog.length : 0,
      co2: mean('co2'),
      power: mean('power'),
      response: responses.length ? responses.reduce((a, b) => a + b, 0) / responses.length : 0,
      responses: responses.length,
      removed: st.removed,
      arrivals: st.arrivals,
      reroutes: st.vehicles.reduce((a, v) => a + v.reroutes, 0),
    },
  }
}

export function createSim(data: CityData, params: SimParams) {
  return new Simulation(data, params)
}
