// v10 Styles-tab fixtures: a Tailwind-utility-classed element (the S1
// class-rewrite target) and an inline-styled element (the S2 style-object
// merge target). index.html mirrors both with matching data-praxis-source stamps.
export function TwCard(): JSX.Element {
  return <div className="p-4 rounded-md">Padded box</div>
}

export function InlineCard(): JSX.Element {
  return <div style={{ padding: '8px' }}>Inline padded</div>
}

// v10 design tokens: the color is spelled as a literal here, but it IS the value
// of `--color-text` in src/theme.css — so the Styles tab must NAME the token
// rather than show the hex, and picking another token must replace this literal
// with a `var(--…)` reference.
export function TokenCard(): JSX.Element {
  return <div style={{ color: '#6c6c6c' }}>Token colored</div>
}

// v10 Custom Controls fixture (custom-controls.mjs): module constants a canned
// .praxis/control-panels.json anchors on with the 'literal' strategy. CustomCard
// USES them, so each write-through commit would repaint under a real dev
// server's HMR — the literal tier's whole preview story.
const DEMO_SCALE = 1.5
const DEMO_LABEL = 'Hello caption'
const DEMO_ALIGN = 'left'

export function CustomCard(): JSX.Element {
  return (
    <p style={{ opacity: DEMO_SCALE / 10, textAlign: DEMO_ALIGN as 'left' | 'center' | 'right' }}>
      {DEMO_LABEL}
    </p>
  )
}
