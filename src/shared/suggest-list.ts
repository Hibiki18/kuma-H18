/**
 * 自绘联想下拉的纯逻辑：候选过滤、条数上限、高亮环绕。
 *
 * **不碰任何 DOM 与 node 内建**——渲染层（组合实验室的装备格 / 舰娘框）要 import 它，
 * 而渲染层的打包目标是 browser。真正画浮层的是 renderer/modules/ji-lab-suggest.ts。
 *
 * 会挪到这里，是因为这三件事错了都不报错、只是候选看着不对：
 * 上限少切一条、环绕少绕一圈、别名没进匹配（输日文原名搜不出东西），
 * 在真机上要一条条试才发现。
 */

export interface SuggestEntry {
  /** 选中后填回输入框的字面值。回填口径由调用方定，这里只负责搬 */
  value: string
  /** 候选行的主文本；缺省 = value（舰娘那份的 value 尾巴带 Lv 与编号，不适合当主文本） */
  label?: string
  /** 参与匹配、但不单独显示的别名。装备与舰娘都拿它收日文原名 */
  alias?: string
  /** 候选行右侧的小字：装备类别 / 舰娘等级与编号 */
  hint?: string
}

export interface SuggestPage {
  items: SuggestEntry[]
  /** 还有没列出来的：被上限切掉过 */
  truncated: boolean
  /** 这一页是「还没输字时的预览」而不是真过滤结果 */
  preview: boolean
}

/** 匹配用的归一：大小写不敏感、忽略空白。舰娘那份的 value 里本来就带空格 */
export const normalizeSuggestQuery = (text: string): string =>
  text.toLowerCase().replace(/\s+/g, '')

/** 一条候选参与匹配的两块干草堆：填回去的那串字 + 别名 */
const haystacksOf = (entry: SuggestEntry): string[] =>
  entry.alias ? [entry.value, entry.alias] : [entry.value]

/** 命中位置（越靠前越像玩家要的那条）；没命中给 -1 */
const matchAt = (entry: SuggestEntry, query: string): number => {
  let best = -1
  for (const hay of haystacksOf(entry)) {
    const at = normalizeSuggestQuery(hay).indexOf(query)
    if (at >= 0 && (best < 0 || at < best)) best = at
  }
  return best
}

/**
 * 按输入过滤候选。
 *
 * 输入为空时**不铺全量**：装备库上千条，全铺一次既卡又没法看。给前 `preview` 条预览，
 * 顺序照数据源自己的（装备按主数据 id、舰娘按等级降序），玩家点一下就能看见列表在动。
 *
 * 命中位置靠前的排前面，同位置的保持数据源原序（Array.sort 在 V8 上是稳定的）——
 * 搜「12cm」时一串前缀命中会按装备 id 排好，不会被中段命中插队。
 */
export const filterSuggestions = (
  entries: readonly SuggestEntry[],
  raw: string,
  limits: { limit: number; preview: number },
): SuggestPage => {
  const query = normalizeSuggestQuery(raw)
  if (!query) {
    return {
      items: entries.slice(0, limits.preview),
      truncated: entries.length > limits.preview,
      preview: true,
    }
  }
  const hits: { entry: SuggestEntry; at: number }[] = []
  for (const entry of entries) {
    const at = matchAt(entry, query)
    if (at >= 0) hits.push({ entry, at })
  }
  hits.sort((a, b) => a.at - b.at)
  return {
    items: hits.slice(0, limits.limit).map((hit) => hit.entry),
    truncated: hits.length > limits.limit,
    preview: false,
  }
}

/**
 * 上下键挪高亮，两头环绕。
 *
 * 一条候选都没有时给 -1（没有可选中的东西，回车也不该落到第 0 条上）。
 * 高亮还没落下（-1）时按 ↓ 落到第一条、按 ↑ 落到最后一条。
 */
export const moveSuggestActive = (active: number, count: number, delta: number): number => {
  if (count <= 0) return -1
  const from = active >= 0 && active < count ? active : delta > 0 ? -1 : 0
  return (((from + delta) % count) + count) % count
}
