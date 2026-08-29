import assert from 'node:assert/strict'
import test from 'node:test'

import {
  containGameRect,
  cssRectToViewBounds,
  restoreWindowBounds,
} from '../dist/shared/game-window.js'

test('game view bounds follow renderer zoom once and reject invalid rectangles', () => {
  assert.deepEqual(
    cssRectToViewBounds({ x: 10.2, y: 20.4, width: 500, height: 300 }, 1.25, { width: 1000, height: 800 }),
    { x: 13, y: 26, width: 625, height: 375 },
  )
  assert.equal(cssRectToViewBounds({ x: -1, y: 0, width: 10, height: 10 }, 1, { width: 100, height: 100 }), null)
  assert.equal(cssRectToViewBounds({ x: 0, y: 0, width: 101, height: 10 }, 1, { width: 100, height: 100 }), null)
})

test('game content is contained at 5:3 without stretching', () => {
  assert.deepEqual(containGameRect(1000, 1000), { x: 0, y: 200, width: 1000, height: 600 })
  assert.deepEqual(containGameRect(1600, 720), { x: 200, y: 0, width: 1200, height: 720 })
  assert.deepEqual(containGameRect(Number.NaN, 720), { x: 0, y: 0, width: 0, height: 0 })
})

test('detached window restores visible bounds and recenters off-screen saves', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 }
  const secondary = { x: 1920, y: 0, width: 1280, height: 1024 }
  assert.deepEqual(
    restoreWindowBounds({ x: 2100, y: 100, width: 900, height: 600, isMaximized: true }, [primary, secondary], primary),
    { x: 2100, y: 100, width: 900, height: 600, isMaximized: true },
  )
  assert.deepEqual(
    restoreWindowBounds({ x: 9000, y: 9000, width: 1000, height: 650 }, [primary], primary),
    { x: 460, y: 195, width: 1000, height: 650, isMaximized: false },
  )
})

