// AI 对话：每篇论文可以有好几个对话，存在数据库里。ai_conversations 一行一个对话，ai_messages 一行一条消息。
// 消息只追加、不改；同步时两台设备各加的消息合在一起，按时间排（见 sync/conversationStore.ts）。
// "现在开着哪个对话"只属于这台设备，存在 ai_current，不同步。
import type { AiChatTurn, AiConversationSummary, AiProviderKind } from './ai/types'
import type { SqlDb } from './library'

export interface StoredTurn extends AiChatTurn {
  id: string
  /** 服务原样返回的内容（含思考块），同一个模型时原样发回去 */
  raw?: unknown
  rawProvider?: AiProviderKind
}

export interface Conversation {
  id: string
  paperId: string
  title: string
  createdAt: string
  /** 最后一条消息的时间；还没有消息时是 createdAt */
  updatedAt: string
  turns: StoredTurn[]
}

export type NewTurn = Omit<StoredTurn, 'id'>

export const CONVERSATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ai_conversations (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS ai_conversations_paper ON ai_conversations(paper_id);
  CREATE TABLE IF NOT EXISTS ai_messages (id TEXT PRIMARY KEY, conv_id TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS ai_messages_conv ON ai_messages(conv_id, at);
  CREATE TABLE IF NOT EXISTS ai_current (paper_id TEXT PRIMARY KEY, conv_id TEXT);
`

/** 对话本身的字段（不含消息），同步时按字段合并 */
export interface ConversationHead {
  id: string
  paperId: string
  title: string
  createdAt: string
}

const isTurn = (t: unknown): t is StoredTurn => {
  const o = t as Record<string, unknown> | null
  return !!o && typeof o['id'] === 'string' && (o['role'] === 'user' || o['role'] === 'assistant') && typeof o['text'] === 'string' && typeof o['at'] === 'string'
}

/** 消息的顺序：按时间；同一毫秒里问题在回答前面，再按 id。两台设备同一毫秒各问了一句时，排出来的顺序也一样 */
export const byTime = (a: { at: string; role: string; id: string }, b: { at: string; role: string; id: string }): number =>
  a.at !== b.at ? (a.at < b.at ? -1 : 1) : a.role !== b.role ? (a.role === 'user' ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0

export class Conversations {
  constructor(
    private db: SqlDb,
    private tx: <T>(fn: () => T) => T,
    private now: () => string,
    private uuid: () => string
  ) {}

  /** 这篇论文的全部对话（不含删掉的），最近的在前 */
  list(paperId: string): AiConversationSummary[] {
    const rows = this.db
      .prepare(
        `SELECT c.data, (SELECT MAX(at) FROM ai_messages m WHERE m.conv_id = c.id) AS last,
                (SELECT COUNT(*) FROM ai_messages m WHERE m.conv_id = c.id AND json_extract(m.data, '$.role') = 'user') AS questions
         FROM ai_conversations c WHERE c.paper_id = ? AND c.deleted = 0`
      )
      .all(paperId) as { data: string; last: string | null; questions: number }[]
    return rows
      .map((r) => {
        const h = JSON.parse(r.data) as ConversationHead
        return { id: h.id, title: h.title, updatedAt: r.last && r.last > h.createdAt ? r.last : h.createdAt, questions: Number(r.questions) }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** 一个对话和它的全部消息；删掉了或者不是这篇论文的返回 null */
  get(id: string, paperId?: string): Conversation | null {
    const row = this.db.prepare('SELECT data, paper_id FROM ai_conversations WHERE id = ? AND deleted = 0').get(id) as { data: string; paper_id: string } | undefined
    if (!row || (paperId !== undefined && row.paper_id !== paperId)) return null
    const h = JSON.parse(row.data) as ConversationHead
    const turns = this.turns(id)
    const last = turns[turns.length - 1]?.at
    return { ...h, updatedAt: last && last > h.createdAt ? last : h.createdAt, turns }
  }

  turns(convId: string): StoredTurn[] {
    const rows = this.db.prepare('SELECT data FROM ai_messages WHERE conv_id = ?').all(convId) as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as StoredTurn).sort(byTime)
  }

  /** 这台设备上开着的对话；null 是"新对话、还没问" */
  current(paperId: string): string | null {
    const row = this.db.prepare('SELECT conv_id FROM ai_current WHERE paper_id = ?').get(paperId) as { conv_id: string | null } | undefined
    const id = row?.conv_id ?? null
    return id && this.get(id, paperId) ? id : null
  }

  setCurrent(paperId: string, id: string | null): void {
    this.db.prepare('INSERT INTO ai_current (paper_id, conv_id) VALUES (?, ?) ON CONFLICT(paper_id) DO UPDATE SET conv_id = excluded.conv_id').run(paperId, id)
  }

  create(paperId: string, title: string, at = this.now(), id = this.uuid()): Conversation {
    const head: ConversationHead = { id, paperId, title, createdAt: at }
    this.db.prepare('INSERT INTO ai_conversations (id, paper_id, data, updated_at) VALUES (?, ?, ?, ?)').run(id, paperId, JSON.stringify(head), this.now())
    return { ...head, updatedAt: at, turns: [] }
  }

  /** 加一条消息。对话删掉了就不加，返回 null */
  append(convId: string, turn: NewTurn): StoredTurn | null {
    return this.tx(() => {
      const row = this.db.prepare('SELECT 1 FROM ai_conversations WHERE id = ? AND deleted = 0').get(convId)
      if (!row) return null
      const t: StoredTurn = { ...turn, id: this.uuid() }
      this.insertTurn(convId, t)
      this.touch(convId)
      return t
    })
  }

  rename(id: string, title: string): void {
    const row = this.db.prepare('SELECT data FROM ai_conversations WHERE id = ? AND deleted = 0').get(id) as { data: string } | undefined
    if (!row) return
    const h = JSON.parse(row.data) as ConversationHead
    if (h.title === title) return
    this.db.prepare('UPDATE ai_conversations SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify({ ...h, title }), this.stamp(id), id)
  }

  /** 软删除，同步时别的设备也删掉；消息留着，删除被撤回时还在 */
  remove(id: string): void {
    this.tx(() => {
      this.db.prepare('UPDATE ai_conversations SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0').run(this.stamp(id), id)
      this.db.prepare('UPDATE ai_current SET conv_id = NULL WHERE conv_id = ?').run(id)
    })
  }

  /**
   * 读入以前存在 ai/conversations/<论文>.json 的对话（桌面 0.1.4 之前）。
   * 两种格式：version 2 是 { current, conversations: [...] }；最早的 version 1 只有一个对话 { turns }。
   * 可以重复读：对话和消息的 id 是固定的，已经有的跳过。返回读进来的对话数
   */
  importLegacy(paperId: string, json: unknown): number {
    const j = (json && typeof json === 'object' ? json : {}) as { current?: unknown; conversations?: unknown; turns?: unknown }
    type Legacy = { id: string; title: string; createdAt: string; turns: unknown[] }
    let convs: Legacy[] = []
    let current: string | null = null
    if (Array.isArray(j.conversations)) {
      convs = (j.conversations as Legacy[]).filter((c) => c && typeof c.id === 'string' && Array.isArray(c.turns))
      current = typeof j.current === 'string' && convs.some((c) => c.id === j.current) ? j.current : null
    } else if (Array.isArray(j.turns) && j.turns.length) {
      const turns = j.turns as { role?: string; text?: string; quote?: string; at?: string }[]
      const first = turns.find((t) => t.role === 'user')
      const at = turns[0]?.at ?? this.now()
      convs = [{ id: `legacy-${paperId}`, title: titleFor(first?.text ?? '对话', first?.quote), createdAt: at, turns }]
      current = convs[0]!.id
    }
    return this.tx(() => {
      let n = 0
      for (const c of convs) {
        if (this.db.prepare('SELECT 1 FROM ai_conversations WHERE id = ?').get(c.id)) continue
        const turns = c.turns
          .map((t, i) => ({ ...(t as object), id: `${c.id}-${i}` }))
          .filter(isTurn)
        const createdAt = typeof c.createdAt === 'string' ? c.createdAt : (turns[0]?.at ?? this.now())
        this.create(paperId, typeof c.title === 'string' && c.title ? c.title : '对话', createdAt, c.id)
        for (const t of turns) this.insertTurn(c.id, t)
        n++
      }
      if (n && !this.db.prepare('SELECT 1 FROM ai_current WHERE paper_id = ?').get(paperId)) this.setCurrent(paperId, current)
      return n
    })
  }

  // —— 给同步用 ——

  insertTurn(convId: string, t: StoredTurn): void {
    this.db.prepare('INSERT OR IGNORE INTO ai_messages (id, conv_id, at, data) VALUES (?, ?, ?, ?)').run(t.id, convId, t.at, JSON.stringify(t))
  }

  /** 改过的对话的 updated_at 一定和上次不一样，同步才认得出来（同一毫秒里改两次也是） */
  stamp(id: string): string {
    const row = this.db.prepare('SELECT updated_at FROM ai_conversations WHERE id = ?').get(id) as { updated_at: string } | undefined
    const now = this.now()
    if (!row || row.updated_at < now) return now
    const t = Date.parse(row.updated_at)
    return Number.isFinite(t) ? new Date(t + 1).toISOString() : now
  }

  private touch(id: string): void {
    this.db.prepare('UPDATE ai_conversations SET updated_at = ? WHERE id = ?').run(this.stamp(id), id)
  }
}

/** 对话的默认标题：第一个问题。问题太短（"这是什么意思？"）时带上问的那段原文 */
export function titleFor(question: string, quote?: string): string {
  const cut = (s: string, n: number) => {
    const t = s.replace(/\s+/g, ' ').trim()
    return [...t].length > n ? [...t].slice(0, n).join('') + '…' : t
  }
  const q = cut(question, 40)
  return quote && [...q].length < 12 ? `「${cut(quote, 16)}」${q}` : q
}
