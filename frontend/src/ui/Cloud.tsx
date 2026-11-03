import { useEffect, useState } from 'react'
import { runtime } from '../runtime'
import { useUI } from '../store'
import { SCENARIOS } from '../sim/scenarios'
import { API_URL, addComment, comments, connect, createProject, fetchRun, invite, logout, openProject, saveScenario, share, signIn, useCloud, type CommentRec, type RunRec } from '../cloud'
import { pushRun } from '../lab'
import { Icon } from './Icons'
import { CompareToggle } from './Compare'

const input = { width: '100%', background: 'rgba(0,0,0,.3)', border: '1px solid var(--line-2)', borderRadius: 8, padding: '7px 10px', outline: 'none' } as const

function useAsync() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

function SignIn() {
  const [mode, setMode] = useState<'login' | 'register'>('register')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const { busy, error, run } = useAsync()
  return (
    <form className="section" onSubmit={(e) => { e.preventDefault(); run(() => signIn(mode, { email, password, name })) }}>
      <div className="seg" style={{ marginBottom: 12 }}>
        <button type="button" className={mode === 'register' ? 'on' : ''} onClick={() => setMode('register')}>Create account</button>
        <button type="button" className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>Sign in</button>
      </div>
      {mode === 'register' && <div className="param"><div className="param-head">Name</div><input style={input} value={name} onChange={(e) => setName(e.target.value)} required /></div>}
      <div className="param"><div className="param-head">Email</div><input style={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" /></div>
      <div className="param"><div className="param-head">Password <span className="dim">min. 8 characters</span></div><input style={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></div>
      {error && <div className="down" style={{ fontSize: 12, marginBottom: 8 }}>{error}</div>}
      <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>{busy ? '…' : mode === 'register' ? 'Create account' : 'Sign in'}</button>
    </form>
  )
}

function RunCard({ r, onOpen }: { r: RunRec; onOpen: () => void }) {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<CommentRec[]>([])
  const [text, setText] = useState('')
  const [link, setLink] = useState('')
  const sc = SCENARIOS.find((s) => s.id === r.preset)
  const sig = r.stats.filter((s) => s.p_value != null && s.p_value < 0.05).length
  useEffect(() => {
    if (open) comments(r.id).then(setList).catch(() => {})
  }, [open, r.id])
  return (
    <div className="card">
      <div className="between">
        <b style={{ fontSize: 12 }}>{r.label_b}</b>
        <span className={`chip ${r.verdict === 'B' ? 'green' : r.verdict === 'A' ? 'red' : 'amber'}`}>{r.verdict === 'B' ? 'B wins' : r.verdict === 'A' ? 'A wins' : 'tie'}</span>
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{sc?.name ?? r.preset} · {r.duration / 60} min · {new Date(r.created_at).toLocaleString()}</div>
      <div className="dim" style={{ fontSize: 10.5, marginTop: 3 }}>{r.stats.every((s) => s.p_value == null)
        ? 'single replicate · run 3+ seeds for a significance test'
        : `server-side Welch t-test: ${sig} KPI${sig === 1 ? '' : 's'} with p < 0.05`}</div>
      <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        <button className="btn small" onClick={onOpen}>Open in Lab</button>
        <button className="btn small" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Discuss'}</button>
        <button className="btn small" onClick={async () => { const u = await share('run', r.id); setLink(u); navigator.clipboard?.writeText(u).catch(() => {}) }}>{link ? 'Link copied ✓' : 'Public link'}</button>
        <CompareToggle run={() => fetchRun(r.id)} cloudId={r.id} />
      </div>
      {link && <div className="mono dim" style={{ fontSize: 10, marginTop: 6, wordBreak: 'break-all' }}>{link}</div>}
      {open && (
        <div style={{ marginTop: 8 }}>
          {list.map((c) => <div key={c.id} style={{ fontSize: 11.5, padding: '4px 0', borderTop: '1px solid var(--line)' }}><b>{c.user.name}</b> {c.text}</div>)}
          <form className="row" style={{ gap: 6, marginTop: 6 }} onSubmit={async (e) => { e.preventDefault(); if (!text.trim()) return; const c = await addComment(r.id, text); setList([...list, c]); setText('') }}>
            <input style={input} value={text} onChange={(e) => setText(e.target.value)} placeholder="Comment on this result…" />
            <button className="icon-btn" type="submit"><Icon.send /></button>
          </form>
        </div>
      )}
    </div>
  )
}

export function CloudPanel() {
  const cloud = useCloud()
  const params = useUI((s) => s.params)
  const scenarioId = useUI((s) => s.scenarioId)
  const [scName, setScName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'editor' | 'viewer'>('editor')
  const [newProject, setNewProject] = useState('')
  const [scLink, setScLink] = useState<Record<number, string>>({})
  const { busy, error, run } = useAsync()

  const head = (
    <div className="side-head">
      <div className="side-title"><Icon.data /> Cloud workspace</div>
      <div className="side-sub">Accounts, shared projects, saved scenarios and experiments, live collaboration and public links — backed by the SYNAPSE API.</div>
      {cloud.online && (
        <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <span className="chip green">API online</span>
          <span className="chip">{cloud.info.database === 'postgresql' ? 'PostgreSQL' : cloud.info.database}</span>
          {cloud.info.postgis && <span className="chip cyan">PostGIS</span>}
          {cloud.info.pgrouting && <span className="chip cyan">pgRouting</span>}
          <span className="chip">events: {cloud.info.events}</span>
        </div>
      )}
    </div>
  )

  if (cloud.online === false) {
    return (
      <>
        {head}
        <div className="side-body" style={{ fontSize: 12, lineHeight: 1.6 }}>
          <div className="card">
            <b>Offline demo mode</b>
            <p className="muted" style={{ margin: '6px 0' }}>The digital twin, Scenario Lab, Time Machine and copilot all run in your browser. Start the API to enable accounts and collaboration:</p>
            <pre className="mono" style={{ fontSize: 10.5, whiteSpace: 'pre-wrap', margin: 0, color: 'var(--cyan-2)' }}>cd backend{'\n'}.venv\Scripts\python -m uvicorn app.main:app --port 8010</pre>
            <p className="dim" style={{ margin: '6px 0 0' }}>Looking for it at {API_URL}</p>
          </div>
          <button className="btn" style={{ marginTop: 10 }} onClick={() => connect()}>Retry connection</button>
        </div>
      </>
    )
  }
  if (!cloud.user) {
    return (<>{head}<div className="side-body"><SignIn /></div></>)
  }
  const canEdit = cloud.project && cloud.project.role !== 'viewer'
  return (
    <>
      {head}
      <div className="side-body">
        <div className="section">
          <div className="between">
            <div><div style={{ fontWeight: 600 }}>{cloud.user.name}</div><div className="dim" style={{ fontSize: 11 }}>{cloud.user.email}</div></div>
            <button className="btn small" onClick={logout}>Sign out</button>
          </div>
        </div>

        <div className="section">
          <div className="section-title">Project</div>
          <select style={input} value={cloud.project?.id ?? ''} onChange={(e) => run(() => openProject(Number(e.target.value)))}>
            {cloud.projects.map((p) => <option key={p.id} value={p.id} style={{ background: '#0a1022' }}>{p.name} · {p.role}</option>)}
          </select>
          <form className="row" style={{ gap: 6, marginTop: 6 }} onSubmit={(e) => { e.preventDefault(); if (newProject.trim()) run(async () => { await createProject(newProject.trim()); setNewProject('') }) }}>
            <input style={input} value={newProject} onChange={(e) => setNewProject(e.target.value)} placeholder="New project name" />
            <button className="btn small" disabled={busy}>Create</button>
          </form>
        </div>

        {cloud.project && (
          <>
            <div className="section">
              <div className="section-title">Team <span>{cloud.presence.length} online now</span></div>
              {cloud.members.map((m) => (
                <div key={m.user.id} className="between" style={{ fontSize: 12, padding: '4px 0' }}>
                  <span className="row" style={{ gap: 6 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: cloud.presence.some((p) => p.id === m.user.id) ? 'var(--green)' : 'var(--text-3)' }} />
                    {m.user.name} <span className="dim">{m.user.email}</span>
                  </span>
                  <span className="chip">{m.role}</span>
                </div>
              ))}
              {cloud.project.role === 'owner' && (
                <form className="row" style={{ gap: 6, marginTop: 6 }} onSubmit={(e) => { e.preventDefault(); run(async () => { await invite(email, role); setEmail('') }) }}>
                  <input style={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="colleague@email.com" required />
                  <select style={{ ...input, width: 90 }} value={role} onChange={(e) => setRole(e.target.value as 'editor' | 'viewer')}>
                    <option value="editor" style={{ background: '#0a1022' }}>editor</option>
                    <option value="viewer" style={{ background: '#0a1022' }}>viewer</option>
                  </select>
                  <button className="btn small" disabled={busy}>Invite</button>
                </form>
              )}
            </div>

            <div className="section">
              <div className="section-title">Scenarios <span>{cloud.scenarios.length}</span></div>
              {canEdit && (
                <form className="row" style={{ gap: 6, marginBottom: 8 }} onSubmit={(e) => {
                  e.preventDefault()
                  const sc = SCENARIOS.find((s) => s.id === scenarioId)
                  run(async () => { await saveScenario(scName.trim() || `${sc?.name} · seed ${params.seed}`, scenarioId, params, sc?.intervention); setScName('') })
                }}>
                  <input style={input} value={scName} onChange={(e) => setScName(e.target.value)} placeholder="Save the live scenario as…" />
                  <button className="btn small primary" disabled={busy}>Save</button>
                </form>
              )}
              {cloud.scenarios.map((s) => (
                <div key={s.id} className="card">
                  <div className="between"><b style={{ fontSize: 12 }}>{s.name}</b><span className="chip mono">v{s.version} · seed {s.params.seed}</span></div>
                  <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{SCENARIOS.find((x) => x.id === s.preset)?.name ?? s.preset} · {s.params.vehicles} vehicles · {s.params.signals} signals</div>
                  <div className="row" style={{ gap: 6, marginTop: 8 }}>
                    <button className="btn small" onClick={() => { runtime.loadScenario(s.preset, s.params); useUI.setState({ paused: false }) }}><Icon.play /> Run live</button>
                    <button className="btn small" onClick={async () => { const u = await share('scenario', s.id); setScLink({ ...scLink, [s.id]: u }); navigator.clipboard?.writeText(u).catch(() => {}) }}>{scLink[s.id] ? 'Link copied ✓' : 'Public link'}</button>
                  </div>
                </div>
              ))}
            </div>

            <div className="section">
              <div className="section-title">Experiments <span>{cloud.runs.length}</span></div>
              {cloud.runs.length === 0 && <div className="dim" style={{ fontSize: 12 }}>Run an A/B test in Scenario Lab and press “Save to cloud”.</div>}
              {cloud.runs.map((r) => <RunCard key={r.id} r={r} onOpen={() => run(async () => { pushRun(await fetchRun(r.id)); useUI.setState({ panel: 'lab' }) })} />)}
            </div>

            <div className="section">
              <div className="section-title">Live activity</div>
              {cloud.feed.length === 0 && <div className="dim" style={{ fontSize: 12 }}>Changes by teammates appear here in real time.</div>}
              {cloud.feed.map((f, i) => (
                <div key={i} className="alert-row"><span className="mono dim">{new Date(f.t).toLocaleTimeString().slice(0, 5)}</span><span>{f.text}</span></div>
              ))}
            </div>
          </>
        )}
        {error && <div className="down" style={{ fontSize: 12 }}>{error}</div>}
      </div>
    </>
  )
}
