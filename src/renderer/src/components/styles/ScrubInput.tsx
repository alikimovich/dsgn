import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { clamp } from '@/lib/css-values'
import { cn } from '@/lib/utils'

export interface ScrubInputProps {
  /** Row label (css property name, e.g. "padding-top"). */
  label: string
  /** Current committed value (numeric, in the property's canonical unit). */
  value: number
  min: number
  max: number
  /** Value change per pointer-lock px (Shift held ×10, Alt/Option ÷10). */
  step: number
  /** Display suffix ('px', 'ms', '' for unitless). Ignored when formatValue is set. */
  unit?: string
  disabled?: boolean
  /** Custom readout for the track (full text, unit included — replaces the default). */
  formatValue?: (value: number) => string
  /**
   * Rendered at the track's right edge, inside its border — the design-token
   * dropdown chevron (see TokenRow). Anything here must stop its own pointer/
   * key events from reaching the track, which would otherwise start a scrub or
   * open the exact-value editor. Absent while the inline editor is open (the
   * track isn't rendered then).
   */
  trailing?: React.ReactNode
  /** Per movement while scrubbing — the caller throttles the live preview. */
  onScrub: (value: number) => void
  /** Exactly once per interaction: pointer release, pointer-lock exit, or Enter. */
  onCommit: (value: number) => void
  /** Live parsed value while typing in the inline exact-value editor. */
  onInput?: (value: number) => void
  /**
   * The editor was dismissed WITHOUT a commit (Escape, or unparseable text on
   * blur) — the caller should drop any live preview the typing injected.
   * Re-previewing the old value instead would leave a stale inline override
   * masking later legitimate changes (agent edits, HMR).
   */
  onCancel?: () => void
}

/** Total pointer travel under this = a click (opens the exact-value editor). */
const CLICK_THRESHOLD_PX = 3

/** Effective per-px step for the movement/key event's modifiers. */
function stepFor(step: number, mods: { shiftKey: boolean; altKey: boolean }): number {
  if (mods.shiftKey) return step * 10
  if (mods.altKey) return step / 10
  return step
}

/** Round away float noise from step accumulation (0.30000000000000004 → 0.3). */
function round(n: number): number {
  return Number(n.toFixed(4))
}

/**
 * Pointer-LOCK scrubber (Dialkit-style) for numeric style values. Dragging the
 * label or the value track locks the pointer and accumulates `movementX * step`
 * per event; a sub-3px drag is a click and swaps the track for an inline
 * exact-value input (select-all; Enter commits, Escape cancels back). Arrow
 * keys nudge ±step with the same Shift/Alt modifiers.
 *
 * CRITICAL Escape semantics: exiting pointer lock — Escape or programmatic —
 * COMMITS at the current value, never reverts (`pointerlockchange` with the
 * lock gone → commit). Pointer lock, not capture: capture dies at the small
 * island view's edge.
 *
 * Presentation-only — no window.api; the caller owns preview/apply.
 */
export default function ScrubInput({
  label,
  value,
  min,
  max,
  step,
  unit = '',
  disabled,
  formatValue,
  trailing,
  onScrub,
  onCommit,
  onInput,
  onCancel
}: ScrubInputProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  /** Value shown while a scrub is in flight (and until the prop catches up). */
  const [scrubValue, setScrubValue] = useState<number | null>(null)
  /** Tear-down for an in-flight drag — non-null exactly while one is active. */
  const dragCleanupRef = useRef<(() => void) | null>(null)
  /** Guards the inline editor's Enter-then-blur double fire. */
  const editDoneRef = useRef(false)

  const shown = scrubValue ?? value

  // A fresh committed value from the caller supersedes the sticky scrub readout.
  useEffect(() => setScrubValue(null), [value])

  // Unmount mid-drag: drop listeners and the lock without emitting.
  useEffect(() => () => dragCleanupRef.current?.(), [])

  const openEditor = (initial: number): void => {
    editDoneRef.current = false
    setDraft(String(round(initial)))
    setEditing(true)
  }

  const beginScrub = (e: React.PointerEvent): void => {
    if (disabled || editing || e.button !== 0 || dragCleanupRef.current) return
    e.preventDefault()
    const root = e.currentTarget as HTMLElement
    const session = { acc: shown, moved: 0, started: false, done: false }

    const onMove = (ev: PointerEvent): void => {
      session.moved += Math.abs(ev.movementX)
      if (!session.started) {
        if (session.moved < CLICK_THRESHOLD_PX) return
        session.started = true
      }
      // Clamp the ACCUMULATOR, not just the derived value — an unclamped acc
      // keeps racking up past min/max under pointer lock, and the user would
      // have to drag the whole overshoot back through a dead zone before the
      // value responds to a reversal.
      session.acc = clamp(session.acc + ev.movementX * stepFor(step, ev), min, max)
      const next = round(session.acc)
      setScrubValue(next)
      onScrub(next)
    }
    const onUp = (): void => finish(false)
    // Cancelled pointer streams get no release — treat like a lock exit: commit.
    const onCancel = (): void => finish(true)
    const onLockChange = (): void => {
      // Fires on acquire too; only the lock going away ends the scrub.
      if (document.pointerLockElement !== root) finish(true)
    }

    const removeAll = (): void => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onCancel)
      document.removeEventListener('pointerlockchange', onLockChange)
      dragCleanupRef.current = null
    }

    const finish = (viaLockExit: boolean): void => {
      if (session.done) return
      session.done = true
      removeAll()
      if (document.pointerLockElement === root) {
        document.exitPointerLock()
      } else {
        // The async lock request may still be pending (sub-latency click) —
        // if it lands after this, release it so the cursor doesn't stick.
        const bail = (): void => {
          if (document.pointerLockElement === root) document.exitPointerLock()
        }
        document.addEventListener('pointerlockchange', bail, { once: true })
        window.setTimeout(() => document.removeEventListener('pointerlockchange', bail), 500)
      }
      const v = round(clamp(session.acc, min, max))
      if (session.started) {
        // A real scrub always commits — incl. lock exit (Escape): COMMIT at
        // the current value, never revert.
        setScrubValue(v)
        onCommit(v)
      } else if (!viaLockExit) {
        // Total drag < 3px → it was a click: swap to the exact-value input.
        openEditor(v)
      }
      // else: aborted before any real travel (Escape / pointercancel with the
      // value untouched) — nothing changed, so committing would only splice
      // spurious classes into source. No-op.
    }

    dragCleanupRef.current = () => {
      session.done = true
      removeAll()
      if (document.pointerLockElement === root) document.exitPointerLock()
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onCancel)
    document.addEventListener('pointerlockchange', onLockChange)

    try {
      // Chrome returns a Promise despite the void typing; swallow rejections —
      // an unlocked scrub still works via movementX.
      const ret = root.requestPointerLock() as unknown
      if (ret instanceof Promise) ret.catch(() => {})
    } catch {
      /* pointer lock unavailable — unlocked scrubbing still works */
    }
  }

  const onTrackKeyDown = (e: React.KeyboardEvent): void => {
    if (disabled) return
    if (e.key === 'Enter') {
      e.preventDefault()
      openEditor(shown)
      return
    }
    const dir =
      e.key === 'ArrowUp' || e.key === 'ArrowRight'
        ? 1
        : e.key === 'ArrowDown' || e.key === 'ArrowLeft'
          ? -1
          : 0
    if (!dir) return
    e.preventDefault()
    const next = round(clamp(shown + dir * stepFor(step, e), min, max))
    setScrubValue(next)
    onCommit(next) // per-nudge commit; edit-history coalesces the burst
  }

  // --- inline exact-value editor -------------------------------------------

  const parseDraft = (text: string): number | null => {
    let t = text.trim()
    if (unit && t.toLowerCase().endsWith(unit.toLowerCase())) t = t.slice(0, -unit.length).trim()
    if (t === '') return null
    const n = Number(t)
    return Number.isFinite(n) ? n : null
  }

  const commitDraft = (): void => {
    if (editDoneRef.current) return
    editDoneRef.current = true
    setEditing(false)
    const n = parseDraft(draft)
    if (n === null) {
      onCancel?.() // unparseable → cancel: clear the preview the typing injected
      return
    }
    const v = round(clamp(n, min, max))
    setScrubValue(v)
    onCommit(v)
  }

  const cancelDraft = (): void => {
    if (editDoneRef.current) return
    editDoneRef.current = true
    setEditing(false)
    onCancel?.() // drop the typed-in preview — never re-inject the old value
  }

  return (
    <div className="scrubinput grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2">
      <span
        className={cn(
          'scrubinput__label select-none overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-muted-foreground',
          disabled ? 'opacity-50' : 'cursor-ew-resize'
        )}
        onPointerDown={beginScrub}
        title={label}
      >
        {label}
      </span>
      {editing ? (
        <Input
          className="scrubinput__input h-7 w-[128px] justify-self-end px-2 text-xs"
          type="text"
          inputMode="decimal"
          autoFocus
          value={draft}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            setDraft(e.target.value)
            const n = parseDraft(e.target.value)
            if (n !== null) onInput?.(round(clamp(n, min, max)))
          }}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitDraft()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancelDraft()
            }
          }}
        />
      ) : (
        <div
          role="slider"
          aria-label={label}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={shown}
          aria-disabled={disabled || undefined}
          tabIndex={disabled ? -1 : 0}
          className={cn(
            'scrubinput__track flex h-7 w-[128px] select-none items-center justify-end gap-1 rounded-md border border-input bg-transparent px-2 text-xs tabular-nums justify-self-end',
            'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
            disabled ? 'pointer-events-none opacity-50' : 'cursor-ew-resize hover:border-ring'
          )}
          onPointerDown={beginScrub}
          onKeyDown={onTrackKeyDown}
        >
          {/* min-w-0 + truncate: a long token name (the readout `formatValue`
              returns when the value IS a token) must shrink rather than push
              the trailing chevron out of the fixed-width track. */}
          <span className="min-w-0 truncate">
            {formatValue ? (
              formatValue(shown)
            ) : (
              <>
                {String(round(shown))}
                {unit && <span className="ml-0.5 text-muted-foreground">{unit}</span>}
              </>
            )}
          </span>
          {trailing}
        </div>
      )}
    </div>
  )
}
