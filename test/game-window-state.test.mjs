import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isGameCommand,
  modeForStablePhase,
  normalizeGameWindowMode,
  normalizeOverlayEvent,
} from '../dist/shared/game-window.js'

test('game window modes default to embedded and stable phases map exactly', () => {
  assert.equal(normalizeGameWindowMode('detached'), 'detached')
  assert.equal(normalizeGameWindowMode('other'), 'embedded')
  assert.equal(modeForStablePhase('EMBEDDED'), 'embedded')
  assert.equal(modeForStablePhase('DETACHED'), 'detached')
  assert.equal(modeForStablePhase('DETACHING'), null)
})

test('game command channel accepts only the fixed one-field command union', () => {
  for (const type of ['reload', 'capture', 'audio-stats', 'focus']) {
    assert.equal(isGameCommand({ type }), true)
  }
  assert.equal(isGameCommand({ type: 'execute', script: '1+1' }), false)
  assert.equal(isGameCommand({ type: 'reload', path: 'elsewhere' }), false)
})

test('overlay DTO validation rejects oversized, malformed, and script-shaped payloads', () => {
  assert.deepEqual(
    normalizeOverlayEvent({ kind: 'caption-clear', scope: 'bottom' }),
    { kind: 'caption-clear', scope: 'bottom' },
  )
  assert.equal(normalizeOverlayEvent({ kind: 'caption-clear', scope: 'danmaku' }), null)
  assert.deepEqual(
    normalizeOverlayEvent({
      kind: 'caption', mode: 'friendly', speaker: '赤城', text: '発艦始め！', tone: 'light', durationMs: 4200, lane: 2,
    }),
    { kind: 'caption', mode: 'friendly', speaker: '赤城', text: '発艦始め！', tone: 'light', durationMs: 4200, lane: 2 },
  )
  assert.equal(normalizeOverlayEvent({ kind: 'caption', mode: 'other', speaker: '', text: 'x', durationMs: 1 }), null)
  assert.equal(normalizeOverlayEvent({ kind: 'toast', id: 'x', severity: 'ok', title: 'x', detail: 'x', locked: false, action: { token: 'x', label: 'x', script: 'x' } })?.kind, 'toast')
  assert.equal(normalizeOverlayEvent({ kind: 'toast', id: 'x', severity: 'ok', title: 'x'.repeat(200), detail: '', locked: false }), null)
  assert.deepEqual(
    normalizeOverlayEvent({
      kind: 'toast', id: 'x', severity: 'ok', title: '任务完成 ×3', detail: '最新', locked: false,
      groupKey: 'quest', groupTitle: '任务完成', count: 3,
      action: { token: 'detail', label: '任务详情' },
      groupAction: { token: 'overview', label: '任务总览' },
    }),
    {
      kind: 'toast', id: 'x', severity: 'ok', title: '任务完成 ×3', detail: '最新', locked: false,
      groupKey: 'quest', groupTitle: '任务完成', count: 3,
      action: { token: 'detail', label: '任务详情' },
      groupAction: { token: 'overview', label: '任务总览' },
      durationMs: undefined,
    },
  )
  assert.equal(normalizeOverlayEvent({
    kind: 'toast', id: 'x', severity: 'ok', title: 'x', detail: '', locked: false, count: 0,
  }), null)
  assert.deepEqual(
    normalizeOverlayEvent({ kind: 'launch-glow', phase: 'run', delayMs: 123.4, durationMs: 1800 }),
    { kind: 'launch-glow', phase: 'run', delayMs: 123, durationMs: 1800 },
  )
  assert.equal(normalizeOverlayEvent({ kind: 'launch-glow', phase: 'run', delayMs: 0 }), null)
})
