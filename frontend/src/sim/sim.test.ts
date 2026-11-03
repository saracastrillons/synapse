import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Simulation } from './engine'
import { RoadGraph } from './graph'
import { findRoute } from './routing'
import { SCENARIOS } from './scenarios'
import { runExperiment } from './experiment'
import { DEFAULT_PARAMS, type CityData } from './types'

const data = JSON.parse(readFileSync(new URL('../../public/data/medellin.json', import.meta.url), 'utf-8')) as CityData
const params = { ...DEFAULT_PARAMS, vehicles: 400 }

describe('routing', () => {
  const g = new RoadGraph(data)
  const cost = (e: number) => g.edges[e].len / g.edges[e].vfree

  it('A* and Dijkstra agree on the optimal cost, A* expands fewer nodes', () => {
    let astarExpanded = 0
    let dijkstraExpanded = 0
    for (let i = 0; i < 25; i++) {
      const a = (i * 7919) % g.nodeX.length
      const b = (i * 104729 + 13) % g.nodeX.length
      const ra = findRoute(g, a, b, { cost, algorithm: 'astar' })
      const rd = findRoute(g, a, b, { cost, algorithm: 'dijkstra' })
      expect(ra.found).toBe(rd.found)
      if (ra.found) expect(ra.cost).toBeCloseTo(rd.cost, 6)
      astarExpanded += ra.expanded
      dijkstraExpanded += rd.expanded
    }
    expect(astarExpanded).toBeLessThan(dijkstraExpanded)
  })

  it('returns a connected edge sequence', () => {
    const r = findRoute(g, 10, 2000, { cost })
    expect(r.found).toBe(true)
    expect(g.edges[r.edges[0]].from).toBe(10)
    expect(g.edges[r.edges.at(-1)!].to).toBe(2000)
    for (let i = 1; i < r.edges.length; i++) expect(g.edges[r.edges[i]].from).toBe(g.edges[r.edges[i - 1]].to)
  })

  it('never routes through a forbidden edge', () => {
    const base = findRoute(g, 10, 2000, { cost })
    const banned = base.edges[Math.floor(base.edges.length / 2)]
    const r = findRoute(g, 10, 2000, { cost: (e) => (e === banned ? Infinity : cost(e)) })
    expect(r.edges).not.toContain(banned)
    expect(r.cost).toBeGreaterThanOrEqual(base.cost)
  })
})

describe('simulation', () => {
  it('is deterministic for a given seed', () => {
    const a = new Simulation(data, params)
    const b = new Simulation(data, params)
    a.run(90)
    b.run(90)
    expect(a.state.metrics).toEqual(b.state.metrics)
    expect(a.state.vehicles.map((v) => v.s)).toEqual(b.state.vehicles.map((v) => v.s))
  })

  it('different seeds produce different runs', () => {
    const a = new Simulation(data, params)
    const b = new Simulation(data, { ...params, seed: 7 })
    a.run(60)
    b.run(60)
    expect(a.state.metrics.speed).not.toEqual(b.state.metrics.speed)
  })

  it('snapshot → restore replays the exact same future (Time Machine)', () => {
    const sim = new Simulation(data, params)
    sim.run(40)
    const snap = sim.snapshot()
    sim.run(40)
    const first = sim.state.metrics
    sim.restore(snap)
    sim.run(40)
    expect(sim.state.metrics).toEqual(first)
  })

  it('keeps traffic moving and completes trips', () => {
    const sim = new Simulation(data, params)
    sim.run(240)
    const m = sim.state.metrics
    expect(m.speed).toBeGreaterThan(8)
    expect(sim.state.arrivals).toBeGreaterThan(20)
    expect(m.vehicles).toBeGreaterThan(params.vehicles * 0.9)
  })

  it('dispatches an ambulance to a blocking accident and clears it', () => {
    const preset = SCENARIOS.find((s) => s.id === 'oriental')!
    const sim = new Simulation(data, { ...params, incidentRate: 0 })
    const events = preset.events(sim.g, sim.state.subs.map((s) => s.name)).map((e) => ({ ...e, duration: 60 }))
    sim.reset({ ...params, incidentRate: 0 }, events)
    sim.run(400)
    const inc = sim.state.incidents[0]
    expect(inc.dispatch?.candidates.length).toBeGreaterThan(0)
    expect(inc.arrivedAt).toBeGreaterThan(inc.t)
    expect(inc.status).toBe('resolved')
  })

  it('a substation trip darkens its signals and is repaired', () => {
    const sim = new Simulation(data, params)
    sim.tripSubstation(0, 30)
    expect(sim.state.metrics.outages).toBe(0)
    sim.run(5)
    expect(sim.state.metrics.outages).toBe(1)
    expect(sim.state.metrics.power).toBeLessThan(1)
    sim.run(40)
    expect(sim.state.subs[0].online).toBe(true)
  })

  it('experiment runner summarises a run', () => {
    const sim = new Simulation(data, params)
    const r = runExperiment(sim, { label: 'test', params, events: [], duration: 180 })
    expect(r.summary.speed).toBeGreaterThan(0)
    expect(r.history.length).toBeGreaterThan(10)
  })
})
