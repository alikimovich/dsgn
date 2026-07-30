import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * ColorControl — swatch + hex field + hidden native color input for the
 * Styles tab. Pure component: no window.api calls; the parent wires
 * onChange → styles.preview and onCommit → styles.apply.
 *
 * Accepts the current value in any computed form. sRGB values (hex, rgb(a))
 * get editable controls — normalized to #rrggbb for the native input, with
 * alpha preserved as #rrggbbaa in the hex field and emitted values. Anything
 * else (oklch/lab/color()/var()) renders a read-only swatch (the raw value is
 * the swatch background, so the browser still paints it) plus an
 * "edit via chat" affordance.
 */
export interface ColorControlProps {
  /** Current CSS color, any computed form (hex, rgb(a), oklch(), var(), …). */
  value: string
  disabled?: boolean
  /** Rendered at the hex field's right edge, inside its border — the
   *  design-token dropdown chevron (see TokenRow). */
  trailing?: React.ReactNode
  /** Live update while the native picker scrubs (its 'input' events). */
  onChange: (cssColor: string) => void
  /** Final value — native picker close, hex-field blur, or Enter. */
  onCommit: (cssColor: string) => void
  /** The value isn't editable here (non-sRGB) — hand the edit to the agent. */
  onNeedsAgent: () => void
}

// ---------------------------------------------------------------------------
// sRGB parse/format (local + pure — computed colors arrive as rgb()/rgba();
// committed hex round-trips through here too)
// ---------------------------------------------------------------------------

interface Srgb {
  r: number // 0–255
  g: number
  b: number
  a: number // 0–1
}

const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB_RE = /^rgba?\(([^)]+)\)$/i

function clampChannel(n: number): number {
  return Math.min(255, Math.max(0, Math.round(n)))
}

/** '255' | '50%' → 0–255 channel; null when not numeric. */
function parseChannel(part: string): number | null {
  const pct = part.endsWith('%')
  const n = Number(pct ? part.slice(0, -1) : part)
  if (!Number.isFinite(n)) return null
  return clampChannel(pct ? n * 2.55 : n)
}

/** '0.5' | '50%' → 0–1 alpha; null when not numeric. */
function parseAlpha(part: string): number | null {
  const pct = part.endsWith('%')
  const n = Number(pct ? part.slice(0, -1) : part)
  if (!Number.isFinite(n)) return null
  return Math.min(1, Math.max(0, pct ? n / 100 : n))
}

/**
 * Hex / rgb() / rgba() (comma or space syntax, optional `/ alpha`) → Srgb.
 * Anything else — oklch(), lab(), color(), var(), keywords — → null.
 */
function parseSrgb(text: string): Srgb | null {
  const t = text.trim().toLowerCase()
  if (t === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  if (HEX_RE.test(t)) {
    let hex = t.slice(1)
    if (hex.length <= 4) hex = [...hex].map((c) => c + c).join('')
    const int = (at: number): number => parseInt(hex.slice(at, at + 2), 16)
    return { r: int(0), g: int(2), b: int(4), a: hex.length === 8 ? int(6) / 255 : 1 }
  }
  const m = RGB_RE.exec(t)
  if (!m) return null
  const parts = m[1].replace('/', ' ').trim().split(/[\s,]+/)
  if (parts.length !== 3 && parts.length !== 4) return null
  const r = parseChannel(parts[0])
  const g = parseChannel(parts[1])
  const b = parseChannel(parts[2])
  const a = parts.length === 4 ? parseAlpha(parts[3]) : 1
  if (r === null || g === null || b === null || a === null) return null
  return { r, g, b, a }
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0')
}

/** Opaque → '#rrggbb'; translucent → '#rrggbbaa'. */
function formatHex(c: Srgb): string {
  const base = `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`
  return c.a < 1 ? `${base}${hex2(Math.round(c.a * 255))}` : base
}

/** Alpha-less '#rrggbb' — the only form the native color input accepts. */
function formatRgbHex(c: Srgb): string {
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`
}

/** Checkerboard under translucent swatches so alpha reads visually. */
const CHECKER = 'repeating-conic-gradient(#cbd5e1 0% 25%, #fff 0% 50%) 0 0 / 8px 8px'

export default function ColorControl({
  value,
  disabled,
  trailing,
  onChange,
  onCommit,
  onNeedsAgent
}: ColorControlProps): React.JSX.Element {
  // Editability is decided by the INCOMING value; a half-typed draft never
  // flips the row to the read-only branch.
  const parsed = useMemo(() => parseSrgb(value), [value])
  const [draft, setDraft] = useState(parsed ? formatHex(parsed) : value)
  // Sync the draft to a fresh value — but never while the hex field has focus:
  // the post-commit reconcile merges a re-read ~600ms after every commit, and
  // the computed form always differs textually ('#ff0000' → 'rgb(255, 0, 0)'),
  // so an unguarded sync would wipe in-progress typing right after a commit.
  const hexFocusedRef = useRef(false)
  useEffect(() => {
    if (hexFocusedRef.current) return
    setDraft(parsed ? formatHex(parsed) : value)
  }, [value, parsed])

  const nativeRef = useRef<HTMLInputElement>(null)
  // The native picker's rgb-only edits re-attach this alpha on emit; a ref so
  // the once-attached 'change' listener below always sees the latest.
  const parsedDraft = useMemo(() => parseSrgb(draft), [draft])
  const shown = parsedDraft ?? parsed
  const alphaHex = shown && shown.a < 1 ? hex2(Math.round(shown.a * 255)) : ''
  const latest = useRef({ alphaHex, onCommit })
  latest.current = { alphaHex, onCommit }

  // React's onChange on inputs is the 'input' event — the native 'change'
  // (fires when the picker CLOSES) needs a real listener for commit-on-close.
  // Keyed on the branch: the non-sRGB branch renders NO input, and a branch
  // flip recreates the DOM node — a mount-only effect would leave the fresh
  // input listener-less (picker edits would preview but never commit).
  const editable = parsed !== null
  // biome-ignore lint/correctness/useExhaustiveDependencies: `editable` keys the
  // re-attach to the branch's input node; the handler reads only refs.
  useEffect(() => {
    const el = nativeRef.current
    if (!el) return
    const commit = (): void => {
      const { alphaHex: a, onCommit: fn } = latest.current
      fn(`${el.value}${a}`)
    }
    el.addEventListener('change', commit)
    return () => el.removeEventListener('change', commit)
  }, [editable])

  if (!parsed || !shown) {
    // Non-sRGB (oklch/lab/color()/var()) — let the browser paint the raw
    // value; edits route through the agent.
    return (
      <div className="colorctl colorctl--raw flex items-center gap-1.5 justify-self-end">
        <span
          className="colorctl__swatch size-7 shrink-0 rounded-md border shadow-xs"
          style={{ background: value }}
          title={value}
          aria-label={`Current color ${value}`}
        />
        <Button
          variant="outline"
          size="sm"
          className="colorctl__agent h-7 px-2 text-[11.5px]"
          onClick={onNeedsAgent}
          disabled={disabled}
          title={`${value} — not editable here`}
        >
          edit via chat
        </Button>
      </div>
    )
  }

  const commitDraft = (): void => {
    const next = parseSrgb(draft)
    if (!next) {
      setDraft(formatHex(parsed)) // revert the unparseable draft
      return
    }
    const css = formatHex(next)
    setDraft(css)
    if (css !== formatHex(parsed)) onCommit(css)
  }

  return (
    <div className="colorctl flex items-center gap-1.5 justify-self-end">
      <button
        type="button"
        className="colorctl__swatch relative size-7 shrink-0 overflow-hidden rounded-md border shadow-xs disabled:pointer-events-none disabled:opacity-50"
        style={{ background: CHECKER }}
        onClick={() => nativeRef.current?.click()}
        disabled={disabled}
        aria-label="Open color picker"
        title="Open color picker"
      >
        <span className="absolute inset-0" style={{ background: formatHex(shown) }} />
        <input
          ref={nativeRef}
          type="color"
          className="colorctl__native pointer-events-none absolute inset-0 opacity-0"
          tabIndex={-1}
          value={formatRgbHex(shown)}
          disabled={disabled}
          onChange={(e) => {
            const css = `${e.currentTarget.value}${alphaHex}`
            setDraft(css)
            onChange(css)
          }}
        />
      </button>
      {/* The chevron sits INSIDE the field's border, so the border lives on
          this wrapper and the input itself goes borderless — otherwise the
          token affordance would float outside the box it belongs to. */}
      {/* w-28 (112px), not the 96px this was before the chevron moved inside:
          the trailing icon eats ~16px, and design-system token names are long
          (`--rmt-radius-none`) — at 96px they truncated to `--color…`. Kept in
          sync with ColorRow's TokenChip so the row doesn't jump when a value
          flips between token and raw hex. */}
      <div
        className={cn(
          'flex h-7 w-28 items-center gap-1 rounded-md border px-2',
          'focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
          disabled && 'pointer-events-none opacity-50'
        )}
      >
        <input
          className="colorctl__hex min-w-0 flex-1 bg-transparent font-mono text-xs outline-none"
          type="text"
          value={draft}
          disabled={disabled}
          spellCheck={false}
          aria-label="Hex color"
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => {
            hexFocusedRef.current = true
          }}
          onBlur={() => {
            hexFocusedRef.current = false
            commitDraft()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitDraft()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setDraft(formatHex(parsed))
            }
          }}
        />
        {trailing}
      </div>
    </div>
  )
}
