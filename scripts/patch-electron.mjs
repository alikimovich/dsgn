// Rebrand the dev Electron.app bundle so `bun run dev` presents as Praxis.
//
// In development the macOS app-menu title, Cmd-Tab entry, and Activity Monitor
// name all come from node_modules/electron/dist/Electron.app's Info.plist —
// `app.setName()` cannot override them. Since Praxis is distributed as source
// and run via `bun run dev`, the dev bundle IS the product, so we patch it in
// place and ad-hoc re-sign (editing a signed bundle breaks its seal; unsigned
// apps are killed on arm64). What gets rebranded:
//
//  - Main bundle CFBundleName/CFBundleDisplayName → menu bar, Cmd-Tab,
//    Activity Monitor, crash dialogs.
//  - Icon, two ways: build/Assets.car + CFBundleIconName (the macOS 26 layered
//    icon compiled from the Icon Composer source — native icons get the
//    system's sizing treatment; a flat .icns alone draws ~10% oversized) and
//    an electron.icns swap for pre-26 macOS / CFBundleIconFile readers.
//  - The MAIN EXECUTABLE: Contents/MacOS/Electron → Praxis (CFBundleExecutable
//    + node_modules/electron/path.txt updated to match), so `ps`, sampling,
//    and crash reports show Praxis. Electron resolves its own path via
//    process.execPath at runtime, so the rename is safe.
//  - Helper apps' CFBundleName/CFBundleDisplayName ("Electron Helper
//    (Renderer)" → "Praxis Helper (Renderer)") so child processes read as ours
//    in Activity Monitor. Their .app folders and executables keep their names —
//    Chromium locates helpers by path, and display names come from the plists.
//
//  - CFBundleIdentifier → com.alikimovich.praxis (helpers get .helper). NOTE:
//    macOS keys TCC permission grants (screen recording, notifications) to the
//    bundle id, so the first run after this re-prompts for them.
//
// Runs from postinstall (every `bun install` restores a stock Electron), and is
// a no-op on non-macOS or when the bundle is already patched.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_NAME = 'Praxis'
const BUNDLE_ID = 'com.alikimovich.praxis'
const ICON_NAME = 'praxis' // asset name inside Assets.car
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronDir = join(root, 'node_modules/electron')
const appBundle = join(electronDir, 'dist/Electron.app')
const plist = join(appBundle, 'Contents/Info.plist')
const resources = join(appBundle, 'Contents/Resources')
const macosDir = join(appBundle, 'Contents/MacOS')
const frameworks = join(appBundle, 'Contents/Frameworks')
const icns = join(resources, 'electron.icns')
const car = join(resources, 'Assets.car')
const ourIcns = join(root, 'build/icon.icns')
const ourCar = join(root, 'build/Assets.car')

if (process.platform !== 'darwin' || !existsSync(plist)) process.exit(0)

const buddy = (file, cmd) =>
  execFileSync('/usr/libexec/PlistBuddy', ['-c', cmd, file]).toString().trim()
const setOrAdd = (file, key, value) => {
  try {
    buddy(file, `Set :${key} ${value}`)
  } catch {
    buddy(file, `Add :${key} string ${value}`)
  }
}
const fileMatches = (ours, theirs) =>
  existsSync(ours) && existsSync(theirs) &&
  readFileSync(ours).equals(readFileSync(theirs))

// Refresh LaunchServices. Renaming + re-signing the bundle in place does NOT
// invalidate the LS cache, so the Dock, Cmd-Tab, and menu-bar app title keep
// showing the stale "Electron" identity until a reboot. Force a re-register so
// the rebrand shows on the next `bun run dev` (relaunch a running app to see it).
// Runs even when the bundle is already patched, to migrate machines patched by
// an older version of this script that didn't refresh LS.
const lsregister =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const refreshLaunchServices = () => {
  if (!existsSync(lsregister)) return
  try {
    execFileSync(lsregister, ['-f', appBundle], { stdio: 'ignore' })
  } catch {
    // Best-effort: a stale LS entry only affects the displayed name, not function.
  }
}

let iconName = ''
try {
  iconName = buddy(plist, 'Print :CFBundleIconName')
} catch {
  /* key absent on stock Electron */
}
const patched =
  buddy(plist, 'Print :CFBundleName') === APP_NAME &&
  iconName === ICON_NAME &&
  buddy(plist, 'Print :CFBundleExecutable') === APP_NAME &&
  buddy(plist, 'Print :CFBundleIdentifier') === BUNDLE_ID &&
  fileMatches(ourIcns, icns) &&
  fileMatches(ourCar, car)
if (patched) {
  refreshLaunchServices()
  process.exit(0)
}

// Main bundle identity + icon.
setOrAdd(plist, 'CFBundleName', APP_NAME)
setOrAdd(plist, 'CFBundleDisplayName', APP_NAME)
setOrAdd(plist, 'CFBundleIdentifier', BUNDLE_ID)
setOrAdd(plist, 'CFBundleIconName', ICON_NAME)
if (existsSync(ourIcns)) copyFileSync(ourIcns, icns)
if (existsSync(ourCar)) copyFileSync(ourCar, car)

// Main executable: Electron → Praxis (+ path.txt so require('electron'),
// electron-vite, and Playwright keep launching the right binary).
const oldExe = join(macosDir, 'Electron')
const newExe = join(macosDir, APP_NAME)
if (existsSync(oldExe) && !existsSync(newExe)) renameSync(oldExe, newExe)
if (existsSync(newExe)) {
  setOrAdd(plist, 'CFBundleExecutable', APP_NAME)
  const pathTxt = join(electronDir, 'path.txt')
  if (existsSync(pathTxt)) {
    writeFileSync(pathTxt, `Electron.app/Contents/MacOS/${APP_NAME}`)
  }
}

// Helper apps: display names only (folders/executables keep their paths).
if (existsSync(frameworks)) {
  for (const entry of readdirSync(frameworks)) {
    if (!/^Electron Helper.*\.app$/.test(entry)) continue
    const helperPlist = join(frameworks, entry, 'Contents/Info.plist')
    if (!existsSync(helperPlist)) continue
    const suffix = entry.replace(/^Electron/, '').replace(/\.app$/, '') // " Helper (Renderer)"
    setOrAdd(helperPlist, 'CFBundleName', `${APP_NAME}${suffix}`)
    setOrAdd(helperPlist, 'CFBundleDisplayName', `${APP_NAME}${suffix}`)
    setOrAdd(helperPlist, 'CFBundleIdentifier', `${BUNDLE_ID}.helper`)
  }
}

execFileSync('codesign', ['--force', '--deep', '--sign', '-', appBundle], {
  stdio: 'inherit',
})
refreshLaunchServices()

console.log(`[patch-electron] dev Electron.app rebranded as ${APP_NAME}`)
