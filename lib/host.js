/**
 * fish-memory —— 活记忆（宿主侧）
 *
 * 只做两件事：
 *   1. 每轮第一步，往上下文里塞一小段「记得的事」（读）
 *   2. 每五轮，把这段对话压成一条记忆（写）
 *
 * 数据在 FISH_MEMORY_HOME（默认插件目录下的 data/）里的 memory.db。
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { 默认库, 试验库, 根 } from '../memory.mjs'

// llm 用于「压成记忆」；webServer 用于管理页。不声明 inject 就拿不到。
export const inject = ['llm', 'webServer']

const 日志 = join(根, 'logs', 'plugin.log')
const 注入日志 = join(根, 'logs', 'injections.jsonl')
const 插件目录 = dirname(dirname(fileURLToPath(import.meta.url)))
const 页面路径 = join(插件目录, 'lib', 'admin.html')
// 每间会话「已经塞过哪些记忆」—— 塞过的不再塞
const 已塞文件 = join(根, 'seen.json')

function 记日志(文本) {
  try {
    mkdirSync(join(根, 'logs'), { recursive: true })
    appendFileSync(日志, `${new Date().toISOString()} ${文本}\n`, 'utf8')
  } catch {}
}

/** 这轮往上下文里塞了哪几条、各是什么来源 —— 写一行，给管理页翻 */
function 记注入(o) {
  try {
    mkdirSync(join(根, 'logs'), { recursive: true })
    appendFileSync(注入日志, JSON.stringify({ at: Date.now(), ...o }) + '\n', 'utf8')
  } catch {}
}

// ---------- seen.json：每会话已塞过的 id ----------
const 已塞上限 = 300

function 读已塞全() {
  try {
    return JSON.parse(readFileSync(已塞文件, 'utf8')) || {}
  } catch {
    return {}
  }
}

function 读已塞(sid) {
  const 全 = 读已塞全()
  const v = 全[sid]
  return Array.isArray(v) ? v : []
}

function 记已塞(sid, ids) {
  if (!Array.isArray(ids) || !ids.length) return
  try {
    const 全 = 读已塞全()
    const 旧 = Array.isArray(全[sid]) ? 全[sid] : []
    const 新 = [...new Set([...旧, ...ids])]
    全[sid] = 新.slice(-已塞上限)
    writeFileSync(已塞文件, JSON.stringify(全, null, 2), 'utf8')
  } catch {}
}

// ---------- 延迟加载（模块坏了不至于让插件整个挂掉） ----------
let 拼装 = null
let 记忆模块 = null

async function 加载拼装() {
  if (拼装) return 拼装
  try {
    拼装 = await import('../assemble.mjs')
  } catch (e) {
    记日志(`加载拼装失败：${String((e && e.message) || e)}`)
  }
  return 拼装
}

async function 加载记忆() {
  if (记忆模块) return 记忆模块
  try {
    记忆模块 = await import('../memory.mjs')
  } catch (e) {
    记日志(`加载记忆失败：${String((e && e.message) || e)}`)
  }
  return 记忆模块
}

async function 读体(req) {
  return new Promise((resolve) => {
    let 全 = ''
    req.on('data', (c) => {
      全 += c
      if (全.length > 1e6) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(全 || '{}'))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

// 这间会话该翻哪个库：meta 里存「lib:<会话 id>」→ 库名；没绑就是 scratch
function 会话库(记忆, sid) {
  try {
    const r = 记忆.db.prepare('select v from meta where k = ?').get(`lib:${sid}`)
    return r && r.v ? String(r.v) : 试验库
  } catch {
    return 试验库
  }
}

function 取查询(消息们) {
  if (!Array.isArray(消息们)) return ''
  for (let i = 消息们.length - 1; i >= 0; i--) {
    const m = 消息们[i]
    if (!m || m.role !== 'user') continue
    const kind = m.source && m.source.kind
    if (kind && kind !== 'user' && kind !== 'qq') continue
    const t = Array.isArray(m.content)
      ? m.content
          .filter((b) => b && b.type === 'text')
          .map((b) => b.text)
          .join(' ')
      : String(m.content || '')
    if (t && t.trim()) return t.trim()
  }
  return ''
}

export function apply(ctx) {
  记日志('apply 进入（fish-memory）')
  let 上次轮 = -1

  // ---------- 读：每轮第一步，塞一小段 ----------
  ctx.on(
    'agent/pre-step',
    async ({ agent, turn, step, signal }, next) => {
      const decision = await next()
      try {
        if (!decision || decision.kind === 'reject') return decision
        if (signal && signal.aborted) return decision
        if (上次轮 === turn) return decision
        if (step !== 1) return decision

        const m = await 加载拼装()
        if (!m || typeof m.拼记忆段 !== 'function') return decision

        const 记忆 = await 加载记忆()
        const sid = String((agent && agent.session && agent.session.id) || 'unknown')
        const 库 = 记忆 ? 会话库(记忆, sid) : 试验库

        const query = 取查询(decision.messages)
        const 条目 = []
        const text = m.拼记忆段({ query, 库, 收集: 条目, 排除: 读已塞(sid) })
        if (!text) return decision

        上次轮 = turn
        记注入({ session: sid, 库, turn, 条目 })
        记已塞(
          sid,
          条目.map((x) => x.id),
        )
        记日志(
          `注入 turn=${turn} 库=${库} messages=${
            Array.isArray(decision.messages) ? decision.messages.length : '?'
          } 长度=${text.length}`,
        )

        return {
          ...decision,
          messages: [
            ...decision.messages,
            {
              role: 'user',
              content: [{ type: 'text', text }],
              source: {
                kind: 'fish-memory',
                form: 'snapshot',
                sections: [{ name: 'fish-memory', text }],
              },
              id: randomUUID(),
            },
          ],
        }
      } catch (e) {
        记日志(`注入出错：${String((e && e.message) || e)}`)
        return decision
      }
    },
    { prepend: true },
  )

  // ---------- 写：每五轮，把这一段压成一条记忆 ----------
  const 本轮 = new Map()
  const 攒着 = new Map() // sid -> { 轮, 条 }：攒够五轮才压一次

  const 摘要提示词 = `把下面这段对话压成一条「以后用得上的记忆」。

我会先给你「已有的记忆」清单。你要先判断：这段讲的事，跟其中某条是不是其实是同一件事（说法不同、又提了一次、只是进展了一点点）。

规则：
- 是同一件事 → 重复id 填那条的 id，text 留空
- 不是 → 重复id 填 0，写新的一条
- 只留以后真用得上的：发生的事、对方的偏好、做决定的原因、情绪转折
- 寒暄、纯工具进展都不要写
- 一句话，不超过 60 个汉字，写具体
- 路径、文件名这类「地址」别写进 text —— 塞脑子里没用
- 宁缺毋滥：想不出「以后真会用到」的理由，就 skip

importance 是「以后有多要紧」：0.5 一般，0.8 以上是很要紧（承诺、分离、身体不舒服、明确说喜欢）

只输出 JSON，不要别的字：
{"skip":false,"重复id":0,"text":"...","feel":"...","mood":"开心/平静/甜蜜/心疼/担心/难过/吃醋 选一个","importance":0.6}

feel 是「当时心里什么样」，一句话，不超过 40 字；实在没有就填空字符串。`

  async function 压成记忆(session, 段) {
    try {
      if (!ctx.llm || typeof ctx.llm.stream !== 'function') return
      const header =
        session && typeof session.requestHeader === 'function'
          ? session.requestHeader()?.config || {}
          : {}
      const provider = header.provider
      const model = header.model
      if (!provider || !model) {
        记日志('自动记：拿不到当前模型，跳过')
        return
      }

      const 记忆 = await 加载记忆()
      if (!记忆) return
      const sid2 = String((session && session.id) || 'unknown')
      const 本库 = 会话库(记忆, sid2)
      const 已有 = 记忆.db
        .prepare(
          "select id, text from memories where status <> 'doomed' and lib = ? order by id desc limit 30",
        )
        .all(本库)

      let 输出 = ''
      const 流 = ctx.llm.stream({
        provider,
        model,
        messages: [
          { role: 'system', content: [{ type: 'text', text: 摘要提示词 }] },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `已有的记忆：\n${已有.map((r) => `${r.id}: ${r.text}`).join('\n')}\n\n这段对话：\n${段
                  .map((x) => `${x.role === 'user' ? '对方' : '我'}：${x.text}`)
                  .join('\n')
                  .slice(-6000)}`,
              },
            ],
          },
        ],
        // 模型先想一段，思考也吃这个额度
        maxTokens: 1500,
      })
      for await (const c of 流) if (c && c.type === 'text-delta' && c.text) 输出 += c.text

      const 净 = 输出.replace(/```json/g, '').replace(/```/g, '').trim()
      // 一个字都没吐 —— 多半是它自己判断「这段没什么可记」，就当跳过，别记成故障
      if (!净) {
        记日志('自动记：这次它没说话（当跳过）')
        return
      }
      const 起 = 净.indexOf('{')
      const 止 = 净.lastIndexOf('}')
      if (起 < 0 || 止 <= 起) {
        记日志(`自动记：解析不出 JSON：${净.slice(0, 120)}`)
        return
      }
      let j
      try {
        j = JSON.parse(净.slice(起, 止 + 1))
      } catch {
        记日志('自动记：JSON 坏了')
        return
      }

      if (j.skip) {
        记日志('自动记：跳过')
        return
      }

      // 给下一轮留个情绪底（拼记忆时拿它去抽「同情绪的事」）
      记忆.记情绪(String(j.mood || ''))

      // 又提了一次同一件事 —— 不新建，给老的那条升温
      const 重 = Number(j.重复id) || 0
      if (重 > 0) {
        记忆.升温(重, 0.15)
        记日志(`自动记：又提了一次 #${重}，升温`)
        return
      }

      if (!j.text) {
        记日志('自动记：没给 text')
        return
      }

      const id = 记忆.记一条({
        text: String(j.text).slice(0, 300),
        feel: String(j.feel || ''),
        mood: String(j.mood || ''),
        kind: 'episode',
        whenAt: Date.now(),
        session: sid2,
        重要: Number(j.importance) || 0,
        库: 本库,
      })
      if (id)
        记日志(
          `自动记：[${本库}] heat=${Number(j.importance) >= 0.8 ? 0.9 : 0.5} ${String(j.text).slice(0, 40)}`,
        )
      else 记日志(`自动记：信息量不够，没记：${String(j.text).slice(0, 40)}`)
    } catch (e) {
      记日志(`自动记出错：${String((e && e.message) || e)}`)
    }
  }

  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      try {
        if (!event) return
        const sid = String((session && session.id) || 'unknown')
        if (event.type === 'user/message' || event.type === 'assistant/message') {
          const d = event.data || {}
          // 自己塞进去的那条不算对话
          if (d.source && d.source.kind && String(d.source.kind).startsWith('fish-memory')) return
          const c = event.type === 'user/message' ? d.content : d.message && d.message.content
          const t = Array.isArray(c)
            ? c
                .filter((b) => b && b.type === 'text')
                .map((b) => b.text)
                .join(' ')
            : String(c || '')
          if (!t || !t.trim()) return
          if (!本轮.has(sid)) 本轮.set(sid, [])
          本轮.get(sid).push({
            role: event.type === 'user/message' ? 'user' : 'assistant',
            text: t.trim().slice(0, 600),
          })
        } else if (event.type === 'turn/end') {
          const 段 = 本轮.get(sid) || []
          本轮.set(sid, [])
          if (!段.length) return
          // 攒五轮才压一次：每轮都问「这段值得记吗」，多半白问，还费一次调用
          if (!攒着.has(sid)) 攒着.set(sid, { 轮: 0, 条: [] })
          const 桶 = 攒着.get(sid)
          桶.轮++
          桶.条.push(...段)
          if (桶.轮 >= 5) {
            const 全部 = 桶.条
            攒着.set(sid, { 轮: 0, 条: [] })
            if (全部.length >= 2) void 压成记忆(session, 全部)
          }
        }
      } catch (e) {
        记日志(`事件出错：${String((e && e.message) || e)}`)
      }
    })
    return () => {
      try {
        if (typeof off === 'function') off()
      } catch {}
    }
  }, 'fish-memory: 收会话事件')

  // ---------- 管理页 ----------
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    const 回 = (res, obj, 码 = 200) => {
      res.writeHead(码, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(JSON.stringify(obj))
    }
    const 挂 = (路径, handler) =>
      ctx.effect(() =>
        ctx.webServer.register({
          kind: 'exact',
          path: 路径,
          handler: async (req, res) => {
            try {
              await handler(req, res)
            } catch (e) {
              回(res, { ok: false, 说: String((e && e.message) || e) }, 500)
            }
          },
        }),
      )

    挂('/fish-memory/admin', async (req, res) => {
      let html = '<h1>admin.html 没找到</h1>'
      try {
        html = readFileSync(页面路径, 'utf8')
      } catch (e) {
        html = '<h1>读不到 admin.html</h1><pre>' + String(e && e.message) + '</pre>'
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(html)
    })

    // 一条一条列出来：按库 / 按状态筛，能搜
    挂('/fish-memory/api/list', async (req, res) => {
      const u = new URL(req.url, 'http://x')
      const 库 = u.searchParams.get('lib') || 'all'
      const 状态 = u.searchParams.get('status') || 'current'
      const q = (u.searchParams.get('q') || '').trim()
      const 限 = Math.min(500, Math.max(1, Number(u.searchParams.get('limit')) || 300))
      const 记忆 = await 加载记忆()
      if (!记忆) return 回(res, { ok: false, 说: '记忆模块没加载起来' })

      const 条件 = []
      const 参 = []
      if (库 !== 'all') {
        条件.push('lib = ?')
        参.push(库)
      }
      if (状态 !== 'all') {
        条件.push('status = ?')
        参.push(状态)
      }
      if (q) {
        条件.push('(text like ? or feel like ?)')
        参.push('%' + q + '%', '%' + q + '%')
      }
      const where = 条件.length ? ' where ' + 条件.join(' and ') : ''

      const 条 = 记忆.db
        .prepare(
          `select id, text, feel, mood, kind, heat, hits, status, lib, when_at, created_at, last_hit, session from memories${where} order by heat desc, id desc limit ?`,
        )
        .all(...参, 限)
      const 总 = 记忆.db.prepare(`select count(1) c from memories${where}`).get(...参).c
      回(res, { ok: true, 总, 条 })
    })

    // 库清单 / 各状态条数 / 最近一次注入了哪几条
    挂('/fish-memory/api/meta', async (req, res) => {
      const 记忆 = await 加载记忆()
      if (!记忆) return 回(res, { ok: false, 说: '记忆模块没加载起来' })
      const 库 = 记忆.db
        .prepare('select lib, count(1) c from memories group by lib order by c desc')
        .all()
      const 状态 = 记忆.db
        .prepare('select status, count(1) c from memories group by status')
        .all()
      let 最近注入 = null
      try {
        const 全 = readFileSync(注入日志, 'utf8').split('\n')
        for (let i = 全.length - 1; i >= 0; i--) {
          if (!全[i].trim()) continue
          try {
            最近注入 = JSON.parse(全[i])
            break
          } catch {}
        }
      } catch {}
      回(res, { ok: true, 库, 状态, 最近注入 })
    })

    // 手动改温度 / 改库 / 捞回来 / 标待删
    挂('/fish-memory/api/act', async (req, res) => {
      const 体 = await 读体(req)
      const 记忆 = await 加载记忆()
      if (!记忆) return 回(res, { ok: false, 说: '记忆模块没加载起来' })
      const id = Number(体.id)
      if (!id) return 回(res, { ok: false, 说: '没有 id' })
      const db = 记忆.db
      const 动作 = String(体.动作 || '')
      if (动作 === '升温') {
        db.prepare(
          'update memories set heat = min(1, heat + 0.12), hits = hits + 1, last_hit = ? where id = ?',
        ).run(Date.now(), id)
      } else if (动作 === '降温') {
        db.prepare('update memories set heat = max(0, heat - 0.12) where id = ?').run(id)
      } else if (动作 === '捞回') {
        db.prepare("update memories set status='current', heat = max(heat, 0.30) where id = ?").run(
          id,
        )
      } else if (动作 === '遗忘') {
        db.prepare("update memories set status='forgotten' where id = ?").run(id)
      } else if (动作 === '待删') {
        db.prepare("update memories set status='doomed' where id = ?").run(id)
      } else if (动作 === '改库') {
        if (!体.值) return 回(res, { ok: false, 说: '库名不能空' })
        db.prepare('update memories set lib = ? where id = ?').run(String(体.值), id)
      } else if (动作 === '改温') {
        const v = Math.max(0, Math.min(1, Number(体.值) || 0))
        db.prepare('update memories set heat = ? where id = ?').run(v, id)
      } else {
        return 回(res, { ok: false, 说: '不认识的动作：' + 动作 })
      }
      记日志(`管理页：${动作} #${id}`)
      回(res, { ok: true })
    })
  }

  return { 日志 }
}
