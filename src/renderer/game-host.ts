import { createGameOverlayPresenter } from './game-overlay-presenter'
import type { GameOverlayEvent } from '../shared/game-window'

interface Bootstrap {
  homepage: string
  preload: string
  userAgent: string
}

interface HostBridge {
  bootstrap(): Promise<Bootstrap>
  ready(): void
  command(type: 'reload'): Promise<unknown>
  onOverlay(listener: (event: GameOverlayEvent) => void): void
  action(token: string): void
  releaseAction(token: string): void
  onRemount(listener: () => void): void
}

declare global {
  interface Window {
    kansoGameHost: HostBridge
  }
}

const wrapper = document.querySelector<HTMLElement>('#game-wrapper')!
const overlay = document.querySelector<HTMLElement>('#game-overlay')!
const overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!
const overlayDetail = document.querySelector<HTMLElement>('#overlay-detail')!
let webview: Electron.WebviewTag | null = null
let webviewReady = false
let bootstrap: Bootstrap
let zoomTimer: ReturnType<typeof setTimeout> | null = null

const applyZoom = () => {
  if (!webview || !webviewReady || wrapper.clientWidth <= 0) return
  const factor = Math.round((wrapper.clientWidth / 1200) * 100000) / 100000
  try {
    webview.setZoomFactor(factor)
    void webview.executeJavaScript('window.align && window.align()').catch(() => {})
  } catch {
    // Attachment can be between renderer lifecycle events while a window is moving.
  }
}

const scheduleZoom = () => {
  if (zoomTimer) clearTimeout(zoomTimer)
  zoomTimer = setTimeout(applyZoom, 120)
}

const hideError = () => overlay.classList.remove('visible')
const showError = (title: string, detail: string) => {
  overlayTitle.textContent = title
  overlayDetail.textContent = detail
  overlay.classList.add('visible')
}

const createGameView = () => {
  webviewReady = false
  const view = document.createElement('webview') as Electron.WebviewTag
  view.id = 'game-webview'
  view.setAttribute('allowpopups', '')
  view.setAttribute('nodeintegrationinsubframes', '')
  view.setAttribute('disablewebsecurity', '')
  view.setAttribute(
    'webpreferences',
    'allowRunningInsecureContent=no, backgroundThrottling=no, contextIsolation=yes, sandbox=no, nodeIntegrationInSubFrames=yes',
  )
  view.setAttribute('preload', bootstrap.preload)
  view.setAttribute('useragent', bootstrap.userAgent)
  view.src = bootstrap.homepage
  view.addEventListener('dom-ready', () => {
    webviewReady = true
    hideError()
    applyZoom()
  })
  view.addEventListener('did-fail-load', (event) => {
    if (event.isMainFrame && event.errorCode !== -3) {
      showError(
        '游戏页面加载失败',
        `${event.errorDescription} (${event.errorCode})\n${event.validatedURL}\n\n可在工作台“设置 · 代理”调整后重试。`,
      )
    }
  })
  wrapper.prepend(view)
  webview = view
}

const remount = () => {
  webview?.remove()
  createGameView()
}

document.querySelector('#btn-retry')!.addEventListener('click', () => {
  hideError()
  void window.kansoGameHost.command('reload')
})

void (async () => {
  bootstrap = await window.kansoGameHost.bootstrap()
  createGameView()
  new ResizeObserver(scheduleZoom).observe(wrapper)
  const present = createGameOverlayPresenter(
    document,
    (token) => window.kansoGameHost.action(token),
    (token) => window.kansoGameHost.releaseAction(token),
  )
  window.kansoGameHost.onOverlay(present)
  window.kansoGameHost.onRemount(remount)
  window.kansoGameHost.ready()
})().catch((error) => showError('游戏宿主启动失败', error instanceof Error ? error.message : String(error)))
