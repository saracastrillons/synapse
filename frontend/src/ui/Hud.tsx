import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { clock, runtime } from '../runtime'
import { useUI, type LayerKey, type Panel, type Tool } from '../store'
import { fmtDuration } from '../sim/engine'
import { SCENARIOS } from '../sim/scenarios'
import { Icon, Logo } from './Icons'
import { LineChart, Legend, Sparkline } from './Charts'

// ───────────────────────────────────────── top bar
export function TopBar() {
  const live = useUI((s) => s.live)
  const paused = useUI((s) => s.paused)
  const scenarioId = useUI((s) => s.scenarioId)
  const seed = useUI((s) => s.params.seed)
  const m = live?.metrics
  const sc = SCENARIOS.find((s) => s.id === scenarioId)
  return (
    <div className="topbar glass">
      <div className="brand">
        <Logo />
        <div>
          <div className="brand-name">SYNAPSE</div>
          <div className="brand-sub">Living digital twin</div>
        </div>
      </div>
      <div>
        <div className="crumbs">Earth › Colombia › <b>Medellín · Centro</b></div>
        <div className="row" style={{ gap: 8, marginTop: 2 }}>
          <span className={`live-dot ${paused ? 'paused' : ''}`} />
          <span className="clock">{clock(live?.t ?? 0)}</span>
          <span className="chip violet mono">seed {seed}</span>
          <span className="chip cyan" title={sc?.tagline}>{sc?.name}</span>
        </div>
      </div>
      <div className="kpis">
        <Kpi label="Mean speed" value={m ? m.speed.toFixed(1) : '—'} unit="km/h" />
        <Kpi label="Delay index" value={m ? (m.congestion * 100).toFixed(0) : '—'} unit="%" warn={!!m && m.congestion > 0.3} />
        <Kpi label="Trips / h" value={m ? m.throughput.toFixed(0) : '—'} />
        <Kpi label="CO₂" value={m ? (m.co2 / 1000).toFixed(2) : '—'} unit="t/h" />
        <Kpi label="Grid served" value={m ? (m.power * 100).toFixed(0) : '—'} unit="%" warn={!!m && m.power < 0.99} />
        <Kpi label="Agents" value={m ? m.vehicles.toLocaleString() : '—'} />
      </div>
    </div>
  )
}

function Kpi({ label, value, unit, warn }: { label: string; value: string; unit?: string; warn?: boolean }) {
  return (
    <div className="kpi" style={warn ? { borderColor: 'rgba(251,79,107,.45)' } : undefined}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value" style={warn ? { color: 'var(--red)' } : undefined}>{value}{unit && <small>{unit}</small>}</div>
    </div>
  )
}

// ───────────────────────────────────────── left rail
export function Rail() {
  const panel = useUI((s) => s.panel)
  const setPanel = useUI((s) => s.setPanel)
  const items: { id: Panel; icon: () => ReactElement; tip: string }[] = [
    { id: 'overview', icon: Icon.city, tip: 'City operations' },
    { id: 'lab', icon: Icon.lab, tip: 'Scenario Lab' },
    { id: 'ai', icon: Icon.ai, tip: 'AI Command Center' },
    { id: 'agents', icon: Icon.agents, tip: 'Autonomous agents' },
    { id: 'data', icon: Icon.data, tip: 'Data & model card' },
    { id: 'cloud', icon: Icon.cloud, tip: 'Cloud workspace' },
  ]
  return (
    <div className="rail glass">
      <button className="rail-btn" onClick={() => useUI.setState({ mode: 'globe', selected: null, follow: false })}>
        <Icon.globe /><span className="tip">Back to Earth</span>
      </button>
      <div className="rail-sep" />
      {items.map((it) => (
        <button key={it.id} className={`rail-btn ${panel === it.id ? 'active' : ''}`} onClick={() => setPanel(it.id)}>
          <it.icon /><span className="tip">{it.tip}</span>
        </button>
      ))}
      <div style={{ flex: 1 }} />
      <LayersButton />
      <button className="rail-btn" onClick={() => useUI.setState({ showAbout: true })}>
        <Icon.info /><span className="tip">About SYNAPSE</span>
      </button>
    </div>
  )
}

function LayersButton() {
  const [open, setOpen] = useState(false)
  const layers = useUI((s) => s.layers)
  const toggle = useUI((s) => s.toggleLayer)
  const names: Record<LayerKey, string> = { heatmap: 'Congestion heatmap', signals: 'Traffic signals', grid: 'Power grid feeders', routes: 'Emergency routes', labels: 'Labels', buildings: 'Buildings' }
  return (
    <div style={{ position: 'relative' }}>
      <button className={`rail-btn ${open ? 'active' : ''}`} onClick={() => setOpen(!open)}>
        <Icon.layers />{!open && <span className="tip">Map layers</span>}
      </button>
      {open && (
        <div className="glass" style={{ position: 'absolute', left: 52, bottom: 0, width: 210, padding: 10 }}>
          <div className="section-title">Layers</div>
          {(Object.keys(names) as LayerKey[]).map((k) => (
            <label key={k} className="between" style={{ padding: '5px 2px', cursor: 'pointer', fontSize: 12 }}>
              {names[k]}
              <input type="checkbox" checked={layers[k]} onChange={() => toggle(k)} />
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// ───────────────────────────────────────── tools
export function Tools() {
  const tool = useUI((s) => s.tool)
  const items: { id: Tool; icon: () => ReactElement; label: string }[] = [
    { id: 'select', icon: Icon.cursor, label: 'Inspect agent' },
    { id: 'block', icon: Icon.block, label: 'Cause accident' },
    { id: 'medical', icon: Icon.cross, label: 'Medical call' },
    { id: 'fire', icon: Icon.fire, label: 'Fire' },
  ]
  return (
    <div className="tools glass">
      {items.map((it) => (
        <button key={it.id} className={`tool-btn ${tool === it.id ? 'on' : ''}`} onClick={() => useUI.setState({ tool: it.id })}>
          <it.icon /> {it.label}
        </button>
      ))}
      {tool !== 'select' && <span className="dim" style={{ fontSize: 11, alignSelf: 'center', padding: '0 8px' }}>click a street on the map</span>}
    </div>
  )
}

// ───────────────────────────────────────── agent inspector
export function Inspector() {
  const v = useUI((s) => s.live?.selected)
  const follow = useUI((s) => s.follow)
  if (!v) return null
  const kindColor = v.kind === 'ambulance' ? 'red' : v.kind === 'fire' ? 'amber' : v.strategy === 'adaptive' ? 'violet' : 'cyan'
  return (
    <div className="inspector glass">
      <div className="between">
        <div>
          <div className="section-title" style={{ marginBottom: 2 }}>Autonomous agent</div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>#{v.id} · {v.kind.toUpperCase()}</div>
        </div>
        <button className="icon-btn" onClick={() => useUI.setState({ selected: null, follow: false })}><Icon.close /></button>
      </div>
      <div className="row" style={{ gap: 6, margin: '8px 0 10px', flexWrap: 'wrap' }}>
        <span className={`chip ${kindColor}`}>{v.mission ? 'emergency priority' : v.strategy === 'adaptive' ? 'live navigation' : 'fixed route'}</span>
        <span className="chip">headway {v.headway.toFixed(1)}s</span>
        <span className="chip">{(v.speedFactor * 100).toFixed(0)}% of limit</span>
      </div>
      {v.mission && <div className="card" style={{ marginBottom: 8, borderColor: 'rgba(251,79,107,.4)' }}>{v.mission}</div>}
      <div className="grid2">
        <div className="stat"><div className="stat-label">Speed</div><div className="stat-value">{v.speed.toFixed(0)}<small>km/h</small></div></div>
        <div className="stat"><div className="stat-label">ETA</div><div className="stat-value">{fmtDuration(v.eta)}</div></div>
        <div className="stat"><div className="stat-label">Remaining</div><div className="stat-value">{(v.remaining / 1000).toFixed(2)}<small>km</small></div></div>
        <div className="stat"><div className="stat-label">Reroutes</div><div className="stat-value">{v.reroutes}</div></div>
      </div>
      <div className="muted" style={{ fontSize: 11.5, margin: '10px 0 6px' }}>Now on <b style={{ color: 'var(--text)' }}>{v.street}</b>{v.stopped > 3 ? ` · waiting ${v.stopped.toFixed(0)}s` : ''}</div>
      <div className="section-title" style={{ marginTop: 10 }}>Decision log</div>
      <div style={{ maxHeight: 150, overflowY: 'auto' }}>
        {v.log.map((l, i) => (
          <div key={i} style={{ fontSize: 11.5, padding: '5px 0', borderTop: '1px solid var(--line)', lineHeight: 1.45 }}>
            <span className="mono dim">{clock(l.t)}</span> {l.msg}
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className={`btn small ${follow ? 'active' : ''}`} onClick={() => useUI.setState({ follow: !follow })}><Icon.target /> {follow ? 'Following' : 'Follow camera'}</button>
      </div>
    </div>
  )
}

// ───────────────────────────────────────── toasts
export function Toasts() {
  const alerts = useUI((s) => s.live?.alerts)
  const [shown, setShown] = useState<{ id: number; level: string; msg: string }[]>([])
  const seen = useRef(0)
  useEffect(() => {
    if (!alerts) return
    // a Time Machine rewind restores older alert ids: restart the cursor for the new branch
    if (alerts.length && alerts[alerts.length - 1].id < seen.current) seen.current = alerts[alerts.length - 1].id
    const fresh = alerts.filter((a) => a.id > seen.current && a.level !== 'info')
    if (alerts.length) seen.current = Math.max(seen.current, alerts[alerts.length - 1].id)
    if (!fresh.length) return
    setShown((s) => [...s, ...fresh.slice(-2)].slice(-3))
    const ids = fresh.map((f) => f.id)
    const timer = setTimeout(() => setShown((s) => s.filter((x) => !ids.includes(x.id))), 6000)
    return () => clearTimeout(timer)
  }, [alerts])
  return (
    <div className="toasts">
      {shown.map((a) => (
        <div key={a.id} className={`toast glass ${a.level}`}>
          <span className={`lvl-${a.level}`}>{a.level === 'crit' ? '◆' : '▲'}</span> {a.msg}
        </div>
      ))}
    </div>
  )
}

// ───────────────────────────────────────── time machine
export function TimeMachine() {
  const live = useUI((s) => s.live)
  const paused = useUI((s) => s.paused)
  const speed = useUI((s) => s.speed)
  const branches = useUI((s) => s.branches)
  const [hover, setHover] = useState<number | null>(null)
  const track = useRef<HTMLDivElement>(null)
  const t = live?.t ?? 0
  const span = Math.max(600, t * 1.05)
  const hist = live?.history ?? []
  const toX = (time: number) => `${(time / span) * 100}%`
  const pathOf = (pts: { t: number; speed: number }[]) =>
    pts.map((p, i) => `${i ? 'L' : 'M'}${((p.t / span) * 1000).toFixed(1)},${(44 - Math.min(1, p.speed / 45) * 40).toFixed(1)}`).join('')
  const pick = (e: React.MouseEvent) => {
    const r = track.current!.getBoundingClientRect()
    return Math.max(0, Math.min(t, ((e.clientX - r.left) / r.width) * span))
  }
  const incidents = live?.incidents ?? []
  return (
    <div className="tm glass">
      <div>
        <div className="tm-label">Time Machine</div>
        <div className="tm-controls" style={{ marginTop: 5 }}>
          <button className="icon-btn" title={paused ? 'Play' : 'Pause'} onClick={() => useUI.setState({ paused: !paused })}>{paused ? <Icon.play /> : <Icon.pause />}</button>
          <button className="icon-btn" title="Rewind 2 minutes and branch" onClick={() => runtime.rewind(Math.max(0, t - 120))}><Icon.rewind /></button>
          {[1, 4, 10, 25].map((s) => (
            <button key={s} className={`speed-btn ${speed === s ? 'on' : ''}`} onClick={() => useUI.setState({ speed: s })}>{s}×</button>
          ))}
        </div>
      </div>
      <div className="tm-track" ref={track} onMouseMove={(e) => setHover(pick(e))} onMouseLeave={() => setHover(null)}
        onClick={(e) => runtime.rewind(pick(e))}>
        <svg viewBox="0 0 1000 46" preserveAspectRatio="none" width="100%" height="46" style={{ position: 'absolute', inset: 0 }}>
          <rect x="0" y="0" width={(t / span) * 1000} height="46" fill="rgba(34,211,238,.05)" />
          {branches.slice(0, -1).map((b) => (
            <path key={b.id} d={pathOf(b.history)} fill="none" stroke={b.color} strokeWidth="1.4" strokeDasharray="4 3" opacity=".7" vectorEffect="non-scaling-stroke" />
          ))}
          <path d={pathOf(hist)} fill="none" stroke={branches.length ? branches[branches.length - 1].color : '#22d3ee'} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
        </svg>
        {runtime.snapshots.map((s, i) => i % 4 === 0 && (
          <div key={i} style={{ position: 'absolute', left: toX(s.t), bottom: 0, width: 1, height: 5, background: 'rgba(120,160,255,.35)' }} />
        ))}
        {incidents.map((i) => (
          <div key={i.id} title={i.label} style={{ position: 'absolute', left: toX(i.t), top: 2, width: 7, height: 7, marginLeft: -3, borderRadius: 2, transform: 'rotate(45deg)', background: i.kind === 'accident' ? 'var(--red)' : i.kind === 'fire' ? 'var(--amber)' : 'var(--magenta)' }} />
        ))}
        {branches.slice(1).map((b) => (
          <div key={b.id} style={{ position: 'absolute', left: toX(b.forkT), top: 0, bottom: 0, width: 1, background: b.color, boxShadow: `0 0 8px ${b.color}` }} />
        ))}
        <div style={{ position: 'absolute', left: toX(t), top: -3, bottom: -3, width: 2, background: '#fff', boxShadow: '0 0 10px #22d3ee' }} />
        {hover != null && (
          <div style={{ position: 'absolute', left: toX(hover), top: -26, transform: 'translateX(-50%)', whiteSpace: 'nowrap' }} className="chip cyan mono">
            ⟲ rewind to {clock(hover)}
          </div>
        )}
      </div>
      <div style={{ minWidth: 150 }}>
        <div className="tm-label">Branches</div>
        <div style={{ marginTop: 4, fontSize: 11 }}>
          {branches.length === 0 ? <span className="dim">click the timeline to rewind & fork</span> : branches.map((b) => (
            <div key={b.id} className="row" style={{ gap: 5 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: b.color }} />
              <span>{b.name}</span><span className="dim mono">@{clock(b.forkT).slice(0, 5)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ───────────────────────────────────────── overview panel
export function OverviewPanel() {
  const live = useUI((s) => s.live)
  const branches = useUI((s) => s.branches)
  if (!live) return null
  const m = live.metrics
  const h = live.history
  const pts = (k: 'speed' | 'congestion' | 'throughput') => h.map((x) => ({ t: x.t, v: k === 'congestion' ? x[k] * 100 : x[k] }))
  const forecastPts = h.length ? [{ t: h[h.length - 1].t, v: m.congestion * 100 }, { t: h[h.length - 1].t + 600, v: live.forecast.in10 * 100 }] : []
  const activeInc = live.incidents.filter((i) => i.status !== 'resolved')
  return (
    <>
      <div className="side-head">
        <div className="side-title"><Icon.city /> City operations</div>
        <div className="side-sub">Live state of the Medellín Centro twin · {live.subs.length} substations · {live.units.length} emergency units</div>
      </div>
      <div className="side-body">
        <div className="grid2 section">
          <div className="stat"><div className="stat-label">Mean speed</div><div className="stat-value">{m.speed.toFixed(1)}<small>km/h</small></div><Sparkline values={h.slice(-60).map((x) => x.speed)} width={90} height={30} /></div>
          <div className="stat"><div className="stat-label">Delay index</div><div className="stat-value">{(m.congestion * 100).toFixed(1)}<small>%</small></div><Sparkline values={h.slice(-60).map((x) => x.congestion)} color="#f472b6" width={90} height={30} /></div>
          <div className="stat"><div className="stat-label">Stopped</div><div className="stat-value">{(m.stopped * 100).toFixed(0)}<small>%</small></div></div>
          <div className="stat"><div className="stat-label">Mean trip</div><div className="stat-value">{fmtDuration(m.trip)}</div></div>
          <div className="stat"><div className="stat-label">Emergency resp.</div><div className="stat-value">{m.response ? fmtDuration(m.response) : '—'}</div></div>
          <div className="stat"><div className="stat-label">Abandoned trips</div><div className="stat-value">{m.removed}</div></div>
        </div>

        <div className="section">
          <div className="section-title">Delay index · forecast <span className={live.forecast.slope > 0.00005 ? 'down' : 'up'}>{live.forecast.slope > 0.00005 ? '▲ rising' : live.forecast.slope < -0.00005 ? '▼ easing' : '■ stable'} · +10 min ≈ {(live.forecast.in10 * 100).toFixed(0)}%</span></div>
          <LineChart unit="sim" fmt={(v) => v.toFixed(0) + '%'} series={[
            ...branches.slice(0, -1).map((b) => ({ name: b.name, color: b.color, dashed: true, points: b.history.map((x) => ({ t: x.t, v: x.congestion * 100 })) })),
            { name: 'live', color: '#f472b6', points: pts('congestion') },
            { name: 'forecast', color: '#fbbf24', dashed: true, points: forecastPts },
          ]} markers={activeInc.map((i) => ({ t: i.t, color: '#fb4f6b' }))} />
          <Legend items={[{ name: 'delay index', color: '#f472b6' }, { name: 'linear forecast (2-min trend)', color: '#fbbf24', dashed: true }, ...branches.slice(0, -1).map((b) => ({ name: b.name, color: b.color, dashed: true }))]} />
        </div>

        <div className="section">
          <div className="section-title">Power grid</div>
          {live.subs.map((s, i) => (
            <div className="card" key={i}>
              <div className="between">
                <span style={{ fontWeight: 600, fontSize: 12 }}>{s.name}</span>
                {s.online ? <span className="chip green">online</span> : <span className="chip red">offline · {fmtDuration(s.repairAt - live.t)}</span>}
              </div>
              <div className="between" style={{ marginTop: 6, fontSize: 11 }}>
                <span className="muted">load {(s.load / 1000).toFixed(1)} / {(s.capacity / 1000).toFixed(1)} MW</span>
                <span className="mono">{(s.load / s.capacity * 100).toFixed(0)}%</span>
              </div>
              <div className="bar" style={{ marginTop: 4 }}><div style={{ width: `${Math.min(100, s.load / s.capacity * 100)}%`, background: !s.online ? 'var(--red)' : s.load > s.capacity ? 'var(--amber)' : 'linear-gradient(90deg,#22d3ee,#a78bfa)' }} /></div>
              <div className="row" style={{ marginTop: 8, gap: 6 }}>
                <button className="btn small" onClick={() => runtime.focusSub(i)}><Icon.target /> Locate</button>
                {s.online && <button className="btn small danger" onClick={() => { runtime.sim.tripSubstation(i, 420); runtime.publish(true) }}><Icon.bolt /> Trip</button>}
              </div>
            </div>
          ))}
        </div>

        <div className="section">
          <div className="section-title">Incidents <span>{activeInc.length} active</span></div>
          {activeInc.length === 0 && <div className="dim" style={{ fontSize: 12 }}>No active incidents. Use the tools at the bottom-left to create one.</div>}
          {activeInc.map((i) => {
            const unit = live.units[i.unit]
            return (
              <div className="card" key={i.id} style={{ cursor: 'pointer' }} onClick={() => useUI.getState().focusOn(i.x, i.z, 600)}>
                <div className="between"><b style={{ fontSize: 12 }}>{i.label}</b><span className={`chip ${i.kind === 'accident' ? 'red' : 'amber'}`}>{i.status}</span></div>
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                  {unit ? `${unit.name}` : 'waiting for a free unit'}{i.dispatch ? ` · ${i.dispatch.candidates.length} units evaluated` : ''}
                </div>
                {i.dispatch && (
                  <div style={{ marginTop: 6 }}>
                    {i.dispatch.candidates.slice(0, 3).map((c) => (
                      <div key={c.unit} className="between mono" style={{ fontSize: 10.5, color: c.unit === i.dispatch!.chosen ? 'var(--green)' : 'var(--text-3)' }}>
                        <span>{c.unit === i.dispatch!.chosen ? '✓' : ' '} {c.name.split('·')[1]?.trim().slice(0, 30)}</span><span>ETA {fmtDuration(c.eta)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {i.blocks && <button className="btn small" style={{ marginTop: 8 }} onClick={(e) => { e.stopPropagation(); runtime.sim.clearIncident(i.id); runtime.publish(true) }}>Clear now</button>}
              </div>
            )
          })}
        </div>

        <div className="section">
          <div className="section-title">Event log</div>
          {[...live.alerts].reverse().slice(0, 14).map((a) => (
            <div key={a.id} className="alert-row" onClick={() => a.x != null && useUI.getState().focusOn(a.x, a.z!, 650)}>
              <span className="mono dim">{clock(a.t).slice(0, 8)}</span>
              <span><span className={`lvl-${a.level}`}>●</span> {a.msg}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

// ───────────────────────────────────────── agents panel
export function AgentsPanel() {
  const live = useUI((s) => s.live)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 1500)
    return () => clearInterval(id)
  }, [])
  const notable = useMemo(() => {
    void tick
    const vs = runtime.sim.state.vehicles.filter((v) => v.edge >= 0)
    const rerouters = [...vs].filter((v) => !v.mission).sort((a, b) => b.reroutes - a.reroutes).slice(0, 4)
    const stuck = [...vs].filter((v) => !v.mission).sort((a, b) => b.stopped - a.stopped).slice(0, 3)
    const emergency = vs.filter((v) => v.mission)
    return { rerouters, stuck, emergency }
  }, [tick])
  if (!live) return null
  const a = live.agents
  const total = a.adaptive + a.static || 1
  const pick = (id: number) => {
    useUI.setState({ selected: id, follow: true })
    runtime.publish(true)
  }
  const Row = ({ v, note }: { v: (typeof notable.rerouters)[number]; note: string }) => (
    <div className="alert-row" onClick={() => pick(v.id)}>
      <span className="mono dim">#{v.id}</span>
      <span><b style={{ color: v.mission ? 'var(--red)' : v.strategy === 'adaptive' ? 'var(--violet)' : 'var(--cyan)' }}>{v.kind}</b> · {note}</span>
    </div>
  )
  return (
    <>
      <div className="side-head">
        <div className="side-title"><Icon.agents /> Autonomous agents</div>
        <div className="side-sub">Every vehicle is an agent with a goal (its destination), constraints (speed limit, safe headway, signals, road capacity) and a navigation strategy. Click any agent on the map to read its decisions.</div>
      </div>
      <div className="side-body">
        <div className="grid2 section">
          <div className="stat"><div className="stat-label">Live-navigation</div><div className="stat-value" style={{ color: 'var(--violet)' }}>{a.adaptive}</div></div>
          <div className="stat"><div className="stat-label">Fixed-route</div><div className="stat-value" style={{ color: 'var(--cyan)' }}>{a.static}</div></div>
          <div className="stat"><div className="stat-label">Buses · taxis</div><div className="stat-value">{a.bus} · {a.taxi}</div></div>
          <div className="stat"><div className="stat-label">Reroute decisions</div><div className="stat-value">{a.reroutes}</div></div>
        </div>
        <div className="section">
          <div className="section-title">Strategy mix</div>
          <div className="bar" style={{ height: 10 }}><div style={{ width: `${(a.adaptive / total) * 100}%`, background: 'var(--violet)' }} /></div>
          <div className="between muted" style={{ fontSize: 11, marginTop: 4 }}><span>{((a.adaptive / total) * 100).toFixed(0)}% connected</span><span>{((a.static / total) * 100).toFixed(0)}% fixed route</span></div>
        </div>
        {notable.emergency.length > 0 && (
          <div className="section">
            <div className="section-title">Emergency units on the move</div>
            {notable.emergency.map((v) => <Row key={v.id} v={v} note={v.log[v.log.length - 1]?.msg ?? ''} />)}
          </div>
        )}
        <div className="section">
          <div className="section-title">Most adaptive agents</div>
          {notable.rerouters.map((v) => <Row key={v.id} v={v} note={`${v.reroutes} reroutes · ${v.log[v.log.length - 1]?.msg.slice(0, 70) ?? ''}`} />)}
        </div>
        <div className="section">
          <div className="section-title">Longest waiting</div>
          {notable.stuck.map((v) => <Row key={v.id} v={v} note={`stopped ${v.stopped.toFixed(0)}s on ${runtime.sim.edgeName(v.edge)}`} />)}
        </div>
        <div className="section">
          <div className="section-title">Behaviour model</div>
          <div className="card" style={{ fontSize: 12, lineHeight: 1.6 }}>
            <p style={{ margin: 0 }}><b>Car-following:</b> Intelligent Driver Model — acceleration 1.6 m/s², comfortable braking 2.5 m/s², min gap 2 m, personal time headway 0.8–1.9 s.</p>
            <p style={{ margin: '6px 0 0' }}><b>Fixed-route agents</b> plan once on free-flow travel times and only react to a blockage when they reach it.</p>
            <p style={{ margin: '6px 0 0' }}><b>Live-navigation agents</b> re-plan every 50–90 s with A* on observed speeds and switch if they save &gt;10% (min 6 s); incident broadcasts force an immediate re-plan.</p>
            <p style={{ margin: '6px 0 0' }}><b>Emergency units</b> use lane-weaving speed, cross red lights with caution and request signal pre-emption within 160 m.</p>
          </div>
        </div>
      </div>
    </>
  )
}

// ───────────────────────────────────────── data & model card
export function DataPanel() {
  const d = runtime.data
  const osm = d.buildings.filter((b) => b.est !== 'proc').length
  return (
    <>
      <div className="side-head">
        <div className="side-title"><Icon.data /> Data & model card</div>
        <div className="side-sub">What is real, what is simulated, and how each number is computed.</div>
      </div>
      <div className="side-body" style={{ fontSize: 12, lineHeight: 1.6 }}>
        <div className="section">
          <div className="section-title">Sources</div>
          <div className="card">
            <div className="between"><span>Road network</span><span className="chip green">OpenStreetMap</span></div>
            <div className="muted">{d.roads.nodes.length.toLocaleString()} junctions · {d.roads.edges.length.toLocaleString()} segments with lanes, speed limits, one-way rules and names.</div>
          </div>
          <div className="card">
            <div className="between"><span>Buildings</span><span className="chip amber">mixed</span></div>
            <div className="muted">{osm.toLocaleString()} footprints from OSM (heights estimated when untagged) + {(d.buildings.length - osm).toLocaleString()} procedurally generated to fill unmapped blocks.</div>
          </div>
          <div className="card">
            <div className="between"><span>Critical facilities</span><span className="chip green">OpenStreetMap</span></div>
            <div className="muted">{d.pois.length} hospitals, fire stations, police stations and power substations, at their real locations.</div>
          </div>
          <div className="card">
            <div className="between"><span>Demand, loads, incidents</span><span className="chip violet">simulated</span></div>
            <div className="muted">Synthetic, seeded and reproducible. Not calibrated against real counts — the twin is a laboratory for comparing strategies, not a forecast of Medellín.</div>
          </div>
          <div className="dim" style={{ marginTop: 6 }}>{d.meta.source}. Globe: Natural Earth (public domain).</div>
        </div>
        <div className="section">
          <div className="section-title">Algorithms</div>
          <ul style={{ paddingLeft: 16, margin: 0 }}>
            <li><b>Routing:</b> A* with an admissible Euclidean/max-speed heuristic and Dijkstra on travel-time weights; live costs from exponentially-smoothed edge speeds.</li>
            <li><b>Signals:</b> fixed-time 30 s, or max-pressure adaptive control (serve the approach with the larger stopped queue, 7–55 s green), with emergency pre-emption.</li>
            <li><b>Dispatch:</b> severity-ordered greedy assignment minimising A* ETA over all idle units.</li>
            <li><b>Grid:</b> substations sized at 122% of base load; per-second failure hazard from storm intensity² and overload; repair time scales with crews.</li>
            <li><b>Anomalies:</b> per-edge z-score of speed against an EMA baseline.</li>
            <li><b>Forecast:</b> least-squares trend of the last 2 minutes of delay index.</li>
          </ul>
        </div>
        <div className="section">
          <div className="section-title">Metrics</div>
          <ul style={{ paddingLeft: 16, margin: 0 }}>
            <li><b>Delay index:</b> mean of 1 − v / v<sub>desired</sub> over all private vehicles.</li>
            <li><b>Trips / h:</b> completed trips in the last 5 simulated minutes, annualised to an hour.</li>
            <li><b>CO₂:</b> 170 g/km cars, 900 g/km buses, 0.28 g/s idling.</li>
            <li><b>Abandoned trips:</b> agents stuck &gt;240 s (gridlock breaker).</li>
          </ul>
        </div>
        <div className="section">
          <div className="section-title">Reproducibility</div>
          <div className="muted">Fixed 0.2 s step, a single seeded PRNG inside the state and no wall-clock inputs. The same seed + parameters + events always produce the same run — verified by automated tests, which also check that a Time-Machine restore replays the identical future.</div>
        </div>
      </div>
    </>
  )
}
