/**
 * Fluid CSS `clamp()` sizing engine — the Utopia (utopia.fyi) fluid-scale math,
 * implemented locally so it's pure, dependency-free, and unit-testable under bun.
 *
 * Given a size (or a modular-scale step) at two viewport widths, this derives the
 * linear `interceptRem + slopeVw` term Utopia uses as the middle argument of
 * `clamp(<lower>, <preferred>, <upper>)`, so a design token can scale continuously
 * between a mobile and a desktop value instead of jumping at breakpoints.
 */

export interface FluidClampInput {
  minPx: number
  maxPx: number
  minViewportPx?: number // default 320
  maxViewportPx?: number // default 1280
  rootPx?: number // default 16
  precision?: number // default 4
}

export interface FluidClampResult {
  css: string // e.g. "clamp(2rem, 1.1429rem + 2.8571vw, 4rem)"
  minRem: number
  maxRem: number
  slopeVw: number // the vw coefficient (= slopePxPerPx * 100)
  interceptRem: number
  checkAtMinPx: number // the size the css evaluates to at minViewportPx (must equal minPx within 0.5px)
  checkAtMaxPx: number // the size at maxViewportPx (must equal maxPx within 0.5px)
  isStatic: boolean // true when minPx === maxPx
  warning?: string
}

function round(n: number, precision: number): number {
  return Number(n.toFixed(precision))
}

/** clamp(value, lower, upper) — lower must be <= upper. */
function clampValue(value: number, lower: number, upper: number): number {
  return Math.min(Math.max(value, lower), upper)
}

/**
 * Derive a fluid `clamp()` between two px sizes at two viewport widths (Utopia
 * math): slope = Δpx / Δviewport, intercept = min - slope * minViewport. The
 * clamp's lower/upper bounds are the numeric min/max of the two rem values (not
 * necessarily minRem/maxRem in that order) so "shrink-on-grow" tokens — where
 * minPx > maxPx — still clamp correctly; the vw slope carries the direction.
 *
 * Rounding can nudge the emitted css just off the exact endpoints, so after
 * rounding we re-evaluate the rounded css at both viewports and bump precision
 * (up to 6) until it's within 0.5px of the requested min/max at each end.
 */
export function fluidClamp(input: FluidClampInput): FluidClampResult {
  const {
    minPx,
    maxPx,
    minViewportPx = 320,
    maxViewportPx = 1280,
    rootPx = 16,
    precision = 4
  } = input

  if (minViewportPx === maxViewportPx) {
    throw new Error(
      `fluidClamp: minViewportPx and maxViewportPx must differ (both ${minViewportPx}px) — slope is divide-by-zero`
    )
  }

  const warning =
    minPx < rootPx
      ? `minPx (${minPx}px) is below the root font size (${rootPx}px) — a sub-1rem floor may be too small and won't scale with user font/zoom settings as cleanly as a rem-based value`
      : undefined

  if (minPx === maxPx) {
    const rem = round(minPx / rootPx, precision)
    return {
      css: `${rem}rem`,
      minRem: rem,
      maxRem: rem,
      slopeVw: 0,
      interceptRem: rem,
      checkAtMinPx: minPx,
      checkAtMaxPx: maxPx,
      isStatic: true,
      warning
    }
  }

  const slopePxPerPx = (maxPx - minPx) / (maxViewportPx - minViewportPx)
  const interceptPx = minPx - slopePxPerPx * minViewportPx

  let p = precision
  while (true) {
    const minRem = round(minPx / rootPx, p)
    const maxRem = round(maxPx / rootPx, p)
    const interceptRem = round(interceptPx / rootPx, p)
    const slopeVw = round(slopePxPerPx * 100, p)
    const lowerRem = Math.min(minRem, maxRem)
    const upperRem = Math.max(minRem, maxRem)

    const evalPx = (viewportPx: number): number => {
      const preferredPx = interceptRem * rootPx + (slopeVw / 100) * viewportPx
      return clampValue(preferredPx, lowerRem * rootPx, upperRem * rootPx)
    }

    const checkAtMinPx = evalPx(minViewportPx)
    const checkAtMaxPx = evalPx(maxViewportPx)
    const withinTolerance =
      Math.abs(checkAtMinPx - minPx) <= 0.5 && Math.abs(checkAtMaxPx - maxPx) <= 0.5

    if (withinTolerance || p >= 6) {
      return {
        css: `clamp(${lowerRem}rem, ${interceptRem}rem + ${slopeVw}vw, ${upperRem}rem)`,
        minRem,
        maxRem,
        slopeVw,
        interceptRem,
        checkAtMinPx,
        checkAtMaxPx,
        isStatic: false,
        warning
      }
    }
    p++
  }
}

export interface FluidScaleInput {
  baseMinPx: number // base step size at min viewport
  baseMaxPx: number // base step size at max viewport
  ratioMin?: number // modular ratio at min viewport, default 1.2
  ratioMax?: number // modular ratio at max viewport, default 1.25
  stepsUp?: number // steps above base, default 5
  stepsDown?: number // steps below base, default 2
  minViewportPx?: number // default 320
  maxViewportPx?: number // default 1280
  rootPx?: number // default 16
  precision?: number // default 4
}

export interface FluidScaleStep {
  step: number
  minPx: number
  maxPx: number
  css: string
}

/**
 * A fluid type/space scale: each step's min/max px come from a modular scale
 * (basePx * ratio**step), with the min-viewport and max-viewport ratios allowed
 * to differ — Utopia's standard trick of a tighter ratio on mobile and a looser
 * one on desktop — then each step is independently run through fluidClamp.
 * Ordered from -stepsDown .. +stepsUp; step 0 is the base size.
 */
export function fluidScale(input: FluidScaleInput): FluidScaleStep[] {
  const {
    baseMinPx,
    baseMaxPx,
    ratioMin = 1.2,
    ratioMax = 1.25,
    stepsUp = 5,
    stepsDown = 2,
    minViewportPx = 320,
    maxViewportPx = 1280,
    rootPx = 16,
    precision = 4
  } = input

  const steps: FluidScaleStep[] = []
  for (let step = -stepsDown; step <= stepsUp; step++) {
    const minPx = baseMinPx * ratioMin ** step
    const maxPx = baseMaxPx * ratioMax ** step
    const { css } = fluidClamp({
      minPx,
      maxPx,
      minViewportPx,
      maxViewportPx,
      rootPx,
      precision
    })
    steps.push({ step, minPx, maxPx, css })
  }
  return steps
}

export interface ModularScaleStep {
  step: number
  px: number
}

/** A plain (non-fluid) modular scale: basePx * ratio**step, -stepsDown .. +stepsUp. */
export function modularScale(
  basePx: number,
  ratio: number,
  stepsUp: number,
  stepsDown: number
): ModularScaleStep[] {
  const steps: ModularScaleStep[] = []
  for (let step = -stepsDown; step <= stepsUp; step++) {
    steps.push({ step, px: basePx * ratio ** step })
  }
  return steps
}
