import type { Element, Root, RootContent, Text } from 'hast'
import type { ComponentPropsWithoutRef, CSSProperties } from 'react'
import type { ExtraProps } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import type { PluggableList } from 'unified'

const HEX_COLOR =
  /(?<![A-Za-z0-9_-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![A-Za-z0-9_-])/g

type HastParent = Root | Element

function colorToken(value: string): Element {
  return {
    type: 'element',
    tagName: 'span',
    properties: { className: ['markdown__color-token'], dataColor: value },
    children: [
      {
        type: 'element',
        tagName: 'span',
        properties: { className: ['markdown__color-swatch'], ariaHidden: 'true' },
        children: []
      },
      { type: 'text', value }
    ]
  }
}

function decorateHexColors(parent: HastParent): void {
  const next: RootContent[] = []

  for (const child of parent.children) {
    // Source blocks and links should remain uninterrupted. Inline code is useful
    // as a color surface, since assistants commonly format tokens as `#edf4ff`.
    if (child.type === 'element' && child.tagName !== 'pre' && child.tagName !== 'a') {
      decorateHexColors(child)
    }
    if (child.type !== 'text') {
      next.push(child)
      continue
    }

    HEX_COLOR.lastIndex = 0
    let cursor = 0
    let match = HEX_COLOR.exec(child.value)
    while (match) {
      if (match.index > cursor) {
        next.push({ type: 'text', value: child.value.slice(cursor, match.index) } satisfies Text)
      }
      next.push(colorToken(match[0]))
      cursor = match.index + match[0].length
      match = HEX_COLOR.exec(child.value)
    }
    if (cursor === 0) {
      next.push(child)
    } else if (cursor < child.value.length) {
      next.push({ type: 'text', value: child.value.slice(cursor) })
    }
  }

  parent.children = next
}

function rehypeColorPreviews() {
  return (tree: Root) => decorateHexColors(tree)
}

// highlight.js has no Svelte/Vue/Astro grammars, so fences tagged with them
// rendered completely unhighlighted. Their templates are close enough to HTML
// that the xml grammar reads well — script/style blocks included.
const rehypePlugins: PluggableList = [
  [rehypeHighlight, { aliases: { xml: ['svelte', 'vue', 'astro'] } }],
  rehypeColorPreviews
]

type MarkdownSpanProps = ComponentPropsWithoutRef<'span'> & ExtraProps

function MarkdownSpan({ node, style, ...props }: MarkdownSpanProps): React.JSX.Element {
  const color = node?.properties.dataColor
  const colorStyle =
    typeof color === 'string' ? ({ ...style, '--markdown-color': color } as CSSProperties) : style
  return <span {...props} style={colorStyle} />
}

/** Renders streamed assistant text as GitHub-flavored markdown with code highlighting. */
export default function Markdown({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={{ span: MarkdownSpan }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
