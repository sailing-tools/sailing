import { describe, it, expect } from 'vitest';
import { fromBearing, bearingOf, add, len, sub, mul, norm180 } from '../src/nav/vec';
import { JEANNEAU_410, polarSpeed, optimalAngles } from '../src/nav/polar';
import { resolveWind, solveReach, solveLeg, startLineInfo, twoTack, tackBearings, laneParts, tackPair, sailingAngles, roundsCorrectly, BoatCfg, Strategy } from '../src/nav/solve';

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

describe('own upwind angle', () => {
  const w = { from: 0, kn: 12 };
  it('overrides the polar optimum, with polar speed at that angle', () => {
    const own = { ...boat, upTwa: 45 };
    const a = sailingAngles(own, 12);
    close(a.up.twa, 45);
    close(a.up.stw, polarSpeed(JEANNEAU_410, 45, 12));
    close(a.down.twa, optimalAngles(JEANNEAU_410, 12).down.twa);
    const pair = tackPair(w, { x: 0, y: 0 }, own, 'up');
    close(norm180(pair.starboard.heading), -45, 1e-9);
    close(norm180(pair.port.heading), 45, 1e-9);
  });
  it('a wider angle widens the laylines and the tack bearings', () => {
    const narrow = solveLeg({ x: 0, y: 0 }, { x: 0, y: 2 }, w, { x: 0, y: 0 }, { ...boat, upTwa: 40 });
    const wide = solveLeg({ x: 0, y: 0 }, { x: 0, y: 2 }, w, { x: 0, y: 0 }, { ...boat, upTwa: 45 });
    close(norm180(narrow.tackBearings!.starboard), 40, 1e-6);
    close(norm180(wide.tackBearings!.starboard), 45, 1e-6);
    expect(wide.timeH).toBeGreaterThan(0);
  });
  it('a mark 42 degrees off the wind is a beat at 45 but a reach at 40', () => {
    const to = { x: Math.sin(42 * Math.PI / 180) * 2, y: Math.cos(42 * Math.PI / 180) * 2 };
    expect(solveLeg({ x: 0, y: 0 }, to, w, { x: 0, y: 0 }, { ...boat, upTwa: 45 }).kind).toBe('beat');
    expect(solveLeg({ x: 0, y: 0 }, to, w, { x: 0, y: 0 }, { ...boat, upTwa: 40 }).kind).toBe('reach');
  });
});

describe('rounding side', () => {
  const w = { from: 0, kn: 12 };
  const from = { x: 0, y: 0 };
  // Mark a little to the left of dead upwind, so the longer board comes first on port without a rounding rule.
  const mark = { x: -0.3, y: 2 };
  const down = 180; // next leg runs back downwind
  it('a left turn leaves the mark to port', () => {
    expect(roundsCorrectly(315, { side: 'port', nextBearing: 180 })).toBe(true);
    expect(roundsCorrectly(45, { side: 'port', nextBearing: 180 })).toBe(false);
    expect(roundsCorrectly(45, { side: 'starboard', nextBearing: 180 })).toBe(true);
  });
  for (const tideKn of [0, 1.5]) {
    it(`windward mark to port: final board is starboard (tide ${tideKn} kn)`, () => {
      const tide = fromBearing(90, tideKn);
      for (const strat of [undefined, { mode: 'lane', margin: 0.3, maxTacks: 4 } as Strategy, { mode: 'lane', margin: 0.3, maxTacks: 3 } as Strategy]) {
        const leg = solveLeg(from, mark, w, tide, boat, strat, { side: 'port', nextBearing: down });
        expect(leg.parts[leg.parts.length - 1].sail.tack).toBe('starboard');
        expect(leg.rounding!.ok).toBe(true);
        close(len(sub(leg.parts[leg.parts.length - 1].end, mark)), 0, 1e-9);
        if (leg.altParts) expect(leg.altParts[leg.altParts.length - 1].sail.tack).toBe('starboard');
      }
    });
    it(`windward mark to starboard: final board is port (tide ${tideKn} kn)`, () => {
      const leg = solveLeg(from, mark, w, fromBearing(90, tideKn), boat, undefined, { side: 'starboard', nextBearing: down });
      expect(leg.parts[leg.parts.length - 1].sail.tack).toBe('port');
      expect(leg.rounding!.ok).toBe(true);
    });
  }
  it('flags a reach that turns the wrong way round the mark', () => {
    // Reach east to a mark, then turn north: a left turn, so leaving it to starboard is wrong.
    const leg = solveLeg(from, { x: 1, y: 0 }, w, { x: 0, y: 0 }, boat, undefined, { side: 'starboard', nextBearing: 0 });
    expect(leg.kind).toBe('reach');
    expect(leg.rounding!.ok).toBe(false);
  });
});

import { parseCourseHash } from '../src/store';
describe('course link', () => {
  it('reads a course from a link hash and ignores junk', () => {
    const course = { marks: [{ id: 'a', name: 'Wíndward', pos: { x: 1, y: 2 }, rounding: 'port' }], finishAtStart: true, tool: 'mark' };
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(course)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const o = parseCourseHash('#c=' + b64)!;
    expect((o.marks as any)[0].name).toBe('Wíndward');
    expect('tool' in o).toBe(false);
    expect(parseCourseHash('#c=!!!')).toBe(null);
    expect(parseCourseHash('')).toBe(null);
  });
});

import { tackNarrative, offBowText } from '../src/course';
describe('tack narrative', () => {
  it('describes each board and the tack bearing off the bow', () => {
    const leg = solveLeg({ x: 0, y: 0 }, { x: 0, y: 2 }, { from: 0, kn: 12 }, fromBearing(90, 1), boat);
    const t = tackNarrative(leg, 0, 'Windward');
    expect(t).toMatch(/^Board 1 of 2: /);
    expect(t).toMatch(/off the (port|starboard) bow/);
    expect(tackNarrative(leg, 1, 'Windward', 'port')).toMatch(/the last.*leaving it to port/);
    expect(offBowText(10, 0)).toBe('10° off the starboard bow');
    expect(offBowText(350, 0)).toBe('10° off the port bow');
  });
});

import { startStrategy } from '../src/nav/start';
describe('start strategy', () => {
  const w = { from: 0, kn: 12 };
  const mark = { x: 0, y: 2 };
  const square = { committee: { x: 0.1, y: 0 }, pin: { x: -0.1, y: 0 } };
  it('square line in slack water is even, both boards shown from each end', () => {
    const s = startStrategy(square.committee, square.pin, mark, w, { x: 0, y: 0 }, boat);
    expect(Math.abs(s.gainS.total)).toBeLessThan(2);
    expect(s.favoured).toBe('even');
    expect(s.routes.filter((r) => r.plan === 'laylines').length).toBe(4);
    expect(s.fastest!.first).toBe('starboard'); // tie goes to right of way
  });
  it('a line biased to the pin gives the wind gain to the pin', () => {
    const s = startStrategy({ x: 0.1, y: 0 }, { x: -0.1, y: 0.03 }, mark, w, { x: 0, y: 0 }, boat);
    expect(s.gainS.wind).toBeGreaterThan(5);
    close(s.gainS.tide, 0, 1e-6);
    expect(s.favoured).toBe('pin');
    expect(s.fastest!.end).toBe('pin');
  });
  it('splits wind and tide, and tide can outweigh the bias', () => {
    // Pin slightly upwind, but a strong stream setting west makes the committee (east) end pay.
    // A stream across the line (setting south) changes how long each end takes to reach the mark.
    const s = startStrategy({ x: 0.3, y: 0 }, { x: -0.3, y: 0.01 }, { x: -0.6, y: 1.5 }, w, fromBearing(200, 2), boat);
    close(s.gainS.wind + s.gainS.tide, s.gainS.total, 1e-6);
    expect(s.gainS.wind).toBeGreaterThan(0);
    expect(Math.sign(s.gainS.tide)).not.toBe(0);
  });
  it('charges an extra tack for arriving on the wrong board', () => {
    const pen = { ...boat, tackPenaltySec: 20 };
    const s = startStrategy(square.committee, square.pin, mark, w, { x: 0, y: 0 }, pen, { side: 'port', nextBearing: 180 });
    const fromPin = s.routes.filter((r) => r.end === 'pin' && r.plan === 'laylines');
    const good = fromPin.find((r) => r.roundsOk)!, bad = fromPin.find((r) => !r.roundsOk)!;
    expect(good.parts[good.parts.length - 1].sail.tack).toBe('starboard');
    close((bad.timeH - good.timeH) * 3600, 20, 1);
    expect(s.best!.roundsOk).toBe(true);
  });
});

describe('start strategy risk', () => {
  const w = { from: 0, kn: 12 };
  const mark = { x: 0, y: 2 };
  it('a layline route spends more of the beat near a layline than a lane route', () => {
    const s = startStrategy({ x: 0.1, y: 0 }, { x: -0.1, y: 0 }, mark, w, { x: 0, y: 0 }, boat, undefined, { margin: 0.2, maxTacks: 4 });
    const lay = s.routes.find((r) => r.end === 'pin' && r.plan === 'laylines' && r.first === 'starboard')!;
    const lane = s.routes.find((r) => r.end === 'pin' && r.plan === 'lane' && r.first === 'starboard')!;
    expect(lay.nearLayline).toBeGreaterThan(lane.nearLayline + 0.2);
    expect(lane.parts.length).toBeGreaterThan(2);
  });
  it('allowance 0 picks the fastest; a big allowance picks the safer route', () => {
    const pen = { ...boat, tackPenaltySec: 10 };
    const fast = startStrategy({ x: 0.1, y: 0 }, { x: -0.1, y: 0 }, mark, w, { x: 0, y: 0 }, pen, undefined, { allowanceSec: 0 });
    close(fast.best!.timeH, fast.fastest!.timeH, 1e-9); // only equal-time routes are allowed
    const safe = startStrategy({ x: 0.1, y: 0 }, { x: -0.1, y: 0 }, mark, w, { x: 0, y: 0 }, pen, undefined, { allowanceSec: 120 });
    expect(safe.best!.risk).toBeLessThan(safe.fastest!.risk);
    expect(safe.best!.plan).toBe('lane');
  });
  it('knows the up-tide side and counts time down-tide', () => {
    // Stream setting east, so west is up-tide. With the wind from the north, starboard tack heads west of north.
    const s = startStrategy({ x: 0.1, y: 0 }, { x: -0.1, y: 0 }, mark, w, fromBearing(90, 1), boat);
    expect(s.upTideSide).toBe('starboard');
    const stbd = s.routes.find((r) => r.end === 'pin' && r.plan === 'laylines' && r.first === 'starboard')!;
    const port = s.routes.find((r) => r.end === 'pin' && r.plan === 'laylines' && r.first === 'port')!;
    expect(stbd.downTide!).toBeLessThan(port.downTide!);
    expect(startStrategy({ x: 0.1, y: 0 }, { x: -0.1, y: 0 }, mark, w, { x: 0, y: 0 }, boat).upTideSide).toBe(null);
  });
});

describe('leg 1 follows the start strategy', () => {
  it('sails the recommended start route, so only one route is drawn to the first mark', async () => {
    const { computeCourse } = await import('../src/course');
    const { initialState } = await import('../src/store');
    for (const cond of [initialState.cond, { windFrom: 37, windKn: 11.6, windRef: 'ground' as const, tideTo: 95, tideKn: 0.6 }]) {
      const c = computeCourse({ ...initialState, cond, upTwa: 44 });
      const best = c.startPlan!.best!;
      expect(c.points[0].pos).toEqual(best.from);
      if (c.legs[0].kind === 'reach') { expect(best.parts.length).toBe(1); continue; } // laid from the line
      expect(c.legs[0].parts).toBe(best.parts);
      expect(c.legs[0].altParts).toBeUndefined();
      expect(c.legs[0].timeH).toBeCloseTo(best.timeH, 9);
      expect(c.legs[0].rounding?.ok).toBe(best.roundsOk);
    }
  });
});

describe('start anywhere on the line', () => {
  it('starts where the starboard layline crosses the line rather than sailing back to it', () => {
    const w = { from: 0, kn: 12 };
    const mark = { x: 0, y: 1 };
    // The starboard layline to the mark crosses this line between the pin and the committee boat.
    // With no time to give up, the quickest start is on the layline. (With an allowance, staying off the layline can win.)
    const s = startStrategy({ x: 1.6, y: 0 }, { x: 0.4, y: 0 }, mark, w, { x: 0, y: 0 }, { ...boat, tackPenaltySec: 15 }, undefined, { allowanceSec: 0 });
    const best = s.best!;
    expect(best.end).toBe('line');
    expect(best.onLayline).toBe('starboard');
    expect(best.first).toBe('starboard');
    expect(best.parts.length).toBe(1);
    for (const r of s.routes.filter((r) => r.end !== 'line')) expect(best.timeH).toBeLessThan(r.timeH);
    expect(best.fromPinM).toBeGreaterThan(0);
    expect(best.fromPinM).toBeLessThan(1.2 * 1852);
  });
  it('never recommends a first board that heads back below the line', () => {
    const w = { from: 0, kn: 12 };
    // Committee end well outside the starboard layline: port first runs along and below the line.
    const s = startStrategy({ x: 0.6, y: 0 }, { x: -0.2, y: 0.2 }, { x: -0.6, y: 1.2 }, w, { x: 0, y: 0 }, boat);
    expect(s.best!.belowLine).toBe(false);
  });
});

describe('Solent racing marks', () => {
  it('has the SCRA list with unique codes and Solent positions', async () => {
    const { SOLENT_MARKS } = await import('../src/data/solentMarks');
    expect(SOLENT_MARKS.length).toBe(157);
    expect(new Set(SOLENT_MARKS.map((m) => m.code)).size).toBe(157);
    const g = SOLENT_MARKS.find((m) => m.code === '3U')!;
    expect(g.name).toBe('Gurnard');
    close(g.lat, 50 + 46.22 / 60, 1e-6);
    close(g.lon, -(1 + 18.84 / 60), 1e-6);
  });
  it('finds a mark by code, by "code name" and by name, and adds it at its position', async () => {
    const { findSolentMark, solentToMark, fmtLatLon } = await import('../src/marks');
    expect(findSolentMark('3u')?.name).toBe('Gurnard');
    expect(findSolentMark('33 Prince Consort')?.code).toBe('33');
    expect(findSolentMark('prince consort')?.code).toBe('33');
    expect(findSolentMark('East Kn')?.code).toBe('4H');
    expect(findSolentMark('zz')).toBeUndefined();
    const m = solentToMark(findSolentMark('3U')!);
    expect(m.code).toBe('3U');
    expect(fmtLatLon(50 + 46.22 / 60, -(1 + 18.84 / 60))).toBe("50°46.22'N 1°18.84'W");
    expect(Math.hypot(m.pos.x, m.pos.y)).toBeLessThan(2); // near the Cowes origin
  });
});
