import type { CityData } from './types'

/** Per-city knowledge the engine cannot infer from OSM alone: which avenues matter, where
 *  emergencies make a good story, and the copilot's example prompts. */
export interface CityConfig {
  id: string
  name: string
  country: string
  area: string
  lat: number
  lon: number
  /** main arterials, most important first (names as they appear in OpenStreetMap) */
  arterials: { name: string; lat?: number; lon?: number }[]
  /** places for scripted emergencies */
  spots: { label: string; lat: number; lon: number }[]
  blurb: string
}

export const CITIES: CityConfig[] = [
  {
    id: 'medellin', name: 'Medellín', country: 'Colombia', area: 'Centro · La Candelaria', lat: 6.25, lon: -75.569,
    arterials: [
      { name: 'Avenida Oriental', lat: 6.2514, lon: -75.5649 },
      { name: 'Avenida del Ferrocarril' },
      { name: 'Avenida Calle 37' },
    ],
    spots: [
      { label: 'Parque Berrío', lat: 6.2502, lon: -75.5683 },
      { label: 'San Benito', lat: 6.2556, lon: -75.5725 },
    ],
    blurb: 'Metro lines A and B on a viaduct, the Ayacucho tramway and the city’s busiest downtown arterials.',
  },
  {
    id: 'bogota', name: 'Bogotá', country: 'Colombia', area: 'Centro · La Candelaria · Santa Fe', lat: 4.604, lon: -74.075,
    arterials: [
      { name: 'Avenida Carrera 10', lat: 4.6069, lon: -74.0737 },
      { name: 'Avenida Calle 19' },
      { name: 'Avenida Calle 26' },
    ],
    spots: [
      { label: 'Plaza de Bolívar', lat: 4.5981, lon: -74.076 },
      { label: 'Parque Santander', lat: 4.6025, lon: -74.0727 },
    ],
    blurb: 'The historic centre at 2,600 m: dense colonial grid, Avenida Carrera 10 and the Calle 26 corridor.',
  },
  {
    id: 'newyork', name: 'New York', country: 'United States', area: 'Lower Manhattan', lat: 40.713, lon: -74.006,
    arterials: [
      { name: 'West Street', lat: 40.7115, lon: -74.0135 },
      { name: 'Broadway' },
      { name: 'Canal Street' },
    ],
    spots: [
      { label: 'City Hall', lat: 40.7127, lon: -74.0059 },
      { label: 'Wall Street', lat: 40.706, lon: -74.009 },
    ],
    blurb: 'Skyscrapers with mapped heights, a dense subway network underground and the West Street corridor.',
  },
]

export const cityById = (id: string) => CITIES.find((c) => c.id === id) ?? CITIES[0]

/** WGS84 → the dataset's local metric plane (same projection as the Python pipeline). */
export function toLocal(data: CityData, lat: number, lon: number): [number, number] {
  const { lat: lat0, lon: lon0 } = data.meta.center
  const mLon = 111_320 * Math.cos((lat0 * Math.PI) / 180)
  return [(lon - lon0) * mLon, -(lat - lat0) * 110_574]
}
