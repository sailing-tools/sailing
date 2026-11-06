import * as React from 'react';
import { useApp, setState, getState, checkpoint, newId, AppState } from '../store';
import { useCourse, LAND_PATH, toLonLat, toXY, fmtDeg, fmtTime, CourseModel, tackNarrative } from '../course';
import { Vec, add, mul, sub, len, mid, fromBearing, bearingOf, norm180, D2R } from '../nav/vec';
import { LegSolution, Sailing } from '../nav/solve';
import { SOLENT_MARKS, RacingMark } from '../data/solentMarks';
import { solentPos, solentToMark, colourName, fmtLatLon } from '../marks';

type Drag =
  | { kind: 'pan'; start: Vec; view: AppState['view']; moved: boolean; legIdx: number | null; tackIdx: number | null; onLine: boolean; lib: string | null }
  | { kind: 'mark'; id: string }
  | { kind: 'committee'; start?: Vec; moved?: boolean }
  | { kind: 'pin'; start?: Vec; moved?: boolean }
  | { kind: 'probe' }
  | { kind: 'pinch'; d0: number; c0: Vec; view: AppState['view'] };

export function Chart() {
  const svgRef = React.useRef<SVGSVGElement>(null);
  const [size, setSize] = React.useState({ w: 800, h: 600 });
  const view = useApp((s) => s.view);
  const base = useApp((s) => s.base);
  const tool = useApp((s) => s.tool);
  const marks = useApp((s) => s.marks);
  const startLine = useApp((s) => s.startLine);
  const pendingCommittee = useApp((s) => s.pendingCommittee);
  const layers = useApp((s) => s.layers);
  const selectedLeg = useApp((s) => s.selectedLeg);
  const probe = useApp((s) => s.probe);
  const vectorMin = useApp((s) => s.vectorMin);
  const selTack = useApp((s) => s.selectedTack);
  const course = useCourse();
  const [lineCard, setLineCard] = React.useState(false);
  const [libCard, setLibCard] = React.useState<string | null>(null);
  React.useEffect(() => { if (selTack) setLineCard(false); }, [selTack]);
  const toggleLineCard = () => setLineCard((v) => { if (!v) setState({ selectedTack: null }); return !v; });

  React.useLayoutEffect(() => {
    const el = svgRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const { w, h } = size;
  const k = view.scale;
  const toS = (p: Vec): Vec => ({ x: w / 2 + (p.x - view.cx) * k, y: h / 2 - (p.y - view.cy) * k });
  const fromS = (p: Vec): Vec => ({ x: view.cx + (p.x - w / 2) / k, y: view.cy - (p.y - h / 2) / k });

  // ----- pointer handling -----
  const pointers = React.useRef(new Map<number, Vec>());
  const drag = React.useRef<Drag | null>(null);
  const local = (e: { clientX: number; clientY: number }): Vec => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const beginHandle = (e: React.PointerEvent, d: Drag) => {
    if (getState().tool !== 'select' && d.kind !== 'probe') return;
    e.stopPropagation();
    checkpoint();
    svgRef.current!.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    drag.current = d.kind === 'committee' || d.kind === 'pin' ? { ...d, start: local(e), moved: false } : d;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    svgRef.current!.setPointerCapture(e.pointerId);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      drag.current = { kind: 'pinch', d0: len(sub(a, b)), c0: mid(a, b), view: getState().view };
      return;
    }
    const legEl = (e.target as Element).closest?.('[data-leg]');
    const tackEl = (e.target as Element).closest?.('[data-tack]');
    drag.current = {
      kind: 'pan', start: p, view: getState().view, moved: false,
      legIdx: legEl ? Number(legEl.getAttribute('data-leg')) : tackEl ? Number(tackEl.getAttribute('data-tleg')) : null,
      tackIdx: tackEl ? Number(tackEl.getAttribute('data-tack')) : null,
      onLine: !!(e.target as Element).closest?.('[data-startline]'),
      lib: (e.target as Element).closest?.('[data-lib]')?.getAttribute('data-lib') ?? null,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const d = drag.current;
    if (!d) return;
    const v = getState().view;
    const fromSv = (q: Vec): Vec => ({ x: v.cx + (q.x - w / 2) / v.scale, y: v.cy - (q.y - h / 2) / v.scale });
    if (d.kind === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const scale = clampScale(d.view.scale * (len(sub(a, b)) / Math.max(1, d.d0)));
      const c = mid(a, b);
      const w0 = { x: d.view.cx + (d.c0.x - w / 2) / d.view.scale, y: d.view.cy - (d.c0.y - h / 2) / d.view.scale };
      setState({ view: { scale, cx: w0.x - (c.x - w / 2) / scale, cy: w0.y + (c.y - h / 2) / scale } });
    } else if (d.kind === 'pan') {
      const dx = p.x - d.start.x, dy = p.y - d.start.y;
      if (!d.moved && Math.hypot(dx, dy) > 5) d.moved = true;
      if (d.moved) setState({ view: { ...d.view, cx: d.view.cx - dx / d.view.scale, cy: d.view.cy + dy / d.view.scale } });
    } else if (d.kind === 'mark') {
      const pos = fromSv(p);
      setState((s) => ({ marks: s.marks.map((m) => (m.id === d.id ? { ...m, pos } : m)) }));
    } else if (d.kind === 'committee' || d.kind === 'pin') {
      // A small wobble is a tap (show the line's length and bearing), not a drag.
      if (!d.moved && d.start && Math.hypot(p.x - d.start.x, p.y - d.start.y) <= 5) return;
      d.moved = true;
      const pos = fromSv(p);
      setState((s) => (s.startLine ? { startLine: { ...s.startLine, [d.kind]: pos } } : {}));
    } else if (d.kind === 'probe') {
      setState({ probe: fromSv(p) });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const d = drag.current;
    if (d?.kind === 'pinch') { drag.current = null; return; }
    drag.current = null;
    if ((d?.kind === 'committee' || d?.kind === 'pin') && !d.moved) { if (getState().tool === 'select') toggleLineCard(); return; }
    if (!d || d.kind !== 'pan' || d.moved) return;
    // A tap
    const pos = fromS(local(e));
    const s = getState();
    if (s.tool === 'mark') {
      checkpoint();
      const n = s.marks.length + 1;
      const lm = d.lib ? SOLENT_MARKS.find((m) => m.code === d.lib) : undefined;
      setState({ marks: [...s.marks, lm ? solentToMark(lm) : { id: newId(), name: `Mark ${n}`, pos }] }); // snap to a Solent mark
    } else if (s.tool === 'start') {
      if (!s.pendingCommittee) setState({ pendingCommittee: pos });
      else {
        checkpoint();
        setState({ startLine: { committee: s.pendingCommittee, pin: pos }, pendingCommittee: null, tool: 'select' });
      }
    } else if (s.tool === 'probe') {
      setState({ probe: pos });
    } else if (d.lib) {
      setLineCard(false);
      if (s.selectedTack) setState({ selectedTack: null });
      setLibCard(libCard === d.lib ? null : d.lib);
    } else if (d.onLine) {
      setLibCard(null);
      toggleLineCard();
    } else if (d.tackIdx !== null && d.legIdx !== null) {
      const cur = s.selectedTack;
      const same = cur && cur.leg === d.legIdx && cur.idx === d.tackIdx;
      setState({ selectedLeg: d.legIdx, selectedTack: same ? null : { leg: d.legIdx, idx: d.tackIdx } });
    } else if (d.legIdx !== null) {
      setState({ selectedLeg: d.legIdx, selectedTack: s.selectedLeg === d.legIdx ? s.selectedTack : null });
    } else {
      if (s.selectedTack) setState({ selectedTack: null });
      setLineCard(false);
      setLibCard(null);
    }
  };

  React.useEffect(() => {
    const el = svgRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const c = { x: e.clientX - r.left, y: e.clientY - r.top };
      const v = getState().view;
      const ww = el.clientWidth, hh = el.clientHeight;
      const w0 = { x: v.cx + (c.x - ww / 2) / v.scale, y: v.cy - (c.y - hh / 2) / v.scale };
      const scale = clampScale(v.scale * Math.exp(-e.deltaY * 0.0015));
      setState({ view: { scale, cx: w0.x - (c.x - ww / 2) / scale, cy: w0.y + (c.y - hh / 2) / scale } });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ----- drawing helpers -----
  const vecT = vectorMin / 60; // hours represented by a drawn vector
  const P = (p: Vec) => { const s = toS(p); return `${s.x.toFixed(1)},${s.y.toFixed(1)}`; };
  const line = (a: Vec, b: Vec, cls: string, extra: React.SVGProps<SVGLineElement> = {}) => {
    const A = toS(a), B = toS(b);
    return <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} className={cls} {...extra} />;
  };

  const triangle = (at: Vec, sail: Sailing, tide: Vec, key: string, faint = false) => {
    const tipW = add(at, mul(sail.water, vecT));
    const tipG = add(at, mul(sail.ground, vecT));
    return (
      <g key={key} className={faint ? 'faint' : ''}>
        {line(at, tipW, 'v-water', { markerEnd: 'url(#ah-water)' })}
        {len(tide) > 0.02 && line(tipW, tipG, 'v-tide', { markerEnd: 'url(#ah-tide)' })}
        {line(at, tipG, 'v-ground', { markerEnd: 'url(#ah-ground)' })}
      </g>
    );
  };

  // Tack labels on a multi-tack leg are dropped where they would crowd the mark or each other.
  const tackLabelAt: Vec[] = [];
  const roomFor = (p: Vec, markS: Vec) => {
    if (len(sub(p, markS)) < 45 || tackLabelAt.some((q) => len(sub(p, q)) < 40)) return false;
    tackLabelAt.push(p);
    return true;
  };

  const legLayer = (leg: LegSolution, i: number) => {
    const sel = i === selectedLeg;
    if (sel) tackLabelAt.length = 0;
    const A = toS(leg.from), B = toS(leg.to);
    const m = mid(A, B);
    const showLay = layers.laylines && leg.laylines && (sel || layers.allLaylines) && (leg.kind === 'beat' || leg.kind === 'run' || leg.kind === 'blocked');
    const layLen = Math.max(leg.dist * 1.3, 0.6);
    return (
      <g key={'leg' + i} className={sel ? 'leg sel' : 'leg'}>
        {showLay && (
          <g>
            {line(leg.to, add(leg.to, mul(leg.laylines!.starboard, layLen)), 'layline stbd')}
            {line(leg.to, add(leg.to, mul(leg.laylines!.port, layLen)), 'layline port')}
            {sel && label(add(leg.to, mul(leg.laylines!.starboard, Math.min(layLen, 170 / k))), `Starboard layline (CoG ${fmtDeg(bearingOf(mul(leg.laylines!.starboard, -1)))})`, 'lbl stbd-t layline-t')}
            {sel && label(add(leg.to, mul(leg.laylines!.port, Math.min(layLen, 230 / k))), `Port layline (CoG ${fmtDeg(bearingOf(mul(leg.laylines!.port, -1)))})`, 'lbl port-t layline-t')}
          </g>
        )}
        <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} className="rhumb" />
        {sel && leg.lane && (leg.kind === 'beat' || leg.kind === 'run') && (
          <g>
            {line(leg.to, add(leg.to, mul(leg.lane.starboard, layLen)), 'layline inner stbd')}
            {line(leg.to, add(leg.to, mul(leg.lane.port, layLen)), 'layline inner port')}
            {label(add(leg.to, mul(leg.lane.starboard, Math.min(layLen, 300 / k))), `${Math.round(leg.lane.margin * 100)}% in from stbd layline`, 'lbl stbd-t layline-t inner-t')}
            {label(add(leg.to, mul(leg.lane.port, Math.min(layLen, 300 / k))), `${Math.round(leg.lane.margin * 100)}% in from port layline`, 'lbl port-t layline-t inner-t')}
          </g>
        )}
        {leg.parts.map((pt, j) => {
          const many = leg.parts.length > 2;
          const isTack = j < leg.parts.length - 1 && leg.kind !== 'reach';
          const tp = toS(pt.end);
          const picked = sel && selTack?.leg === i && selTack.idx === j;
          return (
            <g key={j}>
              {line(pt.start, pt.end, `track ${pt.sail.tack}${picked ? ' picked' : ''}`, { markerMid: undefined })}
              {sel && (!many || pt.hours * k * len(pt.sail.ground) > 90) && label(mid(pt.start, pt.end), `${leg.kind === 'reach' ? 'CoG' : pt.sail.tack === 'starboard' ? 'Stbd' : 'Port'} ${fmtDeg(pt.sail.cog)} · ${fmtTime(pt.hours)}`, 'lbl track-t', 10)}
              {sel && isTack && <circle cx={tp.x} cy={tp.y} r={picked ? 6 : 4.5} className={`tackdot ${pt.sail.tack}${picked ? ' picked' : ''}`} />}
              {picked && <circle cx={tp.x} cy={tp.y} r={11} className="tack-ring" />}
              {sel && isTack && (many ? roomFor(tp, toS(leg.to)) : !(i === 0 && layers.startOptions && course.start)) && label(pt.end, many ? `${leg.kind === 'beat' ? 'Tack' : 'Gybe'} ${j + 1} · mark ${fmtDeg(bearingOf(sub(leg.to, pt.end)))}` : `${pt.sail.tack === 'starboard' ? 'Stbd' : 'Port'} first: ${leg.kind === 'beat' ? 'tack' : 'gybe'} at ${fmtTime(pt.hours)} · mark ${fmtDeg(bearingOf(sub(leg.to, pt.end)))}`, 'lbl tackpt-t', -8)}
            </g>
          );
        })}
        {layers.bothRoutes && leg.altParts && (sel || layers.allLaylines) && leg.altParts.map((pt, j) => (
          <g key={'alt' + j}>
            {line(pt.start, pt.end, `track alt ${pt.sail.tack}`)}
            {sel && j === 0 && leg.parts.length <= 2 && !(i === 0 && layers.startOptions && course.start) && label(pt.end, `${pt.sail.tack === 'starboard' ? 'Stbd' : 'Port'} first: ${leg.kind === 'beat' ? 'tack' : 'gybe'} at ${fmtTime(pt.hours)} · mark ${fmtDeg(bearingOf(sub(leg.to, pt.end)))}`, 'lbl tackpt-t', -8)}
          </g>
        ))}
        {layers.triangles && leg.parts[0] && triangle(leg.from, leg.parts[0].sail, course.wind.tide, 'tri' + i, !sel)}
        <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} className="hit" data-leg={i} />
        <g transform={`translate(${m.x},${m.y})`} data-leg={i} className="legno">
          <circle r={9} />
          <text dy="0.35em">{i + 1}</text>
        </g>
      </g>
    );
  };

  // Tap targets for boards and tack points, drawn above every route line so nothing else catches the tap.
  // The selected leg goes last, on top.
  const tackHits = () => {
    const order = course.legs.map((_, i) => i).filter((i) => i !== selectedLeg);
    if (course.legs[selectedLeg]) order.push(selectedLeg);
    return order.map((i) => {
      const leg = course.legs[i];
      if (leg.kind !== 'beat' && leg.kind !== 'run') return null;
      return (
        <g key={'th' + i}>
          {leg.parts.map((pt, j) => {
            const S1 = toS(pt.start), S2 = toS(pt.end);
            return <line key={'b' + j} x1={S1.x} y1={S1.y} x2={S2.x} y2={S2.y} className="board-hit tackhit" data-tack={j} data-tleg={i} />;
          })}
          {/* Tack points sit above the boards: tapping one picks the board that ends there. */}
          {leg.parts.slice(0, -1).map((pt, j) => {
            const S2 = toS(pt.end);
            return <circle key={'t' + j} cx={S2.x} cy={S2.y} r={24} className="tack-hit tackhit" data-tack={j} data-tleg={i} />;
          })}
        </g>
      );
    });
  };

  const label = (p: Vec, text: string, cls: string, dy = 0) => {
    const s = toS(p);
    return <text x={s.x} y={s.y + dy} className={cls}>{text}</text>;
  };

  const landTransform = `matrix(${k} 0 0 ${k} ${w / 2 - view.cx * k} ${h / 2 + view.cy * k})`;

  return (
    <div className={`chart base-${base} tool-${tool}`}>
      <svg ref={svgRef} className="chart-svg" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} role="application" aria-label="Race chart">
        <Defs />
        <rect x={0} y={0} width={w} height={h} className="sea" />
        {base === 'chart' && <path d={LAND_PATH} transform={landTransform} className="land" vectorEffect="non-scaling-stroke" />}
        <Graticule base={base} w={w} h={h} toS={toS} fromS={fromS} />
        {layers.tide && <TideField w={w} h={h} tide={course.wind.tide} />}
        {course.legs.map(legLayer)}
        {layers.startOptions && course.startPlan && (course.startPlan.kind === 'beat' || course.startPlan.kind === 'run') && (
          <g className="start-opt">
            {course.startPlan.routes.map((r, ri) => {
              const best = r === course.startPlan!.best;
              // Leg 1 already draws the recommended route; the lane variants would crowd the chart.
              if (best || r.plan !== 'laylines') return null;
              return (
                <g key={'so' + ri} className={r.roundsOk ? '' : 'so-wrong'}>
                  {r.parts.map((pt, j) => <g key={j}>{line(pt.start, pt.end, `track opt ${pt.sail.tack}`)}</g>)}
                  {r.parts.length > 1 && (() => { const s2 = toS(r.parts[0].end); return <circle cx={s2.x} cy={s2.y} r={3} className={`tackdot ${r.parts[0].sail.tack}`} />; })()}
                </g>
              );
            })}
          </g>
        )}
        {probe && course.probeLeg && (
          <g className="probe">
            {course.probeLeg.parts.map((pt, j) => <g key={j}>{line(pt.start, pt.end, `track probe-track`)}</g>)}
            {course.probeLeg.parts[0] && triangle(probe, course.probeLeg.parts[0].sail, course.wind.tide, 'ptri')}
            <circle cx={toS(probe).x} cy={toS(probe).y} r={16} className="hit-handle" onPointerDown={(e) => beginHandle(e, { kind: 'probe' })} />
            <path d={`M${toS(probe).x - 7},${toS(probe).y}h14M${toS(probe).x},${toS(probe).y - 7}v14`} className="probe-x" />
            {label(probe, `${fmtTime(course.probeLeg.timeH)} to ${course.points[Math.min(selectedLeg + 1, course.points.length - 1)]?.label}`, 'lbl probe-t', -14)}
          </g>
        )}
        {layers.racingMarks && (
          <g className="libmarks">
            {SOLENT_MARKS.map((m) => {
              const q = toS(solentPos(m));
              if (q.x < -20 || q.y < -20 || q.x > w + 20 || q.y > h + 20) return null;
              return (
                <g key={m.code} data-lib={m.code} className={`libmark${libCard === m.code ? ' picked' : ''}`}>
                  <path d={`M${q.x},${q.y - 5}L${q.x + 5},${q.y}L${q.x},${q.y + 5}L${q.x - 5},${q.y}Z`} className={`libdot c-${m.colour[0]}`} />
                  {k >= 120 && <text x={q.x + 7} y={q.y + 3.5} className="lbl lib-t">{m.code}</text>}
                  {(tool === 'select' || tool === 'mark') && <circle cx={q.x} cy={q.y} r={13} className="lib-hit" />}
                </g>
              );
            })}
          </g>
        )}
        {tool === 'select' && startLine && line(startLine.committee, startLine.pin, 'hit start-hit', { 'data-startline': '1' } as React.SVGProps<SVGLineElement>)}
        {tool === 'select' && <g className="tackhits">{tackHits()}</g>}
        {startLine && (
          <g className="startline">
            {line(startLine.committee, startLine.pin, `start-line${lineCard ? ' picked' : ''}`)}
            <rect x={toS(startLine.committee).x - 6} y={toS(startLine.committee).y - 6} width={12} height={12} className="committee" />
            <circle cx={toS(startLine.pin).x} cy={toS(startLine.pin).y} r={5.5} className="pin" />
            {label(startLine.committee, 'Committee', 'lbl handle-t', -12)}
            {label(startLine.pin, 'Pin', 'lbl handle-t', -12)}
            <circle cx={toS(startLine.committee).x} cy={toS(startLine.committee).y} r={18} className="hit-handle" onPointerDown={(e) => beginHandle(e, { kind: 'committee' })} />
            <circle cx={toS(startLine.pin).x} cy={toS(startLine.pin).y} r={18} className="hit-handle" onPointerDown={(e) => beginHandle(e, { kind: 'pin' })} />
          </g>
        )}
        {pendingCommittee && <rect x={toS(pendingCommittee).x - 6} y={toS(pendingCommittee).y - 6} width={12} height={12} className="committee pending" />}
        {marks.map((m) => {
          const s = toS(m.pos);
          return (
            <g key={m.id} className="mark">
              <RoundingArrow x={s.x} y={s.y} side={m.rounding ?? 'port'} />
              <circle cx={s.x} cy={s.y} r={7} className="buoy" />
              <text x={s.x + 11} y={s.y - 9} className="lbl mark-t">{m.name}</text>
              <circle cx={s.x} cy={s.y} r={18} className="hit-handle" onPointerDown={(e) => beginHandle(e, { kind: 'mark', id: m.id })} />
            </g>
          );
        })}
        <ScaleBar k={k} h={h} />
      </svg>
      <WindRose course={course} />
      <Hint tool={tool} pending={!!pendingCommittee} />
      {tool === 'select' && libCard && (() => { const m = SOLENT_MARKS.find((x) => x.code === libCard); return m ? <RacingMarkCard m={m} onClose={() => setLibCard(null)} /> : null; })()}
      {tool === 'select' && lineCard && startLine && <StartLineCard committee={startLine.committee} pin={startLine.pin} course={course} onClose={() => setLineCard(false)} />}
      {tool === 'select' && selTack && <TackCard course={course} leg={selTack.leg} idx={selTack.idx} />}
      <div className="attrib">{base === 'chart' ? 'Coastline: ONS boundaries, OGL. Not for navigation.' : 'Grid in nautical miles from Cowes'}</div>
    </div>
  );
}

/** Three-quarter arc round a mark, arrow showing the way round: anticlockwise for port, clockwise for starboard. */
function RoundingArrow({ x, y, side }: { x: number; y: number; side: 'port' | 'starboard' }) {
  const r = 13;
  const port = side === 'port';
  // Screen y points down, so sweep-flag 0 is anticlockwise on screen.
  const a0 = port ? -0.25 * Math.PI : 1.25 * Math.PI, a1 = port ? -1.75 * Math.PI : 2.75 * Math.PI;
  const P = (a: number) => `${(x + r * Math.cos(a)).toFixed(1)},${(y + r * Math.sin(a)).toFixed(1)}`;
  return (
    <path d={`M${P(a0)} A${r},${r} 0 1 ${port ? 0 : 1} ${P(a1)}`} className={`rounding ${side}`} markerEnd={`url(#ah-round-${side})`}>
      <title>Leave to {side}</title>
    </path>
  );
}

const clampScale = (s: number) => Math.min(6000, Math.max(20, s));

function Defs() {
  // Arrowheads follow the RYA convention: water track one head, ground track two, tide three.
  const chev = (n: number) => Array.from({ length: n }, (_, i) => `M${-i * 5 - 8},-4 L${-i * 5},0 L${-i * 5 - 8},4`).join(' ');
  return (
    <defs>
      {(['water', 'ground', 'tide'] as const).map((t, i) => (
        <marker key={t} id={`ah-${t}`} viewBox="-20 -6 22 12" refX={0} refY={0} markerWidth={22} markerHeight={12} markerUnits="userSpaceOnUse" orient="auto">
          <path d={chev([1, 2, 3][i])} className={`ah ah-${t}`} />
        </marker>
      ))}
      {(['port', 'starboard'] as const).map((sd) => (
        <marker key={sd} id={`ah-round-${sd}`} viewBox="-8 -5 9 10" refX={0} refY={0} markerWidth={8} markerHeight={8} markerUnits="userSpaceOnUse" orient="auto">
          <path d="M-7,-3.5 L0,0 L-7,3.5" className={`ah-round ${sd}`} />
        </marker>
      ))}
      <marker id="td-ah" viewBox="-8 -5 9 10" refX={0} refY={0} markerWidth={8} markerHeight={8} markerUnits="userSpaceOnUse" orient="auto">
        <path d="M-7,-3.5 L0,0 L-7,3.5" className="ah-td" />
      </marker>
      <marker id="ah-small" viewBox="-10 -5 11 10" refX={0} refY={0} markerWidth={10} markerHeight={9} markerUnits="userSpaceOnUse" orient="auto">
        <path d="M-8,-3.5 L0,0 L-8,3.5" className="ah ah-tidefield" />
      </marker>
    </defs>
  );
}

function niceStep(target: number, steps: number[]) {
  for (const s of steps) if (s >= target) return s;
  return steps[steps.length - 1];
}

function Graticule({ base, w, h, toS, fromS }: { base: string; w: number; h: number; toS: (p: Vec) => Vec; fromS: (p: Vec) => Vec }) {
  const tl = fromS({ x: 0, y: 0 });
  const br = fromS({ x: w, y: h });
  const els: React.ReactNode[] = [];
  if (base === 'grid') {
    const pxPerNm = w / (br.x - tl.x);
    const step = niceStep(90 / pxPerNm, [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10]);
    for (let x = Math.ceil(tl.x / step) * step; x <= br.x; x += step) {
      const s = toS({ x, y: 0 });
      const major = Math.abs(Math.round(x / (step * 2)) * step * 2 - x) < 1e-9;
      els.push(<line key={'gx' + x.toFixed(3)} x1={s.x} y1={0} x2={s.x} y2={h} className={major ? 'grid major' : 'grid'} />);
      els.push(<text key={'tx' + x.toFixed(3)} x={s.x + 3} y={h - 6} className="grid-t">{x.toFixed(step < 0.1 ? 2 : step < 1 ? 2 : 0)}</text>);
    }
    for (let y = Math.ceil(br.y / step) * step; y <= tl.y; y += step) {
      const s = toS({ x: 0, y });
      const major = Math.abs(Math.round(y / (step * 2)) * step * 2 - y) < 1e-9;
      els.push(<line key={'gy' + y.toFixed(3)} x1={0} y1={s.y} x2={w} y2={s.y} className={major ? 'grid major' : 'grid'} />);
      els.push(<text key={'ty' + y.toFixed(3)} x={4} y={s.y - 3} className="grid-t">{y.toFixed(step < 1 ? 2 : 0)}</text>);
    }
  } else {
    // Latitude / longitude graticule in minutes
    const a = toLonLat(tl), b = toLonLat(br);
    const pxPerMinLat = (toS(toXY(0, ORIGIN_LAT + 1 / 60)).y - toS(toXY(0, ORIGIN_LAT)).y) * -1;
    const stepMin = niceStep(80 / Math.max(1e-6, pxPerMinLat), [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30]);
    const st = stepMin / 60;
    for (let lon = Math.ceil(a.lon / st) * st; lon <= b.lon; lon += st) {
      const s = toS(toXY(lon, a.lat));
      els.push(<line key={'lo' + lon.toFixed(5)} x1={s.x} y1={0} x2={s.x} y2={h} className="grid" />);
      els.push(<text key={'lot' + lon.toFixed(5)} x={s.x + 3} y={h - 6} className="grid-t">{dm(lon, 'EW')}</text>);
    }
    for (let lat = Math.ceil(b.lat / st) * st; lat <= a.lat; lat += st) {
      const s = toS(toXY(a.lon, lat));
      els.push(<line key={'la' + lat.toFixed(5)} x1={0} y1={s.y} x2={w} y2={s.y} className="grid" />);
      els.push(<text key={'lat' + lat.toFixed(5)} x={4} y={s.y - 3} className="grid-t">{dm(lat, 'NS')}</text>);
    }
  }
  return <g>{els}</g>;
}
const ORIGIN_LAT = 50.766;

function dm(v: number, hemi: string) {
  const H = v >= 0 ? hemi[0] : hemi[1];
  const a = Math.abs(v);
  let d = Math.floor(a);
  let m = (a - d) * 60;
  if (m > 59.95) { d += 1; m = 0; }
  return `${d}°${m.toFixed(m % 1 < 0.05 || m % 1 > 0.95 ? 0 : 1).padStart(2, '0')}′${H}`;
}

function TideField({ w, h, tide }: { w: number; h: number; tide: Vec }) {
  const rate = len(tide);
  if (rate < 0.05) return null;
  const gap = 120;
  const L = Math.min(40, 10 + rate * 9);
  const dir = { x: tide.x / rate, y: -tide.y / rate };
  const els: React.ReactNode[] = [];
  for (let y = gap / 2; y < h; y += gap) {
    for (let x = gap / 2 + ((y / gap) % 2 ? gap / 2 : 0); x < w; x += gap) {
      els.push(<line key={x + ':' + y} x1={x - (dir.x * L) / 2} y1={y - (dir.y * L) / 2} x2={x + (dir.x * L) / 2} y2={y + (dir.y * L) / 2} className="tidefield" markerEnd="url(#ah-small)" />);
    }
  }
  return <g aria-hidden>{els}</g>;
}

function ScaleBar({ k, h }: { k: number; h: number }) {
  const nm = niceStep(110 / k, [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10]);
  const px = nm * k;
  const labelTxt = nm < 0.1 ? `${Math.round(nm * 10)} cable` : nm < 1 ? `${Math.round(nm * 10)} cables` : `${nm} nm`;
  return (
    <g transform={`translate(14,${h - 34})`} className="scalebar">
      <rect x={0} y={0} width={px / 2} height={5} className="sb-a" />
      <rect x={px / 2} y={0} width={px / 2} height={5} className="sb-b" />
      <text x={0} y={-5} className="grid-t">{labelTxt}</text>
    </g>
  );
}

function WindRose({ course }: { course: CourseModel }) {
  const { ground, water } = course.wind;
  const R = 34;
  const arrow = (from: number, cls: string) => {
    const a = fromBearing(from, R - 4); // point on rim the wind comes from
    return <line x1={a.x} y1={-a.y} x2={-a.x * 0.35} y2={a.y * 0.35} className={cls} markerEnd="url(#rose-ah)" />;
  };
  const t = course.wind.tide;
  const tr = len(t);
  return (
    <div className="rose" aria-label="Wind and tide">
      <svg viewBox="-42 -42 84 84" width={84} height={84}>
        <defs>
          <marker id="rose-ah" viewBox="-10 -5 11 10" refX={0} refY={0} markerWidth={9} markerHeight={8} markerUnits="userSpaceOnUse" orient="auto">
            <path d="M-8,-3.5 L0,0 L-8,3.5" className="ah ah-wind" />
          </marker>
        </defs>
        <circle r={R} className="rose-ring" />
        {[0, 90, 180, 270].map((b) => { const p = fromBearing(b, R + 0.5); return <text key={b} x={p.x} y={-p.y} dy="0.35em" className="rose-t">{'NESW'[b / 90]}</text>; })}
        {arrow(ground.from, 'rose-ground')}
        {Math.abs(water.from - ground.from) > 0.5 || Math.abs(water.kn - ground.kn) > 0.05 ? arrow(water.from, 'rose-water') : null}
        {tr > 0.05 && <line x1={0} y1={0} x2={(t.x / tr) * 20} y2={(-t.y / tr) * 20} className="rose-tide" markerEnd="url(#ah-tide)" />}
      </svg>
      <div className="rose-text">
        <div><b>Wind</b> {fmtDeg(ground.from)} {ground.kn.toFixed(1)} kn</div>
        <div className="muted">on water {fmtDeg(water.from)} {water.kn.toFixed(1)} kn</div>
        <div className="tide-t"><b>Tide</b> {fmtDeg(bearingOf(t))} {tr.toFixed(1)} kn</div>
      </div>
    </div>
  );
}

/** A Solent racing mark tapped on the chart, with a button to add it to the course. */
function RacingMarkCard({ m, onClose }: { m: RacingMark; onClose: () => void }) {
  const marks = useApp((s) => s.marks);
  const inCourse = marks.some((x) => x.code === m.code);
  return (
    <div className="tackcard linecard" role="status" aria-live="polite">
      <div className="kv"><span><b>{m.code}</b> {m.name}</span><b>{colourName(m.colour)}</b></div>
      <div className="kv"><span>Position</span><b>{fmtLatLon(m.lat, m.lon)}</b></div>
      {m.note && <p className="small muted">{m.note}</p>}
      <div className="tackcard-nav">
        <button type="button" className="primary" style={{ marginRight: 'auto' }} onClick={() => { checkpoint(); setState({ marks: [...marks, solentToMark(m)] }); onClose(); }}>
          {inCourse ? 'Add to course again' : 'Add to course'}
        </button>
        <button type="button" onClick={onClose} aria-label="Close">×</button>
      </div>
    </div>
  );
}

/** Length and bearing of the start line, shown when the line or either end is tapped. */
function StartLineCard({ committee, pin, course, onClose }: { committee: Vec; pin: Vec; course: CourseModel; onClose: () => void }) {
  const d = sub(committee, pin);
  const m = len(d) * 1852;
  const brg = bearingOf(d);
  const info = course.start;
  return (
    <div className="tackcard linecard" role="status" aria-live="polite">
      <div className="kv"><span>Start line length</span><b>{Math.round(m)} m · {(m / 185.2).toFixed(1)} cables</b></div>
      <div className="kv"><span>Pin → committee</span><b>{fmtDeg(brg)}T</b></div>
      <div className="kv"><span>Committee → pin</span><b>{fmtDeg((brg + 180) % 360)}T</b></div>
      {info && (
        <div className="kv"><span>Bias to the wind on the water</span><b>{Math.abs(info.bias).toFixed(0)}° {info.favoured === 'square' ? '(square)' : `to ${info.favoured}`}</b></div>
      )}
      <div className="tackcard-nav">
        <span className="muted small" style={{ marginRight: 'auto' }}>Drag either end to move it.</span>
        <button type="button" onClick={onClose} aria-label="Close">×</button>
      </div>
    </div>
  );
}

function TackCard({ course, leg, idx }: { course: CourseModel; leg: number; idx: number }) {
  const l = course.legs[leg];
  if (!l || !l.parts[idx] || (l.kind !== 'beat' && l.kind !== 'run')) return null;
  const n = l.parts.length;
  const go = (j: number) => setState({ selectedTack: { leg, idx: j } });
  const to = course.points[leg + 1];
  const tp = l.parts[idx].end;
  const zoomTo = () => {
    const v = getState().view;
    setState({ view: { cx: tp.x, cy: tp.y, scale: Math.max(v.scale, Math.min(6000, v.scale * 3)) } });
  };
  return (
    <div className="tackcard" role="status" aria-live="polite">
      <TackDetail course={course} leg={l} idx={idx} markLabel={to?.label ?? 'Mark'} />
      <p>{tackNarrative(l, idx, to?.label ?? 'the mark', to?.rounding)}</p>
      <div className="tackcard-nav">
        <button type="button" className="zoom-btn" onClick={zoomTo}>Zoom chart here</button>
        <button type="button" onClick={() => go(idx - 1)} disabled={idx === 0} aria-label="Previous board">‹</button>
        <span>{idx + 1} / {n}</span>
        <button type="button" onClick={() => go(idx + 1)} disabled={idx === n - 1} aria-label="Next board">›</button>
        <button type="button" onClick={() => setState({ selectedTack: null })} aria-label="Close">×</button>
      </div>
    </div>
  );
}

/**
 * Close-up of one tack, north up and not to scale: the board in and out, the heading (CTW) the boat is on,
 * the line of sight to the mark, and the angle between them, with wind and tide for reference.
 */
function TackDetail({ course, leg, idx, markLabel }: { course: CourseModel; leg: LegSolution; idx: number; markLabel: string }) {
  const W = 300, H = 190, cx = W / 2, cy = H / 2 + 6;
  const p = leg.parts[idx];
  const next = leg.parts[idx + 1];
  const last = !next;
  const brg = bearingOf(sub(leg.to, p.end));
  const at = (b: number, r: number) => ({ x: cx + r * Math.sin(b * D2R), y: cy - r * Math.cos(b * D2R) });
  const ln = (a: Vec, b: Vec, cls: string, marker?: string) => <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={cls} markerEnd={marker} />;
  // Labels sit past the end of their line and are kept inside the box.
  const tx = (q: Vec, text: string, cls: string, dx = 0, dy = 0) => {
    const w = text.length * 6.3;
    let x = q.x + dx;
    let anchor: 'start' | 'end' | 'middle' = q.x < cx - 10 ? 'end' : q.x > cx + 10 ? 'start' : 'middle';
    const left = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x;
    if (left < 4) { x = 4; anchor = 'start'; } else if (left + w > W - 4) { x = W - 4; anchor = 'end'; }
    return <text x={x} y={Math.min(H - 18, Math.max(12, q.y + dy))} textAnchor={anchor} className={cls}>{text}</text>;
  };
  const inFrom = at(p.sail.cog + 180, 72);
  const head = at(p.sail.heading, 58);
  const sight = at(brg, 74);
  const rel = norm180(brg - p.sail.heading);
  const R = 34;
  const a0 = at(p.sail.heading, R), a1 = at(brg, R);
  const arc = `M${a0.x},${a0.y} A${R},${R} 0 0 ${rel > 0 ? 1 : 0} ${a1.x},${a1.y}`;
  const mid = at(p.sail.heading + rel / 2, R + 12);
  const hull = (b: number) => {
    // A simple hull outline pointing along bearing b, 22px long.
    const pts = [[0, -11], [4.5, -2], [4, 8], [-4, 8], [-4.5, -2]].map(([x, y]) => {
      const c = Math.cos(b * D2R), s2 = Math.sin(b * D2R);
      return `${(cx + x * c - y * s2).toFixed(1)},${(cy + x * s2 + y * c).toFixed(1)}`;
    });
    return <polygon points={pts.join(' ')} className={`td-hull ${p.sail.tack}`} />;
  };
  const wind = course.wind.water;
  const wFrom = { x: 26 + 14 * Math.sin(wind.from * D2R), y: 26 - 14 * Math.cos(wind.from * D2R) };
  const wTo = { x: 26 - 14 * Math.sin(wind.from * D2R), y: 26 + 14 * Math.cos(wind.from * D2R) };
  const t = course.wind.tide, tr = len(t);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="tackdetail" role="img"
      aria-label={`${last ? 'Final board' : 'Tack'}: heading ${fmtDeg(p.sail.heading)}, ${markLabel} ${Math.round(Math.abs(rel))} degrees off the ${rel >= 0 ? 'starboard' : 'port'} bow, bearing ${fmtDeg(brg)} true`}>
      <rect x={0} y={0} width={W} height={H} className="td-bg" rx={6} />
      {ln(wFrom, wTo, 'td-wind', 'url(#td-ah)')}
      <text x={26} y={52} textAnchor="middle" className="td-t muted-t">wind</text>
      {tr > 0.05 && (
        <>
          {ln({ x: W - 26 - (t.x / tr) * 13, y: 26 + (t.y / tr) * 13 }, { x: W - 26 + (t.x / tr) * 13, y: 26 - (t.y / tr) * 13 }, 'td-tide', 'url(#td-ah)')}
          <text x={W - 26} y={50} textAnchor="middle" className="td-t tide-t">tide {tr.toFixed(1)}</text>
        </>
      )}
      {ln(inFrom, { x: cx, y: cy }, `td-track ${p.sail.tack}`)}
      {next && ln({ x: cx, y: cy }, at(next.sail.cog, 72), `td-track ${next.sail.tack}`, 'url(#td-ah)')}
      {ln({ x: cx, y: cy }, sight, 'td-sight')}
      <circle cx={sight.x} cy={sight.y} r={5} className="buoy" />
      {tx(sight, `${markLabel} ${fmtDeg(brg)}T`, 'td-t mark-t', 0, -9)}
      {ln({ x: cx, y: cy }, head, 'td-head')}
      {tx(head, `CTW ${fmtDeg(p.sail.heading)}`, 'td-t', 0, -5)}
      <path d={arc} className="td-arc" />
      {tx(mid, `${Math.round(Math.abs(rel))}° ${rel >= 0 ? 'stbd' : 'port'}`, 'td-t td-rel', 0, 4)}
      {hull(p.sail.heading)}
      <text x={W / 2} y={H - 6} textAnchor="middle" className="td-t muted-t">
        <tspan className={p.sail.tack === 'starboard' ? 'stbd-t' : 'port-t'}>in: {p.sail.tack === 'starboard' ? 'stbd' : 'port'} CoG {fmtDeg(p.sail.cog)}</tspan>
        {next && <tspan className={next.sail.tack === 'starboard' ? 'stbd-t' : 'port-t'}>{'  '}out: {next.sail.tack === 'starboard' ? 'stbd' : 'port'} CTW {fmtDeg(next.sail.heading)}</tspan>}
        <tspan>{'  '}· not to scale</tspan>
      </text>
    </svg>
  );
}

function Hint({ tool, pending }: { tool: string; pending: boolean }) {
  const text =
    tool === 'mark' ? 'Tap the chart to drop a mark. Marks are sailed in the order you add them.'
    : tool === 'start' ? (pending ? 'Now tap the pin end.' : 'Tap the committee boat end of the start line.')
    : tool === 'probe' ? 'Tap anywhere to see the course and time to the next mark from there.'
    : null;
  return text ? <div className="hint" role="status">{text}</div> : null;
}
