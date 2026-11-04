import { demandProfile } from './timeofday'
import type { CityData, TransitLineData } from './types'

/**
 * Rail transit (metro, light rail, tram) as a timetabled system.
 *
 * Train positions are a pure function of the clock: each line runs a daily
 * timetable whose headway depends on the time of day and on the service level
 * (1 = normal, 0.5 = half the trains, 0 = suspended). Running time between
 * stations uses an acceleration / cruise / braking profile plus a dwell time.
 * Being stateless, it is deterministic and free for the Time Machine.
 */

export interface Train {
  line: number
  dir: 0 | 1
  /** arc length along the line (m) */
  s: number
  atStation: boolean
}

interface ModeSpec {
  cruise: number
  accel: number
  dwell: number
  capacity: number
  cars: number
  carLength: number
  /** headway (s) by period: peak, day, shoulder */
  headway: [number, number, number]
}

export const MODES: Record<TransitLineData['mode'], ModeSpec> = {
  metro: { cruise: 19, accel: 1.0, dwell: 28, capacity: 1150, cars: 3, carLength: 21, headway: [210, 330, 480] },
  rail: { cruise: 22, accel: 0.8, dwell: 35, capacity: 900, cars: 4, carLength: 22, headway: [420, 600, 900] },
  tram: { cruise: 8.5, accel: 0.9, dwell: 20, capacity: 300, cars: 2, carLength: 17, headway: [300, 420, 600] },
}

export const SERVICE_START = 4.5 * 3600
export const SERVICE_END = 23 * 3600

export function headwayAt(mode: TransitLineData['mode'], secOfDay: number, level: number): number {
  if (level <= 0.001) return Infinity
  const h = secOfDay / 3600
  const spec = MODES[mode].headway
  const base = (h >= 6 && h < 9) || (h >= 17 && h < 20) ? spec[0] : h >= 9 && h < 17 ? spec[1] : spec[2]
  return base / Math.min(1, level)
}

/** travel time to cover distance d starting and ending at rest (trapezoidal speed profile) */
function hop(d: number, v: number, a: number) {
  const dAccel = (v * v) / a
  return d >= dAccel ? d / v + v / a : 2 * Math.sqrt(d / a)
}

/** distance covered after time τ within a hop of length d (inverse of hop) */
function hopDistance(tau: number, d: number, v: number, a: number) {
  const T = hop(d, v, a)
  const tau2 = Math.min(Math.max(0, tau), T)
  const tAcc = Math.min(v / a, T / 2)
  const vMax = a * tAcc
  if (tau2 <= tAcc) return 0.5 * a * tau2 * tau2
  const cruise = T - 2 * tAcc
  const dAcc = 0.5 * a * tAcc * tAcc
  if (tau2 <= tAcc + cruise) return dAcc + vMax * (tau2 - tAcc)
  const tb = tau2 - tAcc - cruise
  return d - 0.5 * a * (tAcc - tb) * (tAcc - tb)
}

export class TransitSystem {
  readonly lines: (TransitLineData & { cum: number[]; stopS: number[]; runtime: number; share: number; legs: { from: number; to: number; t0: number; t1: number; dwellEnd: number }[] })[]
  /** mapped lines that are not in service yet (rendered as works in progress) */
  readonly planned: TransitLineData[]
  /** departures (seconds of day) per line and direction */
  private timetable: number[][][] = []

  constructor(data: CityData, private level = 1) {
    const all = data.transit?.lines ?? []
    this.planned = all.filter((l) => l.status === 'construction')
    const open = all.filter((l) => l.status !== 'construction')
    // services sharing the same track (NYC 2/3, A/C, N/R/W…) split the trunk's frequency
    const signature = (l: TransitLineData) => `${Math.round(l.len / 20)}:${Math.round(l.pts[0][0] / 25)},${Math.round(l.pts[0][1] / 25)}`
    const sharing = new Map<string, number>()
    for (const l of open) sharing.set(signature(l), (sharing.get(signature(l)) ?? 0) + 1)
    this.lines = open.map((l) => {
      const cum = [0]
      for (let i = 1; i < l.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(l.pts[i][0] - l.pts[i - 1][0], l.pts[i][1] - l.pts[i - 1][1]))
      const len = cum[cum.length - 1]
      // trains enter the twin at s=0, serve every station, and leave at s=len
      const stopS = [0, ...l.stations.map((s) => Math.min(len, Math.max(0, s.s))), len]
      const spec = MODES[l.mode]
      const legs: { from: number; to: number; t0: number; t1: number; dwellEnd: number }[] = []
      let t = 0
      for (let i = 0; i < stopS.length - 1; i++) {
        const d = stopS[i + 1] - stopS[i]
        const travel = d > 0.5 ? hop(d, spec.cruise, spec.accel) : 0
        const isStation = i + 1 < stopS.length - 1
        legs.push({ from: stopS[i], to: stopS[i + 1], t0: t, t1: t + travel, dwellEnd: t + travel + (isStation ? spec.dwell : 0) })
        t += travel + (isStation ? spec.dwell : 0)
      }
      return { ...l, cum, stopS, runtime: t, legs, share: sharing.get(signature(l)) ?? 1 }
    })
    this.buildTimetable(level)
  }

  buildTimetable(level: number) {
    this.level = level
    this.timetable = this.lines.map((l, li) => [0, 1].map((dir) => {
      const deps: number[] = []
      // stagger directions and lines so trains do not move in lock-step
      let t = SERVICE_START + ((li * 97 + dir * 131) % 180)
      while (t < SERVICE_END) {
        deps.push(t)
        t += headwayAt(l.mode, t, Math.max(level, 0.001)) * l.share
      }
      return deps
    }))
  }

  get serviceLevel() {
    return this.level
  }

  /** where every train is at second-of-day `sec` (a frozen clock while service is suspended) */
  trains(sec: number): Train[] {
    const out: Train[] = []
    const day = ((sec % 86400) + 86400) % 86400
    this.lines.forEach((l, li) => {
      for (const dir of [0, 1] as const) {
        for (const dep of this.timetable[li][dir]) {
          const tau = day - dep
          if (tau < 0) break
          if (tau > l.runtime) continue
          const leg = l.legs.find((g) => tau < g.dwellEnd) ?? l.legs[l.legs.length - 1]
          const spec = MODES[l.mode]
          let s: number
          let atStation = false
          if (tau >= leg.t1) {
            s = leg.to
            atStation = true
          } else s = leg.from + hopDistance(tau - leg.t0, leg.to - leg.from, spec.cruise, spec.accel)
          out.push({ line: li, dir, s: dir === 0 ? s : l.len - s, atStation })
        }
      }
    })
    return out
  }

  /** riders per hour across all lines at second-of-day `sec` */
  ridersPerHour(sec: number) {
    if (this.level <= 0.001) return 0
    const h = (((sec % 86400) + 86400) % 86400) / 3600
    if (h * 3600 < SERVICE_START || h * 3600 > SERVICE_END) return 0
    const load = 0.18 + 0.72 * demandProfile(h)
    return this.lines.reduce((acc, l) => acc + (2 * 3600 / (headwayAt(l.mode, h * 3600, this.level) * l.share)) * MODES[l.mode].capacity * load, 0)
  }

  /** point on a line at arc length s, lateral offset for direction, returns [x, y, z, heading] */
  posAt(li: number, s: number, offset = 0): [number, number, number, number] {
    const l = this.lines[li]
    const { cum, pts } = l
    s = Math.max(0, Math.min(l.len, s))
    let lo = 0
    let hi = cum.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (cum[mid] <= s) lo = mid
      else hi = mid
    }
    const seg = cum[hi] - cum[lo] || 1
    const t = (s - cum[lo]) / seg
    const a = pts[lo]
    const b = pts[hi]
    const dx = (b[0] - a[0]) / seg
    const dz = (b[1] - a[1]) / seg
    const elev = a[2] + (b[2] - a[2]) * t
    return [a[0] + (b[0] - a[0]) * t - dz * offset, elev, a[1] + (b[1] - a[1]) * t + dx * offset, Math.atan2(dz, dx)]
  }
}
