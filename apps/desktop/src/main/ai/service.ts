// AI 问答：只发用户的问题（选中一段问 AI 时带上那段文字），不会自己去读论文。
// 回答按 requestId 流式推给渲染进程；问答记录按论文存成数据目录 ai/conversations 下的 JSON。
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AiChatTurn, AiConfig, AiConversationList, AiEvent, AiModel, AiStatus, AiUsage, AppleTranslateStatus, MtEngine, TranslateEngine, TranslateStatus } from '../../shared/api'
import { mtEngineOf } from '../../shared/mtEngines'
import { machineTranslate, toEnglish } from './mt'
import { levelsFor, resolveEffort } from '../../shared/effort'
import { AiError, makeProvider, translateSystem, type Effort, type Provider, type Turn } from './providers'
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
  /** macOS 自带的翻译；没有就当用不了 */
  apple?: AppleEngine
}

export interface AppleEngine {
  status(): Promise<AppleTranslateStatus>
  translate(text: string, toEnglish: boolean, signal: AbortSignal): Promise<string>
}

/** 第一次连上时默认选的模型 */
const PREFERRED = ['claude-opus-5-5', 'deepseek-chat']

export class AiService {
  private running = new Map<string, AbortController>()
  /** 每篇论文同一时间只跑一个提问，记录才不会乱 */
  private asking = new Set<string>()
  private modelCache = new Map<string, AiModel[]>()
  /** 系统翻译的状态，查一次要启动小助手，所以记下来；去系统设置下载完回来时再查 */
  private apple: AppleTranslateStatus = 'unavailable'

  constructor(private d: AiServiceDeps) {}

  /** 重新看一下系统翻译能不能用；变了就通知界面 */
  async checkApple(): Promise<AiStatus> {
    const st = this.d.apple ? await this.d.apple.status() : 'unavailable'
    if (st === this.apple) return this.status()
    this.apple = st
    return this.changed()
  }

  status(): AiStatus {
    const s = this.d.settings
    return { services: s.services(), selection: s.selection(), effort: s.effort(), ready: s.ready(), canEncrypt: s.canEncrypt(), usage: s.usage(), translate: this.translateStatus() }
  }

  private translateStatus(): TranslateStatus {
    const s = this.d.settings
    const engine = this.translateEngine()
    const ready = engine === 'ai' ? s.ready() : engine === 'apple' ? this.apple === 'installed' : !!s.mtAccount(engine)
    return { engine, auto: s.translateEngine() === null, apple: this.apple, ready, accounts: s.mtAccounts() }
  }

  /** 用户没选过时：系统翻译能用就用它；不然有 AI 用 AI；都没有就指向系统翻译，引导去下载语言 */
  private translateEngine(): TranslateEngine {
    const chosen = this.d.settings.translateEngine()
    if (chosen) return chosen
    if (this.apple === 'installed') return 'apple'
    if (this.d.settings.ready()) return 'ai'
    return this.apple === 'supported' ? 'apple' : 'ai'
  }

  setTranslateEngine(e: unknown): AiStatus {
    this.d.settings.setTranslateEngine(e)
    return this.changed()
  }

  /** 填好就顺手换成这家：用户填 Key 就是想用它 */
  saveTranslateAccount(account: unknown, secret?: string | null): AiStatus {
    this.d.settings.saveMtAccount(account, secret)
    const engine = (account as { engine: MtEngine }).engine
    if (secret !== null) this.d.settings.setTranslateEngine(engine)
    return this.changed()
  }

  /** 翻一个词试试 Key 对不对 */
  async testTranslate(e: unknown): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
    const info = mtEngineOf(String(e))
    const account = info && this.d.settings.mtAccount(info.id)
    if (!info || !account) return { ok: false, message: '还没有填完整' }
    try {
      return { ok: true, text: await machineTranslate(info.id, account, { text: 'hello', signal: AbortSignal.timeout(15000), fetch: this.d.fetch }) }
    } catch (err) {
      return { ok: false, message: err instanceof AiError ? (err.code === 'cancelled' ? '连接超时。' : err.message) : String(err) }
    }
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

  setEffort(e: unknown): AiStatus {
    this.d.settings.setEffort(e)
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
  /** 一个对话的内容；不给 id 就是当前那个（新对话还没开始时是空的） */
  conversation(paperId: string, id?: string): AiChatTurn[] {
    const f = this.readFile(paperId)
    const c = f.conversations.find((x) => x.id === (id ?? f.current))
    return (c?.turns ?? []).map(({ raw: _raw, rawProvider: _p, ...t }) => t)
  }

  /** 这篇论文的全部对话，最近的在前 */
  conversations(paperId: string): AiConversationList {
    const f = this.readFile(paperId)
    const list = f.conversations
      .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, questions: c.turns.filter((t) => t.role === 'user').length }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return { current: f.current, list }
  }

  /** 开一个新对话：旧的都留着，在历史里能找回来 */
  newConversation(paperId: string): void {
    if (this.asking.has(paperId)) throw new Error('上一个问题还在回答')
    const f = this.readFile(paperId)
    if (f.current === null) return
    f.current = null
    this.writeFile(paperId, f)
  }

  openConversation(paperId: string, id: string): AiChatTurn[] {
    if (this.asking.has(paperId)) throw new Error('上一个问题还在回答')
    const f = this.readFile(paperId)
    if (!f.conversations.some((c) => c.id === id)) throw new Error('这个对话已经删掉了')
    f.current = id
    this.writeFile(paperId, f)
    return this.conversation(paperId, id)
  }

  renameConversation(paperId: string, id: string, title: string): void {
    const f = this.readFile(paperId)
    const c = f.conversations.find((x) => x.id === id)
    const t = title.replace(/\s+/g, ' ').trim().slice(0, 80)
    if (!c || !t) return
    c.title = t
    this.writeFile(paperId, f)
  }

  deleteConversation(paperId: string, id: string): void {
    if (this.asking.has(paperId) && this.readFile(paperId).current === id) throw new Error('这个对话还在回答')
    const f = this.readFile(paperId)
    f.conversations = f.conversations.filter((c) => c.id !== id)
    if (f.current === id) f.current = null
    this.writeFile(paperId, f)
  }

  /** quote：用户在论文里选中、拿来问的那段文字 */
  ask(paperId: string, question: string, quote?: string): string {
    const q = question.trim().slice(0, 8000)
    if (!q) throw new Error('问题是空的')
    if (this.asking.has(paperId)) throw new Error('上一个问题还在回答')
    // 问在当前对话里；新对话第一次提问时才建，标题取这个问题
    const file = this.readFile(paperId)
    let conv = file.conversations.find((c) => c.id === file.current)
    const now = new Date().toISOString()
    if (!conv) {
      conv = { id: randomUUID(), title: titleFor(q, quote), createdAt: now, updatedAt: now, turns: [] }
      file.conversations.push(conv)
      file.current = conv.id
    }
    const convId = conv.id
    const turns = conv.turns
    // 模型自己的思考块只能原样发回给同一个模型；换了模型就只发文字
    const model = this.d.settings.selection()?.model
    const quoteText = quote?.replace(/\s+/g, ' ').trim().slice(0, 4000) || undefined
    turns.push({ role: 'user', text: q, quote: quoteText, at: now })
    conv.updatedAt = now
    this.writeFile(paperId, file)
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
    const effort = this.effortFor()
    return this.start(history, {
      done: (r) => this.appendTurn(paperId, convId, { role: 'assistant', text: r.text, raw: r.raw, rawProvider: r.config.provider, model: r.config.model, usage: r.usage, at: new Date().toISOString() }),
      failed: (message, code) => this.appendTurn(paperId, convId, { role: 'assistant', text: '', error: code === 'cancelled' ? '已停止' : message, at: new Date().toISOString() }),
      finally: () => this.asking.delete(paperId)
    }, { effort })
  }

  /** 翻译选中的一段：只发这段文字和其中出现的术语译法，不记进对话 */
  translate(text: string, glossary: { term: string; translation: string }[] = []): string {
    const t = text.replace(/-\s*\n\s*/g, '').replace(/\s+/g, ' ').trim().slice(0, 6000)
    if (!t) throw new Error('没有要翻译的文字')
    const engine = this.translateEngine()
    if (engine === 'apple') return this.startApple(t)
    if (engine !== 'ai') return this.startMt(engine, t)
    return this.start([{ role: 'user', text: t }], {}, { system: translateSystem(glossary.slice(0, 50)), quick: true })
  }

  /** 用户选的深度落到当前模型上：模型不支持那档就用最近的浅一档，不能调就不发 */
  private effortFor(): Effort | undefined {
    const sel = this.d.settings.selection()
    const conn = this.d.settings.connection()
    if (!sel || !conn) return undefined
    const model = this.modelCache.get(sel.service)?.find((m) => m.id === sel.model)
    return resolveEffort(this.d.settings.effort(), levelsFor(conn.config.provider, model))
  }

  // —— 内部 ——
  private makeProvider(config: AiConfig, key: string | null): Provider {
    return this.d.provider ? this.d.provider(config, key) : makeProvider(config, key, this.d.fetch)
  }

  /** 在这台 Mac 上翻；语言还没下载时顺手再查一次状态，设置里好显示引导 */
  private startApple(text: string): string {
    return this.startOnce(async (signal) => {
      if (!this.d.apple) throw new AiError('other', '这台电脑用不了系统翻译。')
      try {
        return await this.d.apple.translate(text, toEnglish(text), signal)
      } catch (e) {
        if (e instanceof AiError && e.code === 'no_key') void this.checkApple()
        throw e
      }
    }, 30000)
  }

  /** 机器翻译不是流式的，翻完一次给出结果 */
  private startMt(engine: MtEngine, text: string): string {
    return this.startOnce(async (signal) => {
      const account = this.d.settings.mtAccount(engine)
      if (!account) throw new AiError('no_key', `${mtEngineOf(engine)?.name ?? '翻译服务'}还没有填 Key。`)
      return machineTranslate(engine, account, { text, signal, fetch: this.d.fetch })
    }, 20000)
  }

  private startOnce(run: (signal: AbortSignal) => Promise<string>, timeoutMs: number): string {
    const requestId = randomUUID()
    const ac = new AbortController()
    this.running.set(requestId, ac)
    let timedOut = false
    const timer = setTimeout(() => ((timedOut = true), ac.abort()), timeoutMs)
    void (async () => {
      try {
        const out = (await run(ac.signal)).trim()
        this.d.emit({ requestId, type: 'done', text: out, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null } })
      } catch (e) {
        const err = e instanceof AiError ? e : new AiError('other', e instanceof Error ? e.message : String(e))
        if (timedOut) this.d.emit({ requestId, type: 'error', message: '翻译服务没有响应，稍后再试。', code: 'network' })
        else this.d.emit({ requestId, type: 'error', message: err.message, code: err.code })
      } finally {
        clearTimeout(timer)
        this.running.delete(requestId)
      }
    })()
    return requestId
  }

  private start(
    turns: Turn[],
    hooks: {
      done?: (r: { text: string; raw?: unknown; usage: AiUsage; config: AiConfig }) => void
      failed?: (message: string, code: AiError['code']) => void
      finally?: () => void
    } = {},
    opts: { system?: string; effort?: Effort; quick?: boolean } = {}
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

  /** 一篇论文的对话都存在一个文件里。最早的版本只有一个对话（version 1），读的时候转成一个对话 */
  private readFile(paperId: string): ConvFile {
    try {
      const j = JSON.parse(readFileSync(this.convFile(paperId), 'utf8')) as Partial<ConvFile> & { turns?: StoredTurn[] }
      if (Array.isArray(j.conversations)) {
        const conversations = j.conversations.filter((c) => c && typeof c.id === 'string' && Array.isArray(c.turns))
        const current = typeof j.current === 'string' && conversations.some((c) => c.id === j.current) ? j.current : null
        return { version: 2, current, conversations }
      }
      if (Array.isArray(j.turns) && j.turns.length) {
        const first = j.turns.find((t) => t.role === 'user')
        const at = j.turns[0]?.at ?? new Date().toISOString()
        const last = j.turns[j.turns.length - 1]?.at ?? at
        const conv = { id: randomUUID(), title: titleFor(first?.text ?? '对话', first?.quote), createdAt: at, updatedAt: last, turns: j.turns }
        return { version: 2, current: conv.id, conversations: [conv] }
      }
    } catch {
      /* 还没有对话 */
    }
    return { version: 2, current: null, conversations: [] }
  }

  private writeFile(paperId: string, f: ConvFile): void {
    mkdirSync(join(this.d.dir, 'conversations'), { recursive: true })
    if (!f.conversations.length && f.current === null) return void rmSync(this.convFile(paperId), { force: true })
    writeFileSync(this.convFile(paperId), JSON.stringify(f, null, 2))
  }

  /** 回答写回提问时的那个对话（中途切到别的对话也不会写错地方） */
  private appendTurn(paperId: string, convId: string, turn: StoredTurn): void {
    const f = this.readFile(paperId)
    const c = f.conversations.find((x) => x.id === convId)
    if (!c) return
    c.turns.push(turn)
    c.updatedAt = turn.at
    this.writeFile(paperId, f)
  }
}

interface StoredConversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  turns: StoredTurn[]
}

interface ConvFile {
  version: 2
  /** 正在用的对话；null 表示开了新对话、还没问 */
  current: string | null
  conversations: StoredConversation[]
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

/** 论文 id 当文件名用，只留安全字符 */
function safeId(id: string): string {
  if (!/^[\w-]{1,80}$/.test(id)) throw new Error('bad paper id')
  return id
}
