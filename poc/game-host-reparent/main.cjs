const { app, BrowserWindow, ipcMain, screen, WebContentsView } = require('electron')
const electronRemote = require('@electron/remote/main')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '..', '..')
const RUNTIME = path.join(__dirname, '.runtime')
const RESULT = path.join(__dirname, 'result.json')
const PRELOAD = path.join(ROOT, 'assets', 'preload', 'webview-preload.js')
const HOST = path.join(__dirname, 'host.html')
const GUEST = fs.readFileSync(path.join(__dirname, 'guest.html'))
const ITERATIONS = 100

process.env.KANSO_DATA_DIR = RUNTIME
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.commandLine.appendSwitch('disable-site-isolation-trials')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.setPath('userData', RUNTIME)
electronRemote.initialize()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (read, description, timeoutMs = 8000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = read()
    if (value) return value
    await sleep(20)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname === '/guest.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(GUEST)
    return
  }
  if (url.pathname === '/frame.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end('<script>window.__frameInstance = crypto.randomUUID()</script>frame probe')
    return
  }
  if (url.pathname === '/kcsapi/poc') {
    const seq = Number(url.searchParams.get('seq'))
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ seq }))
    return
  }
  response.writeHead(404)
  response.end('not found')
})

const listen = () => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})

const closeServer = () => new Promise((resolve) => server.close(resolve))

app.on('remote-require', (event, _contents, moduleName) => {
  if (moduleName === './config') {
    event.returnValue = require(path.join(ROOT, 'dist', 'main', 'config.js'))
  } else {
    event.preventDefault()
  }
})

app.whenReady().then(async () => {
  fs.rmSync(RUNTIME, { recursive: true, force: true })
  fs.mkdirSync(RUNTIME, { recursive: true })
  const port = await listen()
  const guestUrl = `http://127.0.0.1:${port}/guest.html`
  const preloadUrl = pathToFileURL(PRELOAD).href
  const primary = screen.getPrimaryDisplay().workArea
  const windowOptions = (x, title) => ({
    x,
    y: primary.y + 40,
    width: Math.min(760, primary.width),
    height: Math.min(500, primary.height - 80),
    title,
    show: true,
    backgroundColor: '#050708',
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false },
  })
  const mainWindow = new BrowserWindow(windowOptions(primary.x + 20, 'PoC · workbench'))
  const detachedWindow = new BrowserWindow(
    windowOptions(primary.x + Math.max(40, primary.width - Math.min(780, primary.width)), 'PoC · detached'),
  )
  mainWindow.setMenu(null)
  detachedWindow.setMenu(null)

  const hostView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  })
  const counters = {
    attach: 0,
    guestDestroyed: 0,
    hostMainNavigations: 0,
    guestMainNavigations: 0,
    guestDomReady: 0,
  }
  let guest = null
  const apiResponses = []
  let currentParent = mainWindow
  let closing = false
  let closeRecovered = false

  ipcMain.on('kanso:game-api', (event, phase, payload) => {
    if (!guest || event.sender.id !== guest.id || phase !== 'response') return
    try {
      const parsed = typeof payload.response === 'string' ? JSON.parse(payload.response) : payload.response
      if (Number.isInteger(parsed?.seq)) apiResponses.push(parsed.seq)
    } catch {}
  })
  hostView.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) counters.hostMainNavigations += 1
  })
  hostView.webContents.on('will-attach-webview', (event, preferences, params) => {
    let supplied = ''
    try {
      supplied = params.preload.startsWith('file:') ? require('node:url').fileURLToPath(params.preload) : params.preload
    } catch {}
    if (path.resolve(supplied).toLowerCase() !== path.resolve(PRELOAD).toLowerCase() || guest) {
      event.preventDefault()
      return
    }
    preferences.preload = PRELOAD
    preferences.nodeIntegration = false
    preferences.nodeIntegrationInSubFrames = true
    preferences.nodeIntegrationInWorker = false
    preferences.contextIsolation = true
    preferences.sandbox = false
    preferences.webSecurity = false
    preferences.allowRunningInsecureContent = false
    preferences.webviewTag = false
  })
  hostView.webContents.on('did-attach-webview', (_event, contents) => {
    counters.attach += 1
    guest = contents
    electronRemote.enable(contents)
    contents.on('did-start-navigation', (_navEvent, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) counters.guestMainNavigations += 1
    })
    contents.on('dom-ready', () => { counters.guestDomReady += 1 })
    contents.on('destroyed', () => { counters.guestDestroyed += 1 })
  })

  const viewBounds = { x: 0, y: 0, width: Math.min(760, primary.width), height: Math.min(500, primary.height - 80) }
  mainWindow.contentView.addChildView(hostView)
  hostView.setBounds(viewBounds)
  await hostView.webContents.loadURL(`${pathToFileURL(HOST).href}?guest=${encodeURIComponent(guestUrl)}&preload=${encodeURIComponent(preloadUrl)}`)
  await waitFor(() => guest && counters.guestDomReady > 0, 'the production-preloaded guest')
  await sleep(250)

  const snapshot = () => guest.executeJavaScript('window.__poc.snapshot()', true)
  const baseline = await snapshot()
  const initialSession = guest.session
  const identity = {
    hostWebContentsId: hostView.webContents.id,
    guestWebContentsId: guest.id,
    guestProcessId: guest.getOSProcessId(),
    sessionStoragePath: guest.session.storagePath,
    hostInstance: await hostView.webContents.executeJavaScript('window.__hostPoc.instance', true),
    ...baseline,
  }
  const initialCounters = { ...counters }
  const durations = []

  const migrate = async (target, inject = '') => {
    const source = currentParent
    const started = performance.now()
    let removed = false
    try {
      if (inject === 'target-create') throw new Error('TARGET_WINDOW_CREATE_FAILED')
      source.contentView.removeChildView(hostView)
      removed = true
      if (inject === 'target-attach') throw new Error('ATTACH_TARGET_FAILED')
      target.contentView.addChildView(hostView)
      hostView.setBounds(viewBounds)
      currentParent = target
      target.show()
      target.focus()
      guest.focus()
      durations.push(performance.now() - started)
      await sleep(16)
      return { ok: true }
    } catch (error) {
      if (removed) {
        source.contentView.addChildView(hostView)
        hostView.setBounds(viewBounds)
      }
      durations.push(performance.now() - started)
      return { ok: false, code: error.message, rolledBack: currentParent === source }
    }
  }

  for (let i = 0; i < ITERATIONS; i += 1) {
    const detached = await migrate(detachedWindow)
    if (!detached.ok) throw new Error(`detach ${i + 1} failed`)
    const embedded = await migrate(mainWindow)
    if (!embedded.ok) throw new Error(`attach ${i + 1} failed`)
  }

  const createFailure = await migrate(detachedWindow, 'target-create')
  const attachFailure = await migrate(detachedWindow, 'target-attach')

  detachedWindow.on('close', (event) => {
    if (closing) return
    event.preventDefault()
    void migrate(mainWindow).then((value) => { closeRecovered = value.ok })
  })
  await migrate(detachedWindow)
  detachedWindow.close()
  await waitFor(() => closeRecovered, 'close-to-attach recovery')

  guest.focus()
  await guest.executeJavaScript("document.querySelector('#probe-input').focus()", true)
  guest.sendInputEvent({ type: 'char', keyCode: 'K' })
  guest.sendInputEvent({ type: 'mouseDown', x: 50, y: 90, button: 'left', clickCount: 1 })
  guest.sendInputEvent({ type: 'mouseUp', x: 50, y: 90, button: 'left', clickCount: 1 })
  guest.sendInputEvent({ type: 'mouseWheel', x: 300, y: 200, deltaY: -120, canScroll: true })
  const overlayX = viewBounds.width - 60
  hostView.webContents.sendInputEvent({ type: 'mouseDown', x: overlayX, y: 30, button: 'left', clickCount: 1 })
  hostView.webContents.sendInputEvent({ type: 'mouseUp', x: overlayX, y: 30, button: 'left', clickCount: 1 })
  await guest.executeJavaScript('window.__poc.stop()', true)
  await sleep(250)

  const finalSnapshot = await snapshot()
  const finalIdentity = {
    hostWebContentsId: hostView.webContents.id,
    guestWebContentsId: guest.id,
    guestProcessId: guest.getOSProcessId(),
    sessionStoragePath: guest.session.storagePath,
    hostInstance: await hostView.webContents.executeJavaScript('window.__hostPoc.instance', true),
    overlayClicks: await hostView.webContents.executeJavaScript('window.__hostPoc.overlayClicks', true),
    ...finalSnapshot,
  }
  const received = [...apiResponses].sort((a, b) => a - b)
  const expected = Array.from({ length: finalSnapshot.requestSeq }, (_, index) => index + 1)
  const apiContinuous = received.length === expected.length && received.every((value, index) => value === expected[index])
  const assertions = {
    hostIdStable: identity.hostWebContentsId === finalIdentity.hostWebContentsId,
    guestIdStable: identity.guestWebContentsId === finalIdentity.guestWebContentsId,
    guestProcessStable: identity.guestProcessId === finalIdentity.guestProcessId,
    sessionStable: guest.session === initialSession && identity.sessionStoragePath === finalIdentity.sessionStoragePath,
    hostInstanceStable: identity.hostInstance === finalIdentity.hostInstance,
    guestInstanceStable: identity.instance === finalIdentity.instance,
    iframeInstanceStable: identity.iframeInstance === finalIdentity.iframeInstance,
    attachCountStable: counters.attach === initialCounters.attach && counters.attach === 1,
    noExtraHostNavigation: counters.hostMainNavigations === initialCounters.hostMainNavigations,
    noExtraGuestNavigation: counters.guestMainNavigations === initialCounters.guestMainNavigations,
    noExtraGuestDomReady: counters.guestDomReady === initialCounters.guestDomReady,
    guestNotDestroyed: counters.guestDestroyed === 0,
    productionPreloadInstalled: identity.preloadAudioHook && finalIdentity.preloadAudioHook,
    audioInstanceStable: identity.audioInstance === finalIdentity.audioInstance,
    audioAdvanced: finalIdentity.audioTime > identity.audioTime,
    apiContinuous,
    inputReceived: finalIdentity.inputEvents > identity.inputEvents && finalIdentity.inputValue.includes('K'),
    pointerReceived: finalIdentity.pointerEvents > identity.pointerEvents,
    wheelReceived: finalIdentity.wheelEvents > identity.wheelEvents,
    overlayHitAboveGuest: finalIdentity.overlayClicks === 1,
    underOneSecond: Math.max(...durations) < 1000,
    targetCreateFailurePreservedSource: !createFailure.ok && createFailure.rolledBack,
    targetAttachFailureRolledBack: !attachFailure.ok && attachFailure.rolledBack,
    closeReturnedToWorkbench: closeRecovered && currentParent === mainWindow,
  }
  const result = {
    timestamp: new Date().toISOString(),
    environment: {
      platform: process.platform,
      osRelease: os.release(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      displays: screen.getAllDisplays().map(({ bounds, workArea, scaleFactor }) => ({ bounds, workArea, scaleFactor })),
    },
    iterations: ITERATIONS,
    migrations: ITERATIONS * 2,
    initialCounters,
    finalCounters: counters,
    maxMigrationMs: Math.max(...durations),
    apiGenerated: finalSnapshot.requestSeq,
    apiObserved: received.length,
    identity,
    finalIdentity,
    assertions,
    automatedGatePassed: Object.values(assertions).every(Boolean),
    remainingManualMatrix: ['Windows 10', '125% DPI', '150% DPI', '200% DPI', 'mixed-DPI dual display'],
  }
  fs.writeFileSync(RESULT, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result, null, 2))
  closing = true
  hostView.webContents.close()
  mainWindow.destroy()
  detachedWindow.destroy()
  await closeServer()
  app.quit()
}).catch(async (error) => {
  console.error(error)
  try { await closeServer() } catch {}
  app.exit(1)
})
