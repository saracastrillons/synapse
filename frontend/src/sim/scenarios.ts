import type { RoadGraph } from './graph'
import type { ScheduledEvent, SimParams } from './types'

export interface ScenarioPreset {
  id: string
  name: string
  tagline: string
  question: string
  params: Partial<SimParams>
  events: (g: RoadGraph, subs: string[]) => ScheduledEvent[]
  /** the intervention Scenario Lab proposes to test against this situation */
  intervention?: { label: string; params: Partial<SimParams> }
}

const subIndex = (subs: string[], needle: string) => Math.max(0, subs.findIndex((s) => s.toLowerCase().includes(needle)))

export const SCENARIOS: ScenarioPreset[] = [
  {
    id: 'baseline',
    name: 'Baseline · Tuesday 07:00',
    tagline: 'Normal morning operation of Medellín Centro',
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
    id: 'oriental',
    name: 'Accident · Avenida Oriental',
    tagline: 'A collision blocks the main north–south arterial for 10 minutes',
    question: 'A major accident just blocked Avenida Oriental. What is the fastest way to restore traffic flow?',
    params: { incidentRate: 0 },
    events: (g) => {
      const a = g.findEdgeByName('Avenida Oriental', [450, -150])
      const b = g.findEdgeByName('Avenida Oriental', [500, 250])
      return [
        { t: 45, type: 'block', edge: a, duration: 600, label: 'Multi-vehicle collision on Avenida Oriental' },
        ...(b !== a ? [{ t: 45, type: 'block' as const, edge: b, duration: 600, label: 'Debris on Avenida Oriental (southbound)' }] : []),
      ]
    },
    intervention: { label: 'Broadcast incident to 75% of drivers', params: { smartNav: 0.75 } },
  },
  {
    id: 'storm',
    name: 'Storm & blackout',
    tagline: 'A severe storm knocks out Subestación Central EPM',
    question: 'If a storm cuts power to downtown, how much does mobility degrade and how fast do we recover?',
    params: { incidentRate: 6 },
    events: (_g, subs) => [
      { t: 20, type: 'storm', intensity: 0.85 },
      { t: 75, type: 'trip', sub: subIndex(subs, 'central'), duration: 900 },
    ],
    intervention: { label: 'Deploy 4 repair crews', params: { repairCrews: 4 } },
  },
  {
    id: 'ambulance',
    name: 'Ambulance gauntlet',
    tagline: 'Three arterials blocked while a cardiac emergency happens downtown',
    question: 'Can an ambulance reach a patient in time when the main arterials are blocked?',
    params: { incidentRate: 0, vehicles: 1500 },
    events: (g) => [
      { t: 20, type: 'block', edge: g.findEdgeByName('Avenida Oriental', [450, -150]), duration: 900, label: 'Collision on Avenida Oriental' },
      { t: 20, type: 'block', edge: g.findEdgeByName('Avenida del Ferrocarril'), duration: 900, label: 'Collision on Avenida del Ferrocarril' },
      { t: 20, type: 'block', edge: g.findEdgeByName('Avenida Calle 37'), duration: 900, label: 'Road works on Avenida Calle 37' },
      { t: 90, type: 'medical', node: g.nearestNode(-560, 420), label: 'Cardiac arrest · Parque Berrío area' },
      { t: 150, type: 'medical', node: g.nearestNode(-200, -650), label: 'Respiratory emergency · San Benito' },
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
]
