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
  assert.match(main, /new URL\(params\.src\)\.href === new URL\(String\(config\.get\('kanso\.homepage'\)\)\)\.href/)
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
  assert.match(client, /#kanso-welcome, #overlay-host\.show, #startup-overlay\.visible/)
  assert.match(client, /ipcRenderer\.send\('game-window:occluded', occluded\)/)
  assert.match(main, /surface === 'embedded' && this\.workbenchOccluded/)
  assert.match(main, /this\.hostView\.setBounds\(this\.presentedBounds\('embedded', this\.embeddedBounds\)\)/)
})
