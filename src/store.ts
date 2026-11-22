import * as React from 'react';
import { Vec } from './nav/vec';
import { Conditions, Strategy } from './nav/solve';
import { Polar } from './nav/polar';

/** rounding: which side the mark is left on. Absent means port, the usual default. */
export interface Mark { id: string; name: string; pos: Vec; rounding?: 'port' | 'starboard'; /** SCRA code when taken from the Solent marks list. */ code?: string }

export type Tool = 'select' | 'start' | 'mark' | 'probe';

export interface AppState {
  cond: Conditions;
  leewayDeg: number;
  /** Boat speed as a percentage of the polar (100 = as published). */
  speedPct?: number;
  tackPenaltySec: number;
  upTwa: number | null;
  strategy: Strategy;
  /** Seconds you'd give up at the start to stay off the laylines and up-tide. */
  startAllowanceSec: number;
  customPolar: Polar | null;
  startLine: { committee: Vec; pin: Vec } | null;
  pendingCommittee: Vec | null;
  marks: Mark[];
  finishAtStart: boolean;
  base: 'chart' | 'grid';
  tool: Tool;
  selectedLeg: number;
  /** A board picked on the chart or in the tacking table: its leg and index in that leg's parts. */
  selectedTack: { leg: number; idx: number } | null;
  probe: Vec | null;
  layers: { laylines: boolean; allLaylines: boolean; triangles: boolean; tide: boolean; wind: boolean; bothRoutes: boolean; startOptions: boolean; racingMarks: boolean; track?: boolean };
  /** An imported GPS track: positions in nm on the local plane, t in seconds from the first fix. */
  track?: { name: string; startUnix: number; fixes: { t: number; x: number; y: number }[]; /** Gun time in seconds from the first fix; absent means found from the start line. */ gunT?: number; /** Upwind TWA to analyse with; absent means the boat's. */ twa?: number } | null;
  vectorMin: number;
  view: { cx: number; cy: number; scale: number }; // scale = px per nm
}

// Default course in the central Solent off Cowes (George's set-up, 2026-11-06). Positions in nm from the Cowes origin.
export const initialState: AppState = {
  cond: { windFrom: 29, windKn: 12.6, windRef: 'ground', tideTo: 89, tideKn: 2 },
  leewayDeg: 0,
  speedPct: 100,
  tackPenaltySec: 15,
  upTwa: 50,
  strategy: { mode: 'lane', margin: 0.2, maxTacks: 2 },
  startAllowanceSec: 30,
  customPolar: null,
  startLine: { committee: { x: 2.488, y: 0.039 }, pin: { x: 1.973, y: -0.058 } },
  pendingCommittee: null,
  marks: [
    { id: 'm1', name: 'Windward', pos: { x: 2.68, y: 2.106 }, rounding: 'port' },
    { id: 'm2', name: 'Wing', pos: { x: 0.975, y: 1.324 }, rounding: 'port' },
  ],
  finishAtStart: true,
  base: 'chart',
  tool: 'select',
  selectedLeg: 0,
  selectedTack: null,
  probe: null,
  layers: { laylines: true, allLaylines: true, triangles: true, tide: true, wind: true, bothRoutes: true, startOptions: true, racingMarks: true, track: true },
  track: null,
  vectorMin: 6,
  view: { cx: 1.8, cy: 1.0, scale: 260 },
};

const KEY = 'solent-race-calc-v3';
const PERSIST: (keyof AppState)[] = [
  'cond', 'leewayDeg', 'speedPct', 'tackPenaltySec', 'upTwa', 'strategy', 'startAllowanceSec', 'customPolar', 'startLine', 'marks', 'finishAtStart', 'base', 'layers', 'vectorMin', 'track',
];

function load(): AppState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { const o = JSON.parse(raw); return { ...initialState, ...o, layers: { ...initialState.layers, ...(o.layers || {}) } }; }
  } catch { /* storage unavailable */ }
  return initialState;
}

/** The parts of the set-up that a course link carries. */
const SHARE: (keyof AppState)[] = ['cond', 'startLine', 'marks', 'finishAtStart', 'upTwa', 'strategy', 'startAllowanceSec', 'leewayDeg', 'speedPct', 'tackPenaltySec'];
export const SITE_URL = 'https://sailing.georgejacques.com/';

export function courseLink(s: AppState = state) {
  const o: Partial<AppState> = {};
  for (const k of SHARE) (o as any)[k] = s[k];
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${SITE_URL}#c=${b64}`;
}

/** Read a course from a #c=... link, or null. */
export function parseCourseHash(hash: string): Partial<AppState> | null {
  const m = /[#&]c=([A-Za-z0-9_-]+)/.exec(hash);
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const o = JSON.parse(decodeURIComponent(escape(atob(b64))));
    const out: Partial<AppState> = {};
    for (const k of SHARE) if (k in o) (out as any)[k] = o[k];
    return out;
  } catch { return null; }
}

function fromLink(base: AppState): AppState {
  try {
    const o = parseCourseHash(location.hash);
    if (!o) return base;
    history.replaceState(null, '', location.pathname + location.search);
    return { ...base, ...o, selectedLeg: 0, probe: null };
  } catch { return base; }
}

let state: AppState = fromLink(load());

// A course link opened while the app is already open in this tab only changes the hash, so load it then too.
if (typeof window !== 'undefined') window.addEventListener('hashchange', () => {
  if (!parseCourseHash(location.hash)) return;
  checkpoint();
  setState(fromLink(state));
  window.dispatchEvent(new Event('course-loaded'));
});
const listeners = new Set<() => void>();
const undoStack: string[] = [];
let saveTimer: number | undefined;

function save() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      const o: Partial<AppState> = {};
      for (const k of PERSIST) (o as any)[k] = state[k];
      localStorage.setItem(KEY, JSON.stringify(o));
    } catch { /* ignore */ }
  }, 300);
}

export function getState() { return state; }

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((l) => l());
  save();
}

const snapKeys: (keyof AppState)[] = ['cond', 'startLine', 'marks', 'finishAtStart', 'leewayDeg', 'speedPct', 'tackPenaltySec', 'upTwa', 'strategy', 'startAllowanceSec'];
/** Call before a user edit that should be undoable. */
export function checkpoint() {
  const o: Partial<AppState> = {};
  for (const k of snapKeys) (o as any)[k] = state[k];
  const s = JSON.stringify(o);
  if (undoStack[undoStack.length - 1] !== s) undoStack.push(s);
  if (undoStack.length > 50) undoStack.shift();
}
export function undo() {
  const s = undoStack.pop();
  if (s) setState(JSON.parse(s));
}
export function canUndo() { return undoStack.length > 0; }

export function resetAll() {
  checkpoint();
  setState({ ...initialState });
}

export function useApp<T>(sel: (s: AppState) => T): T {
  return React.useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => sel(state),
  );
}

let idn = 0;
export const newId = () => 'm' + Date.now().toString(36) + (idn++).toString(36);

// ----- Named courses saved in this browser -----
const SAVED_KEY = 'solent-race-calc-courses';
export interface SavedCourse { name: string; savedAt: number; data: Partial<AppState> }

export function listCourses(): SavedCourse[] {
  try { const a = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
function writeCourses(a: SavedCourse[]) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(a)); return true; } catch { return false; }
}
/** Save the course, wind, tide and boat settings under a name, replacing any with the same name. */
export function saveCourse(name: string): boolean {
  const data: Partial<AppState> = {};
  for (const k of SHARE) (data as any)[k] = state[k];
  const rest = listCourses().filter((c) => c.name.toLowerCase() !== name.toLowerCase());
  return writeCourses([{ name, savedAt: Date.now(), data }, ...rest]);
}
export function loadCourse(name: string) {
  const c = listCourses().find((x) => x.name === name);
  if (!c) return;
  checkpoint();
  setState({ ...c.data, selectedLeg: 0, selectedTack: null, probe: null });
}
export function deleteCourse(name: string) { writeCourses(listCourses().filter((c) => c.name !== name)); }
