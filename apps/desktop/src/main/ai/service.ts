// AI 问答：只发用户的问题（选中一段问 AI 时带上那段文字），不会自己去读论文。
// 回答按 requestId 流式推给渲染进程；问答记录按论文存成数据目录 ai/conversations 下的 JSON。
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AiChatTurn, AiConfig, AiEvent, AiModel, AiStatus, AiUsage } from '../../shared/api'
import { AiError, makeProvider, translateSystem, type Provider, type Turn } from './providers'
import type { AiSettings } from './settings'

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

interface StoredTurn extends AiChatTurn {
  raw?: unknown
  rawProvider?: Turn['rawProvider']
}

export interface AiServiceDeps {
  dir: string
  settings: AiSettings
  emit: (e: AiEvent) => void
  onStatus: (s: AiStatus) => void
  fetch: FetchLike
  /** 测试时换成假的服务 */
  provider?: (config: AiConfig, key: string | null) => Provider
}

/** 第一次连上时默认选的模型 */
const PREFERRED = ['claude-opus-5-5', 'deepseek-chat']

export class AiService {
  private running = new Map<string, AbortController>()
  /** 每篇论文同一时间只跑一个提问，记录才不会乱 */
  private asking = new Set<string>()
  private modelCache = new Map<string, AiModel[]>()

  constructor(private d: AiServiceDeps) {}

  status(): AiStatus {
    const s = this.d.settings
    return { services: s.services(), selection: s.selection(), ready: s.ready(), canEncrypt: s.canEncrypt(), usage: s.usage() }
  }

  private changed(): AiStatus {
    const st = this.status()
    this.d.onStatus(st)
    return st
  }

  saveService(service: unknown, key?: string | null): string {
    const id = this.d.settings.saveService(service, key)
    this.modelCache.delete(id)
    this.changed()
    return id
  }

  removeService(id: string): void {
    this.d.settings.removeService(id)
    this.modelCache.delete(id)
    this.changed()
  }

  select(sel: unknown): AiStatus {
    this.d.settings.select(sel)
    return this.changed()
  }

  /** 服务的模型列表：同一次运行里缓存，refresh 时重新要。也当作"测试连接"用（不花钱） */
  async models(serviceId: string, refresh = false): Promise<{ ok: true; models: AiModel[] } | { ok: false; message: string }> {
    const cached = this.modelCache.get(serviceId)
    if (cached && !refresh) return { ok: true, models: cached }
    const svc = this.d.settings.service(serviceId)
    if (!svc) return { ok: false, message: '没有这个服务。' }
    if (!this.d.settings.usable(serviceId)) return { ok: false, message: '还没有填 Key。' }
    const conn = this.d.settings.connection({ service: serviceId, model: '' })!
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 20_000)
    try {
      const models = await this.makeProvider(conn.config, conn.key).models(ac.signal)
      if (!models.length) return { ok: false, message: '这家服务没有返回模型列表。' }
      this.modelCache.set(serviceId, models)
      // 第一次连上、还没选过模型：有熟悉的就先选上
      if (!this.d.settings.selection()) {
        const pick = PREFERRED.find((id) => models.some((m) => m.id === id))
        if (pick) this.select({ service: serviceId, model: pick })
      }
      return { ok: true, models }
    } catch (e) {
      return { ok: false, message: e instanceof AiError ? (e.code === 'cancelled' ? '连接超时。' : e.message) : String(e) }
    } finally {
      clearTimeout(t)
    }
  }

  cancel(requestId: string): void {
    this.running.get(requestId)?.abort()
  }

  // —— 单篇问答 ——
  conversation(paperId: string): AiChatTurn[] {
    return this.readTurns(paperId).map(({ raw: _raw, rawProvider: _p, ...t }) => t)
  }

  /** quote：用户在论文里选中、拿来问的那段文字 */
  ask(paperId: string, question: string, quote?: string): string {
    const q = question.trim().slice(0, 8000)
    if (!q) throw new Error('问题是空的')
    if (this.asking.has(paperId)) throw new Error('上一个问题还在回答')
    const turns = this.readTurns(paperId)
    // 模型自己的思考块只能原样发回给同一个模型；换了模型就只发文字
    const model = this.d.settings.selection()?.model
    const quoteText = quote?.replace(/\s+/g, ' ').trim().slice(0, 4000) || undefined
    turns.push({ role: 'user', text: q, quote: quoteText, at: new Date().toISOString() })
    this.writeTurns(paperId, turns)
    // 出错的那一问一答不再发给模型；其余原样按顺序发（历史只追加，不改）
    const history: Turn[] = []
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i]!
      const next = turns[i + 1]
      if (t.role === 'user' && next?.role === 'assistant' && next.error) {
        i++
        continue
      }
      if (t.role === 'assistant' && t.error) continue
      if (t.role === 'user') history.push({ role: 'user', text: t.quote ? `关于论文里的这段文字：「${t.quote}」\n\n${t.text}` : t.text })
      else history.push({ role: 'assistant', text: t.text, raw: t.model === model ? t.raw : undefined, rawProvider: t.rawProvider })
    }
    this.asking.add(paperId)
    return this.start(history, {
      done: (r) => {
        const all = this.readTurns(paperId)
        all.push({ role: 'assistant', text: r.text, raw: r.raw, rawProvider: r.config.provider, model: r.config.model, usage: r.usage, at: new Date().toISOString() })
        this.writeTurns(paperId, all)
      },
      failed: (message, code) => {
        const all = this.readTurns(paperId)
        all.push({ role: 'assistant', text: '', error: code === 'cancelled' ? '已停止' : message, at: new Date().toISOString() })
        this.writeTurns(paperId, all)
      },
      finally: () => this.asking.delete(paperId)
    })
  }

  /** 翻译选中的一段：只发这段文字和其中出现的术语译法，不记进对话 */
  translate(text: string, glossary: { term: string; translation: string }[] = []): string {
    const t = text.replace(/-\s*\n\s*/g, '').replace(/\s+/g, ' ').trim().slice(0, 6000)
    if (!t) throw new Error('没有要翻译的文字')
    return this.start([{ role: 'user', text: t }], {}, { system: translateSystem(glossary.slice(0, 50)), effort: 'low' })
  }

  resetConversation(paperId: string): void {
    rmSync(this.convFile(paperId), { force: true })
  }

  // —— 内部 ——
  private makeProvider(config: AiConfig, key: string | null): Provider {
    return this.d.provider ? this.d.provider(config, key) : makeProvider(config, key, this.d.fetch)
  }

  private start(
    turns: Turn[],
    hooks: {
      done?: (r: { text: string; raw?: unknown; usage: AiUsage; config: AiConfig }) => void
      failed?: (message: string, code: AiError['code']) => void
      finally?: () => void
    } = {},
    opts: { system?: string; effort?: 'low' | 'medium' } = {}
  ): string {
    const requestId = randomUUID()
    const ac = new AbortController()
    this.running.set(requestId, ac)
    const fail = (message: string, code: AiError['code']) => {
      hooks.failed?.(message, code)
      this.d.emit({ requestId, type: 'error', message, code })
    }
    void (async () => {
      try {
        const conn = this.d.settings.ready() ? this.d.settings.connection() : null
        if (!conn) throw new AiError('no_key', this.d.settings.services().length ? '先在下面选一个模型。' : '还没有连接 AI 服务。在设置里添加一个就能用。')
        const r = await this.makeProvider(conn.config, conn.key).run({ turns, ...opts, signal: ac.signal, onText: (text) => this.d.emit({ requestId, type: 'delta', text }) })
        this.d.settings.addUsage(r.usage)
        this.d.onStatus(this.status())
        hooks.done?.({ text: r.text, raw: r.raw, usage: r.usage, config: conn.config })
        this.d.emit({ requestId, type: 'done', text: r.text, usage: r.usage })
      } catch (e) {
        if (e instanceof AiError) fail(e.message, e.code)
        else fail(e instanceof Error ? e.message : String(e), 'other')
      } finally {
        this.running.delete(requestId)
        hooks.finally?.()
      }
    })()
    return requestId
  }

  private convFile(paperId: string): string {
    return join(this.d.dir, 'conversations', `${safeId(paperId)}.json`)
  }

  private readTurns(paperId: string): StoredTurn[] {
    try {
      const j = JSON.parse(readFileSync(this.convFile(paperId), 'utf8')) as { turns?: StoredTurn[] }
      return Array.isArray(j.turns) ? j.turns : []
    } catch {
      return []
    }
  }

  private writeTurns(paperId: string, turns: StoredTurn[]): void {
    mkdirSync(join(this.d.dir, 'conversations'), { recursive: true })
    writeFileSync(this.convFile(paperId), JSON.stringify({ version: 1, turns }, null, 2))
  }
}

/** 论文 id 当文件名用，只留安全字符 */
function safeId(id: string): string {
  if (!/^[\w-]{1,80}$/.test(id)) throw new Error('bad paper id')
  return id
}
