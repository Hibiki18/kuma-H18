// 换装三条的状态自演：slotset / slotset_ex / unsetslot_all。
//
// 这三条的响应体只有 api_result（账本 941 / 88 / 56 份实样，无一例外），
// 舰上装备变成什么样只能照 POST 参数推。推错了不会报错、也不会黑屏，
// 只会让读装备的功能（泊地修理覆盖数、编队装备图标、制空、索敌、对空 CI）
// 在下一次全量刷新盖上来之前拿旧数据——所以判据只能在这里钉。
//
// 参数出处：全部取自用户账本 events 的真报文，逐个核过名字与编号基。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  REAL,
  REPAIR_FACILITY_MST_ID,
  berthFacilityCount,
  feedSlotset,
  feedSlotsetEx,
  feedUnsetslotAll,
  reset,
  shipAt,
} from './fixtures/store-kaisou-slotset.mjs'

import berth from '../dist/shared/berth-repair.js'

const { berthCoverage } = berth

// ---- ① slotset：装上 ----

test('slotset 把实例装进指定格，api_slot_idx 是 0-based', () => {
  reset({ 443: {} }, { 13482: 5 })
  const sections = feedSlotset(REAL.slotset)
  // 实样 api_slot_idx = "4" → 第 5 格 = 下标 4。多减一会落到下标 3。
  assert.deepEqual(shipAt(443).slot, [-1, -1, -1, -1, 13482])
  assert.deepEqual(sections, ['ships'])
})

test('slotset 只动点名那一格，别的格原样不动', () => {
  reset({ 443: { slot: [11, 22, 33, 44, -1] } }, { 13482: 5 })
  feedSlotset(REAL.slotset)
  assert.deepEqual(shipAt(443).slot, [11, 22, 33, 44, 13482])
})

test('slotset 换掉已有装备时，旧实例从那一格离开', () => {
  reset({ 443: { slot: [-1, -1, -1, -1, 999] } }, { 13482: 5, 999: 5 })
  feedSlotset(REAL.slotset)
  assert.deepEqual(shipAt(443).slot, [-1, -1, -1, -1, 13482])
})

// ---- ② slotset：卸下 ----

test('slotset 的 api_item_id = -1 是把那一格卸空', () => {
  reset({ 877: { slot: [11, 22, 33, 44, 55] } })
  const sections = feedSlotset(REAL.slotsetUnset)
  // 实样 api_slot_idx = "3" → 下标 3（第 4 格）变 -1，其余不动
  assert.deepEqual(shipAt(877).slot, [11, 22, 33, -1, 55])
  assert.deepEqual(sections, ['ships'])
})

test('卸一个本来就空的格不算变化，不惊动订阅方', () => {
  reset({ 877: { slot: [11, 22, -1, -1, 55] } })
  assert.deepEqual(feedSlotset(REAL.slotsetUnset), [])
})

// ---- ③ 一件实例只能待在一个地方 ----

test('把已在别格的实例装到新格，旧格同时空出来', () => {
  // 13482 本来在下标 0，实样要把它装到下标 4
  reset({ 443: { slot: [13482, 22, -1, -1, -1] } }, { 13482: 5, 22: 5 })
  feedSlotset(REAL.slotset)
  assert.deepEqual(shipAt(443).slot, [-1, 22, -1, -1, 13482])
})

test('把补强増設格里的实例装到常规格，补强格退回「开着但空」', () => {
  reset({ 443: { slot: [-1, -1, -1, -1, -1], slotEx: 13482 } }, { 13482: 5 })
  feedSlotset(REAL.slotset)
  assert.deepEqual(shipAt(443).slot, [-1, -1, -1, -1, 13482])
  // -1 = 开了但空着；落 0 等于把开好的格子又关上
  assert.equal(shipAt(443).slotEx, -1)
})

// ---- ④ slotset_ex ----

test('slotset_ex 装进补强増設格，不碰常规格', () => {
  reset({ 7209: { slot: [11, 22, 33, -1, -1], slotEx: -1 } }, { 17190: 5 })
  const sections = feedSlotsetEx(REAL.slotsetEx)
  assert.equal(shipAt(7209).slotEx, 17190)
  assert.deepEqual(shipAt(7209).slot, [11, 22, 33, -1, -1])
  assert.deepEqual(sections, ['ships'])
})

test('slotset_ex 的 -1 是卸下，落 -1 不落 0（0 = 这格根本没开过）', () => {
  reset({ 1339: { slotEx: 16289 } })
  feedSlotsetEx(REAL.slotsetExUnset)
  assert.equal(shipAt(1339).slotEx, -1)
  assert.notEqual(shipAt(1339).slotEx, 0)
})

test('从常规格挪进补强増設格，常规格那一格空出来', () => {
  reset({ 7209: { slot: [17190, 22, -1, -1, -1], slotEx: -1 } }, { 17190: 5 })
  feedSlotsetEx(REAL.slotsetEx)
  assert.equal(shipAt(7209).slotEx, 17190)
  assert.deepEqual(shipAt(7209).slot, [-1, 22, -1, -1, -1])
})

// ---- ⑤ unsetslot_all ----

test('unsetslot_all 清空全部常规格', () => {
  reset({ 3212: { slot: [11, 22, 33, 44, 55] } })
  const sections = feedUnsetslotAll(REAL.unsetslotAll)
  assert.deepEqual(shipAt(3212).slot, [-1, -1, -1, -1, -1])
  assert.deepEqual(sections, ['ships'])
})

test('unsetslot_all 不碰补强増設格', () => {
  // 补强格是游戏里另一颗按钮，这条报文里没有任何东西能证明它跟着清；
  // 多清一格会把玩家真装着的东西从账面抹掉，比漏清难查得多。
  reset({ 3212: { slot: [11, 22, -1, -1, -1], slotEx: 777 } })
  feedUnsetslotAll(REAL.unsetslotAll)
  assert.deepEqual(shipAt(3212).slot, [-1, -1, -1, -1, -1])
  assert.equal(shipAt(3212).slotEx, 777)
})

test('本来就空的舰再一括解除，不算变化', () => {
  reset({ 3212: {} })
  assert.deepEqual(feedUnsetslotAll(REAL.unsetslotAll), [])
})

// ---- ⑥ 畸形报文不崩 ----

test('认不出的在籍 id / 越界格位 / 缺字段，一律安静地什么都不做', () => {
  reset({ 443: { slot: [11, 22, 33, 44, 55] } })
  const before = [...shipAt(443).slot]
  const cases = [
    {},
    { api_id: '999999', api_item_id: '1', api_slot_idx: '0' },
    { api_id: '443', api_item_id: '1', api_slot_idx: '5' },
    { api_id: '443', api_item_id: '1', api_slot_idx: '-1' },
    { api_id: '443', api_item_id: '1', api_slot_idx: 'x' },
    { api_id: '443', api_item_id: '1' },
    { api_id: 'x', api_item_id: 'y', api_slot_idx: 'z' },
  ]
  for (const post of cases) {
    assert.deepEqual(feedSlotset(post), [], `slotset 对 ${JSON.stringify(post)} 应当无动作`)
  }
  assert.deepEqual(shipAt(443).slot, before)

  for (const post of [{}, { api_id: '999999', api_item_id: '1' }, { api_id: 'x' }]) {
    assert.deepEqual(feedSlotsetEx(post), [], `slotset_ex 对 ${JSON.stringify(post)} 应当无动作`)
  }
  for (const post of [{}, { api_id: '999999' }, { api_id: 'x' }]) {
    assert.deepEqual(feedUnsetslotAll(post), [], `unsetslot_all 对 ${JSON.stringify(post)} 应当无动作`)
  }
})

test('响应体缺失或畸形也不崩（这三条本来就不看响应体）', () => {
  reset({ 443: {} }, { 13482: 5 })
  assert.deepEqual(feedSlotset(REAL.slotset, undefined), ['ships'])
  assert.deepEqual(shipAt(443).slot, [-1, -1, -1, -1, 13482])
})

// ---- ⑦ 验收闭环：换装之后，数修理施設的那一行拿到的是新数据 ----

test('明石带 4 个修理施設：换装归约完，锐数出 4 件、覆盖 6 艘', () => {
  // 四件施設的实例 id，加一件无关装备占第 5 格
  const facilities = [8001, 8002, 8003, 8004]
  const stock = { 9001: 5 }
  for (const id of facilities) stock[id] = REPAIR_FACILITY_MST_ID
  reset({ 443: {} }, stock)

  // 一格一条报文地装上去——真链路就是这么来的（实样每次只动一格）
  facilities.forEach((itemId, idx) => {
    const sections = feedSlotset({
      api_token: '<REDACTED>',
      api_verno: '1',
      api_id: '443',
      api_item_id: `${itemId}`,
      api_slot_idx: `${idx}`,
    })
    assert.deepEqual(sections, ['ships'])
  })
  feedSlotset({
    api_token: '<REDACTED>',
    api_verno: '1',
    api_id: '443',
    api_item_id: '9001',
    api_slot_idx: '4',
  })

  const flag = shipAt(443)
  assert.deepEqual(flag.slot, [...facilities, 9001])
  assert.equal(berthFacilityCount(flag), 4)
  assert.equal(berthCoverage(berthFacilityCount(flag)), 6)
})

test('拆掉两个施設后，覆盖数跟着退回 4 艘', () => {
  const facilities = [8001, 8002, 8003, 8004]
  const stock = {}
  for (const id of facilities) stock[id] = REPAIR_FACILITY_MST_ID
  reset({ 443: { slot: [...facilities, -1] } }, stock)
  assert.equal(berthFacilityCount(shipAt(443)), 4)

  for (const idx of [2, 3]) {
    feedSlotset({
      api_token: '<REDACTED>',
      api_verno: '1',
      api_id: '443',
      api_item_id: '-1',
      api_slot_idx: `${idx}`,
    })
  }
  assert.equal(berthFacilityCount(shipAt(443)), 2)
  assert.equal(berthCoverage(berthFacilityCount(shipAt(443))), 4)
})

test('一括解除之后，覆盖数回到不带施設的 2 艘', () => {
  const facilities = [8001, 8002, 8003, 8004]
  const stock = {}
  for (const id of facilities) stock[id] = REPAIR_FACILITY_MST_ID
  reset({ 3212: { slot: [...facilities, -1] } }, stock)
  assert.equal(berthFacilityCount(shipAt(3212)), 4)

  feedUnsetslotAll(REAL.unsetslotAll)
  assert.equal(berthFacilityCount(shipAt(3212)), 0)
  assert.equal(berthCoverage(berthFacilityCount(shipAt(3212))), 2)
})

test('同一件施設不会因为换格被数两次', () => {
  // 8001 本来在下标 0；把它挪到下标 2。数出来必须还是 1 件。
  reset({ 443: { slot: [8001, -1, -1, -1, -1] } }, { 8001: REPAIR_FACILITY_MST_ID })
  feedSlotset({
    api_token: '<REDACTED>',
    api_verno: '1',
    api_id: '443',
    api_item_id: '8001',
    api_slot_idx: '2',
  })
  assert.deepEqual(shipAt(443).slot, [-1, -1, 8001, -1, -1])
  assert.equal(berthFacilityCount(shipAt(443)), 1)
})
