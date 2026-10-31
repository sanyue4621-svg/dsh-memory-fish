// fish-memory —— 每轮拼装
//
// 作用：拼出「这一轮该带的记忆」那一段文本，交给插件塞进上下文。
//
// 设计上刻意收得很紧（宁可不塞，也别塞噪音）：
//   · 一轮最多一条（相关 1，随手 0，情绪 0）
//   · 门槛 0.62：热但不贴题的别硬塞
//   · 最近一天记下的不塞（那段原文还在上下文里，塞了是重复）
//   · 塞过的 id 由调用方传 排除 跳掉
//
// 注入的文本本身一个字都不带前缀（别给上下文塞「来源」这种噪音），
// 来源只放进 收集 数组里，界面自己去标。
import { 按情绪抽, 找几条, 捞回来, 最近情绪, 随机一条 } from './memory.mjs'
import { 默认库 } from './memory.mjs'

/**
 * @param {object} opts
 * @param {string} opts.mood        当前情绪（开心/难过/心疼/吃醋…），可以是空
 * @param {string} opts.query       用户刚说的话
 * @param {string} opts.库          从哪个库翻，默认 default
 * @param {number} opts.相关条数    贴题带几条，默认 1
 * @param {number} opts.门槛        相关度门槛，默认 0.62（宁可不塞）
 * @param {number} opts.情绪条数    按情绪抽几条，默认 0
 * @param {number} opts.随手条数    随便翻几条旧的，默认 0
 * @param {Array}  opts.排除        这些 id 不再塞（已经塞过的）
 * @param {number} opts.一天内不塞  这么新以内记下的不塞（毫秒），默认一天
 * @param {Array}  opts.收集        传个数组进来，这轮用到的每条会 push 进去，带来源
 * @returns {string} 拼好的那段；一条都没有返回 ''
 */
export function 拼记忆段({
  mood = '',
  query = '',
  库 = 默认库,
  相关条数 = 1,
  门槛 = 0.62,
  情绪条数 = 0,
  随手条数 = 0,
  排除 = null,
  一天内不塞 = 86400000,
  压缩界 = 0,
  收集 = null,
} = {}) {
  // 没人告诉我这轮什么情绪时，用上一轮压记忆时判的那个
  const 此刻 = mood || 最近情绪()

  const 排除集 = new Set(Array.isArray(排除) ? 排除 : [])
  const 太新 = Date.now() - Number(一天内不塞 || 0)
  // 压缩分界：压缩之前的才塞（压缩之后说的一定还在上下文里）。
  // 没给分界时退回「一天内不塞」。
  const 压界 = Number(压缩界) || 0
  const 能用 = (r) => {
    if (!r || 排除集.has(r.id)) return false
    const 记时 = Number(r.when_at || r.created_at || 0)
    if (压界 > 0) return 记时 < 压界
    return 记时 < 太新
  }

  // 相关的那几条连遗忘区一起搜：沉下去的，提起来还能翻出来。
  // 多要几条再筛（排除的、太新的会占名额），筛完只留 相关条数。
  const 相关 = query
    ? 找几条(query, 相关条数 + 4, 门槛, { 含遗忘: true, 库 }).filter(能用).slice(0, 相关条数)
    : []
  for (const r of 相关) if (r.status === 'forgotten') 捞回来(r.id)

  // 多抽几条备着：跟别的撞车的会被跳过，得留余量
  const 情绪 =
    此刻 && 情绪条数 > 0
      ? 按情绪抽(此刻, 情绪条数 + 相关条数 + 随手条数, 库).filter(能用)
      : []

  const 已用 = new Set()
  const 行 = []

  const push = (r, 来源) => {
    if (!r || 已用.has(r.id)) return false
    已用.add(r.id)
    const 感 = r.feel ? `（当时：${r.feel}）` : ''
    行.push(`- ${r.text}${感}`)
    if (收集) {
      收集.push({
        id: r.id,
        text: r.text,
        feel: r.feel || '',
        mood: r.mood || '',
        heat: Number(r.heat || 0),
        status: r.status || 'current',
        来源,
      })
    }
    return true
  }

  for (const r of 相关) push(r, '顺着话翻的')

  // 情绪那几条排在最后补位：先保证贴题的、最热的都在，剩下的位置再给气氛
  let 情绪用 = 0
  for (const r of 情绪) {
    if (情绪用 >= 情绪条数) break
    if (push(r, '按情绪抽的')) 情绪用++
  }

  // 最后再翻旧的出来 —— 不按热度，瞎抽。这就是「忽然想起来」
  for (let i = 0; i < 随手条数; i++) {
    const r = 随机一条([...已用], 库)
    if (!r || !能用(r) || !push(r, '随手翻的')) break
  }

  if (!行.length) return ''
  return ['【记得的事】', ...行, '', '（不确定就说个大概，留个印象；别硬提）'].join('\n')
}
