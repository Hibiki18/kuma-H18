import * as electronRemote from '@electron/remote/main'
import {
  BrowserWindow,
  ipcMain,
  screen,
  webContents,
  WebContentsView,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron'
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

import config from './config'
import { ROOT } from './env'
import { setKcsResourceGameWebContentsId } from './kcs-resource'
import { handleNewWindow, handleWebviewPreloadHack, stopFileNavigate } from './webcontent-utils'
import broadcaster = require('./game-api-broadcaster')
import {
  cssRectToViewBounds,
  isGameCommand,
  normalizeGameWindowMode,
  normalizeOverlayEvent,
  restoreWindowBounds,
  type GameCommand,
  type GameCommandResult,
  type GameHostPhase,
  type GameOverlayEvent,
  type GameWindowMode,
  type GameWindowSnapshot,
  type ModeSwitchResult,
  type RectLike,
  type SavedWindowBounds,
} from '../shared/game-window'

const TARGET_BOUNDS_TIMEOUT_MS = 3000
const sameRect = (left: RectLike | null, right: RectLike): boolean =>
  !!left && left.x === right.x && left.y === right.y &&
  left.width === right.width && left.height === right.height

export class GameHostManager {
  private hostView: WebContentsView | null = null
  private detachedWindow: BrowserWindow | null = null
  private guestWebContentsId: number | null = null
  private phase: GameHostPhase = 'BOOTSTRAPPING'
  private effectiveMode: GameWindowMode = 'embedded'
  private configuredMode: GameWindowMode
  private requestId = 0
  private error: GameWindowSnapshot['error']
  private embeddedBounds: RectLike | null = null
  private detachedBounds: RectLike | null = null
  private boundsSeq = { embedded: 0, detached: 0 }
  private boundsWaiters = new Set<(error?: Error) => void>()
  private closingDetachedForAttach = false
  private previewDucking = false
  private workbenchOccluded = false
  private disposed = false
  private ipcInstalled = false
  private saveDetachedTimer: ReturnType<typeof setTimeout> | null = null
  private overlayWindowStartedAt = 0
  private overlayWindowCount = 0
  private hostReady = false
  private readonly pendingOverlays: GameOverlayEvent[] = []
  private readonly actionTokens = new Map<string, number | null>()
  private readonly bannerActionTokens = new Map<string, string[]>()

  constructor(
    private readonly mainWindow: BrowserWindow,
    private readonly appIcon: string,
  ) {
    this.configuredMode = normalizeGameWindowMode(config.get('kanso.gameWindow.mode', 'embedded'))
  }

  get gameWindow(): BrowserWindow | null {
    return this.detachedWindow && !this.detachedWindow.isDestroyed() ? this.detachedWindow : null
  }

  getSnapshot = (): GameWindowSnapshot => ({
    phase: this.phase,
    effectiveMode: this.effectiveMode,
    configuredMode: this.configuredMode,
    hostWebContentsId: this.hostView?.webContents.id ?? null,
    guestWebContentsId: this.guestWebContentsId,
    requestId: this.requestId,
    canRetry:
      this.phase === 'RECOVERING' &&
      !!this.hostView &&
      !this.hostView.webContents.isDestroyed() &&
      !this.hostView.webContents.isCrashed(),
    ...(this.error ? { error: this.error } : {}),
  })

  start = async (): Promise<void> => {
    this.installIpc()
    const trustedHostPreload = path.join(__dirname, 'game-host-preload.js')
    const view = new WebContentsView({
      webPreferences: {
        preload: trustedHostPreload,
        nodeIntegration: false,
        contextIsolation: true,
        webviewTag: true,
        backgroundThrottling: false,
        spellcheck: false,
      },
    })
    this.hostView = view
    this.installHostSecurity(view)
    this.mainWindow.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    await view.webContents.loadFile(path.join(ROOT, 'dist', 'renderer', 'game-host.html'))
    this.phase = 'EMBEDDED'
    this.broadcastState()
    if (this.configuredMode === 'detached') {
      const result = await this.requestMode('detached', false)
      if (!result.ok) {
        this.error = {
          code: result.code ?? 'STARTUP_DETACH_FAILED',
          message: result.message ?? '独立游戏窗口恢复失败，已暂时回到工作台。',
        }
        this.broadcastState()
      }
    }
  }

  setPreviewDucking = (active: boolean) => {
    this.previewDucking = active
    const guest = this.getGuest()
    if (guest) guest.send('kanso:preview-audio-duck', active)
  }

  locateGameWindow = () => {
    const win = this.gameWindow
    if (!win) return
    this.ensureDetachedVisible()
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
  }

  restoreWindows = () => {
    if (this.mainWindow.isMinimized()) this.mainWindow.restore()
    if (!this.mainWindow.isVisible()) this.mainWindow.show()
    if (this.effectiveMode === 'detached') this.ensureDetachedVisible()
    this.mainWindow.focus()
  }

  requestMode = async (mode: GameWindowMode, persist = true): Promise<ModeSwitchResult> => {
    if (this.disposed || this.phase === 'DISPOSING') {
      return this.switchFailure('DISPOSING', '应用正在退出。')
    }
    if (mode !== 'embedded' && mode !== 'detached') {
      return this.switchFailure('INVALID_MODE', '未知的游戏窗口模式。')
    }
    if (this.phase === 'RECOVERING') return this.recoverToMode(mode, persist)
    if (
      (this.phase === 'EMBEDDED' && mode === 'embedded') ||
      (this.phase === 'DETACHED' && mode === 'detached')
    ) {
      return { ok: true, snapshot: this.getSnapshot() }
    }
    if (this.phase !== 'EMBEDDED' && this.phase !== 'DETACHED') {
      return this.switchFailure('BUSY', '游戏窗口正在切换，请稍候。')
    }
    if (!this.hostView || this.hostView.webContents.isDestroyed()) {
      return this.switchFailure('HOST_OR_GUEST_DESTROYED', '游戏宿主已不可用。')
    }

    const sourceMode = this.effectiveMode
    const transition: GameHostPhase = mode === 'detached' ? 'DETACHING' : 'ATTACHING'
    const stable: GameHostPhase = mode === 'detached' ? 'DETACHED' : 'EMBEDDED'
    this.phase = transition
    this.error = undefined
    this.requestId += 1
    const requestId = this.requestId
    this.broadcastState()
    const started = Date.now()
    let removedSource = false
    let attachedTarget = false
    let targetWindow: BrowserWindow | null = null

    try {
      if (mode === 'detached') {
        try {
          await this.ensureDetachedWindow()
        } catch (error) {
          if (error instanceof Error && error.message === 'TARGET_BOUNDS_TIMEOUT') throw error
          throw new Error('TARGET_WINDOW_CREATE_FAILED')
        }
      }
      else {
        this.restoreWindows()
        await this.waitForBounds('embedded')
      }
      if (this.disposed) throw new Error('DISPOSING')
      targetWindow = mode === 'detached' ? this.gameWindow : this.mainWindow
      const targetBounds = mode === 'detached' ? this.detachedBounds : this.embeddedBounds
      if (!targetWindow || targetWindow.isDestroyed()) throw new Error('TARGET_WINDOW_CREATE_FAILED')
      if (!targetBounds) throw new Error('TARGET_BOUNDS_TIMEOUT')

      const sourceWindow = sourceMode === 'embedded' ? this.mainWindow : this.gameWindow
      if (!sourceWindow || sourceWindow.isDestroyed()) throw new Error('REMOVE_SOURCE_FAILED')
      try {
        sourceWindow.contentView.removeChildView(this.hostView)
      } catch {
        throw new Error('REMOVE_SOURCE_FAILED')
      }
      removedSource = true
      try {
        targetWindow.contentView.addChildView(this.hostView)
        attachedTarget = true
        this.hostView.setBounds(this.presentedBounds(mode, targetBounds))
      } catch {
        throw new Error('ATTACH_TARGET_FAILED')
      }
      this.effectiveMode = mode
      this.phase = stable
      if (persist) {
        config.set('kanso.gameWindow.mode', mode)
        this.configuredMode = mode
      }
      this.finishCommittedMode(mode, targetWindow)
      console.log(
        `[kanso] game-window ${sourceMode} -> ${mode} request=${requestId}` +
          ` host=${this.hostView.webContents.id} guest=${this.guestWebContentsId ?? 'pending'}` +
          ` bounds=${JSON.stringify(targetBounds)} ${Date.now() - started}ms`,
      )
      this.broadcastState()
      return { ok: true, snapshot: this.getSnapshot() }
    } catch (error) {
      if (this.disposed) return this.switchFailure('DISPOSING', '应用正在退出。')
      const code = error instanceof Error ? error.message : 'ATTACH_TARGET_FAILED'
      const rollbackWindow = sourceMode === 'embedded' ? this.mainWindow : this.gameWindow
      const rollbackBounds = sourceMode === 'embedded' ? this.embeddedBounds : this.detachedBounds
      try {
        if (removedSource) {
          if (!rollbackWindow || rollbackWindow.isDestroyed() || !rollbackBounds) {
            throw new Error('ROLLBACK_SOURCE_UNAVAILABLE')
          }
          if (attachedTarget && targetWindow && !targetWindow.isDestroyed()) {
            targetWindow.contentView.removeChildView(this.hostView)
          }
          rollbackWindow.contentView.addChildView(this.hostView)
          this.hostView.setBounds(this.presentedBounds(sourceMode, rollbackBounds))
        }
        this.effectiveMode = sourceMode
        this.phase = sourceMode === 'embedded' ? 'EMBEDDED' : 'DETACHED'
        this.error = { code, message: this.messageForCode(code) }
        if (sourceMode === 'embedded' && this.detachedWindow) {
          this.closingDetachedForAttach = true
          this.detachedWindow.close()
          this.closingDetachedForAttach = false
          this.detachedWindow = null
        }
      } catch (rollbackError) {
        this.phase = 'RECOVERING'
        this.error = {
          code: 'ROLLBACK_FAILED',
          message: `游戏窗口切换与回滚均失败：${String(rollbackError)}`,
        }
      }
      console.warn(`[kanso] game-window switch failed request=${requestId}`, error)
      this.broadcastState()
      return this.switchFailure(this.error?.code ?? code, this.error?.message ?? this.messageForCode(code))
    }
  }

  execute = async (command: GameCommand): Promise<GameCommandResult> => {
    if (!isGameCommand(command) || this.phase === 'DISPOSING') {
      return { ok: false, message: '游戏控制命令无效或当前不可用。' }
    }
    const guest = this.getGuest()
    if (!guest) return { ok: false, message: '游戏页面尚未就绪。' }
    try {
      if (command.type === 'reload') {
        guest.reload()
        return { ok: true }
      }
      if (command.type === 'audio-stats') {
        const value = await guest.executeJavaScript(
          'window.kansoGameAudioStats ? window.kansoGameAudioStats() : null',
          true,
        )
        return { ok: true, value }
      }
      if (command.type === 'capture') {
        const dataUrl = await guest.executeJavaScript('window.capture && window.capture()', true)
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
          return { ok: false, message: '没有找到可截图的游戏画布。' }
        }
        const screenshotPath = global.DEFAULT_SCREENSHOT_PATH as string
        fs.mkdirSync(screenshotPath, { recursive: true })
        const file = path.join(screenshotPath, `kanso-${Date.now()}.png`)
        fs.writeFileSync(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
        console.log('[kanso] screenshot saved:', file)
        return { ok: true, value: file }
      }
      this.locateCurrentParent()
      guest.focus()
      return { ok: true }
    } catch (error) {
      console.warn('[kanso] game command failed', command.type, error)
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  dispose = () => {
    if (this.disposed) return
    this.disposed = true
    screen.removeListener('display-removed', this.ensureDetachedVisible)
    screen.removeListener('display-metrics-changed', this.ensureDetachedVisible)
    this.phase = 'DISPOSING'
    this.broadcastState()
    this.uninstallIpc()
    for (const wake of this.boundsWaiters) wake(new Error('DISPOSING'))
    this.boundsWaiters.clear()
    if (this.saveDetachedTimer) clearTimeout(this.saveDetachedTimer)
    this.hostReady = false
    this.pendingOverlays.length = 0
    this.actionTokens.clear()
    this.bannerActionTokens.clear()
    this.saveDetachedWindowBounds()
    const view = this.hostView
    const guest = this.getGuest()
    try {
      if (view) {
        const parent = this.effectiveMode === 'detached' ? this.gameWindow : this.mainWindow
        if (parent && !parent.isDestroyed()) parent.contentView.removeChildView(view)
      }
    } catch (error) {
      console.warn('[kanso] failed to remove game host while disposing', error)
    }
    this.guestWebContentsId = null
    setKcsResourceGameWebContentsId(null)
    broadcaster.setGameWebContentsId(null)
    try {
      if (guest && !guest.isDestroyed()) guest.close()
    } catch {}
    try {
      if (view && !view.webContents.isDestroyed()) view.webContents.close()
    } catch {}
    this.hostView = null
    try {
      this.closingDetachedForAttach = true
      if (this.detachedWindow && !this.detachedWindow.isDestroyed()) this.detachedWindow.close()
    } catch {}
    this.detachedWindow = null
  }

  private installHostSecurity(view: WebContentsView) {
    const trustedWebviewPreload = path.join(ROOT, 'assets', 'preload', 'webview-preload.js')
    view.webContents.on('will-attach-webview', (event, preferences, params) => {
      const current = this.getGuest()
      let preloadMatches = false
      let sourceMatches = false
      try {
        const preload = params.preload?.startsWith('file:') ? fileURLToPath(params.preload) : params.preload
        preloadMatches =
          typeof preload === 'string' &&
          path.resolve(preload).toLowerCase() === path.resolve(trustedWebviewPreload).toLowerCase()
      } catch {}
      try {
        sourceMatches = new URL(params.src).href === new URL(String(config.get('kanso.homepage'))).href
      } catch {}
      if ((current && !current.isCrashed()) || !preloadMatches || !sourceMatches) {
        event.preventDefault()
        console.warn('[kanso] rejected unexpected game webview attachment')
        return
      }
      preferences.preload = trustedWebviewPreload
      preferences.nodeIntegration = false
      preferences.nodeIntegrationInSubFrames = true
      preferences.nodeIntegrationInWorker = false
      preferences.contextIsolation = true
      preferences.sandbox = false
      preferences.webSecurity = false
      preferences.allowRunningInsecureContent = false
      preferences.webviewTag = false
    })
    view.webContents.on('did-attach-webview', (_event, guest) => {
      const current = this.getGuest()
      if (current && current.id !== guest.id && !current.isCrashed()) {
        guest.close()
        return
      }
      this.guestWebContentsId = guest.id
      setKcsResourceGameWebContentsId(guest.id)
      broadcaster.setGameWebContentsId(guest.id)
      electronRemote.enable(guest)
      stopFileNavigate(guest.id)
      handleNewWindow(guest.id)
      if (this.previewDucking) guest.send('kanso:preview-audio-duck', true)
      guest.once('destroyed', () => {
        if (this.guestWebContentsId === guest.id) this.clearGuestId()
      })
      guest.once('render-process-gone', (_goneEvent, details) => {
        if (this.disposed || this.guestWebContentsId !== guest.id) return
        console.warn('[kanso] game guest renderer gone', details.reason, details.exitCode)
        this.phase = 'RECOVERING'
        this.error = { code: 'GAME_GUEST_CRASHED', message: '游戏页面崩溃，正在原位恢复。' }
        this.broadcastState()
        guest.once('destroyed', () => {
          if (this.disposed || view.webContents.isDestroyed()) return
          view.webContents.send('game-host:remount')
        })
        try {
          guest.close()
        } catch (closeError) {
          this.error = {
            code: 'GAME_GUEST_DESTROY_FAILED',
            message: `游戏页面崩溃且无法安全销毁，请重启 kuma：${String(closeError)}`,
          }
          this.broadcastState()
        }
      })
      const guestRecovery =
        this.error?.code === 'GAME_GUEST_CRASHED' || this.error?.code === 'GAME_GUEST_DESTROY_FAILED'
      if (this.phase === 'RECOVERING' && guestRecovery) {
        this.phase = this.effectiveMode === 'detached' ? 'DETACHED' : 'EMBEDDED'
        this.error = undefined
      }
      this.broadcastState()
    })
    view.webContents.on('render-process-gone', (_event, details) => {
      if (this.disposed) return
      this.hostReady = false
      console.warn('[kanso] game host renderer gone', details.reason, details.exitCode)
      this.phase = 'RECOVERING'
      this.error = { code: 'GAME_HOST_CRASHED', message: '游戏宿主已崩溃，请重启 kuma 以恢复。' }
      this.broadcastState()
    })
    view.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame) this.hostReady = false
    })
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('will-navigate', (event, url) => {
      if (url !== view.webContents.getURL()) event.preventDefault()
    })
    handleWebviewPreloadHack(view.webContents.id)
  }

  private async recoverToMode(mode: GameWindowMode, persist: boolean): Promise<ModeSwitchResult> {
    const view = this.hostView
    if (!view || view.webContents.isDestroyed() || view.webContents.isCrashed()) {
      return this.switchFailure('HOST_OR_GUEST_DESTROYED', '游戏宿主已不可用，请重启 kuma 恢复。')
    }
    this.phase = mode === 'detached' ? 'DETACHING' : 'ATTACHING'
    this.error = undefined
    this.requestId += 1
    const requestId = this.requestId
    this.broadcastState()
    try {
      if (mode === 'detached') {
        try {
          await this.ensureDetachedWindow()
        } catch (error) {
          if (error instanceof Error && error.message === 'TARGET_BOUNDS_TIMEOUT') throw error
          throw new Error('TARGET_WINDOW_CREATE_FAILED')
        }
      } else {
        this.restoreWindows()
        await this.waitForBounds('embedded')
      }
      if (this.disposed) throw new Error('DISPOSING')
      const targetWindow = mode === 'detached' ? this.gameWindow : this.mainWindow
      const targetBounds = mode === 'detached' ? this.detachedBounds : this.embeddedBounds
      if (!targetWindow || targetWindow.isDestroyed()) throw new Error('TARGET_WINDOW_CREATE_FAILED')
      if (!targetBounds) throw new Error('TARGET_BOUNDS_TIMEOUT')

      for (const parent of [this.mainWindow, this.gameWindow]) {
        if (!parent || parent.isDestroyed() || !parent.contentView.children.includes(view)) continue
        parent.contentView.removeChildView(view)
      }
      try {
        targetWindow.contentView.addChildView(view)
        view.setBounds(this.presentedBounds(mode, targetBounds))
      } catch {
        throw new Error('ATTACH_TARGET_FAILED')
      }
      if (persist) {
        config.set('kanso.gameWindow.mode', mode)
        this.configuredMode = mode
      }
      this.effectiveMode = mode
      this.phase = mode === 'detached' ? 'DETACHED' : 'EMBEDDED'
      this.finishCommittedMode(mode, targetWindow)
      console.log(
        `[kanso] game-window recovered -> ${mode} request=${requestId}` +
          ` host=${view.webContents.id} guest=${this.guestWebContentsId ?? 'pending'}` +
          ` bounds=${JSON.stringify(targetBounds)}`,
      )
      this.broadcastState()
      return { ok: true, snapshot: this.getSnapshot() }
    } catch (error) {
      if (this.disposed) return this.switchFailure('DISPOSING', '应用正在退出。')
      const code = error instanceof Error ? error.message : 'ATTACH_TARGET_FAILED'
      this.phase = 'RECOVERING'
      this.error = { code, message: this.messageForCode(code) }
      this.broadcastState()
      return this.switchFailure(code, this.error.message)
    }
  }

  private finishCommittedMode(mode: GameWindowMode, targetWindow: BrowserWindow) {
    if (mode === 'detached') {
      try {
        targetWindow.show()
        targetWindow.focus()
      } catch (windowError) {
        console.warn('[kanso] game window attached but could not be focused', windowError)
      }
      return
    }
    const shell = this.detachedWindow
    this.closingDetachedForAttach = true
    try {
      shell?.close()
    } catch (windowError) {
      console.warn('[kanso] game window shell did not close after attach', windowError)
      try {
        shell?.destroy()
      } catch (destroyError) {
        console.warn('[kanso] game window shell could not be destroyed', destroyError)
      }
    } finally {
      this.closingDetachedForAttach = false
    }
    if (!shell || shell.isDestroyed()) this.detachedWindow = null
    try {
      this.mainWindow.show()
      this.mainWindow.focus()
    } catch (windowError) {
      console.warn('[kanso] workbench attached but could not be focused', windowError)
    }
  }

  private installIpc() {
    if (this.ipcInstalled) return
    this.ipcInstalled = true
    ipcMain.handle('game-window:get-state', (event) =>
      this.isWorkbench(event) || this.isDetachedShell(event) ? this.getSnapshot() : null,
    )
    ipcMain.handle('game-window:set-mode', (event, rawMode: unknown) => {
      if (rawMode !== 'embedded' && rawMode !== 'detached') {
        return this.switchFailure('INVALID_MODE', '未知的游戏窗口模式。')
      }
      const mode = rawMode
      if (!this.isWorkbench(event) && !(this.isDetachedShell(event) && mode === 'embedded')) {
        return this.switchFailure('FORBIDDEN', '当前窗口无权切换游戏窗口模式。')
      }
      return this.requestMode(mode)
    })
    ipcMain.handle('game-window:locate', (event) => {
      if (!this.isWorkbench(event)) return false
      this.locateGameWindow()
      return true
    })
    ipcMain.handle('game-window:command', (event, command: unknown) => {
      if (!this.isAllowedCommandSender(event) || !isGameCommand(command)) {
        return { ok: false, message: '游戏控制命令被拒绝。' }
      }
      return this.execute(command)
    })
    ipcMain.on('game-window:bounds', (event, surface: unknown, rect: unknown, seq: unknown) => {
      if (surface !== 'embedded' && surface !== 'detached') return
      if (surface === 'embedded' ? !this.isWorkbench(event) : !this.isDetachedShell(event)) return
      const sequence = Number(seq)
      if (!Number.isInteger(sequence) || sequence <= this.boundsSeq[surface]) return
      const win = surface === 'embedded' ? this.mainWindow : this.gameWindow
      if (!win || win.isDestroyed()) return
      const content = win.getContentBounds()
      const bounds = cssRectToViewBounds(rect, win.webContents.getZoomFactor(), content)
      if (!bounds) return
      this.boundsSeq[surface] = sequence
      const previous = surface === 'embedded' ? this.embeddedBounds : this.detachedBounds
      if (sameRect(previous, bounds)) {
        for (const wake of this.boundsWaiters) wake()
        return
      }
      if (surface === 'embedded') this.embeddedBounds = bounds
      else this.detachedBounds = bounds
      if (this.effectiveMode === surface && this.hostView) {
        this.hostView.setBounds(this.presentedBounds(surface, bounds))
      }
      for (const wake of this.boundsWaiters) wake()
    })
    ipcMain.on('game-window:occluded', (event, value: unknown) => {
      if (!this.isWorkbench(event) || typeof value !== 'boolean') return
      this.workbenchOccluded = value
      if (this.effectiveMode !== 'embedded' || !this.hostView || !this.embeddedBounds) return
      this.hostView.setBounds(this.presentedBounds('embedded', this.embeddedBounds))
    })
    ipcMain.handle('game-host:get-bootstrap', (event) => {
      if (!this.isHost(event)) return null
      return {
        homepage: String(config.get('kanso.homepage')),
        preload: pathToFileURL(path.join(ROOT, 'assets', 'preload', 'webview-preload.js')).href,
        userAgent: this.mainWindow.webContents.userAgent
          .replace(/Electron[^ ]* /, '')
          .replace(/kanso[^ ]* /, ''),
      }
    })
    ipcMain.on('game-host:ready', (event) => {
      if (!this.isHost(event)) return
      this.hostReady = true
      for (const overlay of this.pendingOverlays.splice(0)) {
        this.hostView?.webContents.send('game-host:overlay', overlay)
      }
      this.broadcastState()
    })
    ipcMain.on('game-host:overlay', (event, raw: unknown) => {
      if (!this.isWorkbench(event) || !this.hostView || this.hostView.webContents.isDestroyed()) return
      if (!this.acceptOverlayNow()) return
      const overlay = normalizeOverlayEvent(raw)
      if (!overlay) return
      this.pruneActionTokens()
      if (overlay.kind === 'banner') {
        this.releaseBannerActionTokens(overlay.id)
        const tokens = [overlay.go.token, overlay.dismiss.token]
        for (const token of tokens) this.actionTokens.set(token, null)
        this.bannerActionTokens.set(overlay.id, tokens)
      } else if (overlay.kind === 'banner-remove') {
        this.releaseBannerActionTokens(overlay.id)
      } else if (overlay.kind === 'banner-clear') {
        for (const id of [...this.bannerActionTokens.keys()]) this.releaseBannerActionTokens(id)
      } else if (overlay.kind === 'toast') {
        const expiresAt = overlay.locked
          ? null
          : Date.now() + (overlay.durationMs ?? 8000) + 5000
        for (const action of [overlay.action, overlay.groupAction]) {
          if (action) this.actionTokens.set(action.token, expiresAt)
        }
      }
      if (this.hostReady) this.hostView.webContents.send('game-host:overlay', overlay)
      else {
        this.pendingOverlays.push(overlay)
        if (this.pendingOverlays.length > 128) this.pendingOverlays.shift()
      }
    })
    ipcMain.on('game-host:action', (event, token: unknown) => {
      if (!this.isHost(event) || typeof token !== 'string' || token.length > 100) return
      this.pruneActionTokens()
      if (!this.actionTokens.delete(token)) return
      if (!this.mainWindow.isDestroyed()) this.mainWindow.webContents.send('game-host:action', token)
    })
    ipcMain.on('game-host:release-action', (event, token: unknown) => {
      if (!this.isHost(event) || typeof token !== 'string' || token.length > 100) return
      if (!this.actionTokens.delete(token)) return
      if (!this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('game-host:release-action', token)
      }
    })
    this.mainWindow.webContents.on('did-navigate', () => {
      this.boundsSeq.embedded = 0
      this.embeddedBounds = null
    })
    screen.on('display-removed', this.ensureDetachedVisible)
    screen.on('display-metrics-changed', this.ensureDetachedVisible)
  }

  private uninstallIpc() {
    if (!this.ipcInstalled) return
    this.ipcInstalled = false
    for (const channel of [
      'game-window:get-state',
      'game-window:set-mode',
      'game-window:locate',
      'game-window:command',
      'game-host:get-bootstrap',
    ]) {
      ipcMain.removeHandler(channel)
    }
    for (const channel of [
      'game-window:bounds',
      'game-window:occluded',
      'game-host:ready',
      'game-host:overlay',
      'game-host:action',
      'game-host:release-action',
    ]) {
      ipcMain.removeAllListeners(channel)
    }
  }

  private async ensureDetachedWindow(): Promise<void> {
    if (this.gameWindow) {
      await this.waitForBounds('detached')
      return
    }
    const primary = screen.getPrimaryDisplay().workArea
    const saved = config.get('kanso.gameWindow.bounds', {}) as SavedWindowBounds
    const restored = restoreWindowBounds(saved, screen.getAllDisplays().map((d) => d.workArea), primary)
    // The shell renderer starts its sequence at one. A closed shell's last bounds
    // must not make the replacement shell look stale or ready before its DOM exists.
    this.detachedBounds = null
    this.boundsSeq.detached = 0
    const win = new BrowserWindow({
      ...restored,
      minWidth: 720,
      minHeight: 480,
      title: 'kuma · 游戏',
      icon: this.appIcon,
      backgroundColor: '#050708',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'game-window-preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
        spellcheck: false,
      },
    })
    this.detachedWindow = win
    win.setMenu(null)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.webContents.on('did-navigate', () => {
      this.boundsSeq.detached = 0
      this.detachedBounds = null
    })
    win.on('close', (event) => {
      this.saveDetachedWindowBounds()
      if (!this.disposed && !this.closingDetachedForAttach) {
        event.preventDefault()
        void this.requestMode('embedded')
      }
    })
    win.on('move', this.scheduleDetachedBoundsSave)
    win.on('resize', this.scheduleDetachedBoundsSave)
    win.on('closed', () => {
      if (this.detachedWindow === win) this.detachedWindow = null
    })
    await win.loadFile(path.join(ROOT, 'dist', 'renderer', 'game-window.html'))
    if (restored.isMaximized) win.maximize()
    await this.waitForBounds('detached')
  }

  private waitForBounds(surface: GameWindowMode): Promise<void> {
    const present = surface === 'embedded' ? this.embeddedBounds : this.detachedBounds
    if (present) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const done = (error?: Error) => {
        if (error) {
          clearTimeout(timer)
          this.boundsWaiters.delete(done)
          reject(error)
          return
        }
        const value = surface === 'embedded' ? this.embeddedBounds : this.detachedBounds
        if (!value) return
        clearTimeout(timer)
        this.boundsWaiters.delete(done)
        resolve()
      }
      const timer = setTimeout(() => {
        this.boundsWaiters.delete(done)
        reject(new Error('TARGET_BOUNDS_TIMEOUT'))
      }, TARGET_BOUNDS_TIMEOUT_MS)
      this.boundsWaiters.add(done)
    })
  }

  private presentedBounds(surface: GameWindowMode, bounds: RectLike): RectLike {
    return surface === 'embedded' && this.workbenchOccluded
      ? { x: 0, y: 0, width: 0, height: 0 }
      : bounds
  }

  private broadcastState() {
    const snapshot = this.getSnapshot()
    if (!this.mainWindow.isDestroyed()) this.mainWindow.webContents.send('game-window:state', snapshot)
    if (this.gameWindow) this.gameWindow.webContents.send('game-window:state', snapshot)
  }

  private getGuest() {
    if (this.guestWebContentsId == null) return null
    const guest = webContents.fromId(this.guestWebContentsId)
    return guest && !guest.isDestroyed() ? guest : null
  }

  private clearGuestId() {
    this.guestWebContentsId = null
    setKcsResourceGameWebContentsId(null)
    broadcaster.setGameWebContentsId(null)
  }

  private locateCurrentParent() {
    if (this.effectiveMode === 'detached') this.locateGameWindow()
    else {
      if (this.mainWindow.isMinimized()) this.mainWindow.restore()
      this.mainWindow.show()
      this.mainWindow.focus()
    }
  }

  private isMainFrame(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return !event.senderFrame || event.senderFrame.parent == null
  }

  private isWorkbench(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return this.isMainFrame(event) && event.sender.id === this.mainWindow.webContents.id
  }

  private isDetachedShell(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return this.isMainFrame(event) && !!this.gameWindow && event.sender.id === this.gameWindow.webContents.id
  }

  private isHost(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return this.isMainFrame(event) && !!this.hostView && event.sender.id === this.hostView.webContents.id
  }

  private isAllowedCommandSender(event: IpcMainInvokeEvent): boolean {
    return this.isWorkbench(event) || this.isDetachedShell(event) || this.isHost(event)
  }

  private switchFailure(code: string, message: string): ModeSwitchResult {
    return { ok: false, code, message, snapshot: this.getSnapshot() }
  }

  private messageForCode(code: string): string {
    const messages: Record<string, string> = {
      TARGET_WINDOW_CREATE_FAILED: '无法创建独立游戏窗口。',
      TARGET_BOUNDS_TIMEOUT: '目标窗口没有及时准备好可用区域。',
      REMOVE_SOURCE_FAILED: '无法从原窗口移出游戏画面。',
      ATTACH_TARGET_FAILED: '无法把游戏画面放入目标窗口。',
      ROLLBACK_SOURCE_UNAVAILABLE: '原游戏窗口已不可用，无法完成自动回滚。',
      HOST_OR_GUEST_DESTROYED: '游戏宿主已不可用。',
    }
    return messages[code] ?? `游戏窗口切换失败：${code}`
  }

  private scheduleDetachedBoundsSave = () => {
    if (this.saveDetachedTimer) clearTimeout(this.saveDetachedTimer)
    this.saveDetachedTimer = setTimeout(this.saveDetachedWindowBounds, 250)
  }

  private saveDetachedWindowBounds = () => {
    const win = this.gameWindow
    if (!win) return
    config.set('kanso.gameWindow.bounds', {
      ...win.getNormalBounds(),
      isMaximized: win.isMaximized(),
    })
  }

  private acceptOverlayNow(): boolean {
    const now = Date.now()
    if (now - this.overlayWindowStartedAt >= 1000) {
      this.overlayWindowStartedAt = now
      this.overlayWindowCount = 0
    }
    this.overlayWindowCount += 1
    return this.overlayWindowCount <= 120
  }

  private pruneActionTokens() {
    const now = Date.now()
    for (const [token, expiresAt] of this.actionTokens) {
      if (expiresAt != null && expiresAt <= now) this.actionTokens.delete(token)
    }
  }

  private releaseBannerActionTokens(id: string) {
    for (const token of this.bannerActionTokens.get(id) ?? []) this.actionTokens.delete(token)
    this.bannerActionTokens.delete(id)
  }

  private ensureDetachedVisible = () => {
    const win = this.gameWindow
    if (!win) return
    const current = win.getBounds()
    const visible = screen.getAllDisplays().some((display) => {
      const area = display.workArea
      return current.x < area.x + area.width && current.x + current.width > area.x &&
        current.y < area.y + area.height && current.y + current.height > area.y
    })
    if (visible) return
    const restored = restoreWindowBounds(current, [], screen.getPrimaryDisplay().workArea)
    win.setBounds(restored)
  }
}
