/**
 * Time-of-day model. Urban traffic follows a two-peak daily curve (morning commute,
 * evening commute, a lunchtime shoulder and a deep night trough). `demandProfile`
 * returns the share of the peak-hour vehicle count that is on the road at hour h.
 */

const bump = (h: number, centre: number, width: number) => Math.exp(-(((h - centre) / width) ** 2))

export function demandProfile(h: number): number {
  const x = ((h % 24) + 24) % 24
  return 0.1 + 0.9 * Math.max(bump(x, 7.4, 1.1), 0.94 * bump(x, 18.0, 1.4), 0.62 * bump(x, 12.8, 2.6))
}

/** 0 = night, 1 = full daylight, with dawn/dusk transitions (tropical latitudes: ~6:00 / ~18:30). */
export function daylight(h: number): number {
  const x = ((h % 24) + 24) % 24
  const smooth = (a: number, b: number, v: number) => Math.min(1, Math.max(0, (v - a) / (b - a)))
  return smooth(5.4, 6.8, x) * (1 - smooth(18.0, 19.2, x))
}

export type Period = 'night' | 'morning-peak' | 'day' | 'evening-peak' | 'evening'

export function periodOf(h: number): Period {
  const x = ((h % 24) + 24) % 24
  if (x < 5.5 || x >= 22) return 'night'
  if (x < 9.5) return 'morning-peak'
  if (x < 16.5) return 'day'
  if (x < 20) return 'evening-peak'
  return 'evening'
}

export const PERIOD_LABEL: Record<Period, string> = {
  night: 'Night', 'morning-peak': 'Morning peak', day: 'Daytime', 'evening-peak': 'Evening peak', evening: 'Evening',
}

export function hourAt(startHour: number, t: number) {
  return (((startHour + t / 3600) % 24) + 24) % 24
}
