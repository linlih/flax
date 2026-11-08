// 笔记的同步。笔记是磁盘上的 .md 文件（Obsidian 也能直接改），这里通过 NoteFiles 读写，不关心文件怎么存。
// 标题、关联论文、删除按字段"晚的赢"；正文用版本向量判断两边是不是同时改了：
//   一边包含另一边的全部修改 → 直接用新的；
//   同时改了 → 从上次同步的版本（base）出发按行三方合并；改了同一行 → 本机保留自己的，另存一份冲突副本。
import type { SqlDb } from '../library'
import { merge3 } from './diff3'
import type { Hlc } from './hlc'
import { maxStamp, mergeRecord, stampChanges, vvCovers, vvMerge, type SyncRecord } from './record'
import type { Outgoing, SyncStore } from './store'

export interface NoteDoc {
  id: string
  title: string
  paperId?: string
  createdAt: string
  body: string
}

export interface NoteFiles {
  all(): NoteDoc[]
  /** 新建或覆盖；标题和别的笔记重名时可以自己改一下 */
  put(doc: NoteDoc): void
  remove(id: string): void
}

const docData = (n: NoteDoc): Record<string, unknown> => {
  const d: Record<string, unknown> = { id: n.id, title: n.title, createdAt: n.createdAt, body: n.body }
  if (n.paperId) d['paperId'] = n.paperId
  return d
}

const toDoc = (d: Record<string, unknown>): NoteDoc => {
  const n: NoteDoc = { id: String(d['id']), title: typeof d['title'] === 'string' && d['title'] ? d['title'] : '未命名笔记', createdAt: typeof d['createdAt'] === 'string' ? d['createdAt'] : new Date().toISOString(), body: typeof d['body'] === 'string' ? d['body'] : '' }
  if (typeof d['paperId'] === 'string' && d['paperId']) n.paperId = d['paperId']
  return n
}

export function createNoteSyncStore(db: SqlDb, deviceId: string, files: NoteFiles, tx: <T>(fn: () => T) => T, uuid: () => string, conflictTitle: (title: string) => string = (t) => `${t}（冲突副本）`): SyncStore {
  const getShadow = (id: string) => {
    const r = db.prepare("SELECT rec, base FROM sync_shadow WHERE kind = 'note' AND id = ?").get(id) as { rec: string; base: string | null } | undefined
    return r ? { rec: JSON.parse(r.rec) as SyncRecord, base: r.base ?? '' } : null
  }
  const save = (rec: SyncRecord, base?: string) => {
    db.prepare("INSERT INTO sync_shadow (kind, id, rec, updated_at, base) VALUES ('note', ?, ?, '', ?) ON CONFLICT(kind, id) DO UPDATE SET rec = excluded.rec, base = COALESCE(excluded.base, sync_shadow.base)").run(rec.id, JSON.stringify(rec), base ?? null)
  }
  const queue = (id: string) => db.prepare("INSERT INTO sync_outbox (kind, id) VALUES ('note', ?) ON CONFLICT(kind, id) DO UPDATE SET ver = ver + 1").run(id)

  const collect = (hlc: Hlc) => {
    const seen = new Set<string>()
    for (const n of files.all()) {
      seen.add(n.id)
      const sh = getShadow(n.id)
      const prev = sh?.rec ?? null
      const d = docData(n)
      const bodyChanged = !prev || prev.d['body'] !== n.body
      const rec = stampChanges('note', prev, d, false, () => hlc.tick())
      if (!rec) continue
      rec.id = n.id
      if (bodyChanged) rec.vv = { ...(prev?.vv ?? {}), [deviceId]: (prev?.vv?.[deviceId] ?? 0) + 1 }
      save(rec, prev ? undefined : '')
      queue(n.id)
    }
    // 本机删掉的笔记
    const rows = db.prepare("SELECT id, rec FROM sync_shadow WHERE kind = 'note'").all() as { id: string; rec: string }[]
    for (const r of rows) {
      if (seen.has(r.id)) continue
      const prev = JSON.parse(r.rec) as SyncRecord
      if (prev.del) continue
      const rec = stampChanges('note', prev, prev.d, true, () => hlc.tick())
      if (rec) {
        save(rec)
        queue(r.id)
      }
    }
  }

  return {
    kinds: ['note'],
    collect: (hlc) => tx(() => collect(hlc)),
    pending() {
      const rows = db.prepare("SELECT o.id, o.ver, s.rec FROM sync_outbox o JOIN sync_shadow s ON s.kind = 'note' AND s.id = o.id WHERE o.kind = 'note'").all() as { id: string; ver: number; rec: string }[]
      return rows.map((r) => ({ rec: JSON.parse(r.rec) as SyncRecord, token: `${r.id}\n${r.ver}` }))
    },
    sent(items: Outgoing[]) {
      tx(() => {
        for (const it of items) {
          const [id, ver] = it.token.split('\n') as [string, string]
          const gone = db.prepare("DELETE FROM sync_outbox WHERE kind = 'note' AND id = ? AND ver = ?").run(id, Number(ver)) as { changes?: number }
          // 传上去的正文就是下一次三方合并的基础版本
          if (gone.changes !== 0) db.prepare("UPDATE sync_shadow SET base = ? WHERE kind = 'note' AND id = ?").run(String(it.rec.d['body'] ?? ''), id)
        }
      })
    },
    apply(recs, hlc) {
      return tx(() => {
        collect(hlc)
        let n = 0
        for (const remote of recs) {
          if (remote.k !== 'note' || typeof remote.id !== 'string' || !remote.d) continue
          hlc.observe(maxStamp(remote))
          const sh = getShadow(remote.id)
          const incoming: SyncRecord = { ...remote, d: { ...remote.d, id: remote.id } }
          if (!sh) {
            const rec = JSON.parse(JSON.stringify(incoming)) as SyncRecord
            if (!rec.del) files.put(toDoc(rec.d))
            save(rec, String(rec.d['body'] ?? ''))
            n++
            continue
          }
          const local = sh.rec
          const merged = mergeRecord(local, incoming) ?? (JSON.parse(JSON.stringify(local)) as SyncRecord)
          const L = String(local.d['body'] ?? '')
          const R = String(incoming.d['body'] ?? '')
          let body = L
          let forked = false
          if (vvCovers(local.vv, incoming.vv)) body = L
          else if (vvCovers(incoming.vv, local.vv)) body = R
          else {
            const m = merge3(sh.base, L, R)
            if (m !== null) body = m
            else {
              // 改了同一处：本机保留自己的，远端的那份存成冲突副本（它会作为一篇新笔记同步出去）
              files.put({ ...toDoc(incoming.d), id: uuid(), title: conflictTitle(String(incoming.d['title'] ?? local.d['title'] ?? '笔记')), body: R })
            }
            forked = true
          }
          merged.d['body'] = body
          merged.vv = vvMerge(local.vv, incoming.vv)
          if (forked) {
            merged.vv[deviceId] = (merged.vv[deviceId] ?? 0) + 1
            merged.c['body'] = hlc.tick()
          }
          const before = JSON.stringify(local)
          if (JSON.stringify(merged) === before) continue
          const changedLocally = merged.del !== local.del || body !== L || merged.d['title'] !== local.d['title'] || merged.d['paperId'] !== local.d['paperId']
          if (merged.del) {
            if (!local.del) files.remove(remote.id)
          } else if (changedLocally) files.put(toDoc(merged.d))
          save(merged, body)
          if (forked) queue(remote.id)
          if (changedLocally) n++
        }
        // 刚写的文件可能因为重名改了标题，这里记下来，下次同步时发出去
        collect(hlc)
        return n
      })
    },
    snapshot() {
      const rows = db.prepare("SELECT rec FROM sync_shadow WHERE kind = 'note'").all() as { rec: string }[]
      return rows.map((r) => JSON.parse(r.rec) as SyncRecord)
    },
    reset() {
      tx(() => {
        db.prepare("DELETE FROM sync_shadow WHERE kind = 'note'").run()
        db.prepare("DELETE FROM sync_outbox WHERE kind = 'note'").run()
      })
    }
  }
}
