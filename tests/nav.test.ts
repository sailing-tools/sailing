import { describe, it, expect } from 'vitest';
import { fromBearing, bearingOf, add, len, sub, norm180 } from '../src/nav/vec';
import { JEANNEAU_410, polarSpeed, optimalAngles } from '../src/nav/polar';
import { resolveWind, solveReach, solveLeg, startLineInfo, twoTack, BoatCfg } from '../src/nav/solve';

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
