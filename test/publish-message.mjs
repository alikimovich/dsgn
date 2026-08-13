/**
 * Unit test for the pure Publish commit/PR message builder (no Electron).
 * Run with: bun test/publish-message.mjs
 */
import assert from 'node:assert'
import { buildPublishMessage } from '../src/shared/publish-message.ts'

// No asks → the old fallback (but with a body).
let m = buildPublishMessage('praxis/main', [])
assert.equal(m.title, 'Praxis: publish praxis/main')
assert.equal(m.body, 'Published from Praxis.')

// One ask → it IS the title, and the body lists it.
m = buildPublishMessage('praxis/main', ['make the hero heading teal'])
assert.equal(m.title, 'make the hero heading teal')
assert.ok(m.body.includes('- make the hero heading teal'), m.body)

// Multiple asks → "(+N more)" and all listed.
m = buildPublishMessage('praxis/main', ['fix the nav', 'darken the footer', 'add a favicon'])
assert.equal(m.title, 'fix the nav (+2 more)')
assert.ok(m.body.includes('- darken the footer') && m.body.includes('- add a favicon'), m.body)

// praxis's seeded element-reference preamble is stripped from selection asks.
m = buildPublishMessage('praxis/x', [
  'In the preview I selected the <h3#tooltip> element in src/lib/Workplace.svelte:42:8 with text “PLUS8”. remove the tooltip from this place of work'
])
assert.equal(m.title, 'remove the tooltip from this place of work')

// Long asks truncate on a word boundary with an ellipsis.
m = buildPublishMessage('praxis/x', ['please carefully restructure the entire landing page hero section grid to be responsive'])
assert.ok(m.title.length <= 65 && m.title.endsWith('…'), m.title)

// Diffstat lands in a fenced block.
m = buildPublishMessage('praxis/x', ['fix nav'], ' src/App.tsx | 4 ++--\n 1 file changed')
assert.ok(m.body.includes('```') && m.body.includes('src/App.tsx'), m.body)

console.log('PUBLISH-MESSAGE OK — titles, preamble strip, truncation, diffstat')
