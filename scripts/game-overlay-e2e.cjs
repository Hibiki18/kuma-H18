const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, ipcMain } = require('electron')

const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async (read, description, timeoutMs = 5000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await read()
    if (value) return value
    await sleep(20)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

app.whenReady().then(async () => {
  let ready
  const hostReady = new Promise((resolve) => { ready = resolve })
  const actions = []
  const releasedActions = []
  ipcMain.handle('game-host:get-bootstrap', () => ({
    homepage: 'about:blank',
    preload: pathToFileURL(path.join(ROOT, 'assets', 'preload', 'webview-preload.js')).href,
    userAgent: 'kuma-overlay-e2e',
  }))
  ipcMain.handle('game-window:command', () => ({ ok: true }))
  ipcMain.on('game-host:ready', () => ready())
  ipcMain.on('game-host:action', (_event, token) => actions.push(token))
  ipcMain.on('game-host:release-action', (_event, token) => releasedActions.push(token))

  const window = new BrowserWindow({
    show: false,
    width: 1200,
    height: 720,
    webPreferences: {
      preload: path.join(ROOT, 'dist', 'main', 'game-host-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
      backgroundThrottling: false,
    },
  })
  await window.loadFile(path.join(ROOT, 'dist', 'renderer', 'game-host.html'))
  await Promise.race([
    hostReady,
    sleep(5000).then(() => { throw new Error('game host did not finish bootstrap within 5 seconds') }),
  ])

  const send = (event) => window.webContents.send('game-host:overlay', event)
  send({
    kind: 'caption', mode: 'friendly', speaker: '赤城', text: '発艦始め！',
    tone: 'light', durationMs: 5000, lane: 1,
  })
  send({
    kind: 'caption', mode: 'bottom', speaker: '榛名', text: '準備万端です',
    durationMs: 40,
  })
  await waitFor(
    () => window.webContents.executeJavaScript(
      "document.querySelector('#voice-subtitle').classList.contains('show') && " +
      "document.querySelectorAll('#voice-danmaku .voice-danmaku-item').length === 1",
      true,
    ),
    'caption and danmaku rendering',
  )
  await sleep(120)
  const initial = await window.webContents.executeJavaScript(`({
    subtitleVisible: document.querySelector('#voice-subtitle').classList.contains('show'),
    subtitleBackground: getComputedStyle(document.querySelector('#voice-subtitle')).backgroundColor,
    danmakuBackground: getComputedStyle(document.querySelector('#voice-danmaku')).backgroundColor,
    danmakuCount: document.querySelectorAll('#voice-danmaku .voice-danmaku-item').length,
  })`, true)
  assert.equal(initial.subtitleVisible, true, 'the host must not pre-empt the controller audio timer')
  assert.equal(initial.subtitleBackground, 'rgba(0, 0, 0, 0)')
  assert.equal(initial.danmakuBackground, 'rgba(0, 0, 0, 0)')
  assert.equal(initial.danmakuCount, 1)

  send({ kind: 'caption-clear', scope: 'bottom' })
  await waitFor(
    () => window.webContents.executeJavaScript(
      "!document.querySelector('#voice-subtitle').classList.contains('show')",
      true,
    ),
    'bottom caption clear',
  )
  assert.equal(
    await window.webContents.executeJavaScript(
      "document.querySelectorAll('#voice-danmaku .voice-danmaku-item').length",
      true,
    ),
    1,
    'bottom caption expiry must not clear battle danmaku',
  )
  send({ kind: 'caption-clear', scope: 'all' })
  await waitFor(
    () => window.webContents.executeJavaScript(
      "document.querySelectorAll('#voice-danmaku .voice-danmaku-item').length === 0",
      true,
    ),
    'full caption clear',
  )

  send({
    kind: 'toast', id: 'quest-1', severity: 'ok', title: '任务完成 ×3', detail: '第一批',
    locked: false, groupKey: 'quest', groupTitle: '任务完成', count: 3,
    action: { token: 'detail-1', label: '任务详情' },
    groupAction: { token: 'overview-1', label: '任务总览' }, durationMs: 5000,
  })
  send({
    kind: 'toast', id: 'quest-2', severity: 'ok', title: '任务完成 ×2', detail: '第二批',
    locked: false, groupKey: 'quest', groupTitle: '任务完成', count: 2,
    action: { token: 'detail-2', label: '任务详情' },
    groupAction: { token: 'overview-2', label: '任务总览' }, durationMs: 5000,
  })
  await waitFor(
    () => window.webContents.executeJavaScript(
      "document.querySelector('#lg-toasts .lg-toast b')?.textContent === '任务完成 ×5'",
      true,
    ),
    'toast batch merge',
  )
  const merged = await window.webContents.executeJavaScript(`({
    count: document.querySelectorAll('#lg-toasts .lg-toast').length,
    detail: document.querySelector('#lg-toasts .detail').textContent,
    action: document.querySelector('#lg-toasts .toast-action').textContent,
  })`, true)
  assert.deepEqual(merged, { count: 1, detail: '最新：第二批', action: '→ 任务总览' })
  await window.webContents.executeJavaScript(
    "document.querySelector('#lg-toasts .toast-action').click()",
    true,
  )
  await waitFor(() => actions.includes('overview-2'), 'merged toast overview action')

  send({
    kind: 'toast', id: 'locked-1', severity: 'danger', title: '大破警告', detail: '手动确认',
    locked: true, action: { token: 'locked-action', label: '战斗详情' },
  })
  await waitFor(
    () => window.webContents.executeJavaScript(
      "document.querySelector('#lg-toasts [data-locked=\"1\"]') != null",
      true,
    ),
    'locked toast rendering',
  )
  await window.webContents.executeJavaScript(
    "document.querySelector('#lg-toasts [data-locked=\"1\"] .toast-close').click()",
    true,
  )
  await waitFor(() => releasedActions.includes('locked-action'), 'dismissed toast action release')

  console.log('[kanso] game overlay e2e ok')
  window.destroy()
  app.exit(0)
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
