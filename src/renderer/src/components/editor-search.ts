import { search, SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, setSearchQuery } from '@codemirror/search'
import type { Extension } from '@codemirror/state'
import { EditorView, type Panel, type ViewUpdate } from '@codemirror/view'

/**
 * Zed-style search panel for the code editor (replaces CodeMirror's stock
 * bottom bar). basicSetup ships `searchKeymap` (⌘F open, Enter/Shift-Enter
 * next/prev, Esc close) but no `search()` config, so the panel came from the
 * facet DEFAULT — this extension supplies the config: top-mounted, one rounded
 * query field with inline Aa / wd / .* toggles, ‹ › stepping, a live n/N match
 * count, and a collapsible replace row. Plain DOM (a CM Panel can't be React);
 * colors ride the same design-token vars as `praxisTheme`, so it follows the
 * app's light/dark theme.
 */

/** Inline SVG (lucide paths) — CM panels are plain DOM, no React icons here. */
const svg = (paths: string): string =>
  `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
const ICONS = {
  prev: svg('<path d="m15 18-6-6 6-6"/>'),
  next: svg('<path d="m9 18 6-6-6-6"/>'),
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  replace: svg('<path d="M14 4a2 2 0 0 1 2-2"/><path d="M16 10a2 2 0 0 1-2-2"/><path d="M20 2a2 2 0 0 1 2 2"/><path d="M22 8a2 2 0 0 1-2 2"/><path d="m3 7 3 3 3-3"/><path d="M6 10V5a3 3 0 0 1 3-3h1"/><rect x="2" y="14" width="8" height="8" rx="2"/>')
}

/** Count matches (capped) and the 1-based index of the one the selection is on. */
function countMatches(view: EditorView, query: SearchQuery): { total: number; current: number } {
  if (!query.search) return { total: 0, current: 0 }
  const { main } = view.state.selection
  let total = 0
  let current = 0
  try {
    const cursor = query.getCursor(view.state)
    let step = cursor.next()
    while (!step.done && total < 1000) {
      total++
      if (step.value.from === main.from && step.value.to === main.to) current = total
      step = cursor.next()
    }
  } catch {
    return { total: 0, current: 0 } // malformed regexp mid-typing
  }
  return { total, current }
}

class ZedSearchPanel implements Panel {
  dom: HTMLElement
  top = true
  private query: SearchQuery
  private searchInput: HTMLInputElement
  private replaceInput: HTMLInputElement
  private count: HTMLElement
  private replaceRow: HTMLElement
  private toggles = new Map<'caseSensitive' | 'wholeWord' | 'regexp', HTMLButtonElement>()

  constructor(readonly view: EditorView) {
    this.query = getSearchQuery(view.state)
    this.dom = document.createElement('div')
    this.dom.className = 'cm-zed-search'
    // The outer keydown runs before CM's panel keymap: Esc always closes.
    this.dom.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeSearchPanel(this.view)
        this.view.focus()
      }
    })

    const row = document.createElement('div')
    row.className = 'cm-zed-search__row'

    const field = document.createElement('div')
    field.className = 'cm-zed-search__field'
    this.searchInput = this.input('Search…', 'search')
    this.searchInput.addEventListener('input', () => this.commit())
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      ;(e.shiftKey ? findPrevious : findNext)(this.view)
    })
    field.append(
      this.searchInput,
      this.toggle('caseSensitive', 'Aa', 'Match case'),
      this.toggle('wholeWord', 'wd', 'Whole word'),
      this.toggle('regexp', '.*', 'Regular expression')
    )

    this.count = document.createElement('span')
    this.count.className = 'cm-zed-search__count'

    const replaceToggle = this.iconBtn(ICONS.replace, 'Toggle replace', () => {
      const open = this.replaceRow.classList.toggle('is-open')
      replaceToggle.classList.toggle('is-active', open)
      if (open) this.replaceInput.focus()
      else this.searchInput.focus()
    })

    row.append(
      field,
      this.iconBtn(ICONS.prev, 'Previous match (⇧↵)', () => findPrevious(this.view)),
      this.iconBtn(ICONS.next, 'Next match (↵)', () => findNext(this.view)),
      this.count,
      replaceToggle,
      this.iconBtn(ICONS.close, 'Close (Esc)', () => {
        closeSearchPanel(this.view)
        this.view.focus()
      })
    )

    this.replaceRow = document.createElement('div')
    this.replaceRow.className = 'cm-zed-search__row cm-zed-search__replace'
    const rfield = document.createElement('div')
    rfield.className = 'cm-zed-search__field'
    this.replaceInput = this.input('Replace with…', 'replace')
    this.replaceInput.addEventListener('input', () => this.commit())
    this.replaceInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      ;(e.metaKey || e.ctrlKey ? replaceAll : replaceNext)(this.view)
    })
    rfield.append(this.replaceInput)
    const replaceBtn = this.textBtn('Replace', 'Replace next (↵)', () => replaceNext(this.view))
    const allBtn = this.textBtn('All', 'Replace all (⌘↵)', () => replaceAll(this.view))
    this.replaceRow.append(rfield, replaceBtn, allBtn)

    this.dom.append(row, this.replaceRow)
    this.syncFromQuery()
  }

  mount(): void {
    this.searchInput.focus()
    this.searchInput.select()
  }

  update(update: ViewUpdate): void {
    // Another actor (searchKeymap's "select word under cursor" on ⌘F reopen,
    // a programmatic setSearchQuery) may have changed the query — resync.
    const q = getSearchQuery(update.state)
    if (!q.eq(this.query)) {
      this.query = q
      this.syncFromQuery()
    }
    if (update.docChanged || update.selectionSet) this.recount()
  }

  private input(placeholder: string, kind: string): HTMLInputElement {
    const el = document.createElement('input')
    el.className = 'cm-zed-search__input'
    el.placeholder = placeholder
    el.setAttribute('aria-label', kind)
    // CM focuses the panel's [main-field] on open — that's the search box only.
    if (kind === 'search') el.setAttribute('main-field', 'true')
    return el
  }

  private toggle(
    flag: 'caseSensitive' | 'wholeWord' | 'regexp',
    label: string,
    title: string
  ): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'cm-zed-search__toggle'
    btn.textContent = label
    btn.title = title
    btn.addEventListener('click', () => {
      btn.classList.toggle('is-active')
      btn.setAttribute('aria-pressed', String(btn.classList.contains('is-active')))
      this.commit()
      this.searchInput.focus()
    })
    this.toggles.set(flag, btn)
    return btn
  }

  private iconBtn(icon: string, title: string, run: () => void): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'cm-zed-search__btn'
    btn.innerHTML = icon
    btn.title = title
    btn.setAttribute('aria-label', title)
    btn.addEventListener('click', run)
    return btn
  }

  private textBtn(label: string, title: string, run: () => void): HTMLButtonElement {
    const btn = this.iconBtn('', title, run)
    btn.classList.add('cm-zed-search__btn--text')
    btn.textContent = label
    return btn
  }

  private on(flag: 'caseSensitive' | 'wholeWord' | 'regexp'): boolean {
    return this.toggles.get(flag)?.classList.contains('is-active') ?? false
  }

  /** Push the panel's state into the search query (drives match highlighting). */
  private commit(): void {
    const query = new SearchQuery({
      search: this.searchInput.value,
      replace: this.replaceInput.value,
      caseSensitive: this.on('caseSensitive'),
      wholeWord: this.on('wholeWord'),
      regexp: this.on('regexp')
    })
    if (query.eq(this.query)) return
    this.query = query
    this.view.dispatch({ effects: setSearchQuery.of(query) })
    this.recount()
  }

  /** Pull query state into the DOM (initial open, external query change). */
  private syncFromQuery(): void {
    this.searchInput.value = this.query.search
    this.replaceInput.value = this.query.replace
    for (const [flag, btn] of this.toggles) {
      btn.classList.toggle('is-active', this.query[flag])
      btn.setAttribute('aria-pressed', String(this.query[flag]))
    }
    this.recount()
  }

  private recount(): void {
    const { total, current } = countMatches(this.view, this.query)
    this.count.textContent = this.query.search ? `${current}/${total}${total >= 1000 ? '+' : ''}` : '0/0'
    this.count.classList.toggle('is-empty', Boolean(this.query.search) && total === 0)
  }
}

const zedSearchTheme = EditorView.theme({
  '.cm-panels': { backgroundColor: 'var(--background)', color: 'var(--foreground)' },
  '.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-zed-search': {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '8px 10px'
  },
  '.cm-zed-search__row': { display: 'flex', alignItems: 'center', gap: '4px' },
  '.cm-zed-search__replace': { display: 'none' },
  '.cm-zed-search__replace.is-open': { display: 'flex' },
  '.cm-zed-search__field': {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    flex: '0 1 420px',
    minWidth: '180px',
    padding: '3px 6px',
    background: 'var(--background)',
    border: '1px solid var(--border)',
    borderRadius: '8px'
  },
  '.cm-zed-search__field:focus-within': { borderColor: 'var(--ring)' },
  '.cm-zed-search__input': {
    flex: '1 1 auto',
    minWidth: '60px',
    border: 'none',
    outline: 'none',
    background: 'transparent',
    color: 'var(--foreground)',
    font: '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  },
  '.cm-zed-search__toggle': {
    flex: 'none',
    padding: '2px 5px',
    border: 'none',
    borderRadius: '5px',
    background: 'transparent',
    color: 'var(--muted-foreground)',
    font: '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    cursor: 'pointer'
  },
  '.cm-zed-search__toggle:hover': { color: 'var(--foreground)' },
  '.cm-zed-search__toggle.is-active': {
    background: 'color-mix(in oklab, var(--primary) 15%, transparent)',
    color: 'var(--primary)'
  },
  '.cm-zed-search__btn': {
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    border: 'none',
    borderRadius: '6px',
    background: 'transparent',
    color: 'var(--muted-foreground)',
    cursor: 'pointer'
  },
  '.cm-zed-search__btn:hover': {
    background: 'color-mix(in oklab, var(--muted) 70%, transparent)',
    color: 'var(--foreground)'
  },
  '.cm-zed-search__btn.is-active': {
    background: 'color-mix(in oklab, var(--primary) 15%, transparent)',
    color: 'var(--primary)'
  },
  '.cm-zed-search__btn--text': {
    width: 'auto',
    padding: '0 8px',
    font: '11px system-ui, sans-serif'
  },
  '.cm-zed-search__count': {
    flex: 'none',
    minWidth: '38px',
    textAlign: 'center',
    color: 'var(--muted-foreground)',
    font: '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontVariantNumeric: 'tabular-nums'
  },
  '.cm-zed-search__count.is-empty': { color: 'var(--destructive)' }
})

/** The full drop-in: top-mounted Zed-style panel + its theme. */
export function zedSearch(): Extension {
  return [search({ top: true, createPanel: (view) => new ZedSearchPanel(view) }), zedSearchTheme]
}
