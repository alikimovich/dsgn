/**
 * Assistant markdown color previews — pure server-rendered component test.
 * Hex literals in prose and inline code get a swatch; fenced source and links
 * stay uninterrupted.
 *
 * Run with: bun test/markdown-color.mjs
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from '../src/renderer/src/components/Markdown.tsx'

const sample = [
  'Colors: `#edf4ff`, #abc, #abcd, #11223344, and #A1B2C3.',
  '',
  '[A fragment](https://example.com/#ffffff)',
  '',
  '```css',
  '.card { color: #ffffff; }',
  '```',
  '',
  'Invalid: #12 and #12345.'
].join('\n')

const html = renderToStaticMarkup(createElement(Markdown, null, sample))
const colors = [...html.matchAll(/data-color="([^"]+)"/g)].map((match) => match[1])
const expected = ['#edf4ff', '#abc', '#abcd', '#11223344', '#A1B2C3']

if (JSON.stringify(colors) !== JSON.stringify(expected)) {
  throw new Error(
    `color previews wrong — expected ${JSON.stringify(expected)}, got ${JSON.stringify(colors)}`
  )
}
if (!html.includes('style="--markdown-color:#edf4ff"')) {
  throw new Error('the validated hex value should feed the swatch CSS variable')
}
if (!html.includes('class="markdown__color-swatch" aria-hidden="true"')) {
  throw new Error('the supplementary swatch should be hidden from assistive technology')
}
if (!html.includes('<pre><code') || !html.includes('#ffffff')) {
  throw new Error('fenced source should keep its color literal')
}
if (colors.includes('#ffffff')) {
  throw new Error('fenced source and linked URL fragments must not gain color previews')
}

console.log('MARKDOWN-COLOR OK')
