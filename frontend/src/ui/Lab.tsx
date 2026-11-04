import { useEffect, useState } from 'react'
import { runtime } from '../runtime'
import { useUI, type LabRun } from '../store'
import { SCENARIOS, scenarioById } from '../sim/scenarios'
import { DEFAULT_PARAMS, type SimParams } from '../sim/types'
import { compare, exportCsv, exportJson, fmtKpi, openReport, pushRun, readSharedSetup, runAB, seriesOf, shareLink, verdict } from '../lab'
import { Icon } from './Icons'
import { broadcastActivity, saveRun, useCloud } from '../cloud'
import { CompareToggle } from './Compare'
import { Legend, LineChart } from './Charts'

type NumKey = 'vehicles' | 'capacity' | 'smartNav' | 'storm' | 'powerDemand' | 'repairCrews' | 'ambulances' | 'incidentRate' | 'seed' | 'startHour' | 'metro'

const hhmm = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`

const SLIDERS: { key: NumKey; label: string; min: number; max: number; step: number; fmt: (v: number) => string }[] = [
  { key: 'startHour', label: 'Start time', min: 0, max: 23.5, step: 0.5, fmt: hhmm },
  { key: 'metro', label: 'Rail service level', min: 0, max: 1, step: 0.25, fmt: (v) => (v === 0 ? 'suspended' : `${(v * 100).toFixed(0)}%`) },
  { key: 'vehicles', label: 'Vehicles at peak hour', min: 200, max: 2400, step: 50, fmt: (v) => v.toFixed(0) },
  { key: 'capacity', label: 'Road capacity (lanes ×)', min: 0.5, max: 1.5, step: 0.05, fmt: (v) => `${(v * 100).toFixed(0)}%` },
  { key: 'smartNav', label: 'Connected navigation', min: 0, max: 1, step: 0.05, fmt: (v) => `${(v * 100).toFixed(0)}%` },
  { key: 'storm', label: 'Storm intensity', min: 0, max: 1, step: 0.05, fmt: (v) => `${(v * 100).toFixed(0)}%` },
  { key: 'powerDemand', label: 'Electricity demand', min: 0.6, max: 1.6, step: 0.05, fmt: (v) => `${(v * 100).toFixed(0)}%` },
  { key: 'repairCrews', label: 'Grid repair crews', min: 1, max: 4, step: 1, fmt: (v) => v.toFixed(0) },
  { key: 'ambulances', label: 'Ambulances per hospital', min: 1, max: 3, step: 1, fmt: (v) => v.toFixed(0) },
  { key: 'incidentRate', label: 'Random incidents / hour', min: 0, max: 20, step: 1, fmt: (v) => v.toFixed(0) },
  { key: 'seed', label: 'Random seed', min: 1, max: 9999, step: 1, fmt: (v) => v.toFixed(0) },
]

export function ParamEditor({ value, onChange, base }: { value: SimParams; onChange: (p: SimParams) => void; base?: SimParams }) {
  const changed = (k: keyof SimParams) => base && base[k] !== value[k]
  return (
    <>
      {SLIDERS.map((s) => (
        <div className="param" key={s.key}>
          <div className="param-head">
            <span style={changed(s.key) ? { color: 'var(--magenta)' } : undefined}>{s.label}{changed(s.key) ? ' •' : ''}</span>
            <span className="mono">{s.fmt(value[s.key])}</span>
          </div>
          <input type="range" min={s.min} max={s.max} step={s.step} value={value[s.key]} onChange={(e) => onChange({ ...value, [s.key]: Number(e.target.value) })} />
        </div>
      ))}
      <div className="param">
        <div className="param-head"><span style={changed('dynamicDemand') ? { color: 'var(--magenta)' } : undefined}>Traffic demand</span></div>
        <div className="seg">
          <button className={value.dynamicDemand ? 'on' : ''} onClick={() => onChange({ ...value, dynamicDemand: true })}>Follows time of day</button>
          <button className={!value.dynamicDemand ? 'on' : ''} onClick={() => onChange({ ...value, dynamicDemand: false })}>Constant</button>
        </div>
      </div>
      <div className="param">
        <div className="param-head"><span style={changed('signals') ? { color: 'var(--magenta)' } : undefined}>Signal control</span></div>
        <div className="seg">
          <button className={value.signals === 'fixed' ? 'on' : ''} onClick={() => onChange({ ...value, signals: 'fixed' })}>Fixed-time 30 s</button>
          <button className={value.signals === 'adaptive' ? 'on' : ''} onClick={() => onChange({ ...value, signals: 'adaptive' })}>Adaptive max-pressure</button>
        </div>
      </div>
      <div className="param">
        <div className="param-head"><span style={changed('preemption') ? { color: 'var(--magenta)' } : undefined}>Emergency signal pre-emption</span></div>
        <div className="seg">
          <button className={value.preemption ? 'on' : ''} onClick={() => onChange({ ...value, preemption: true })}>On</button>
          <button className={!value.preemption ? 'on' : ''} onClick={() => onChange({ ...value, preemption: false })}>Off</button>
        </div>
      </div>
    </>
  )
}

export function LabPanel() {
  const scenarioId = useUI((s) => s.scenarioId)
  const live = useUI((s) => s.params)
  const lab = useUI((s) => s.lab)
  const [sel, setSel] = useState(scenarioId)
  const preset = scenarioById(sel)!
  const [a, setA] = useState<SimParams>(() => ({ ...live }))
  const [b, setB] = useState<SimParams>(() => ({ ...live, ...preset.intervention?.params }))
  const [labelB, setLabelB] = useState(preset.intervention?.label ?? 'Intervention')
  const [tab, setTab] = useState<'A' | 'B'>('A')
  const [duration, setDuration] = useState(600)
  const [reps, setReps] = useState(1)
  const [metric, setMetric] = useState<'speed' | 'congestion' | 'throughput' | 'power'>('congestion')
  const [copied, setCopied] = useState(false)
  const current = lab.runs[lab.runs.length - 1]

  useEffect(() => {
    const shared = readSharedSetup()
    if (shared) {
      setSel(shared.scenario)
      setA(shared.a)
      setB(shared.b)
      setLabelB(shared.labelB)
      setDuration(shared.duration)
      setReps(shared.reps)
      history.replaceState(null, '', location.pathname)
    }
  }, [])

  const choose = (id: string) => {
    const p = scenarioById(id)!
    const pa = { ...DEFAULT_PARAMS, seed: a.seed, ...p.params }
    setSel(id)
    setA(pa)
    setB({ ...pa, ...p.intervention?.params })
    setLabelB(p.intervention?.label ?? 'Intervention')
  }

  const runLive = (p: SimParams) => {
    runtime.loadScenario(sel, p)
    useUI.setState({ paused: false })
  }

  const run = async () => {
    broadcastActivity(`is running an A/B experiment: ${labelB}`)
    useUI.setState({ lab: { ...useUI.getState().lab, running: true, progress: 0, label: 'starting' } })
    const r = await runAB({
      scenarioId: sel, a, b, labelA: 'Baseline', labelB, duration, reps,
      onProgress: (p, label) => useUI.setState({ lab: { ...useUI.getState().lab, progress: p, label } }),
    })
    useUI.setState({ lab: { ...useUI.getState().lab, running: false, progress: 1 } })
    pushRun(r)
  }

  return (
    <>
      <div className="side-head">
        <div className="side-title"><Icon.lab /> Scenario Lab</div>
        <div className="side-sub">Build a hypothetical situation, then test an intervention against it. Both arms run on identical seeds, so differences come from the decision, not from luck.</div>
      </div>
      <div className="side-body">
        <div className="section">
          <div className="section-title">1 · Situation</div>
          <div className="grid2">
            {SCENARIOS.map((s) => (
              <button key={s.id} className={`card scn ${sel === s.id ? 'on' : ''}`} style={{ marginTop: 0 }} onClick={() => choose(s.id)}>
                <div className="scn-name">{s.name}</div>
                <div className="scn-tag">{s.tagline}</div>
              </button>
            ))}
          </div>
          <div className="card" style={{ marginTop: 8, fontSize: 12, fontStyle: 'italic', color: 'var(--text-2)' }}>“{preset.question}”</div>
        </div>

        <div className="section">
          <div className="section-title">
            2 · Parameters
            <div className="seg" style={{ width: 150 }}>
              <button className={tab === 'A' ? 'on' : ''} onClick={() => setTab('A')}>A · baseline</button>
              <button className={tab === 'B' ? 'on' : ''} onClick={() => setTab('B')}>B · test</button>
            </div>
          </div>
          {tab === 'B' && (
            <div className="param">
              <div className="param-head"><span>Intervention name</span></div>
              <input value={labelB} onChange={(e) => setLabelB(e.target.value)} style={{ width: '100%', background: 'rgba(0,0,0,.3)', border: '1px solid var(--line-2)', borderRadius: 8, padding: '6px 9px' }} />
            </div>
          )}
          {tab === 'A' ? <ParamEditor value={a} onChange={setA} /> : <ParamEditor value={b} onChange={setB} base={a} />}
          <div className="row" style={{ gap: 6, marginTop: 4 }}>
            <button className="btn" onClick={() => runLive(tab === 'A' ? a : b)}><Icon.play /> Run {tab} live on the map</button>
          </div>
        </div>

        <div className="section">
          <div className="section-title">3 · Experiment</div>
          <div className="grid2" style={{ marginBottom: 10 }}>
            <div>
              <div className="dim" style={{ fontSize: 11, marginBottom: 4 }}>Simulated time</div>
              <div className="seg">{[300, 600, 900].map((d) => <button key={d} className={duration === d ? 'on' : ''} onClick={() => setDuration(d)}>{d / 60} min</button>)}</div>
            </div>
            <div>
              <div className="dim" style={{ fontSize: 11, marginBottom: 4 }}>Replicates (seeds)</div>
              <div className="seg">{[1, 3, 5].map((r) => <button key={r} className={reps === r ? 'on' : ''} onClick={() => setReps(r)}>{r}</button>)}</div>
            </div>
          </div>
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center', padding: 10 }} disabled={lab.running} onClick={run}>
            {lab.running ? `Simulating… ${(lab.progress * 100).toFixed(0)}%` : `Run A/B · ${reps * 2} simulations × ${duration / 60} min`}
          </button>
          {lab.running && (
            <>
              <div className="bar" style={{ marginTop: 8 }}><div style={{ width: `${lab.progress * 100}%`, background: 'linear-gradient(90deg,#22d3ee,#a78bfa)' }} /></div>
              <div className="dim mono" style={{ fontSize: 10.5, marginTop: 4 }}>{lab.label}</div>
            </>
          )}
        </div>

        {current && <Results run={current} metric={metric} setMetric={setMetric} onShare={async () => {
          await navigator.clipboard?.writeText(shareLink({ scenario: sel, a, b, labelB, duration, reps })).catch(() => {})
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        }} copied={copied} onApply={() => runLive(current.b[0].params)} />}

        {lab.runs.length > 1 && (
          <div className="section">
            <div className="section-title">Experiment history</div>
            {[...lab.runs].reverse().slice(1).map((r) => {
              const v = verdict(r)
              return (
                <div key={r.id} className="alert-row" style={{ gridTemplateColumns: '56px 1fr auto', alignItems: 'center' }} onClick={() => useUI.setState({ lab: { ...lab, runs: [...lab.runs.filter((x) => x.id !== r.id), r] } })}>
                  <span className="mono dim">{new Date(r.createdAt).toLocaleTimeString().slice(0, 5)}</span>
                  <span>{scenarioById(r.scenario)?.name} · <b className={v.winner === 'B' ? 'up' : v.winner === 'A' ? 'down' : ''}>{r.labelB}</b></span>
                  <CompareToggle run={r} />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}

function Results({ run, metric, setMetric, onShare, copied, onApply }: {
  run: LabRun; metric: 'speed' | 'congestion' | 'throughput' | 'power'; setMetric: (m: 'speed' | 'congestion' | 'throughput' | 'power') => void
  onShare: () => void; copied: boolean; onApply: () => void
}) {
  const rows = compare(run)
  const v = verdict(run)
  const sc = scenarioById(run.scenario)
  const events = runtime.scenarioEvents(run.scenario)
  return (
    <div className="section">
      <div className="section-title">Results · {sc?.name}</div>
      <div className="card" style={{ borderColor: v.winner === 'B' ? 'rgba(52,211,153,.5)' : v.winner === 'A' ? 'rgba(251,79,107,.5)' : 'var(--line-2)', marginBottom: 10 }}>
        <div className="row" style={{ gap: 6, marginBottom: 4 }}>
          <span className={`chip ${v.winner === 'B' ? 'green' : v.winner === 'A' ? 'red' : 'amber'}`}>{v.winner === 'B' ? 'Intervention wins' : v.winner === 'A' ? 'Baseline wins' : 'Inconclusive'}</span>
          <span className="chip mono">{run.a.length} seed{run.a.length > 1 ? 's' : ''} · {run.duration / 60} min</span>
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.5 }}>{v.text}</div>
      </div>
      <table className="cmp">
        <thead><tr><th>KPI</th><th>A</th><th>B</th><th>Δ</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.label}{r.unit && <span className="dim"> {r.unit}</span>}</td>
              <td>{fmtKpi(r.key, r.a)}{r.sdA > 0 && <span className="dim"> ±{fmtKpi(r.key, r.sdA)}</span>}</td>
              <td>{fmtKpi(r.key, r.b)}{r.sdB > 0 && <span className="dim"> ±{fmtKpi(r.key, r.sdB)}</span>}</td>
              <td className={r.better === null ? 'dim' : r.better ? 'up' : 'down'} title={r.consistent ? 'same direction in every replicate' : 'direction varies across replicates'}>
                {r.better === null ? '≈' : `${r.delta > 0 ? '+' : ''}${(r.delta * 100).toFixed(1)}%`}{run.a.length > 1 && r.better !== null && (r.consistent ? ' ✓' : ' ~')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="seg" style={{ margin: '12px 0 6px' }}>
        {(['congestion', 'speed', 'throughput', 'power'] as const).map((m) => <button key={m} className={metric === m ? 'on' : ''} onClick={() => setMetric(m)}>{m === 'congestion' ? 'delay' : m}</button>)}
      </div>
      <LineChart unit="sim" fmt={(x) => x.toFixed(0)} series={[
        { name: 'A', color: '#22d3ee', points: seriesOf(run.a, metric) },
        { name: 'B', color: '#f472b6', points: seriesOf(run.b, metric) },
      ]} markers={events.filter((e) => e.type !== 'demand').map((e) => ({ t: e.t, color: '#fbbf24', label: e.type }))} />
      <Legend items={[{ name: `A · ${run.labelA}`, color: '#22d3ee' }, { name: `B · ${run.labelB}`, color: '#f472b6' }]} />
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
        <button className="btn small primary" onClick={onApply}>Apply B live</button>
        <button className="btn small" onClick={() => openReport(run)}>Executive report</button>
        <button className="btn small" onClick={() => exportCsv(run)}>CSV</button>
        <button className="btn small" onClick={() => exportJson(run)}>JSON</button>
        <button className="btn small" onClick={onShare}>{copied ? 'Link copied ✓' : 'Share link'}</button>
        <SaveToCloud run={run} />
        <CompareToggle run={run} />
      </div>
      <div className="dim" style={{ fontSize: 10.5, marginTop: 8 }}>Computed in a Web Worker in {(run.a.concat(run.b).reduce((x, r) => x + r.wallMs, 0) / 1000).toFixed(1)} s · ✓ = same sign in every replicate</div>
    </div>
  )
}

function SaveToCloud({ run }: { run: LabRun }) {
  const user = useCloud((s) => s.user)
  const project = useCloud((s) => s.project)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  useEffect(() => setState('idle'), [run.id])
  if (!user || !project || project.role === 'viewer') {
    return <button className="btn small" title="Sign in from the Cloud workspace" onClick={() => useUI.setState({ panel: 'cloud' })}>Save to cloud…</button>
  }
  return (
    <button className="btn small" disabled={state === 'saving' || state === 'saved'} onClick={async () => {
      setState('saving')
      try {
        await saveRun(run)
        setState('saved')
      } catch {
        setState('error')
      }
    }}>{state === 'saved' ? `Saved to ${project.name} ✓` : state === 'saving' ? 'Saving…' : state === 'error' ? 'Save failed — retry' : 'Save to cloud'}</button>
  )
}
