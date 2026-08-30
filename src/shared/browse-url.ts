// 浏览窗的落点：主页那一条，与地址栏里敲进来的那一行怎么判。
//
// 与游戏页面网址（shared/game-url）**分开两份**：那一条管游戏本体加载哪里，
// 玩家配一次就不再动；这一条是浏览窗开在哪，他每分钟都在改（他就是来逛的）。
// 合成一份的后果是「改了游戏网址，浏览窗跟着搬家」，那不是他要的。
//
// 只收 http / https。地址栏是个自由文本框，而它后面那层网页与游戏共用
// defaultSession（kanso-cache:// 就注册在这个会话上），file: / javascript:
// 不该从这里进得来。

/**
 * 主页按钮与新开一扇窗时的落点：DMM 的舰C 详情页。
 *
 * 取这一条而不是别的：
 *  · 不取 `play.games.dmm.com/game/kancolle`（游戏本体）——本体在主窗跑着，
 *    默认再开一份就是同一个账号双开，而浏览窗那份没有抓包桥，等于白玩；
 *  · 不取 `www.dmm.com/netgame/`——那是旧门户，舰C 早搬到 games.dmm.com
 *    （仓内 assets/preload/page-align.js 认的就是 games.dmm.com/detail/kancolle）；
 *  · 不取 games.dmm.com 根——门户首页会先撞年龄/分区选择，不适合当默认落点。
 * 详情页同时是官方お知らせ / メンテ情報 的落点（「边玩边查」），
 * 它自己的导航条又能通到整个 DMM GAMES 门户（「逛 DMM」），一条兼了两头。
 */
export const BROWSE_HOME_URL = 'https://games.dmm.com/detail/kancolle'

/**
 * 地址栏那一行能不能拿去导航：认得出就返回真正要加载的那条，认不出返回 null。
 *
 * **认不出时不替他猜**。猜错的代价是他以为打开了某一页、其实去了别处，
 * 而地址栏上又写着他自己敲的那行字——错在哪根本看不出来。
 * 唯一的补全是「少了协议」：`games.dmm.com/...` 是最常犯的那种手滑。
 */
export const normalizeBrowseInput = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return null
  const accept = (candidate: string): string | null => {
    try {
      const { protocol } = new URL(candidate)
      return protocol === 'http:' || protocol === 'https:' ? candidate : null
    } catch (_e) {
      // 解析不出来就是不能导航，这个 catch 是判据本身的一半
      return null
    }
  }
  const direct = accept(text)
  if (direct) return direct
  // 已经写着协议样子的一律不补：补了会把 `javascript:alert(1)` 变成
  // `https://javascript:alert(1)`，看着像个网址，其实哪也去不了。
  // 代价是 `localhost:8080` 这种也算「写了协议」，得自己带上 http://。
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return null
  // 没有点的东西不像主机名。「舰これ 攻略」这种是想搜，不是想导航——
  // 浏览窗不带搜索引擎（那是一处新的第三方出口），所以原地不动，别乱跳。
  if (!/^[^\s/?#]+\.[^\s/?#]+/.test(text)) return null
  return accept(`https://${text}`)
}
