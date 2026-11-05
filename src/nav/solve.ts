import { Polar, polarSpeed, optimalAngles } from './polar';
import {
  Vec, add, sub, mul, dot, len, norm, cross, fromBearing, bearingOf, norm180, norm360, D2R,
} from './vec';

export interface Conditions {
  windFrom: number; // degrees true, where the wind comes FROM
  windKn: number;
  windRef: 'ground' | 'water';
  tideTo: number; // degrees true, where the stream flows TO
  tideKn: number;
}

export interface BoatCfg {
  polar: Polar;
  leewayDeg: number;
  tackPenaltySec: number;
}

export interface Wind { from: number; kn: number }

export interface WindPair { ground: Wind; water: Wind; tide: Vec }

/** Wind over the ground and over the water. The boat's polar uses the water wind. */
export function resolveWind(c: Conditions): WindPair {
  const tide = fromBearing(c.tideTo, c.tideKn);
  const given = fromBearing(c.windFrom + 180, c.windKn); // air velocity
  const g = c.windRef === 'ground' ? given : add(given, tide);
  const w = c.windRef === 'ground' ? sub(given, tide) : given;
  const toWind = (v: Vec, fallback: number): Wind =>
    len(v) < 1e-6 ? { from: fallback, kn: 0 } : { from: norm360(bearingOf(v) + 180), kn: len(v) };
  return { ground: toWind(g, c.windFrom), water: toWind(w, c.windFrom), tide };
}

export interface Sailing {
  heading: number; // course to steer (CTW), degrees true
  waterTrack: number; // track through the water after leeway
  twa: number; // signed: + wind from starboard, - wind from port
  stw: number;
  water: Vec; // velocity through water, knots
  ground: Vec; // velocity over ground, knots
  cog: number;
  sog: number;
  tack: 'starboard' | 'port';
}

function leewayFor(twaAbs: number, leeway: number) {
  return twaAbs < 90 ? leeway * Math.cos(twaAbs * D2R) : 0;
}

/** Sail on a given heading. */
export function sailHeading(heading: number, wind: Wind, tide: Vec, boat: BoatCfg): Sailing {
  const twa = norm180(wind.from - heading);
  const side = twa >= 0 ? 1 : -1;
  const waterTrack = norm360(heading - side * leewayFor(Math.abs(twa), boat.leewayDeg));
  const stw = polarSpeed(boat.polar, twa, wind.kn);
  const water = fromBearing(waterTrack, stw);
  const ground = add(water, tide);
  return {
    heading: norm360(heading), waterTrack, twa, stw, water, ground,
    cog: bearingOf(ground), sog: len(ground), tack: side > 0 ? 'starboard' : 'port',
  };
}

/** Sail along a given water track (heading is derived by adding leeway back). */
function sailWaterTrack(track: number, wind: Wind, tide: Vec, boat: BoatCfg): Sailing {
  let heading = track;
  for (let i = 0; i < 3; i++) {
    const twa = norm180(wind.from - heading);
    const side = twa >= 0 ? 1 : -1;
    heading = track + side * leewayFor(Math.abs(twa), boat.leewayDeg);
  }
  return sailHeading(heading, wind, tide, boat);
}

export interface ReachSolution extends Sailing { feasible: boolean; timeH: number; reason?: string }

/**
 * Course to steer to make good the straight track from A to B:
 * sin(delta) = -Tc / STW, CTW = track + delta, SOG = STW cos(delta) + Ta.
 * STW depends on TWA, which depends on CTW, so iterate.
 */
export function solveReach(a: Vec, b: Vec, wind: Wind, tide: Vec, boat: BoatCfg): ReachSolution {
  const d = sub(b, a);
  const dist = len(d);
  const u = norm(d);
  const n = { x: u.y, y: -u.x }; // 90 degrees to starboard of the track
  const track = bearingOf(d);
  const ta = dot(tide, u);
  const tc = dot(tide, n);
  let wt = track;
  let s = sailWaterTrack(wt, wind, tide, boat);
  let feasible = true;
  let reason: string | undefined;
  for (let i = 0; i < 10; i++) {
    if (s.stw < 0.05) { feasible = false; reason = 'No boat speed at this angle'; break; }
    const r = -tc / s.stw;
    if (Math.abs(r) > 1) { feasible = false; reason = 'Tide too strong to hold this track'; break; }
    const next = track + Math.asin(r) / D2R;
    s = sailWaterTrack(next, wind, tide, boat);
    if (Math.abs(norm180(next - wt)) < 0.01) { wt = next; break; }
    wt = next;
  }
  const made = dot(s.ground, u);
  if (feasible && made <= 0.01) { feasible = false; reason = 'Tide sets you away from the mark'; }
  void ta;
  return { ...s, feasible, reason, timeH: feasible && dist > 0 ? dist / made : Infinity };
}

export interface TackPair { mode: 'up' | 'down'; twa: number; starboard: Sailing; port: Sailing }

/** Both tacks (or gybes) at the optimum VMG angle in the water wind. */
export function tackPair(wind: Wind, tide: Vec, boat: BoatCfg, mode: 'up' | 'down'): TackPair {
  const opt = optimalAngles(boat.polar, wind.kn)[mode];
  return {
    mode,
    twa: opt.twa,
    starboard: sailHeading(wind.from - opt.twa, wind, tide, boat),
    port: sailHeading(wind.from + opt.twa, wind, tide, boat),
  };
}

/** Hours on each of two ground vectors to get from P to M: a*Gs + b*Gp = M - P. */
export function twoTack(p: Vec, m: Vec, gs: Vec, gp: Vec) {
  const d = sub(m, p);
  const det = cross(gs, gp);
  if (Math.abs(det) < 1e-9) return null;
  return { a: cross(d, gp) / det, b: cross(gs, d) / det };
}

export type LegKind = 'beat' | 'run' | 'reach' | 'blocked';

export interface LegSolution {
  kind: LegKind;
  from: Vec;
  to: Vec;
  dist: number;
  bearing: number;
  timeH: number;
  /** Boat states in the order sailed. */
  parts: { sail: Sailing; hours: number; start: Vec; end: Vec }[];
  /** The same leg sailed with the other board first (beats and runs with two boards). */
  altParts?: { sail: Sailing; hours: number; start: Vec; end: Vec }[];
  pair?: TackPair;
  laylines?: { starboard: Vec; port: Vec }; // unit directions FROM the mark, back along -ground
  reach: ReachSolution;
  note?: string;
}

export function solveLeg(from: Vec, to: Vec, wind: Wind, tide: Vec, boat: BoatCfg): LegSolution {
  const d = sub(to, from);
  const dist = len(d);
  const bearing = bearingOf(d);
  const reach = solveReach(from, to, wind, tide, boat);
  const base = { from, to, dist, bearing, reach };
  if (dist < 1e-6) return { ...base, kind: 'reach', timeH: 0, parts: [] };

  const opt = optimalAngles(boat.polar, wind.kn);
  const absTwa = Math.abs(reach.twa);
  let mode: 'up' | 'down' | null = null;
  if (!reach.feasible || absTwa < opt.up.twa) {
    // Too close to the wind, or tide stops a straight course: try tacking (or gybing if it's behind us).
    mode = Math.abs(norm180(wind.from - bearing)) <= 90 ? 'up' : 'down';
  } else if (absTwa > opt.down.twa) mode = 'down';

  if (mode) {
    const pair = tackPair(wind, tide, boat, mode);
    const sol = twoTack(from, to, pair.starboard.ground, pair.port.ground);
    const laylines = { starboard: norm(mul(pair.starboard.ground, -1)), port: norm(mul(pair.port.ground, -1)) };
    if (sol && sol.a >= -1e-9 && sol.b >= -1e-9) {
      const legs = [
        { sail: pair.starboard, hours: Math.max(0, sol.a) },
        { sail: pair.port, hours: Math.max(0, sol.b) },
      ].sort((x, y) => y.hours - x.hours); // longer board first
      const build = (order: typeof legs) => {
        const out: LegSolution['parts'] = [];
        let p = from;
        for (const l of order) {
          if (l.hours < 1e-6) continue;
          const end = add(p, mul(l.sail.ground, l.hours));
          out.push({ ...l, start: p, end });
          p = end;
        }
        return out;
      };
      const parts = build(legs);
      const altParts = parts.length > 1 ? build([...legs].reverse()) : undefined;
      const turns = Math.max(0, parts.length - 1);
      return {
        ...base, kind: mode === 'up' ? 'beat' : 'run', pair, laylines, parts, altParts,
        timeH: sol.a + sol.b + (turns * boat.tackPenaltySec) / 3600,
      };
    }
    if (!reach.feasible) {
      return { ...base, kind: 'blocked', pair, laylines, parts: [], timeH: Infinity, note: reach.reason };
    }
    // One tack lays the mark: sail it as a tight reach.
    return {
      ...base, kind: 'reach', parts: [{ sail: reach, hours: reach.timeH, start: from, end: to }],
      timeH: reach.timeH, pair, laylines, note: 'Laid on one tack',
    };
  }
  return {
    ...base, kind: 'reach', parts: [{ sail: reach, hours: reach.timeH, start: from, end: to }],
    timeH: reach.timeH,
  };
}

export interface StartLineInfo {
  bias: number; // degrees, + means pin end is upwind
  favoured: 'pin' | 'committee' | 'square';
  advantageM: number; // metres upwind of the other end
  lengthM: number;
}

export function startLineInfo(committee: Vec, pin: Vec, wind: Wind): StartLineInfo {
  const line = sub(pin, committee);
  const square = wind.from - 90; // committee to pin bearing for a square line
  const bias = norm180(bearingOf(line) - square);
  const adv = dot(line, fromBearing(wind.from, 1)) * 1852;
  const favoured = Math.abs(adv) < 2 ? 'square' : adv > 0 ? 'pin' : 'committee';
  return { bias, favoured, advantageM: Math.abs(adv), lengthM: len(line) * 1852 };
}
