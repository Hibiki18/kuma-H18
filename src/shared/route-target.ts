// 「这趟出击你想走到哪一格」——路线预测的目标点由玩家自己定。
//
// 从前预测拿「打过的 Boss 点」当目标，多血条活动图上就成了反功能：新一段的
// Boss 还没打到时，旧段 Boss 一直占着目标位；而捞船的人本来就会**故意**停在
// 旧段 Boss，跟着攻略进度自动换目标同样不是他要的。所以候选开放整张图的点位，
// 手选优先，没手选时才拿「最近打过的那个 Boss」作默认。

export interface BossSeenCell {
  cell: number
  /** 这个点最近一次遭遇的时间戳 */
  lastTs: number
}

export interface RouteTargetView {
  /** 可选的点位字母（出发点除外），字母序 */
  candidates: string[]
  /** 当前目标点；没手选又没打过 Boss 时为 null，不猜 */
  target: string | null
  /** 目标点是不是自己打过 Boss 的那几格之一 */
  targetIsSeenBoss: boolean
}

export const resolveRouteTarget = (
  spots: Record<string, [number, number, string]>,
  bossSeen: BossSeenCell[] | null | undefined,
  letterOf: (cell: number) => string | null,
  savedChoice: string | null,
): RouteTargetView => {
  const candidates = Object.entries(spots ?? {})
    .filter(([, spot]) => spot?.[2] !== 'start')
    .map(([letter]) => letter)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
  const bossLetters = new Set<string>()
  let latest: { letter: string; ts: number } | null = null
  for (const seen of bossSeen ?? []) {
    const letter = letterOf(seen.cell)
    if (!letter) continue
    bossLetters.add(letter)
    if (!latest || seen.lastTs > latest.ts) latest = { letter, ts: seen.lastTs }
  }
  // 手选只在它还是这张图的点位时才算数：海图包换版、活动图改建之后，
  // 存着的那个字母可能已经不存在了
  const target =
    savedChoice && candidates.includes(savedChoice) ? savedChoice : (latest?.letter ?? null)
  return {
    candidates,
    target,
    targetIsSeenBoss: target != null && bossLetters.has(target),
  }
}
