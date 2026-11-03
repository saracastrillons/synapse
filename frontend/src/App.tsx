import { Suspense, useEffect, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing'
import { runtime } from './runtime'
import { useUI } from './store'
import { loadRuns, readSharedSetup } from './lab'
import { GlobeScene, HUBS } from './three/Globe'
import { CityScene } from './three/CityScene'
import { AgentsPanel, DataPanel, Inspector, OverviewPanel, Rail, TimeMachine, Toasts, Tools, TopBar } from './ui/Hud'
import { LabPanel } from './ui/Lab'
import { CommandCenter } from './ui/CommandCenter'
import { Logo } from './ui/Icons'
import { CityLabels } from './ui/Labels'
import { CloudPanel } from './ui/Cloud'
import { CompareModal } from './ui/Compare'
import { connect, detailToLabRun, openShared } from './cloud'
import { pushRun } from './lab'

function Boot({ done }: { done: boolean }) {
  const log = useUI((s) => s.bootLog)
  const error = useUI((s) => s.bootError)
  return (
    <div className="boot" style={{ opacity: done ? 0 : 1, pointerEvents: done ? 'none' : 'auto' }}>
      <div className="boot-inner">
        <div className="row" style={{ gap: 12, marginBottom: 18 }}>
          <Logo size={38} />
          <div><div className="brand-name" style={{ fontFamily: 'var(--sans)' }}>SYNAPSE</div><div className="brand-sub">initialising digital twin</div></div>
        </div>
        {log.map((l, i) => <div key={i}><span className="ok">✓</span> {l}</div>)}
        {error ? (
          <div style={{ marginTop: 14, color: 'var(--red)', lineHeight: 1.6 }}>
            ✗ {error}
            <div><button className="btn small" style={{ marginTop: 10 }} onClick={() => location.reload()}>Retry</button></div>
          </div>
        ) : <div className="boot-bar"><div style={{ width: `${Math.min(100, (log.length / 5) * 100)}%` }} /></div>}
      </div>
    </div>
  )
}

function GlobeOverlay() {
  const enter = () => useUI.setState({ mode: 'descending' })
  return (
    <>
      <div className="globe-hero">
        <div className="tag">The living digital twin of Earth</div>
        <h1>SYNAPSE</h1>
        <p>An interactive laboratory where cities become experiments. Agent-based traffic, emergency response and power-grid simulation on real OpenStreetMap data — with an AI that tests its own recommendations before it makes them.</p>
        <div className="cta">
          <button className="btn primary" style={{ padding: '11px 18px', fontSize: 13 }} onClick={enter}>Descend into Medellín →</button>
          <button className="btn" style={{ padding: '11px 14px' }} onClick={() => useUI.setState({ showAbout: true })}>How it works</button>
        </div>
      </div>
      <div className="city-list glass">
        <div className="section-title">Twins on the network</div>
        {HUBS.map((h) => (
          <div key={h.name} className={`city-item ${h.active ? 'on' : 'off'}`} onClick={h.active ? enter : undefined}>
            <div>
              <div style={{ fontWeight: 600 }}>{h.name}</div>
              <div className="dim mono" style={{ fontSize: 10 }}>{h.lat.toFixed(2)}°, {h.lon.toFixed(2)}°</div>
            </div>
            {h.active ? <span className="chip green">● live</span> : <span className="chip">{h.note}</span>}
          </div>
        ))}
      </div>
    </>
  )
}

function About() {
  const show = useUI((s) => s.showAbout)
  if (!show) return null
  return (
    <div className="modal-back" onClick={() => useUI.setState({ showAbout: false })}>
      <div className="modal glass" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ gap: 12 }}><Logo size={36} /><div><h2>SYNAPSE</h2><div className="dim">The Living Digital Twin of Earth · v0.1 · Medellín pilot</div></div></div>
        <h3>What it is</h3>
        <p>A computational laboratory that turns urban problems into reproducible experiments. Every vehicle is an autonomous agent; every junction, ambulance and substation follows an explicit model; every recommendation is backed by simulations you can rerun with the same seed.</p>
        <h3>Try this</h3>
        <ul>
          <li><b>AI Command Center</b> → "A major accident just blocked Avenida Oriental…" — the copilot blocks the road, computes the detour with A* and Dijkstra, simulates four strategies and explains the winner.</li>
          <li><b>Scenario Lab</b> → pick "Storm & blackout", set B to 4 repair crews, run the A/B experiment with 3 seeds, open the executive report.</li>
          <li><b>Time Machine</b> → let an accident happen, click the timeline before it, change a parameter and watch the new branch diverge from the dashed original.</li>
          <li><b>Map tools</b> → cause an accident or a medical call anywhere, then click the ambulance to read its decisions.</li>
        </ul>
        <h3>Engineering</h3>
        <p>React + TypeScript + React Three Fiber · deterministic agent engine (IDM, A*/Dijkstra, max-pressure signals, ETA dispatch, grid hazard model) shared by the live view and a Web Worker experiment runner · OSM → Python data pipeline · Vitest suite covering routing optimality, determinism and Time-Machine replay.</p>
        <h3>Honesty note</h3>
        <p>Roads, facilities and most building footprints are real (© OpenStreetMap contributors). Traffic demand, electrical loads and incidents are synthetic and uncalibrated; the twin compares strategies, it does not predict Medellín's actual traffic.</p>
        <div style={{ textAlign: 'right', marginTop: 16 }}><button className="btn primary" onClick={() => useUI.setState({ showAbout: false })}>Close</button></div>
      </div>
    </div>
  )
}

let booted = false

function webglAvailable() {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    return false
  }
}

export default function App() {
  const mode = useUI((s) => s.mode)
  const panel = useUI((s) => s.panel)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const log = (s: string) => useUI.setState({ bootLog: [...useUI.getState().bootLog, s] })
    let first = false
    if (!booted) {
      booted = true
      first = true
    }
    if (!webglAvailable()) {
      useUI.setState({ bootError: 'This browser cannot run WebGL, which SYNAPSE needs for its 3D view. Try an up-to-date Chrome, Edge or Firefox with hardware acceleration enabled.' })
      return
    }
    runtime.load(log).catch((e: Error) => {
      useUI.setState({ bootError: `Could not load the city dataset (${e.message}). Check your connection and retry.` })
      throw e
    }).then(() => {
      setLoaded(true)
      if (!first) return
      useUI.setState({ lab: { ...useUI.getState().lab, runs: loadRuns() } })
      connect()
      const shareToken = new URLSearchParams(location.search).get('share')
      if (shareToken) {
        history.replaceState(null, '', location.pathname)
        openShared(shareToken).then((s) => {
          const d = s.data as Record<string, never>
          if (s.kind === 'scenario') {
            runtime.loadScenario(d.preset, d.params)
            useUI.setState({ mode: 'city', panel: 'overview' })
          } else {
            pushRun(detailToLabRun({ ...(d as object), id: Date.now() } as Parameters<typeof detailToLabRun>[0]))
            useUI.setState({ mode: 'city', panel: 'lab' })
          }
          runtime.sim.alert('info', `Opened shared ${s.kind} from project "${s.project}" · ${s.views} views`)
        }).catch(() => useUI.setState({ mode: 'globe' }))
      } else if (readSharedSetup()) useUI.setState({ mode: 'city', panel: 'lab' })
      else setTimeout(() => useUI.setState({ mode: 'globe' }), 500)
    })
  }, [])

  const inCity = mode === 'city'
  return (
    <div className="app">
      <div className="canvas-wrap">
        {loaded && (
          <Canvas camera={{ fov: 45, near: 1, far: 20000, position: [0, 0, 400] }} dpr={[1, 1.75]} gl={{ antialias: true, powerPreference: 'high-performance' }}>
            <Suspense fallback={null}>
              {inCity ? <CityScene /> : <GlobeScene />}
              <EffectComposer multisampling={0}>
                <Bloom intensity={inCity ? 0.9 : 1.2} luminanceThreshold={inCity ? 0.62 : 0.2} luminanceSmoothing={0.2} mipmapBlur />
                <Vignette offset={0.25} darkness={0.75} />
              </EffectComposer>
            </Suspense>
          </Canvas>
        )}
      </div>
      <div className="hud">
        {mode === 'globe' && <GlobeOverlay />}
        {mode === 'descending' && (
          <div className="veil" style={{ opacity: 0.85 }}>
            <div className="veil-text">Descending to 6.25° N, 75.57° W<br />establishing twin link · Medellín Centro</div>
          </div>
        )}
        {inCity && (
          <>
            <CityLabels />
            <TopBar />
            <Rail />
            {panel && (
              <div className="side glass">
                {panel === 'overview' && <OverviewPanel />}
                {panel === 'lab' && <LabPanel />}
                {panel === 'ai' && <CommandCenter />}
                {panel === 'agents' && <AgentsPanel />}
                {panel === 'data' && <DataPanel />}
                {panel === 'cloud' && <CloudPanel />}
              </div>
            )}
            <Inspector />
            <Tools />
            <TimeMachine />
            <Toasts />
          </>
        )}
      </div>
      <About />
      <CompareModal />
      <Boot done={loaded && mode !== 'boot'} />
    </div>
  )
}
