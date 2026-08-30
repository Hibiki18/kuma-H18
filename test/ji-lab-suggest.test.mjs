// 组合实验室的自绘联想下拉（2026-08-30 玩家两条反馈的合并修复）：
//   ① 原生 <datalist> 的弹层鼠标滚轮滚不动（那层没有 DOM，挂不上监听）；
//   ② 它由系统绘制、不吃页面 CSS，深色主题下是一片白底。
//
// 能脱开 DOM 测的是过滤/上限/环绕这三件——它们错了都**不报错**，只是候选看着不对：
// 上限少切一条、环绕少绕一圈、别名没进匹配（照日文原名输进去搜不出东西），
// 真机上要一条条试才发现。浮层的摆位与键位接线不在这份护栏里：那两样要真 DOM 才验得了。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import suggest from '../dist/shared/suggest-list.js'

const { filterSuggestions, moveSuggestActive, normalizeSuggestQuery } = suggest

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

const LIMITS = { limit: 40, preview: 12 }
/** 装备那份的形状：译名当字面值，日文原名当别名，类别当小字 */
const equip = (value, alias, hint) => ({ value, alias, hint })

test('译名与日文原名都收：照哪一种输进去都搜得出来', () => {
  const entries = [
    equip('12cm单装炮', '12cm単装砲', '小口径主炮'),
    equip('25mm三联装机枪', '25mm三連装機銃', '对空机枪'),
    equip('九三式水中听音机', '九三式水中聴音機', '声呐'),
  ]
  const byLocal = filterSuggestions(entries, '机枪', LIMITS)
  assert.deepEqual(byLocal.items.map((e) => e.value), ['25mm三联装机枪'])
  // 别名只参与匹配、不单独显示，但输日文原名照样命中同一条
  const byJapanese = filterSuggestions(entries, '機銃', LIMITS)
  assert.deepEqual(byJapanese.items.map((e) => e.value), ['25mm三联装机枪'])
  // 大小写与空白不影响命中：舰娘那份的字面值本来就带空格（「雪风 Lv98 #12」）
  assert.equal(normalizeSuggestQuery(' 12CM 单装 '), '12cm单装')
  assert.deepEqual(
    filterSuggestions(entries, ' 12CM ', LIMITS).items.map((e) => e.value),
    ['12cm单装炮'],
  )
})

test('命中位置靠前的排前面，同一位置保持数据源自己的顺序', () => {
  const entries = [
    equip('探照灯'),
    equip('九六式舰战'),
    equip('舰战烈风'),
    equip('零式舰战21型'),
    equip('二式舰战'),
  ]
  const page = filterSuggestions(entries, '舰战', LIMITS)
  // 「舰战烈风」是零位命中，压过后面几条中段命中；
  // 同样落在第 2 位的两条按数据源原序（装备那份是主数据 id 序）排，不互相插队
  assert.deepEqual(
    page.items.map((e) => e.value),
    ['舰战烈风', '零式舰战21型', '二式舰战', '九六式舰战'],
  )
  assert.equal(page.truncated, false)
  assert.equal(page.preview, false)
})

test('一条都没匹配上时给空数组，而不是回落成全量', () => {
  const entries = [equip('探照灯'), equip('照明弹')]
  const page = filterSuggestions(entries, '不存在的东西', LIMITS)
  assert.deepEqual(page.items, [])
  assert.equal(page.truncated, false)
})

test('上限：切到 limit 条并说明还有更多', () => {
  const entries = Array.from({ length: 57 }, (_, i) => equip(`主炮${i}`))
  const page = filterSuggestions(entries, '主炮', { limit: 40, preview: 12 })
  assert.equal(page.items.length, 40)
  assert.equal(page.truncated, true)
  // 恰好等于上限的那一档不算截断：说「只列前 40 条」而实际列全了是假话
  const exact = filterSuggestions(entries.slice(0, 40), '主炮', { limit: 40, preview: 12 })
  assert.equal(exact.items.length, 40)
  assert.equal(exact.truncated, false)
})

test('空输入不铺全量：只给 preview 条预览，且标明这是预览', () => {
  const entries = Array.from({ length: 900 }, (_, i) => equip(`装备${i}`))
  const page = filterSuggestions(entries, '   ', LIMITS)
  assert.equal(page.preview, true)
  assert.equal(page.items.length, 12)
  assert.equal(page.truncated, true)
  // 预览按数据源自己的顺序取头几条，不重排
  assert.deepEqual(page.items.slice(0, 3).map((e) => e.value), ['装备0', '装备1', '装备2'])
  // 全库还没到 preview 条时列全，也就不该说「前 12 件」
  const few = filterSuggestions(entries.slice(0, 5), '', LIMITS)
  assert.equal(few.items.length, 5)
  assert.equal(few.truncated, false)
})

test('上下键环绕：两头都绕得回去，空列表不给任何下标', () => {
  assert.equal(moveSuggestActive(-1, 3, 1), 0) // 还没选中时按 ↓ 落到第一条
  assert.equal(moveSuggestActive(-1, 3, -1), 2) // 按 ↑ 落到最后一条
  assert.equal(moveSuggestActive(0, 3, 1), 1)
  assert.equal(moveSuggestActive(2, 3, 1), 0) // 末条再往下绕回头
  assert.equal(moveSuggestActive(0, 3, -1), 2) // 首条再往上绕到尾
  assert.equal(moveSuggestActive(0, 0, 1), -1) // 一条候选都没有
  assert.equal(moveSuggestActive(0, 0, -1), -1)
  // 上一批候选留下的越界下标不许生效：回车会填到玩家没看过的那一条上
  assert.equal(moveSuggestActive(9, 3, 1), 0)
})

test('两份 datalist 与 list= 都退场了，联想改由自绘浮层接管', () => {
  const lab = read('src/renderer/modules/ji-lab.ts')
  assert.doesNotMatch(lab, /<datalist/, '还留着原生 datalist')
  assert.doesNotMatch(lab, /\blist="/, '输入框还挂着 list= 指向 datalist')
  // 名字反查的口径没跟着一起重写：候选与回填共用同一份索引
  assert.match(lab, /const equipIdByName = \(name: string\): number =>/)
  assert.match(lab, /const suggestFieldOf =/)
})

test('浮层挂 body，样式选择器也就不带面板前缀', () => {
  const overlay = read('src/renderer/modules/ji-lab-suggest.ts')
  const html = read('src/renderer/index.html')
  // 面板既裁 overflow 又是 transform 包含块：挂在里面 absolute 被裁、fixed 飞出屏幕
  assert.match(overlay, /document\.body\.appendChild\(host\)/)
  assert.match(html, /#ji-lab-suggest \{[^}]*position: fixed/)
  assert.doesNotMatch(html, /\.mod-ji #ji-lab-suggest/)
  // 滚轮能滚的那一层：候选表自己是个 overflow:auto 的容器
  assert.match(html, /#ji-lab-suggest \.ls-list \{ max-height: \d+px; overflow-y: auto; \}/)
})
