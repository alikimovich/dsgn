import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const fixture = mkdtempSync(join(tmpdir(), 'praxis-preview-drag-'))
const profile = mkdtempSync(join(tmpdir(), 'praxis-preview-drag-profile-'))
const file = join(fixture, 'index.html')
const html = `<!doctype html>
<html><head><style>
body { margin: 40px; font: 16px system-ui; }
#group { display: flex; flex-direction: column; gap: 16px; padding: 16px; border: 1px solid; }
article { padding: 20px; border: 1px solid; min-width: 90px; }
</style></head><body>
<main id="group">
<article id="alpha"><span>Alpha</span></article>
<article id="beta"><span>Beta</span></article>
<article id="gamma"><span>Gamma</span></article>
</main>
<aside>Another container</aside>
</body></html>`
writeFileSync(file, html)
let app
try {
  app = await electron.launch({ executablePath: electronPath,
    args: [join(root, 'out/main/index.js')], cwd: root,
    env: { ...process.env, PRAXIS_USER_DATA: profile } })
  const win = await app.firstWindow()
  await win.waitForSelector('.empty__open')
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, fixture)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'open-project'))
  const preview = async (code) => app.evaluate(async ({ webContents }, code) => {
    const wc = webContents.getAllWebContents().find(w => /^http:\/\/(localhost|127\.0\.0\.1):/.test(w.getURL()))
    return wc ? wc.executeJavaScript(code, true) : null
  }, code)
  const wait = async (fn) => {
    for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)) }
    throw new Error('Timed out waiting for preview state')
  }
  await wait(() => preview('!!document.querySelector("#alpha[data-praxis-source]")'))
  const input = async (events) => app.evaluate(({ webContents }, events) => {
    const wc = webContents.getAllWebContents().find(w => /^http:\/\/(localhost|127\.0\.0\.1):/.test(w.getURL()))
    wc.focus()
    for (const e of events) wc.sendInputEvent(e)
  }, events)
  const coords = async (id, end = false, row = false) => preview(`(() => {
    const b = document.querySelector('#${id}').getBoundingClientRect();
    return {x: Math.round(${end && row ? 'b.right - 3' : 'b.left + b.width / 2'}),
      y: Math.round(${end && !row ? 'b.bottom - 3' : 'b.top + b.height / 2'})}; })()`)
  const pick = async () => {
    const snapshot = await win.evaluate(() => window.api.layers.read())
    const node = snapshot.nodes.find(n => n.id === 'alpha')
    await win.evaluate(n => window.api.layers.select(n.path, { tag: n.tag, source: n.source }), node)
    await new Promise(r => setTimeout(r, 100))
  }
  const mods = process.platform === 'darwin' ? ['meta'] : ['control']
  const start = async (row = false, modifiers = mods) => {
    const a = await coords('alpha'), c = await coords('gamma', true, row)
    await input([{type:'mouseMove', ...a}, {type:'mouseDown', ...a, button:'left', clickCount:1, modifiers},
      {type:'mouseMove', ...c, modifiers}])
    return c
  }
  const line = () => preview('!!document.querySelector("[data-praxis-overlay]")?.shadowRoot?.querySelector("[data-praxis-drop-line]")')
  await pick()
  let c = await start()
  await wait(line)
  mkdirSync(join(root, 'test/artifacts'), { recursive: true })
  const png = await app.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find(w => /^http:\/\/(localhost|127\.0\.0\.1):/.test(w.getURL()))
    return (await wc.capturePage()).toPNG().toString('base64')
  })
  writeFileSync(join(root, 'test/artifacts/preview-drag.png'), Buffer.from(png, 'base64'))
  await input([{type:'mouseUp', ...c, button:'left', clickCount:1, modifiers:mods}])
  await wait(() => readFileSync(file, 'utf8').indexOf('id="alpha"') > readFileSync(file, 'utf8').indexOf('id="gamma"'))
  await wait(() => preview('document.querySelector("#group").lastElementChild.id === "alpha"'))
  assert.equal(await preview('document.querySelector("#alpha").parentElement.id'), 'group')
  await win.evaluate(root => window.api.edits.undo(root), fixture)
  await wait(() => preview('document.querySelector("#group").firstElementChild.id === "alpha"'))
  assert.equal(readFileSync(file, 'utf8'), html, 'undo restores exact source')
  // Leaving the current parent never targets a different container.
  await pick()
  c = await start()
  await wait(line)
  await input([{type:'mouseMove', x:5, y:5, modifiers:mods},
    {type:'mouseUp', x:5, y:5, button:'left', clickCount:1, modifiers:mods}])
  assert.equal(await line(), false)
  assert.equal(readFileSync(file, 'utf8'), html, 'outside-parent drop does not write')
  // Releasing the modifier cancels, including the resulting page click.
  await preview('window.dragClicks = 0; document.addEventListener("click", () => window.dragClicks++)')
  await pick()
  c = await start()
  await wait(line)
  await input([{type:'keyUp', keyCode: process.platform === 'darwin' ? 'Meta' : 'Control'}])
  await new Promise(r => setTimeout(r, 100))
  await input([{type:'mouseUp', ...c, button:'left', clickCount:1}])
  assert.equal(await line(), false)
  assert.equal(await preview('window.dragClicks'), 0, 'cancelled gesture does not click the app')
  assert.equal(readFileSync(file, 'utf8'), html)
  // Synthetic project events cannot initiate source writes.
  await preview(`(() => {
    const el = document.querySelector('#alpha span');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, metaKey:true, ctrlKey:true, button:0 }));
    el.dispatchEvent(new PointerEvent('pointermove', { bubbles:true, metaKey:true, ctrlKey:true, clientX:300, clientY:300 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles:true, metaKey:true, ctrlKey:true }));
  })()`)
  assert.equal(await line(), false)
  assert.equal(readFileSync(file, 'utf8'), html)
  // Horizontal non-list siblings, with an actual nested span under the pointer.
  await preview('document.querySelector("#group").style.flexDirection = "row"')
  await pick()
  c = await start(true)
  await wait(line)
  await input([{type:'keyDown', keyCode:'Escape'}, {type:'mouseUp', ...c, button:'left', clickCount:1, modifiers:mods}])
  assert.equal(await line(), false, 'Escape clears insertion line')
  assert.equal(readFileSync(file, 'utf8'), html, 'Escape does not write')
  // Ordinary dragging remains owned by the page.
  await pick()
  c = await start(true, [])
  await input([{type:'mouseUp', ...c, button:'left', clickCount:1}])
  assert.equal(await line(), false)
  assert.equal(readFileSync(file, 'utf8'), html)
  // Trusted horizontal gesture persists the same sibling move.
  await pick()
  c = await start(true)
  await wait(line)
  await input([{type:'mouseUp', ...c, button:'left', clickCount:1, modifiers:mods}])
  await wait(() => readFileSync(file, 'utf8').indexOf('id="alpha"') > readFileSync(file, 'utf8').indexOf('id="gamma"'))
  console.log('PASS preview drag: non-list siblings, nested content, vertical/horizontal, persistence, reload, undo, Escape, ordinary input')
} finally {
  await app?.close()
  rmSync(fixture, { recursive: true, force: true })
  rmSync(profile, { recursive: true, force: true })
}
