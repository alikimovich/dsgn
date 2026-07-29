import { Play } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { sameCssValue, STYLE_PROP_META } from '@/lib/css-values'
import type { SelectedElement, Token, TokenSet } from '../../../shared/api'
import {
  customPropertyNames,
  resolveTokenForValue,
  type TokenCandidate,
  type TokenResolution,
  tokensForProp
} from '../../../shared/token-match'
import type { RowCtx } from './styles/row-ctx'
import { ColorRow } from './styles/rows/ColorRow'
import { NumberRow, SideRows } from './styles/rows/NumberRow'
import { ChipRow, StyleGroup } from './styles/rows/primitives'
import { TimingRow, TransitionPropertyRow } from './styles/rows/TransitionRows'

// `sameCssValue` moved to lib/css-values.ts (CustomPanel imports it from here).
export { sameCssValue } from '@/lib/css-values'

interface Props {
  root: string
  element: SelectedElement
  /**
   * Can praxis instrument this project for visual editing (supported framework)?
   * When the picked element has no source stamp the panel is read-only; this
   * tailors the guidance — point a framework project at setup, tell a
   * static/runtime-rendered one to ask in chat. Null while unprobed.
   */
  canInstrument: boolean | null
  /** The project's detected design tokens; null when there are none. */
  tokens: TokenSet | null
  /** Seed a chat prompt for changes the styles engine can't land as a literal. */
  onSeedPrompt: (text: string) => void
}

/** Every v1 property (incl. the read-only chips) — one fresh read fills the panel. */
const ALL_PROPS = Object.keys(STYLE_PROP_META)

/** `gap` only means something on these computed display values. */
const FLEX_GRID = new Set(['flex', 'grid', 'inline-flex', 'inline-grid'])

/** Post-commit settle time before reconciling against a fresh read (lets HMR land). */
const RECONCILE_MS = 600

/** Reconcile attempts before conceding — a build slower than ~3s keeps the override. */
const RECONCILE_TRIES = 5

/**
 * The Styles tab body — content-only, rendered inside IslandCard's styles
 * TabsContent (which is `flex min-h-0 flex-col`, so the rows div scrolls under
 * the card's maxHeight). Fresh computed values come from `styles.read` on
 * mount / selection change — the pick-time `element.styles` snapshot only
 * primes the first paint. Scrubs preview live (rAF-throttled CSS injection);
 * release commits through `styles.apply` (Tailwind rewrite → inline splice →
 * agent seed). Styles always target `element.source` — the host element's own
 * stamp — never `componentSource` (a css edit lands on the element, not the
 * component call site).
 *
 * The rows themselves live in `styles/rows/`; this file owns the state machine
 * (preview queue, commit, post-commit reconcile) and the group composition.
 */
export default function StylePanel({
  root,
  element,
  canInstrument,
  tokens,
  onSeedPrompt
}: Props): React.JSX.Element {
  const [values, setValuesRaw] = useState<Record<string, string>>(() => ({ ...element.styles }))
  const [lost, setLost] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * The project's custom properties AS RESOLVED ON THIS ELEMENT, read in the
   * same round trip as the computed values. This is what makes token naming
   * cascade-correct: `--color-text` may be `#6c6c6c` at `:root` and `#c1c1c1`
   * under a dark-mode media query, and only the element knows which applies.
   */
  const [resolvedVars, setResolvedVars] = useState<Record<string, string>>({})

  // Async flows (commit chains, reconcile timers) read through the ref so they
  // never act on a stale snapshot; every write goes through merge/setValues.
  const valuesRef = useRef(values)
  const setValues = (v: Record<string, string>): void => {
    valuesRef.current = v
    setValuesRaw(v)
  }
  const merge = (patch: Record<string, string>): void =>
    setValues({ ...valuesRef.current, ...patch })

  /** Latest un-flushed preview per prop; one rAF flush sends the trailing edge. */
  const pendingRef = useRef(new Map<string, string>())
  const rafRef = useRef<number | null>(null)
  /** Pending post-commit reconcile timers — cancelled on selection change. */
  const timersRef = useRef(new Set<number>())
  /** Last committed change, for Replay (fallback: the opacity demo). */
  const lastCommitRef = useRef<{ prop: string; from: string; to: string } | null>(null)
  /**
   * The token last PICKED per property. Only ever written on an explicit pick,
   * never during render: it exists so that when several tokens share a value
   * (a theme with `--color-title` and `--color-link` both `#212121`), the row
   * keeps naming the one the user chose instead of flipping to whichever comes
   * first in detection order after the post-commit re-read.
   */
  const stickyRef = useRef<Record<string, string>>({})

  const source = element.source
  const disabled = !source

  // Selection identity — NOT the element object (PanelHost re-pushes state for
  // reasons that aren't a new selection, e.g. inspection updates).
  const elKey = `${source ?? ''}|${element.selector}`

  /**
   * A content signature for the token set. `tokens` arrives over IPC, so it is
   * a FRESH object on every panel:state push (which happens for reasons that
   * aren't a token change — an inspection update, a resize). Memoizing on its
   * identity would re-run the read effect constantly; memoizing on what it
   * contains re-runs it exactly when the tokens actually changed.
   */
  const tokenKey = tokens
    ? `${tokens.source}|${tokens.origin ?? ''}|${tokens.groups
        .map((g) => `${g.name}:${g.tokens.length}`)
        .join(',')}`
    : ''

  /** The `--…` names to resolve on the element, alongside the editable props. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: tokenKey is `tokens`' content signature — see above
  const varNames = useMemo(() => customPropertyNames(tokens), [tokenKey])

  /** Per-property candidate lists, computed once per token set. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: tokenKey is `tokens`' content signature — see above
  const candidateCache = useMemo(() => new Map<string, TokenCandidate[]>(), [tokenKey])
  const tokensFor = (prop: string): TokenCandidate[] => {
    let c = candidateCache.get(prop)
    if (!c) {
      c = tokensForProp(tokens, prop)
      candidateCache.set(prop, c)
    }
    return c
  }

  /** A token's value as it resolves on THIS element (else its recorded value). */
  const tokenValue = (token: Token): string =>
    resolvedVars[token.name]?.trim() || token.value

  /** Which token the property's current value IS, if any. */
  const tokenFor = (prop: string): TokenResolution | null =>
    resolveTokenForValue(tokensFor(prop), values[prop] ?? '', {
      resolved: resolvedVars,
      classes: element.classes,
      sticky: stickyRef.current[prop] ?? null,
      equals: (a, b) => sameCssValue(prop, a, b)
    })

  // biome-ignore lint/correctness/useExhaustiveDependencies: elKey is the selection identity; element.styles/read intentionally refresh only then
  useEffect(() => {
    let alive = true
    setLost(false)
    setError(null)
    lastCommitRef.current = null
    stickyRef.current = {}
    setValues({ ...element.styles }) // instant paint from the pick-time snapshot…
    // One round trip for both: the reply is a flat map, split by the `--` prefix
    // (no editable longhand starts with one, so the split is unambiguous).
    window.api.styles.read([...ALL_PROPS, ...varNames]).then((res) => {
      if (!alive) return
      if (!res) {
        setLost(true)
        return
      }
      const fresh: Record<string, string> = {}
      const vars: Record<string, string> = {}
      for (const [k, v] of Object.entries(res)) {
        if (k.startsWith('--')) vars[k] = v
        else fresh[k] = v
      }
      merge(fresh) // …then the fresh truth
      setResolvedVars(vars)
    })
    return () => {
      alive = false
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      pendingRef.current.clear()
      for (const t of timersRef.current) window.clearTimeout(t)
      timersRef.current.clear()
    }
  }, [elKey, varNames])

  /** rAF-throttled (trailing-edge) live injection — scrubs call this per move. */
  const preview = (prop: string, css: string): void => {
    pendingRef.current.set(prop, css)
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      for (const [p, v] of pendingRef.current) window.api.styles.preview(p, v)
      pendingRef.current.clear()
    })
  }

  /**
   * Clear a prop's live override AND its queued preview frame. Without the
   * queue drain, a pending rAF flush landing after the clear would re-inject
   * the abandoned value — and nothing would ever remove it (reconciles are
   * only scheduled on successful applies).
   */
  const dropPreview = (prop: string): void => {
    pendingRef.current.delete(prop)
    if (pendingRef.current.size === 0 && rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    window.api.styles.clearPreview(prop)
  }

  /**
   * Post-commit reconciliation: do NOT clear the live override immediately
   * (HMR flash); after a settle delay LIFT the override and read the
   * UNDERLYING value — reading through the override would be a self-comparison
   * (the override IS the committed value, so it would always "match" and the
   * clear would fire before slow builds land, snapping the element back).
   * Underlying equals committed → the source provides it now, stay cleared;
   * selection gone → nothing (the override died with the node); mismatch → the
   * build hasn't landed yet: re-inject the override and retry, conceding after
   * RECONCILE_TRIES (the committed source is still correct — keep the override).
   */
  const scheduleReconcile = (prop: string, committed: string, tries = RECONCILE_TRIES): void => {
    const id = window.setTimeout(async () => {
      timersRef.current.delete(id)
      window.api.styles.clearPreview(prop) // lift the override for the read
      const res = await window.api.styles.read([prop])
      const fresh = res?.[prop]
      if (fresh === undefined) return
      if (sameCssValue(prop, fresh, committed)) {
        merge({ [prop]: fresh })
        return
      }
      window.api.styles.preview(prop, committed) // not landed yet — restore it
      if (tries > 1) scheduleReconcile(prop, committed, tries - 1)
    }, RECONCILE_MS)
    timersRef.current.add(id)
  }

  const commit = async (
    prop: string,
    css: string,
    group?: string,
    token?: { name: string; group: string }
  ): Promise<void> => {
    if (!source) return
    setError(null)
    // Tuning a duration/delay with transitions off would commit an invisible
    // change — enable `transition-property: all` first so the tweak is real.
    if (prop === 'transition-duration' || prop === 'transition-delay') {
      const tp = valuesRef.current['transition-property']
      if (!tp || tp === 'none') await commit('transition-property', 'all')
    }
    const prev = valuesRef.current[prop] ?? css
    preview(prop, css) // non-scrub commits (select / Enter) show instantly too
    merge({ [prop]: css })
    // Every not-applied branch uses dropPreview, NOT bare clearPreview: the
    // preview above may still sit in the rAF queue, and a flush after a bare
    // clear would re-inject the never-applied value permanently.
    try {
      const res = await window.api.styles.apply(root, {
        source,
        prop,
        value: css,
        classes: element.classes,
        group,
        token
      })
      if (res.applied) {
        lastCommitRef.current = { prop, from: prev, to: css }
        scheduleReconcile(prop, css)
      } else if (res.needsAgent) {
        onSeedPrompt(
          res.agentPrompt ??
            `In ${source}, set \`${prop}\` to \`${css}\` on the <${element.tag}> element.`
        )
        dropPreview(prop)
      } else {
        setError(res.error ?? 'Could not apply the change.')
        dropPreview(prop)
      }
    } catch {
      setError('The edit could not be sent.')
      dropPreview(prop)
    }
  }

  /**
   * Commit a token pick. The resolved value is what gets previewed and what
   * reconcile compares against; the token name + group ride along so main can
   * write a REFERENCE (`var(--color-text)`, a Tailwind token class) instead.
   * Marks the pick sticky so a value shared by several tokens keeps naming
   * this one.
   */
  const commitToken = async (
    prop: string,
    candidate: TokenCandidate,
    group?: string
  ): Promise<void> => {
    stickyRef.current[prop] = candidate.token.name
    await commit(prop, tokenValue(candidate.token), group, {
      name: candidate.token.name,
      group: candidate.group
    })
  }

  /** Replay the last committed change; before any commit, a small opacity demo. */
  const replay = (): void => {
    const last = lastCommitRef.current
    if (last && last.from !== last.to) window.api.styles.replay(last.prop, last.from, last.to)
    else window.api.styles.replay('opacity', '0.5', valuesRef.current.opacity || '1')
  }

  /** Hand a prop the panel can't edit (non-sRGB color, steps() easing) to chat. */
  const seedStyleEdit = (prop: string): void =>
    onSeedPrompt(
      `In ${source ?? 'the selected element'}, change the \`${prop}\` (currently \`${
        values[prop] ?? 'unset'
      }\`) of the <${element.tag}> element.`
    )

  // No source stamp → style edits can't be written back. Rather than a full set
  // of dead, greyed-out controls, show WHY it's read-only and WHAT to do about
  // it — tailored to whether the project could be set up at all.
  if (disabled) {
    const ask = (): void =>
      onSeedPrompt(`Change the styling of the selected <${element.tag}> element (${element.selector}).`)
    return (
      <div className="stylepanel__rows flex flex-col gap-3 overflow-y-auto px-3 pb-3 pt-2">
        <div className="stylepanel__note text-[12px] leading-snug text-muted-foreground">
          {canInstrument === false ? (
            <>
              Styles here are read-only. This element is built at runtime, so Praxis can’t map it
              back to your source to save changes. Describe the change in chat and Praxis will edit
              the code directly.
            </>
          ) : canInstrument ? (
            <>
              Styles here are read-only until this project is set up for visual editing (there’s an
              offer in the chat) — then Praxis maps elements to your source and you can edit styles
              directly. Meanwhile, ask Praxis in chat to make the change.
            </>
          ) : (
            <>
              Styles here are read-only — this element isn’t mapped to your source, so changes can’t
              be saved. Ask Praxis in chat to make the change and it’ll edit the code.
            </>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="stylepanel__ask h-7 self-start px-2 text-[11.5px]"
          onClick={ask}
        >
          Ask Praxis to restyle it
        </Button>
      </div>
    )
  }

  if (lost) {
    return (
      <div className="stylepanel__rows flex flex-col gap-2 overflow-y-auto px-3 pb-3 pt-1.5">
        <div className="stylepanel__lost text-[12px] text-muted-foreground">
          Selection lost — click the element again.
        </div>
      </div>
    )
  }

  const ctx: RowCtx = {
    values,
    disabled,
    preview,
    commit,
    cancel: dropPreview,
    tokens,
    tokensFor,
    tokenFor,
    tokenValue,
    commitToken
  }
  const display = values.display ?? ''
  const tokenCount = tokens?.groups.reduce((n, g) => n + g.tokens.length, 0) ?? 0

  return (
    <>
      {error && (
        <div className="stylepanel__error mx-3 mt-1 text-[11.5px] text-red-700">{error}</div>
      )}
      <div className="stylepanel__rows flex flex-1 flex-col gap-1 overflow-y-auto px-3 pb-3 pt-1.5">
        {tokenCount > 0 && (
          <div
            className="stylepanel__tokensource truncate text-[10px] text-muted-foreground/70"
            title={
              tokens?.source === 'css'
                ? `${tokenCount} design tokens from ${tokens.origin}. Picking one writes var(--name).`
                : tokens?.source === 'tailwind'
                  ? `${tokenCount} design tokens from ${tokens.origin}. Picking one writes a utility class.`
                  : `${tokenCount} design tokens from ${tokens?.origin}. This source has no runtime reference, so picking one writes its value.`
            }
          >
            {tokenCount} tokens · {tokens?.origin}
          </div>
        )}
        <StyleGroup title="Layout">
          <SideRows base="padding" ctx={ctx} />
          <SideRows base="margin" ctx={ctx} />
          {FLEX_GRID.has(display) && <NumberRow prop="gap" ctx={ctx} />}
        </StyleGroup>

        <StyleGroup title="Appearance">
          <ColorRow prop="color" ctx={ctx} onNeedsAgent={() => seedStyleEdit('color')} />
          <ColorRow
            prop="background-color"
            ctx={ctx}
            onNeedsAgent={() => seedStyleEdit('background-color')}
          />
          <NumberRow prop="border-radius" ctx={ctx} />
          <NumberRow prop="opacity" ctx={ctx} />
        </StyleGroup>

        <StyleGroup title="Typography">
          <NumberRow prop="font-size" ctx={ctx} />
          <NumberRow prop="font-weight" ctx={ctx} />
          <NumberRow prop="line-height" ctx={ctx} />
          <NumberRow prop="letter-spacing" ctx={ctx} />
          <ChipRow label="font-family" value={values['font-family'] ?? '—'} />
          <ChipRow label="display" value={display || '—'} />
        </StyleGroup>

        <StyleGroup title="Transition">
          <TransitionPropertyRow ctx={ctx} />
          <NumberRow prop="transition-duration" ctx={ctx} />
          <NumberRow prop="transition-delay" ctx={ctx} />
          <TimingRow
            ctx={ctx}
            onReplay={replay}
            onNeedsAgent={() => seedStyleEdit('transition-timing-function')}
          />
          <div className="stylepanel__row grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2">
            <span />
            <Button
              variant="outline"
              size="sm"
              className="stylepanel__replay h-7 justify-self-end px-2 text-[11.5px]"
              onClick={replay}
              title="Replay the last change as a transition"
            >
              <Play className="size-3" aria-hidden="true" />
              Replay
            </Button>
          </div>
        </StyleGroup>
      </div>
    </>
  )
}
