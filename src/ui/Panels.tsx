import * as React from 'react';
import { SOLENT_MARKS, SOLENT_MARKS_SOURCE } from '../data/solentMarks';
import { findSolentMark, solentToMark, colourName, fmtLatLon } from '../marks';
import { useApp, setState, checkpoint, getState, courseLink, listCourses, saveCourse, loadCourse, deleteCourse } from '../store';
import { useCourse, fmtDeg, fmtKn, fmtTime, kindLabel, CourseModel, tackNarrative, offBowText } from '../course';
import { Dial, Speed, Slider } from './Dial';
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
          <Speed id="wind-kn" label="Speed" max={35} nudge={0.5} value={cond.windKn} onStart={checkpoint} onChange={(v) => set({ windKn: v })} />
        </div>
        <div className="pair-col tide-col">
          <h3>Tide <span className="muted">set and rate</span></h3>
          <Dial id="tide" label="Tide direction" kind="to" value={cond.tideTo} onStart={checkpoint} onChange={(v) => set({ tideTo: v })} />
          <Speed id="tide-kn" label="Rate" max={5} nudge={0.1} value={cond.tideKn} onStart={checkpoint} onChange={(v) => set({ tideKn: v })} />
        </div>
      </div>
      <p className="readout">
        Wind the boat sails in, after tide: <b>{fmtDeg(c.wind.water.from)} at {fmtKn(c.wind.water.kn)}</b>
      </p>
    </section>
  );
}

/** Pick a mark from the SCRA Solent list by code or name and add it to the course. */
function AddSolentMark() {
  const marks = useApp((s) => s.marks);
  const [q, setQ] = React.useState('');
  const found = findSolentMark(q);
  const add = () => {
    if (!found) return;
    checkpoint();
    setState({ marks: [...marks, solentToMark(found)] });
    setQ('');
  };
  return (
    <div className="addmark">
      <label htmlFor="solent-mark">Add a Solent mark</label>
      <div className="row">
        <input id="solent-mark" list="solent-mark-list" value={q} placeholder="Code or name, e.g. 3U or Gurnard" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <button type="button" onClick={add} disabled={!found}>Add</button>
      </div>
      <datalist id="solent-mark-list">
        {SOLENT_MARKS.map((m) => <option key={m.code} value={`${m.code} ${m.name}`} />)}
      </datalist>
      <p className="small muted">
        {found ? `${found.code} ${found.name} (${colourName(found.colour)}), ${fmtLatLon(found.lat, found.lon)}${found.note ? `. ${found.note}` : ''}` : `${SOLENT_MARKS.length} marks from the ${SOLENT_MARKS_SOURCE} list. You can also tap a mark on the chart.`}
      </p>
    </div>
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
      {!startLine && <p className="muted">No start line yet. Use Start line in the toolbar, or ping it in Start line above.</p>}
      <ol className="marklist">
        {marks.map((m, i) => (
          <li key={m.id}>
            <span className="buoy-dot" aria-hidden />
            <label className="sr" htmlFor={`mk-${m.id}`}>Mark name</label>
            <input id={`mk-${m.id}`} value={m.name} onFocus={checkpoint} onChange={(e) => setState({ marks: marks.map((x) => (x.id === m.id ? { ...x, name: e.target.value } : x)) })} />
            <button type="button" className={`round-btn ${(m.rounding ?? 'port') === 'port' ? 'port-c' : 'stbd-c'}`} onClick={() => { checkpoint(); setState({ marks: marks.map((x) => (x.id === m.id ? { ...x, rounding: (x.rounding ?? 'port') === 'port' ? 'starboard' : 'port' } : x)) }); }} aria-label={`${m.name}: leave to ${(m.rounding ?? 'port')}. Tap to switch.`} title="Leave this mark to port or starboard">
              {(m.rounding ?? 'port') === 'port' ? 'Port' : 'Stbd'}
            </button>
            <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${m.name} earlier`}>↑</button>
            <button type="button" onClick={() => move(i, 1)} disabled={i === marks.length - 1} aria-label={`Move ${m.name} later`}>↓</button>
            <button type="button" className="danger" onClick={() => { checkpoint(); setState({ marks: marks.filter((x) => x.id !== m.id), selectedLeg: 0 }); }} aria-label={`Delete ${m.name}`}>×</button>
          </li>
        ))}
      </ol>
      {marks.length > 0 && <p className="small muted">The Port / Stbd button sets which side you leave each mark on. On a beat or run the route picks the board that rounds the right way.</p>}
      {marks.length === 0 && <p className="muted">No marks yet. Use Add mark in the toolbar, then tap the chart.</p>}
      <label className="check">
        <input id="finish-at-start" type="checkbox" checked={finishAtStart} onChange={(e) => { checkpoint(); setState({ finishAtStart: e.target.checked }); }} />
        Finish back at the start line
      </label>
      <AddSolentMark />
      <SavedCourses />
      <ShareCourse />
    </section>
  );
}

function SavedCourses() {
  const [list, setList] = React.useState(listCourses);
  const [name, setName] = React.useState('');
  const [msg, setMsg] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<string | null>(null);
  const save = () => {
    const n = name.trim();
    if (!n) return;
    const replaced = list.some((c) => c.name.toLowerCase() === n.toLowerCase());
    setMsg(saveCourse(n) ? `${replaced ? 'Updated' : 'Saved'} "${n}".` : "Couldn't save: this browser's storage is full or blocked.");
    setList(listCourses()); setName('');
  };
  const when = (t: number) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
  return (
    <div className="saved">
      <label htmlFor="save-name">Save this course</label>
      <div className="row">
        <input id="save-name" value={name} placeholder="Name, e.g. Race 2 Peel Bank" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
        <button type="button" onClick={save} disabled={!name.trim()}>Save</button>
      </div>
      {msg && <p className="small muted">{msg}</p>}
      {list.length > 0 && (
        <ul className="savedlist">
          {list.map((c) => (
            <li key={c.name}>
              <button type="button" className="linkish" onClick={() => { loadCourse(c.name); setMsg(`Loaded "${c.name}". Undo puts back what you had.`); }}>{c.name}</button>
              <span className="small muted">{when(c.savedAt)}</span>
              {confirm === c.name ? (
                <>
                  <button type="button" className="danger" onClick={() => { deleteCourse(c.name); setList(listCourses()); setConfirm(null); }}>Delete</button>
                  <button type="button" onClick={() => setConfirm(null)}>Keep</button>
                </>
              ) : (
                <button type="button" className="danger" onClick={() => setConfirm(c.name)} aria-label={`Delete saved course ${c.name}`}>×</button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="small muted">Saved courses keep the marks, start line, wind, tide and boat settings. They live in this browser only: use Copy course link to move one to another phone.</p>
    </div>
  );
}

function ShareCourse() {
  const [link, setLink] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const make = async () => {
    const l = courseLink(getState());
    setLink(l);
    try { await navigator.clipboard.writeText(l); setCopied(true); } catch { setCopied(false); }
  };
  return (
    <div className="share">
      <button type="button" onClick={make}>Copy course link</button>
      {link && (
        <>
          <span className="small muted">{copied ? ' Copied. Opening it loads this course, wind and tide.' : ' Copy the link below.'}</span>
          {!copied && <input className="share-link" readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Course link" />}
        </>
      )}
    </div>
  );
}

const endName = (r: { end: string; fromPinM?: number }) => (r.end === 'pin' ? 'Pin' : r.end === 'committee' ? 'Committee' : `Line, ${Math.round(r.fromPinM ?? 0)} m from pin`);
const secs = (x: number) => `${Math.abs(Math.round(x))} s`;
const gainText = (g: number) => (!isFinite(g) ? '—' : Math.abs(g) < 2 ? 'even' : `${g > 0 ? 'pin' : 'committee'} by ${secs(g)}`);

export function StartPanel() {
  const c = useCourse();
  const marks = useApp((s) => s.marks);
  const allowance = useApp((s) => s.startAllowanceSec ?? 30);
  const plan = c.startPlan;
  const st = c.start;
  if (!st) return null;
  const markName = marks[0]?.name ?? 'the first mark';
  const r1 = c.points[1]?.rounding;
  const word = plan?.kind === 'run' ? 'gybe' : 'tack';
  const Word = word === 'gybe' ? 'Gybe' : 'Tack';
  const best = plan?.best;
  const fastest = plan?.fastest;
  const twoBoard = plan && (plan.kind === 'beat' || plan.kind === 'run');
  const rows = plan ? [...plan.routes].sort((a, b) => a.timeH - b.timeH) : [];
  const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
  const planName = (r: { plan: string; parts: unknown[] }) => (r.plan === 'laylines' ? 'Laylines' : `Lane, ${r.parts.length - 1} ${word}s`);
  return (
    <section className="panel" aria-labelledby="h-start">
      <h2 id="h-start">Start strategy <span className="muted">to {markName}</span></h2>
      {best && twoBoard ? (
        <p className="verdict">
          {best.end === 'line'
            ? <>Start on the line <b>{Math.round(best.fromPinM)} m from the pin</b>, where the {best.onLayline} layline crosses it, on</>
            : <>Start at the <b>{endName(best).toLowerCase()} end</b> on</>} <b className={best.first === 'starboard' ? 'stbd-c' : 'port-c'}>{best.first}</b>
          {best.parts.length > 1 && best.tackBearing !== undefined
            ? <>, then {word} after {fmtTime(best.parts[0].hours)} when {markName} bears {fmtDeg(best.tackBearing)}T, {offBowText(best.tackBearing, best.parts[0].sail.heading)}.</>
            : <>, and you lay {markName}.</>}
          {best.plan === 'lane' ? ` Then keep off the laylines: ${best.parts.length - 1} ${word}s in all.` : ''}
        </p>
      ) : null}
      {best && twoBoard && (() => {
        const quick = [...plan!.routes].filter((r) => isFinite(r.timeH)).sort((a, b) => a.timeH - b.timeH)[0];
        return quick && quick.belowLine && quick !== best ? (
          <p className="note">
            The quickest route on paper ({endName(quick).toLowerCase()}, {quick.first} first, {secs((best.timeH - quick.timeH) * 3600)} quicker) starts by sailing back below the line, so it isn't recommended.
          </p>
        ) : null;
      })()}
      {best && fastest && twoBoard && best !== fastest && (
        <p className="note">
          This gives up {secs((best.timeH - fastest.timeH) * 3600)} on the quickest route ({endName(fastest).toLowerCase()}, {fastest.first} first, {planName(fastest).toLowerCase()})
          {Math.abs(best.risk - fastest.risk) <= 0.05 && best.first === 'starboard' && fastest.first === 'port'
            ? ` to start on starboard. That's one ${word} or less, which is less than starting on port into a starboard fleet usually costs.`
            : <>
              {' '}to spend {pct(best.nearLayline)} of the beat near a layline instead of {pct(fastest.nearLayline)}
              {best.downTide !== null && fastest.downTide !== null ? `, and ${pct(best.downTide)} down-tide instead of ${pct(fastest.downTide)}` : ''}.
            </>}
        </p>
      )}
      {best && twoBoard && best.first === 'port' && (() => {
        const stbd = plan!.routes.filter((r) => r.end === best.end && r.first === 'starboard').sort((a, b) => a.risk - b.risk || a.timeH - b.timeH)[0];
        return (
          <p className="note">
            On port you give way to every boat on starboard. If the fleet is on starboard, start on starboard and tack when you're clear
            {stbd ? `. Staying on starboard first costs ${secs((stbd.timeH - best.timeH) * 3600)}.` : '.'}
          </p>
        );
      })()}
      {!(best && twoBoard) && plan ? (
        <p className="note">Leg 1 is a {plan.kind}, so there is no tack to choose. The favoured end is still shown below.</p>
      ) : null}
      {twoBoard && (
        <Slider id="start-allow" label="Give up to" min={0} max={180} step={5} value={allowance} onStart={checkpoint} onChange={(v) => setState({ startAllowanceSec: v })} format={(v) => `${v} s`} />
      )}
      {twoBoard && <p className="small muted">How much time you'll give up on the quickest route to stay off the laylines and up-tide. 0 means fastest on paper.</p>}
      <div className="gains">
        <div className="kv"><span>Line bias to the wind on the water</span><b>{st.favoured === 'square' ? 'square' : `${Math.abs(st.bias).toFixed(0)}° to ${st.favoured}, ${Math.round(st.advantageM)} m upwind`}</b></div>
        {plan && <>
          <div className="kv"><span>Wind alone favours</span><b>{gainText(plan.gainS.wind)}</b></div>
          <div className="kv"><span>Tide on top of that</span><b>{gainText(plan.gainS.tide)}</b></div>
          <div className="kv total"><span>Fastest end to {markName}</span><b>{plan.favoured === 'even' ? 'even' : `${plan.favoured} by ${secs(plan.gainS.total)}`}</b></div>
          {plan.upTideSide && <div className="kv"><span>Up-tide side</span><b className={plan.upTideSide === 'starboard' ? 'stbd-c' : 'port-c'}>the {plan.upTideSide} tack takes you there</b></div>}
        </>}
        <div className="kv"><span>Line length</span><b>{Math.round(st.lengthM)} m</b></div>
      </div>
      {twoBoard && rows.length > 0 && (
        <div className="tablewrap">
          <table className="opts" aria-label={`Start options to ${markName}`}>
            <thead><tr><th>From</th><th>First</th><th>Plan</th><th>Time</th><th>Near layline</th><th>Down-tide</th><th>{Word} at</th><th>Mark bears</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={r === best ? 'best' : r.roundsOk && !r.belowLine ? '' : 'wrong'}>
                  <td>{endName(r)}</td>
                  <td className={r.first === 'starboard' ? 'stbd-c' : 'port-c'}>{side(r.first)}</td>
                  <td>{planName(r)}</td>
                  <td>{fmtTime(r.timeH)}{r.roundsOk ? '' : ' *'}{r.belowLine ? ' †' : ''}{fastest && r !== fastest ? (d => ` (${d < 0 ? '−' : '+'}${Math.abs(d)} s)`)(Math.round((r.timeH - fastest.timeH) * 3600)) : ''}</td>
                  <td>{pct(r.nearLayline)}</td>
                  <td>{pct(r.downTide)}</td>
                  <td>{r.parts.length > 1 ? fmtTime(r.parts[0].hours) : 'lays it'}</td>
                  <td>{r.tackBearing !== undefined ? `${fmtDeg(r.tackBearing)}T · ${offBow(r.tackBearing, r.parts[0].sail.heading)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">
        Near layline: share of the beat within {Math.round((plan?.options.margin ?? 0.2) * 100)}% of a layline (your Tacking margin), not counting the last quarter, where you have to be on one.
        Down-tide: share of the beat on the side of the line to the mark that the stream sets you towards. The pick is the route with least of both within your allowance of the quickest.
        Wind alone is the course sailed in slack water, so it shows what the line bias is worth; tide is the rest.
        {twoBoard && rows.some((r) => r.belowLine) ? ` † starts by sailing back below the start line, so it is never recommended.` : ''}
        {twoBoard && r1 ? ` * arrives on the wrong board to leave ${markName} to ${r1}, so it carries one extra ${word}.` : ''}
      </p>
    </section>
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
                <tr key={i} className={i === selected ? 'sel' : ''} onClick={() => setState({ selectedLeg: i, selectedTack: null })} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setState({ selectedLeg: i, selectedTack: null })}>
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
/** "301°T · 100° port" : true bearing and relative bearing off the bow on that board's heading. */
const both = (brg: number, heading: number | undefined) => `${fmtDeg(brg)}T${heading === undefined ? '' : ` · ${offBow(brg, heading)}`}`;
const side = (t: string) => (t === 'starboard' ? 'Stbd' : 'Port');

export function TackingPanel() {
  const c = useCourse();
  const strategy = useApp((s) => s.strategy);
  const selected = useApp((s) => s.selectedLeg);
  const selTack = useApp((s) => s.selectedTack);
  const tackIdx = selTack && selTack.leg === selected ? selTack.idx : null;
  const pick = (j: number) => setState({ selectedTack: tackIdx === j ? null : { leg: selected, idx: j } });
  const set = (p: Partial<typeof strategy>) => setState((s) => ({ strategy: { ...s.strategy, ...p } }));
  const leg: LegSolution | undefined = c.legs[selected];
  const twoBoard = leg && (leg.kind === 'beat' || leg.kind === 'run');
  const word = leg?.kind === 'run' ? 'gybe' : 'tack';
  const Word = word === 'gybe' ? 'Gybe' : 'Tack';
  const lane = strategy.mode === 'lane';
  return (
    <section className="panel" aria-labelledby="h-tack">
      <h2 id="h-tack">Tacking <span className="muted">{leg ? `Leg ${selected + 1}` : ''}</span></h2>
      <TwaSlider />
      <div className="seg seg-full" role="radiogroup" aria-label="Upwind and downwind strategy">
        {([['laylines', 'Tack on the laylines'], ['lane', 'Stay off the laylines']] as const).map(([m, t]) => (
          <button key={m} type="button" role="radio" aria-checked={strategy.mode === m} className={strategy.mode === m ? 'on' : ''} onClick={() => { checkpoint(); set({ mode: m }); }}>{t}</button>
        ))}
      </div>
      {lane && (
        <>
          <Slider id="lane-margin" label="Keep off by" min={0.1} max={0.45} step={0.05} value={strategy.margin} onStart={checkpoint} onChange={(v) => set({ margin: v })} format={(v) => `${Math.round(v * 100)}%`} />
          <Slider id="lane-tacks" label="Most tacks" min={2} max={12} step={1} value={strategy.maxTacks} onStart={checkpoint} onChange={(v) => set({ maxTacks: v })} format={(v) => `${v}`} />
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
            {lane && leg.lane?.startOff && Math.min(leg.lane.startOff.starboard, leg.lane.startOff.port) < leg.lane.margin - 0.005 && (() => {
              const off = leg.lane!.startOff!;
              const near = off.starboard < off.port ? 'starboard' : 'port';
              const pct = Math.round(Math.min(off.starboard, off.port) * 100);
              return (
                <p className="note warn">
                  Leg {selected + 1} starts only {pct}% in from the {near} layline, inside your {Math.round(strategy.margin * 100)}% margin.
                  You can't sail further from a layline once you've started, only along it ({near === 'starboard' ? 'on starboard' : 'on port'}) until it closes in.
                  So the first board runs close to the {near} layline. To keep the margin, start further from it.
                </p>
              );
            })()}
            {lane && leg.lane && <div className="kv"><span>This leg</span><b>{leg.parts.length - 1} {word}s of {strategy.maxTacks} allowed, {fmtTime(leg.timeH)}</b></div>}
            <p className="small muted bearings-h">{Word} when the mark bears (true · off the bow)</p>
            {lane && leg.lane && (
              <>
                <div className="kv"><span>Inner layline, on stbd</span><b className="stbd-c">{both(leg.lane.bearings.starboard, leg.pair?.starboard.heading)}</b></div>
                <div className="kv"><span>Inner layline, on port</span><b className="port-c">{both(leg.lane.bearings.port, leg.pair?.port.heading)}</b></div>
              </>
            )}
            <div className="kv"><span>{lane ? 'Last ' + word + ', layline' : 'Layline'}, on stbd</span><b className="stbd-c">{both(leg.tackBearings.starboard, leg.pair?.starboard.heading)}</b></div>
            <div className="kv"><span>{lane ? 'Last ' + word + ', layline' : 'Layline'}, on port</span><b className="port-c">{both(leg.tackBearings.port, leg.pair?.port.heading)}</b></div>
          </div>
          {leg.parts.length > 0 && (
            <div className="tablewrap">
              <table className="opts boards pickable" aria-label={`Boards on leg ${selected + 1}`}>
                <thead><tr><th>#</th><th>Board</th><th>CTW</th><th>CoG</th><th>Time</th><th>{Word} at: off bow</th><th>True</th></tr></thead>
                <tbody>
                  {leg.parts.map((p, j) => {
                    const last = j === leg.parts.length - 1;
                    const brg = bearingOf(sub(leg.to, p.end));
                    return (
                      <tr key={j} className={tackIdx === j ? 'sel' : ''} onClick={() => pick(j)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && pick(j)} aria-selected={tackIdx === j}>
                        <td>{j + 1}</td>
                        <td className={p.sail.tack === 'starboard' ? 'stbd-c' : 'port-c'}>{side(p.sail.tack)}</td>
                        <td>{fmtDeg(p.sail.heading)}</td>
                        <td>{fmtDeg(p.sail.cog)}</td>
                        <td>{fmtTime(p.hours)}</td>
                        <td><b>{last ? 'mark' : offBow(brg, p.sail.heading)}</b></td>
                        <td>{last ? '—' : `${fmtDeg(brg)}T`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {tackIdx !== null && leg.parts[tackIdx] ? (
            <p className="note narrative">{tackNarrative(leg, tackIdx, c.points[selected + 1]?.label ?? 'the mark', c.points[selected + 1]?.rounding)}</p>
          ) : (
            <p className="small muted">Tap a board here or on the chart for step-by-step directions.</p>
          )}
          <p className="small muted">
            With tide, the mark bears the next board's course over the ground when you reach the layline, not the next heading.
            Off the bow is the angle from your bow to the mark on that board's heading (CTW), so you can read it from the pulpit, a sight line or the instruments without a compass. Or take a hand-bearing and {word} when it reads the true bearing. Bearings are true; variation in the Solent is under 1°.
          </p>
        </>
      ) : (
        <p className="muted">{leg ? `Leg ${selected + 1} is a ${leg.kind === 'reach' ? 'reach, laid on one board' : 'blocked leg'}. Pick a beat or a run to see tack bearings.` : 'Add marks to see tack bearings.'}</p>
      )}
    </section>
  );
}

function TwaSlider() {
  const c = useCourse();
  const upTwa = useApp((s) => s.upTwa);
  const best = optimalAngles(c.boat.polar, c.wind.water.kn).up;
  const value = upTwa ?? Math.round(best.twa);
  return (
    <div className="twa-set">
      <Slider id="up-twa" label="Upwind angle" min={30} max={60} step={1} value={value} onStart={checkpoint} onChange={(v) => setState({ upTwa: v })} format={(v) => `${v}° TWA`} />
      <p className="small muted">
        {upTwa == null
          ? `From the polar: best VMG is at ${best.twa.toFixed(0)}° in ${c.wind.water.kn.toFixed(1)} kn on the water. Slide to set your own.`
          : `Your angle, tacking through about ${2 * upTwa}°. The polar's best is ${best.twa.toFixed(0)}°. Speed comes from the polar at your angle.`}
        {upTwa != null && <> <button type="button" className="linkish" onClick={() => { checkpoint(); setState({ upTwa: null }); }}>Use the polar</button></>}
      </p>
    </div>
  );
}

function SelectedLegNote({ c, i }: { c: CourseModel; i: number }) {
  const l = c.legs[i];
  if (!l) return null;
  return (
    <>
      <LegNoteBody c={c} i={i} />
      {l.rounding && !l.rounding.ok && (
        <p className="note warn">
          {c.points[i + 1].label} is left to {l.rounding.side}, but this approach turns the other way round it. Allow for sailing round the mark.
        </p>
      )}
    </>
  );
}

function LegNoteBody({ c, i }: { c: CourseModel; i: number }) {
  const l = c.legs[i];
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
        {b && l.altParts ? ` Or ${b.sail.tack} first for ${fmtTime(b.hours)}, then ${a.sail.tack} for ${fmtTime(a.hours)}.` : ''}
        {b && !l.altParts && l.rounding?.ok ? ` Finishing on ${b.sail.tack} leaves ${c.points[i + 1].label} to ${l.rounding.side}.` : ''}
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
  const speedPct = useApp((s) => s.speedPct ?? 100);
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
      <Slider id="leeway" label="Leeway" min={0} max={8} step={0.5} value={leeway} onStart={checkpoint} onChange={(v) => setState({ leewayDeg: v })} format={(v) => `${v.toFixed(1)}°`} />
      <Slider id="penalty" label="Tack cost" min={0} max={60} step={1} value={penalty} onStart={checkpoint} onChange={(v) => setState({ tackPenaltySec: v })} format={(v) => `${v} s`} />
      <Slider id="speed-pct" label="Boat speed" min={50} max={110} step={1} value={speedPct} onStart={checkpoint} onChange={(v) => setState({ speedPct: v })} format={(v) => `${v}% of polar`} />
      <p className="small muted">Scales every speed in the polar. Use it when you know you sail slower (or faster) than the polar: for example 90% turns 6.8 kn into 6.1 kn. The angles stay the same.</p>
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
        <label className="check"><input id="ly-rm" type="checkbox" checked={layers.racingMarks} onChange={() => tog('racingMarks')} />Solent racing marks</label>
        <label className="check"><input id="ly-tide" type="checkbox" checked={layers.tide} onChange={() => tog('tide')} />Tide arrows</label>
        <label className="check"><input id="ly-wind" type="checkbox" checked={layers.wind} onChange={() => tog('wind')} />Wind arrows</label>
        <label className="check"><input id="ly-trk" type="checkbox" checked={layers.track !== false} onChange={() => setState((s) => ({ layers: { ...s.layers, track: s.layers.track === false } }))} />GPS track</label>
      </div>
      <Slider id="vecmin" label="Vector length" min={2} max={60} step={1} value={vectorMin} onChange={(v) => setState({ vectorMin: v })} format={(v) => `${v} min`} />
      <p className="small muted">Vectors on the chart show where each velocity takes you in this many minutes.</p>
    </section>
  );
}

void getState; void add; void mul;
