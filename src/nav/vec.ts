// Flat local plane: x east, y north. Positions in nautical miles, velocities in knots.
export type Vec = { x: number; y: number };

export const D2R = Math.PI / 180;

export const vec = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec) => a.x * b.y - a.y * b.x;
export const len = (a: Vec) => Math.hypot(a.x, a.y);
export const norm = (a: Vec): Vec => {
  const l = len(a);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
};
export const mid = (a: Vec, b: Vec): Vec => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export const norm360 = (a: number) => ((a % 360) + 360) % 360;
export const norm180 = (a: number) => {
  const x = norm360(a);
  return x > 180 ? x - 360 : x;
};

/** Vector of magnitude `mag` pointing TOWARDS true bearing `deg`. */
export const fromBearing = (deg: number, mag = 1): Vec => ({
  x: mag * Math.sin(deg * D2R),
  y: mag * Math.cos(deg * D2R),
});

/** True bearing (0..360) the vector points towards. */
export const bearingOf = (v: Vec) => norm360(Math.atan2(v.x, v.y) / D2R);
