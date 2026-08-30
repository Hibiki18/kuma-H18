import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const main = fs.readFileSync(path.join(root, 'src/main/game-host-manager.ts'), 'utf8')
const workbench = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')
const broadcaster = fs.readFileSync(path.join(root, 'src/main/game-api-broadcaster.ts'), 'utf8')
const hostPreload = fs.readFileSync(path.join(root, 'src/main/game-host-preload.ts'), 'utf8')
const client = fs.readFileSync(path.join(root, 'src/renderer/game-window-client.ts'), 'utf8')

test('only the host surface can attach a webview and the workbench disables webviewTag', () => {
  assert.match(main, /view\.webContents\.on\('will-attach-webview'/)
  assert.match(main, /path\.resolve\(preload\).*trustedWebviewPreload/s)
  assert.match(main, /new URL\(params\.src\)\.href === new URL\(normalizeGameUrl\(config\.get\(GAME_URL_CONFIG_KEY\)\)\)\.href/)
  assert.match(main, /preferences\.nodeIntegration = false/)
  assert.match(workbench, /webviewTag: false/)
})

test('game API messages must come from the manager registered guest id', () => {
  assert.match(broadcaster, /acceptsGameWebContents\(event\.sender\.id\)/)
  assert.match(main, /broadcaster\.setGameWebContentsId\(guest\.id\)/)
  assert.match(main, /broadcaster\.setGameWebContentsId\(null\)/)
})

test('host preload exposes fixed operations rather than ipcRenderer or arbitrary script execution', () => {
  assert.doesNotMatch(hostPreload, /exposeInMainWorld\([^]*ipcRenderer\s*[,}]/)
  assert.doesNotMatch(hostPreload, /executeJavaScript/)
  assert.match(hostPreload, /command: \(type: 'reload'\)/)
})

test('recovery reuses the existing host and disposal removes owned IPC handlers', () => {
  assert.match(main, /this\.phase === 'RECOVERING'\) return this\.recoverToMode\(mode, persist\)/)
  assert.match(main, /parent\.contentView\.children\.includes\(view\)/)
  assert.match(main, /ipcMain\.removeHandler\(channel\)/)
  assert.match(main, /ipcMain\.removeAllListeners\(channel\)/)
})

test('workbench overlays occlude only the embedded native view without touching the guest', () => {
  for (const selector of [
    '#kanso-welcome',
    '#overlay-host.show',
    '#startup-overlay.visible',
    '#drag-overlay',
    '#kanso-command-palette.open',
    '#cg-lightbox.show',
    '.senka-detail-host',
    '#crash-panel:not([hidden])',
  ]) {
    assert.ok(client.includes(selector), `missing native-view occluder: ${selector}`)
  }
  assert.match(client, /ipcRenderer\.send\('game-window:occluded', occluded\)/)
  assert.match(main, /surface === 'embedded' && this\.workbenchOccluded/)
  assert.match(main, /this\.hostView\.setBounds\(this\.presentedBounds\('embedded', this\.embeddedBounds\)\)/)
})

test('failed migration cannot report a stable rollback unless the source was reattached', () => {
  assert.match(main, /if \(removedSource\) \{[^]*ROLLBACK_SOURCE_UNAVAILABLE[^]*rollbackWindow\.contentView\.addChildView\(this\.hostView\)/)
  assert.match(main, /catch \(rollbackError\) \{\s*this\.phase = 'RECOVERING'/)
})

test('only a guest-crash remount can clear the recovering phase on guest attach', () => {
  assert.match(main, /const guestRecovery =[^]*GAME_GUEST_CRASHED[^]*GAME_GUEST_DESTROY_FAILED/)
  assert.match(main, /if \(this\.phase === 'RECOVERING' && guestRecovery\)/)
})

test('workbench occlusion tracks hidden attributes as well as classes', () => {
  assert.match(client, /attributeFilter: \['class', 'hidden'\]/)
})

test('a crashed guest is destroyed before the host is allowed to remount it', () => {
  const crash = main.indexOf("guest.once('render-process-gone'")
  const destroyed = main.indexOf("guest.once('destroyed'", crash)
  const remount = main.indexOf("view.webContents.send('game-host:remount')", crash)
  const close = main.indexOf('guest.close()', crash)
  assert.ok(crash >= 0 && destroyed > crash && remount > destroyed && close > remount)
  assert.doesNotMatch(main.slice(crash, remount), /this\.clearGuestId\(\)/)
})

test('persistent banner actions expire with banner lifecycle rather than a fixed timeout', () => {
  assert.match(main, /for \(const token of tokens\) this\.actionTokens\.set\(token, null\)/)
  assert.match(main, /releaseBannerActionTokens\(overlay\.id\)/)
  assert.match(client, /releaseBannerActions\(event\.id\)/)
})

test('dismissed host toasts release action callbacks in both trusted processes', () => {
  assert.match(main, /ipcMain\.on\('game-host:release-action'/)
  assert.match(main, /webContents\.send\('game-host:release-action', token\)/)
  assert.match(client, /ipcRenderer\.on\('game-host:release-action'/)
  assert.match(client, /releaseAction\(token\)/)
})
