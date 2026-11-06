import { describe, it, expect } from 'vitest';
import { fromBearing, bearingOf, add, len, sub, mul, norm180 } from '../src/nav/vec';
import { JEANNEAU_410, polarSpeed, optimalAngles } from '../src/nav/polar';
import { resolveWind, solveReach, solveLeg, startLineInfo, twoTack, tackBearings, laneParts, tackPair, BoatCfg, Strategy } from '../src/nav/solve';

const boat: BoatCfg = { polar: JEANNEAU_410, leewayDeg: 0, tackPenaltySec: 0 };
const close = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol);

describe('vectors', () => {
  it('bearings round-trip', () => {
    for (const b of [0, 45, 90, 135, 225, 359]) close(bearingOf(fromBearing(b, 3)), b, 1e-9);
  });
});

describe('polar', () => {
  it('reproduces table points and interpolates', () => {
    close(polarSpeed(JEANNEAU_410, 90, 10), 7.6);
    close(polarSpeed(JEANNEAU_410, -90, 10), 7.6);
    const mid = polarSpeed(JEANNEAU_410, 90, 11);
    expect(mid).toBeGreaterThan(7.6);
    expect(mid).toBeLessThan(7.9);
  });
  it('has sensible VMG angles', () => {
    const o = optimalAngles(JEANNEAU_410, 12);
    expect(o.up.twa).toBeGreaterThan(36);
    expect(o.up.twa).toBeLessThan(50);
    expect(o.down.twa).toBeGreaterThan(135);
  });
});

describe('wind over water', () => {
  it('wind against tide increases water wind', () => {
    // Wind from west (blowing east), tide flowing west: air moves faster relative to water.
    const w = resolveWind({ windFrom: 270, windKn: 10, windRef: 'ground', tideTo: 270, tideKn: 2 });
    close(w.water.kn, 12, 1e-9);
    close(w.water.from, 270, 1e-9);
  });
  it('cross tide shifts water wind direction', () => {
    const w = resolveWind({ windFrom: 0, windKn: 10, windRef: 'ground', tideTo: 90, tideKn: 2 });
    // air (0,-10) minus tide (2,0) = (-2,-10): comes from slightly east of north... from = bearing(2,10)
    close(w.water.from, bearingOf({ x: 2, y: 10 }), 1e-9);
  });
});

describe('course to steer (tide triangle)', () => {
  it('slack water: CTW equals track', () => {
    const w = { from: 0, kn: 12 };
    const s = solveReach({ x: 0, y: 0 }, { x: 1, y: 0 }, w, { x: 0, y: 0 }, boat);
    expect(s.feasible).toBe(true);
    close(s.heading, 90, 1e-6);
    close(s.sog, s.stw, 1e-9);
  });
  it('cross tide: ground velocity lies on the track', () => {
    const w = { from: 0, kn: 12 };
    const tide = fromBearing(0, 2); // pushing north while we head east
    const s = solveReach({ x: 0, y: 0 }, { x: 1, y: 0 }, w, tide, boat);
    expect(s.feasible).toBe(true);
    close(s.cog, 90, 1e-3);
    expect(s.heading).toBeGreaterThan(90); // steer south of east to cancel
    const g = add(s.water, tide);
    close(len(sub(g, s.ground)), 0, 1e-9);
    close(s.water.y, -2, 1e-3);
  });
  it('tide stronger than boat across track is flagged', () => {
    const w = { from: 0, kn: 3 };
    const s = solveReach({ x: 0, y: 0 }, { x: 1, y: 0 }, w, fromBearing(0, 6), boat);
    expect(s.feasible).toBe(false);
  });
});

describe('beats with tide', () => {
  it('slack water beat is symmetric and both boards reach the mark', () => {
    const w = { from: 0, kn: 12 };
    const leg = solveLeg({ x: 0, y: 0 }, { x: 0, y: 2 }, w, { x: 0, y: 0 }, boat);
    expect(leg.kind).toBe('beat');
    const [p1, p2] = leg.parts;
    close(p1.hours, p2.hours, 1e-6);
    close(len(sub(p2.end, { x: 0, y: 2 })), 0, 1e-9);
  });
  it('cross tide makes laylines asymmetric and the route still ends at the mark', () => {
    const w = { from: 0, kn: 12 };
    const tide = fromBearing(90, 1.5);
    const leg = solveLeg({ x: 0, y: 0 }, { x: 0, y: 2 }, w, tide, boat);
    expect(leg.kind).toBe('beat');
    const ls = bearingOf(leg.laylines!.starboard);
    const lp = bearingOf(leg.laylines!.port);
    // Unequal angles either side of the downwind direction from the mark
    expect(Math.abs(Math.abs(norm180(ls - 180)) - Math.abs(norm180(lp - 180)))).toBeGreaterThan(5);
    const last = leg.parts[leg.parts.length - 1];
    close(len(sub(last.end, { x: 0, y: 2 })), 0, 1e-9);
  });
  it('two-tack solve', () => {
    const r = twoTack({ x: 0, y: 0 }, { x: 0, y: 2 }, { x: -1, y: 1 }, { x: 1, y: 1 })!;
    close(r.a, 1);
    close(r.b, 1);
  });
});

describe('start line', () => {
  it('detects pin favoured', () => {
    // Wind from north. Square line runs committee (east) -> pin (west).
    const info = startLineInfo({ x: 0.1, y: 0 }, { x: -0.1, y: 0.01 }, { from: 0, kn: 10 });
    expect(info.favoured).toBe('pin');
    expect(info.bias).toBeGreaterThan(0);
    close(info.advantageM, 18.52, 1e-6);
  });
});

describe('tacking bearing', () => {
  const w = { from: 0, kn: 12 };
  const mark = { x: 0, y: 2 };
  for (const tideKn of [0, 1.5]) {
    it(`mark bears the other board's CoG at the tack point (tide ${tideKn} kn)`, () => {
      const leg = solveLeg({ x: 0, y: 0 }, mark, w, fromBearing(90, tideKn), boat);
      expect(leg.kind).toBe('beat');
      const [p1, p2] = leg.parts;
      const seen = bearingOf(sub(mark, p1.end));
      close(seen, p2.sail.cog, 1e-6);
      close(seen, leg.tackBearings![p1.sail.tack], 1e-6);
    });
  }
  it('slack water tack bearings are the wind direction plus or minus the tacking angle over the ground', () => {
    const pair = tackPair(w, { x: 0, y: 0 }, boat, 'up');
    const tb = tackBearings(pair.starboard.ground, pair.port.ground);
    close(norm180(tb.starboard), pair.twa, 1e-6); // on starboard, tack when the mark is on port's heading
    close(norm180(tb.port), -pair.twa, 1e-6);
  });
  it('tide changes the bearing to tack on', () => {
    const slack = solveLeg({ x: 0, y: 0 }, mark, w, { x: 0, y: 0 }, boat).tackBearings!;
    const tide = solveLeg({ x: 0, y: 0 }, mark, w, fromBearing(90, 1.5), boat).tackBearings!;
    expect(Math.abs(norm180(slack.starboard - tide.starboard))).toBeGreaterThan(3);
  });
});

describe('lane strategy (stay off the laylines)', () => {
  const w = { from: 0, kn: 12 };
  const from = { x: 0, y: 0 };
  const mark = { x: 0, y: 2 };
  const lane = (margin: number, maxTacks: number): Strategy => ({ mode: 'lane', margin, maxTacks });
  for (const tideKn of [0, 1.5]) {
    const tide = fromBearing(90, tideKn);
    it(`ends at the mark, keeps the total sailing time and uses the tack budget (tide ${tideKn} kn)`, () => {
      const classic = solveLeg(from, mark, w, tide, boat);
      const leg = solveLeg(from, mark, w, tide, boat, lane(0.4, 4));
      expect(leg.parts.length).toBe(5); // four tacks, five boards
      close(len(sub(leg.parts[leg.parts.length - 1].end, mark)), 0, 1e-9);
      for (let i = 1; i < leg.parts.length; i++) {
        expect(leg.parts[i].sail.tack).not.toBe(leg.parts[i - 1].sail.tack);
        close(len(sub(leg.parts[i].start, leg.parts[i - 1].end)), 0, 1e-12);
      }
      const hrs = leg.parts.reduce((t, p) => t + p.hours, 0);
      close(hrs, classic.timeH, 1e-9); // tack penalty is zero for this boat
    });
    it(`every lane tack is on the inner layline bearing, the last on the real layline (tide ${tideKn} kn)`, () => {
      const leg = solveLeg(from, mark, w, tide, boat, lane(0.4, 4));
      const n = leg.parts.length;
      expect(n).toBe(5);
      for (let i = 0; i < n - 1; i++) {
        const p = leg.parts[i];
        const seen = bearingOf(sub(mark, p.end));
        const want = i < n - 2 ? leg.lane!.bearings[p.sail.tack] : leg.tackBearings![p.sail.tack];
        close(seen, want, 1e-6);
      }
    });
  }
  it('margin 0 or one tack is the classic layline route', () => {
    const classic = solveLeg(from, mark, w, fromBearing(90, 1), boat);
    for (const s of [lane(0, 6), lane(0.3, 1)]) {
      const leg = solveLeg(from, mark, w, fromBearing(90, 1), boat, s);
      expect(leg.parts.length).toBe(2);
      close(len(sub(leg.parts[0].end, classic.parts[0].end)), 0, 1e-9);
    }
  });
  it('a wider margin stays further from the laylines', () => {
    const pair = tackPair(w, { x: 0, y: 0 }, boat, 'up');
    const offLayline = (m: number) => {
      const parts = laneParts(from, mark, pair, 'starboard', m, 4)!;
      // Distance in from the nearest real layline at the first tack, as a share of the time left
      const r = twoTack(parts[0].end, mark, pair.starboard.ground, pair.port.ground)!;
      return Math.min(r.a, r.b) / (r.a + r.b);
    };
    close(offLayline(0.2), 0.2, 1e-9);
    close(offLayline(0.4), 0.4, 1e-9);
  });
  it('stops zig-zagging when boards get too short', () => {
    const pair = tackPair(w, { x: 0, y: 0 }, boat, 'up');
    const all = laneParts(from, mark, pair, 'starboard', 0.2, 12)!;
    const capped = laneParts(from, mark, pair, 'starboard', 0.2, 12, 2 / 60)!;
    expect(capped.length).toBeLessThan(all.length);
    for (const p of capped.slice(0, -2)) expect(p.hours).toBeGreaterThanOrEqual(2 / 60);
    // the final approach (to the layline and in) is at least two minimum boards long
    const fin = capped.slice(-2).reduce((t, p) => t + p.hours, 0);
    expect(fin).toBeGreaterThanOrEqual(4 / 60 - 1e-9);
    close(len(sub(capped[capped.length - 1].end, mark)), 0, 1e-9);
  });
  it('a start outside the lane sails into it first and does not loop at the mark', () => {
    const pair = tackPair(w, { x: 0, y: 0 }, boat, 'up');
    // On the port layline: starboard would leave the lane at once, so the route starts on port.
    const start = add(mark, mul(pair.port.ground, -0.3));
    const parts = laneParts(start, mark, pair, 'starboard', 0.3, 4)!;
    expect(parts.length).toBe(1);
    expect(parts[0].sail.tack).toBe('port');
    expect(laneParts(mark, mark, pair, 'starboard', 0.3, 4)!.length).toBe(0);
  });
  it('never makes more tacks than asked for', () => {
    for (const n of [2, 3, 4, 6, 10]) {
      const leg = solveLeg(from, mark, w, fromBearing(90, 1), boat, lane(0.45, n));
      expect(leg.parts.length - 1).toBeLessThanOrEqual(n);
    }
  });
  it('works for runs (gybes) too', () => {
    const leg = solveLeg({ x: 0, y: 2 }, { x: 0, y: 0 }, w, fromBearing(90, 1), boat, lane(0.4, 3));
    expect(leg.kind).toBe('run');
    expect(leg.parts.length).toBe(4);
    close(len(sub(leg.parts[leg.parts.length - 1].end, { x: 0, y: 0 })), 0, 1e-9);
  });
});
