import * as React from 'react';
import { useApp, setState, getState, checkpoint } from '../store';
import { useCourse, fmtDeg, fmtKn, toXY } from '../course';
import { parseGpx, analyseTrack, findStart, groundWind, Fix, TrackAnalysis, BoardKind } from '../nav/track';
import { optimalAngles } from '../nav/polar';
import { bearingOf, len } from '../nav/vec';
import { Slider } from './Dial';

export interface TrackModel { fixes: Fix[]; a: TrackAnalysis; startT: number | null; autoStart: boolean; twa: number }

/** The imported track analysed with the current course and boat. */
export function useTrackAnalysis(): TrackModel | null {
  const track = useApp((s) => s.track);
  const marks = useApp((s) => s.marks);
  const startLine = useApp((s) => s.startLine);
  const c = useCourse();
  const polar = c.boat.polar;
  return React.useMemo(() => {
    if (!track || track.fixes.length < 20) return null;
    const fixes: Fix[] = track.fixes.map((f) => ({ t: f.t, p: { x: f.x, y: f.y } }));
    const auto = track.gunT === undefined;
    const startT = auto ? (startLine && marks[0] ? findStart(fixes, startLine.committee, startLine.pin, marks[0].pos) : null) : track.gunT!;
    const opts = { polar, marks: [...marks.map((m) => m.pos), ...(startLine ? [startLine.committee, startLine.pin] : [])], windFrom: c.wind.ground.from, startT: startT ?? undefined };
    // The upwind angle depends on the wind speed the track gives, so settle it in a couple of passes.
    let twa = track.twa ?? optimalAngles(polar, c.wind.water.kn).up.twa;
    let a = analyseTrack(fixes, { ...opts, twa });
    if (track.twa === undefined) {
      for (let k = 0; k < 2 && a.wind?.tws; k++) { twa = optimalAngles(polar, a.wind.tws).up.twa; a = analyseTrack(fixes, { ...opts, twa }); }
    }
    return { fixes, a, startT, autoStart: auto, twa };
  }, [track, marks, startLine, polar, c.wind.ground.from, c.wind.water.kn]);
}

const clock = (unix: number) => new Date(unix * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const mmss = (s: number) => `${s < 0 ? '−' : ''}${Math.floor(Math.abs(s) / 60)}:${String(Math.round(Math.abs(s) % 60)).padStart(2, '0')}`;
const KIND: Record<BoardKind, string> = { starboard: 'Starboard', port: 'Port', downwind: 'Downwind', reach: 'Reach', prestart: 'Pre-start' };

async function importGpx(f: File) {
  const pts = parseGpx(await f.text());
  if (pts.length < 20) throw new Error('No track points found in that file. Export the activity as GPX.');
  // Keep one fix every 2 seconds at most, so a long race still fits in the browser's storage.
  const kept: typeof pts = [];
  for (const p of pts) if (!kept.length || p.t - kept[kept.length - 1].t >= 2) kept.push(p);
  const t0 = kept[0].t;
  const fixes = kept.map((p) => { const q = toXY(p.lon, p.lat); return { t: Math.round(p.t - t0), x: +q.x.toFixed(5), y: +q.y.toFixed(5) }; });
  setState({ track: { name: f.name.replace(/\.gpx$/i, ''), startUnix: t0, fixes }, layers: { ...getState().layers, track: true } });
}

/** A small chart of the wind direction worked out minute by minute from each upwind board. */
function ShiftChart({ m }: { m: TrackModel }) {
  const sh = m.a.shifts;
  if (sh.length < 3 || !m.a.wind) return null;
  const base = m.a.wind.from;
  const off = (d: number) => ((d - base + 540) % 360) - 180;
  const t0 = m.startT ?? 0, tMax = Math.max(...sh.map((s) => s.t)) - t0, tMin = Math.min(0, ...sh.map((s) => s.t - t0));
  const W = 300, H = 110, span = 25;
  const x = (t: number) => 28 + ((t - t0 - tMin) / Math.max(60, tMax - tMin)) * (W - 36);
  const y = (d: number) => H / 2 - (Math.max(-span, Math.min(span, off(d))) / span) * (H / 2 - 10);
  return (
    <figure className="shiftchart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Wind direction through the race">
        <line x1={28} x2={W - 8} y1={H / 2} y2={H / 2} className="axis" />
        <text x={24} y={H / 2 + 4} className="tick" textAnchor="end">{fmtDeg(base)}</text>
        <text x={24} y={14} className="tick" textAnchor="end">+{span}</text>
        <text x={24} y={H - 6} className="tick" textAnchor="end">−{span}</text>
        {sh.map((s, i) => <circle key={i} cx={x(s.t)} cy={y(s.from)} r={2.4} className={`dot ${s.kind}`} />)}
      </svg>
      <figcaption className="small muted">Wind direction each minute on the beats (dots above the line are a veer, below a back). Starboard green, port red.</figcaption>
    </figure>
  );
}

export function TrackPanel() {
  const track = useApp((s) => s.track);
  const marks = useApp((s) => s.marks);
  const m = useTrackAnalysis();
  const [err, setErr] = React.useState<string | null>(null);
  const [gun, setGun] = React.useState('');
  const fileRef = React.useRef<HTMLInputElement>(null);
  const setTrack = (p: Partial<NonNullable<typeof track>>) => setState((s) => ({ track: s.track ? { ...s.track, ...p } : s.track }));
  const onFile = async (f?: File) => {
    if (!f) return;
    try { await importGpx(f); setErr(null); } catch (e: any) { setErr(e.message); }
    if (fileRef.current) fileRef.current.value = '';
  };
  const applyGun = () => {
    if (!track) return;
    const mt = /^(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?$/.exec(gun.trim());
    if (!mt) { setErr('Type the gun time as hh:mm or hh:mm:ss.'); return; }
    const d = new Date(track.startUnix * 1000);
    d.setHours(+mt[1], +mt[2], +(mt[3] ?? 0), 0);
    const t = d.getTime() / 1000 - track.startUnix;
    if (t < 0 || t > track.fixes[track.fixes.length - 1].t) { setErr('That time is outside the track.'); return; }
    setErr(null); setTrack({ gunT: Math.round(t) });
  };
  const w = m?.a.wind;
  const useConditions = () => {
    if (!w || !w.tws) return;
    const g = groundWind(w.from, w.tws, w.tide);
    checkpoint();
    setState((s) => ({ cond: { ...s.cond, windFrom: Math.round(g.from), windKn: Math.round(g.kn * 10) / 10, tideTo: Math.round(bearingOf(w.tide)), tideKn: Math.round(len(w.tide) * 10) / 10 } }));
  };
  const rel = (t: number) => mmss(t - (m?.startT ?? 0));
  const markName = (i: number) => (i < marks.length ? marks[i].name : i === marks.length ? 'the committee' : 'the pin');
  return (
    <section className="panel" aria-labelledby="h-track">
      <h2 id="h-track">Race track <span className="muted">from a GPS file</span></h2>
      <div className="row">
        <label className="filebtn">
          <input ref={fileRef} type="file" accept=".gpx,application/gpx+xml" onChange={(e) => onFile(e.target.files?.[0])} />
          <span>{track ? 'Load another GPX' : 'Load a GPX track'}</span>
        </label>
        {track && <button type="button" className="danger" onClick={() => setState({ track: null })}>Remove track</button>}
      </div>
      {err && <p className="note warn">{err}</p>}
      {!track && <p className="small muted">Export the race from Garmin Connect (or any GPS app) as GPX. Set up the course first: the analysis uses the start line and the marks to find the start, the roundings and the laylines.</p>}
      {track && m && (
        <>
          <p className="small">
            <b>{track.name}</b>, {clock(track.startUnix)} to {clock(track.startUnix + m.a.durationS)}.{' '}
            {m.startT !== null ? <>Start at <b>{clock(track.startUnix + m.startT)}</b> {m.autoStart ? '(where the track crosses the start line)' : '(gun time you entered)'}.</> : <>No start found: set up the start line, or type the gun time.</>}
          </p>
          <div className="row">
            <label htmlFor="gun" className="small">Gun time</label>
            <input id="gun" className="short" placeholder="hh:mm:ss" value={gun} onChange={(e) => setGun(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') applyGun(); }} />
            <button type="button" onClick={applyGun} disabled={!gun.trim()}>Set</button>
            {!m.autoStart && <button type="button" onClick={() => { setGun(''); setTrack({ gunT: undefined }); }}>Auto</button>}
          </div>
          {w ? (
            <>
              <div className="kv"><span>Wind on the water</span><b>{fmtDeg(w.from)}{w.tws ? ` at about ${fmtKn(w.tws)}` : ''}</b></div>
              <div className="kv"><span>Tide</span><b>{fmtDeg(bearingOf(w.tide))} at {fmtKn(len(w.tide))}</b></div>
              <div className="kv"><span>Upwind speed through the water</span><b>{fmtKn(w.stw)} at TWA {Math.round(m.twa)}°</b></div>
              <div className="kv"><span>Tacking angle</span><b>{Math.round(w.groundTack)}° over the ground</b></div>
              <div className="row">
                <button type="button" className="primary" onClick={useConditions} disabled={!w.tws}>Use as wind and tide</button>
              </div>
              <Slider id="trk-twa" label="Upwind TWA" min={34} max={56} step={1} value={Math.round(m.twa)} onChange={(v) => setTrack({ twa: v })} format={(v) => `${v}°`} />
              <p className="small muted">
                The difference between the starboard and port tracks over the ground lies across the wind, whatever the tide, so it gives the wind direction. The track can't show the angle you sailed to the wind, so it uses the polar's best upwind angle (change it with the slider). That sets the speed through the water, and what is left over is tide.
                {track.twa !== undefined && <> <button type="button" className="linkish" onClick={() => setTrack({ twa: undefined })}>Use the polar's angle</button></>}
              </p>
            </>
          ) : (
            <p className="note">Not enough time on both tacks to work out the wind. It needs at least 90 seconds on each.</p>
          )}
          {m.a.overstands.length > 0 && (
            <>
              <h3>Laylines overstood</h3>
              <ul className="small">
                {m.a.overstands.map((o, i) => (
                  <li key={i}>
                    At {rel(m.a.boards[o.board].t1)} you sailed about <b>{Math.round(o.seconds)} s</b> past the layline to {markName(o.markIndex)}. Tack when it bears {fmtDeg(o.laylineBearing)}; you tacked at {fmtDeg(o.bearingAtTack)}.
                  </li>
                ))}
              </ul>
            </>
          )}
          <ShiftChart m={m} />
          <details>
            <summary>Boards ({m.a.boards.filter((b) => b.kind !== 'prestart').length})</summary>
            <table className="opts boards">
              <thead><tr><th>From</th><th>Board</th><th>Time</th><th>COG</th><th>SOG</th></tr></thead>
              <tbody>
                {m.a.boards.filter((b) => b.kind !== 'prestart').map((b, i) => (
                  <tr key={i}>
                    <td>{rel(b.t0)}</td>
                    <td className={b.kind === 'starboard' ? 'stbd-c' : b.kind === 'port' ? 'port-c' : ''}>{KIND[b.kind]}</td>
                    <td>{mmss(b.t1 - b.t0)}</td>
                    <td>{fmtDeg(b.cog)}</td>
                    <td>{b.sog.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small muted">Times are from the start. Course and speed are over the ground.</p>
          </details>
        </>
      )}
    </section>
  );
}
