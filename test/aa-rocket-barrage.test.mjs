import assert from 'node:assert/strict'
import test from 'node:test'

import barrageModule from '../dist/shared/aa-rocket-barrage.js'
import abilityModule from '../dist/shared/ship-special-attack.js'

const { canRocketBarrage, rocketBarrageOf } = barrageModule
const { ROCKET_LAUNCHER_K2_MST_ID } = abilityModule

// 舰与装备的数值取自 poi `views/utils/combat/__tests__/aapb.spec.ts` 的同一组样本
// （2026-08-30 取），这样两边算出来的率能直接对数，不必各自编一套。
//   伊勢改二 mstId 553 · stype 10（航空戦艦）· ctype 2（伊勢型）
//   素対空 = master 初始対空 48 + 近代化改修 api_kyouka[2] 36 = 84，運 12
const iseK2 = (over = {}) => ({ stype: 10, ctype: 2, baseAntiAir: 84, luck: 12, ...over })

const equip = (over = {}) => ({ mstId: 0, type2: 0, iconId: 0, antiAir: 0, asw: 0, level: 0, ...over })

// 12cm30連装噴進砲改二：api_type [4,29,21,15,0] → 大分类 21（対空機銃）、图标 15，素対空 8。
// 素対空 ≥ 8，所以改修走机铳的 6 系数那一档。
const rocketK2 = (level = 0) =>
  equip({ mstId: ROCKET_LAUNCHER_K2_MST_ID, type2: 21, iconId: 15, antiAir: 8, level })
// 13号対空電探改：小型電探、対空 4、样本里带 ★6——电探那一档没有改修项，★6 不该进数
const aaRadar = (level = 6) => equip({ type2: 12, iconId: 11, antiAir: 4, level })
// 10cm高角砲＋高射装置：图标 16 的高角炮、対空 10（≥8 → 改修系数 3）、样本里带 ★10
const haMount = (level = 10) => equip({ iconId: 16, antiAir: 10, level })

test('喷二的装备 id 就是主数据里的 274，测试跟着常量走而不是另抄一个数', () => {
  assert.equal(ROCKET_LAUNCHER_K2_MST_ID, 274)
})

test('可发动舰种只有航巡/轻母/航战/正规空母/水母/装甲空母，其余舰种带满喷二也不发动', () => {
  for (const stype of [6, 7, 10, 11, 16, 18]) assert.equal(canRocketBarrage(stype), true, `stype ${stype}`)
  // 驱逐 2 / 轻巡 3 / 重巡 5（不带航空）/ 戦艦 9 / 潜水 13 都不在名单里
  for (const stype of [1, 2, 3, 5, 8, 9, 12, 13, 14, 17, 19, 20, 21, 22]) {
    assert.equal(canRocketBarrage(stype), false, `stype ${stype}`)
  }
  // 未改造的伊勢是戦艦（stype 9）：舰级对上了也不发动，条件收在舰种上
  const ise = rocketBarrageOf(iseK2({ stype: 9 }), [rocketK2(), rocketK2()])
  assert.equal(ise.eligible, false)
  assert.equal(ise.rate, null)
  // 舰种不符时连加重対空都不该报出来，免得界面拿它当「差一点就发动」显示
  assert.equal(ise.weightedAntiAir, null)
})

test('舰种对了但没带喷二：eligible 仍是 true，率是 null——两件事分开报', () => {
  const outcome = rocketBarrageOf(iseK2(), [aaRadar(), haMount(), haMount()])
  assert.equal(outcome.eligible, true)
  assert.equal(outcome.rate, null)
  assert.equal(outcome.rocketCount, 0)
  assert.equal(outcome.baseRate, null)
})

test('伊勢改二 两根喷二 + 対空電探 + 高角炮两门，与 poi aapb.spec.ts 同一个数', () => {
  // 素対空 84 ／ 喷二 6×8 + 6×√0 = 48（两根）／ 電探 3×4 = 12（★6 不进数）
  // ／ 高角炮 4×10 + 3×√10（两门）
  const raw = 84 + 2 * 48 + 12 + 2 * (4 * 10 + 3 * Math.sqrt(10))
  const expected = ((2 * Math.floor(raw / 2) + 0.9 * 12) * 100) / 281 + 15 * (2 - 1) + 25
  const outcome = rocketBarrageOf(iseK2(), [rocketK2(), rocketK2(), aaRadar(), haMount(), haMount()])
  assert.equal(outcome.rate, expected)
  assert.equal(outcome.weightedAntiAir, 2 * Math.floor(raw / 2))
  assert.equal(outcome.rocketCount, 2)
  assert.equal(outcome.extraRocketBonus, 15)
  assert.equal(outcome.iseBonus, 25)
})

test('单根不叠加、非伊勢型不给 25——同样照 poi 那条样本', () => {
  const raw = 84 + 48
  const expected = ((2 * Math.floor(raw / 2) + 0.9 * 12) * 100) / 281
  const outcome = rocketBarrageOf(iseK2({ ctype: 6 }), [rocketK2()])
  assert.equal(outcome.rate, expected)
  assert.equal(outcome.extraRocketBonus, 0)
  assert.equal(outcome.iseBonus, 0)
})

test('第二根起每根 +15：一根→两根→三根，两次差值都正好是 15', () => {
  // 同一艘、同一批装备，只加喷二根数。喷二自己也进加重対空，所以差值不是纯 15——
  // 把加重対空那一截减掉之后才是 15，这里用 baseRate 拆开对。
  const ship = iseK2({ ctype: 6 })
  const one = rocketBarrageOf(ship, [rocketK2()])
  const two = rocketBarrageOf(ship, [rocketK2(), rocketK2()])
  const three = rocketBarrageOf(ship, [rocketK2(), rocketK2(), rocketK2()])
  assert.equal(one.extraRocketBonus, 0)
  assert.equal(two.extraRocketBonus, 15)
  assert.equal(three.extraRocketBonus, 30)
  assert.equal(two.rate - two.baseRate, 15)
  assert.equal(three.rate - three.baseRate, 30)
  // 多带一根同时也把加重対空抬高，总率的涨幅必然大于 15
  assert.ok(two.rate - one.rate > 15)
})

test('伊勢型 +25：同舰同配装只换舰级，差值正好 25', () => {
  const equips = [rocketK2(), aaRadar()]
  const ise = rocketBarrageOf(iseK2(), equips)
  const other = rocketBarrageOf(iseK2({ ctype: 6 }), equips)
  assert.equal(ise.iseBonus, 25)
  assert.equal(other.iseBonus, 0)
  assert.equal(ise.rate - other.rate, 25)
})

test('加重対空要过 2×⌊X/2⌋ 这一步：X 落在奇数上会被抹平到下一个偶数', () => {
  // 素対空 85 + 喷二 48 = 133（奇数）→ 132
  const odd = rocketBarrageOf(iseK2({ baseAntiAir: 85, ctype: 6 }), [rocketK2()])
  assert.equal(odd.weightedAntiAir, 132)
  // 素対空 84 + 48 = 132（偶数）→ 原样。两者加重対空相同，率也就相同
  const even = rocketBarrageOf(iseK2({ baseAntiAir: 84, ctype: 6 }), [rocketK2()])
  assert.equal(even.weightedAntiAir, 132)
  assert.equal(odd.rate, even.rate)
})

test('改修：机铳/高角炮/高射装置吃 √★，电探不吃', () => {
  const ship = iseK2({ ctype: 6 })
  // 喷二 ★10：6×8 + 6×√10，比 ★0 多 6√10
  const plain = rocketBarrageOf(ship, [rocketK2(0)])
  const starred = rocketBarrageOf(ship, [rocketK2(10)])
  assert.equal(plain.weightedAntiAir, 2 * Math.floor((84 + 48) / 2))
  assert.equal(starred.weightedAntiAir, 2 * Math.floor((84 + 48 + 6 * Math.sqrt(10)) / 2))
  assert.ok(starred.rate > plain.rate)
  // 电探那一档没有改修项：★0 与 ★10 一模一样
  const radarPlain = rocketBarrageOf(ship, [rocketK2(), aaRadar(0)])
  const radarStarred = rocketBarrageOf(ship, [rocketK2(), aaRadar(10)])
  assert.equal(radarStarred.rate, radarPlain.rate)
  // 高射装置（大分类 36）：4×対空 + 2×√★
  const aaFd = (level) => equip({ type2: 36, antiAir: 7, level })
  const fd = rocketBarrageOf(ship, [rocketK2(), aaFd(9)])
  assert.equal(fd.weightedAntiAir, 2 * Math.floor((84 + 48 + 4 * 7 + 2 * 3) / 2))
})

test('与加重対空无关的装备一概记 0，不靠白名单漏进来', () => {
  const ship = iseK2({ ctype: 6 })
  const bare = rocketBarrageOf(ship, [rocketK2()])
  // 主炮（大分类 3）、水上电探（电探但对空 0）、舰攻（大分类 8）都不进加重対空
  const withJunk = rocketBarrageOf(ship, [
    rocketK2(),
    equip({ type2: 3, iconId: 2, antiAir: 0, level: 10 }),
    equip({ type2: 12, iconId: 11, antiAir: 0, level: 10 }),
    equip({ type2: 8, iconId: 8, antiAir: 0, level: 10 }),
  ])
  assert.equal(withJunk.rate, bare.rate)
})
