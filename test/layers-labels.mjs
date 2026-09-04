/**
 * Unit test for the Layers tree's scope-class filter (no DOM needed — the
 * predicate is pure). Run via bun so the .ts import transpiles:
 *   bun run test:layers-labels
 *
 * The contract has two halves and BOTH must hold, so the two directions get
 * equal weight here: a compiler's scope marker is hidden, and a hand-written
 * class that merely shares one of those prefixes is not.
 */
import assert from 'node:assert'
import { isScopeClass } from '../src/preview/layers.ts'

// --- Hidden: compiler-generated style-scope markers. ---
for (const cls of [
  's-p0FWuf5vgUnM', // the reported one
  'svelte-a43zbs', // Svelte's compiler default
  'svelte-1t2ke3o',
  'sc-bdVaJa', // styled-components
  'css-1x2y3z', // emotion
  'jsx-712345678', // styled-jsx (all-digit hash)
  'astro-jhd3mn2q'
]) {
  assert.ok(isScopeClass(cls), `expected "${cls}" to be treated as a scope class`)
}

// --- Kept: authored classes, including ones sharing a scoping prefix. ---
for (const cls of [
  's-active', // prefix matches, tail is a plain word
  'css-grid',
  'sc-header',
  'mapped',
  'card',
  'hero-2024', // digits, but too short a tail to be a hash
  'text-sm',
  'bg-red-500', // two hyphens — never a scope marker's shape
  'grid-cols-12',
  'opacity-50',
  'duration-300',
  'block__el--mod', // BEM
  'text-[11px]', // Tailwind arbitrary value
  's', // no hyphen at all
  '-leading', // leading hyphen: no prefix to match
  ''
]) {
  assert.ok(!isScopeClass(cls), `expected "${cls}" to be kept on the row`)
}

// An unknown prefix is kept even when the tail looks like a hash — this is an
// allowlist on purpose (nothing distinguishes a short hash from a real name).
assert.ok(!isScopeClass('mycomp-1a2b3c'), 'unknown prefixes are not filtered')

console.log('layers-labels: ok')
