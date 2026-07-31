import { Play } from 'lucide-react'
import { useCallback, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import {
  BEZIER_PRESETS,
  type Bezier,
  clampBezier,
  clampBezierX,
  clampBezierY,
  displayBezierPreset,
  formatBezier
} from '@/lib/css-values'
import { cn } from '@/lib/utils'

// Both now live in `lib/css-values.ts` (they're value math, and `sameCssValue`
// needs TW_EASE_EQUIV — a lib→component import). Re-exported here so existing
// importers of the editor keep working.
export { displayBezierPreset, TW_EASE_EQUIV } from '@/lib/css-values'

/**
 * BezierEditor — draggable cubic-bezier curve editor for
 * transition-timing-function. Pure component: no window.api calls; the parent
 * wires onChange → styles.preview and onCommit → styles.apply.
 *
 * SVG curve area with two pointer-CAPTURE-dragged handles (capture is fine
 * here — unlike ScrubInput the handle tracks the absolute pointer position,
 * so there's no relative travel to lose at the island view's edge), keyword
 * preset chips, and a demo dot that replays a fixed-duration slide using the
 * current curve as its easing (Web Animations API — restarted whenever the
 * curve changes, and by the Replay button).
 *
 * Model: x ∈ [0,1] (CSS spec), y ∈ [-1,2] (overshoot renders above/below the
 * unit square — the square + quarter grid are drawn subtly inside the area).
 */
export interface BezierEditorProps {
  value: Bezier
  disabled?: boolean
  /** Live while dragging a handle — the caller throttles the preview. */
  onChange: (b: Bezier) => void
  /** Drag end / preset chip click / keyboard nudge. */
  onCommit: (b: Bezier) => void
  /** Replay clicked — the caller re-runs the last change on the real element. */
  onReplay?: () => void
}

// --- geometry (fixed-size svg; 236px fits the 268px island card) -----------
const W = 236
const H = 196
const PAD = 10 // room for handle circles at the edges
const PLOT_W = W - PAD * 2
const PLOT_H = H - PAD * 2
const Y_MAX = 2 // editor y range [-1, 2]
const Y_SPAN = 3

const xToPx = (x: number): number => PAD + x * PLOT_W
const yToPx = (y: number): number => PAD + ((Y_MAX - y) / Y_SPAN) * PLOT_H

/** Demo slide duration — long enough to read overshoot, short enough to spam. */
const DEMO_MS = 900

/** Trailing debounce for curve-change restarts — a drag restarts the demo on
 * pauses instead of pinning the dot to the start on every pointermove. */
const RESTART_DEBOUNCE_MS = 150

const round2 = (n: number): number => Number(n.toFixed(2))

type HandleId = 1 | 2

function withHandle(base: Bezier, handle: HandleId, p: { x: number; y: number }): Bezier {
  return handle === 1 ? { ...base, x1: p.x, y1: p.y } : { ...base, x2: p.x, y2: p.y }
}

const KEY_DIRS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1]
}

export default function BezierEditor({
  value,
  disabled,
  onChange,
  onCommit,
  onReplay
}: BezierEditorProps): React.JSX.Element {
  // Defensive: computed input may carry float noise. TimingRow gates curves
  // whose y falls outside the editor's [-1,2] range to its edit-via-chat
  // branch, so this clamp never silently rewrites an authored overshoot.
  const b = clampBezier(value)
  const bezierCss = formatBezier(b)

  const svgRef = useRef<SVGSVGElement>(null)
  /** Non-null exactly while a handle drag is active. `pointerId` pins the
   * drag to its capturing pointer — capture is per-pointer, so without it a
   * second touch pointer over the other circle could move or commit this one. */
  const dragRef = useRef<{
    handle: HandleId
    pointerId: number
    last: Bezier
    moved: boolean
  } | null>(null)

  // --- demo dot (Web Animations API) ---------------------------------------
  const trackRef = useRef<HTMLDivElement>(null)
  const dotRef = useRef<HTMLDivElement>(null)
  const animRef = useRef<Animation | null>(null)

  /** Cancel-and-restart the demo slide with the given easing (stable). */
  const runDemo = useCallback((easing: string): void => {
    const track = trackRef.current
    const dot = dotRef.current
    if (!track || !dot) return
    animRef.current?.cancel()
    const dist = track.clientWidth - dot.offsetWidth
    if (dist <= 0) return
    animRef.current = dot.animate(
      [{ transform: 'translateX(0px)' }, { transform: `translateX(${dist}px)` }],
      { duration: DEMO_MS, easing, fill: 'both' }
    )
  }, [])

  // Restart the demo whenever the curve changes (debounced — see above).
  useEffect(() => {
    const id = window.setTimeout(() => runDemo(bezierCss), RESTART_DEBOUNCE_MS)
    return () => window.clearTimeout(id)
  }, [bezierCss, runDemo])

  // Unmount: drop the animation with the nodes.
  useEffect(() => () => animRef.current?.cancel(), [])

  // --- handle dragging (pointer capture) -----------------------------------

  const pointToBezier = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return null
    // Scale-aware (the svg renders at its fixed size, but cheap to be exact).
    const px = (clientX - rect.left) * (W / rect.width)
    const py = (clientY - rect.top) * (H / rect.height)
    return {
      x: round2(clampBezierX((px - PAD) / PLOT_W)),
      y: round2(clampBezierY(Y_MAX - ((py - PAD) / PLOT_H) * Y_SPAN))
    }
  }

  const onHandleDown =
    (handle: HandleId) =>
    (e: React.PointerEvent<SVGCircleElement>): void => {
      if (disabled || e.button !== 0 || dragRef.current) return
      e.preventDefault()
      // preventDefault suppresses focus-on-click (with the compat mousedown),
      // and the arrow-key nudges need focus — grant it explicitly.
      e.currentTarget.focus()
      e.currentTarget.setPointerCapture(e.pointerId)
      dragRef.current = { handle, pointerId: e.pointerId, last: b, moved: false }
    }

  const onHandleMove = (e: React.PointerEvent<SVGCircleElement>): void => {
    const drag = dragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    const p = pointToBezier(e.clientX, e.clientY)
    if (!p) return
    const next = withHandle(drag.last, drag.handle, p)
    if (
      next.x1 === drag.last.x1 &&
      next.y1 === drag.last.y1 &&
      next.x2 === drag.last.x2 &&
      next.y2 === drag.last.y2
    )
      return
    drag.last = next
    drag.moved = true
    onChange(next)
  }

  /** Release, cancel, and lost-capture all land here; commit-at-current, once.
   * An unmoved press (click on the handle) commits nothing — a same-value
   * commit would splice a spurious edit into source. */
  const endDrag = (e: React.PointerEvent<SVGCircleElement>): void => {
    const drag = dragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    dragRef.current = null
    if (drag.moved) onCommit(drag.last)
  }

  const onHandleKeyDown =
    (handle: HandleId) =>
    (e: React.KeyboardEvent<SVGCircleElement>): void => {
      if (disabled) return
      const dir = KEY_DIRS[e.key]
      if (!dir) return
      e.preventDefault()
      const step = e.shiftKey ? 0.1 : 0.01
      const cx = handle === 1 ? b.x1 : b.x2
      const cy = handle === 1 ? b.y1 : b.y2
      const p = {
        x: round2(clampBezierX(cx + dir[0] * step)),
        y: round2(clampBezierY(cy + dir[1] * step))
      }
      if (p.x === cx && p.y === cy) return
      onCommit(withHandle(b, handle, p)) // per-nudge commit; edit-history coalesces
    }

  // --- render ---------------------------------------------------------------

  const activePreset = displayBezierPreset(b)
  const yTop = yToPx(1) // unit square top
  const yBot = yToPx(0) // unit square bottom

  const handles: { id: HandleId; hx: number; hy: number; fromX: number; fromY: number }[] = [
    { id: 1, hx: b.x1, hy: b.y1, fromX: 0, fromY: 0 },
    { id: 2, hx: b.x2, hy: b.y2, fromX: 1, fromY: 1 }
  ]

  return (
    <div className={cn('bezier flex w-[236px] flex-col gap-1.5', disabled && 'opacity-50')}>
      <svg
        ref={svgRef}
        className="bezier__svg select-none rounded-md border border-input bg-muted/20"
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Easing curve ${activePreset ?? formatBezier(b)}`}
      >
        {/* quarter grid inside the unit square */}
        <g className="text-muted-foreground" stroke="currentColor" strokeOpacity={0.15}>
          {[0.25, 0.5, 0.75].map((t) => (
            <line key={`v${t}`} x1={xToPx(t)} y1={yTop} x2={xToPx(t)} y2={yBot} />
          ))}
          {[0.25, 0.5, 0.75].map((t) => (
            <line key={`h${t}`} x1={xToPx(0)} y1={yToPx(t)} x2={xToPx(1)} y2={yToPx(t)} />
          ))}
        </g>
        {/* the unit square — overshoot area extends above and below it */}
        <rect
          className="text-muted-foreground"
          x={xToPx(0)}
          y={yTop}
          width={PLOT_W}
          height={yBot - yTop}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.35}
        />
        {/* control arms */}
        <g className="text-muted-foreground" stroke="currentColor" strokeOpacity={0.5}>
          {handles.map((h) => (
            <line
              key={h.id}
              x1={xToPx(h.fromX)}
              y1={yToPx(h.fromY)}
              x2={xToPx(h.hx)}
              y2={yToPx(h.hy)}
            />
          ))}
        </g>
        {/* the curve */}
        <path
          className="bezier__curve text-primary"
          d={`M ${xToPx(0)} ${yToPx(0)} C ${xToPx(b.x1)} ${yToPx(b.y1)}, ${xToPx(b.x2)} ${yToPx(b.y2)}, ${xToPx(1)} ${yToPx(1)}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        />
        {/* fixed endpoints */}
        <g className="text-muted-foreground" fill="currentColor">
          <circle cx={xToPx(0)} cy={yToPx(0)} r={3} />
          <circle cx={xToPx(1)} cy={yToPx(1)} r={3} />
        </g>
        {/* draggable control-point handles */}
        {handles.map((h) => (
          <circle
            key={h.id}
            className={cn(
              'bezier__handle text-primary',
              disabled ? 'pointer-events-none' : 'cursor-grab'
            )}
            cx={xToPx(h.hx)}
            cy={yToPx(h.hy)}
            r={5}
            fill="currentColor"
            stroke="var(--background)"
            strokeWidth={1.5}
            tabIndex={disabled ? -1 : 0}
            role="slider"
            aria-label={`Control point ${h.id}`}
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={h.hx}
            aria-valuetext={`${h.hx}, ${h.hy}`}
            onPointerDown={onHandleDown(h.id)}
            onPointerMove={onHandleMove}
            onPointerUp={endDrag}
            onLostPointerCapture={endDrag}
            onKeyDown={onHandleKeyDown(h.id)}
          />
        ))}
      </svg>

      {/* keyword preset chips */}
      <div className="bezier__presets flex flex-wrap items-center gap-0.5">
        {Object.keys(BEZIER_PRESETS).map((name) => (
          <Button
            key={name}
            variant={activePreset === name ? 'secondary' : 'ghost'}
            size="sm"
            className="bezier__preset h-5 rounded px-1 text-[10px] font-normal"
            disabled={disabled}
            onClick={() => onCommit({ ...BEZIER_PRESETS[name] })}
          >
            {name}
          </Button>
        ))}
      </div>

      {/* demo dot + replay */}
      <div className="bezier__demo flex items-center gap-2">
        <div ref={trackRef} className="bezier__track relative flex h-4 min-w-0 flex-1 items-center">
          <div className="absolute inset-x-0 top-1/2 h-px bg-border" aria-hidden="true" />
          <div ref={dotRef} className="bezier__dot relative size-2.5 rounded-full bg-primary" />
        </div>
        <Button
          variant="outline"
          size="sm"
          className="bezier__replay h-6 px-1.5 text-[10.5px]"
          onClick={() => {
            runDemo(bezierCss)
            onReplay?.()
          }}
          title="Replay the demo and the last change"
        >
          <Play className="size-3" aria-hidden="true" />
          Replay
        </Button>
      </div>
    </div>
  )
}
