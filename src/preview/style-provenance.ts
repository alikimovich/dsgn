/**
 * Style-token provenance — proves whether a property's value comes from a
 * design token, instead of guessing from value coincidence.
 *
 * `getComputedStyle` always fully resolves `var()`, so it cannot distinguish
 * "this element's color IS `var(--color-text)`" from "this element's color
 * happens to be the same hex, coincidentally." Every value-equality match the
 * Styles panel used to make was really the latter — a guess. This module reads
 * the property's SPECIFIED (unresolved) declaration instead, which is the only
 * place a `var(--name)` reference actually survives, and reports the exact
 * variable name in use, or null when there genuinely isn't one.
 *
 * Split out of preload.ts (already large) so it's a plain DOM module with no
 * `ipcRenderer` import — testable against a real browser (headless Chromium),
 * not just reasoned about, the same way `layers.ts` is split for its own walk.
 */

/** The outermost `--name` in a `var(--name, …fallback)` reference, or null. */
export function varRefName(value: string): string | null {
  const m = /var\(\s*(--[\w-]+)/.exec(value)
  return m ? m[1] : null
}

/**
 * The SPECIFIED value of each of `props` on `el` — unlike computed style, this
 * preserves `var(--x)` literally. Checked in a rough cascade approximation:
 * matched same-origin stylesheet rules in document order, THEN inline
 * (`el.style`), which overwrites since it's closest to the top of the real
 * cascade. We don't evaluate `@media`/`@supports` conditions before walking
 * their body — a declaration inside a currently-inactive block still counts as
 * usage evidence, which only WIDENS what's provable, never invents a match to
 * an unrelated token. A cross-origin sheet throws on `.cssRules` access; it
 * can't be the previewed app's own CSS, so it's simply skipped.
 */
export function specifiedValues(el: Element, props: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (rules: CSSRuleList | undefined): void => {
    if (!rules) return
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        let matches = false
        try {
          matches = el.matches(rule.selectorText)
        } catch {
          continue // an unsupported/invalid selector — not a usage signal
        }
        if (!matches) continue
        for (const p of props) {
          const v = rule.style.getPropertyValue(p)
          if (v) out[p] = v
        }
      } else if (rule instanceof CSSImportRule) {
        // An @import's nested sheet hangs off `.styleSheet`, NOT `.cssRules` —
        // the grouping-rule branch below would silently skip it. Same
        // cross-origin caveat as the top-level loop, hence its own try.
        try {
          walk(rule.styleSheet?.cssRules)
        } catch {
          /* cross-origin import — not the previewed app's own CSS */
        }
      } else if ('cssRules' in rule) {
        walk((rule as CSSGroupingRule).cssRules) // @media / @supports / @layer
      }
    }
  }
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | undefined
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    walk(rules)
  }
  if (el instanceof HTMLElement || el instanceof SVGElement) {
    for (const p of props) {
      const inline = el.style.getPropertyValue(p)
      if (inline) out[p] = inline
    }
  }
  return out
}

/**
 * Per property, the `--name` a design token would need to match to be real
 * usage evidence — or null when the specified declaration isn't a `var()` at
 * all (a literal value: no token is in play, coincidence or not).
 */
export function declaredVarsFor(el: Element, props: string[]): Record<string, string | null> {
  const specified = specifiedValues(el, props)
  const out: Record<string, string | null> = {}
  for (const p of props) out[p] = varRefName(specified[p] ?? '')
  return out
}
