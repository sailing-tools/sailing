import { SOLENT_MARKS, RacingMark } from './data/solentMarks';
import { toXY } from './course';
import { newId, Mark } from './store';

const COLOURS: Record<string, string> = { R: 'red', G: 'green', Y: 'yellow', B: 'black', W: 'white' };
/** "YBY" -> "yellow-black-yellow". */
export const colourName = (c: string) => c.split('').map((x) => COLOURS[x] ?? x).join('-');

/** 50.77N 1.31W -> "50°46.22'N 1°18.84'W" */
export function fmtLatLon(lat: number, lon: number) {
  const f = (v: number, p: string, n: string) => { const a = Math.abs(v), d = Math.floor(a); return `${d}°${((a - d) * 60).toFixed(2).padStart(5, '0')}'${v >= 0 ? p : n}`; };
  return `${f(lat, 'N', 'S')} ${f(lon, 'E', 'W')}`;
}

/** Match a typed code ("3U"), "code name" (as the picker lists them) or a name, ignoring case. */
export function findSolentMark(q: string): RacingMark | undefined {
  const t = q.trim().toLowerCase();
  if (!t) return undefined;
  const code = t.split(/\s+/)[0];
  return SOLENT_MARKS.find((m) => m.code.toLowerCase() === t || `${m.code} ${m.name}`.toLowerCase() === t)
    ?? SOLENT_MARKS.find((m) => m.name.toLowerCase() === t)
    ?? (t.length >= 3 ? SOLENT_MARKS.find((m) => m.name.toLowerCase().startsWith(t)) : undefined)
    ?? (code.length <= 2 && t === code ? SOLENT_MARKS.find((m) => m.code.toLowerCase() === code) : undefined);
}

export const solentPos = (m: RacingMark) => toXY(m.lon, m.lat);
export const solentToMark = (m: RacingMark): Mark => ({ id: newId(), name: `${m.code} ${m.name}`, pos: solentPos(m), code: m.code, rounding: 'port' });
