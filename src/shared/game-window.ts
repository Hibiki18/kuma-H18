import { TOAST_CORNERS, type ToastCorner } from './toast-position'

export type GameWindowMode = 'embedded' | 'detached'

export type GameHostPhase =
  | 'BOOTSTRAPPING'
  | 'EMBEDDED'
  | 'DETACHING'
  | 'DETACHED'
  | 'ATTACHING'
  | 'RECOVERING'
  | 'DISPOSING'

export interface RectLike {
  x: number
  y: number
  width: number
  height: number
}

export interface SavedWindowBounds extends RectLike {
  isMaximized?: boolean
}

export interface GameWindowSnapshot {
  phase: GameHostPhase
  effectiveMode: GameWindowMode
  configuredMode: GameWindowMode
  hostWebContentsId: number | null
  guestWebContentsId: number | null
  requestId: number
  canRetry: boolean
  error?: { code: string; message: string }
}

export type GameCommand =
  | { type: 'reload' }
  | { type: 'capture' }
  | { type: 'audio-stats' }
  | { type: 'focus' }

export interface GameCommandResult {
  ok: boolean
  value?: unknown
  message?: string
}

export interface ModeSwitchResult {
  ok: boolean
  snapshot: GameWindowSnapshot
  code?: string
  message?: string
}

export type CaptionTone = 'light' | 'mid' | 'heavy' | 'sunk' | 'wedding'

export type GameOverlayEvent =
  | { kind: 'caption-clear'; scope?: 'bottom' | 'all' }
  | {
      kind: 'launch-glow'
      phase: 'arm' | 'run' | 'end'
      delayMs?: number
      durationMs?: number
    }
  | {
      kind: 'banner'
      id: string
      tone: 'celebrate' | 'danger' | 'repair' | 'goddess' | 'wedding'
      icon: string
      title: string
      detail: string
      order: number
      go: { token: string; label: string }
      dismiss: { token: string }
    }
  | { kind: 'banner-remove'; id: string }
  | { kind: 'banner-clear' }
  | {
      kind: 'caption'
      mode: 'bottom' | 'friendly' | 'enemy'
      speaker: string
      text: string
      tone?: CaptionTone
      durationMs: number
      lane?: number
    }
  | {
      kind: 'toast'
      id: string
      severity: 'info' | 'ok' | 'warn' | 'danger'
      title: string
      detail: string
      locked: boolean
      corner: ToastCorner
      groupKey?: string
      groupTitle?: string
      count?: number
      action?: { token: string; label: string }
      groupAction?: { token: string; label: string }
      durationMs?: number
    }

export const normalizeGameWindowMode = (value: unknown): GameWindowMode =>
  value === 'detached' ? 'detached' : 'embedded'

export const isStableGameHostPhase = (phase: GameHostPhase): boolean =>
  phase === 'EMBEDDED' || phase === 'DETACHED'

export const modeForStablePhase = (phase: GameHostPhase): GameWindowMode | null =>
  phase === 'EMBEDDED' ? 'embedded' : phase === 'DETACHED' ? 'detached' : null

export const isGameCommand = (value: unknown): value is GameCommand => {
  if (!value || typeof value !== 'object') return false
  const keys = Object.keys(value as Record<string, unknown>)
  if (keys.length !== 1 || keys[0] !== 'type') return false
  return ['reload', 'capture', 'audio-stats', 'focus'].includes(
    (value as { type?: unknown }).type as string,
  )
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

export const normalizeRect = (value: unknown): RectLike | null => {
  if (!value || typeof value !== 'object') return null
  const { x, y, width, height } = value as Partial<RectLike>
  if (![x, y, width, height].every(finite) || width! < 0 || height! < 0) return null
  return {
    x: Math.round(x!),
    y: Math.round(y!),
    width: Math.round(width!),
    height: Math.round(height!),
  }
}

export const cssRectToViewBounds = (
  value: unknown,
  zoomFactor: number,
  contentBounds: Pick<RectLike, 'width' | 'height'>,
): RectLike | null => {
  if (!value || typeof value !== 'object') return null
  const rect = value as Partial<RectLike>
  if (![rect.x, rect.y, rect.width, rect.height].every(finite)) return null
  if (rect.width! < 0 || rect.height! < 0 || !finite(zoomFactor) || zoomFactor <= 0) return null
  const scaled = {
    x: Math.round(rect.x! * zoomFactor),
    y: Math.round(rect.y! * zoomFactor),
    width: Math.round(rect.width! * zoomFactor),
    height: Math.round(rect.height! * zoomFactor),
  }
  if (scaled.width <= 0 || scaled.height <= 0 || scaled.x < 0 || scaled.y < 0) return null
  if (scaled.x + scaled.width > contentBounds.width) return null
  if (scaled.y + scaled.height > contentBounds.height) return null
  return scaled
}

export const containGameRect = (width: number, height: number): RectLike => {
  if (!finite(width) || !finite(height) || width <= 0 || height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  const scale = Math.min(width / 1200, height / 720)
  const gameWidth = Math.max(0, Math.floor(1200 * scale))
  const gameHeight = Math.max(0, Math.floor(720 * scale))
  return {
    x: Math.floor((width - gameWidth) / 2),
    y: Math.floor((height - gameHeight) / 2),
    width: gameWidth,
    height: gameHeight,
  }
}

const intersects = (a: RectLike, b: RectLike): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

export const restoreWindowBounds = (
  raw: unknown,
  workAreas: readonly RectLike[],
  primary: RectLike,
  minimum = { width: 720, height: 480 },
): SavedWindowBounds => {
  const saved = normalizeRect(raw)
  const maxWidth = Math.max(minimum.width, primary.width)
  const maxHeight = Math.max(minimum.height, primary.height)
  const width = Math.min(maxWidth, Math.max(minimum.width, saved?.width ?? 1000))
  const height = Math.min(maxHeight, Math.max(minimum.height, saved?.height ?? 650))
  const candidate = saved ? { ...saved, width, height } : null
  if (candidate && workAreas.some((area) => intersects(candidate, area))) {
    return {
      ...candidate,
      isMaximized: (raw as SavedWindowBounds | null)?.isMaximized === true,
    }
  }
  return {
    x: primary.x + Math.max(0, Math.floor((primary.width - width) / 2)),
    y: primary.y + Math.max(0, Math.floor((primary.height - height) / 2)),
    width,
    height,
    isMaximized: (raw as SavedWindowBounds | null)?.isMaximized === true,
  }
}

const textWithin = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max

export const normalizeOverlayEvent = (value: unknown): GameOverlayEvent | null => {
  if (!value || typeof value !== 'object') return null
  const event = value as Record<string, unknown>
  if (event.kind === 'caption-clear') {
    if (event.scope == null) return { kind: 'caption-clear' }
    return event.scope === 'bottom' || event.scope === 'all'
      ? { kind: 'caption-clear', scope: event.scope }
      : null
  }
  if (event.kind === 'launch-glow') {
    if (!['arm', 'run', 'end'].includes(event.phase as string)) return null
    if (event.phase !== 'run') {
      return { kind: 'launch-glow', phase: event.phase as 'arm' | 'end' }
    }
    if (!finite(event.delayMs) || !finite(event.durationMs)) return null
    return {
      kind: 'launch-glow',
      phase: 'run',
      delayMs: Math.min(30_000, Math.max(0, Math.round(event.delayMs))),
      durationMs: Math.min(30_000, Math.max(1, Math.round(event.durationMs))),
    }
  }
  if (event.kind === 'banner-clear') return { kind: 'banner-clear' }
  if (event.kind === 'banner-remove') {
    return textWithin(event.id, 100) && event.id ? { kind: 'banner-remove', id: event.id } : null
  }
  if (event.kind === 'banner') {
    const go = event.go as Record<string, unknown> | undefined
    const dismiss = event.dismiss as Record<string, unknown> | undefined
    if (!textWithin(event.id, 100) || !event.id) return null
    if (!['celebrate', 'danger', 'repair', 'goddess', 'wedding'].includes(event.tone as string)) return null
    if (!textWithin(event.icon, 8) || !textWithin(event.title, 160) || !textWithin(event.detail, 1000)) return null
    if (!go || !textWithin(go.token, 100) || !textWithin(go.label, 80)) return null
    if (!dismiss || !textWithin(dismiss.token, 100)) return null
    const order = Number(event.order)
    if (!Number.isInteger(order) || order < 0 || order > 10) return null
    return {
      kind: 'banner',
      id: event.id,
      tone: event.tone as 'celebrate' | 'danger' | 'repair' | 'goddess' | 'wedding',
      icon: event.icon,
      title: event.title,
      detail: event.detail,
      order,
      go: { token: go.token, label: go.label } as { token: string; label: string },
      dismiss: { token: dismiss.token } as { token: string },
    }
  }
  if (event.kind === 'caption') {
    if (!['bottom', 'friendly', 'enemy'].includes(event.mode as string)) return null
    if (!textWithin(event.speaker, 80) || !textWithin(event.text, 600) || !event.text) return null
    if (event.tone != null && !['light', 'mid', 'heavy', 'sunk', 'wedding'].includes(event.tone as string)) return null
    const durationMs = Number(event.durationMs)
    const lane = event.lane == null ? undefined : Number(event.lane)
    if (!Number.isFinite(durationMs)) return null
    if (lane != null && (!Number.isInteger(lane) || lane < 0 || lane > 7)) return null
    return {
      kind: 'caption',
      mode: event.mode as 'bottom' | 'friendly' | 'enemy',
      speaker: event.speaker,
      text: event.text,
      tone: event.tone as CaptionTone | undefined,
      durationMs: Math.min(30_000, Math.max(1_000, Math.round(durationMs))),
      lane,
    }
  }
  if (event.kind === 'toast') {
    if (!textWithin(event.id, 100) || !event.id) return null
    if (!['info', 'ok', 'warn', 'danger'].includes(event.severity as string)) return null
    if (!textWithin(event.title, 160) || !textWithin(event.detail, 1000)) return null
    if (typeof event.locked !== 'boolean') return null
    const action = event.action as Record<string, unknown> | undefined
    const groupAction = event.groupAction as Record<string, unknown> | undefined
    if (action && (!textWithin(action.token, 100) || !action.token || !textWithin(action.label, 80) || !action.label)) return null
    if (groupAction && (!textWithin(groupAction.token, 100) || !groupAction.token || !textWithin(groupAction.label, 80) || !groupAction.label)) return null
    if (event.groupTitle != null && !textWithin(event.groupTitle, 160)) return null
    const count = event.count == null ? undefined : Number(event.count)
    if (count != null && (!Number.isInteger(count) || count < 1 || count > 999)) return null
    const corner = TOAST_CORNERS.includes(event.corner as ToastCorner)
      ? (event.corner as ToastCorner)
      : 'br'
    return {
      kind: 'toast',
      id: event.id,
      severity: event.severity as 'info' | 'ok' | 'warn' | 'danger',
      title: event.title,
      detail: event.detail,
      locked: event.locked,
      corner,
      groupKey: textWithin(event.groupKey, 100) ? event.groupKey : undefined,
      groupTitle: textWithin(event.groupTitle, 160) ? event.groupTitle : undefined,
      count,
      action: action ? { token: action.token as string, label: action.label as string } : undefined,
      groupAction: groupAction
        ? { token: groupAction.token as string, label: groupAction.label as string }
        : undefined,
      durationMs: finite(event.durationMs)
        ? Math.min(30_000, Math.max(1_000, Math.round(event.durationMs)))
        : undefined,
    }
  }
  return null
}
