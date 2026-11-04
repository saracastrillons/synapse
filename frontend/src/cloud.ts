import { create } from 'zustand'
import type { ExperimentSummary } from './sim/experiment'
import type { Sample, SimParams } from './sim/types'
import type { LabRun } from './store'
import { parsePresetKey, presetKey } from './sim/cities'
import { runtime } from './runtime'

/**
 * Client for the optional SYNAPSE API. The twin is fully usable offline; when the
 * API is reachable, users can sign in, keep scenarios and experiments in shared
 * projects, collaborate live and publish read-only links.
 */
export const API_URL: string = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8010'
const TOKEN_KEY = 'synapse.token'

export interface User { id: number; email: string; name: string }
export interface Project { id: number; name: string; description: string; role: 'owner' | 'editor' | 'viewer'; scenario_count: number; run_count: number }
export interface Member { user: User; role: string }
export interface ScenarioRec { id: number; name: string; preset: string; params: SimParams; intervention: { label?: string; params?: Partial<SimParams> } | null; notes: string; version: number; updated_at: string }
export interface StatRow { kpi: string; mean_a: number; mean_b: number; sd_a: number; sd_b: number; delta: number; better: boolean | null; consistent: boolean; p_value: number | null }
export interface RunRec { id: number; preset: string; label_a: string; label_b: string; duration: number; params_a: SimParams; params_b: SimParams; stats: StatRow[]; verdict: 'A' | 'B' | 'tie'; created_at: string }
export interface CommentRec { id: number; text: string; created_at: string; user: User }
export interface FeedItem { t: number; text: string }

interface Cloud {
  online: boolean | null
  info: { database?: string; postgis?: boolean; pgrouting?: boolean; events?: string; copilot?: { enabled: boolean; model: string } }
  user: User | null
  projects: Project[]
  project: Project | null
  members: Member[]
  scenarios: ScenarioRec[]
  runs: RunRec[]
  presence: { id: number; name: string }[]
  feed: FeedItem[]
}

export const useCloud = create<Cloud>(() => ({
  online: null, info: {}, user: null, projects: [], project: null, members: [], scenarios: [], runs: [], presence: [], feed: [],
}))

function token() {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) }
  const t = token()
  if (t) headers.Authorization = `Bearer ${t}`
  if (init.json !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${API_URL}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body })
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const detail = Array.isArray(body.detail) ? body.detail.map((d: { msg: string }) => d.msg).join('; ') : body.detail
    if (res.status === 401 && t) logout()
    throw new ApiError(res.status, detail ?? res.statusText)
  }
  return body as T
}

// ───────────────────────────── session
export async function connect() {
  try {
    const info = await api<Cloud['info']>('/api/health')
    useCloud.setState({ online: true, info })
  } catch {
    useCloud.setState({ online: false })
    return
  }
  if (token()) {
    try {
      useCloud.setState({ user: await api<User>('/api/auth/me') })
      await loadProjects()
    } catch { /* expired token: stay signed out */ }
  }
}

export async function signIn(mode: 'login' | 'register', body: { email: string; password: string; name?: string }) {
  const r = await api<{ token: string; user: User }>(`/api/auth/${mode}`, { method: 'POST', json: body })
  try {
    localStorage.setItem(TOKEN_KEY, r.token)
  } catch { /* private mode: session-only */ }
  useCloud.setState({ user: r.user })
  await loadProjects()
  if (!useCloud.getState().projects.length) await createProject('Medellín pilot', 'First SYNAPSE workspace')
}

export function logout() {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch { /* ignore */ }
  socket?.close()
  useCloud.setState({ user: null, projects: [], project: null, members: [], scenarios: [], runs: [], presence: [], feed: [] })
}

// ───────────────────────────── projects
export async function loadProjects() {
  const projects = await api<Project[]>('/api/projects')
  const current = useCloud.getState().project
  useCloud.setState({ projects })
  const pick = projects.find((p) => p.id === current?.id) ?? projects[0]
  if (pick) await openProject(pick.id)
}

export async function createProject(name: string, description = '') {
  const p = await api<Project>('/api/projects', { method: 'POST', json: { name, description } })
  useCloud.setState({ projects: [p, ...useCloud.getState().projects] })
  await openProject(p.id)
}

export async function openProject(id: number) {
  const [project, members, scenarios, runs] = await Promise.all([
    api<Project>(`/api/projects/${id}`), api<Member[]>(`/api/projects/${id}/members`),
    api<ScenarioRec[]>(`/api/projects/${id}/scenarios`), api<RunRec[]>(`/api/projects/${id}/runs`),
  ])
  useCloud.setState({ project, members, scenarios, runs })
  openSocket(id)
}

export async function refreshProject() {
  const p = useCloud.getState().project
  if (!p) return
  const [scenarios, runs, members] = await Promise.all([
    api<ScenarioRec[]>(`/api/projects/${p.id}/scenarios`), api<RunRec[]>(`/api/projects/${p.id}/runs`), api<Member[]>(`/api/projects/${p.id}/members`),
  ])
  useCloud.setState({ scenarios, runs, members })
}

export async function invite(email: string, role: 'editor' | 'viewer') {
  const p = useCloud.getState().project!
  await api(`/api/projects/${p.id}/members`, { method: 'POST', json: { email, role } })
  await refreshProject()
}

// ───────────────────────────── scenarios & runs
export async function saveScenario(name: string, preset: string, params: SimParams, intervention?: { label: string; params: Partial<SimParams> }) {
  const p = useCloud.getState().project!
  await api(`/api/projects/${p.id}/scenarios`, { method: 'POST', json: { name, preset: presetKey(runtime.city.id, preset), params, intervention: intervention ?? null } })
  await refreshProject()
}

const numeric = (s: ExperimentSummary) => Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v === 'number' && isFinite(v)))
const thin = (h: Sample[]) => h.filter((_, i) => i % 2 === 0) as unknown as Record<string, number>[]

export async function saveRun(run: LabRun) {
  const p = useCloud.getState().project!
  const strip = (x: SimParams): SimParams => {
    const { seed, vehicles, capacity, smartNav, signals, preemption, storm, powerDemand, repairCrews, ambulances, incidentRate, startHour, dynamicDemand, metro } = x
    return { seed, vehicles, capacity, smartNav, signals, preemption, storm, powerDemand, repairCrews, ambulances, incidentRate, startHour, dynamicDemand, metro }
  }
  const saved = await api<RunRec>(`/api/projects/${p.id}/runs`, {
    method: 'POST',
    json: {
      preset: presetKey(run.city ?? 'medellin', run.scenario), label_a: run.labelA, label_b: run.labelB, duration: run.duration,
      params_a: strip(run.a[0].params), params_b: strip({ ...run.b[0].params, seed: run.a[0].params.seed }),
      a: run.a.map((r) => ({ seed: r.seed, summary: numeric(r.summary), history: thin(r.history) })),
      b: run.b.map((r) => ({ seed: r.seed, summary: numeric(r.summary), history: thin(r.history) })),
    },
  })
  await refreshProject()
  return saved
}

interface RunDetail extends RunRec {
  replicates: { a: { seed: number; summary: ExperimentSummary; history: Sample[] }[]; b: { seed: number; summary: ExperimentSummary; history: Sample[] }[] }
}

export function detailToLabRun(d: RunDetail): LabRun {
  const arm = (reps: RunDetail['replicates']['a'], label: string, params: SimParams) =>
    reps.map((r) => ({ label, seed: r.seed, params: { ...params, seed: r.seed }, summary: r.summary, history: r.history, wallMs: 0 }))
  return {
    id: d.id, scenario: parsePresetKey(d.preset).preset, city: parsePresetKey(d.preset).city, labelA: d.label_a, labelB: d.label_b, duration: d.duration, createdAt: Date.parse(d.created_at),
    a: arm(d.replicates.a, d.label_a, d.params_a), b: arm(d.replicates.b, d.label_b, d.params_b),
  }
}

export async function fetchRun(id: number) {
  return detailToLabRun(await api<RunDetail>(`/api/runs/${id}`))
}

export const comments = (runId: number) => api<CommentRec[]>(`/api/runs/${runId}/comments`)
export const addComment = (runId: number, text: string) => api<CommentRec>(`/api/runs/${runId}/comments`, { method: 'POST', json: { text } })

export async function share(kind: 'scenario' | 'run', id: number) {
  const r = await api<{ token: string }>('/api/share', { method: 'POST', json: { kind, id } })
  return `${location.origin}${location.pathname}?share=${r.token}`
}

export async function openShared(tokenValue: string) {
  return api<{ kind: 'scenario' | 'run'; project: string; views: number; data: Record<string, unknown> }>(`/api/share/${encodeURIComponent(tokenValue)}`)
}

// ───────────────────────────── live collaboration
let socket: WebSocket | null = null

function openSocket(projectId: number) {
  socket?.close()
  const t = token()
  if (!t) return
  const ws = new WebSocket(`${API_URL.replace(/^http/, 'ws')}/api/ws/projects/${projectId}`)
  socket = ws
  // authenticate in-band: tokens in URLs end up in server and proxy logs
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: t }))
  ws.onmessage = (ev) => {
    const e = JSON.parse(ev.data)
    if (e.type === 'presence') {
      useCloud.setState({ presence: e.users })
      return
    }
    const text = e.type === 'scenario_saved' ? `${e.by} saved scenario “${e.name}”${e.version ? ` (v${e.version})` : ''}`
      : e.type === 'run_saved' ? `${e.by} saved experiment “${e.label}” · verdict ${e.verdict}`
      : e.type === 'comment' ? `${e.by}: “${e.text}”`
      : e.type === 'member_added' ? `${e.by} added ${e.user} as ${e.role}`
      : e.type === 'activity' ? `${e.by} ${e.text}` : null
    if (text) useCloud.setState({ feed: [{ t: Date.now(), text }, ...useCloud.getState().feed].slice(0, 30) })
    if (e.type === 'scenario_saved' || e.type === 'run_saved' || e.type === 'member_added') refreshProject().catch(() => {})
  }
  ws.onclose = () => {
    if (socket === ws) useCloud.setState({ presence: [] })
  }
}

export function broadcastActivity(text: string) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'activity', text }))
}
