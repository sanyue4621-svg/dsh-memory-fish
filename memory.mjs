// fish-memory —— 存储层
//
// 一个 SQLite 文件，三张表：memories（记忆本体）、fts（倒排，按二元词切）、meta（零碎状态）。
//
// 库（lib）是一条记忆的属性：每条记忆属于某个库，翻记忆时按库过滤，不串门。
// 默认库 default；没绑定库的会话走 scratch（试验库，免得把主库弄脏）。
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 数据落哪：环境变量 FISH_MEMORY_HOME，否则插件目录下的 data/ */
export const 根 =
  process.env.FISH_MEMORY_HOME ?? join(dirname(dirname(fileURLToPath(import.meta.url))), 'data')

/** 默认库名 */
export const 默认库 = 'default'
/** 没绑定库的会话用哪个 */
export const 试验库 = 'scratch'

mkdirSync(根, { recursive: true })

export const db = new DatabaseSync(join(根, 'memory.db'))

// 建表（幂等）—— 第一次跑就自己建好，不需要额外的初始化脚本
db.exec(`
  create table if not exists memories (
    id          integer primary key autoincrement,
    kind        text    not null default 'episode',
    text        text    not null,
    feel        text,
    mood        text,
    when_at     integer,
    heat        real    not null default 0.5,
    hits        integer not null default 0,
    last_hit    integer,
    status      text    not null default 'current',
    session     text,
    created_at  integer not null,
    lib         text    not null default '${默认库}'
  );

  create table if not exists fts (
    tokens    text,
    memory_id integer
  );

  create table if not exists meta (
    k text primary key,
    v text
  );

  create index if not exists idx_mem_heat   on memories(heat);
  create index if not exists idx_mem_status on memories(status);
  create index if not exists idx_mem_lib    on memories(lib);
  create index if not exists idx_fts_mid    on fts(memory_id);
`)

const 词表 = (s) => {
  const 净 = String(s || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
    .toLowerCase()
  const out = []
  for (let i = 0; i < 净.length - 1; i++) out.push(净.slice(i, i + 2))
  if (净.length === 1) out.push(净)
  return out.join(' ')
}

/**
 * 记一条。返回 id；被「信息量闸」拦下时返回 null。
 *
 * 两个设计点：
 *   1. 信息量闸 —— 翻来覆去就那几个字的（「哈哈哈」「好的」）不值得占一个位置
 *   2. 重要性直通 —— 要紧的事记下来就是热的，不用从 0.5 慢慢熬
 */
export function 记一条({
  text,
  feel = '',
  mood = '',
  kind = 'episode',
  whenAt = Date.now(),
  session = '',
  重要 = 0,
  库 = 默认库,
}) {
  if (!text || !String(text).trim()) return null
  const 正文 = String(text).slice(0, 400)

  const 种数 = new Set(词表(正文).split(' ').filter(Boolean)).size
  if (种数 < 3) return null

  const now = Date.now()
  const 起点 = Number(重要) >= 0.8 ? 0.9 : 0.5

  const r = db
    .prepare(
      'insert into memories (kind, text, feel, mood, when_at, heat, session, created_at, lib) values (?,?,?,?,?,?,?,?,?)',
    )
    .run(
      kind,
      正文,
      String(feel || '').slice(0, 200),
      String(mood || ''),
      Number(whenAt) || now,
      起点,
      String(session || ''),
      now,
      String(库 || 默认库),
    )
  const id = Number(r.lastInsertRowid)
  db.prepare('insert into fts (tokens, memory_id) values (?,?)').run(词表(正文), id)
  return id
}

/** 升温：被提起一次 */
export function 升温(id, 量 = 0.12) {
  db.prepare(
    'update memories set heat = min(1, heat + ?), hits = hits + 1, last_hit = ? where id = ?',
  ).run(量, Date.now(), id)
}

/**
 * 找几条：关键词 + 温度 + 新鲜度
 * 含遗忘=true 时连遗忘区一起搜 —— 沉下去的不等于没了，提起来还能翻出来
 */
export function 找几条(query, 条数 = 3, 门槛 = 0.3, { 含遗忘 = false, 库 = 默认库 } = {}) {
  const 词 = new Set(词表(query).split(' ').filter(Boolean))
  const 状态 = 含遗忘 ? "status in ('current','forgotten')" : "status='current'"
  const 行 = db
    .prepare(
      `select id, text, feel, mood, kind, heat, when_at, hits, status, created_at from memories where ${状态} and lib = ?`,
    )
    .all(String(库 || 默认库))
  const now = Date.now()
  const 结果 = []
  for (const r of 行) {
    const 记忆词 = new Set(词表(r.text).split(' ').filter(Boolean))
    let 命中 = 0
    for (const w of 词) if (记忆词.has(w)) 命中++
    const 关键词分 = 词.size ? 命中 / 词.size : 0
    const 新鲜 = Math.exp(-(now - (r.when_at || r.created_at || now)) / (14 * 86400000))
    // 已经沉下去的，同样的匹配要打个折 —— 它毕竟凉了
    const 沉的罚 = r.status === 'forgotten' ? 0.75 : 1
    const 分 = (0.5 * 关键词分 + 0.35 * Number(r.heat || 0) + 0.15 * 新鲜) * 沉的罚
    if (分 >= 门槛) 结果.push({ ...r, score: 分 })
  }
  结果.sort((a, b) => b.score - a.score)
  return 结果.slice(0, 条数)
}

/** 从遗忘区捞回来：想起来了，就不算忘。温度抬到退出线之上 */
export function 捞回来(id) {
  db.prepare(
    "update memories set status='current', heat=max(heat, 0.30), hits=hits+1, last_hit=? where id=? and status='forgotten'",
  ).run(Date.now(), id)
}

/**
 * 记下「最近的情绪」。
 * 每轮结束压记忆时判一次，下一轮拼记忆时拿来用 ——
 * 情绪一般不会一轮就翻面，隔一轮够准了，还不用多花一次模型钱。
 */
export function 记情绪(mood) {
  if (!mood || !String(mood).trim()) return
  db.prepare("insert or replace into meta (k, v) values ('最近情绪', ?)").run(String(mood).trim())
}

/** 读最近一次判定的情绪；没有就返回空 */
export function 最近情绪() {
  try {
    const r = db.prepare("select v from meta where k='最近情绪'").get()
    return r && r.v ? String(r.v) : ''
  } catch {
    return ''
  }
}

/** 当前层：温度最高的 N 条（不管关键词，给上下文用） */
export function 当前层(条数 = 10, 库 = 默认库) {
  return db
    .prepare(
      "select id, text, feel, mood, kind, heat, when_at from memories where status='current' and lib = ? order by heat desc, when_at desc limit ?",
    )
    .all(String(库 || 默认库), 条数)
}

/** 按情绪抽一两条 */
export function 按情绪抽(mood, 条数 = 2, 库 = 默认库) {
  return db
    .prepare(
      "select id, text, feel, mood, when_at from memories where status='current' and mood = ? and lib = ? order by heat desc limit ?",
    )
    .all(String(mood || ''), String(库 || 默认库), 条数)
}

/**
 * 随手翻一条 —— 不按热度排，就是「忽然想起来」。
 * 库里一百多条，光靠最热那三条撑着，剩下的永远见不着；这是给它们留的门。
 */
export function 随机一条(排除 = [], 库 = 默认库) {
  const 排 = 排除.length ? `and id not in (${排除.map(() => '?').join(',')})` : ''
  const r = db
    .prepare(
      `select id, text, feel, mood, when_at from memories where status='current' and lib = ? ${排} order by random() limit 1`,
    )
    .get(String(库 || 默认库), ...排除)
  return r || null
}

/**
 * 最近记的几条 —— 短句没命中时垫底用。
 * 你那句话不到八个字、又一条都没搜到，就给最近的两条，别让那一轮空着。
 */
export function 最近几条(条数 = 2, 库 = 默认库) {
  return db
    .prepare(
      "select id, text, feel, mood, when_at from memories where status='current' and lib = ? order by created_at desc limit ?",
    )
    .all(String(库 || 默认库), 条数)
}

/** 这个库有多少条活着的 */
export function 库条数(库 = 默认库) {
  return db
    .prepare("select count(1) c from memories where status='current' and lib = ?")
    .get(String(库 || 默认库)).c
}

/** 所有库的名字和条数 */
export function 库清单() {
  return db
    .prepare('select lib, count(1) c from memories where status=\'current\' group by lib order by c desc')
    .all()
}
