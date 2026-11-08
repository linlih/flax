// 文献库表（论文、文件夹、批注、术语、标签颜色）的同步。
// 不改原来的写法：每张表都有 updated_at，和 sync_shadow 里记的不一样就是本机改过，
// 这时和 shadow 比出哪些字段变了，打上时间戳。合并远端记录后把 updated_at 同时写进表和 shadow，就不会被当成本机修改。
import type { SqlDb } from '../library'
import { normalizeTitle } from '../text'
import { isoMs, type Hlc } from './hlc'
import { maxStamp, mergeRecord, stampChanges, type SyncKind, type SyncRecord } from './record'
import type { Outgoing, SyncStore } from './store'

interface Spec {
  table: string
  /** 只属于这台设备、不同步的字段 */
  local: string[]
  write(db: SqlDb, d: Record<string, unknown>, deleted: number, updatedAt: string): void
}

const str = (v: unknown, def = ''): string => (typeof v === 'string' ? v : def)

type LibKind = Exclude<SyncKind, 'note' | 'conversation'>

const SPECS: Record<LibKind, Spec> = {
  paper: {
    table: 'papers',
    local: ['readingPosition'],
    write(db, d, deleted, at) {
      const ids = (d['identifiers'] ?? {}) as { doi?: string; arxiv?: string }
      db.prepare(
        `INSERT INTO papers (id, data, title_norm, doi, arxiv, added_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, title_norm = excluded.title_norm, doi = excluded.doi, arxiv = excluded.arxiv,
         updated_at = excluded.updated_at, deleted = excluded.deleted`
      ).run(str(d['id']), JSON.stringify(d), normalizeTitle(str(d['title'])), ids.doi?.toLowerCase() ?? null, ids.arxiv ?? null, str(d['addedAt'], at), at, deleted)
      const files = Array.isArray(d['files']) ? (d['files'] as { hash?: unknown }[]) : []
      for (const f of files) if (typeof f.hash === 'string') db.prepare('INSERT OR REPLACE INTO files (hash, paper_id) VALUES (?, ?)').run(f.hash, str(d['id']))
    }
  },
  folder: {
    table: 'folders',
    local: [],
    write(db, d, deleted, at) {
      db.prepare('INSERT INTO folders (id, data, updated_at, deleted) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted').run(str(d['id']), JSON.stringify(d), at, deleted)
    }
  },
  annotation: {
    table: 'annotations',
    local: [],
    write(db, d, deleted, at) {
      db.prepare(
        `INSERT INTO annotations (id, paper_id, file_hash, data, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET paper_id = excluded.paper_id, file_hash = excluded.file_hash, data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted`
      ).run(str(d['id']), str(d['paperId']), str(d['fileHash']), JSON.stringify(d), at, deleted)
    }
  },
  term: {
    table: 'terms',
    local: [],
    write(db, d, deleted, at) {
      const norm = str(d['term']).trim().replace(/\s+/g, ' ').toLowerCase()
      db.prepare('INSERT INTO terms (id, term_norm, data, updated_at, deleted) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET term_norm = excluded.term_norm, data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted').run(str(d['id']), norm, JSON.stringify(d), at, deleted)
    }
  },
  tagColor: {
    table: 'tag_colors',
    local: [],
    write(db, d, deleted, at) {
      db.prepare('INSERT INTO tag_colors (id, data, updated_at, deleted) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted').run(str(d['id']), JSON.stringify(d), at, deleted)
    }
  }
}

/** 每次修改都会变、本身没有意义的字段 */
const BOOKKEEPING = ['updatedAt', 'deviceId']

/** 远端来的论文缺字段时补上，免得界面拿到不完整的记录 */
function fillPaper(d: Record<string, unknown>, at: string): void {
  if (typeof d['title'] !== 'string' || !d['title']) d['title'] = '未命名论文'
  for (const k of ['authors', 'files', 'folderIds', 'tags']) if (!Array.isArray(d[k])) d[k] = []
  if (!d['identifiers'] || typeof d['identifiers'] !== 'object') d['identifiers'] = {}
  if (typeof d['readingStatus'] !== 'string') d['readingStatus'] = 'inbox'
  if (typeof d['addedAt'] !== 'string') d['addedAt'] = at
  if (typeof d['metadataSource'] !== 'string') d['metadataSource'] = 'user'
  if (typeof d['needsMatch'] !== 'boolean') d['needsMatch'] = false
}

export const LIBRARY_SYNC_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sync_shadow (kind TEXT NOT NULL, id TEXT NOT NULL, rec TEXT NOT NULL, updated_at TEXT NOT NULL, base TEXT, PRIMARY KEY (kind, id));
  CREATE TABLE IF NOT EXISTS sync_outbox (kind TEXT NOT NULL, id TEXT NOT NULL, ver INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (kind, id));
  CREATE TABLE IF NOT EXISTS sync_files (hash TEXT PRIMARY KEY);
`

type Row = { id: string; data: string; deleted: number; updated_at: string; rec: string | null }

export function createLibrarySyncStore(db: SqlDb, deviceId: string, tx: <T>(fn: () => T) => T, now: () => string = () => new Date().toISOString()): SyncStore {
  const kinds = Object.keys(SPECS) as LibKind[]

  const strip = (kind: LibKind, data: Record<string, unknown>) => {
    const d = { ...data }
    for (const k of [...BOOKKEEPING, ...SPECS[kind].local]) delete d[k]
    return d
  }
  const saveShadow = (kind: SyncKind, rec: SyncRecord, at: string) =>
    db.prepare('INSERT INTO sync_shadow (kind, id, rec, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET rec = excluded.rec, updated_at = excluded.updated_at').run(kind, rec.id, JSON.stringify(rec), at)
  const queue = (kind: SyncKind, id: string) =>
    db.prepare('INSERT INTO sync_outbox (kind, id) VALUES (?, ?) ON CONFLICT(kind, id) DO UPDATE SET ver = ver + 1').run(kind, id)

  const collect = (hlc: Hlc) => {
    for (const kind of kinds) {
      const { table } = SPECS[kind]
      const rows = db
        .prepare(`SELECT t.id, t.data, t.deleted, t.updated_at, s.rec FROM ${table} t LEFT JOIN sync_shadow s ON s.kind = ? AND s.id = t.id WHERE s.id IS NULL OR s.updated_at <> t.updated_at`)
        .all(kind) as Row[]
      for (const r of rows) {
        let data: Record<string, unknown>
        try {
          data = JSON.parse(r.data) as Record<string, unknown>
        } catch {
          continue
        }
        const prev = r.rec ? (JSON.parse(r.rec) as SyncRecord) : null
        const at = isoMs(r.updated_at)
        const rec = stampChanges(kind, prev, strip(kind, data), !!r.deleted, () => hlc.tick(at))
        if (rec) {
          rec.id = r.id
          saveShadow(kind, rec, r.updated_at)
          queue(kind, r.id)
        } else if (prev) saveShadow(kind, prev, r.updated_at)
      }
    }
  }

  return {
    kinds,
    collect: (hlc) => tx(() => collect(hlc)),
    pending() {
      const rows = db
        .prepare(`SELECT o.kind, o.id, o.ver, s.rec FROM sync_outbox o JOIN sync_shadow s ON s.kind = o.kind AND s.id = o.id WHERE o.kind IN (${kinds.map(() => '?').join(',')})`)
        .all(...kinds) as { kind: string; id: string; ver: number; rec: string }[]
      return rows.map((r) => ({ rec: JSON.parse(r.rec) as SyncRecord, token: `${r.kind}\n${r.id}\n${r.ver}` }))
    },
    sent(items: Outgoing[]) {
      tx(() => {
        for (const it of items) {
          const [kind, id, ver] = it.token.split('\n') as [string, string, string]
          db.prepare('DELETE FROM sync_outbox WHERE kind = ? AND id = ? AND ver = ?').run(kind, id, Number(ver))
        }
      })
    },
    apply(recs, hlc) {
      return tx(() => {
        // 先把本机还没记下的修改记下来，免得被远端的值盖掉
        collect(hlc)
        let n = 0
        for (const remote of recs) {
          if (!(remote.k in SPECS) || typeof remote.id !== 'string' || !remote.d || typeof remote.d !== 'object') continue
          const kind = remote.k as LibKind
          const spec = SPECS[kind]
          hlc.observe(maxStamp(remote))
          const sh = db.prepare('SELECT rec FROM sync_shadow WHERE kind = ? AND id = ?').get(kind, remote.id) as { rec: string } | undefined
          const local = sh ? (JSON.parse(sh.rec) as SyncRecord) : null
          const merged = mergeRecord(local, { ...remote, d: { ...remote.d, id: remote.id } })
          if (!merged) continue
          const at = now()
          const row = db.prepare(`SELECT data FROM ${spec.table} WHERE id = ?`).get(remote.id) as { data: string } | undefined
          const old = row ? (JSON.parse(row.data) as Record<string, unknown>) : {}
          const data: Record<string, unknown> = { ...merged.d, id: remote.id, updatedAt: at, deviceId: maxStamp(merged).split('-').slice(2).join('-') || deviceId }
          for (const k of spec.local) if (k in old) data[k] = old[k]
          if (kind === 'paper') fillPaper(data, at)
          spec.write(db, data, merged.del ? 1 : 0, at)
          saveShadow(kind, merged, at)
          n++
        }
        return n
      })
    },
    snapshot() {
      const rows = db.prepare(`SELECT rec FROM sync_shadow WHERE kind IN (${kinds.map(() => '?').join(',')})`).all(...kinds) as { rec: string }[]
      return rows.map((r) => JSON.parse(r.rec) as SyncRecord)
    },
    reset() {
      tx(() => {
        db.prepare(`DELETE FROM sync_shadow WHERE kind IN (${kinds.map(() => '?').join(',')})`).run(...kinds)
        db.prepare(`DELETE FROM sync_outbox WHERE kind IN (${kinds.map(() => '?').join(',')})`).run(...kinds)
      })
    }
  }
}

