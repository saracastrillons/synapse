import type { RoadGraph } from './graph'
import { toLocal, type CityConfig } from './cities'
import type { CityData, ScheduledEvent, SimParams } from './types'

export interface ScenarioContext {
  g: RoadGraph
  data: CityData
  city: CityConfig
  subs: { name: string; capacity: number }[]
}

export interface ScenarioPreset {
  id: string
  name: string
  tagline: string
  question: string
  params: Partial<SimParams>
  events: (ctx: ScenarioContext) => ScheduledEvent[]
  /** the intervention Scenario Lab proposes to test against this situation */
  intervention?: { label: string; params: Partial<SimParams> }
}

/** the substation called "central" if any, otherwise the one feeding the largest load */
function keySubstation(subs: ScenarioContext['subs']) {
  const central = subs.findIndex((s) => /central/i.test(s.name))
  if (central >= 0) return central
  return subs.reduce((best, s, i) => (s.capacity > subs[best].capacity ? i : best), 0)
}

function arterialEdge(ctx: ScenarioContext, i: number) {
  const a = ctx.city.arterials[i]
  if (!a) return -1
  const near = a.lat != null && a.lon != null ? toLocal(ctx.data, a.lat, a.lon) : undefined
  return ctx.g.findEdgeByName(a.name, near)
}

/** Scenario presets for one city. Ids are stable across cities so saved experiments stay comparable. */
export function buildScenarios(city: CityConfig, data: CityData): ScenarioPreset[] {
  const [a0, a1, a2] = city.arterials.map((a) => a.name)
  const hasRail = (data.transit?.lines ?? []).some((l) => l.status !== 'construction')
  const presets: ScenarioPreset[] = [
    {
      id: 'baseline',
      name: 'Baseline · weekday 07:00',
      tagline: `Normal morning operation of ${city.name} ${city.area.split(' · ')[0]}`,
      question: 'How does the city behave on an ordinary morning?',
      params: {},
      events: () => [],
      intervention: { label: 'Fixed-time signals instead of adaptive', params: { signals: 'fixed' } },
    },
    {
      id: 'rush40',
      name: 'Traffic demand +40%',
      tagline: 'Peak-hour surge across the whole network',
      question: 'What happens if traffic grows 40% — and can connected navigation absorb it?',
      params: { vehicles: 1820 },
      events: () => [],
      intervention: { label: '70% of drivers on live navigation', params: { smartNav: 0.7 } },
    },
    {
      id: 'accident',
      name: `Accident · ${a0}`,
      tagline: `A collision blocks ${a0} for 10 minutes`,
      question: `A major accident just blocked ${a0}. What is the fastest way to restore traffic flow?`,
      params: { incidentRate: 0 },
      events: (ctx) => [{ t: 45, type: 'block', edge: arterialEdge(ctx, 0), duration: 600, label: `Multi-vehicle collision on ${a0}` }],
      intervention: { label: 'Broadcast incident to 75% of drivers', params: { smartNav: 0.75 } },
    },
  ]
  if (hasRail) {
    presets.push({
      id: 'metro',
      name: 'Rail outage at rush hour',
      tagline: 'Every rail line stops at 07:16 and riders take to the roads',
      question: 'If the metro stops during the morning peak, how bad does traffic get — and what mitigates it?',
      params: { startHour: 7.25, incidentRate: 0 },
      events: () => [{ t: 60, type: 'metro', level: 0, label: 'Rail service suspended (power fault) · trains held · riders shift to buses, taxis and cars' }],
      intervention: { label: 'Bus bridge lanes + live navigation', params: { capacity: 1.15, smartNav: 0.8 } },
    })
  }
  presets.push(
    {
      id: 'evening',
      name: 'Evening peak · 17:45',
      tagline: 'The afternoon commute builds up as the sun sets',
      question: 'Is the evening peak worse than the morning one, and does staggering work hours help?',
      params: { startHour: 17.75 },
      events: () => [],
      intervention: { label: 'Staggered hours: −15% peak demand', params: { vehicles: 1105 } },
    },
    {
      id: 'storm',
      name: 'Storm & blackout',
      tagline: 'A severe storm knocks out a key substation',
      question: 'If a storm cuts power to downtown, how much does mobility degrade and how fast do we recover?',
      params: { incidentRate: 6 },
      events: (ctx) => [
        { t: 20, type: 'storm', intensity: 0.85 },
        { t: 75, type: 'trip', sub: keySubstation(ctx.subs), duration: 900 },
      ],
      intervention: { label: 'Deploy 4 repair crews', params: { repairCrews: 4 } },
    },
    {
      id: 'ambulance',
      name: 'Ambulance gauntlet',
      tagline: 'Three arterials blocked while medical emergencies happen downtown',
      question: 'Can an ambulance reach a patient in time when the main arterials are blocked?',
      params: { incidentRate: 0, vehicles: 1500 },
      events: (ctx) => [
        ...[a0, a1, a2].map((name, i) => ({ t: 20, type: 'block' as const, edge: arterialEdge(ctx, i), duration: 900, label: `${i === 2 ? 'Road works' : 'Collision'} on ${name}` })),
        ...ctx.city.spots.map((s, i) => {
          const [x, z] = toLocal(ctx.data, s.lat, s.lon)
          return { t: 90 + i * 60, type: 'medical' as const, node: ctx.g.nearestNode(x, z), label: `${i === 0 ? 'Cardiac arrest' : 'Respiratory emergency'} · ${s.label}` }
        }),
      ],
      intervention: { label: 'Disable signal pre-emption', params: { preemption: false } },
    },
    {
      id: 'heat',
      name: 'Heat wave · grid stress',
      tagline: 'Air-conditioning pushes electricity demand 35% above normal',
      question: 'Will the grid hold under a demand spike, and what do outages do to traffic?',
      params: { powerDemand: 1.35, incidentRate: 3 },
      events: () => [],
      intervention: { label: 'Demand response: cut load to 105%', params: { powerDemand: 1.05 } },
    },
  )
  return presets
}

/** Current city's presets (mutated in place when the city changes so imports stay valid). */
export const SCENARIOS: ScenarioPreset[] = []

export function setScenarioCity(city: CityConfig, data: CityData) {
  SCENARIOS.splice(0, SCENARIOS.length, ...buildScenarios(city, data))
}

/** Older saved experiments used the id "oriental" for the accident preset. */
export function scenarioById(id: string) {
  const bare = id.includes('/') ? id.split('/')[1] : id
  return SCENARIOS.find((s) => s.id === (bare === 'oriental' ? 'accident' : bare))
}
