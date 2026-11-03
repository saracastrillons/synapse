import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { ask, llmAvailable, resetAgent } from '../ai/agent'
import { useCloud } from '../cloud'
import { useUI, type ChatMessage, type XaiCard } from '../store'
import { Icon } from './Icons'

const STARTERS: { title: string; prompt: string; icon: () => ReactNode }[] = [
  { title: 'Restore traffic after a crash', prompt: 'A major accident just blocked Avenida Oriental. Find the fastest way to restore traffic flow', icon: Icon.block },
  { title: 'Dispatch an ambulance', prompt: 'Send an ambulance to Carrera 54 and tell me if signal pre-emption is worth it', icon: Icon.cross },
  { title: 'Stress-test the grid', prompt: '¿Qué pasa si una tormenta tumba la Subestación Central EPM? ¿Cómo nos recuperamos más rápido?', icon: Icon.storm },
  { title: 'Find the bottlenecks', prompt: 'Where is the congestion right now and what would you change?', icon: Icon.target },
]

/** Minimal, safe markdown: **bold**, paragraphs, and bullet / numbered lists. */
function Rich({ text }: { text: string }) {
  const inline = (s: string): ReactNode[] => s.split(/(\*\*[^*]+\*\*)/g).map((p, i) => (p.startsWith('**') && p.endsWith('**') ? <b key={i} style={{ color: '#fff' }}>{p.slice(2, -2)}</b> : <Fragment key={i}>{p}</Fragment>))
  const bullet = /^\s*(?:[-*•]|\d+[.)]|★)\s+/
  return (
    <>
      {text.split(/\n\s*\n/).map((block, i) => {
        const lines = block.split('\n').filter((l) => l.trim())
        if (lines.length && lines.every((l) => bullet.test(l))) {
          return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(bullet, ''))}</li>)}</ul>
        }
        return <p key={i}>{lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l)}</Fragment>)}</p>
      })}
    </>
  )
}

function Xai({ card }: { card: XaiCard }) {
  const max = Math.max(0.05, ...card.factors.map((f) => Math.abs(f.delta)))
  return (
    <div className="xai">
      <div className="between">
        <span className="xai-kicker">Explainable recommendation</span>
        <span className="chip violet">{card.confidence}</span>
      </div>
      <div className="xai-title">{card.title}: <span>{card.recommendation}</span></div>
      {card.factors.map((f) => {
        const w = (Math.abs(f.delta) / max) * 50
        return (
          <div key={f.label} className="factor">
            <span className="muted">{f.label}</span>
            <div className="track"><div style={{ left: `${f.good ? 50 : 50 - w}%`, width: `${w}%`, background: f.good ? 'var(--green)' : 'var(--red)' }} /></div>
            <span className={`mono ${f.good ? 'up' : 'down'}`} style={{ textAlign: 'right', fontSize: 11 }}>{f.display}</span>
          </div>
        )
      })}
      <div className="dim" style={{ fontSize: 10.5, marginTop: 8, lineHeight: 1.5 }}>{card.evidence}</div>
    </div>
  )
}

function ToolTimeline({ tools }: { tools: NonNullable<ChatMessage['tools']> }) {
  const [open, setOpen] = useState(true)
  const done = tools.filter((t) => t.result !== '…').length
  return (
    <div className="timeline">
      <button className="timeline-head" onClick={() => setOpen(!open)}>
        <span>{open ? '▾' : '▸'} {done}/{tools.length} tool call{tools.length > 1 ? 's' : ''}</span>
        <span className="dim mono">{(tools.reduce((a, t) => a + t.ms, 0) / 1000).toFixed(1)} s</span>
      </button>
      {open && tools.map((t, i) => {
        const running = t.result === '…'
        let args = t.args
        try {
          const o = JSON.parse(t.args)
          args = Object.entries(o).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : v}`).join(', ')
        } catch { /* keep raw */ }
        return (
          <div key={i} className={`step ${running ? 'running' : 'done'}`}>
            <span className="step-dot">{running ? <span className="spin" /> : '✓'}</span>
            <div style={{ minWidth: 0 }}>
              <div className="between"><span className="mono step-name">{t.name}</span>{!running && <span className="dim mono" style={{ fontSize: 10 }}>{t.ms < 1000 ? `${t.ms.toFixed(0)} ms` : `${(t.ms / 1000).toFixed(1)} s`}</span>}</div>
              {args && <div className="step-args">{args.length > 110 ? args.slice(0, 110) + '…' : args}</div>}
              {!running && <div className="step-res">→ {t.result}</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Message({ m }: { m: ChatMessage }) {
  if (m.role === 'user') return <div className="msg user">{m.text}</div>
  return (
    <div className="msg ai">
      <div className="who">
        <span className="avatar"><Icon.ai /></span> SYNAPSE COPILOT
        <span className={`chip ${m.engine === 'llm' ? 'cyan' : ''}`} style={{ marginLeft: 'auto' }}>{m.engine === 'llm' ? 'Gemini agent' : 'on-device planner'}</span>
      </div>
      {m.notice && <div className="notice">{m.notice}</div>}
      {m.tools && m.tools.length > 0 && <ToolTimeline tools={m.tools} />}
      {m.pending ? <div className="thinking"><span className="typing"><span /><span /><span /></span> {m.text}</div> : <div className="answer"><Rich text={m.text} /></div>}
      {m.xai && <Xai card={m.xai} />}
      {m.actions && (
        <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
          {m.actions.map((a, i) => <ActionButton key={i} label={a.label} run={a.run} primary={i === 0} />)}
        </div>
      )}
    </div>
  )
}

function ActionButton({ label, run, primary }: { label: string; run: () => void; primary: boolean }) {
  const [done, setDone] = useState(false)
  return (
    <button className={`btn small ${primary && !done ? 'primary' : ''}`} disabled={done} onClick={() => { run(); setDone(true) }}>
      {done ? `✓ ${label.replace(/^(Apply|Aplicar) /, '')} applied` : label}
    </button>
  )
}

export function CommandCenter() {
  const chat = useUI((s) => s.chat)
  const online = useCloud((s) => s.online)
  const info = useCloud((s) => s.info)
  const llm = online === true && !!info.copilot?.enabled
  const [engine, setEngine] = useState<'llm' | 'local'>(llmAvailable() ? 'llm' : 'local')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const log = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setEngine(llm ? 'llm' : 'local')
  }, [llm])
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' })
  }, [chat])
  useEffect(() => {
    if (!input.current) return
    input.current.style.height = 'auto'
    input.current.style.height = `${Math.min(140, input.current.scrollHeight)}px`
  }, [text])

  const send = async (q: string) => {
    if (!q.trim() || busy) return
    setText('')
    setBusy(true)
    try {
      await ask(q.trim(), engine)
    } finally {
      setBusy(false)
      input.current?.focus()
    }
  }

  return (
    <div className="chat">
      <div className="side-head">
        <div className="between">
          <div className="side-title"><Icon.ai /> AI Command Center</div>
          {chat.length > 0 && <button className="btn small" disabled={busy} onClick={() => { useUI.setState({ chat: [], highlight: null }); resetAgent() }}>New chat</button>}
        </div>
        <div className="side-sub">An agent that reads the live twin, calls authorised engine tools, runs controlled simulations and explains its recommendation with measured evidence.</div>
        <div className="seg" style={{ marginTop: 10 }}>
          <button className={engine === 'llm' ? 'on' : ''} disabled={!llm} title={llm ? '' : 'Start the SYNAPSE API with GEMINI_API_KEY to enable'} onClick={() => setEngine('llm')}>
            <span className="dot" style={{ background: llm ? 'var(--green)' : 'var(--text-3)' }} /> Gemini agent{llm ? ` · ${info.copilot?.model}` : ' · offline'}
          </button>
          <button className={engine === 'local' ? 'on' : ''} onClick={() => setEngine('local')}>On-device planner</button>
        </div>
      </div>
      <div className="chat-log" ref={log}>
        {chat.length === 0 && (
          <div className="empty">
            <div className="empty-title">What should we test today?</div>
            <div className="dim" style={{ fontSize: 12, marginBottom: 12 }}>
              {engine === 'llm' ? 'Gemini plans which tools to use; every number it reports comes from the simulation.' : 'The on-device planner maps your request to a fixed tool plan. Works offline.'}
            </div>
            <div className="starters">
              {STARTERS.map((s) => (
                <button key={s.title} className="starter" onClick={() => send(s.prompt)} disabled={busy}>
                  <span className="starter-icon"><s.icon /></span>
                  <span><b>{s.title}</b><span className="dim">{s.prompt}</span></span>
                </button>
              ))}
            </div>
          </div>
        )}
        {chat.map((m) => <Message key={m.id} m={m} />)}
      </div>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); send(text) }}>
        <textarea ref={input} rows={1} value={text} onChange={(e) => setText(e.target.value)} disabled={busy}
          placeholder={busy ? 'Working on it…' : 'Ask SYNAPSE to analyse or intervene…'}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(text) } }} />
        <button className="send" type="submit" disabled={busy || !text.trim()} aria-label="Send"><Icon.send /></button>
      </form>
      <div className="composer-hint dim">Enter to send · Shift+Enter for a new line · policy changes always ask for your confirmation</div>
    </div>
  )
}
