// 同步的记录和合并规则。每条记录的每个字段单独记时间戳（HLC），合并时字段级别晚的赢；
// 标签、文件夹这类集合字段，每个元素单独记"加上 / 去掉"的时间，两边各加一个就都保留。
// 删除也是一个字段（_del），所以"删了以后另一台设备又改了"时仍然是删除状态，恢复后改动都在。
import type { HlcStamp } from './hlc'

export type SyncKind = 'paper' | 'folder' | 'annotation' | 'term' | 'tagColor' | 'note' | 'conversation'

export interface SyncRecord {
  k: SyncKind
  id: string
  /** 记录的内容（去掉了只属于本机的字段） */
  d: Record<string, unknown>
  del: boolean
  /** 字段 → 时间戳。集合字段的元素写成 "tags/元素"，删除标记是 "_del" */
  c: Record<string, HlcStamp>
  /** 笔记正文的版本向量（设备 → 改过几次），用来判断两边是不是同时改了 */
  vv?: Record<string, number>
}

/** 集合字段：按元素合并 */
export const SET_FIELDS: Partial<Record<SyncKind, string[]>> = { paper: ['tags', 'folderIds'] }

/** 字典字段：每个键单独记时间戳，比如每台设备各自的阅读位置（键是设备 id），两台设备各写各的，不会互相盖掉 */
export const MAP_FIELDS: Partial<Record<SyncKind, string[]>> = { paper: ['positions'] }

function asMap(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

const DEL = '_del'

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

function asList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/**
 * 本机改过的记录：和上次同步时的样子（shadow）比，变了的字段打上新的时间戳。
 * 没有 shadow 就是新记录，每个字段都打。什么都没变返回 null
 */
export function stampChanges(kind: SyncKind, prev: SyncRecord | null, d: Record<string, unknown>, del: boolean, tick: () => HlcStamp): SyncRecord | null {
  const sets = SET_FIELDS[kind] ?? []
  const maps = MAP_FIELDS[kind] ?? []
  const c: Record<string, HlcStamp> = { ...(prev?.c ?? {}) }
  let changed = !prev
  const stampNow = (key: string) => {
    c[key] = tick()
    changed = true
  }
  const keys = new Set([...Object.keys(d), ...Object.keys(prev?.d ?? {})])
  for (const key of keys) {
    if (sets.includes(key)) {
      const before = new Set(asList(prev?.d[key]))
      const after = new Set(asList(d[key]))
      for (const e of new Set([...before, ...after])) if (!prev || before.has(e) !== after.has(e)) stampNow(`${key}/${e}`)
    } else if (maps.includes(key)) {
      const before = asMap(prev?.d[key])
      const after = asMap(d[key])
      for (const e of new Set([...Object.keys(before), ...Object.keys(after)])) if (!prev || !equal(before[e], after[e])) stampNow(`${key}/${e}`)
    } else if (!prev || !equal(prev.d[key], d[key])) stampNow(key)
  }
  if (!prev || prev.del !== del) stampNow(DEL)
  if (!changed) return null
  const rec: SyncRecord = { k: kind, id: prev?.id ?? String(d['id']), d, del, c }
  if (prev?.vv) rec.vv = prev.vv
  return rec
}

/**
 * 把远端的一条记录合进本地。返回合并结果；远端没有更新的字段时返回 null（本地不用写）。
 * 交换律、结合律、幂等都成立：同一条记录收到几次、按什么顺序收到，结果都一样
 */
export function mergeRecord(local: SyncRecord | null, remote: SyncRecord): SyncRecord | null {
  if (!local) return clone(remote)
  const sets = SET_FIELDS[remote.k] ?? []
  const maps = MAP_FIELDS[remote.k] ?? []
  const out = clone(local)
  let changed = false
  for (const [key, stamp] of Object.entries(remote.c)) {
    if (stamp <= (local.c[key] ?? '')) continue
    out.c[key] = stamp
    changed = true
    if (key === DEL) {
      out.del = remote.del
      continue
    }
    const slash = key.indexOf('/')
    const field = slash > 0 ? key.slice(0, slash) : key
    if (slash > 0 && sets.includes(field)) {
      const elem = key.slice(slash + 1)
      const list = asList(out.d[field])
      const want = asList(remote.d[field]).includes(elem)
      out.d[field] = want ? (list.includes(elem) ? list : [...list, elem]) : list.filter((x) => x !== elem)
    } else if (slash > 0 && maps.includes(field)) {
      const k = key.slice(slash + 1)
      const map = { ...asMap(out.d[field]) }
      const theirs = asMap(remote.d[field])
      if (k in theirs) map[k] = clone(theirs[k])
      else delete map[k]
      out.d[field] = map
    } else if (key in remote.d) out.d[key] = clone(remote.d[key])
    else delete out.d[key]
  }
  for (const f of sets) if (!Array.isArray(out.d[f])) out.d[f] = []
  return changed ? out : null
}

/** 本地记录里所有时间戳的最大值（推进本机时钟用） */
export function maxStamp(r: SyncRecord): HlcStamp {
  let m = ''
  for (const s of Object.values(r.c)) if (s > m) m = s
  return m
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)
}

/** 版本向量：a 包含了 b 的全部修改 */
export function vvCovers(a: Record<string, number> = {}, b: Record<string, number> = {}): boolean {
  return Object.entries(b).every(([dev, n]) => (a[dev] ?? 0) >= n)
}

export function vvMerge(a: Record<string, number> = {}, b: Record<string, number> = {}): Record<string, number> {
  const out = { ...a }
  for (const [dev, n] of Object.entries(b)) out[dev] = Math.max(out[dev] ?? 0, n)
  return out
}
