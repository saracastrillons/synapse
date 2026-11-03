import { create } from 'zustand'
import type { Alert, Incident, Metrics, Sample, SimParams, Substation, Unit } from './sim/types'
import { DEFAULT_PARAMS } from './sim/types'
import type { ExperimentResult } from './sim/experiment'

export type Mode = 'boot' | 'globe' | 'descending' | 'city'
export type Panel = 'overview' | 'lab' | 'ai' | 'agents' | 'data' | 'cloud'
export type Tool = 'select' | 'block' | 'medical' | 'fire'
export type LayerKey = 'heatmap' | 'signals' | 'grid' | 'routes' | 'labels' | 'buildings'

export interface VehicleView {
  id: number
  kind: string
  strategy: string
  speed: number
  street: string
  remaining: number
  eta: number
  dist: number
  age: number
  headway: number
  speedFactor: number
  reroutes: number
  stopped: number
  log: { t: number; msg: string }[]
  mission?: string
}

export interface LiveView {
  t: number
  metrics: Metrics
  history: Sample[]
  alerts: Alert[]
  incidents: Incident[]
  subs: Substation[]
  units: Unit[]
  agents: { adaptive: number; static: number; bus: number; taxi: number; emergency: number; reroutes: number }
  forecast: { in10: number; slope: number }
  selected?: VehicleView
}

export interface Branch {
  id: number
  name: string
  color: string
  forkT: number
  history: Sample[]
}

export interface ChatMessage {
  id: number
  role: 'user' | 'ai'
  text: string
  tools?: { name: string; args: string; result: string; ms: number; started?: number }[]
  startedAt?: number
  finishedAt?: number
  xai?: XaiCard
  actions?: { label: string; run: () => void }[]
  pending?: boolean
  /** which engine produced the answer */
  engine?: 'llm' | 'local'
  notice?: string
}

export interface XaiCard {
  title: string
  recommendation: string
  confidence: string
  factors: { label: string; delta: number; display: string; good: boolean }[]
  evidence: string
}

export interface LabRun {
  id: number
  scenario: string
  a: ExperimentResult[]
  b: ExperimentResult[]
  labelA: string
  labelB: string
  duration: number
  createdAt: number
}

interface UI {
  mode: Mode
  panel: Panel | null
  tool: Tool
  layers: Record<LayerKey, boolean>
  paused: boolean
  speed: number
  live: LiveView | null
  selected: number | null
  follow: boolean
  scenarioId: string
  params: SimParams
  branches: Branch[]
  focus: { x: number; z: number; dist?: number; n: number } | null
  highlight: { edges: number[]; color: string; label?: string } | null
  chat: ChatMessage[]
  lab: { running: boolean; progress: number; label: string; runs: LabRun[] }
  showAbout: boolean
  bootLog: string[]
  bootError: string | null

  set: (p: Partial<UI>) => void
  setPanel: (p: Panel | null) => void
  toggleLayer: (k: LayerKey) => void
  focusOn: (x: number, z: number, dist?: number) => void
  pushChat: (m: Omit<ChatMessage, 'id'>) => number
  patchChat: (id: number, p: Partial<ChatMessage>) => void
}

let chatId = 1

export const useUI = create<UI>((set, get) => ({
  mode: 'boot',
  // phones open on the map; panels are one tap away in the bottom rail
  panel: typeof window !== 'undefined' && window.innerWidth < 760 ? null : 'overview',
  tool: 'select',
  layers: { heatmap: true, signals: true, grid: false, routes: true, labels: true, buildings: true },
  paused: false,
  speed: 4,
  live: null,
  selected: null,
  follow: false,
  scenarioId: 'baseline',
  params: { ...DEFAULT_PARAMS },
  branches: [],
  focus: null,
  highlight: null,
  chat: [],
  lab: { running: false, progress: 0, label: '', runs: [] },
  showAbout: false,
  bootLog: [],
  bootError: null,

  set: (p) => set(p),
  setPanel: (p) => set({ panel: get().panel === p ? null : p }),
  toggleLayer: (k) => set({ layers: { ...get().layers, [k]: !get().layers[k] } }),
  focusOn: (x, z, dist) => set({ focus: { x, z, dist, n: (get().focus?.n ?? 0) + 1 } }),
  pushChat: (m) => {
    const id = chatId++
    set({ chat: [...get().chat, { ...m, id }] })
    return id
  },
  patchChat: (id, p) => set({ chat: get().chat.map((m) => (m.id === id ? { ...m, ...p } : m)) }),
}))
