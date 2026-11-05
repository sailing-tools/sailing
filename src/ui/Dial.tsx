import * as React from 'react';
import { fromBearing, bearingOf, norm360 } from '../nav/vec';

/** Compass dial. kind 'from' draws an arrow blowing in from the rim; 'to' draws one flowing out. */
export function Dial({ id, value, onChange, kind, label, onStart }: {
  id: string; value: number; onChange: (v: number) => void; kind: 'from' | 'to'; label: string; onStart?: () => void;
}) {
  const ref = React.useRef<SVGSVGElement>(null);
  const R = 44;
  const set = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const x = e.clientX - (r.left + r.width / 2);
    const y = -(e.clientY - (r.top + r.height / 2));
    onChange(Math.round(bearingOf({ x, y })) % 360);
  };
  const rim = fromBearing(value, R - 6);
  const a = kind === 'from'
    ? { x1: rim.x, y1: -rim.y, x2: -rim.x * 0.45, y2: rim.y * 0.45 }
    : { x1: -rim.x * 0.45, y1: rim.y * 0.45, x2: rim.x, y2: -rim.y };
  const step = (d: number) => onChange(norm360(Math.round(value) + d));
  return (
    <div className="dial">
      <svg
        ref={ref}
        viewBox="-52 -52 104 104"
        className={`dial-svg dial-${kind}`}
        role="slider"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={359}
        aria-valuenow={Math.round(value)}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); step(e.shiftKey ? 1 : 5); }
          if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); step(e.shiftKey ? -1 : -5); }
        }}
        onPointerDown={(e) => { onStart?.(); (e.currentTarget as Element).setPointerCapture(e.pointerId); set(e); }}
        onPointerMove={(e) => { if (e.buttons || e.pointerType === 'touch') { if ((e.currentTarget as Element).hasPointerCapture(e.pointerId)) set(e); } }}
      >
        <defs>
          <marker id={`dah-${id}`} viewBox="-10 -5 11 10" refX={0} refY={0} markerWidth={11} markerHeight={10} markerUnits="userSpaceOnUse" orient="auto">
            <path d="M-8,-4 L0,0 L-8,4" className="dial-ah" />
          </marker>
        </defs>
        <circle r={R} className="dial-ring" />
        {Array.from({ length: 36 }, (_, i) => {
          const p1 = fromBearing(i * 10, R), p2 = fromBearing(i * 10, i % 9 === 0 ? R - 7 : R - 3.5);
          return <line key={i} x1={p1.x} y1={-p1.y} x2={p2.x} y2={-p2.y} className="dial-tick" />;
        })}
        {[0, 90, 180, 270].map((b) => { const p = fromBearing(b, R - 13); return <text key={b} x={p.x} y={-p.y} dy="0.35em" className="dial-t">{'NESW'[b / 90]}</text>; })}
        <line {...a} className="dial-arrow" markerEnd={`url(#dah-${id})`} />
      </svg>
      <div className="dial-num">
        <button type="button" onClick={() => { onStart?.(); step(-5); }} aria-label={`${label} minus 5 degrees`}>−</button>
        <label htmlFor={`${id}-deg`} className="sr">{label} in degrees</label>
        <input id={`${id}-deg`} type="number" min={0} max={359} value={Math.round(value)} onFocus={onStart} onChange={(e) => onChange(norm360(Number(e.target.value) || 0))} />
        <span className="unit">°{kind === 'from' ? ' from' : ' to'}</span>
        <button type="button" onClick={() => { onStart?.(); step(5); }} aria-label={`${label} plus 5 degrees`}>+</button>
      </div>
    </div>
  );
}

export function Speed({ id, value, onChange, max, label, onStart, step = 0.1 }: {
  id: string; value: number; onChange: (v: number) => void; max: number; label: string; onStart?: () => void; step?: number;
}) {
  return (
    <div className="speed">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="range" min={0} max={max} step={step} value={value} onPointerDown={onStart} onChange={(e) => onChange(Number(e.target.value))} />
      <output htmlFor={id}>{value.toFixed(1)} kn</output>
    </div>
  );
}
