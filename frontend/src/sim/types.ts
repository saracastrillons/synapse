export type RoadClass = 'arterial' | 'collector' | 'local'

export interface TransitLineData {
  id: string
  ref: string
  name: string
  mode: 'metro' | 'rail' | 'tram'
  colour: string
  /** [x, z, elevation] — elevation: -1 tunnel, 0 at grade, 1 viaduct */
  pts: [number, number, number][]
  len: number
  stations: { name: string; s: number }[]
  /** 'construction': mapped but not in service yet (rendered as works, no trains) */
  status?: 'open' | 'construction'
}

export interface CityData {
  meta: {
    id?: string
    city: string
    area: string
    country: string
    center: { lat: number; lon: number }
    extent: { halfWidth: number; halfHeight: number }
    source: string
    notes: string
  }
  roads: {
    nodes: [number, number][]
    edges: {
      a: number
      b: number
      pts: [number, number][]
      len: number
      cls: RoadClass
      lanes: number
      speed: number
      oneway: boolean
      name: string
    }[]
  }
  buildings: { p: [number, number][]; h: number; est: boolean | 'proc' }[]
  pois: { kind: 'hospital' | 'fire' | 'police' | 'substation'; name: string; x: number; z: number }[]
  transit?: { lines: TransitLineData[] }
}

export type SignalStrategy = 'fixed' | 'adaptive'

export interface SimParams {
  seed: number
  /** target number of private vehicles in the network */
  vehicles: number
  /** multiplier on usable lanes (road works, lane closures, extra capacity) */
  capacity: number
  /** share of agents with live, congestion-aware navigation (0–1) */
  smartNav: number
  signals: SignalStrategy
  /** emergency vehicles request green at signalized junctions */
  preemption: boolean
  /** storm intensity 0–1: lowers speeds and raises substation failure hazard */
  storm: number
  /** electricity demand multiplier */
  powerDemand: number
  /** repair crews available for the power grid (1–4) */
  repairCrews: number
  /** ambulances stationed per hospital */
  ambulances: number
  /** random emergencies per simulated hour */
  incidentRate: number
  /** clock time when the simulation starts (hours, 0–24) */
  startHour: number
  /** traffic follows the daily demand curve; `vehicles` is then the peak-hour count */
  dynamicDemand: boolean
  /** rail transit service level: 1 normal, 0.5 half the trains, 0 suspended */
  metro: number
}

export const DEFAULT_PARAMS: SimParams = {
  seed: 2026,
  vehicles: 1300,
  capacity: 1,
  smartNav: 0.35,
  signals: 'adaptive',
  preemption: true,
  storm: 0,
  powerDemand: 1,
  repairCrews: 2,
  ambulances: 1,
  incidentRate: 4,
  startHour: 7,
  dynamicDemand: true,
  metro: 1,
}

export type VehicleKind = 'car' | 'bus' | 'taxi' | 'ambulance' | 'fire'

export interface AgentLog {
  t: number
  msg: string
}

export interface Mission {
  incident: number
  unit: number
  phase: 'toScene' | 'onScene' | 'return'
  sceneEdge: number
  sceneS: number
  until: number
}

export interface Vehicle {
  id: number
  kind: VehicleKind
  edge: number
  lane: number
  s: number
  v: number
  route: number[]
  ri: number
  dest: number
  born: number
  strategy: 'static' | 'adaptive'
  /** desired time headway (s) — personality: lower = more aggressive */
  headway: number
  /** fraction of the speed limit this agent targets */
  speedFactor: number
  stopped: number
  nextReroute: number
  dist: number
  reroutes: number
  log: AgentLog[]
  mission?: Mission
  /** set when a known blockage forces a reroute regardless of expected gain */
  force?: boolean
}

export interface Signal {
  node: number
  groups: [number[], number[]]
  phase: 0 | 1
  /** time in current phase */
  pt: number
  /** remaining all-red clearance time */
  clear: number
  preempt: -1 | 0 | 1
  preemptUntil: number
  sector: number
}

export type IncidentKind = 'accident' | 'medical' | 'fire'

export interface Incident {
  id: number
  kind: IncidentKind
  edge: number
  s: number
  x: number
  z: number
  t: number
  blocks: boolean
  severity: 1 | 2 | 3
  status: 'pending' | 'responding' | 'onScene' | 'resolved'
  unit: number
  arrivedAt: number
  clearAfter: number
  label: string
  dispatch?: DispatchDecision
}

export interface DispatchDecision {
  t: number
  candidates: { unit: number; name: string; eta: number; expanded: number }[]
  chosen: number
  algorithm: string
}

export interface Unit {
  id: number
  kind: 'ambulance' | 'fire'
  home: number
  name: string
  status: 'idle' | 'busy'
  vehicle: number
}

export interface Substation {
  name: string
  x: number
  z: number
  capacity: number
  load: number
  online: boolean
  repairAt: number
  failures: number
}

export interface Alert {
  id: number
  t: number
  level: 'info' | 'warn' | 'crit'
  msg: string
  x?: number
  z?: number
}

export interface Sample {
  t: number
  speed: number
  congestion: number
  throughput: number
  co2: number
  power: number
  response: number
  trip: number
  vehicles: number
  stopped: number
  /** rail transit riders per hour */
  riders: number
}

export interface Metrics extends Sample {
  arrivals: number
  removed: number
  activeIncidents: number
  outages: number
  /** vehicles the demand model wants on the road right now */
  demandTarget: number
  hour: number
  trainsInService: number
}

export type ScheduledEvent =
  | { t: number; type: 'block'; edge: number; duration?: number; label?: string }
  | { t: number; type: 'storm'; intensity: number }
  | { t: number; type: 'trip'; sub: number; duration: number }
  | { t: number; type: 'medical'; node: number; label?: string }
  | { t: number; type: 'demand'; vehicles: number }
  | { t: number; type: 'metro'; level: number; label?: string }

export interface SimState {
  t: number
  rng: number
  nextId: number
  params: SimParams
  vehicles: Vehicle[]
  signals: Signal[]
  edgeSpeed: Float32Array
  edgeMean: Float32Array
  edgeVar: Float32Array
  edgeCount: Uint16Array
  edgeAlertAt: Float32Array
  incidents: Incident[]
  units: Unit[]
  subs: Substation[]
  alerts: Alert[]
  history: Sample[]
  metrics: Metrics
  arrivalsLog: number[]
  tripLog: number[]
  responseLog: number[]
  events: ScheduledEvent[]
  rerouteQueue: number[]
  nextAlertId: number
  removed: number
  arrivals: number
  /** second-of-day at which rail service was suspended (trains hold position), or null */
  transitHold: number | null
  acc: { second: number; sample: number; spawnBudget: number }
}
