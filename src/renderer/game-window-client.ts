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
interface ActionCallback {
  run: () => void
  timer?: ReturnType<typeof setTimeout>
}
const actionCallbacks = new Map<string, ActionCallback>()
const bannerActionTokens = new Map<string, string[]>()
let workbenchOccluded: boolean | null = null

const releaseAction = (token: string) => {
  const entry = actionCallbacks.get(token)
  if (entry?.timer) clearTimeout(entry.timer)
  actionCallbacks.delete(token)
}

const gameAction = (label: string, action: () => void, ttlMs?: number) => {
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const entry: ActionCallback = { run: action }
  if (ttlMs != null) entry.timer = setTimeout(() => releaseAction(token), ttlMs)
  actionCallbacks.set(token, entry)
  return { token, label }
}

const releaseBannerActions = (id: string) => {
  for (const token of bannerActionTokens.get(id) ?? []) releaseAction(token)
  bannerActionTokens.delete(id)
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
      document.querySelector(
        '#kanso-welcome, #overlay-host.show, #startup-overlay.visible, #drag-overlay, ' +
          '#kanso-command-palette.open, #cg-lightbox.show, .senka-detail-host, ' +
          '#crash-panel:not([hidden])',
      ),
    )
    if (occluded === workbenchOccluded) return
    workbenchOccluded = occluded
    ipcRenderer.send('game-window:occluded', occluded)
  }
  const watchedOccluders = new WeakSet<Element>()
  const occluderAttributes = new MutationObserver(syncWorkbenchOcclusion)
  const discoverOccluders = () => {
    for (const element of document.querySelectorAll(
      '#overlay-host, #startup-overlay, #kanso-command-palette, #cg-lightbox, #crash-panel',
    )) {
      if (watchedOccluders.has(element)) continue
      watchedOccluders.add(element)
      occluderAttributes.observe(element, { attributes: true, attributeFilter: ['class', 'hidden'] })
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
    releaseAction(token)
    action.run()
  })
  ipcRenderer.on('game-host:release-action', (_event, token: unknown) => {
    if (typeof token === 'string') releaseAction(token)
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
  event: Omit<Extract<GameOverlayEvent, { kind: 'toast' }>, 'kind' | 'action' | 'groupAction'> & {
    actionLabel?: string
    groupActionLabel?: string
  },
  action?: () => void,
  groupAction?: () => void,
) => {
  let actionDto: { token: string; label: string } | undefined
  let groupActionDto: { token: string; label: string } | undefined
  const ttlMs = event.locked ? undefined : (event.durationMs ?? 8000) + 5000
  if (action && event.actionLabel) {
    actionDto = gameAction(event.actionLabel, action, ttlMs)
  }
  if (groupAction && event.groupActionLabel) {
    groupActionDto = gameAction(event.groupActionLabel, groupAction, ttlMs)
  }
  publishGameOverlay({
    kind: 'toast',
    id: event.id,
    severity: event.severity,
    title: event.title,
    detail: event.detail,
    locked: event.locked,
    corner: event.corner,
    groupKey: event.groupKey,
    groupTitle: event.groupTitle,
    count: event.count,
    durationMs: event.durationMs,
    action: actionDto,
    groupAction: groupActionDto,
  })
}

export const publishGameBanner = (
  event: Omit<Extract<GameOverlayEvent, { kind: 'banner' }>, 'kind' | 'go' | 'dismiss'> & {
    actionLabel: string
  },
  onGo: () => void,
  onDismiss: () => void,
) => {
  releaseBannerActions(event.id)
  const go = gameAction(event.actionLabel, onGo)
  const dismissAction = gameAction('关闭', onDismiss)
  bannerActionTokens.set(event.id, [go.token, dismissAction.token])
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

export const removeGameBanner = (id: string) => {
  releaseBannerActions(id)
  publishGameOverlay({ kind: 'banner-remove', id })
}
export const clearGameBanners = () => {
  for (const id of bannerActionTokens.keys()) releaseBannerActions(id)
  publishGameOverlay({ kind: 'banner-clear' })
}
