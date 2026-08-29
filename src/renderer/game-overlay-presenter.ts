import type { GameOverlayEvent } from '../shared/game-window'

const toneClass = (tone: string | undefined) =>
  !tone ? '' : tone === 'wedding' ? 'voice-wedding' : `dmg-${tone}`

export const createGameOverlayPresenter = (
  root: ParentNode,
  sendAction: (token: string) => void,
  releaseAction: (token: string) => void = () => {},
) => {
  const subtitle = root.querySelector<HTMLElement>('#voice-subtitle')!
  const speaker = subtitle.querySelector<HTMLElement>('.voice-subtitle-speaker')!
  const line = subtitle.querySelector<HTMLElement>('.voice-subtitle-line')!
  const danmaku = root.querySelector<HTMLElement>('#voice-danmaku')!
  const toasts = root.querySelector<HTMLElement>('#lg-toasts')!
  const banners = root.querySelector<HTMLElement>('#lg-banners')!
  const followingEffects = root.querySelector<HTMLElement>('#game-following-effects')!

  const clearBottomCaption = () => {
    subtitle.className = ''
    speaker.textContent = ''
    line.textContent = ''
  }

  const clearCaptions = () => {
    clearBottomCaption()
    danmaku.replaceChildren()
  }

  const showCaption = (event: Extract<GameOverlayEvent, { kind: 'caption' }>) => {
    if (event.mode === 'bottom') {
      speaker.textContent = event.speaker
      line.textContent = event.text
      subtitle.className = toneClass(event.tone)
      void subtitle.offsetWidth
      subtitle.classList.add('show')
      return
    }
    const item = document.createElement('span')
    item.className = `voice-danmaku-item ${event.mode} ${toneClass(event.tone)}`
    item.style.setProperty('--voice-lane', `${event.lane ?? 0}`)
    item.style.setProperty('--voice-duration', `${event.durationMs / 1000}s`)
    item.textContent = event.speaker ? `${event.speaker}：${event.text}` : event.text
    const remove = () => item.remove()
    item.addEventListener('animationend', remove, { once: true })
    danmaku.appendChild(item)
    setTimeout(remove, event.durationMs + 500)
  }

  const releaseToastAction = (element: HTMLElement) => {
    const action = element.querySelector<HTMLButtonElement>('.toast-action')
    const token = action?.dataset.actionToken
    if (!token) return
    delete action.dataset.actionToken
    releaseAction(token)
  }

  const removeToast = (element: HTMLElement, release = true) => {
    const timer = Number(element.dataset.timer)
    if (timer) clearTimeout(timer)
    delete element.dataset.timer
    if (release) releaseToastAction(element)
    element.remove()
  }

  const armToast = (element: HTMLElement, durationMs: number) => {
    const old = Number(element.dataset.timer)
    if (old) clearTimeout(old)
    const ttl = element.querySelector<HTMLElement>('.ttl')
    if (ttl) {
      ttl.style.transition = 'none'
      ttl.style.width = '100%'
      void ttl.offsetWidth
      ttl.style.transition = `width ${durationMs}ms linear`
      requestAnimationFrame(() => (ttl.style.width = '0'))
    }
    const timer = setTimeout(() => removeToast(element), durationMs)
    element.dataset.timer = `${timer as unknown as number}`
  }

  const showToast = (event: Extract<GameOverlayEvent, { kind: 'toast' }>) => {
    const group = event.groupKey
      ? toasts.querySelector<HTMLElement>(`[data-group="${CSS.escape(event.groupKey)}"]`)
      : null
    if (group && !event.locked) {
      const count = Number(group.dataset.count ?? 1) + (event.count ?? 1)
      group.dataset.count = `${count}`
      group.querySelector<HTMLElement>('b')!.textContent = `${event.groupTitle ?? event.title} ×${count}`
      group.querySelector<HTMLElement>('.detail')!.textContent = `最新：${event.detail}`
      const action = group.querySelector<HTMLButtonElement>('.toast-action')
      if (event.action) releaseAction(event.action.token)
      if (action && event.groupAction) {
        releaseToastAction(group)
        action.dataset.actionToken = event.groupAction.token
        action.textContent = `→ ${event.groupAction.label}`
      } else if (event.groupAction) {
        releaseAction(event.groupAction.token)
      }
      armToast(group, event.durationMs ?? 8000)
      return
    }

    const element = document.createElement('section')
    element.className = `lg-toast ${event.severity}`
    element.dataset.group = event.groupKey ?? ''
    element.dataset.count = `${event.count ?? 1}`
    const close = document.createElement('button')
    close.className = 'toast-close'
    close.type = 'button'
    close.title = event.locked ? '需手动关闭' : '关闭'
    close.setAttribute('aria-label', close.title)
    close.textContent = '×'
    const body = document.createElement('span')
    body.className = 'toast-body'
    const title = document.createElement('b')
    title.textContent = event.title
    const detail = document.createElement('span')
    detail.className = 'detail'
    detail.textContent = event.detail
    body.append(title, detail)
    if (event.action) {
      const action = document.createElement('button')
      action.className = 'toast-action'
      action.type = 'button'
      action.dataset.actionToken = event.action.token
      action.textContent = `→ ${event.action.label}`
      action.addEventListener('click', (click) => {
        click.stopPropagation()
        const token = action.dataset.actionToken
        if (token) {
          delete action.dataset.actionToken
          sendAction(token)
        }
        removeToast(element, false)
      })
      body.appendChild(action)
    }
    if (event.groupAction) releaseAction(event.groupAction.token)
    close.addEventListener('click', (click) => {
      click.stopPropagation()
      removeToast(element)
    })
    element.addEventListener('click', () => removeToast(element))
    element.append(body, close)
    if (!event.locked) {
      const ttl = document.createElement('span')
      ttl.className = 'ttl'
      element.appendChild(ttl)
    }
    if (event.locked) element.dataset.locked = '1'
    toasts.appendChild(element)
    while (toasts.children.length > 4) {
      const removable = [...toasts.children].find((child) => !child.hasAttribute('data-locked'))
      if (!removable) break
      removeToast(removable as HTMLElement)
    }
    if (!event.locked) armToast(element, event.durationMs ?? 8000)
  }

  const showLaunchGlow = (event: Extract<GameOverlayEvent, { kind: 'launch-glow' }>) => {
    if (event.phase === 'end') {
      followingEffects.className = ''
      followingEffects.style.animationDelay = ''
      followingEffects.style.animationDuration = ''
      return
    }
    followingEffects.className = event.phase === 'run' ? 'armed running' : 'armed'
    if (event.phase === 'run') {
      followingEffects.style.animationDelay = `${event.delayMs ?? 0}ms`
      followingEffects.style.animationDuration = `${event.durationMs ?? 1}ms`
    }
  }

  const showBanner = (event: Extract<GameOverlayEvent, { kind: 'banner' }>) => {
    banners.querySelector<HTMLElement>(`[data-banner-id="${CSS.escape(event.id)}"]`)?.remove()
    const element = document.createElement('section')
    element.className = `lg-banner ${event.tone}`
    element.dataset.bannerId = event.id
    element.style.order = `${event.order}`
    const mark = document.createElement('span')
    mark.className = 'mark'
    mark.setAttribute('aria-hidden', 'true')
    mark.textContent = event.icon
    const copy = document.createElement('span')
    copy.className = 'copy'
    const title = document.createElement('b')
    title.textContent = event.title
    const detail = document.createElement('span')
    detail.textContent = event.detail
    copy.append(title, detail)
    const actions = document.createElement('span')
    actions.className = 'actions'
    const go = document.createElement('button')
    go.type = 'button'
    go.textContent = `查看${event.go.label}`
    go.addEventListener('click', () => {
      go.disabled = true
      sendAction(event.go.token)
    })
    const close = document.createElement('button')
    close.type = 'button'
    close.title = '关闭'
    close.setAttribute('aria-label', '关闭')
    close.textContent = '×'
    close.addEventListener('click', () => sendAction(event.dismiss.token))
    actions.append(go, close)
    element.append(mark, copy, actions)
    banners.appendChild(element)
  }

  return (event: GameOverlayEvent) => {
    if (event.kind === 'caption-clear') {
      if (event.scope === 'bottom') clearBottomCaption()
      else clearCaptions()
    }
    else if (event.kind === 'caption') showCaption(event)
    else if (event.kind === 'toast') showToast(event)
    else if (event.kind === 'launch-glow') showLaunchGlow(event)
    else if (event.kind === 'banner') showBanner(event)
    else if (event.kind === 'banner-remove') {
      banners.querySelector<HTMLElement>(`[data-banner-id="${CSS.escape(event.id)}"]`)?.remove()
    } else if (event.kind === 'banner-clear') banners.replaceChildren()
  }
}
