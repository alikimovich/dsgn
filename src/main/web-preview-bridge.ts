/**
 * Dev-only script injected by the local preview gateway. It executes inside the
 * preview's own origin, so it can inspect DOM that the cross-origin Praxis parent
 * cannot, then reports bounded descriptions through postMessage.
 */
export const WEB_PREVIEW_BRIDGE = String.raw`(() => {
  const script = document.currentScript
  const params = new URL(script && script.src ? script.src : location.href).searchParams
  const token = params.get('token') || ''
  let selectMode = false
  let hovered = null

  const send = (type, payload) => {
    parent.postMessage({ source: 'praxis-preview', token, type, payload }, '*')
  }

  const overlay = document.createElement('div')
  overlay.setAttribute('data-praxis-browser-overlay', '')
  Object.assign(overlay.style, {
    position: 'fixed',
    display: 'none',
    pointerEvents: 'none',
    zIndex: '2147483647',
    border: '2px solid #2563eb',
    borderRadius: '4px',
    background: 'rgba(37, 99, 235, 0.08)',
    boxSizing: 'border-box'
  })
  document.documentElement.appendChild(overlay)

  const sourceElement = (element) => {
    let current = element
    while (current && current !== document.documentElement) {
      if (current.hasAttribute && current.hasAttribute('data-praxis-source')) return current
      current = current.parentElement
    }
    return element
  }

  const selector = (element) => {
    if (element.id) return '#' + CSS.escape(element.id)
    const parts = []
    let current = element
    while (current && current !== document.body && parts.length < 5) {
      let part = current.tagName.toLowerCase()
      const classes = Array.from(current.classList || []).slice(0, 2)
      if (classes.length) part += '.' + classes.map((name) => CSS.escape(name)).join('.')
      const parentElement = current.parentElement
      if (parentElement) {
        const siblings = Array.from(parentElement.children).filter((child) => child.tagName === current.tagName)
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')'
      }
      parts.unshift(part)
      current = parentElement
    }
    return parts.join(' > ')
  }

  const describe = (raw) => {
    const element = sourceElement(raw)
    const rect = element.getBoundingClientRect()
    const computed = getComputedStyle(element)
    const styles = {}
    for (const property of [
      'color', 'background-color', 'font-family', 'font-size', 'font-weight',
      'line-height', 'display', 'position', 'width', 'height', 'margin',
      'padding', 'border-radius', 'opacity'
    ]) styles[property] = computed.getPropertyValue(property)
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id || null,
      classes: Array.from(element.classList || []).slice(0, 32),
      selector: selector(element).slice(0, 1024),
      source: element.getAttribute('data-praxis-source'),
      componentSource: element.getAttribute('data-praxis-component-source'),
      text: (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) || null,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      styles
    }
  }

  const paint = (element) => {
    hovered = element
    if (!selectMode || !element) {
      overlay.style.display = 'none'
      return
    }
    const rect = sourceElement(element).getBoundingClientRect()
    Object.assign(overlay.style, {
      display: 'block',
      left: rect.left + 'px',
      top: rect.top + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px'
    })
  }

  addEventListener('pointermove', (event) => {
    if (!selectMode) return
    const element = event.target instanceof Element ? event.target : null
    if (element && element !== overlay) paint(element)
  }, true)

  addEventListener('click', (event) => {
    if (!selectMode) return
    const element = event.target instanceof Element ? event.target : null
    if (!element || element === overlay) return
    event.preventDefault()
    event.stopImmediatePropagation()
    selectMode = false
    paint(null)
    send('element-picked', describe(element))
  }, true)

  addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && selectMode) {
      selectMode = false
      paint(null)
      send('select-cancelled')
    } else if (event.key.toLowerCase() === 's' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const target = event.target
      if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement) && !target?.isContentEditable) {
        send('toggle-select')
      }
    }
  }, true)

  addEventListener('message', (event) => {
    const message = event.data || {}
    if (message.source !== 'praxis-control' || message.token !== token) return
    if (message.type === 'set-select-mode') {
      selectMode = !!message.payload
      paint(selectMode ? hovered : null)
    } else if (message.type === 'clear-selected') {
      paint(null)
    } else if (message.type === 'styles-preview' && hovered) {
      const property = message.payload && message.payload.prop
      const value = message.payload && message.payload.value
      if (typeof property === 'string' && typeof value === 'string') hovered.style.setProperty(property, value)
    } else if (message.type === 'styles-clear-preview' && hovered) {
      const property = message.payload && message.payload.prop
      if (typeof property === 'string') hovered.style.removeProperty(property)
    }
  })

  const announceUrl = () => send('url-changed', location.href)
  addEventListener('popstate', announceUrl)
  addEventListener('hashchange', announceUrl)
  const originalPush = history.pushState.bind(history)
  const originalReplace = history.replaceState.bind(history)
  history.pushState = (...args) => { originalPush(...args); announceUrl() }
  history.replaceState = (...args) => { originalReplace(...args); announceUrl() }

  const ready = () => {
    send('ready', { stamps: document.querySelectorAll('[data-praxis-source]').length })
    announceUrl()
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', ready, { once: true })
  else ready()
})()`
