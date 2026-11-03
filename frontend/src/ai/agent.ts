import { api, useCloud } from '../cloud'
import { clock, runtime } from '../runtime'
import { fmtDuration } from '../sim/engine'
import type { ScheduledEvent, SimParams } from '../sim/types'
import { useUI, type XaiCard } from '../store'
import {
  activeBlock, askLocal, cityState, detour, experiments, findStreet, hotspots, isSpanish, progress, rank, say, tool, xai,
  type Ctx, type Ranked,
} from './copilot'

/**
 * LLM agent loop. Gemini (behind the SYNAPSE API, which owns the key, the system
 * prompt and the tool catalogue) decides which tools to call; the browser runs them
 * against the live twin and the experiment worker, sends the results back, and the
 * model writes the final answer from that evidence. Policy changes are only
 * *proposed* — the user applies them with a button (human in the loop).
 */

interface Part {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> }
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> }
}
interface Content { role: 'user' | 'model'; parts: Part[] }

const MAX_STEPS = 8
let history: Content[] = []

export function resetAgent() {
  history = []
}

const LIMITS: Record<string, [number, number]> = {
  vehicles: [200, 2400], capacity: [0.5, 1.5], smartNav: [0, 1], storm: [0, 1], powerDemand: [0.6, 1.6],
  repairCrews: [1, 4], ambulances: [1, 3], incidentRate: [0, 20],
}
const INTEGER = new Set(['vehicles', 'repairCrews', 'ambulances'])

/** Never trust model-supplied parameters: keep known keys, coerce types, clamp ranges. */
export function sanitizeParams(raw: unknown): Partial<SimParams> {
  const out: Record<string, unknown> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k in LIMITS && typeof v === 'number' && isFinite(v)) {
      const [lo, hi] = LIMITS[k]
      const x = Math.min(hi, Math.max(lo, v))
      out[k] = INTEGER.has(k) ? Math.round(x) : x
    } else if (k === 'signals' && (v === 'fixed' || v === 'adaptive')) out[k] = v
    else if (k === 'preemption' && typeof v === 'boolean') out[k] = v
  }
  return out as Partial<SimParams>
}

interface TurnState {
  experiment?: { ranked: Ranked[]; baseLabel: string; objective: string; seeds: number }
  proposals: { label: string; params: Partial<SimParams> }[]
}

const OBJECTIVES: Record<string, (m: Record<string, number>) => number> = {
  traffic: (m) => m.congestion * 100 + m.trip / 30 + m.removed * 0.5,
  emergency: (m) => (m.response || 999) + m.congestion * 20,
  grid: (m) => (1 - m.power) * 100 + m.congestion * 30,
}

function streetOrError(street: unknown) {
  const edge = findStreet(String(street ?? ''))
  if (edge >= 0) return { edge }
  const names = [...new Set(runtime.sim.g.edges.map((e) => e.name).filter(Boolean))]
  const needle = String(street ?? '').toLowerCase().split(/\s+/).pop() ?? ''
  return { error: `Street "${street}" not found in the twin`, suggestions: names.filter((n) => n.toLowerCase().includes(needle)).slice(0, 6) }
}

function focusEdge(edge: number, dist = 900) {
  const e = runtime.sim.g.edges[edge]
  const [x, z] = runtime.sim.g.posAt(e, e.len / 2, 0)
  useUI.getState().focusOn(x, z, dist)
}

async function execTool(ctx: Ctx, name: string, args: Record<string, unknown>, turn: TurnState): Promise<Record<string, unknown>> {
  const sim = runtime.sim
  switch (name) {
    case 'get_city_state':
      return tool(ctx, name, args, cityState, (r) => `${r.time} · ${r.speed} km/h · delay ${r.delay}% · ${r.tripsPerHour} trips/h`)

    case 'find_hotspots': {
      const k = Math.min(8, Math.max(1, Number(args.k) || 5))
      const spots = await tool(ctx, name, { k }, () => hotspots(k), (r) => r.map((h) => `${h.name}: ${h.speed.toFixed(0)} km/h`).join(' · ') || 'none')
      if (spots.length) {
        useUI.setState({ highlight: { edges: spots.flatMap((s) => s.edges), color: '#fbbf24', label: 'hotspots' } })
        focusEdge(spots[0].edges[0])
      }
      const f = useUI.getState().live?.forecast
      return {
        hotspots: spots.map((s) => ({ street: s.name, speed_kmh: +s.speed.toFixed(1), vehicles_queued: s.queued })),
        delay_index_now_pct: +(sim.state.metrics.congestion * 100).toFixed(1),
        forecast_10min_pct: f ? +(f.in10 * 100).toFixed(1) : null,
      }
    }

    case 'list_incidents':
      return tool(ctx, name, args, () => ({
        incidents: sim.state.incidents.filter((i) => i.status !== 'resolved').map((i) => ({
          id: i.id, kind: i.kind, label: i.label, status: i.status, blocks_lane: i.blocks,
          unit: sim.state.units[i.unit]?.name ?? null, minutes_ago: +((sim.state.t - i.t) / 60).toFixed(1),
        })),
      }), (r) => `${r.incidents.length} active`)

    case 'block_road': {
      const s = streetOrError(args.street)
      if ('error' in s) return tool(ctx, name, args, () => s, (r) => r.error ?? '')
      const minutes = Math.min(60, Math.max(1, Number(args.minutes) || 15))
      const inc = await tool(ctx, name, args, () => sim.createIncident('accident', s.edge, `Accident on ${sim.edgeName(s.edge)}`, minutes * 60),
        (r) => (r ? `incident #${r.id} · lane blocked` : 'already blocked'))
      if (inc) focusEdge(inc.edge)
      runtime.publish(true)
      return inc ? { incident_id: inc.id, street: sim.edgeName(inc.edge), clearance_min_after_arrival: minutes } : { error: 'That segment is already blocked' }
    }

    case 'clear_incident': {
      const id = Number(args.incident_id)
      return tool(ctx, name, args, () => {
        const inc = sim.state.incidents.find((i) => i.id === id && i.status !== 'resolved')
        if (!inc) return { error: `No active incident #${id}` }
        sim.clearIncident(id)
        runtime.publish(true)
        return { cleared: id }
      }, (r) => ('error' in r ? String(r.error) : `incident #${id} cleared`))
    }

    case 'compute_detour': {
      const inc = args.incident_id != null ? sim.state.incidents.find((i) => i.id === Number(args.incident_id)) : activeBlock()
      if (!inc) return tool(ctx, name, args, () => ({ error: 'No blocking incident to detour around' }), (r) => r.error)
      const d = await tool(ctx, name, { incident_id: inc.id }, () => detour(inc.edge),
        (r) => r.astar.found ? `${fmtDuration(r.astar.cost)} via ${r.via.join(', ') || 'local streets'} · A* ${r.astar.expanded} vs Dijkstra ${r.dijkstra.expanded} nodes` : 'no detour')
      if (d.astar.found) useUI.setState({ highlight: { edges: d.astar.edges, color: '#34d399', label: 'detour' } })
      return d.astar.found ? {
        street: sim.edgeName(inc.edge), detour_s: Math.round(d.astar.cost), direct_s: Math.round(d.original), detour_length_m: Math.round(d.len),
        via: d.via, astar_nodes_expanded: d.astar.expanded, dijkstra_nodes_expanded: d.dijkstra.expanded,
        astar_ms: +d.msA.toFixed(2), dijkstra_ms: +d.msD.toFixed(2), same_optimal_cost: Math.abs(d.astar.cost - d.dijkstra.cost) < 1e-6,
      } : { error: 'No detour exists around this segment' }
    }

    case 'evaluate_dispatch': {
      const s = streetOrError(args.street)
      if ('error' in s) return tool(ctx, name, args, () => s, (r) => r.error ?? '')
      const kind = args.unit === 'fire' ? 'fire' : 'ambulance'
      const etas = await tool(ctx, name, args, () => sim.unitEtas(s.edge, kind),
        (r) => r.slice(0, 3).map((x) => `${x.unit.name.split('·')[1]?.trim()}: ${fmtDuration(x.eta)}`).join(' · '))
      const best = etas.find((x) => x.unit.status === 'idle') ?? etas[0]
      if (best) useUI.setState({ highlight: { edges: best.edges, color: '#ff2d55', label: 'fastest unit route' } })
      return { street: sim.edgeName(s.edge), units: etas.slice(0, 6).map((x) => ({ unit: x.unit.name, eta_s: Math.round(x.eta), busy: x.unit.status === 'busy' })) }
    }

    case 'create_emergency': {
      const s = streetOrError(args.street)
      if ('error' in s) return tool(ctx, name, args, () => s, (r) => r.error ?? '')
      const kind = args.kind === 'fire' ? 'fire' : args.kind === 'accident' ? 'accident' : 'medical'
      const inc = await tool(ctx, name, args, () => sim.createIncident(kind, s.edge), (r) => (r ? `incident #${r.id} · dispatcher assigns the minimum-ETA unit` : 'not created'))
      if (!inc) return { error: 'Could not create the incident there' }
      focusEdge(inc.edge, 1100)
      runtime.publish(true)
      setTimeout(() => {
        const unit = sim.state.vehicles.find((v) => v.mission?.incident === inc.id)
        if (unit) useUI.setState({ selected: unit.id, follow: true })
      }, 1500)
      return { incident_id: inc.id, kind, street: sim.edgeName(inc.edge), note: 'Dispatch is automatic within 1 simulated second' }
    }

    case 'grid_status':
      return tool(ctx, name, args, () => ({
        substations: sim.state.subs.map((s) => ({
          name: s.name, online: s.online, load_pct: Math.round((s.load / s.capacity) * 100),
          repair_eta_s: s.online ? null : Math.max(0, Math.round(s.repairAt - sim.state.t)),
        })),
        power_served_pct: +(sim.state.metrics.power * 100).toFixed(1),
      }), (r) => r.substations.map((s) => `${s.name}: ${s.online ? `${s.load_pct}%` : 'OFFLINE'}`).join(' · '))

    case 'trip_substation': {
      const needle = String(args.name ?? '').toLowerCase()
      const i = sim.state.subs.findIndex((s) => s.name.toLowerCase().includes(needle) || needle.includes(s.name.toLowerCase()))
      const minutes = Math.min(60, Math.max(1, Number(args.minutes) || 10))
      return tool(ctx, name, args, () => {
        if (i < 0) return { error: `No substation matching "${args.name}"`, available: sim.state.subs.map((s) => s.name) }
        sim.tripSubstation(i, minutes * 60, 'requested by operator')
        runtime.focusSub(i)
        runtime.publish(true)
        return { offline: sim.state.subs[i].name, minutes }
      }, (r) => ('error' in r ? String(r.error) : `${r.offline} offline for ${minutes} min`))
    }

    case 'compare_algorithms': {
      const ext = runtime.data.meta.extent
      const a = sim.g.nearestNode(-ext.halfWidth * 0.8, -ext.halfHeight * 0.8)
      const b = sim.g.nearestNode(ext.halfWidth * 0.8, ext.halfHeight * 0.8)
      const r = await tool(ctx, name, {}, () => sim.compareAlgorithms(a, b),
        (x) => `A* ${x.astar.expanded} nodes · Dijkstra ${x.dijkstra.expanded} nodes · same cost ${fmtDuration(x.astar.cost)}`)
      useUI.setState({ highlight: { edges: r.astar.edges, color: '#22d3ee', label: 'A* route' } })
      useUI.getState().focusOn(0, 0, 3200)
      return {
        route_cost_s: Math.round(r.astar.cost), same_optimal_cost: Math.abs(r.astar.cost - r.dijkstra.cost) < 1e-6,
        astar: { nodes_expanded: r.astar.expanded, ms: +r.astar.ms.toFixed(2) }, dijkstra: { nodes_expanded: r.dijkstra.expanded, ms: +r.dijkstra.ms.toFixed(2) },
        heuristic: 'straight-line distance / max speed (admissible)',
      }
    }

    case 'run_experiment': {
      const raw = Array.isArray(args.strategies) ? (args.strategies as { label?: string; params?: unknown }[]) : []
      const strategies = raw.slice(0, 5).map((s, i) => ({ label: String(s.label || `Strategy ${i + 1}`).slice(0, 80), patch: sanitizeParams(s.params) }))
      if (strategies.length < 2) return { error: 'Provide at least 2 strategies (first = baseline)' }
      const objective = typeof args.objective === 'string' && args.objective in OBJECTIVES ? args.objective : 'traffic'
      const minutes = Math.min(15, Math.max(3, Number(args.minutes) || 7))
      const seeds = Math.min(3, Math.max(1, Number(args.seeds) || 2))
      const events: ScheduledEvent[] = []
      if (args.include_active_incidents !== false) {
        for (const inc of sim.state.incidents) {
          if (inc.blocks && inc.status !== 'resolved') events.push({ t: 30, type: 'block', edge: inc.edge, duration: 900, label: inc.label })
        }
      }
      if (typeof args.storm === 'number') events.push({ t: 20, type: 'storm', intensity: Math.min(1, Math.max(0, args.storm)) })
      if (typeof args.trip_substation === 'string') {
        const i = sim.state.subs.findIndex((s) => s.name.toLowerCase().includes(String(args.trip_substation).toLowerCase()))
        if (i >= 0) events.push({ t: 40, type: 'trip', sub: i, duration: 900 })
      }
      const base: SimParams = { ...sim.state.params, incidentRate: events.length ? 0 : sim.state.params.incidentRate }
      const results = await experiments(ctx, base, events, strategies, minutes * 60, seeds)
      const ranked = rank(results, strategies, OBJECTIVES[objective])
      turn.experiment = { ranked, baseLabel: strategies[0].label, objective, seeds }
      progress(ctx, ctx.L('Analysing results…', 'Analizando resultados…'))
      return {
        objective, minutes, seeds, events_reproduced: events.length, common_random_numbers: true,
        ranking_best_first: ranked.map((r) => ({
          label: r.label, is_baseline: r.label === strategies[0].label,
          delay_index_pct: +(r.m.congestion * 100).toFixed(1), mean_speed_kmh: +r.m.speed.toFixed(1), mean_trip_s: Math.round(r.m.trip),
          trips_per_hour: Math.round(r.m.throughput), co2_kg_h: Math.round(r.m.co2), power_served_pct: +(r.m.power * 100).toFixed(1),
          emergency_response_s: r.m.response ? Math.round(r.m.response) : null, abandoned_trips: +r.m.removed.toFixed(1),
          beats_baseline_in_every_seed: r.consistent,
        })),
      }
    }

    case 'propose_parameters': {
      const params = sanitizeParams(args.params)
      const label = String(args.label || 'Proposed policy').slice(0, 80)
      return tool(ctx, name, { label, params }, () => {
        if (Object.keys(params).length) turn.proposals.push({ label, params })
        return { status: Object.keys(params).length ? 'shown to the user as a button; not applied yet' : 'no valid parameters', params }
      }, (r) => r.status)
    }

    case 'focus_map': {
      const s = streetOrError(args.street)
      return tool(ctx, name, args, (): Record<string, unknown> => {
        if ('error' in s) return { error: s.error, suggestions: s.suggestions }
        focusEdge(s.edge, 700)
        return { focused: sim.edgeName(s.edge) }
      }, (r) => (r.error ? String(r.error) : `camera on ${r.focused}`))
    }

    default:
      return { error: `Unknown tool ${name}` }
  }
}

function card(ctx: Ctx, turn: TurnState): XaiCard | undefined {
  const exp = turn.experiment
  if (!exp) return undefined
  const best = exp.ranked[0]
  const base = exp.ranked.find((r) => r.label === exp.baseLabel) ?? exp.ranked[exp.ranked.length - 1]
  const title = exp.objective === 'emergency' ? ctx.L('Emergency response', 'Respuesta a emergencias')
    : exp.objective === 'grid' ? ctx.L('Grid resilience', 'Resiliencia eléctrica') : ctx.L('Traffic flow', 'Flujo vehicular')
  const c = xai(ctx, title, best, base, exp.seeds)
  if (exp.objective === 'emergency' && base.m.response) {
    c.factors.unshift({ label: ctx.L('Response time', 'Tiempo de respuesta'), delta: (best.m.response - base.m.response) / base.m.response, display: `${Math.round(best.m.response - base.m.response)} s`, good: best.m.response <= base.m.response })
  }
  if (exp.objective === 'grid') {
    c.factors.unshift({ label: ctx.L('Power served', 'Energía servida'), delta: (best.m.power - base.m.power) / (base.m.power || 1), display: `${((best.m.power - base.m.power) * 100).toFixed(1)} pp`, good: best.m.power >= base.m.power })
  }
  return c
}

/** Ask the LLM agent; falls back to the on-device planner when the API or the key is unavailable. */
export async function ask(text: string, engine: 'llm' | 'local') {
  if (engine === 'local') return askLocal(text)
  const ui = useUI.getState()
  const userId = ui.pushChat({ role: 'user', text })
  const lang = isSpanish(text) ? 'es' : 'en'
  const id = ui.pushChat({ role: 'ai', text: lang === 'es' ? 'Gemini está planificando…' : 'Gemini is planning…', pending: true, tools: [], engine: 'llm', startedAt: Date.now() })
  const ctx: Ctx = { id, lang, tools: [], L: (en, es) => (lang === 'es' ? es : en) }
  const state = runtime.sim.state
  const context = `[context: simulated clock ${clock(state.t)}, scenario "${useUI.getState().scenarioId}", ${state.metrics.activeIncidents} active incidents]`
  const turn: Content[] = [{ role: 'user', parts: [{ text: `${text}\n\n${context}` }] }]
  const ts: TurnState = { proposals: [] }
  let final = ''
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (step > 0) progress(ctx, ctx.L(`Gemini is reading the results (step ${step + 1})…`, `Gemini está leyendo los resultados (paso ${step + 1})…`))
      const res = await api<{ parts: Part[] }>('/api/copilot/step', { method: 'POST', json: { contents: [...history, ...turn] } })
      turn.push({ role: 'model', parts: res.parts })
      const calls = res.parts.filter((p) => p.functionCall)
      if (!calls.length) {
        final = res.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim()
        break
      }
      const responses: Part[] = []
      for (const c of calls) {
        let out: Record<string, unknown>
        try {
          out = await execTool(ctx, c.functionCall!.name, c.functionCall!.args ?? {}, ts)
        } catch (err) {
          out = { error: (err as Error).message }
        }
        // echo the call id so the model can match results to parallel calls
        responses.push({ functionResponse: { ...(c.functionCall!.id ? { id: c.functionCall!.id } : {}), name: c.functionCall!.name, response: out } })
      }
      turn.push({ role: 'user', parts: responses })
    }
  } catch (err) {
    // LLM unavailable mid-turn: answer with the deterministic planner instead of failing
    // LLM unavailable: answer this question with the deterministic planner instead of failing
    const reason = (err as Error).message
    useUI.setState({ chat: useUI.getState().chat.filter((m) => m.id !== id && m.id !== userId) })
    await askLocal(text)
    const chat = useUI.getState().chat
    const last = [...chat].reverse().find((m) => m.role === 'ai')
    if (last) useUI.getState().patchChat(last.id, { notice: ctx.L(`LLM unavailable (${reason}) — answered by the on-device planner`, `LLM no disponible (${reason}) — respondió el planificador local`) })
    return
  }
  if (!final) final = ctx.L('I reached the step limit before finishing. Try a more specific request.', 'Llegué al límite de pasos sin terminar. Intenta con una petición más concreta.')
  history = [...history, { role: 'user' as const, parts: [{ text }] }, { role: 'model' as const, parts: [{ text: final }] }].slice(-12)
  const actions = ts.proposals.map((p) => ({ label: ctx.L(`Apply "${p.label}"`, `Aplicar "${p.label}"`), run: () => runtime.applyParams(p.params) }))
  if (!actions.length && ts.experiment && ts.experiment.ranked[0].label !== ts.experiment.baseLabel) {
    const best = ts.experiment.ranked[0]
    actions.push({ label: ctx.L(`Apply "${best.label}"`, `Aplicar "${best.label}"`), run: () => runtime.applyParams(best.patch) })
  }
  say(ctx, final, { xai: card(ctx, ts), actions: actions.length ? actions : undefined })
}

export function llmAvailable() {
  return useCloud.getState().online === true && !!useCloud.getState().info.copilot?.enabled
}
