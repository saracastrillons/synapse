import { clock, runtime } from '../runtime'
import { fmtDuration } from '../sim/engine'
import type { ExperimentResult, ExperimentSpec } from '../sim/experiment'
import type { ScheduledEvent, SimParams } from '../sim/types'
import { useUI, type ChatMessage, type XaiCard } from '../store'

/**
 * SYNAPSE Copilot — an on-device planning agent.
 *
 * It maps a natural-language request (English or Spanish) to a plan of calls to
 * authorised engine tools, executes them visibly (each call is shown with its
 * arguments, result and latency), evaluates candidate interventions by running
 * reproducible simulations in the worker, and justifies the recommendation with
 * the measured deltas. No answer is produced without running the tools first.
 */

export type Lang = 'en' | 'es'
export const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
export const isSpanish = (s: string) => /[ñ¿¡]|\b(el|la|los|las|que|como|por|para|una|hay|esta|donde|cual|cuanto|ciudad|trafico|accidente|ambulancia|tormenta|semaforos?|quiero|dame|muestrame|bloque[oa])\b/.test(norm(s))

export interface Ctx {
  id: number
  lang: Lang
  tools: NonNullable<ChatMessage['tools']>
  L: (en: string, es: string) => string
}

export async function tool<T>(ctx: Ctx, name: string, args: Record<string, unknown>, fn: () => T | Promise<T>, summary: (r: T) => string): Promise<T> {
  const entry = { name, args: JSON.stringify(args), result: '…', ms: 0 }
  ctx.tools.push(entry)
  useUI.getState().patchChat(ctx.id, { tools: [...ctx.tools] })
  await new Promise((r) => setTimeout(r, 120))
  const t0 = performance.now()
  const r = await fn()
  entry.ms = performance.now() - t0
  entry.result = summary(r)
  useUI.getState().patchChat(ctx.id, { tools: [...ctx.tools] })
  return r
}

export function say(ctx: Ctx, text: string, extra: Partial<ChatMessage> = {}) {
  useUI.getState().patchChat(ctx.id, { text, pending: false, ...extra })
}

export function progress(ctx: Ctx, text: string) {
  useUI.getState().patchChat(ctx.id, { text })
}

// ───────────────────────────── engine tools
export function cityState() {
  const st = runtime.sim.state
  const m = st.metrics
  return {
    time: clock(st.t), speed: +m.speed.toFixed(1), delay: +(m.congestion * 100).toFixed(1), tripsPerHour: Math.round(m.throughput),
    activeIncidents: m.activeIncidents, outages: m.outages, power: +(m.power * 100).toFixed(1), agents: m.vehicles,
  }
}

export function hotspots(k = 5) {
  const sim = runtime.sim
  const st = sim.state
  const byName = new Map<string, { edges: number[]; score: number; speed: number; count: number }>()
  for (const e of sim.g.edges) {
    const c = st.edgeCount[e.id]
    if (c < 3) continue
    const delay = Math.max(0, 1 - st.edgeSpeed[e.id] / e.vfree)
    if (delay < 0.35) continue
    const key = sim.edgeName(e.id) + (e.name ? '' : `#${e.id}`)
    const cur = byName.get(key) ?? { edges: [], score: 0, speed: 0, count: 0 }
    cur.edges.push(e.id)
    cur.score += delay * c
    cur.speed += st.edgeSpeed[e.id] * c
    cur.count += c
    byName.set(key, cur)
  }
  return [...byName.entries()].map(([name, v]) => ({ name: name.replace(/#\d+$/, ''), edges: v.edges, score: v.score, speed: (v.speed / v.count) * 3.6, queued: v.count }))
    .sort((a, b) => b.score - a.score).slice(0, k)
}

export function findStreet(text: string): number {
  const sim = runtime.sim
  const t = norm(text)
  const names = [...new Set(sim.g.edges.map((e) => e.name).filter(Boolean))].sort((a, b) => b.length - a.length)
  const hit = names.find((n) => t.includes(norm(n))) ?? names.find((n) => {
    const core = norm(n).replace(/^(avenida|calle|carrera|autopista|diagonal|transversal)\s+/, '')
    return core.length > 4 && t.includes(core)
  })
  return hit ? sim.g.findEdgeByName(hit) : -1
}

export function activeBlock() {
  return runtime.sim.state.incidents.find((i) => i.blocks && i.status !== 'resolved')
}

export function detour(edge: number) {
  const sim = runtime.sim
  const e = sim.g.edges[edge]
  const banned = (x: number) => (x === edge ? Infinity : sim.liveCost(x))
  // rejoin the blocked street a few junctions downstream (its end node may only be reachable through it)
  const targets = [e.to]
  let cur = e
  for (let k = 0; k < 4; k++) {
    const next = sim.g.out[cur.to].map((x) => sim.g.edges[x]).find((x) => x.name === e.name && x.to !== cur.from) ?? sim.g.edges[sim.g.out[cur.to][0]]
    if (!next) break
    targets.push(next.to)
    cur = next
  }
  let original = 0
  let along = e
  for (let k = 0; k < targets.length; k++) {
    original += k === 0 ? e.len / Math.max(1, sim.state.edgeSpeed[edge]) : sim.liveCost(along.id)
    const target = targets[k]
    const t0 = performance.now()
    const a = sim.route(e.from, target, banned, 'astar')
    const t1 = performance.now()
    const d = sim.route(e.from, target, banned, 'dijkstra')
    const t2 = performance.now()
    if (a.found) {
      const len = a.edges.reduce((acc, x) => acc + sim.g.edges[x].len, 0)
      return { original, astar: a, dijkstra: d, msA: t1 - t0, msD: t2 - t1, len, via: [...new Set(a.edges.map((x) => sim.g.edges[x].name).filter(Boolean))].slice(0, 3) }
    }
    along = sim.g.edges[sim.g.out[target].find((x) => sim.g.edges[x].name === e.name) ?? sim.g.out[target][0]] ?? along
  }
  const none = sim.route(e.from, e.to, banned, 'astar')
  return { original, astar: none, dijkstra: none, msA: 0, msD: 0, len: 0, via: [] as string[] }
}

export async function experiments(ctx: Ctx, base: SimParams, events: ScheduledEvent[], strategies: { label: string; patch: Partial<SimParams> }[], duration: number, seeds: number) {
  const specs: ExperimentSpec[] = []
  for (let s = 0; s < seeds; s++) {
    for (const st of strategies) specs.push({ label: `${st.label} · seed ${base.seed + s}`, params: { ...base, ...st.patch, seed: base.seed + s }, events, duration })
  }
  return tool(ctx, 'run_experiments', { strategies: strategies.map((s) => s.label), seeds, minutes: duration / 60 },
    () => runtime.runExperiments(specs, (p, label) => progress(ctx, ctx.L(`Simulating strategies in the worker… ${(p * 100).toFixed(0)}% · ${label}`, `Simulando estrategias en el worker… ${(p * 100).toFixed(0)}% · ${label}`))),
    (rs) => `${rs.length} simulations · ${(rs.reduce((a, r) => a + r.wallMs, 0) / 1000).toFixed(1)} s compute`)
}

export interface Ranked { label: string; patch: Partial<SimParams>; runs: ExperimentResult[]; m: Record<string, number>; score: number; consistent: boolean }

export function rank(results: ExperimentResult[], strategies: { label: string; patch: Partial<SimParams> }[], objective: (m: Record<string, number>) => number): Ranked[] {
  const out = strategies.map((st, i) => {
    const runs = results.filter((_, k) => k % strategies.length === i)
    const keys = ['speed', 'congestion', 'trip', 'throughput', 'co2', 'response', 'removed', 'power'] as const
    const m: Record<string, number> = {}
    for (const k of keys) m[k] = runs.reduce((a, r) => a + r.summary[k], 0) / runs.length
    return { label: st.label, patch: st.patch, runs, m, score: objective(m), consistent: true }
  })
  const base = out[0]
  for (const r of out) r.consistent = r.runs.every((run, s) => objective(run.summary as unknown as Record<string, number>) <= objective(base.runs[s].summary as unknown as Record<string, number>) + 1e-9)
  return out.sort((a, b) => a.score - b.score)
}

export function xai(ctx: Ctx, title: string, best: Ranked, base: Ranked, seeds: number, extra = ''): XaiCard {
  const f = (label: string, k: string, unit: string, better: 'up' | 'down', scale = 1) => {
    const a = base.m[k] * scale
    const b = best.m[k] * scale
    const delta = a ? (b - a) / Math.abs(a) : 0
    return { label, delta, display: `${b - a >= 0 ? '+' : ''}${(b - a).toFixed(1)}${unit}`, good: better === 'up' ? b >= a : b <= a }
  }
  const factors = [
    f(ctx.L('Delay index', 'Índice de demora'), 'congestion', ' pp', 'down', 100),
    f(ctx.L('Mean speed', 'Velocidad media'), 'speed', ' km/h', 'up'),
    f(ctx.L('Mean trip time', 'Tiempo de viaje'), 'trip', ' s', 'down'),
    f(ctx.L('Trips / hour', 'Viajes / hora'), 'throughput', '', 'up'),
    f(ctx.L('Abandoned trips', 'Viajes abandonados'), 'removed', '', 'down'),
    f('CO₂', 'co2', ' kg/h', 'down'),
  ].filter((x) => Math.abs(x.delta) > 0.002)
  return {
    title,
    recommendation: best.label,
    confidence: best === base ? ctx.L('No strategy beat the baseline', 'Ninguna estrategia superó la línea base') : best.consistent && seeds > 1
      ? ctx.L(`High — better in all ${seeds} seeds`, `Alta — mejor en las ${seeds} semillas`)
      : seeds > 1 ? ctx.L('Medium — not better in every seed', 'Media — no mejora en todas las semillas') : ctx.L('Indicative — single seed', 'Indicativa — una sola semilla'),
    factors,
    evidence: ctx.L(
      `Evidence: ${seeds} seed(s) × ${Math.round((base.runs[0].history.at(-1)?.t ?? 0) / 60)} simulated minutes per strategy, common random numbers, compared against "${base.label}". ${extra}`,
      `Evidencia: ${seeds} semilla(s) × ${Math.round((base.runs[0].history.at(-1)?.t ?? 0) / 60)} minutos simulados por estrategia, mismos números aleatorios, comparado con "${base.label}". ${extra}`),
  }
}

const tableOf = (ranked: Ranked[], ctx: Ctx) => ranked.map((r, i) =>
  `${i === 0 ? '★' : `${i + 1}.`} ${r.label} — ${ctx.L('delay', 'demora')} ${(r.m.congestion * 100).toFixed(1)}% · ${r.m.speed.toFixed(1)} km/h · ${ctx.L('trip', 'viaje')} ${fmtDuration(r.m.trip)}${r.m.response ? ` · ${ctx.L('response', 'respuesta')} ${fmtDuration(r.m.response)}` : ''}`).join('\n')

function detourNote(ctx: Ctx, astar: number, dijkstra: number) {
  const saved = dijkstra ? Math.round((1 - astar / dijkstra) * 100) : 0
  // on very short detours both searches do the same work: say so instead of "0% fewer"
  return saved > 0
    ? ctx.L(`A* found the same optimal detour as Dijkstra while expanding ${saved}% fewer nodes.`, `A* encontró el mismo desvío óptimo que Dijkstra expandiendo ${saved}% menos nodos.`)
    : ctx.L('A* and Dijkstra agree on the optimal detour.', 'A* y Dijkstra coinciden en el desvío óptimo.')
}

// ───────────────────────────── plans
async function planAccident(ctx: Ctx, text: string) {
  const sim = runtime.sim
  let inc = activeBlock()
  const named = findStreet(text)
  if (!inc || (named >= 0 && sim.g.edges[named].name !== sim.g.edges[inc.edge].name)) {
    const edge = named >= 0 ? named : sim.g.findEdgeByName('Avenida Oriental', [450, -150])
    inc = await tool(ctx, 'block_road', { street: sim.edgeName(edge) }, () => sim.createIncident('accident', edge, `Major accident on ${sim.edgeName(edge)}`, 900)!, (r) => `incident #${r.id} at ${clock(r.t)}, lane blocked`) ?? undefined
  } else {
    await tool(ctx, 'list_incidents', { status: 'active' }, () => inc!, (r) => `#${r.id} ${r.label} · ${r.status}`)
  }
  if (!inc) return say(ctx, ctx.L('I could not place the incident on the network.', 'No pude ubicar el incidente en la red.'))
  useUI.getState().focusOn(inc.x, inc.z, 900)
  const d = await tool(ctx, 'compute_detour', { edge: inc.edge, algorithms: ['A*', 'Dijkstra'] }, () => detour(inc!.edge),
    (r) => r.astar.found ? `detour ${fmtDuration(r.astar.cost)} vs ${fmtDuration(r.original)} direct · ${(r.len).toFixed(0)} m via ${r.via.join(', ') || 'local streets'} · A* ${r.astar.expanded} nodes (${r.msA.toFixed(1)} ms) vs Dijkstra ${r.dijkstra.expanded} (${r.msD.toFixed(1)} ms)` : 'no detour exists')
  if (d.astar.found) useUI.setState({ highlight: { edges: d.astar.edges, color: '#34d399', label: 'detour' } })
  const base = { ...sim.state.params, incidentRate: 0 }
  const events: ScheduledEvent[] = [{ t: 30, type: 'block', edge: inc.edge, duration: 900, label: inc.label }]
  const strategies = [
    { label: ctx.L('Do nothing', 'No hacer nada'), patch: {} },
    { label: ctx.L('Broadcast closure to 80% of drivers', 'Difundir el cierre al 80% de conductores'), patch: { smartNav: 0.8 } },
    { label: ctx.L('Adaptive max-pressure signals', 'Semáforos adaptativos max-pressure'), patch: { signals: 'adaptive' as const, smartNav: base.signals === 'adaptive' ? Math.min(1, base.smartNav + 0.2) : base.smartNav } },
    { label: ctx.L('Broadcast + contraflow lane (+20% capacity)', 'Difusión + carril reversible (+20% capacidad)'), patch: { smartNav: 0.8, capacity: Math.min(1.5, base.capacity * 1.2) } },
  ]
  if (base.signals === 'adaptive') strategies[2].label = ctx.L('Adaptive signals + 20% more connected drivers', 'Semáforos adaptativos + 20% más conductores conectados')
  const results = await experiments(ctx, base, events, strategies, 420, 2)
  const ranked = rank(results, strategies, (m) => m.congestion * 100 + m.trip / 30 + m.removed * 0.5)
  const best = ranked[0]
  const baseR = ranked.find((r) => r.label === strategies[0].label)!
  const gain = (1 - best.m.congestion / baseR.m.congestion) * 100
  say(ctx, ctx.L(
    `The closure on **${runtime.sim.edgeName(inc.edge)}** forces a ${fmtDuration(d.astar.cost)} detour (green on the map). I simulated ${strategies.length} response strategies over the same seeds:\n\n${tableOf(ranked, ctx)}\n\n**Recommendation:** ${best.label} — reduces the delay index by ${gain.toFixed(0)}% versus doing nothing.`,
    `El cierre en **${runtime.sim.edgeName(inc.edge)}** obliga a un desvío de ${fmtDuration(d.astar.cost)} (en verde en el mapa). Simulé ${strategies.length} estrategias de respuesta con las mismas semillas:\n\n${tableOf(ranked, ctx)}\n\n**Recomendación:** ${best.label} — reduce el índice de demora un ${gain.toFixed(0)}% frente a no hacer nada.`),
  {
    xai: xai(ctx, ctx.L('Restore traffic flow', 'Restablecer el flujo vehicular'), best, baseR, 2, detourNote(ctx, d.astar.expanded, d.dijkstra.expanded)),
    actions: [
      { label: ctx.L(`Apply "${best.label}" live`, `Aplicar "${best.label}" en vivo`), run: () => runtime.applyParams(best.patch) },
      { label: ctx.L('Clear the incident', 'Despejar el incidente'), run: () => { runtime.sim.clearIncident(inc!.id); runtime.publish(true) } },
    ],
  })
}

async function planAmbulance(ctx: Ctx, text: string) {
  const sim = runtime.sim
  const named = findStreet(text)
  const spots = hotspots(1)
  const edge = named >= 0 ? named : spots[0]?.edges[0] ?? sim.g.findEdgeByName('Carrera 54')
  const etas = await tool(ctx, 'evaluate_dispatch', { location: sim.edgeName(edge) }, () => sim.unitEtas(edge),
    (r) => r.slice(0, 4).map((x) => `${x.unit.name.split('·')[1]?.trim()}: ${fmtDuration(x.eta)}${x.unit.status === 'busy' ? ' (busy)' : ''}`).join('\n'))
  const best = etas.find((x) => x.unit.status === 'idle') ?? etas[0]
  useUI.setState({ highlight: { edges: best.edges, color: '#ff2d55', label: 'fastest ambulance route' } })
  const inc = await tool(ctx, 'create_emergency', { kind: 'medical', street: sim.edgeName(edge) }, () => sim.createIncident('medical', edge, `Cardiac emergency on ${sim.edgeName(edge)}`)!, (r) => `incident #${r.id} · dispatcher will assign the minimum-ETA unit`)
  if (inc) useUI.getState().focusOn(inc.x, inc.z, 1100)
  const base = { ...sim.state.params, incidentRate: 0 }
  const events: ScheduledEvent[] = [{ t: 20, type: 'medical', node: sim.g.edges[edge].from, label: 'Cardiac emergency' }]
  const strategies = [
    { label: ctx.L('Current policy', 'Política actual'), patch: {} },
    { label: base.preemption ? ctx.L('Without signal pre-emption', 'Sin prioridad semafórica') : ctx.L('With signal pre-emption', 'Con prioridad semafórica'), patch: { preemption: !base.preemption } },
    { label: ctx.L('Pre-emption + 2 ambulances per hospital', 'Prioridad + 2 ambulancias por hospital'), patch: { preemption: true, ambulances: 2 } },
  ]
  const results = await experiments(ctx, base, events, strategies, 300, 2)
  const ranked = rank(results, strategies, (m) => (m.response || 999) + m.congestion * 20)
  const baseR = ranked.find((r) => r.label === strategies[0].label)!
  setTimeout(() => {
    const amb = runtime.sim.state.vehicles.find((v) => v.mission && v.mission.incident === inc?.id)
    if (amb) useUI.setState({ selected: amb.id, follow: true })
  }, 1500)
  say(ctx, ctx.L(
    `I evaluated all ${etas.length} ambulances with A* on live travel times. The fastest is **${best.unit.name}** (ETA ${fmtDuration(best.eta)}); the dispatcher has sent it and the camera will follow it.\n\nPolicy comparison (2 seeds):\n\n${tableOf(ranked, ctx)}`,
    `Evalué las ${etas.length} ambulancias con A* sobre tiempos de viaje en vivo. La más rápida es **${best.unit.name}** (ETA ${fmtDuration(best.eta)}); el despachador ya la envió y la cámara la seguirá.\n\nComparación de políticas (2 semillas):\n\n${tableOf(ranked, ctx)}`),
  {
    xai: {
      ...xai(ctx, ctx.L('Emergency response policy', 'Política de respuesta a emergencias'), ranked[0], baseR, 2),
      factors: [
        { label: ctx.L('Response time', 'Tiempo de respuesta'), delta: baseR.m.response ? (ranked[0].m.response - baseR.m.response) / baseR.m.response : 0, display: `${(ranked[0].m.response - baseR.m.response).toFixed(0)} s`, good: ranked[0].m.response <= baseR.m.response },
        { label: ctx.L('Network delay', 'Demora de la red'), delta: (ranked[0].m.congestion - baseR.m.congestion) / (baseR.m.congestion || 1), display: `${((ranked[0].m.congestion - baseR.m.congestion) * 100).toFixed(1)} pp`, good: ranked[0].m.congestion <= baseR.m.congestion },
        { label: ctx.L('Abandoned trips', 'Viajes abandonados'), delta: (ranked[0].m.removed - baseR.m.removed) / (baseR.m.removed || 1), display: `${(ranked[0].m.removed - baseR.m.removed).toFixed(0)}`, good: ranked[0].m.removed <= baseR.m.removed },
      ],
    },
    actions: [{ label: ctx.L(`Apply "${ranked[0].label}" live`, `Aplicar "${ranked[0].label}" en vivo`), run: () => runtime.applyParams(ranked[0].patch) }],
  })
}

async function planGrid(ctx: Ctx) {
  const sim = runtime.sim
  const subs = await tool(ctx, 'grid_status', {}, () => sim.state.subs.map((s) => ({ ...s })),
    (r) => r.map((s) => `${s.name}: ${s.online ? 'online' : 'OFFLINE'} · ${(s.load / s.capacity * 100).toFixed(0)}% load`).join('\n'))
  const base = { ...sim.state.params, storm: Math.max(0.8, sim.state.params.storm), incidentRate: 4 }
  const central = Math.max(0, subs.findIndex((s) => /central/i.test(s.name)))
  const events: ScheduledEvent[] = [{ t: 20, type: 'storm', intensity: base.storm }, { t: 40, type: 'trip', sub: central, duration: 900 }]
  const strategies = [
    { label: ctx.L(`Current: ${base.repairCrews} crews`, `Actual: ${base.repairCrews} cuadrillas`), patch: {} },
    { label: ctx.L('4 repair crews on standby', '4 cuadrillas de reparación en alerta'), patch: { repairCrews: 4 } },
    { label: ctx.L('Demand response (−20% load)', 'Respuesta de demanda (−20% carga)'), patch: { powerDemand: base.powerDemand * 0.8 } },
    { label: ctx.L('4 crews + demand response', '4 cuadrillas + respuesta de demanda'), patch: { repairCrews: 4, powerDemand: base.powerDemand * 0.8 } },
  ]
  const results = await experiments(ctx, base, events, strategies, 600, 2)
  const ranked = rank(results, strategies, (m) => (1 - m.power) * 100 + m.congestion * 30)
  const baseR = ranked.find((r) => r.label === strategies[0].label)!
  const card = xai(ctx, ctx.L('Grid resilience under a storm', 'Resiliencia de la red ante tormenta'), ranked[0], baseR, 2)
  card.factors.unshift({ label: ctx.L('Power served', 'Energía servida'), delta: (ranked[0].m.power - baseR.m.power) / baseR.m.power, display: `${((ranked[0].m.power - baseR.m.power) * 100).toFixed(1)} pp`, good: ranked[0].m.power >= baseR.m.power })
  say(ctx, ctx.L(
    `Stress test: storm at ${(base.storm * 100).toFixed(0)}% intensity plus loss of ${subs[central].name}. Dark signals turn junctions into all-way stops, so the grid and mobility fail together.\n\n${ranked.map((r, i) => `${i === 0 ? '★' : `${i + 1}.`} ${r.label} — power ${(r.m.power * 100).toFixed(1)}% · delay ${(r.m.congestion * 100).toFixed(1)}%`).join('\n')}`,
    `Prueba de estrés: tormenta al ${(base.storm * 100).toFixed(0)}% más la caída de ${subs[central].name}. Los semáforos apagados convierten los cruces en pare en todas las direcciones, así que la red eléctrica y la movilidad fallan juntas.\n\n${ranked.map((r, i) => `${i === 0 ? '★' : `${i + 1}.`} ${r.label} — energía ${(r.m.power * 100).toFixed(1)}% · demora ${(r.m.congestion * 100).toFixed(1)}%`).join('\n')}`),
  { xai: card, actions: [{ label: ctx.L(`Apply "${ranked[0].label}" live`, `Aplicar "${ranked[0].label}" en vivo`), run: () => runtime.applyParams(ranked[0].patch) }] })
}

async function planHotspots(ctx: Ctx) {
  const spots = await tool(ctx, 'find_hotspots', { k: 5 }, () => hotspots(5), (r) => r.length ? r.map((h) => `${h.name}: ${h.speed.toFixed(0)} km/h · ${h.queued} vehicles`).join('\n') : 'no segment above 35% delay')
  const st = await tool(ctx, 'get_city_state', {}, cityState, (r) => `${r.speed} km/h · delay ${r.delay}% · ${r.tripsPerHour} trips/h`)
  const live = useUI.getState().live
  const fc = live?.forecast
  await tool(ctx, 'forecast_congestion', { horizon: '10 min', method: 'OLS trend' }, () => fc, (r) => r ? `+10 min ≈ ${(r.in10 * 100).toFixed(0)}% (slope ${(r.slope * 6000).toFixed(2)} pp/10min)` : 'n/a')
  if (spots.length) {
    useUI.setState({ highlight: { edges: spots.flatMap((s) => s.edges), color: '#fbbf24', label: 'hotspots' } })
    const e = runtime.sim.g.edges[spots[0].edges[0]]
    const [x, z] = runtime.sim.g.posAt(e, e.len / 2, 0)
    useUI.getState().focusOn(x, z, 800)
  }
  say(ctx, spots.length ? ctx.L(
    `Network at ${st.time}: ${st.speed} km/h mean speed, delay index ${st.delay}%. The worst bottlenecks right now (highlighted in amber):\n\n${spots.map((s, i) => `${i + 1}. **${s.name}** — ${s.speed.toFixed(0)} km/h, ${s.queued} vehicles queued`).join('\n')}\n\nTrend: ${fc && fc.slope > 0.00005 ? 'congestion is rising' : 'congestion is stable or easing'} — forecast ${(fc?.in10 ?? 0) * 100 > 0 ? ((fc?.in10 ?? 0) * 100).toFixed(0) : '—'}% in 10 minutes. Ask me to "compare signal strategies" to test a fix.`,
    `Red a las ${st.time}: velocidad media ${st.speed} km/h, índice de demora ${st.delay}%. Los peores cuellos de botella ahora (resaltados en ámbar):\n\n${spots.map((s, i) => `${i + 1}. **${s.name}** — ${s.speed.toFixed(0)} km/h, ${s.queued} vehículos en cola`).join('\n')}\n\nTendencia: ${fc && fc.slope > 0.00005 ? 'la congestión va en aumento' : 'la congestión está estable o bajando'} — pronóstico ${((fc?.in10 ?? 0) * 100).toFixed(0)}% en 10 minutos. Pídeme "comparar estrategias de semáforos" para probar una solución.`)
    : ctx.L(`Traffic is flowing: ${st.speed} km/h, delay ${st.delay}%. No segment is above 35% delay.`, `El tráfico fluye: ${st.speed} km/h, demora ${st.delay}%. Ningún tramo supera 35% de demora.`))
}

async function planSignals(ctx: Ctx) {
  const base = { ...runtime.sim.state.params, incidentRate: 0 }
  const strategies = [
    { label: ctx.L('Fixed-time (30 s)', 'Tiempo fijo (30 s)'), patch: { signals: 'fixed' as const } },
    { label: ctx.L('Adaptive max-pressure', 'Adaptativo max-pressure'), patch: { signals: 'adaptive' as const } },
  ]
  const results = await experiments(ctx, base, [], strategies, 480, 3)
  const ranked = rank(results, strategies, (m) => m.congestion * 100 + m.trip / 30)
  const baseR = ranked.find((r) => r.label === strategies[0].label)!
  say(ctx, ctx.L(
    `${runtime.sim.signalCount} signalised junctions, 3 seeds each:\n\n${tableOf(ranked, ctx)}\n\nMax-pressure gives green to the approach with the longer stopped queue (min 7 s, max 55 s) instead of a fixed 30 s cycle.`,
    `${runtime.sim.signalCount} cruces semaforizados, 3 semillas cada uno:\n\n${tableOf(ranked, ctx)}\n\nMax-pressure da verde al acceso con la cola detenida más larga (mín. 7 s, máx. 55 s) en lugar de un ciclo fijo de 30 s.`),
  { xai: xai(ctx, ctx.L('Signal control strategy', 'Estrategia de control semafórico'), ranked[0], baseR, 3), actions: [{ label: ctx.L(`Apply "${ranked[0].label}" live`, `Aplicar "${ranked[0].label}" en vivo`), run: () => runtime.applyParams(ranked[0].patch) }] })
}

async function planDemand(ctx: Ctx) {
  const base = { ...runtime.sim.state.params, incidentRate: 0 }
  const strategies = [
    { label: ctx.L('Today’s demand', 'Demanda actual'), patch: {} },
    { label: ctx.L('+40% traffic', '+40% tráfico'), patch: { vehicles: Math.round(base.vehicles * 1.4) } },
    { label: ctx.L('+40% traffic, 75% connected drivers', '+40% tráfico, 75% conductores conectados'), patch: { vehicles: Math.round(base.vehicles * 1.4), smartNav: 0.75 } },
    { label: ctx.L('+40% traffic, +20% road capacity', '+40% tráfico, +20% capacidad vial'), patch: { vehicles: Math.round(base.vehicles * 1.4), capacity: base.capacity * 1.2 } },
  ]
  const results = await experiments(ctx, base, [], strategies, 420, 1)
  const ranked = rank(results, strategies, (m) => m.congestion * 100 + m.trip / 30)
  const today = ranked.find((r) => r.label === strategies[0].label)!
  const surge = ranked.find((r) => r.label === strategies[1].label)!
  const fixes = ranked.filter((r) => r !== today && r !== surge)
  say(ctx, ctx.L(
    `A 40% surge raises the delay index from ${(today.m.congestion * 100).toFixed(1)}% to ${(surge.m.congestion * 100).toFixed(1)}% and mean trip time from ${fmtDuration(today.m.trip)} to ${fmtDuration(surge.m.trip)}.\n\nMitigations under the surge:\n${fixes.map((r) => `• ${r.label}: delay ${(r.m.congestion * 100).toFixed(1)}%, ${r.m.speed.toFixed(1)} km/h`).join('\n')}`,
    `Un aumento del 40% sube el índice de demora de ${(today.m.congestion * 100).toFixed(1)}% a ${(surge.m.congestion * 100).toFixed(1)}% y el tiempo medio de viaje de ${fmtDuration(today.m.trip)} a ${fmtDuration(surge.m.trip)}.\n\nMitigaciones bajo el aumento:\n${fixes.map((r) => `• ${r.label}: demora ${(r.m.congestion * 100).toFixed(1)}%, ${r.m.speed.toFixed(1)} km/h`).join('\n')}`),
  { xai: xai(ctx, ctx.L('Best mitigation for +40% demand', 'Mejor mitigación para +40% de demanda'), fixes.sort((a, b) => a.score - b.score)[0], surge, 1) })
}

async function planAlgorithms(ctx: Ctx) {
  const sim = runtime.sim
  const ext = runtime.data.meta.extent
  const a = sim.g.nearestNode(-ext.halfWidth * 0.8, -ext.halfHeight * 0.8)
  const b = sim.g.nearestNode(ext.halfWidth * 0.8, ext.halfHeight * 0.8)
  const r = await tool(ctx, 'compare_algorithms', { from: `node ${a}`, to: `node ${b}`, weights: 'live travel time' }, () => sim.compareAlgorithms(a, b),
    (x) => `A*: ${fmtDuration(x.astar.cost)} · ${x.astar.expanded} nodes · ${x.astar.ms.toFixed(2)} ms\nDijkstra: ${fmtDuration(x.dijkstra.cost)} · ${x.dijkstra.expanded} nodes · ${x.dijkstra.ms.toFixed(2)} ms`)
  useUI.setState({ highlight: { edges: r.astar.edges, color: '#22d3ee', label: 'A* route' } })
  useUI.getState().focusOn(0, 0, 3200)
  const saved = Math.round((1 - r.astar.expanded / r.dijkstra.expanded) * 100)
  say(ctx, ctx.L(
    `Corner-to-corner route across the twin (highlighted). Both algorithms return the **same optimal cost** (${fmtDuration(r.astar.cost)}), as they must. A* expanded ${r.astar.expanded} nodes vs ${r.dijkstra.expanded} for Dijkstra — **${saved}% less work** — because its heuristic (straight-line distance ÷ max speed) never overestimates, so it can prune the search safely.`,
    `Ruta de esquina a esquina del gemelo (resaltada). Ambos algoritmos devuelven el **mismo costo óptimo** (${fmtDuration(r.astar.cost)}), como debe ser. A* expandió ${r.astar.expanded} nodos frente a ${r.dijkstra.expanded} de Dijkstra — **${saved}% menos trabajo** — porque su heurística (distancia en línea recta ÷ velocidad máxima) nunca sobreestima y puede podar la búsqueda con seguridad.`))
}

async function planStatus(ctx: Ctx) {
  const st = await tool(ctx, 'get_city_state', {}, cityState, (r) => JSON.stringify(r))
  const spots = await tool(ctx, 'find_hotspots', { k: 3 }, () => hotspots(3), (r) => r.map((h) => h.name).join(', ') || 'none')
  const live = useUI.getState().live!
  const crit = live.alerts.filter((a) => a.level === 'crit').length
  say(ctx, ctx.L(
    `**Executive summary · ${st.time}**\n• Mobility: ${st.speed} km/h, delay index ${st.delay}%, ${st.tripsPerHour} trips/h across ${st.agents} agents.\n• Bottlenecks: ${spots.map((s) => s.name).join(', ') || 'none significant'}.\n• Incidents: ${st.activeIncidents} active, ${crit} critical alerts so far.\n• Energy: ${st.power}% of demand served, ${st.outages} substation(s) offline.\n• Outlook: delay ${(live.forecast.in10 * 100).toFixed(0)}% expected in 10 min.`,
    `**Resumen ejecutivo · ${st.time}**\n• Movilidad: ${st.speed} km/h, índice de demora ${st.delay}%, ${st.tripsPerHour} viajes/h con ${st.agents} agentes.\n• Cuellos de botella: ${spots.map((s) => s.name).join(', ') || 'ninguno relevante'}.\n• Incidentes: ${st.activeIncidents} activos, ${crit} alertas críticas hasta ahora.\n• Energía: ${st.power}% de la demanda servida, ${st.outages} subestación(es) fuera de servicio.\n• Perspectiva: demora esperada de ${(live.forecast.in10 * 100).toFixed(0)}% en 10 min.`))
}

function help(ctx: Ctx) {
  say(ctx, ctx.L(
    `I can operate the twin with these tools: **block_road, compute_detour, evaluate_dispatch, create_emergency, find_hotspots, forecast_congestion, grid_status, compare_algorithms, run_experiments**. Try:\n• "A major accident just blocked Avenida Oriental. Find the fastest way to restore traffic flow"\n• "Send an ambulance to Carrera 54"\n• "Where is the congestion right now?"\n• "Compare fixed vs adaptive signals"\n• "What if a storm knocks out the grid?"\n• "What happens if traffic grows 40%?"\n• "A* vs Dijkstra"`,
    `Puedo operar el gemelo con estas herramientas: **block_road, compute_detour, evaluate_dispatch, create_emergency, find_hotspots, forecast_congestion, grid_status, compare_algorithms, run_experiments**. Prueba:\n• "Un accidente bloqueó la Avenida Oriental. ¿Cómo restablezco el flujo?"\n• "Envía una ambulancia a la Carrera 54"\n• "¿Dónde está la congestión ahora?"\n• "Compara semáforos fijos vs adaptativos"\n• "¿Qué pasa si una tormenta tumba la red eléctrica?"\n• "¿Qué pasa si el tráfico aumenta 40%?"\n• "A* vs Dijkstra"`))
}

/** Deterministic keyword planner — the offline fallback for the LLM agent. */
export async function askLocal(text: string) {
  const ui = useUI.getState()
  ui.pushChat({ role: 'user', text })
  const lang: Lang = isSpanish(text) ? 'es' : 'en'
  const id = ui.pushChat({ role: 'ai', text: lang === 'es' ? 'Planificando…' : 'Planning…', pending: true, tools: [] })
  const ctx: Ctx = { id, lang, tools: [], L: (en, es) => (lang === 'es' ? es : en) }
  const t = norm(text)
  try {
    if (/accident|block|closure|restore|accidente|bloque|cierre|choque|restablec|flujo/.test(t)) await planAccident(ctx, text)
    else if (/ambulan|emergenc|hospital|paciente|patient|cardiac|infarto/.test(t)) await planAmbulance(ctx, text)
    else if (/storm|blackout|grid|power|energ|tormenta|apagon|electric|subesta/.test(t)) await planGrid(ctx)
    else if (/signal|semaforo|adaptive|adaptativ|max.?pressure/.test(t)) await planSignals(ctx)
    else if (/a\*|astar|a star|dijkstra|algorit/.test(t)) await planAlgorithms(ctx)
    else if (/40|demand|demanda|grow|aument|rush|more cars|mas carros|mas trafico/.test(t)) await planDemand(ctx)
    else if (/congest|traffic|trafico|hotspot|where|donde|tranc|embotell|cuello|bottleneck/.test(t)) await planHotspots(ctx)
    else if (/report|summary|status|estado|resumen|informe|brief/.test(t)) await planStatus(ctx)
    else help(ctx)
  } catch (err) {
    say(ctx, ctx.L(`A tool failed: ${(err as Error).message}`, `Una herramienta falló: ${(err as Error).message}`))
  }
}
