/// <reference lib="webworker" />
import { Simulation } from './engine'
import { runExperiment, type ExperimentSpec } from './experiment'
import { DEFAULT_PARAMS, type CityData } from './types'

/** Headless experiment runner — keeps the UI at 60 fps while Scenario Lab and the
 *  AI copilot run batches of reproducible simulations. */
let sim: Simulation | null = null

export type WorkerIn =
  | { type: 'init'; data: CityData }
  | { type: 'run'; id: number; specs: ExperimentSpec[] }

self.onmessage = (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data
  if (msg.type === 'init') {
    sim = new Simulation(msg.data, { ...DEFAULT_PARAMS, vehicles: 0 })
    self.postMessage({ type: 'ready' })
    return
  }
  if (!sim) return
  const results = []
  for (let i = 0; i < msg.specs.length; i++) {
    const r = runExperiment(sim, msg.specs[i], (p) =>
      self.postMessage({ type: 'progress', id: msg.id, progress: (i + p) / msg.specs.length, label: msg.specs[i].label }))
    results.push(r)
  }
  self.postMessage({ type: 'done', id: msg.id, results })
}
