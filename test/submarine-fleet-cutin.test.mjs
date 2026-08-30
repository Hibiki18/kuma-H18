// 潜水舰队攻击（api_at_type / api_sp_list = 300/301/302）的分段归属护栏，
// 外加雷击段 *_list_items 两种形状的接线。
//
// 这三个号是**砲击战/夜战里的特殊攻击**，不是独立阶段——两票：
// KC3Kai `BattlePrediction/phases/Hougeki.js` 的 `isSubmarineCutin1/2/3`
// 认的就是 `api_at_type || api_sp_list`；同项目 kancolle-replay `js/kcsim.js`
// 的 `canSpecialAttackUnique` 也只在砲击/夜战两处发动。所以伤害本来就走 applyHougeki，
// 敌方血量不会因为它丢——这份测试钉的是**打出这几段的是哪条舰**。
//
// 一次发动 2～4 段：两条参战潜艇各先打一次，各自还可能再打第二次。
// 只有两段时按四段表截前两位会把第二条的那一击记到第一条头上（MVP、逐舰伤害跟着错）。
//
// 断言的是解析产物（damageDealt / 攻击流水 / 敌方血量），不是源码文本。
import assert from 'node:assert/strict'
import test from 'node:test'

import battleModule from '../dist/main/mg/battle.js'

const { parseBattle } = battleModule

const subFleet = [
  { rosterId: 1, mstId: 491, name: '大鯨', lv: 60, nowHp: 40, maxHp: 40, equipments: [] },
  { rosterId: 2, mstId: 259, name: '伊168', lv: 80, nowHp: 20, maxHp: 20, equipments: [] },
  { rosterId: 3, mstId: 260, name: '伊58改', lv: 80, nowHp: 20, maxHp: 20, equipments: [] },
  { rosterId: 4, mstId: 261, name: '伊8改', lv: 80, nowHp: 20, maxHp: 20, equipments: [] },
  null,
  null,
  null,
]

const ctx = {
  fleetShips: () => subFleet,
  masterName: (mstId) => `E${mstId}`,
  masterMaxEq: () => [],
  combinedType: () => 0,
}

const baseBody = () => ({
  api_deck_id: 1,
  api_formation: [5, 1, 3],
  api_f_nowhps: [40, 20, 20, 20],
  api_f_maxhps: [40, 20, 20, 20],
  api_ship_ke: [1591, 1591, 1591, 1591, 1591],
  api_ship_lv: [1, 1, 1, 1, 1],
  api_e_nowhps: [48, 48, 48, 48, 48],
  api_e_maxhps: [48, 48, 48, 48, 48],
  api_eSlot: [[], [], [], [], []],
})

const withCutin = (ci, damage, df) => ({
  ...baseBody(),
  api_hougeki1: {
    api_at_eflag: [0],
    api_at_list: [0],
    api_at_type: [ci],
    api_df_list: [df],
    api_si_list: [df.map(() => 0)],
    api_cl_list: [df.map(() => 1)],
    api_damage: [damage],
  },
})

const parse = (body) => parseBattle('/kcsapi/api_req_sortie/battle', body, ctx, 0)
const dealt = (view) => view.fShips.map((ship) => ship.damageDealt)
const attackers = (view) => view.attacks.map((attack) => attack.attacker)

test('300 两段：两条潜艇各记一击，不是旗舰后面那条打两次', () => {
  const view = parse(withCutin(300, [60, 60], [3, 3]))
  assert.deepEqual(attackers(view), [1, 2])
  assert.deepEqual(dealt(view), [0, 60, 60, 0])
})

test('300 四段：两条潜艇各两击', () => {
  const view = parse(withCutin(300, [60, 60, 60, 60], [3, 3, 4, 4]))
  assert.deepEqual(attackers(view), [1, 1, 2, 2])
  assert.deepEqual(dealt(view), [0, 120, 120, 0])
})

test('301 / 302 两段各按自己的参战舰位记账', () => {
  const two = parse(withCutin(301, [60, 60], [3, 3]))
  assert.deepEqual(attackers(two), [2, 3])
  const skip = parse(withCutin(302, [60, 60], [3, 3]))
  assert.deepEqual(attackers(skip), [1, 3])
})

test('三段这一档判不出来，沿用四段表的前三位（KC3 在同处也注明无解）', () => {
  const view = parse(withCutin(300, [60, 60, 60], [3, 3, 4]))
  assert.deepEqual(attackers(view), [1, 1, 2])
})

test('归属怎么记都不影响敌方结算：四段全落到目标身上，该沉的沉', () => {
  const view = parse(withCutin(300, [60, 60, 60, 60], [3, 3, 4, 4]))
  assert.deepEqual(
    view.eShips.map((ship) => [ship.hpEnd, ship.sunk]),
    [[48, false], [48, false], [48, false], [0, true], [0, true]],
  )
  assert.equal(view.prediction.eSunk, 2)
})

// ---- 雷击段的 *_list_items ----

test('闭幕雷击也认 *_list_items：整段不会因为没有 api_frai 就静默消失', () => {
  const view = parse({
    ...baseBody(),
    api_raigeki: {
      api_frai_list_items: [null, [0, 1], [2], null],
      api_fydam_list_items: [null, [48, 20], [48], null],
      api_fcl_list_items: [null, [1, 1], [2], null],
    },
  })
  assert.deepEqual(
    view.eShips.map((ship) => ship.hpEnd),
    [0, 28, 0, 48, 48],
  )
  assert.deepEqual(dealt(view), [0, 68, 48, 0])
  assert.ok(view.stages.some((stage) => stage.source === 'api_raigeki'))
})

test('*_list_items 那一格可能是单个数而不是数组，单值那条舰不能被丢掉', () => {
  const view = parse({
    ...baseBody(),
    api_opening_atack: {
      api_frai_list_items: [null, 4, [3, 3], null],
      api_fydam_list_items: [null, 48, [24, 24], null],
      api_fcl_list_items: [null, 1, [1, 1], null],
    },
  })
  assert.deepEqual(
    view.eShips.map((ship) => ship.hpEnd),
    [48, 48, 48, 0, 0],
  )
  assert.deepEqual(dealt(view), [0, 48, 48, 0])
})
