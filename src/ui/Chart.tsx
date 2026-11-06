import * as React from 'react';
import { useApp, setState, getState, checkpoint, newId, AppState } from '../store';
import { useCourse, LAND_PATH, toLonLat, toXY, fmtDeg, fmtTime, CourseModel } from '../course';
import { Vec, add, mul, sub, len, mid, fromBearing, bearingOf } from '../nav/vec';
import { LegSolution, Sailing } from '../nav/solve';

type Drag =
  | { kind: 'pan'; start: Vec; view: AppState['view']; moved: boolean; legIdx: number | null }
  | { kind: 'mark'; id: string }
  | { kind: 'committee' }
  | { kind: 'pin' }
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
  const course = useCourse();

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
    drag.current = d;
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
    drag.current = { kind: 'pan', start: p, view: getState().view, moved: false, legIdx: legEl ? Number(legEl.getAttribute('data-leg')) : null };
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
    if (!d || d.kind !== 'pan' || d.moved) return;
    // A tap
    const pos = fromS(local(e));
    const s = getState();
    if (s.tool === 'mark') {
      checkpoint();
      const n = s.marks.length + 1;
      setState({ marks: [...s.marks, { id: newId(), name: `Mark ${n}`, pos }] });
    } else if (s.tool === 'start') {
      if (!s.pendingCommittee) setState({ pendingCommittee: pos });
      else {
        checkpoint();
        setState({ startLine: { committee: s.pendingCommittee, pin: pos }, pendingCommittee: null, tool: 'select' });
      }
    } else if (s.tool === 'probe') {
      setState({ probe: pos });
    } else if (d.legIdx !== null) {
      setState({ selectedLeg: d.legIdx });
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
            {sel && label(add(leg.to, mul(leg.laylines!.starboard, layLen)), `Stbd layline ${fmtDeg(bearingOf(mul(leg.laylines!.starboard, -1)))}`, 'lbl stbd-t')}
            {sel && label(add(leg.to, mul(leg.laylines!.port, layLen)), `Port layline ${fmtDeg(bearingOf(mul(leg.laylines!.port, -1)))}`, 'lbl port-t')}
          </g>
        )}
        <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} className="rhumb" />
        {sel && leg.lane && (leg.kind === 'beat' || leg.kind === 'run') && (
          <g>
            {line(leg.to, add(leg.to, mul(leg.lane.starboard, layLen)), 'layline inner stbd')}
            {line(leg.to, add(leg.to, mul(leg.lane.port, layLen)), 'layline inner port')}
          </g>
        )}
        {leg.parts.map((pt, j) => {
          const many = leg.parts.length > 2;
          const isTack = j < leg.parts.length - 1 && leg.kind !== 'reach';
          const tp = toS(pt.end);
          return (
            <g key={j}>
              {line(pt.start, pt.end, `track ${pt.sail.tack}`, { markerMid: undefined })}
              {sel && (!many || pt.hours * k * len(pt.sail.ground) > 90) && label(mid(pt.start, pt.end), `${leg.kind === 'reach' ? 'CoG' : pt.sail.tack === 'starboard' ? 'Stbd' : 'Port'} ${fmtDeg(pt.sail.cog)} · ${fmtTime(pt.hours)}`, 'lbl track-t', 10)}
              {sel && isTack && <circle cx={tp.x} cy={tp.y} r={3.5} className={`tackdot ${pt.sail.tack}`} />}
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
        {layers.startOptions && course.start && (['committee', 'pin'] as const).map((end) => {
          const l = end === 'pin' ? course.start!.pinLeg : course.start!.committeeLeg;
          if (!l || l.kind === 'reach' || l.kind === 'blocked') return null;
          const routes = [l.parts, l.altParts ?? []];
          return (
            <g key={'so-' + end} className="start-opt">
              {routes.map((parts, r) => parts.map((pt, j) => (
                <g key={r + ':' + j}>
                  {line(pt.start, pt.end, `track opt ${pt.sail.tack}`)}
                  {j === 0 && parts.length > 1 && (() => { const s2 = toS(pt.end); return <circle cx={s2.x} cy={s2.y} r={3} className={`tackdot ${pt.sail.tack}`} />; })()}
                  {j === 0 && parts.length > 1 && label(pt.end, `${end === 'pin' ? 'Pin' : 'Cttee'}: ${pt.sail.tack === 'starboard' ? 'stbd' : 'port'} ${fmtTime(pt.hours)}, tack at mark ${fmtDeg(bearingOf(sub(l.to, pt.end)))}`, 'lbl opt-t', end === 'pin' ? 26 : 14)}
                </g>
              )))}
            </g>
          );
        })}
        {probe && course.probeLeg && (
          <g className="probe">
            {course.probeLeg.parts.map((pt, j) => <g key={j}>{line(pt.start, pt.end, `track probe-track`)}</g>)}
            {course.probeLeg.parts[0] && triangle(probe, course.probeLeg.parts[0].sail, course.wind.tide, 'ptri')}
            <circle cx={toS(probe).x} cy={toS(probe).y} r={16} className="hit-handle" onPointerDown={(e) => beginHandle(e, { kind: 'probe' })} />
            <path d={`M${toS(probe).x - 7},${toS(probe).y}h14M${toS(probe).x},${toS(probe).y - 7}v14`} className="probe-x" />
            {label(probe, `${fmtTime(course.probeLeg.timeH)} to ${course.points[Math.min(selectedLeg + 1, course.points.length - 1)]?.label}`, 'lbl probe-t', -14)}
          </g>
        )}
        {startLine && (
          <g className="startline">
            {line(startLine.committee, startLine.pin, 'start-line')}
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
      <div className="attrib">{base === 'chart' ? 'Coastline: ONS boundaries, OGL. Not for navigation.' : 'Grid in nautical miles from Cowes'}</div>
    </div>
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

function Hint({ tool, pending }: { tool: string; pending: boolean }) {
  const text =
    tool === 'mark' ? 'Tap the chart to drop a mark. Marks are sailed in the order you add them.'
    : tool === 'start' ? (pending ? 'Now tap the pin end.' : 'Tap the committee boat end of the start line.')
    : tool === 'probe' ? 'Tap anywhere to see the course and time to the next mark from there.'
    : null;
  return text ? <div className="hint" role="status">{text}</div> : null;
}
