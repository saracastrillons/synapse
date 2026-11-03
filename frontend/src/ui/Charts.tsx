import { useMemo } from 'react'

export function Sparkline({ values, color = '#22d3ee', width = 120, height = 34, max }: { values: number[]; color?: string; width?: number; height?: number; max?: number }) {
  const d = useMemo(() => {
    if (values.length < 2) return ''
    const hi = max ?? Math.max(...values, 1e-6)
    const lo = Math.min(0, ...values)
    return values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * width).toFixed(1)},${(height - ((v - lo) / (hi - lo || 1)) * (height - 4) - 2).toFixed(1)}`).join('')
  }, [values, width, height, max])
  const id = `sg${color.replace('#', '')}`
  return (
    <svg width={width} height={height}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {d && <path d={`${d}L${width},${height}L0,${height}Z`} fill={`url(#${id})`} />}
      {d && <path d={d} fill="none" stroke={color} strokeWidth="1.5" />}
    </svg>
  )
}

export interface Series {
  name: string
  color: string
  points: { t: number; v: number }[]
  dashed?: boolean
}

/** Multi-series time chart with axes, used by Scenario Lab, Time Machine and the copilot. */
export function LineChart({ series, height = 150, fmt = (v: number) => v.toFixed(0), unit = '', markers = [] }: {
  series: Series[]; height?: number; fmt?: (v: number) => string; unit?: string; markers?: { t: number; color: string; label?: string }[]
}) {
  const W = 340
  const H = height
  const pad = { l: 34, r: 8, t: 8, b: 18 }
  const all = series.flatMap((s) => s.points)
  if (all.length < 2) return <div className="dim" style={{ height: H, display: 'grid', placeItems: 'center' }}>collecting samples…</div>
  const t0 = Math.min(...all.map((p) => p.t))
  const t1 = Math.max(...all.map((p) => p.t), t0 + 1)
  let lo = Math.min(...all.map((p) => p.v))
  let hi = Math.max(...all.map((p) => p.v))
  const span = hi - lo || Math.abs(hi) || 1
  lo -= span * 0.08
  hi += span * 0.08
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r)
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b)
  const ticks = [lo + (hi - lo) * 0.15, (lo + hi) / 2, hi - (hi - lo) * 0.15]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: 'block' }}>
      {ticks.map((v, i) => (
        <g key={i}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="rgba(120,160,255,.1)" />
          <text x={pad.l - 5} y={y(v) + 3} fill="#5f6d8f" fontSize="9" textAnchor="end" fontFamily="JetBrains Mono">{fmt(v)}</text>
        </g>
      ))}
      <text x={pad.l} y={H - 4} fill="#5f6d8f" fontSize="9" fontFamily="JetBrains Mono">{Math.round(t0 / 60)}m</text>
      <text x={W - pad.r} y={H - 4} fill="#5f6d8f" fontSize="9" textAnchor="end" fontFamily="JetBrains Mono">{Math.round(t1 / 60)}m {unit}</text>
      {markers.map((m, i) => (
        <g key={i}>
          <line x1={x(m.t)} x2={x(m.t)} y1={pad.t} y2={H - pad.b} stroke={m.color} strokeDasharray="3 3" opacity="0.7" />
          {m.label && <text x={x(m.t) + 3} y={pad.t + 9} fill={m.color} fontSize="8.5" fontFamily="JetBrains Mono">{m.label}</text>}
        </g>
      ))}
      {series.map((s) => (
        <path key={s.name} d={s.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('')}
          fill="none" stroke={s.color} strokeWidth="1.8" strokeDasharray={s.dashed ? '4 3' : undefined} opacity={s.dashed ? 0.75 : 1} />
      ))}
    </svg>
  )
}

export function Legend({ items }: { items: { name: string; color: string; dashed?: boolean }[] }) {
  return (
    <div className="row" style={{ gap: 12, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-2)', marginTop: 4 }}>
      {items.map((i) => (
        <span key={i.name} className="row" style={{ gap: 5 }}>
          <svg width="16" height="4"><line x1="0" x2="16" y1="2" y2="2" stroke={i.color} strokeWidth="2" strokeDasharray={i.dashed ? '3 2' : undefined} /></svg>
          {i.name}
        </span>
      ))}
    </div>
  )
}
