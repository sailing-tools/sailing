export interface Polar {
  id: string;
  name: string;
  note: string;
  tws: number[]; // knots, ascending
  twa: number[]; // degrees 0..180, ascending
  stw: number[][]; // stw[twaIndex][twsIndex], knots
}

/**
 * Estimated polar for a Jeanneau Sun Odyssey 410 (12.4 m LOA, about 8.7 t, standard keel,
 * main + genoa upwind, gennaker off the wind). Shaped on ORC VPP output for 40-42 ft
 * production cruiser-racers. Replace with the boat's ORC certificate polar when available.
 */
export const JEANNEAU_410: Polar = {
  id: 'so410',
  name: 'Jeanneau Sun Odyssey 410 (estimated)',
  note: 'Estimated from ORC VPP data for similar 40-42 ft production cruisers. Import an ORC polar for real numbers.',
  tws: [6, 8, 10, 12, 14, 16, 20],
  twa: [0, 30, 36, 40, 45, 52, 60, 75, 90, 110, 120, 135, 150, 165, 180],
  stw: [
    [0, 0, 0, 0, 0, 0, 0],
    [2.4, 3.1, 3.7, 4.1, 4.3, 4.4, 4.5],
    [3.7, 4.6, 5.2, 5.6, 5.8, 5.9, 6.0],
    [4.4, 5.3, 5.9, 6.3, 6.5, 6.6, 6.7],
    [4.9, 5.8, 6.4, 6.7, 6.9, 7.0, 7.2],
    [5.4, 6.3, 6.9, 7.2, 7.4, 7.5, 7.7],
    [5.7, 6.7, 7.2, 7.5, 7.7, 7.8, 8.0],
    [6.0, 7.0, 7.5, 7.8, 8.0, 8.2, 8.4],
    [6.1, 7.1, 7.6, 7.9, 8.2, 8.4, 8.8],
    [5.9, 7.0, 7.6, 8.0, 8.3, 8.7, 9.3],
    [5.6, 6.7, 7.4, 7.8, 8.2, 8.6, 9.4],
    [4.9, 6.0, 6.9, 7.4, 7.8, 8.2, 9.0],
    [4.1, 5.2, 6.2, 6.9, 7.3, 7.7, 8.5],
    [3.6, 4.6, 5.6, 6.4, 7.0, 7.4, 8.2],
    [3.2, 4.2, 5.1, 5.9, 6.6, 7.1, 8.0],
  ],
};

function bracket(arr: number[], v: number): [number, number, number] {
  if (v <= arr[0]) return [0, 0, 0];
  const n = arr.length - 1;
  if (v >= arr[n]) return [n, n, 0];
  let i = 0;
  while (arr[i + 1] < v) i++;
  return [i, i + 1, (v - arr[i]) / (arr[i + 1] - arr[i])];
}

/** Boat speed through water for a true wind angle (either side) and true wind speed. */
export function polarSpeed(p: Polar, twaDeg: number, tws: number): number {
  const a = Math.min(180, Math.abs(twaDeg));
  if (tws <= 0) return 0;
  const lowTws = p.tws[0];
  const scale = tws < lowTws ? tws / lowTws : 1;
  const w = Math.min(Math.max(tws, lowTws), p.tws[p.tws.length - 1]);
  const [i0, i1, ft] = bracket(p.twa, a);
  const [j0, j1, fw] = bracket(p.tws, w);
  const s00 = p.stw[i0][j0], s01 = p.stw[i0][j1], s10 = p.stw[i1][j0], s11 = p.stw[i1][j1];
  const s0 = s00 + (s01 - s00) * fw;
  const s1 = s10 + (s11 - s10) * fw;
  return (s0 + (s1 - s0) * ft) * scale;
}

export interface Optimum { twa: number; stw: number; vmg: number }

const cache = new Map<string, { up: Optimum; down: Optimum }>();

/** Best upwind and downwind VMG angles at a given wind speed. */
export function optimalAngles(p: Polar, tws: number) {
  const key = `${p.id}:${tws.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let up: Optimum = { twa: 45, stw: 0, vmg: -Infinity };
  let down: Optimum = { twa: 180, stw: 0, vmg: -Infinity };
  for (let a = 25; a <= 90; a += 0.5) {
    const s = polarSpeed(p, a, tws);
    const vmg = s * Math.cos((a * Math.PI) / 180);
    if (vmg > up.vmg) up = { twa: a, stw: s, vmg };
  }
  for (let a = 90; a <= 180; a += 0.5) {
    const s = polarSpeed(p, a, tws);
    const vmg = -s * Math.cos((a * Math.PI) / 180);
    if (vmg > down.vmg + 1e-9) down = { twa: a, stw: s, vmg };
  }
  const res = { up, down };
  if (cache.size > 2000) cache.clear();
  cache.set(key, res);
  return res;
}

/**
 * Parse a polar from text. Accepts the common "TWA/TWS" grid: first row is wind speeds,
 * each following row is a TWA followed by boat speeds. Separators: tab, semicolon, comma or spaces.
 */
export function parsePolar(text: string, name: string): Polar {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/[\t;, ]+/).filter(Boolean));
  if (rows.length < 3) throw new Error('Need a header row of wind speeds and at least two angle rows.');
  const header = rows[0].slice(1).map(Number);
  if (header.some((n) => !isFinite(n))) throw new Error('First row must be "TWA" then wind speeds in knots.');
  const twa: number[] = [];
  const stw: number[][] = [];
  for (const r of rows.slice(1)) {
    const nums = r.map(Number);
    if (nums.some((n) => !isFinite(n))) continue;
    twa.push(nums[0]);
    stw.push(header.map((_, j) => nums[j + 1] ?? 0));
  }
  if (twa[0] !== 0) {
    twa.unshift(0);
    stw.unshift(header.map(() => 0));
  }
  return { id: 'custom-' + name, name, note: 'Imported polar', tws: header, twa, stw };
}
