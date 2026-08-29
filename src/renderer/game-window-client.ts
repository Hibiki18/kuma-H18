import type {
  GameCommand,
  GameCommandResult,
  GameOverlayEvent,
  GameWindowMode,
  GameWindowSnapshot,
  ModeSwitchResult,
} from '../shared/game-window'

const { ipcRenderer } = require('electron') as typeof import('electron')

let snapshot: GameWindowSnapshot = {
  phase: 'BOOTSTRAPPING',
  effectiveMode: 'embedded',
  configuredMode: 'embedded',
  hostWebContentsId: null,
  guestWebContentsId: null,
  requestId: 0,
  canRetry: false,
}
let seq = 0
let frame = 0
let initialized = false
let beforeDetachHook: (() => void) | undefined
const actionCallbacks = new Map<string, () => void>()
let workbenchOccluded: boolean | null = null

const gameAction = (label: string, action: () => void) => {
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  actionCallbacks.set(token, action)
  setTimeout(() => actionCallbacks.delete(token), 60_000)
  return { token, label }
}

const reportBounds = () => {
  frame = 0
  const area = document.querySelector<HTMLElement>('#game-area')
  if (!area || area.hidden) return
  const rect = area.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return
  ipcRenderer.send(
    'game-window:bounds',
    'embedded',
    { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    ++seq,
  )
}

export const scheduleEmbeddedGameBounds = () => {
  if (!frame) frame = requestAnimationFrame(reportBounds)
}

const renderState = (state: GameWindowSnapshot) => {
  snapshot = state
  const detached = state.effectiveMode === 'detached' && state.phase !== 'ATTACHING'
  const busy = state.phase === 'DETACHING' || state.phase === 'ATTACHING'
  const app = document.querySelector<HTMLElement>('#app')
  app?.classList.toggle('game-detached', detached)
  const modeButton = document.querySelector<HTMLButtonElement>('#btn-game-window')
  if (modeButton) {
    modeButton.textContent = detached ? '收回游戏' : '拆出游戏'
    modeButton.title = detached ? '把同一游戏会话收回工作台' : '把同一游戏会话移到独立窗口'
    modeButton.disabled = busy || state.phase === 'BOOTSTRAPPING' || state.phase === 'DISPOSING'
  }
  const locate = document.querySelector<HTMLButtonElement>('#btn-game-locate')
  if (locate) {
    locate.hidden = !detached
    locate.disabled = busy
  }
  const status = document.querySelector<HTMLElement>('#game-window-status')
  if (status) {
    status.textContent = state.error?.message ?? (detached ? '游戏在独立窗口' : '')
    status.hidden = !status.textContent
  }
  document.dispatchEvent(new CustomEvent('kanso:game-window-state', { detail: state }))
  if (!detached) scheduleEmbeddedGameBounds()
}

export const initGameWindowClient = (beforeDetach?: () => void) => {
  if (initialized) return
  initialized = true
  beforeDetachHook = beforeDetach
  const area = document.querySelector<HTMLElement>('#game-area')
  if (area) new ResizeObserver(scheduleEmbeddedGameBounds).observe(area)
  window.addEventListener('resize', scheduleEmbeddedGameBounds)
  const syncWorkbenchOcclusion = () => {
    const occluded = Boolean(
      document.querySelector('#kanso-welcome, #overlay-host.show, #startup-overlay.visible'),
    )
    if (occluded === workbenchOccluded) return
    workbenchOccluded = occluded
    ipcRenderer.send('game-window:occluded', occluded)
  }
  const watchedOccluders = new WeakSet<Element>()
  const occluderAttributes = new MutationObserver(syncWorkbenchOcclusion)
  const discoverOccluders = () => {
    for (const element of document.querySelectorAll('#overlay-host, #startup-overlay')) {
      if (watchedOccluders.has(element)) continue
      watchedOccluders.add(element)
      occluderAttributes.observe(element, { attributes: true, attributeFilter: ['class'] })
    }
    syncWorkbenchOcclusion()
  }
  new MutationObserver(discoverOccluders).observe(document.body, { childList: true })
  discoverOccluders()
  ipcRenderer.on('game-window:state', (_event, state: GameWindowSnapshot) => renderState(state))
  ipcRenderer.on('game-host:action', (_event, token: unknown) => {
    if (typeof token !== 'string') return
    const action = actionCallbacks.get(token)
    if (!action) return
    actionCallbacks.delete(token)
    action()
  })
  document.addEventListener('kanso:game-host-overlay', ((event: CustomEvent<GameOverlayEvent>) => {
    publishGameOverlay(event.detail)
  }) as EventListener)
  document.querySelector('#btn-game-window')?.addEventListener('click', () => {
    const target = snapshot.effectiveMode === 'detached' ? 'embedded' : 'detached'
    void setGameWindowMode(target)
  })
  document.querySelector('#btn-game-locate')?.addEventListener('click', () => {
    void ipcRenderer.invoke('game-window:locate')
  })
  void ipcRenderer.invoke('game-window:get-state').then((state: GameWindowSnapshot | null) => {
    if (state) renderState(state)
  })
  scheduleEmbeddedGameBounds()
}

export const getGameWindowSnapshot = () => snapshot

export const setGameWindowMode = async (mode: GameWindowMode): Promise<ModeSwitchResult> => {
  if (mode === 'detached' && snapshot.effectiveMode !== 'detached') beforeDetachHook?.()
  const result = await ipcRenderer.invoke('game-window:set-mode', mode) as ModeSwitchResult
  if (result?.snapshot) renderState(result.snapshot)
  return result
}

export const executeGameCommand = (command: GameCommand): Promise<GameCommandResult> =>
  ipcRenderer.invoke('game-window:command', command) as Promise<GameCommandResult>

export const publishGameOverlay = (event: GameOverlayEvent) => {
  ipcRenderer.send('game-host:overlay', event)
}

export const publishGameToast = (
  event: Omit<Extract<GameOverlayEvent, { kind: 'toast' }>, 'kind' | 'action'> & {
    actionLabel?: string
  },
  action?: () => void,
) => {
  let actionDto: { token: string; label: string } | undefined
  if (action && event.actionLabel) {
    actionDto = gameAction(event.actionLabel, action)
  }
  publishGameOverlay({
    kind: 'toast',
    id: event.id,
    severity: event.severity,
    title: event.title,
    detail: event.detail,
    locked: event.locked,
    groupKey: event.groupKey,
    durationMs: event.durationMs,
    action: actionDto,
  })
}

export const publishGameBanner = (
  event: Omit<Extract<GameOverlayEvent, { kind: 'banner' }>, 'kind' | 'go' | 'dismiss'> & {
    actionLabel: string
  },
  onGo: () => void,
  onDismiss: () => void,
) => {
  const go = gameAction(event.actionLabel, onGo)
  const dismissAction = gameAction('关闭', onDismiss)
  publishGameOverlay({
    kind: 'banner',
    id: event.id,
    tone: event.tone,
    icon: event.icon,
    title: event.title,
    detail: event.detail,
    order: event.order,
    go,
    dismiss: { token: dismissAction.token },
  })
}

export const removeGameBanner = (id: string) => publishGameOverlay({ kind: 'banner-remove', id })
export const clearGameBanners = () => publishGameOverlay({ kind: 'banner-clear' })
