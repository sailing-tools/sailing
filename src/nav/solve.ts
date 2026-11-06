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
  /** Your own upwind TWA (degrees off the true wind on the water). Null or absent uses the polar's best VMG angle. */
  upTwa?: number | null;
}

/** Upwind and downwind sailing angles: the polar's VMG optimum, unless the boat sets its own upwind TWA. */
export function sailingAngles(boat: BoatCfg, tws: number) {
  const opt = optimalAngles(boat.polar, tws);
  if (boat.upTwa == null) return opt;
  const twa = Math.min(70, Math.max(25, boat.upTwa));
  const stw = polarSpeed(boat.polar, twa, tws);
  return { ...opt, up: { twa, stw, vmg: stw * Math.cos(twa * D2R) } };
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
  const opt = sailingAngles(boat, wind.kn)[mode];
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

/**
 * How to sail a beat or run.
 * 'laylines': two boards, tacking on the layline.
 * 'lane': stay inside two "inner laylines" set `margin` of the way in from each real layline,
 * tacking each time you reach one, for at most `maxTacks` tacks in all. The last tack is on the real layline.
 */
export interface Strategy { mode: 'laylines' | 'lane'; margin: number; maxTacks: number }

export const LAYLINE_STRATEGY: Strategy = { mode: 'laylines', margin: 0.25, maxTacks: 1 };

/**
 * Bearings of the mark that tell you when to tack, as seen from the boat.
 * With tide the mark bears the other board's CoG at the moment you reach its layline, because from
 * there the other board's ground track runs straight to the mark. Every point on an inner layline
 * also sees the mark on one fixed bearing, so the lane gives a constant bearing to tack on too.
 * `margin` 0 gives the real laylines. Fraction m in from the layline means the remaining time is split
 * m on the board you are on and 1 - m on the other.
 */
export function tackBearings(gs: Vec, gp: Vec, margin = 0) {
  const m = Math.min(0.49, Math.max(0, margin));
  return {
    /** On starboard, tack when the mark bears this. */
    starboard: bearingOf(add(mul(gs, m), mul(gp, 1 - m))),
    /** On port, tack when the mark bears this. */
    port: bearingOf(add(mul(gs, 1 - m), mul(gp, m))),
  };
}

export type Part = { sail: Sailing; hours: number; start: Vec; end: Vec };

/**
 * Zig-zag from P to M between the inner laylines. In time coordinates (a, b) with M - P = a*Gs + b*Gp,
 * the real laylines are a = 0 and b = 0, and the inner laylines are a = m(a + b) and b = m(a + b).
 * Starboard only reduces a and port only reduces b, so each board runs to the opposite inner layline.
 * When the tack budget is spent, or the next board would be shorter than `minBoardH` (or leave less than
 * two such boards to the mark), the boat carries on to the real layline and makes its final tack there.
 */
export function laneParts(
  from: Vec, to: Vec, pair: TackPair, first: 'starboard' | 'port', margin: number, maxTacks: number, minBoardH = 0,
): Part[] | null {
  const sol = twoTack(from, to, pair.starboard.ground, pair.port.ground);
  if (!sol || sol.a < -1e-9 || sol.b < -1e-9) return null;
  const m = Math.min(0.45, Math.max(0, margin));
  let a = Math.max(0, sol.a), b = Math.max(0, sol.b);
  let cur = first;
  let p = from;
  const out: Part[] = [];
  const sail = (side: 'starboard' | 'port', hours: number) => {
    if (hours < 1e-9) return;
    const s = side === 'starboard' ? pair.starboard : pair.port;
    const end = add(p, mul(s.ground, hours));
    out.push({ sail: s, hours, start: p, end });
    p = end;
    if (side === 'starboard') a -= hours; else b -= hours;
  };
  const budget = Math.max(1, Math.round(maxTacks));
  let flipped = false;
  // Each lane board ends in a tack; the final tack onto the real layline makes up the budget.
  while (out.length < budget - 1 && m > 0) {
    // Hours on this board until the opposite inner layline.
    const t = cur === 'starboard' ? a - (m * b) / (1 - m) : b - (m * a) / (1 - m);
    if (t <= 1e-9) {
      if (out.length === 0 && !flipped) { flipped = true; cur = cur === 'starboard' ? 'port' : 'starboard'; continue; } // start outside the lane
      break;
    }
    // Skip boards too short to be worth a tack, and leave room for a real final approach.
    if (t < minBoardH || a + b - t < 2 * minBoardH) break;
    sail(cur, t);
    cur = cur === 'starboard' ? 'port' : 'starboard';
  }
  // Final approach: carry on to the real layline, tack, and lay the mark.
  sail(cur, cur === 'starboard' ? a : b);
  sail(cur === 'starboard' ? 'port' : 'starboard', cur === 'starboard' ? b : a);
  if (out.length) out[out.length - 1].end = to; // remove rounding drift
  return out;
}

export interface LegSolution {
  kind: LegKind;
  from: Vec;
  to: Vec;
  dist: number;
  bearing: number;
  timeH: number;
  /** Boat states in the order sailed. */
  parts: Part[];
  /** The same leg sailed with the other board first (beats and runs with two boards). */
  altParts?: Part[];
  pair?: TackPair;
  laylines?: { starboard: Vec; port: Vec }; // unit directions FROM the mark, back along -ground
  /** Mark bearing (true, from the boat) at which to tack onto the layline, for each board you might be on. */
  tackBearings?: { starboard: number; port: number };
  /** Lane strategy only: unit directions FROM the mark along the inner laylines, and their tack bearings. */
  lane?: { starboard: Vec; port: Vec; bearings: { starboard: number; port: number }; margin: number };
  reach: ReachSolution;
  note?: string;
}

export function solveLeg(from: Vec, to: Vec, wind: Wind, tide: Vec, boat: BoatCfg, strategy: Strategy = LAYLINE_STRATEGY): LegSolution {
  const d = sub(to, from);
  const dist = len(d);
  const bearing = bearingOf(d);
  const reach = solveReach(from, to, wind, tide, boat);
  const base = { from, to, dist, bearing, reach };
  if (dist < 1e-6) return { ...base, kind: 'reach', timeH: 0, parts: [] };

  const opt = sailingAngles(boat, wind.kn);
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
    const tb = tackBearings(pair.starboard.ground, pair.port.ground);
    const useLane = strategy.mode === 'lane' && strategy.maxTacks > 1 && strategy.margin > 0;
    let lane: LegSolution['lane'];
    if (useLane) {
      const bearings = tackBearings(pair.starboard.ground, pair.port.ground, strategy.margin);
      // The starboard-side inner layline is where a port-tack boat tacks onto starboard, and vice versa.
      lane = { starboard: fromBearing(bearings.port + 180), port: fromBearing(bearings.starboard + 180), bearings, margin: strategy.margin };
    }
    if (sol && sol.a >= -1e-9 && sol.b >= -1e-9 && useLane) {
      // A lane board must be at least a minute, twice the tack cost and 5% of the leg.
      const minBoard = Math.max(60 / 3600, (2 * boat.tackPenaltySec) / 3600, 0.05 * (sol.a + sol.b));
      const firstSide = sol.a >= sol.b ? 'starboard' : 'port';
      const otherSide = firstSide === 'starboard' ? 'port' : 'starboard';
      const parts = laneParts(from, to, pair, firstSide, strategy.margin, strategy.maxTacks, minBoard) ?? [];
      const alt = laneParts(from, to, pair, otherSide, strategy.margin, strategy.maxTacks, minBoard) ?? [];
      const altParts = alt.length > 1 && (alt[0].sail.tack !== parts[0]?.sail.tack) ? alt : undefined;
      const turns = Math.max(0, parts.length - 1);
      return {
        ...base, kind: mode === 'up' ? 'beat' : 'run', pair, laylines, tackBearings: tb, lane, parts, altParts,
        timeH: sol.a + sol.b + (turns * boat.tackPenaltySec) / 3600,
      };
    }
    if (sol && sol.a >= -1e-9 && sol.b >= -1e-9) {
      const legs = [
        { sail: pair.starboard, hours: Math.max(0, sol.a) },
        { sail: pair.port, hours: Math.max(0, sol.b) },
      ].sort((x, y) => y.hours - x.hours); // longer board first
      const build = (order: typeof legs) => {
        const out: Part[] = [];
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
        ...base, kind: mode === 'up' ? 'beat' : 'run', pair, laylines, tackBearings: tb, parts, altParts,
        timeH: sol.a + sol.b + (turns * boat.tackPenaltySec) / 3600,
      };
    }
    if (!reach.feasible) {
      return { ...base, kind: 'blocked', pair, laylines, tackBearings: tb, parts: [], timeH: Infinity, note: reach.reason };
    }
    // One tack lays the mark: sail it as a tight reach.
    return {
      ...base, kind: 'reach', parts: [{ sail: reach, hours: reach.timeH, start: from, end: to }],
      timeH: reach.timeH, pair, laylines, tackBearings: tb, note: 'Laid on one tack',
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
