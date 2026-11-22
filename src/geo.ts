import { Vec, add, fromBearing } from './nav/vec';
import { toXY } from './course';

/**
 * Read a position typed by hand. Accepts decimal degrees ("50.7582, -1.2225"), degrees and decimal minutes
 * ("50 45.49N 1 13.35W", "50°45.49'N 001°13.35'W") and the same with hemisphere letters in front.
 * West and south are negative. Returns null if it can't be read.
 */
export function parseLatLon(text: string): { lat: number; lon: number } | null {
  const t = text.trim().toUpperCase().replace(/[°º'′"″,]/g, ' ').replace(/\s+/g, ' ');
  // Degrees + minutes with hemisphere letters.
  const dm = /^([NS])?\s*(\d{1,2})\s+(\d{1,2}(?:\.\d+)?)\s*([NS])?\s+([EW])?\s*(\d{1,3})\s+(\d{1,2}(?:\.\d+)?)\s*([EW])?$/.exec(t);
  if (dm) {
    const ns = dm[1] ?? dm[4], ew = dm[5] ?? dm[8];
    if (!ns || !ew) return null;
    const lat = (+dm[2] + +dm[3] / 60) * (ns === 'S' ? -1 : 1);
    const lon = (+dm[6] + +dm[7] / 60) * (ew === 'W' ? -1 : 1);
    return valid(lat, lon);
  }
  // Decimal degrees, signed or with letters.
  const dd = /^([NS])?\s*(-?\d{1,2}(?:\.\d+)?)\s*([NS])?\s+([EW])?\s*(-?\d{1,3}(?:\.\d+)?)\s*([EW])?$/.exec(t);
  if (dd) {
    let lat = +dd[2], lon = +dd[5];
    if ((dd[1] ?? dd[3]) === 'S') lat = -Math.abs(lat);
    if ((dd[4] ?? dd[6]) === 'W') lon = -Math.abs(lon);
    return valid(lat, lon);
  }
  return null;
}

const valid = (lat: number, lon: number) => (Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null);

export const latLonToXY = (p: { lat: number; lon: number }): Vec => toXY(p.lon, p.lat);

/** The point `metres` from `from` on a true bearing. */
export const offset = (from: Vec, bearingT: number, metres: number): Vec => add(from, fromBearing(bearingT, metres / 1852));

/** Ask the phone for a GPS fix. Resolves with the position on the chart and its accuracy in metres. */
export function gpsFix(): Promise<{ pos: Vec; accuracyM: number; lat: number; lon: number }> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) { reject(new Error('This device has no GPS access in the browser.')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ pos: toXY(p.coords.longitude, p.coords.latitude), accuracyM: p.coords.accuracy, lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) => reject(new Error(e.code === 1 ? 'Location permission was refused. Allow location for this site and try again.' : 'Could not get a GPS fix. Try again in the open.')),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  });
}
