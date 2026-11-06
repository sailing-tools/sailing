import { Vec, sub, add, mul, dot, norm, len, bearingOf } from './vec';
import {
  BoatCfg, Wind, LegSolution, Part, Rounding, Side, TackPair, solveLeg, startLineInfo, StartLineInfo, roundsCorrectly,
  laneParts, tackPair, twoTack,
} from './solve';

export type End = 'pin' | 'committee';
/** Where on the line a route starts: one of the ends, or the point where a layline crosses the line. */
export type StartAt = End | 'line';

export interface StartRoute {
  end: StartAt;
  /** The start point. */
  from: Vec;
  /** Metres along the line from the pin. */
  fromPinM: number;
  /** For a start on the line: the board whose layline crosses there. */
  onLayline?: Side;
  first: Side;
  /** 'laylines': two boards, tacking on the layline. 'lane': staying off the laylines. */
  plan: 'laylines' | 'lane';
  parts: Part[];
  /** Hours to the mark, including tack costs and an extra tack if it arrives on the wrong board for the rounding. */
  timeH: number;
  /** False when the last board turns the wrong way round the first mark. */
  roundsOk: boolean;
  /** Mark bearing (true) at the first tack, if there is one. */
  tackBearing?: number;
  /** Share of the sailing time spent within the margin of a layline, leaving out the final approach. */
  nearLayline: number;
  /** Share of the sailing time spent down-tide of the straight line from the start to the mark. Null in slack water. */
  downTide: number | null;
  /** nearLayline plus downTide, 0 (safe) to 2. */
  risk: number;
  /** True when the first board heads back behind the start line (below its extension). Never recommended. */
  belowLine: boolean;
}

export interface StartOptions { margin: number; maxTacks: number; allowanceSec: number }

export interface StartStrategy {
  line: StartLineInfo;
  kind: LegSolution['kind'];
  routes: StartRoute[];
  /** Seconds the pin end gains over the committee end (negative: committee gains). */
  gainS: { wind: number; tide: number; total: number };
  favoured: End | 'even';
  /** The quickest route, ignoring risk. */
  fastest: StartRoute | null;
  /** The safest route within the time allowance of the fastest. Within one tack of each other, starboard first wins. */
  best: StartRoute | null;
  /** Which side of the course is up-tide, as the board that takes you there, or null in slack water. */
  upTideSide: Side | null;
  options: StartOptions;
}

/** Final part of the beat (as a share of the time to go) where being on a layline is expected and not counted. */
const FINAL_APPROACH = 0.25;
const SAMPLES = 24;

/** How a route sits against the laylines and the tide, sampled along each board. */
function exposure(parts: Part[], start: Vec, mark: Vec, pair: TackPair, margin: number, tide: Vec) {
  const total = parts.reduce((t, p) => t + p.hours, 0);
  const t0 = twoTack(start, mark, pair.starboard.ground, pair.port.ground);
  const T0 = t0 ? t0.a + t0.b : total;
  const rhumb = norm(sub(mark, start));
  const across = { x: rhumb.y, y: -rhumb.x }; // to starboard of the rhumb line
  const tideAcross = dot(tide, across);
  const upSign = Math.abs(tideAcross) < 0.15 ? 0 : -Math.sign(tideAcross); // up-tide is against the cross-stream
  let near = 0, down = 0;
  for (const p of parts) {
    for (let k = 0; k < SAMPLES; k++) {
      const f = (k + 0.5) / SAMPLES;
      const q = add(p.start, mul(sub(p.end, p.start), f));
      const dt = p.hours / SAMPLES;
      const r = twoTack(q, mark, pair.starboard.ground, pair.port.ground);
      if (r) {
        const T = r.a + r.b;
        if (T > FINAL_APPROACH * T0 && Math.min(r.a, r.b) / T < margin) near += dt;
      }
      if (upSign !== 0) {
        const off = dot(sub(q, start), across);
        if (off * upSign < -0.05 * len(sub(mark, start))) down += dt; // more than 5% of the leg down-tide
      }
    }
  }
  return { nearLayline: total > 0 ? near / total : 0, downTide: upSign === 0 ? null : total > 0 ? down / total : 0, upSign, across };
}

/**
 * Which end of the line to start from, on which board, and how to sail the beat.
 * The gain of one end over the other is split into the part the wind gives (the line bias: the same
 * course sailed in slack water) and the part the tide adds on top.
 * Each end is tried on both first boards, tacking on the laylines and staying off them. Time alone
 * favours sailing to a layline, but shifts punish that, and the stream may change, so the recommendation
 * is the lowest-risk route within `allowanceSec` of the fastest. Risk is the share of the beat spent near
 * a layline (outside the final approach) plus the share spent down-tide of the line to the mark.
 */
export function startStrategy(
  committee: Vec, pin: Vec, mark: Vec, wind: Wind, tide: Vec, boat: BoatCfg, rounding?: Rounding,
  opts: Partial<StartOptions> = {},
): StartStrategy {
  const options: StartOptions = { margin: 0.2, maxTacks: 4, allowanceSec: 30, ...opts };
  const line = startLineInfo(committee, pin, wind);
  const penaltyH = boat.tackPenaltySec / 3600;
  const calm = { x: 0, y: 0 };
  const ends: Record<End, Vec> = { pin, committee };
  const legs = { pin: solveLeg(pin, mark, wind, tide, boat), committee: solveLeg(committee, mark, wind, tide, boat) };
  const still = { pin: solveLeg(pin, mark, wind, calm, boat), committee: solveLeg(committee, mark, wind, calm, boat) };
  const kind = legs.pin.kind;
  const routes: StartRoute[] = [];
  // Unit normal to the line, pointing to the course side (towards the mark).
  const lineN = (() => {
    const d = norm(sub(committee, pin));
    const n = { x: -d.y, y: d.x };
    return dot(n, sub(mark, mul(add(committee, pin), 0.5))) < 0 ? mul(n, -1) : n;
  })();
  const behind = (parts: Part[]) => parts.length > 0 && dot(norm(sub(parts[0].end, parts[0].start)), lineN) < -0.02;
  let upTideSide: Side | null = null;
  if (kind === 'beat' || kind === 'run') {
    const pair = tackPair(wind, tide, boat, kind === 'beat' ? 'up' : 'down');
    // Time to the mark is linear along the line while both boards are needed, so the quickest start is at an end
    // or where a layline crosses the line: from there one board lays the mark.
    const starts: { end: StartAt; from: Vec; u: number; onLayline?: Side }[] = [{ end: 'pin', from: pin, u: 0 }, { end: 'committee', from: committee, u: 1 }];
    const s0 = twoTack(pin, mark, pair.starboard.ground, pair.port.ground);
    const s1 = twoTack(committee, mark, pair.starboard.ground, pair.port.ground);
    if (s0 && s1) {
      for (const [side, v0, v1] of [['starboard', s0.b, s1.b], ['port', s0.a, s1.a]] as [Side, number, number][]) {
        if (v0 === v1) continue;
        const u = v0 / (v0 - v1);
        const q = add(pin, mul(sub(committee, pin), u));
        const t = twoTack(q, mark, pair.starboard.ground, pair.port.ground);
        if (u > 0.02 && u < 0.98 && t && t.a >= -1e-9 && t.b >= -1e-9) starts.push({ end: 'line', from: q, u, onLayline: side });
      }
    }
    const lineM = len(sub(committee, pin)) * 1852;
    for (const st of starts) {
      const { end, from } = st;
      const sol = twoTack(from, mark, pair.starboard.ground, pair.port.ground);
      const T = sol ? sol.a + sol.b : 0;
      const minBoard = Math.max(60 / 3600, 2 * penaltyH, 0.05 * T);
      const seen = new Set<string>();
      for (const first of ['starboard', 'port'] as Side[]) {
        for (const plan of ['laylines', 'lane'] as const) {
          const parts = plan === 'laylines'
            ? laneParts(from, mark, pair, first, 0, 1)
            : laneParts(from, mark, pair, first, options.margin, Math.max(2, options.maxTacks), minBoard);
          if (!parts || !parts.length) continue;
          const key = parts.map((p) => `${p.sail.tack[0]}${p.hours.toFixed(4)}`).join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          const last = parts[parts.length - 1];
          const roundsOk = !rounding || roundsCorrectly(last.sail.cog, rounding);
          const sailed = parts.reduce((t, p) => t + p.hours, 0) + Math.max(0, parts.length - 1) * penaltyH;
          const ex = exposure(parts, from, mark, pair, options.margin, tide);
          if (ex.upSign !== 0 && upTideSide === null) {
            // The board whose ground track heads up-tide (across the rhumb line against the stream).
            const sAcross = dot(pair.starboard.ground, ex.across) * ex.upSign;
            upTideSide = sAcross > 0 ? 'starboard' : 'port';
          }
          routes.push({
            end, from, fromPinM: st.u * lineM, onLayline: st.onLayline, first: parts[0].sail.tack, plan, parts, roundsOk,
            timeH: sailed + (roundsOk ? 0 : penaltyH),
            tackBearing: parts.length > 1 ? bearingOf(sub(mark, parts[0].end)) : undefined,
            nearLayline: ex.nearLayline, downTide: ex.downTide, risk: ex.nearLayline + (ex.downTide ?? 0),
            belowLine: behind(parts),
          });
        }
      }
    }
  } else {
    for (const end of ['pin', 'committee'] as End[]) {
      const l = legs[end];
      if (l.parts.length) routes.push({ end, from: ends[end], fromPinM: end === 'pin' ? 0 : len(sub(committee, pin)) * 1852, first: l.parts[0].sail.tack, plan: 'laylines', parts: l.parts, roundsOk: true, timeH: l.timeH, nearLayline: 0, downTide: null, risk: 0, belowLine: false });
    }
  }
  const fastestAt = (end: StartAt) => Math.min(...routes.filter((r) => r.end === end).map((r) => r.timeH), Infinity);
  const wind_ = (still.committee.timeH - still.pin.timeH) * 3600;
  const total = (fastestAt('committee') - fastestAt('pin')) * 3600;
  const ok = isFinite(total);
  const gainS = { wind: isFinite(wind_) ? wind_ : NaN, tide: ok && isFinite(wind_) ? total - wind_ : NaN, total: ok ? total : NaN };
  const favoured: StartStrategy['favoured'] = !ok || Math.abs(total) < 2 ? 'even' : total > 0 ? 'pin' : 'committee';
  const finite = routes.filter((r) => isFinite(r.timeH));
  const above = finite.filter((r) => !r.belowLine);
  const valid = above.length ? above : finite;
  const byTime = (a: StartRoute, b: StartRoute) => {
    if (Math.abs(a.timeH - b.timeH) * 3600 > 2) return a.timeH - b.timeH;
    if (a.end !== b.end && favoured !== 'even') return a.end === favoured ? -1 : 1;
    if (a.first !== b.first) return a.first === 'starboard' ? -1 : 1;
    return a.timeH - b.timeH;
  };
  const fastest = [...valid].sort(byTime)[0] ?? null;
  const within = fastest ? valid.filter((r) => (r.timeH - fastest.timeH) * 3600 <= options.allowanceSec + 1e-6) : [];
  // Starting on port means giving way to the starboard fleet, so a port-first edge of one tack or less isn't worth it.
  const pick = (a: StartRoute, b: StartRoute) => {
    if (Math.abs(a.risk - b.risk) > 0.05) return a.risk - b.risk;
    if (a.end === b.end && a.first !== b.first && Math.abs(a.timeH - b.timeH) <= penaltyH + 2 / 3600) return a.first === 'starboard' ? -1 : 1;
    return byTime(a, b);
  };
  const best = [...within].sort(pick)[0] ?? fastest;
  return { line, kind, routes, gainS, favoured, fastest, best, upTideSide, options };
}
