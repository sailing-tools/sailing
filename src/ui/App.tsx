import * as React from 'react';
import { useApp, setState, getState, undo, resetAll, Tool } from '../store';
import { Chart } from './Chart';
import { TrackPanel } from './TrackPanel';
import { LinePanel } from './LinePanel';
import { computeCourse } from '../course';
import { ConditionsPanel, CoursePanel, StartPanel, LegsPanel, TackingPanel, VectorPanel, BoatPanel, DisplayPanel } from './Panels';

function fitView() {
  const s = getState();
  const pts = [...s.marks.map((m) => m.pos)];
  if (s.startLine) pts.push(s.startLine.committee, s.startLine.pin);
  if (s.probe) pts.push(s.probe);
  const cm = computeCourse(s);
  const legs = [...cm.legs, ...(cm.start && s.layers.startOptions ? [cm.start.pinLeg, cm.start.committeeLeg] : [])];
  for (const l of legs) if (l) for (const p of [...l.parts, ...(s.layers.bothRoutes ? l.altParts ?? [] : [])]) pts.push(p.end);
  const el = document.querySelector('.chart-svg') as SVGSVGElement | null;
  if (!pts.length || !el) return;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = el.clientWidth, h = el.clientHeight;
  const scale = Math.min(6000, Math.max(20, Math.min((w - 120) / Math.max(0.2, maxX - minX), (h - 160) / Math.max(0.2, maxY - minY))));
  setState({ view: { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, scale } });
}

const TOOLS: { id: Tool; label: string; icon: string }[] = [
  { id: 'select', label: 'Move', icon: 'M4 4l7 16 2-7 7-2z' },
  { id: 'start', label: 'Start line', icon: 'M5 20V4M5 5h10l-2 3 2 3H5' },
  { id: 'mark', label: 'Add mark', icon: 'M12 3v4M12 21a5 5 0 100-10 5 5 0 000 10zM9 7h6' },
  { id: 'probe', label: 'Probe', icon: 'M12 3v6M12 15v6M3 12h6M15 12h6' },
];

function Toolbar() {
  const tool = useApp((s) => s.tool);
  const probe = useApp((s) => s.probe);
  return (
    <div className="toolbar" role="toolbar" aria-label="Chart tools">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={tool === t.id ? 'on' : ''}
          aria-pressed={tool === t.id}
          onClick={() => setState({ tool: t.id, pendingCommittee: null, ...(t.id === 'probe' || !probe ? {} : {}) })}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden><path d={t.icon} /></svg>
          <span>{t.label}</span>
        </button>
      ))}
      <span className="sep" aria-hidden />
      {probe && <button type="button" onClick={() => setState({ probe: null })}><span>Clear probe</span></button>}
      <button type="button" onClick={undo} aria-label="Undo"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden><path d="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3" /></svg><span>Undo</span></button>
      <button type="button" onClick={fitView}><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg><span>Fit</span></button>
    </div>
  );
}

export function App() {
  const base = useApp((s) => s.base);
  const [confirmReset, setConfirmReset] = React.useState(false);
  React.useEffect(() => { const t = setTimeout(fitView, 50); return () => clearTimeout(t); }, []);
  React.useEffect(() => { const f = () => setTimeout(fitView, 30); window.addEventListener('course-loaded', f); return () => window.removeEventListener('course-loaded', f); }, []);
  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <h1>Solent Race Calculator</h1>
          <span className="sub">Laylines and courses with tide</span>
        </div>
        <div className="seg" role="radiogroup" aria-label="Background">
          {(['chart', 'grid'] as const).map((b) => (
            <button key={b} type="button" role="radio" aria-checked={base === b} className={base === b ? 'on' : ''} onClick={() => setState({ base: b })}>
              {b === 'chart' ? 'Chart' : 'Grid'}
            </button>
          ))}
        </div>
      </header>
      <main className="chart-area">
        <Chart />
        <Toolbar />
      </main>
      <aside className="side">
        <ConditionsPanel />
        <LinePanel />
        <StartPanel />
        <LegsPanel />
        <TackingPanel />
        <VectorPanel />
        <CoursePanel />
        <TrackPanel />
        <BoatPanel />
        <DisplayPanel />
        <section className="panel">
          {confirmReset ? (
            <div className="row">
              <span>Replace everything with the example course?</span>
              <button type="button" className="danger" onClick={() => { resetAll(); setConfirmReset(false); setTimeout(fitView, 30); }}>Reset</button>
              <button type="button" onClick={() => setConfirmReset(false)}>Keep</button>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirmReset(true)}>Reset to example course</button>
          )}
          <p className="small muted">Your set-up is saved in this browser. Tide is treated as one uniform stream across the course. Estimates only, not for navigation.</p>
        </section>
      </aside>
    </div>
  );
}
