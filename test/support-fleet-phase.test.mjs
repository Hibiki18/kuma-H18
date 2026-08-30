// 支援段（api_support_info.api_support_hourai）的两条护栏：成员名单的来源、伤害数组的下标口径。
//
// **api_ship_id 是在籍 ID，不是 mstId。** 本机账本唯一那一场（2026-08-07 16:13，deck_id=3）
// 给的 [711,3224,4460,2460,983,202] 六个全是这账号自己的在籍 ID（ship_life_state 逐条对上，
// 分别是 mst 464/538/916/546/541/573），而 3224/4460 早已越过主数据的舰 ID 范围。
// 照 mstId 查主数据，查不到的落成「#3224」，撞上 1500+ 的会取到深海舰名。
//
// **api_damage 的下标就是敌舰位，不做任何前导占位换算**（敌联合时主力 0-5、护卫 6-11
// 排在同一条数组里，没有 _combined 变体）。这条数组是**定长**的：长度按舰队槽位数走、
// 与实际敌舰数无关，敌不满员时尾部补零。判死样本见 support-shelling-fixed-slots.json
// ——敌 5 舰配 7 项，按 1 基读只沉 3 艘，按 0 基读五艘全灭，而游戏 api_dests = 5。
//
// 我方是 6 舰 / 7 舰游击 / 12 舰联合都不改这两件事：伤害数组按**敌方**逐位排，
// deck_id / ship_id 说的是**支援舰队那支队**（另一支队，最多 6 舰）。7 舰游击单列一个用例钉住。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import battleModule from '../dist/main/mg/battle.js'

const { parseBattle } = battleModule

// 真样本里那支支援队：在籍 ID → mstId
const SUPPORT_DECK = [
  [711, 464], [3224, 538], [4460, 916], [2460, 546], [983, 541], [202, 573],
]

const shipOf = (rosterId, mstId, hp = 50) => ({
  rosterId,
  mstId,
  name: `S${mstId}`,
  lv: 99,
  nowHp: hp,
  maxHp: hp,
  equipments: [],
})

const ctxWith = ({ supportDeckId = 4, mainSize = 6, combinedType = 0 } = {}) => ({
  fleetShips: (deckId) => {
    if (deckId === supportDeckId) return SUPPORT_DECK.map(([roster, mst]) => shipOf(roster, mst))
    return Array.from({ length: 7 }, (_, i) => (i < mainSize ? shipOf(9000 + i, 100 + i) : null))
  },
  masterName: (mstId) => `E${mstId}`,
  masterMaxEq: () => [],
  combinedType: () => combinedType,
})

const enemyFleet = (count, hp = 60) => ({
  api_ship_ke: Array.from({ length: count }, () => 1591),
  api_ship_lv: Array.from({ length: count }, () => 1),
  api_e_nowhps: Array.from({ length: count }, () => hp),
  api_e_maxhps: Array.from({ length: count }, () => hp),
  api_eSlot: Array.from({ length: count }, () => []),
})

const body = ({ ourHps, enemy, enemyEscort, support }) => ({
  api_deck_id: 1,
  api_formation: [5, 1, 3],
  api_f_nowhps: ourHps,
  api_f_maxhps: ourHps,
  ...enemyFleet(enemy),
  ...(enemyEscort
    ? {
        api_ship_ke_combined: Array.from({ length: enemyEscort }, () => 1577),
        api_ship_lv_combined: Array.from({ length: enemyEscort }, () => 1),
        api_e_nowhps_combined: Array.from({ length: enemyEscort }, () => 60),
        api_e_maxhps_combined: Array.from({ length: enemyEscort }, () => 60),
        api_eSlot_combined: Array.from({ length: enemyEscort }, () => []),
      }
    : {}),
  api_support_flag: 2,
  api_support_info: { api_support_airatack: null, api_support_hourai: support },
})

const parse = (b, ctx) => parseBattle('/kcsapi/api_req_sortie/battle', b, ctx, 0)
const supportStage = (view) => view.stages.find((stage) => stage.phase === 'support')
const supportHits = (view) =>
  (view.attacks.find((attack) => attack.phase === 'support')?.hits ?? []).map((hit) => [
    hit.target,
    hit.damage,
  ])

// ---- 成员名单 ----

test('成员名单按在籍 ID 回查支援那支队，落成真 mstId', () => {
  const view = parse(
    body({
      ourHps: [50, 50, 50, 50, 50, 50],
      enemy: 5,
      support: { api_deck_id: 4, api_ship_id: SUPPORT_DECK.map(([roster]) => roster), api_damage: [0, 0, 0, 0, 0] },
    }),
    ctxWith(),
  )
  assert.deepEqual(supportStage(view).support, {
    deckId: 4,
    shipMstIds: SUPPORT_DECK.map(([, mst]) => mst),
  })
})

test('在籍 ID 不会被当成 mstId 原样传下去（撞上 1500+ 会渲成深海舰名）', () => {
  const view = parse(
    body({
      ourHps: [50, 50, 50, 50, 50, 50],
      enemy: 5,
      support: { api_deck_id: 4, api_ship_id: [3224, 4460], api_damage: [0, 0, 0, 0, 0] },
    }),
    ctxWith(),
  )
  const list = supportStage(view).support.shipMstIds
  assert.deepEqual(list, [538, 916])
  assert.ok(!list.includes(3224) && !list.includes(4460))
})

test('那支队查不着就一条不写，只留队号，不上屏错名字', () => {
  const view = parse(
    body({
      ourHps: [50, 50, 50, 50, 50, 50],
      enemy: 5,
      support: { api_deck_id: 4, api_ship_id: [711, 202], api_damage: [0, 0, 0, 0, 0] },
    }),
    // 中途启动 kuma：编队还没进 state
    { ...ctxWith(), fleetShips: () => [] },
  )
  assert.deepEqual(supportStage(view).support, { deckId: 4, shipMstIds: [] })
})

// ---- 伤害数组下标 ----

test('KC3 抓包样例：12 项落到敌舰位 0 / 4 / 10', () => {
  const view = parse(
    body({
      ourHps: [50, 50, 50, 50, 50, 50],
      enemy: 6,
      enemyEscort: 6,
      support: {
        api_deck_id: 3,
        api_ship_id: [],
        api_damage: [11, 0, 0, 0, 39.1, 0, 0, 0, 0, 0, 21, 0],
      },
    }),
    ctxWith({ combinedType: 0 }),
  )
  assert.deepEqual(supportHits(view), [[0, 11], [4, 39], [10, 21]])
})

test('本机真样本形态：12 项非零在下标 2 与 10，落到敌主力 #2 与护卫 #4', () => {
  const view = parse(
    body({
      ourHps: [50, 50, 50, 50, 50, 50],
      enemy: 6,
      enemyEscort: 6,
      support: {
        api_deck_id: 3,
        api_ship_id: [],
        api_damage: [0, 0, 37, 0, 0, 0, 0, 0, 0, 0, 149, 0],
      },
    }),
    ctxWith(),
  )
  assert.deepEqual(supportHits(view), [[2, 37], [10, 149]])
  const escort = view.eShips.find((ship) => ship.index === 10)
  assert.equal(escort.fleet, 'escort')
  assert.equal(escort.position, 4)
})

test('现行 0 基形态（长度 = 敌舰位数）：下标就是舰位，多目标一格不落', () => {
  const view = parse(
    body({
      ourHps: [50, 50, 50, 50, 50, 50],
      enemy: 6,
      support: { api_deck_id: 4, api_ship_id: [], api_damage: [12, 0, 0, 34, 0, 56] },
    }),
    ctxWith(),
  )
  assert.deepEqual(supportHits(view), [[0, 12], [3, 34], [5, 56]])
})

test('定长 7 槽 + 敌 6 舰：多出来的尾槽不把整条挪位', () => {
  // 这条形状正是老判据的陷阱：长度 7 = 敌舰位数 6 + 1，会被误判成 1 基。
  const view = parse(
    body({
      ourHps: [50, 50, 50, 50, 50, 50],
      enemy: 6,
      support: { api_deck_id: 4, api_ship_id: [], api_damage: [12, 0, 0, 34, 0, 56, 0] },
    }),
    ctxWith(),
  )
  assert.deepEqual(supportHits(view), [[0, 12], [3, 34], [5, 56]])
})

test('敌联合多带一槽（apilist 记的 [13]）：落位照旧，尾槽只是补零', () => {
  const view = parse(
    body({
      ourHps: [50, 50, 50, 50, 50, 50],
      enemy: 6,
      enemyEscort: 6,
      support: {
        api_deck_id: 4,
        api_ship_id: [],
        api_damage: [0, 0, 37, 0, 0, 0, 0, 0, 0, 0, 149, 0, 0],
      },
    }),
    ctxWith(),
  )
  assert.deepEqual(supportHits(view), [[2, 37], [10, 149]])
})

// ---- 编成形态 ----

test('7 舰游击部队 + 敌 5 舰单队：支援打中的三条一条不少, 第四号照样结算', () => {
  const view = parse(
    body({
      ourHps: [50, 50, 50, 50, 50, 50, 50],
      enemy: 5,
      support: { api_deck_id: 4, api_ship_id: SUPPORT_DECK.map(([r]) => r), api_damage: [0, 70, 0, 60, 0] },
    }),
    ctxWith({ mainSize: 7 }),
  )
  assert.equal(view.fShips.length, 7, '游击部队第 7 舰要建得出来')
  assert.deepEqual(supportHits(view), [[1, 70], [3, 60]])
  const fourth = view.eShips.find((ship) => ship.index === 3)
  assert.equal(fourth.hpEnd, 0)
  assert.equal(fourth.sunk, true)
  // 成员名单与我方编成规模无关：支援队是另一支队
  assert.deepEqual(supportStage(view).support.shipMstIds, SUPPORT_DECK.map(([, m]) => m))
})

// ---- 真报文判死样本 ----

test('真报文：敌 5 舰配定长 7 项, 五艘全灭且与 api_dests 对得上账', () => {
  const one = JSON.parse(
    fs.readFileSync(new URL('./fixtures/support-shelling-fixed-slots.json', import.meta.url), 'utf8'),
  )
  const view = parseBattle(one.path, structuredClone(one.battle), ctxWith({ supportDeckId: 2, mainSize: 7 }), 0)

  // 这一场全场只有支援 + 砲击战一巡，敌 5 舰入场 [48,35,35,35,35]
  assert.deepEqual(view.eShips.map((ship) => ship.hpStart), [48, 35, 35, 35, 35])
  assert.equal(view.fShips.length, 7, '我方是 7 舰游击部队')

  // 支援 damage = [0, 91.1, 6, 0, 131, 0, 0]：按下标落位，不让开前导占位
  assert.deepEqual(supportHits(view), [[1, 91], [2, 6], [4, 131]])

  // 按 1 基读会只沉 3 艘（#1 余 29、#4 满血）——那正是玩家截图里的错账
  assert.deepEqual(view.eShips.map((ship) => ship.hpEnd), [0, 0, 0, 0, 0])
  assert.equal(view.eShips.filter((ship) => ship.sunk).length, one.result.api_dests)
  assert.equal(view.prediction.rank, one.result.api_win_rank)
  // 我方一滴血没掉，这一场是完全胜利
  assert.equal(view.prediction.fTaken, 0)
  assert.equal(view.prediction.perfect, true)
})

test('12 舰联合：支援伤害数组仍按敌方逐位排, 与我方编成规模无关', () => {
  const b = body({
    ourHps: [50, 50, 50, 50, 50, 50],
    enemy: 5,
    support: { api_deck_id: 4, api_ship_id: [], api_damage: [0, 0, 0, 45, 0] },
  })
  b.api_f_nowhps_combined = [40, 40, 40, 40, 40, 40]
  b.api_f_maxhps_combined = [40, 40, 40, 40, 40, 40]
  const view = parse(b, ctxWith({ combinedType: 1 }))
  assert.equal(view.fShips.length, 12)
  assert.deepEqual(supportHits(view), [[3, 45]])
})
