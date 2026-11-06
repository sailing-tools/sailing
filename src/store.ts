import * as React from 'react';
import { Vec } from './nav/vec';
import { Conditions, Strategy } from './nav/solve';
import { Polar } from './nav/polar';

export interface Mark { id: string; name: string; pos: Vec }

export type Tool = 'select' | 'start' | 'mark' | 'probe';

export interface AppState {
  cond: Conditions;
  leewayDeg: number;
  tackPenaltySec: number;
  upTwa: number | null;
  strategy: Strategy;
  customPolar: Polar | null;
  startLine: { committee: Vec; pin: Vec } | null;
  pendingCommittee: Vec | null;
  marks: Mark[];
  finishAtStart: boolean;
  base: 'chart' | 'grid';
  tool: Tool;
  selectedLeg: number;
  probe: Vec | null;
  layers: { laylines: boolean; allLaylines: boolean; triangles: boolean; tide: boolean; bothRoutes: boolean; startOptions: boolean };
  vectorMin: number;
  view: { cx: number; cy: number; scale: number }; // scale = px per nm
}

// Default course in the central Solent off Cowes. Positions in nm from the Cowes origin.
export const initialState: AppState = {
  cond: { windFrom: 250, windKn: 12, windRef: 'ground', tideTo: 80, tideKn: 1.8 },
  leewayDeg: 0,
  tackPenaltySec: 15,
  upTwa: null,
  strategy: { mode: 'laylines', margin: 0.25, maxTacks: 4 },
  customPolar: null,
  startLine: { committee: { x: 3.16, y: 1.61 }, pin: { x: 3.22, y: 1.38 } },
  pendingCommittee: null,
  marks: [
    { id: 'm1', name: 'Windward', pos: { x: 1.0, y: 0.9 } },
    { id: 'm2', name: 'Wing', pos: { x: 2.0, y: 1.9 } },
  ],
  finishAtStart: true,
  base: 'chart',
  tool: 'select',
  selectedLeg: 0,
  probe: null,
  layers: { laylines: true, allLaylines: true, triangles: true, tide: true, bothRoutes: true, startOptions: true },
  vectorMin: 6,
  view: { cx: 2.1, cy: 1.3, scale: 260 },
};

const KEY = 'solent-race-calc-v3';
const PERSIST: (keyof AppState)[] = [
  'cond', 'leewayDeg', 'tackPenaltySec', 'upTwa', 'strategy', 'customPolar', 'startLine', 'marks', 'finishAtStart', 'base', 'layers', 'vectorMin',
];

function load(): AppState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { const o = JSON.parse(raw); return { ...initialState, ...o, layers: { ...initialState.layers, ...(o.layers || {}) } }; }
  } catch { /* storage unavailable */ }
  return initialState;
}

let state: AppState = load();
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

const snapKeys: (keyof AppState)[] = ['cond', 'startLine', 'marks', 'finishAtStart', 'leewayDeg', 'tackPenaltySec', 'upTwa', 'strategy'];
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
