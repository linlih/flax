// AI 对话的同步：每个对话一条记录，记录里带着全部消息。
// 标题、属于哪篇论文、删除按字段"晚的赢"（和论文一样）；消息只追加，两边的消息按 id 取并集、按时间排。
// 删掉的对话另一边又问了一句：仍然是删掉的，消息照样合进来，恢复以后都在。
import type { SqlDb } from '../library'
import { byTime, type Conversations, type StoredTurn } from '../conversations'
import { isoMs, type Hlc } from './hlc'
import { maxStamp, mergeRecord, stampChanges, type SyncRecord } from './record'
import type { Outgoing, SyncStore } from './store'

const KIND = 'conversation'

type Row = { id: string; data: string; deleted: number; updated_at: string; rec: string | null }

const isTurn = (t: unknown): t is StoredTurn => {
  const o = t as Record<string, unknown> | null
  return !!o && typeof o['id'] === 'string' && (o['role'] === 'user' || o['role'] === 'assistant') && typeof o['text'] === 'string' && typeof o['at'] === 'string'
}

/** 记录去掉消息，剩下按字段合并的部分 */
function head(r: SyncRecord): SyncRecord {
  const { turns: _t, ...d } = r.d
  return { ...r, d, c: Object.fromEntries(Object.entries(r.c).filter(([k]) => k !== 'turns')) }
}

/**
 * 两边的消息合在一起：按 id 去重，按时间排；时间一样的，本地的在前、远端的按它自己的顺序。
 * 纯函数，测试直接用
 */
export function mergeTurns(local: StoredTurn[], remote: unknown): StoredTurn[] {
  const seen = new Set(local.map((t) => t.id))
  const extra = (Array.isArray(remote) ? remote : []).filter((t): t is StoredTurn => isTurn(t) && !seen.has(t.id) && (seen.add(t.id), true))
  return [...local, ...extra].sort(byTime)
}

export function createConversationSyncStore(db: SqlDb, conv: Conversations, tx: <T>(fn: () => T) => T): SyncStore {
  const saveShadow = (rec: SyncRecord, at: string) =>
    db.prepare('INSERT INTO sync_shadow (kind, id, rec, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET rec = excluded.rec, updated_at = excluded.updated_at').run(KIND, rec.id, JSON.stringify(rec), at)
  const queue = (id: string) => db.prepare('INSERT INTO sync_outbox (kind, id) VALUES (?, ?) ON CONFLICT(kind, id) DO UPDATE SET ver = ver + 1').run(KIND, id)

  const collect = (hlc: Hlc) => {
    const rows = db
      .prepare(`SELECT t.id, t.data, t.deleted, t.updated_at, s.rec FROM ai_conversations t LEFT JOIN sync_shadow s ON s.kind = ? AND s.id = t.id WHERE s.id IS NULL OR s.updated_at <> t.updated_at`)
      .all(KIND) as Row[]
    for (const r of rows) {
      let d: Record<string, unknown>
      try {
        d = JSON.parse(r.data) as Record<string, unknown>
      } catch {
        continue
      }
      const prev = r.rec ? (JSON.parse(r.rec) as SyncRecord) : null
      const at = isoMs(r.updated_at)
      const rec = stampChanges(KIND, prev && head(prev), d, !!r.deleted, () => hlc.tick(at))
      const turns = conv.turns(r.id)
      const before = new Set((Array.isArray(prev?.d['turns']) ? (prev!.d['turns'] as StoredTurn[]) : []).map((t) => t.id))
      const newTurns = turns.some((t) => !before.has(t.id))
      if (rec || newTurns) {
        const out = rec ?? head(prev!)
        out.id = r.id
        out.d['turns'] = turns
        saveShadow(out, r.updated_at)
        queue(r.id)
      } else if (prev) saveShadow(prev, r.updated_at)
    }
  }

  return {
    kinds: [KIND],
    collect: (hlc) => tx(() => collect(hlc)),
    pending() {
      const rows = db.prepare('SELECT o.id, o.ver, s.rec FROM sync_outbox o JOIN sync_shadow s ON s.kind = o.kind AND s.id = o.id WHERE o.kind = ?').all(KIND) as { id: string; ver: number; rec: string }[]
      return rows.map((r) => ({ rec: JSON.parse(r.rec) as SyncRecord, token: `${r.id}\n${r.ver}` }))
    },
    sent(items: Outgoing[]) {
      tx(() => {
        for (const it of items) {
          const [id, ver] = it.token.split('\n') as [string, string]
          db.prepare('DELETE FROM sync_outbox WHERE kind = ? AND id = ? AND ver = ?').run(KIND, id, Number(ver))
        }
      })
    },
    apply(recs, hlc) {
      return tx(() => {
        // 先把本机还没记下的修改记下来，免得被远端的值盖掉
        collect(hlc)
        let n = 0
        for (const remote of recs) {
          if (remote.k !== KIND || typeof remote.id !== 'string' || !remote.d || typeof remote.d !== 'object') continue
          hlc.observe(maxStamp(remote))
          const sh = db.prepare('SELECT rec FROM sync_shadow WHERE kind = ? AND id = ?').get(KIND, remote.id) as { rec: string } | undefined
          const local = sh ? head(JSON.parse(sh.rec) as SyncRecord) : null
          const merged = mergeRecord(local, { ...head(remote), d: { ...head(remote).d, id: remote.id } })
          const have = conv.turns(remote.id)
          const all = mergeTurns(have, remote.d['turns'])
          if (!merged && all.length === have.length) continue
          const h = merged ?? local!
          const d = h.d
          const data = {
            id: remote.id,
            paperId: typeof d['paperId'] === 'string' ? d['paperId'] : '',
            title: typeof d['title'] === 'string' && d['title'] ? d['title'] : '对话',
            createdAt: typeof d['createdAt'] === 'string' ? d['createdAt'] : (all[0]?.at ?? new Date().toISOString())
          }
          const at = conv.stamp(remote.id)
          db.prepare(
            `INSERT INTO ai_conversations (id, paper_id, data, updated_at, deleted) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET paper_id = excluded.paper_id, data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted`
          ).run(remote.id, data.paperId, JSON.stringify(data), at, h.del ? 1 : 0)
          const known = new Set(have.map((t) => t.id))
          for (const t of all) if (!known.has(t.id)) conv.insertTurn(remote.id, t)
          if (h.del) db.prepare('UPDATE ai_current SET conv_id = NULL WHERE conv_id = ?').run(remote.id)
          saveShadow({ ...h, id: remote.id, d: { ...h.d, turns: conv.turns(remote.id) } }, at)
          n++
        }
        return n
      })
    },
    snapshot() {
      const rows = db.prepare('SELECT rec FROM sync_shadow WHERE kind = ?').all(KIND) as { rec: string }[]
      return rows.map((r) => JSON.parse(r.rec) as SyncRecord)
    },
    reset() {
      tx(() => {
        db.prepare('DELETE FROM sync_shadow WHERE kind = ?').run(KIND)
        db.prepare('DELETE FROM sync_outbox WHERE kind = ?').run(KIND)
      })
    }
  }
}
