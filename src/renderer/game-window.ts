import type { GameCommand, GameWindowSnapshot } from '../shared/game-window'

interface GameWindowBridge {
  state(): Promise<GameWindowSnapshot>
  attach(): Promise<unknown>
  command(command: GameCommand): Promise<unknown>
  bounds(rect: { x: number; y: number; width: number; height: number }, seq: number): void
  onState(listener: (state: GameWindowSnapshot) => void): void
}

declare global {
  interface Window {
    kansoGameWindow: GameWindowBridge
  }
}

const area = document.querySelector<HTMLElement>('#detached-game-area')!
const status = document.querySelector<HTMLElement>('#window-status')!
const controls = [...document.querySelectorAll<HTMLButtonElement>('button')]
let seq = 0
let frame = 0

const reportBounds = () => {
  frame = 0
  const rect = area.getBoundingClientRect()
  window.kansoGameWindow.bounds(
    { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    ++seq,
  )
}
const scheduleBounds = () => {
  if (!frame) frame = requestAnimationFrame(reportBounds)
}

const renderState = (state: GameWindowSnapshot) => {
  const busy = state.phase === 'ATTACHING' || state.phase === 'DETACHING'
  controls.forEach((button) => (button.disabled = busy || state.phase === 'DISPOSING'))
  status.textContent = state.error?.message ?? (busy ? '正在切换…' : '')
}

document.querySelector('#btn-attach')!.addEventListener('click', () => void window.kansoGameWindow.attach())
document.querySelector('#btn-reload')!.addEventListener('click', () => void window.kansoGameWindow.command({ type: 'reload' }))
document.querySelector('#btn-capture')!.addEventListener('click', () => void window.kansoGameWindow.command({ type: 'capture' }))
window.kansoGameWindow.onState(renderState)
new ResizeObserver(scheduleBounds).observe(area)
window.addEventListener('resize', scheduleBounds)
void window.kansoGameWindow.state().then(renderState)
scheduleBounds()

