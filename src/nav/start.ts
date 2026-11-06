import { Vec, sub, bearingOf } from './vec';
import { BoatCfg, Wind, LegSolution, Part, Rounding, Side, solveLeg, startLineInfo, StartLineInfo, roundsCorrectly } from './solve';

export type End = 'pin' | 'committee';

export interface StartRoute {
  end: End;
  first: Side;
  parts: Part[];
  /** Hours to the mark, including an extra tack if the route arrives on the wrong board for the rounding. */
  timeH: number;
  /** False when the last board turns the wrong way round the first mark. */
  roundsOk: boolean;
  /** Mark bearing (true) at the first tack, if there is one. */
  tackBearing?: number;
}

export interface StartStrategy {
  line: StartLineInfo;
  kind: LegSolution['kind'];
  routes: StartRoute[];
  /** Seconds the pin end gains over the committee end (negative: committee gains). */
  gainS: { wind: number; tide: number; total: number };
  favoured: End | 'even';
  best: StartRoute | null;
}

const legRoutes = (end: End, leg: LegSolution, rounding: Rounding | undefined, penaltyH: number): StartRoute[] => {
  const out: StartRoute[] = [];
  for (const parts of [leg.parts, leg.altParts ?? []]) {
    if (!parts.length) continue;
    const last = parts[parts.length - 1];
    const roundsOk = !rounding || roundsCorrectly(last.sail.cog, rounding);
    const sailed = parts.reduce((t, p) => t + p.hours, 0) + Math.max(0, parts.length - 1) * penaltyH;
    out.push({
      end, first: parts[0].sail.tack, parts, roundsOk,
      timeH: sailed + (roundsOk ? 0 : penaltyH),
      tackBearing: parts.length > 1 ? bearingOf(sub(leg.to, parts[0].end)) : undefined,
    });
  }
  return out;
};

/**
 * Which end of the line to start from, and on which board.
 * The gain of one end over the other is split into the part the wind gives (line bias, sailing the same
 * course in slack water) and the part the tide adds on top (the rest of the difference with the real stream).
 * Both first boards are kept for each end. A board that arrives at the mark on the wrong tack for its
 * rounding side is charged one extra tack.
 */
export function startStrategy(
  committee: Vec, pin: Vec, mark: Vec, wind: Wind, tide: Vec, boat: BoatCfg, rounding?: Rounding,
): StartStrategy {
  const line = startLineInfo(committee, pin, wind);
  const penaltyH = boat.tackPenaltySec / 3600;
  const calm = { x: 0, y: 0 };
  const legs = { pin: solveLeg(pin, mark, wind, tide, boat), committee: solveLeg(committee, mark, wind, tide, boat) };
  const still = { pin: solveLeg(pin, mark, wind, calm, boat), committee: solveLeg(committee, mark, wind, calm, boat) };
  const routes = [...legRoutes('pin', legs.pin, rounding, penaltyH), ...legRoutes('committee', legs.committee, rounding, penaltyH)];
  const fastest = (end: End) => Math.min(...routes.filter((r) => r.end === end).map((r) => r.timeH), Infinity);
  const wind_ = (still.committee.timeH - still.pin.timeH) * 3600;
  const total = (fastest('committee') - fastest('pin')) * 3600;
  const ok = isFinite(total);
  const gainS = { wind: isFinite(wind_) ? wind_ : NaN, tide: ok && isFinite(wind_) ? total - wind_ : NaN, total: ok ? total : NaN };
  const favoured: StartStrategy['favoured'] = !ok || Math.abs(total) < 2 ? 'even' : total > 0 ? 'pin' : 'committee';
  // Quickest route; within two seconds, prefer the favoured end and then starboard (right of way off the line).
  const sorted = [...routes].filter((r) => isFinite(r.timeH)).sort((a, b) => {
    if (Math.abs(a.timeH - b.timeH) * 3600 > 2) return a.timeH - b.timeH;
    if (a.end !== b.end && favoured !== 'even') return a.end === favoured ? -1 : 1;
    if (a.first !== b.first) return a.first === 'starboard' ? -1 : 1;
    return a.timeH - b.timeH;
  });
  return { line, kind: legs.pin.kind, routes, gainS, favoured, best: sorted[0] ?? null };
}
