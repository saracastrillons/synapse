import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { create } from 'zustand'
import { ask } from '../ai/agent'
import { mainArterial } from '../ai/copilot'
import { clock, runtime } from '../runtime'
import { useUI } from '../store'
import { Icon } from './Icons'

/**
 * 60-second guided tour: welcome → watch traffic → meet an agent → cause an accident →
 * ask the AI → rewind time → run your own experiments. Each step spotlights a real part
 * of the interface and offers a one-click action that drives the live simulation.
 */

const DONE_KEY = 'synapse.tour.done'

interface TourState {
  step: number | null
  /** start as soon as the city is on screen (set from the globe's "tour" button) */
  queued: boolean
  start: () => void
  go: (n: number) => void
  end: () => void
}

export const useTour = create<TourState>((set) => ({
  step: null,
  queued: false,
  start: () => set({ step: 0, queued: false }),
  go: (n) => set({ step: n }),
  end: () => {
    try {
      localStorage.setItem(DONE_KEY, '1')
    } catch { /* storage unavailable */ }
    set({ step: null })
  },
}))

export function tourAlreadySeen() {
  try {
    return localStorage.getItem(DONE_KEY) === '1'
  } catch {
    return true
  }
}

const railButton = (label: string) => () => [...document.querySelectorAll<HTMLElement>('.rail-btn')].find((b) => b.textContent?.includes(label)) ?? null
const query = (...selectors: string[]) => () => {
  for (const s of selectors) {
    const el = document.querySelector<HTMLElement>(s)
    if (el && el.getBoundingClientRect().width > 0) return el
  }
  return null
}

interface Step {
  title: string
  body: ReactNode
  target?: () => HTMLElement | null
  enter?: () => void
  action?: { label: string; done: string; run: () => void }
}

const mainRoad = () => runtime.city.arterials[0].name
const accidentPrompt = () => `A major accident just blocked ${mainRoad()}. Find the fastest way to restore traffic flow`

function pickAgent() {
  const vs = runtime.sim.state.vehicles.filter((v) => v.edge >= 0 && !v.mission && v.kind === 'car')
  const v = vs.filter((x) => x.strategy === 'adaptive').sort((a, b) => b.reroutes - a.reroutes || b.v - a.v)[0] ?? vs[0]
  if (v) useUI.setState({ selected: v.id, follow: true })
  runtime.publish(true)
}

function blockMainRoad() {
  const sim = runtime.sim
  const edge = mainArterial(0)
  useUI.setState({ selected: null, follow: false, panel: useUI.getState().panel === 'ai' ? 'ai' : null })
  const existing = sim.state.incidents.find((i) => i.edge === edge && i.status !== 'resolved')
  const inc = existing ?? sim.createIncident('accident', edge, `Major accident on ${mainRoad()}`, 900)
  if (inc) useUI.getState().focusOn(inc.x, inc.z, 1000)
  runtime.publish(true)
}

const buildSteps = (): Step[] => [
  {
    title: 'Welcome to SYNAPSE',
    body: <>You are looking at a <b>live digital twin of {runtime.city.name} · {runtime.city.area.split(' · ')[0]}</b>, built on real OpenStreetMap streets, {runtime.sim.transit.lines.length ? 'rail lines, ' : ''}hospitals and substations. In one minute you will break the city, ask an AI how to fix it and rewind time.</>,
  },
  {
    title: 'A city that is alive',
    target: query('.kpis', '.topbar'),
    enter: () => useUI.setState({ paused: false, speed: 4, panel: window.innerWidth < 760 ? null : useUI.getState().panel }),
    body: <>These indicators update every moment. On the map, streets glow <span style={{ color: 'var(--amber)' }}>amber</span> → <span style={{ color: 'var(--red)' }}>red</span> as queues build up, and every moving light is one of <b>~1,300 autonomous vehicles</b>.</>,
  },
  {
    title: 'Meet an agent',
    target: query('.inspector'),
    enter: pickAgent,
    body: <>Each vehicle has a goal, constraints and a strategy. This one uses <b>live navigation</b>: its decision log explains every reroute it takes, computed with A* on real-time travel times.</>,
  },
  {
    title: 'Now, break something',
    target: query('.tools', '.toasts'),
    body: <>{mainRoad()} is one of downtown's main arteries. Block it and watch the dispatcher send the <b>closest ambulance by travel time</b> while connected drivers reroute.</>,
    action: { label: `Block ${mainRoad()}`, done: 'Accident created — an ambulance is on its way', run: blockMainRoad },
  },
  {
    title: 'Ask the AI what to do',
    target: query('.side'),
    enter: () => useUI.setState({ panel: 'ai', selected: null, follow: false }),
    body: <>The copilot does not guess: it computes the detour with A* and Dijkstra, <b>simulates four response strategies on identical seeds</b> in the background and recommends the best one with evidence. You can keep going while it works.</>,
    action: {
      label: 'Ask the copilot',
      done: 'Simulating strategies…',
      run: () => {
        if (!runtime.sim.state.incidents.some((i) => i.blocks && i.status !== 'resolved')) blockMainRoad()
        useUI.setState({ panel: 'ai' })
        void ask(accidentPrompt(), 'local')
      },
    },
  },
  {
    title: 'Rewind time',
    target: query('.tm'),
    body: <>SYNAPSE snapshots the whole city every 20 simulated seconds. <b>Rewind</b>, change a decision and compare: the original timeline stays on screen as a dashed line.</>,
    action: {
      label: 'Rewind 2 minutes',
      done: 'You are now on a new branch',
      run: () => {
        const t = runtime.sim.state.t
        runtime.rewind(Math.max(0, t - 120))
        useUI.setState({ paused: false })
      },
    },
  },
  {
    title: 'Your turn',
    target: railButton('Scenario Lab'),
    body: <>Run your own experiments in the <b>Scenario Lab</b> — storms, blackouts, +40 % traffic — with statistics you can export and share. The ✨ copilot and the agents panel are one click away.</>,
  },
]

export function Tour() {
  const { step, go, end } = useTour()
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [acted, setActed] = useState<Record<number, boolean>>({})
  const card = useRef<HTMLDivElement>(null)
  const [cardSize, setCardSize] = useState({ w: 360, h: 220 })
  const cityId = useUI((st) => st.cityId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const STEPS = useMemo(buildSteps, [cityId])
  const current = step != null ? STEPS[step] : null

  useEffect(() => {
    if (step == null) return
    STEPS[step].enter?.()
  }, [step])

  // follow the target as panels open, the camera moves and the window resizes
  useEffect(() => {
    if (!current) return
    let raf = 0
    const loop = () => {
      const el = current.target?.()
      const r = el?.getBoundingClientRect() ?? null
      setRect((prev) => (prev && r && prev.x === r.x && prev.y === r.y && prev.width === r.width && prev.height === r.height ? prev : r))
      raf = requestAnimationFrame(loop)
    }
    loop()
    return () => cancelAnimationFrame(raf)
  }, [current])

  useLayoutEffect(() => {
    if (card.current) setCardSize({ w: card.current.offsetWidth, h: card.current.offsetHeight })
  }, [step, acted])

  useEffect(() => {
    if (step == null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') end()
      if (e.key === 'ArrowRight') step < STEPS.length - 1 ? go(step + 1) : end()
      if (e.key === 'ArrowLeft' && step > 0) go(step - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, go, end])

  if (step == null || !current) return null
  const last = step === STEPS.length - 1
  const vw = window.innerWidth
  const vh = window.innerHeight
  const phone = vw < 760
  const pad = 8
  let pos: CSSProperties
  if (phone) pos = { left: 12, right: 12, bottom: 84 }
  else if (!rect) pos = { left: (vw - cardSize.w) / 2, top: (vh - cardSize.h) / 2 }
  else {
    const below = rect.bottom + pad + 14 + cardSize.h < vh
    const above = rect.top - pad - 14 - cardSize.h > 0
    const left = Math.min(vw - cardSize.w - 16, Math.max(16, rect.left + rect.width / 2 - cardSize.w / 2))
    if (below) pos = { left, top: rect.bottom + pad + 14 }
    else if (above) pos = { left, top: rect.top - pad - 14 - cardSize.h }
    else if (rect.left > cardSize.w + 40) pos = { left: rect.left - cardSize.w - 24, top: Math.min(vh - cardSize.h - 16, Math.max(16, rect.top)) }
    else pos = { left: Math.min(vw - cardSize.w - 16, rect.right + 24), top: Math.min(vh - cardSize.h - 16, Math.max(16, rect.top)) }
  }

  return (
    <div className="tour" role="dialog" aria-label={`Guided tour, step ${step + 1} of ${STEPS.length}: ${current.title}`}>
      {rect
        ? <div className="tour-spot" style={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }} />
        : <div className="tour-dim" />}
      <div ref={card} className="tour-card glass" style={pos}>
        <div className="between">
          <span className="tour-kicker"><Icon.target /> Guided tour · {step + 1}/{STEPS.length}</span>
          <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={end} aria-label="Close tour"><Icon.close /></button>
        </div>
        <h3>{current.title}</h3>
        <p>{current.body}</p>
        {current.action && (
          <button className={`btn ${acted[step] ? '' : 'primary'}`} style={{ width: '100%', justifyContent: 'center', marginBottom: 10 }} disabled={acted[step]}
            onClick={() => { current.action!.run(); setActed({ ...acted, [step]: true }) }}>
            {acted[step] ? `✓ ${current.action.done}` : current.action.label}
          </button>
        )}
        <div className="between">
          <div className="tour-dots">{STEPS.map((_, i) => <span key={i} className={i === step ? 'on' : i < step ? 'past' : ''} />)}</div>
          <div className="row" style={{ gap: 6 }}>
            {step === 0 ? <button className="btn small" onClick={end}>Explore on my own</button>
              : <button className="btn small" onClick={() => go(step - 1)}>Back</button>}
            <button className="btn small primary" onClick={() => (last ? end() : go(step + 1))}>
              {step === 0 ? 'Start the tour' : last ? 'Start exploring' : 'Next'}
            </button>
          </div>
        </div>
        {step === 5 && acted[5] && <div className="dim" style={{ fontSize: 10.5, marginTop: 8 }}>Now at {clock(runtime.sim.state.t)} — the dashed line is the original timeline.</div>}
      </div>
    </div>
  )
}
