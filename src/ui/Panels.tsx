import * as React from 'react';
import { useApp, setState, checkpoint, getState } from '../store';
import { useCourse, fmtDeg, fmtKn, fmtTime, kindLabel, CourseModel } from '../course';
import { Dial, Speed } from './Dial';
import { optimalAngles, parsePolar } from '../nav/polar';
import { Vec, len, add, mul, sub, bearingOf, norm180 } from '../nav/vec';
import { Sailing, LegSolution, sailingAngles } from '../nav/solve';

const twaTxt = (t: number) => `${Math.round(Math.abs(t))}° ${t >= 0 ? 'stbd' : 'port'}`;

export function ConditionsPanel() {
  const cond = useApp((s) => s.cond);
  const c = useCourse();
  const set = (p: Partial<typeof cond>) => setState((s) => ({ cond: { ...s.cond, ...p } }));
  return (
    <section className="panel" aria-labelledby="h-cond">
      <h2 id="h-cond">Wind and tide</h2>
      <div className="pair">
        <div className="pair-col">
          <h3>Wind <span className="muted">over the ground</span></h3>
          <Dial id="wind" label="Wind direction" kind="from" value={cond.windFrom} onStart={checkpoint} onChange={(v) => set({ windFrom: v })} />
          <Speed id="wind-kn" label="Speed" max={35} value={cond.windKn} onStart={checkpoint} onChange={(v) => set({ windKn: v })} />
        </div>
        <div className="pair-col tide-col">
          <h3>Tide <span className="muted">set and rate</span></h3>
          <Dial id="tide" label="Tide direction" kind="to" value={cond.tideTo} onStart={checkpoint} onChange={(v) => set({ tideTo: v })} />
          <Speed id="tide-kn" label="Rate" max={5} value={cond.tideKn} onStart={checkpoint} onChange={(v) => set({ tideKn: v })} />
        </div>
      </div>
      <p className="readout">
        Wind the boat sails in, after tide: <b>{fmtDeg(c.wind.water.from)} at {fmtKn(c.wind.water.kn)}</b>
      </p>
    </section>
  );
}

export function CoursePanel() {
  const marks = useApp((s) => s.marks);
  const startLine = useApp((s) => s.startLine);
  const finishAtStart = useApp((s) => s.finishAtStart);
  const c = useCourse();
  const st = c.start;
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= marks.length) return;
    checkpoint();
    const m = [...marks];
    [m[i], m[j]] = [m[j], m[i]];
    setState({ marks: m });
  };
  return (
    <section className="panel" aria-labelledby="h-course">
      <h2 id="h-course">Course</h2>
      {startLine && st ? (
        <div className="startinfo">
          <div className="kv"><span>Line length</span><b>{Math.round(st.lengthM)} m</b></div>
          <div className="kv"><span>Bias</span><b>{st.favoured === 'square' ? 'Square' : `${Math.abs(st.bias).toFixed(0)}° to ${st.favoured}`}</b></div>
          {st.favoured !== 'square' && <div className="kv"><span>Upwind advantage</span><b>{Math.round(st.advantageM)} m at {st.favoured}</b></div>}
          {isFinite(st.pinH) && isFinite(st.committeeH) && (
            <div className="kv"><span>To {marks[0]?.name}</span><b>{st.pinH < st.committeeH ? 'Pin' : 'Committee'} end {Math.abs(Math.round((st.pinH - st.committeeH) * 3600))} s faster</b></div>
          )}
        </div>
      ) : (
        <p className="muted">No start line yet. Use Start line in the toolbar.</p>
      )}
      {st && <StartOptions st={st} markName={marks[0]?.name ?? 'mark 1'} />}
      <ol className="marklist">
        {marks.map((m, i) => (
          <li key={m.id}>
            <span className="buoy-dot" aria-hidden />
            <label className="sr" htmlFor={`mk-${m.id}`}>Mark name</label>
            <input id={`mk-${m.id}`} value={m.name} onFocus={checkpoint} onChange={(e) => setState({ marks: marks.map((x) => (x.id === m.id ? { ...x, name: e.target.value } : x)) })} />
            <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${m.name} earlier`}>↑</button>
            <button type="button" onClick={() => move(i, 1)} disabled={i === marks.length - 1} aria-label={`Move ${m.name} later`}>↓</button>
            <button type="button" className="danger" onClick={() => { checkpoint(); setState({ marks: marks.filter((x) => x.id !== m.id), selectedLeg: 0 }); }} aria-label={`Delete ${m.name}`}>×</button>
          </li>
        ))}
      </ol>
      {marks.length === 0 && <p className="muted">No marks yet. Use Add mark in the toolbar, then tap the chart.</p>}
      <label className="check">
        <input id="finish-at-start" type="checkbox" checked={finishAtStart} onChange={(e) => { checkpoint(); setState({ finishAtStart: e.target.checked }); }} />
        Finish back at the start line
      </label>
    </section>
  );
}

function StartOptions({ st, markName }: { st: NonNullable<CourseModel['start']>; markName: string }) {
  const rows: { end: string; first: string; tack: string; cog: number; tackAt: number; second: string; cog2: number; total: number }[] = [];
  for (const [end, l] of [['Committee', st.committeeLeg], ['Pin', st.pinLeg]] as const) {
    if (!l || (l.kind !== 'beat' && l.kind !== 'run')) continue;
    for (const parts of [l.parts, l.altParts ?? []]) {
      if (!parts.length) continue;
      const [a, b] = parts;
      rows.push({ end, first: a.sail.tack, tack: '', cog: a.sail.cog, tackAt: b ? a.hours : NaN, second: b?.sail.tack ?? '', cog2: b?.sail.cog ?? NaN, total: l.timeH });
    }
  }
  if (!rows.length) return null;
  rows.sort((x, y) => x.end.localeCompare(y.end) || (x.first === 'starboard' ? -1 : 1));
  const best = Math.min(...rows.map((r) => r.total));
  const word = st.pinLeg?.kind === 'run' ? 'Gybe' : 'Tack';
  return (
    <div className="tablewrap">
      <table className="opts" aria-label={`Start options to ${markName}`}>
        <thead><tr><th>From</th><th>First board</th><th>CoG</th><th>{word} at</th><th>{word} when mark bears</th><th>To {markName}</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={Math.abs(r.total - best) < 1 / 3600 ? 'best' : ''}>
              <td>{r.end}</td>
              <td className={r.first === 'starboard' ? 'stbd-c' : 'port-c'}>{r.first === 'starboard' ? 'Stbd' : 'Port'}</td>
              <td>{fmtDeg(r.cog)}</td>
              <td>{isFinite(r.tackAt) ? fmtTime(r.tackAt) : 'lays it'}</td>
              <td>{isFinite(r.cog2) ? fmtDeg(r.cog2) : '—'}</td>
              <td>{fmtTime(r.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LegsPanel() {
  const c = useCourse();
  const selected = useApp((s) => s.selectedLeg);
  if (!c.legs.length) return null;
  return (
    <section className="panel" aria-labelledby="h-legs">
      <h2 id="h-legs">Legs <span className="muted">total {fmtTime(c.totalH)}</span></h2>
      <div className="tablewrap">
        <table className="legs">
          <thead>
            <tr><th>Leg</th><th>Type</th><th>nm</th><th>Brg</th><th>TWA</th><th>CTW</th><th>CoG</th><th>SOG</th><th>Time</th></tr>
          </thead>
          <tbody>
            {c.legs.map((l, i) => {
              const first = l.parts[0]?.sail;
              return (
                <tr key={i} className={i === selected ? 'sel' : ''} onClick={() => setState({ selectedLeg: i })} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setState({ selectedLeg: i })}>
                  <td>{i + 1}<span className="to"> → {c.points[i + 1].label}</span></td>
                  <td><span className={`pill k-${l.kind}`}>{kindLabel[l.kind]}</span></td>
                  <td>{l.dist.toFixed(2)}</td>
                  <td>{fmtDeg(l.bearing)}</td>
                  <td>{first ? twaTxt(first.twa) : '—'}</td>
                  <td>{uniq(l.parts.map((p) => fmtDeg(p.sail.heading))) || '—'}</td>
                  <td>{uniq(l.parts.map((p) => fmtDeg(p.sail.cog))) || '—'}</td>
                  <td>{uniq(l.parts.map((p) => p.sail.sog.toFixed(1))) || '—'}</td>
                  <td>{fmtTime(l.timeH)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <SelectedLegNote c={c} i={selected} />
    </section>
  );
}

const uniq = (xs: string[]) => [...new Set(xs)].join(' / ');

/** Relative bearing of the mark off the bow, e.g. "72° stbd". */
const offBow = (markBrg: number, heading: number) => {
  const r = norm180(markBrg - heading);
  return `${Math.round(Math.abs(r))}° ${r >= 0 ? 'stbd' : 'port'}`;
};
const side = (t: string) => (t === 'starboard' ? 'Stbd' : 'Port');

export function TackingPanel() {
  const c = useCourse();
  const strategy = useApp((s) => s.strategy);
  const selected = useApp((s) => s.selectedLeg);
  const set = (p: Partial<typeof strategy>) => setState((s) => ({ strategy: { ...s.strategy, ...p } }));
  const leg: LegSolution | undefined = c.legs[selected];
  const twoBoard = leg && (leg.kind === 'beat' || leg.kind === 'run');
  const word = leg?.kind === 'run' ? 'gybe' : 'tack';
  const Word = word === 'gybe' ? 'Gybe' : 'Tack';
  const lane = strategy.mode === 'lane';
  return (
    <section className="panel" aria-labelledby="h-tack">
      <h2 id="h-tack">Tacking <span className="muted">{leg ? `Leg ${selected + 1}` : ''}</span></h2>
      <div className="seg seg-full" role="radiogroup" aria-label="Upwind and downwind strategy">
        {([['laylines', 'Tack on the laylines'], ['lane', 'Stay off the laylines']] as const).map(([m, t]) => (
          <button key={m} type="button" role="radio" aria-checked={strategy.mode === m} className={strategy.mode === m ? 'on' : ''} onClick={() => { checkpoint(); set({ mode: m }); }}>{t}</button>
        ))}
      </div>
      {lane && (
        <>
          <div className="speed">
            <label htmlFor="lane-margin">Keep off by</label>
            <input id="lane-margin" type="range" min={0.1} max={0.45} step={0.05} value={strategy.margin} onPointerDown={checkpoint} onChange={(e) => set({ margin: Number(e.target.value) })} />
            <output htmlFor="lane-margin">{Math.round(strategy.margin * 100)}%</output>
          </div>
          <div className="speed">
            <label htmlFor="lane-tacks">Most tacks</label>
            <input id="lane-tacks" type="range" min={2} max={12} step={1} value={strategy.maxTacks} onPointerDown={checkpoint} onChange={(e) => set({ maxTacks: Number(e.target.value) })} />
            <output htmlFor="lane-tacks">{strategy.maxTacks}</output>
          </div>
          <p className="small muted">
            Two inner laylines sit this far in from the real ones, as a share of the gap between them. You {word} each time you reach one,
            then make the last {word} on the real layline. A wider margin keeps you nearer the middle and needs more {word}s.
            Boards shorter than a minute, twice the {word} cost or 5% of the leg are left out, so you may use fewer {word}s than the most allowed.
          </p>
        </>
      )}
      {twoBoard && leg.tackBearings ? (
        <>
          <div className="bearings">
            {lane && leg.lane && <div className="kv"><span>This leg</span><b>{leg.parts.length - 1} {word}s of {strategy.maxTacks} allowed, {fmtTime(leg.timeH)}</b></div>}
            {lane && leg.lane && (
              <>
                <div className="kv"><span>Inner laylines: on stbd, {word} when the mark bears</span><b className="stbd-c">{fmtDeg(leg.lane.bearings.starboard)}T</b></div>
                <div className="kv"><span>on port, {word} when it bears</span><b className="port-c">{fmtDeg(leg.lane.bearings.port)}T</b></div>
              </>
            )}
            <div className="kv"><span>{lane ? 'Final ' + word + ' on the layline: on stbd' : `On stbd, ${word}`} when the mark bears</span><b className="stbd-c">{fmtDeg(leg.tackBearings.starboard)}T</b></div>
            <div className="kv"><span>{lane ? 'on port' : `On port, ${word}`} when it bears</span><b className="port-c">{fmtDeg(leg.tackBearings.port)}T</b></div>
          </div>
          {leg.parts.length > 0 && (
            <div className="tablewrap">
              <table className="opts boards" aria-label={`Boards on leg ${selected + 1}`}>
                <thead><tr><th>#</th><th>Board</th><th>CoG</th><th>Time</th><th>{Word} when mark bears</th><th>Off the bow</th></tr></thead>
                <tbody>
                  {leg.parts.map((p, j) => {
                    const last = j === leg.parts.length - 1;
                    const brg = bearingOf(sub(leg.to, p.end));
                    return (
                      <tr key={j}>
                        <td>{j + 1}</td>
                        <td className={p.sail.tack === 'starboard' ? 'stbd-c' : 'port-c'}>{side(p.sail.tack)}</td>
                        <td>{fmtDeg(p.sail.cog)}</td>
                        <td>{fmtTime(p.hours)}</td>
                        <td>{last ? 'mark' : `${fmtDeg(brg)}T`}</td>
                        <td>{last ? '—' : offBow(brg, p.sail.heading)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="small muted">
            With tide, the mark bears the next board's course over the ground when you reach the layline, not the next heading.
            Take a hand-bearing on the mark and {word} when it reads the bearing above. Bearings are true; variation in the Solent is under 1°.
          </p>
        </>
      ) : (
        <p className="muted">{leg ? `Leg ${selected + 1} is a ${leg.kind === 'reach' ? 'reach, laid on one board' : 'blocked leg'}. Pick a beat or a run to see tack bearings.` : 'Add marks to see tack bearings.'}</p>
      )}
    </section>
  );
}

function SelectedLegNote({ c, i }: { c: CourseModel; i: number }) {
  const l = c.legs[i];
  if (!l) return null;
  if (l.kind === 'blocked') return <p className="note warn">Leg {i + 1}: {l.note ?? 'cannot be sailed in this tide'}.</p>;
  if (l.kind === 'beat' || l.kind === 'run') {
    const [a, b] = l.parts;
    const word = l.kind === 'beat' ? 'tack' : 'gybe';
    if (l.parts.length > 2) {
      return (
        <p className="note">
          Leg {i + 1}: {l.parts.length - 1} {word}s, starting on {a.sail.tack}, staying off the laylines until the last {word}. See Tacking for each board.
        </p>
      );
    }
    return (
      <p className="note">
        Leg {i + 1}: sail {a.sail.tack} for {fmtTime(a.hours)}{b ? `, ${word} onto ${b.sail.tack} for ${fmtTime(b.hours)}` : ''}.
        {b ? ` Or ${b.sail.tack} first for ${fmtTime(b.hours)}, then ${a.sail.tack} for ${fmtTime(a.hours)}.` : ''}
        {' '}Optimum {l.kind === 'beat' ? 'upwind' : 'downwind'} TWA {l.pair?.twa.toFixed(0)}° in {c.wind.water.kn.toFixed(1)} kn on the water.
      </p>
    );
  }
  return <p className="note">Leg {i + 1}: steer {fmtDeg(l.parts[0]?.sail.heading ?? 0)} to make good {fmtDeg(l.bearing)}.{l.note ? ` ${l.note}.` : ''}</p>;
}

export function VectorPanel() {
  const c = useCourse();
  const selected = useApp((s) => s.selectedLeg);
  const probe = useApp((s) => s.probe);
  const leg = probe && c.probeLeg ? c.probeLeg : c.legs[selected];
  const title = probe && c.probeLeg ? 'From probe point' : leg ? `Leg ${selected + 1}` : '';
  return (
    <section className="panel" aria-labelledby="h-vec">
      <h2 id="h-vec">Vector triangle <span className="muted">{title}</span></h2>
      {leg && leg.parts.length ? (
        <div className="tri-grid">
          {leg.parts.map((p, j) => <Triangle key={j} sail={p.sail} tide={c.wind.tide} caption={leg.kind === 'reach' ? 'Reach' : p.sail.tack === 'starboard' ? 'Starboard' : 'Port'} />)}
        </div>
      ) : <p className="muted">Add a start line and a mark to see the triangle.</p>}
      <ul className="legend">
        <li><svg width="34" height="10" aria-hidden><line x1="2" y1="5" x2="30" y2="5" className="v-water" markerEnd="url(#ah-water)" /></svg>Through water (CTW, STW)</li>
        <li><svg width="34" height="10" aria-hidden><line x1="2" y1="5" x2="30" y2="5" className="v-tide" markerEnd="url(#ah-tide)" /></svg>Tide (set, rate)</li>
        <li><svg width="34" height="10" aria-hidden><line x1="2" y1="5" x2="30" y2="5" className="v-ground" markerEnd="url(#ah-ground)" /></svg>Over ground (CoG, SOG)</li>
      </ul>
    </section>
  );
}

function Triangle({ sail, tide, caption }: { sail: Sailing; tide: Vec; caption: string }) {
  // Fixed knots scale, fitted to the box.
  const pts = [{ x: 0, y: 0 }, sail.water, sail.ground];
  const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
  const W = 220, H = 170, pad = 36;
  const s = Math.min((W - 2 * pad) / Math.max(0.5, maxX - minX), (H - 2 * pad) / Math.max(0.5, maxY - minY));
  const ox = pad + ((W - 2 * pad) - (maxX - minX) * s) / 2 - minX * s;
  const oy = H - pad - ((H - 2 * pad) - (maxY - minY) * s) / 2 + minY * s;
  const S = (p: Vec) => ({ x: ox + p.x * s, y: oy - p.y * s });
  const o = S({ x: 0, y: 0 }), wv = S(sail.water), gv = S(sail.ground);
  const cen = { x: (o.x + wv.x + gv.x) / 3, y: (o.y + wv.y + gv.y) / 3 };
  // Label each side at its midpoint, pushed outward away from the triangle's centre.
  const midL = (a: Vec, b: Vec) => {
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    let n = { x: -(b.y - a.y), y: b.x - a.x };
    const l = Math.hypot(n.x, n.y) || 1;
    n = { x: n.x / l, y: n.y / l };
    if ((m.x - cen.x) * n.x + (m.y - cen.y) * n.y < 0) n = { x: -n.x, y: -n.y };
    return { x: m.x + n.x * 12, y: m.y + n.y * 12 + 3, anchor: n.x > 0.3 ? 'start' : n.x < -0.3 ? 'end' : 'middle' };
  };
  const lw = midL(o, wv), lt = midL(wv, gv), lg = midL(o, gv);
  const tr = len(tide);
  return (
    <figure className="tri">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${caption}: CTW ${fmtDeg(sail.heading)} at ${sail.stw.toFixed(1)} knots plus tide gives CoG ${fmtDeg(sail.cog)} at ${sail.sog.toFixed(1)} knots`}>
        <line x1={o.x} y1={o.y} x2={wv.x} y2={wv.y} className="v-water" markerEnd="url(#ah-water)" />
        {tr > 0.02 && <line x1={wv.x} y1={wv.y} x2={gv.x} y2={gv.y} className="v-tide" markerEnd="url(#ah-tide)" />}
        <line x1={o.x} y1={o.y} x2={gv.x} y2={gv.y} className="v-ground" markerEnd="url(#ah-ground)" />
        <text x={lw.x} y={lw.y} textAnchor={lw.anchor} className="tri-t water-t">{fmtDeg(sail.heading)} {sail.stw.toFixed(1)}</text>
        {tr > 0.02 && <text x={lt.x} y={lt.y} textAnchor={lt.anchor} className="tri-t tide-t">{fmtDeg(bearingOf(tide))} {tr.toFixed(1)}</text>}
        <text x={lg.x} y={lg.y} textAnchor={lg.anchor} className="tri-t ground-t">{fmtDeg(sail.cog)} {sail.sog.toFixed(1)}</text>
      </svg>
      <figcaption>
        <b>{caption}</b> CTW {fmtDeg(sail.heading)} + tide = CoG {fmtDeg(sail.cog)}, SOG {sail.sog.toFixed(1)} kn
      </figcaption>
    </figure>
  );
}

export function BoatPanel() {
  const custom = useApp((s) => s.customPolar);
  const leeway = useApp((s) => s.leewayDeg);
  const penalty = useApp((s) => s.tackPenaltySec);
  const upTwa = useApp((s) => s.upTwa);
  const c = useCourse();
  const [text, setText] = React.useState('');
  const [err, setErr] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const best = optimalAngles(c.boat.polar, c.wind.water.kn);
  const opt = sailingAngles(c.boat, c.wind.water.kn);
  const onFile = async (f: File | undefined) => { if (f) setText(await f.text()); };
  const doImport = () => {
    try {
      const p = parsePolar(text, 'Imported polar');
      checkpoint();
      setState({ customPolar: p });
      setErr(null); setOpen(false);
    } catch (e: any) { setErr(e.message); }
  };
  return (
    <section className="panel" aria-labelledby="h-boat">
      <h2 id="h-boat">Boat</h2>
      <p className="boatname">{c.boat.polar.name}</p>
      <p className="muted small">{c.boat.polar.note}</p>
      <div className="kv"><span>Upwind at {c.wind.water.kn.toFixed(1)} kn</span><b>TWA {opt.up.twa.toFixed(0)}°, {opt.up.stw.toFixed(1)} kn, VMG {opt.up.vmg.toFixed(1)}</b></div>
      {upTwa != null && <div className="kv"><span>Polar's best upwind</span><b>TWA {best.up.twa.toFixed(0)}°, VMG {best.up.vmg.toFixed(1)}</b></div>}
      <div className="kv"><span>Downwind</span><b>TWA {opt.down.twa.toFixed(0)}°, {opt.down.stw.toFixed(1)} kn, VMG {opt.down.vmg.toFixed(1)}</b></div>
      <div className="speed">
        <label htmlFor="leeway">Leeway</label>
        <input id="leeway" type="range" min={0} max={8} step={0.5} value={leeway} onPointerDown={checkpoint} onChange={(e) => setState({ leewayDeg: Number(e.target.value) })} />
        <output htmlFor="leeway">{leeway.toFixed(1)}°</output>
      </div>
      <label className="check">
        <input id="own-twa" type="checkbox" checked={upTwa != null} onChange={(e) => { checkpoint(); setState({ upTwa: e.target.checked ? Math.round(best.up.twa) : null }); }} />
        Set my own upwind angle
      </label>
      {upTwa != null && (
        <div className="speed">
          <label htmlFor="up-twa">Upwind TWA</label>
          <input id="up-twa" type="range" min={30} max={60} step={1} value={upTwa} onPointerDown={checkpoint} onChange={(e) => setState({ upTwa: Number(e.target.value) })} />
          <output htmlFor="up-twa">{upTwa}°</output>
        </div>
      )}
      {upTwa != null && <p className="small muted">Degrees off the wind on the water, each side, so tacking through about {2 * upTwa}°. Boat speed comes from the polar at this angle.</p>}
      <div className="speed">
        <label htmlFor="penalty">Tack cost</label>
        <input id="penalty" type="range" min={0} max={60} step={1} value={penalty} onPointerDown={checkpoint} onChange={(e) => setState({ tackPenaltySec: Number(e.target.value) })} />
        <output htmlFor="penalty">{penalty} s</output>
      </div>
      <div className="row">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Cancel import' : 'Import polar'}</button>
        {custom && <button type="button" onClick={() => { checkpoint(); setState({ customPolar: null }); }}>Use Sun Odyssey 410</button>}
      </div>
      {open && (
        <div className="import">
          <p className="small muted">Paste a TWA × TWS table: first row "TWA" then wind speeds, each next row an angle then boat speeds. Tabs, commas, semicolons or spaces.</p>
          <label htmlFor="polar-file" className="small">Or choose a file</label>
          <input id="polar-file" type="file" accept=".csv,.txt,.pol,.tsv" onChange={(e) => onFile(e.target.files?.[0])} />
          <label htmlFor="polar-text" className="sr">Polar table</label>
          <textarea id="polar-text" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={'TWA\t6\t8\t10\t12\n45\t4.9\t5.8\t6.4\t6.7\n90\t6.1\t7.1\t7.6\t7.9'} />
          {err && <p className="note warn">{err}</p>}
          <button type="button" className="primary" onClick={doImport} disabled={!text.trim()}>Use this polar</button>
        </div>
      )}
    </section>
  );
}

export function DisplayPanel() {
  const layers = useApp((s) => s.layers);
  const vectorMin = useApp((s) => s.vectorMin);
  const tog = (k: keyof typeof layers) => setState((s) => ({ layers: { ...s.layers, [k]: !s.layers[k] } }));
  return (
    <section className="panel" aria-labelledby="h-disp">
      <h2 id="h-disp">Display</h2>
      <div className="toggles">
        <label className="check"><input id="ly-lay" type="checkbox" checked={layers.laylines} onChange={() => tog('laylines')} />Laylines</label>
        <label className="check"><input id="ly-all" type="checkbox" checked={layers.allLaylines} onChange={() => tog('allLaylines')} disabled={!layers.laylines} />Every leg, not just the selected one</label>
        <label className="check"><input id="ly-both" type="checkbox" checked={layers.bothRoutes} onChange={() => tog('bothRoutes')} />Port and starboard routes</label>
        <label className="check"><input id="ly-start" type="checkbox" checked={layers.startOptions} onChange={() => tog('startOptions')} />Start options from each end</label>
        <label className="check"><input id="ly-tri" type="checkbox" checked={layers.triangles} onChange={() => tog('triangles')} />Vector triangles</label>
        <label className="check"><input id="ly-tide" type="checkbox" checked={layers.tide} onChange={() => tog('tide')} />Tide arrows</label>
      </div>
      <div className="speed">
        <label htmlFor="vecmin">Vector length</label>
        <input id="vecmin" type="range" min={2} max={60} step={1} value={vectorMin} onChange={(e) => setState({ vectorMin: Number(e.target.value) })} />
        <output htmlFor="vecmin">{vectorMin} min</output>
      </div>
      <p className="small muted">Vectors on the chart show where each velocity takes you in this many minutes.</p>
    </section>
  );
}

void getState; void add; void mul;
