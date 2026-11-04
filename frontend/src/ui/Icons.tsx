const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export const Icon = {
  globe: () => (<svg width="19" height="19" viewBox="0 0 24 24" {...s}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" /></svg>),
  city: () => (<svg width="19" height="19" viewBox="0 0 24 24" {...s}><path d="M3 21h18M5 21V9l5-3v15M10 21V4l6 3v14M16 21v-9l4 2v7" /></svg>),
  lab: () => (<svg width="19" height="19" viewBox="0 0 24 24" {...s}><path d="M9 3h6M10 3v6l-5.5 9.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3" /><path d="M7.5 15h9" /></svg>),
  ai: () => (<svg width="19" height="19" viewBox="0 0 24 24" {...s}><path d="M12 3l1.8 4.6L18.5 9l-4.7 1.6L12 15l-1.8-4.4L5.5 9l4.7-1.4z" /><path d="M18.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" /></svg>),
  agents: () => (<svg width="19" height="19" viewBox="0 0 24 24" {...s}><circle cx="6" cy="7" r="2.5" /><circle cx="18" cy="7" r="2.5" /><circle cx="12" cy="17" r="2.5" /><path d="M8 8.5l2.8 6.3M16 8.5l-2.8 6.3M8.5 7h7" /></svg>),
  data: () => (<svg width="19" height="19" viewBox="0 0 24 24" {...s}><ellipse cx="12" cy="5.5" rx="7" ry="2.5" /><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" /></svg>),
  cloud: () => (<svg width="19" height="19" viewBox="0 0 24 24" {...s}><path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4.5 4.5 0 0 1-.5 9.5z" /><path d="M12 11v5M9.5 13.5L12 11l2.5 2.5" /></svg>),
  sun: () => (<svg width="14" height="14" viewBox="0 0 24 24" {...s}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>),
  moon: () => (<svg width="14" height="14" viewBox="0 0 24 24" {...s}><path d="M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z" /></svg>),
  train: () => (<svg width="15" height="15" viewBox="0 0 24 24" {...s}><rect x="5" y="3" width="14" height="14" rx="3" /><path d="M5 11h14M9 21l-2-4M15 21l2-4M9 14h.01M15 14h.01" /></svg>),
  info: () => (<svg width="19" height="19" viewBox="0 0 24 24" {...s}><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.01" /></svg>),
  layers: () => (<svg width="19" height="19" viewBox="0 0 24 24" {...s}><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></svg>),
  play: () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z" /></svg>),
  pause: () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4" height="15" rx="1" /><rect x="14" y="4.5" width="4" height="15" rx="1" /></svg>),
  rewind: () => (<svg width="16" height="16" viewBox="0 0 24 24" {...s}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></svg>),
  cursor: () => (<svg width="15" height="15" viewBox="0 0 24 24" {...s}><path d="M5 3l14 7-6 2-2 6z" /></svg>),
  block: () => (<svg width="15" height="15" viewBox="0 0 24 24" {...s}><path d="M12 3l9.5 17h-19z" /><path d="M12 10v4M12 17v.01" /></svg>),
  cross: () => (<svg width="15" height="15" viewBox="0 0 24 24" {...s}><path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z" /></svg>),
  fire: () => (<svg width="15" height="15" viewBox="0 0 24 24" {...s}><path d="M12 3c1 4 5 5.5 5 10a5 5 0 0 1-10 0c0-2.5 1.5-3.5 2-5 1 1.5 1.5 2 2.5 2C11 7.5 12 5 12 3z" /></svg>),
  close: () => (<svg width="15" height="15" viewBox="0 0 24 24" {...s}><path d="M6 6l12 12M18 6L6 18" /></svg>),
  send: () => (<svg width="16" height="16" viewBox="0 0 24 24" {...s}><path d="M4 12l16-8-6 16-2.5-6.5z" /></svg>),
  target: () => (<svg width="15" height="15" viewBox="0 0 24 24" {...s}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>),
  bolt: () => (<svg width="15" height="15" viewBox="0 0 24 24" {...s}><path d="M13 3L5 13h6l-1 8 8-10h-6z" /></svg>),
  storm: () => (<svg width="15" height="15" viewBox="0 0 24 24" {...s}><path d="M7 15a4 4 0 1 1 1-7.9A5 5 0 0 1 17.6 8 3.5 3.5 0 0 1 17 15" /><path d="M12 13l-2 4h3l-2 4" /></svg>),
}

export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32">
      <defs>
        <linearGradient id="lg" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stopColor="#22d3ee" /><stop offset="1" stopColor="#a78bfa" /></linearGradient>
      </defs>
      <circle cx="16" cy="16" r="13" fill="none" stroke="url(#lg)" strokeWidth="2" />
      <ellipse cx="16" cy="16" rx="13" ry="5" fill="none" stroke="url(#lg)" strokeWidth="1" opacity=".6" />
      <ellipse cx="16" cy="16" rx="5" ry="13" fill="none" stroke="url(#lg)" strokeWidth="1" opacity=".6" />
      <circle cx="16" cy="16" r="3.2" fill="#a78bfa" />
      <circle cx="16" cy="16" r="6" fill="none" stroke="#22d3ee" strokeWidth=".8" opacity=".8" />
    </svg>
  )
}
