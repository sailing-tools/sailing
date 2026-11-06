import { Vec, add, sub, mul, len, norm, cross, bearingOf, fromBearing, norm180, norm360 } from './vec';
import { Polar, polarSpeed } from './polar';

/** One GPS fix: seconds since the first fix, and position in nm on the local plane. */
export interface Fix { t: number; p: Vec }

export type BoardKind = 'starboard' | 'port' | 'downwind' | 'reach' | 'prestart';

export interface Board {
  /** Seconds from the first fix. */
  t0: number;
  t1: number;
  kind: BoardKind;
  /** Course and speed made good over the ground, from the board's end points. */
  cog: number;
  sog: number;
  from: Vec;
  to: Vec;
}

export interface TrackWind {
  /** True wind direction (from) on the water. */
  from: number;
  /** Tide set (towards) and rate. */
  tide: Vec;
  /** Upwind true wind angle the estimate assumes. */
  twa: number;
  /** Upwind speed through the water. */
  stw: number;
  /** True wind speed that gives that speed on the boat's polar, or null if out of range. */
  tws: number | null;
  /** Tacking angle over the ground, between the mean starboard and port ground tracks. */
  groundTack: number;
  /** Tacking angle through the water: 2 × twa. */
  waterTack: number;
  /** Mean ground velocities on each tack. */
  starboard: Vec;
  port: Vec;
}

export interface Overstand {
  /** Index of the board that went past the layline. */
  board: number;
  /** Seconds sailed past the layline. */
  seconds: number;
  /** Mark bearing (true) at the actual tack, and the layline bearing. */
  bearingAtTack: number;
  laylineBearing: number;
  markIndex: number;
}

export interface Shift { t: number; kind: 'starboard' | 'port'; from: number }

export interface TrackAnalysis {
  boards: Board[];
  wind: TrackWind | null;
  shifts: Shift[];
  overstands: Overstand[];
  durationS: number;
}

const KN = 3600; // nm/s to knots

/** Parse the track points of a GPX file. Returns lon/lat and Unix seconds, in time order. */
export function parseGpx(text: string): { lat: number; lon: number; t: number }[] {
  const out: { lat: number; lon: number; t: number }[] = [];
  const re = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const lat = /lat="([-\d.]+)"/.exec(m[1]);
    const lon = /lon="([-\d.]+)"/.exec(m[1]);
    const time = /<time>([^<]+)<\/time>/.exec(m[2]);
    if (!lat || !lon || !time) continue;
    const t = Date.parse(time[1]);
    if (!isFinite(t)) continue;
    out.push({ lat: +lat[1], lon: +lon[1], t: t / 1000 });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Resample to a fixed step by linear interpolation. */
export function resample(fixes: Fix[], step = 5): Fix[] {
  if (fixes.length < 2) return fixes.slice();
  const out: Fix[] = [];
  let j = 0;
  const end = fixes[fixes.length - 1].t;
  for (let t = fixes[0].t; t <= end; t += step) {
    while (j < fixes.length - 2 && fixes[j + 1].t < t) j++;
    const a = fixes[j], b = fixes[j + 1];
    const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
    out.push({ t, p: add(a.p, mul(sub(b.p, a.p), Math.max(0, Math.min(1, f)))) });
  }
  return out;
}

/** Ground velocity (knots) at each sample, centred over ±w samples. */
function velocities(r: Fix[], w = 3): (Vec | null)[] {
  return r.map((_, i) => {
    if (i < w || i >= r.length - w) return null;
    const dt = r[i + w].t - r[i - w].t;
    return dt > 0 ? mul(sub(r[i + w].p, r[i - w].p), KN / dt) : null;
  });
}

const meanDir = (vs: Vec[]) => bearingOf(vs.reduce((s, v) => add(s, norm(v)), { x: 0, y: 0 }));

/** Split the track into boards where the course changes by more than `turnDeg` from the recent mean. */
export function splitBoards(r: Fix[], windFrom: number, turnDeg = 40, minS = 30, marks: Vec[] = []): Board[] {
  const v = velocities(r);
  const segs: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < r.length; i++) {
    const vi = v[i];
    if (!vi || len(vi) < 0.3) continue;
    if (cur.length) {
      const recent = cur.slice(-6).map((k) => v[k]!);
      if (Math.abs(norm180(bearingOf(vi) - meanDir(recent))) > turnDeg) { segs.push(cur); cur = []; }
    }
    cur.push(i);
  }
  if (cur.length) segs.push(cur);
  // A rounding can turn less than turnDeg (a beat into a broad reach); cut boards at the closest pass of a mark.
  const near = (k: number) => Math.min(Infinity, ...marks.map((m) => len(sub(r[k].p, m))));
  const cut = segs.flatMap((s) => {
    const out: number[][] = [];
    let a = 0;
    for (let j = 1; j + 1 < s.length; j++) {
      const d = near(s[j]);
      if (d < 0.06 && d <= near(s[j - 1]) && d < near(s[j + 1]) && j - a >= 3 && s.length - j >= 3) { out.push(s.slice(a, j + 1)); a = j; }
    }
    out.push(s.slice(a));
    return out;
  });
  const boards: Board[] = [];
  for (const s of cut) {
    const a = r[s[0]], b = r[s[s.length - 1]];
    const dt = b.t - a.t;
    if (dt < minS) continue;
    const d = sub(b.p, a.p);
    const cog = bearingOf(d);
    const off = norm180(cog - windFrom);
    const kind: BoardKind = Math.abs(off) < 80 ? (off < 0 ? 'starboard' : 'port') : Math.abs(off) > 130 ? 'downwind' : 'reach';
    boards.push({ t0: a.t, t1: b.t, kind, cog, sog: (len(d) * KN) / dt, from: a.p, to: b.p });
  }
  return boards;
}

/** Wind speed giving `stw` at `twa` on the polar, searched 1–30 kn. */
export function windForSpeed(polar: Polar, twa: number, stw: number): number | null {
  let best: number | null = null, err = Infinity;
  for (let w = 1; w <= 30; w += 0.1) {
    const e = Math.abs(polarSpeed(polar, twa, w) - stw);
    if (e < err) { err = e; best = w; }
  }
  return err < 0.3 ? Math.round(best! * 10) / 10 : null;
}

/**
 * Wind direction, tide and speed through the water from the mean ground velocities on the two tacks.
 * Both carry the same tide, so their difference is the difference of the two water velocities, which
 * lies across the wind. With the upwind angle `twa` the rest follows.
 */
export function windFromTacks(gs: Vec, gp: Vec, twa: number, polar?: Polar): TrackWind | null {
  const d = sub(gp, gs);
  if (len(d) < 0.2) return null;
  const from = norm360(bearingOf(d) - 90);
  const stw = len(d) / (2 * Math.sin((twa * Math.PI) / 180));
  const m = mul(add(gs, gp), 0.5);
  const tide = sub(m, fromBearing(from, stw * Math.cos((twa * Math.PI) / 180)));
  return {
    from, tide, twa, stw,
    tws: polar ? windForSpeed(polar, twa, stw) : null,
    groundTack: Math.abs(norm180(bearingOf(gp) - bearingOf(gs))),
    waterTack: 2 * twa,
    starboard: gs, port: gp,
  };
}

/** Where a board (from a, along direction u) crosses the line through m along direction l. Returns distance along u, or null. */
function crossAt(a: Vec, u: Vec, m: Vec, l: Vec): number | null {
  const den = cross(u, l);
  if (Math.abs(den) < 1e-9) return null;
  return cross(sub(m, a), l) / den;
}

export interface AnalyseOptions { twa: number; polar?: Polar; marks?: Vec[]; windFrom: number; /** Seconds from the first fix when the race started. */ startT?: number }

/** Boards, wind and tide, minute-by-minute wind and layline overstands for a GPS track. */
export function analyseTrack(fixes: Fix[], o: AnalyseOptions): TrackAnalysis {
  const r = resample(fixes, 5);
  const durationS = r.length ? r[r.length - 1].t - r[0].t : 0;
  const startT = o.startT ?? -Infinity;
  // Boards before the start are pre-start; a board running through the start is cut there.
  const race = (bs: Board[]) => bs.flatMap((b): Board[] => {
    if (b.t1 <= startT) return [{ ...b, kind: 'prestart' }];
    if (b.t0 >= startT) return [b];
    const at = (t: number) => { const i = Math.max(0, Math.min(r.length - 1, Math.round((t - r[0].t) / 5))); return r[i].p; };
    const mk = (t0: number, t1: number, kind?: BoardKind): Board => {
      const a = at(t0), z = at(t1), d = sub(z, a), cog = bearingOf(d);
      return { t0, t1, kind: kind ?? b.kind, cog, sog: t1 > t0 ? (len(d) * KN) / (t1 - t0) : 0, from: a, to: z };
    };
    return [mk(b.t0, startT, 'prestart'), mk(startT, b.t1)];
  });
  let boards = race(splitBoards(r, o.windFrom, 40, 30, o.marks));
  // Mean ground velocity on each tack: boards of 90 s or more, time-weighted, dropping boards more than
  // 10° off the others (a start along the line, or footing to a mark after an overstand).
  const meanOf = (k: BoardKind, bs: Board[]) => {
    let use = bs.filter((b) => b.kind === k && b.t1 - b.t0 >= 90);
    const mean = (xs: Board[]) => {
      let s = { x: 0, y: 0 }, T = 0;
      for (const b of xs) { s = add(s, sub(b.to, b.from)); T += b.t1 - b.t0; }
      return T > 0 ? mul(s, KN / T) : null;
    };
    for (;;) {
      const m = mean(use);
      if (!m || use.length < 2) return m;
      const dir = bearingOf(m);
      const worst = use.reduce((w, b) => (Math.abs(norm180(b.cog - dir)) > Math.abs(norm180(w.cog - dir)) ? b : w));
      if (Math.abs(norm180(worst.cog - dir)) <= 10) return m;
      use = use.filter((b) => b !== worst);
    }
  };
  let gs = meanOf('starboard', boards), gp = meanOf('port', boards);
  let wind = gs && gp ? windFromTacks(gs, gp, o.twa, o.polar) : null;
  if (wind) {
    // Classify again against the wind the track itself gives.
    boards = race(splitBoards(r, wind.from, 40, 30, o.marks));
    gs = meanOf('starboard', boards); gp = meanOf('port', boards);
    wind = gs && gp ? windFromTacks(gs, gp, o.twa, o.polar) : wind;
  }
  // Minute-by-minute wind: each upwind sample's water heading plus or minus the TWA.
  const shifts: Shift[] = [];
  if (wind) {
    const v = velocities(r);
    const byMin = new Map<string, { t: number; kind: 'starboard' | 'port'; s: Vec }>();
    boards.forEach((b) => {
      if (b.kind !== 'starboard' && b.kind !== 'port') return;
      for (let i = 0; i < r.length; i++) {
        if (r[i].t < b.t0 + 20 || r[i].t > b.t1 - 20 || !v[i] || len(v[i]!) < 1) continue;
        const water = sub(v[i]!, wind!.tide);
        const w = norm360(bearingOf(water) + (b.kind === 'starboard' ? o.twa : -o.twa));
        const minute = Math.floor((r[i].t - r[0].t) / 60);
        const key = `${minute}${b.kind}`;
        const e = byMin.get(key) ?? { t: minute * 60, kind: b.kind, s: { x: 0, y: 0 } };
        e.s = add(e.s, fromBearing(w));
        byMin.set(key, e);
      }
    });
    for (const e of [...byMin.values()].sort((a, b) => a.t - b.t)) shifts.push({ t: e.t, kind: e.kind, from: bearingOf(e.s) });
  }
  // Overstands: an upwind board followed by the other tack that fetches a mark.
  const overstands: Overstand[] = [];
  if (wind && o.marks?.length) {
    for (let i = 0; i + 1 < boards.length; i++) {
      const b = boards[i], c = boards[i + 1];
      const up = (k: BoardKind) => k === 'starboard' || k === 'port';
      if (!up(b.kind) || !up(c.kind) || b.kind === c.kind) continue;
      const mi = o.marks.findIndex((m) => len(sub(c.to, m)) < 0.06); // within about 110 m
      if (mi < 0) continue;
      // A board that starts at a rounding is the next leg, not a beat to this mark.
      if (o.marks.some((m) => len(sub(b.to, m)) < 0.06 || len(sub(b.from, m)) < 0.06)) continue;
      const m = o.marks[mi];
      const lay = c.kind === 'starboard' ? wind.starboard : wind.port; // the board that fetches the mark
      const u = norm(sub(b.to, b.from));
      const s = crossAt(b.from, u, m, norm(lay));
      const total = len(sub(b.to, b.from));
      if (s === null || s < 0 || s >= total) continue;
      const past = total - s; // nm sailed beyond the layline
      const speed = b.sog / KN; // nm/s
      const seconds = past / speed;
      if (seconds < 5) continue;
      overstands.push({ board: i, seconds, bearingAtTack: bearingOf(sub(m, b.to)), laylineBearing: bearingOf(lay), markIndex: mi });
    }
  }
  return { boards, wind, shifts, overstands, durationS };
}

/** Wind over the ground (from, knots) that gives `waterFrom`/`waterKn` on the water with this tide. */
export function groundWind(waterFrom: number, waterKn: number, tide: Vec) {
  const g = add(fromBearing(waterFrom + 180, waterKn), tide);
  return { from: norm360(bearingOf(g) + 180), kn: len(g) };
}


/**
 * The start: the first time the track crosses the line from the pre-start side to the course side (the side
 * the first mark is on) and goes on to sail `awayNm` clear of the line without coming back. Seconds from the first fix, or null.
 */
export function findStart(fixes: Fix[], committee: Vec, pin: Vec, firstMark: Vec, awayNm = 0.25): number | null {
  const l = sub(committee, pin);
  const side = (p: Vec) => Math.sign(cross(l, sub(p, pin)));
  const dist = (p: Vec) => Math.abs(cross(norm(l), sub(p, pin)));
  const course = side(firstMark);
  if (!course) return null;
  const r = resample(fixes, 2);
  for (let i = 1; i < r.length; i++) {
    if (side(r[i - 1].p) === course || side(r[i].p) !== course) continue;
    // Crossed onto the course side between the ends (with 50 m slack)...
    const a = r[i - 1].p, b = r[i].p, u = sub(b, a);
    const s = crossAt(pin, norm(l), a, norm(u));
    if (s === null || s < -0.03 || s > len(l) + 0.03) continue;
    // ...and sailed well clear up the course before coming back: a pre-start dip doesn't count.
    let ok = false;
    for (let j = i; j < r.length && side(r[j].p) === course; j++) if (dist(r[j].p) > awayNm) { ok = true; break; }
    if (ok) return r[i].t;
  }
  return null;
}
