import * as React from 'react';
import { useApp, setState, getState, checkpoint } from '../store';
import { fmtDeg, toLonLat } from '../course';
import { findSolentMark, fmtLatLon } from '../marks';
import { parseLatLon, latLonToXY, offset, gpsFix } from '../geo';
import { Vec, sub, len, bearingOf, norm360 } from '../nav/vec';

type End = 'committee' | 'pin';

/** A position typed by hand: lat/lon, or a Solent mark code or name. */
function readPos(text: string): Vec | null {
  const ll = parseLatLon(text);
  if (ll) return latLonToXY(ll);
  const m = findSolentMark(text);
  return m ? latLonToXY({ lat: m.lat, lon: m.lon }) : null;
}

const show = (p: Vec) => { const q = toLonLat(p); return fmtLatLon(q.lat, q.lon); };

/** Set up the start line by pinging each end with the phone's GPS, typing positions, or a bearing and length. */
export function LinePanel() {
  const line = useApp((s) => s.startLine);
  const [half, setHalf] = React.useState<{ end: End; pos: Vec } | null>(null);
  const [busy, setBusy] = React.useState<End | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const [txt, setTxt] = React.useState<Record<End, string>>({ committee: '', pin: '' });
  const [brg, setBrg] = React.useState('');
  const [mag, setMag] = React.useState(true);
  const [vari, setVari] = React.useState('1');
  const [lenM, setLenM] = React.useState('');

  const put = (end: End, pos: Vec) => {
    const cur = getState().startLine;
    const other: End = end === 'pin' ? 'committee' : 'pin';
    const otherPos = cur ? cur[other] : half && half.end === other ? half.pos : null;
    if (!otherPos) { setHalf({ end, pos }); return; }
    checkpoint();
    setState({ startLine: end === 'pin' ? { pin: pos, committee: otherPos } : { committee: pos, pin: otherPos }, pendingCommittee: null });
    setHalf(null);
  };

  const ping = async (end: End) => {
    setBusy(end); setErr(null); setMsg(null);
    try {
      const f = await gpsFix();
      put(end, f.pos);
      setMsg(`${end === 'pin' ? 'Pin' : 'Committee'} at ${fmtLatLon(f.lat, f.lon)}, to within about ${Math.round(f.accuracyM)} m.`);
    } catch (e: any) { setErr(e.message); }
    setBusy(null);
  };

  const typed = (end: End) => {
    const p = readPos(txt[end]);
    if (!p) { setErr(`Can't read "${txt[end]}". Type a position like 50 45.49N 1 13.35W, or a mark code like 42.`); return; }
    setErr(null);
    put(end, p);
    setMsg(null);
    setTxt((t) => ({ ...t, [end]: '' }));
  };

  const byBearing = () => {
    const pin = getState().startLine?.pin ?? (half?.end === 'pin' ? half.pos : null);
    const b = parseFloat(brg), l = parseFloat(lenM), v = parseFloat(vari) || 0;
    if (!pin) { setErr('Set the pin first, then the bearing and length to the committee boat.'); return; }
    if (!isFinite(b) || !isFinite(l) || l <= 0) { setErr('Type the bearing in degrees and the length in metres.'); return; }
    const t = norm360(mag ? b + v : b);
    setErr(null);
    put('committee', offset(pin, t, l));
    setMsg(`Committee boat ${Math.round(l)} m from the pin on ${fmtDeg(t)}T.`);
  };

  const L = line ? sub(line.committee, line.pin) : null;
  return (
    <section className="panel" aria-labelledby="h-line">
      <h2 id="h-line">Start line</h2>
      {line && L ? (
        <p className="small">
          Pin to committee <b>{fmtDeg(bearingOf(L))}T</b>, <b>{Math.round(len(L) * 1852)} m</b>.<br />
          <span className="muted">Pin {show(line.pin)}. Committee {show(line.committee)}.</span>
        </p>
      ) : (
        <p className="small muted">No line yet. Ping each end as you sail past it, or type the positions.</p>
      )}
      <div className="row">
        <button type="button" className="primary" onClick={() => ping('pin')} disabled={!!busy}>{busy === 'pin' ? 'Getting a fix…' : 'Ping pin'}</button>
        <button type="button" className="primary" onClick={() => ping('committee')} disabled={!!busy}>{busy === 'committee' ? 'Getting a fix…' : 'Ping committee'}</button>
      </div>
      <p className="small muted">Ping when the end is right beside you. The phone's GPS is good to 5–10 m, so ping each end close aboard.</p>
      {half && <p className="note">{half.end === 'pin' ? 'Pin' : 'Committee'} set at {show(half.pos)}. Waiting for the {half.end === 'pin' ? 'committee boat' : 'pin'}.</p>}
      {msg && <p className="note">{msg}</p>}
      {err && <p className="note warn">{err}</p>}
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide typed entry' : 'Type positions or a bearing'}</button>
      {open && (
        <div className="import">
          {(['pin', 'committee'] as End[]).map((end) => (
            <div key={end}>
              <label htmlFor={`pos-${end}`} className="small">{end === 'pin' ? 'Pin' : 'Committee boat'}: lat/lon or mark code</label>
              <div className="row">
                <input id={`pos-${end}`} value={txt[end]} placeholder="50 45.49N 1 13.35W, or 42" onChange={(e) => setTxt((t) => ({ ...t, [end]: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') typed(end); }} />
                <button type="button" onClick={() => typed(end)} disabled={!txt[end].trim()}>Set</button>
              </div>
            </div>
          ))}
          <p className="small"><b>Or from the pin:</b> bearing and length to the committee boat.</p>
          <div className="row wrap">
            <label className="sr" htmlFor="ln-brg">Bearing</label>
            <input id="ln-brg" className="short" inputMode="decimal" placeholder="Bearing" value={brg} onChange={(e) => setBrg(e.target.value)} />
            <div className="seg small" role="radiogroup" aria-label="Bearing reference">
              <button type="button" role="radio" aria-checked={mag} className={mag ? 'on' : ''} onClick={() => setMag(true)}>°M</button>
              <button type="button" role="radio" aria-checked={!mag} className={!mag ? 'on' : ''} onClick={() => setMag(false)}>°T</button>
            </div>
            <label className="sr" htmlFor="ln-len">Length in metres</label>
            <input id="ln-len" className="short" inputMode="decimal" placeholder="Metres" value={lenM} onChange={(e) => setLenM(e.target.value)} />
            <button type="button" onClick={byBearing}>Set</button>
          </div>
          {mag && (
            <div className="row">
              <label htmlFor="ln-var" className="small">Variation, °E (west is negative)</label>
              <input id="ln-var" className="short" inputMode="decimal" value={vari} onChange={(e) => setVari(e.target.value)} />
            </div>
          )}
          <p className="small muted">Solent variation is about 1°E in 2026, so magnetic and true are almost the same. Check your compass against a transit: a deviation of 10° matters far more.</p>
        </div>
      )}
    </section>
  );
}
