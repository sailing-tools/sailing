import * as React from 'react';
import { AppState, useApp } from './store';
import { JEANNEAU_410, Polar } from './nav/polar';
import { resolveWind, solveLeg, startLineInfo, Rounding, BoatCfg, LegSolution, WindPair, StartLineInfo } from './nav/solve';
import { Vec, mid, sub, bearingOf } from './nav/vec';
import { startStrategy, StartStrategy } from './nav/start';
import land from './data/solent_land.json';

// Local plane origin: Cowes, Isle of Wight.
export const ORIGIN = { lat: 50.766, lon: -1.298 };
const COSLAT = Math.cos((ORIGIN.lat * Math.PI) / 180);

export const toXY = (lon: number, lat: number): Vec => ({ x: (lon - ORIGIN.lon) * 60 * COSLAT, y: (lat - ORIGIN.lat) * 60 });
export const toLonLat = (p: Vec) => ({ lon: ORIGIN.lon + p.x / (60 * COSLAT), lat: ORIGIN.lat + p.y / 60 });

/** Land as an SVG path in nm with y negated (so a plain scale+translate maps it to screen). */
export const LAND_PATH: string = (land as number[][][][])
  .map((poly) =>
    poly
      .map((ring) => 'M' + ring.map(([lon, lat]) => { const p = toXY(lon, lat); return `${p.x.toFixed(4)} ${(-p.y).toFixed(4)}`; }).join('L') + 'Z')
      .join(''),
  )
  .join('');

export interface CoursePoint { pos: Vec; label: string; markId?: string; rounding?: 'port' | 'starboard' }

export interface CourseModel {
  wind: WindPair;
  boat: BoatCfg;
  points: CoursePoint[];
  legs: LegSolution[];
  totalH: number;
  start: (StartLineInfo & { pinH: number; committeeH: number; pinLeg: LegSolution | null; committeeLeg: LegSolution | null }) | null;
  probeLeg: LegSolution | null;
  /** Start line strategy to the first mark (beats and runs). */
  startPlan: StartStrategy | null;
}

const scaled = new Map<string, { src: Polar; q: Polar }>();
/** The polar with every speed scaled by pct/100. The best angles don't change, only the speeds. */
export function scalePolar(p: Polar, pct: number): Polar {
  if (Math.abs(pct - 100) < 1e-9) return p;
  const key = `${p.id}@${pct}`;
  const hit = scaled.get(key);
  if (hit && hit.src === p) return hit.q;
  const q = { ...p, id: key, stw: p.stw.map((r) => r.map((v) => (v * pct) / 100)) };
  if (scaled.size > 50) scaled.clear();
  scaled.set(key, { src: p, q });
  return q;
}

export function computeCourse(s: Pick<AppState, 'cond' | 'leewayDeg' | 'speedPct' | 'tackPenaltySec' | 'upTwa' | 'strategy' | 'startAllowanceSec' | 'customPolar' | 'startLine' | 'marks' | 'finishAtStart' | 'probe' | 'selectedLeg'>): CourseModel {
  const wind = resolveWind(s.cond);
  const boat: BoatCfg = { polar: scalePolar(s.customPolar ?? JEANNEAU_410, s.speedPct ?? 100), leewayDeg: s.leewayDeg, tackPenaltySec: s.tackPenaltySec, upTwa: s.upTwa };
  const points: CoursePoint[] = [];
  if (s.startLine) points.push({ pos: mid(s.startLine.committee, s.startLine.pin), label: 'Start' });
  for (const m of s.marks) points.push({ pos: m.pos, label: m.name, markId: m.id, rounding: m.rounding ?? 'port' });
  if (s.startLine && s.finishAtStart && s.marks.length) points.push({ pos: mid(s.startLine.committee, s.startLine.pin), label: 'Finish' });
  // Rounding side of the point at index j, with the bearing of the leg after it.
  const roundAt = (j: number): Rounding | undefined => {
    const p = points[j], next = points[j + 1];
    if (!p?.rounding || !next) return undefined;
    return { side: p.rounding, nextBearing: bearingOf(sub(next.pos, p.pos)) };
  };
  let start: CourseModel['start'] = null;
  let startPlan: StartStrategy | null = null;
  if (s.startLine) {
    const info = startLineInfo(s.startLine.committee, s.startLine.pin, wind.water);
    const first = s.marks[0];
    const r1 = roundAt(points.findIndex((p) => p.markId === first?.id));
    const pinLeg = first ? solveLeg(s.startLine.pin, first.pos, wind.water, wind.tide, boat, undefined, r1) : null;
    const committeeLeg = first ? solveLeg(s.startLine.committee, first.pos, wind.water, wind.tide, boat, undefined, r1) : null;
    start = { ...info, pinH: pinLeg?.timeH ?? NaN, committeeH: committeeLeg?.timeH ?? NaN, pinLeg, committeeLeg };
    if (first) startPlan = startStrategy(s.startLine.committee, s.startLine.pin, first.pos, wind.water, wind.tide, boat, r1, {
      margin: s.strategy.margin, maxTacks: Math.max(2, s.strategy.maxTacks), allowanceSec: s.startAllowanceSec ?? 30,
    });
    // Leg 1 starts from the recommended end of the line, not the middle.
    const b = startPlan?.best;
    if (b && points[0]?.label === 'Start') points[0] = { pos: b.from, label: b.end === 'pin' ? 'Start (pin)' : b.end === 'committee' ? 'Start (committee)' : `Start (${Math.round(b.fromPinM)} m from pin)` };
  }
  const legs: LegSolution[] = [];
  for (let i = 0; i + 1 < points.length; i++) legs.push(solveLeg(points[i].pos, points[i + 1].pos, wind.water, wind.tide, boat, s.strategy, roundAt(i + 1)));
  // Leg 1 sails the recommended start route, so the chart, the legs table and the tacking table agree with Start strategy.
  const best = startPlan?.best;
  if (best && legs[0] && (legs[0].kind === 'beat' || legs[0].kind === 'run') && points[1]?.markId === s.marks[0]?.id) {
    const l0 = legs[0];
    legs[0] = { ...l0, parts: best.parts, altParts: undefined, timeH: best.timeH, rounding: l0.rounding ? { ...l0.rounding, ok: best.roundsOk } : undefined };
  }
  const totalH = legs.reduce((t, l) => t + l.timeH, 0);
  let probeLeg: LegSolution | null = null;
  if (s.probe && points.length > 1) {
    const ti = Math.min(s.selectedLeg + 1, points.length - 1);
    probeLeg = solveLeg(s.probe, points[ti].pos, wind.water, wind.tide, boat, s.strategy, roundAt(ti));
  }
  return { wind, boat, points, legs, totalH, start, probeLeg, startPlan };
}

export function useCourse(): CourseModel {
  const cond = useApp((s) => s.cond);
  const leewayDeg = useApp((s) => s.leewayDeg);
  const speedPct = useApp((s) => s.speedPct);
  const tackPenaltySec = useApp((s) => s.tackPenaltySec);
  const strategy = useApp((s) => s.strategy);
  const upTwa = useApp((s) => s.upTwa);
  const startAllowanceSec = useApp((s) => s.startAllowanceSec);
  const customPolar = useApp((s) => s.customPolar);
  const startLine = useApp((s) => s.startLine);
  const marks = useApp((s) => s.marks);
  const finishAtStart = useApp((s) => s.finishAtStart);
  const probe = useApp((s) => s.probe);
  const selectedLeg = useApp((s) => s.selectedLeg);
  return React.useMemo(
    () => computeCourse({ cond, leewayDeg, speedPct, tackPenaltySec, upTwa, strategy, startAllowanceSec, customPolar, startLine, marks, finishAtStart, probe, selectedLeg }),
    [cond, leewayDeg, speedPct, tackPenaltySec, upTwa, strategy, startAllowanceSec, customPolar, startLine, marks, finishAtStart, probe, selectedLeg],
  );
}

// Formatting helpers
export const fmtDeg = (d: number) => `${String(Math.round(((d % 360) + 360) % 360) % 360).padStart(3, '0')}°`;
export const fmtKn = (k: number) => `${k.toFixed(1)} kn`;
export const fmtTime = (h: number) => {
  if (!isFinite(h)) return '—';
  const totalS = Math.round(h * 3600);
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  if (m >= 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
};
export const fmtTwa = (t: number) => `${Math.round(Math.abs(t))}° ${t >= 0 ? 'S' : 'P'}`;
export const kindLabel: Record<string, string> = { beat: 'Beat', run: 'Run', reach: 'Reach', blocked: 'Blocked' };

/** Relative bearing of a true bearing off the bow on a heading, e.g. "83° off the port bow". */
export const offBowText = (brg: number, heading: number) => {
  const r = ((brg - heading) % 360 + 540) % 360 - 180;
  const a = Math.round(Math.abs(r));
  if (a <= 2) return 'dead ahead';
  return `${a}° off the ${r >= 0 ? 'starboard' : 'port'} bow`;
};

/** Plain-English description of board `j` of a leg and the tack at its end. */
export function tackNarrative(leg: LegSolution, j: number, markLabel: string, rounding?: 'port' | 'starboard'): string {
  const p = leg.parts[j];
  if (!p) return '';
  const word = leg.kind === 'run' ? 'gybe' : 'tack';
  const n = leg.parts.length;
  const board = `${p.sail.tack} ${leg.kind === 'run' ? 'gybe' : 'tack'}`;
  const sail = `steer ${fmtDeg(p.sail.heading)} (CoG ${fmtDeg(p.sail.cog)}, ${p.sail.sog.toFixed(1)} kn) for ${fmtTime(p.hours)}`;
  if (j === n - 1) {
    return `Board ${j + 1} of ${n}, the last: ${board}, ${sail} to lay ${markLabel}${rounding ? `, leaving it to ${rounding}` : ''}.`;
  }
  const next = leg.parts[j + 1];
  const brg = bearingOf(sub(leg.to, p.end));
  return `Board ${j + 1} of ${n}: ${board}, ${sail}. ${word[0].toUpperCase() + word.slice(1)} when ${markLabel} is ${offBowText(brg, p.sail.heading)} (bearing ${fmtDeg(brg)}T). Then ${next.sail.tack}, steer ${fmtDeg(next.sail.heading)} for ${fmtTime(next.hours)}.`;
}
