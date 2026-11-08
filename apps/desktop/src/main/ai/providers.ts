// 两种模型服务，接口统一：Anthropic（官方 SDK）和 OpenAI 兼容（DeepSeek、Kimi、通义、本机模型…）。
// 只发对话本身，不会自己把论文发出去。用户选中一段问 AI 时，那段文字写在问题里。
import Anthropic from '@anthropic-ai/sdk'
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { costOf, stripCitations } from '@flax/core'
import { endpointOf } from '../../shared/aiVendors'
import { EFFORT_LEVELS } from '../../shared/effort'
import type { AiConfig, AiEffort, AiErrorCode, AiModel, AiUsage } from '../../shared/api'

export interface Turn {
  role: 'user' | 'assistant'
  /** 发给模型的文字（用户这边是整理好的提示，助手这边是显示用的回答） */
  text: string
  /** 服务原样返回的内容（Anthropic 的 content 块，含思考块）；同一个模型时原样回传，保持历史只追加不改动 */
  raw?: unknown
  rawProvider?: AiConfig['provider']
}

/** 具体的思考深度（选“自动”时不填） */
export type Effort = Exclude<AiEffort, 'auto'>

export interface RunRequest {
  turns: Turn[]
  signal: AbortSignal
  onText: (delta: string) => void
  /** 换掉默认的系统提示（翻译时用） */
  system?: string
  /** 用户在对话里选的思考深度；不填用模型自己的默认 */
  effort?: Effort
  /** 简单的活（翻译）：Claude 用 low 省时间。OpenAI 兼容服务不一定认 reasoning_effort，不为它发 */
  quick?: boolean
}

export interface RunResult {
  text: string
  raw?: unknown
  usage: AiUsage
  model: string
}

export interface Provider {
  run(req: RunRequest): Promise<RunResult>
  /** 这个 Key 能用的模型 */
  models(signal: AbortSignal): Promise<AiModel[]>
}

export class AiError extends Error {
  constructor(public code: AiErrorCode, message: string) {
    super(message)
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** 翻译选中的一段。glossary：这段里出现的术语和用户定的译法 */
export function translateSystem(glossary: { term: string; translation: string }[]): string {
  return [
    '你是学术论文翻译。把用户发来的文字译成准确、通顺、符合学术习惯的简体中文；如果原文是中文，就译成英文。',
    '只输出译文本身，不加引号、前言或解释。公式、变量名、引用编号（如 [12]）、代码保持原样。PDF 复制出来的断行和连字符要接上。',
    '如果只是一个词或短语：第一行只写最贴切的译法，第二行用一句话说明它在这类论文里的意思。',
    ...(glossary.length ? ['下面这些术语必须按给定的译法翻译：', ...glossary.map((g) => `- ${g.term} → ${g.translation}`)] : [])
  ].join('\n')
}

const SYSTEM = [
  '你是帮助中文读者读英文学术论文的助手。',
  '用简体中文回答；术语第一次出现时在括号里附英文原词。',
  '回答直接、具体，不客套，不复述问题。可以用 Markdown 的列表和粗体，不用标题。'
].join('\n')

const EFFORT_UNSUPPORTED = '这个模型不支持调整思考深度。把输入框下面的"思考"改回"自动"再试。'

// —— Anthropic ——
const MAX_TOKENS = 32000
/** 这两个模型在官方接口上可以开服务端回退：被安全策略拒答时自动换模型重试 */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5'])

export function anthropicProvider(config: AiConfig, key: string | null, fetch?: FetchLike): Provider {
  const client = new Anthropic({ apiKey: key ?? undefined, baseURL: config.baseUrl || undefined, fetch: fetch as never, maxRetries: 2 })
  const official = !config.baseUrl

  const params = (req: RunRequest): BetaMessageStreamParams => {
    const messages: Anthropic.Beta.BetaMessageParam[] = req.turns.map((t) =>
      t.role === 'assistant'
        ? { role: 'assistant', content: t.rawProvider === 'anthropic' && Array.isArray(t.raw) ? (t.raw as Anthropic.Beta.BetaContentBlockParam[]) : stripCitations(t.text) }
        : { role: 'user', content: t.text }
    )
    const fallback = official && FALLBACK_MODELS.has(config.model)
    return {
      model: config.model,
      max_tokens: MAX_TOKENS,
      system: req.system ?? SYSTEM,
      messages,
      ...(req.effort || req.quick ? { output_config: { effort: req.effort ?? 'low' } } : {}),
      ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {})
    }
  }

  return {
    async run(req) {
      let out = ''
      try {
        const stream = client.beta.messages.stream(params(req), { signal: req.signal })
        stream.on('streamEvent', (ev) => {
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            out += ev.delta.text
            req.onText(ev.delta.text)
          }
        })
        const msg = await stream.finalMessage()
        if (msg.stop_reason === 'refusal') throw new AiError('refusal', '模型拒绝回答这个请求。可以换个问法，或者换一个模型。')
        const u = msg.usage
        const usage = {
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0
        }
        return { text: out, raw: msg.content, model: msg.model, usage: { ...usage, costUsd: costOf(msg.model, usage) } }
      } catch (e) {
        throw mapAnthropicError(e)
      }
    },
    async models(signal) {
      try {
        const out: AiModel[] = []
        for await (const m of client.models.list({ limit: 100 }, { signal })) out.push({ id: m.id, name: m.display_name, efforts: effortsOf(m.capabilities?.effort) })
        return out
      } catch (e) {
        throw mapAnthropicError(e)
      }
    }
  }
}

/** 模型列表里写的思考深度；没写（比如走代理）就不知道 */
function effortsOf(cap: unknown): AiModel['efforts'] {
  const c = cap as Record<string, unknown> | null | undefined
  if (!c) return undefined
  if (!c.supported) return []
  return EFFORT_LEVELS.filter((l) => (c[l] as { supported?: boolean } | null | undefined)?.supported)
}

function mapAnthropicError(e: unknown): AiError {
  if (e instanceof AiError) return e
  if (e instanceof Anthropic.APIUserAbortError) return new AiError('cancelled', '已停止')
  if (e instanceof Anthropic.AuthenticationError) return new AiError('auth', 'Key 无效或已过期，请在设置里重新填写。')
  if (e instanceof Anthropic.PermissionDeniedError) return new AiError('auth', '这个 Key 没有权限使用该模型。')
  if (e instanceof Anthropic.RateLimitError) return new AiError('rate_limit', '请求太频繁或额度用完了，稍后再试。')
  if (e instanceof Anthropic.BadRequestError && /effort/i.test(e.message)) return new AiError('other', EFFORT_UNSUPPORTED)
  if (e instanceof Anthropic.NotFoundError) return new AiError('other', '找不到这个模型，请检查设置里的模型名。')
  if (e instanceof Anthropic.APIConnectionError) return new AiError('network', '连不上服务，请检查网络或代理设置。')
  if (e instanceof Anthropic.APIError) return new AiError('other', `服务出错（${e.status ?? '?'}）：${e.message}`)
  return new AiError('other', e instanceof Error ? e.message : String(e))
}

// —— OpenAI 兼容 ——
/** 模型列表里明显不是对话模型的（向量、语音、画图…） */
const NOT_CHAT = /embed|whisper|tts|dall-e|moderation|transcri|rerank|davinci|babbage|text-to-|speech|image-gen/i

export function openaiProvider(config: AiConfig, key: string | null, fetch: FetchLike): Provider {
  const base = endpointOf(config.vendor, config.baseUrl)
  const url = `${base}/chat/completions`
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (key) headers['authorization'] = `Bearer ${key}`

  const post = async (body: unknown, signal: AbortSignal, get?: string): Promise<Response> => {
    let res: Response
    try {
      res = await fetch(get ?? url, get ? { headers, signal } : { method: 'POST', headers, body: JSON.stringify(body), signal })
    } catch (e) {
      if (signal.aborted) throw new AiError('cancelled', '已停止')
      throw new AiError('network', `连不上 ${base}：${e instanceof Error ? e.message : String(e)}`)
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      if (res.status === 401 || res.status === 403) throw new AiError('auth', 'Key 无效或没有权限，请在设置里重新填写。')
      if (res.status === 429) throw new AiError('rate_limit', '请求太频繁或额度用完了，稍后再试。')
      if (res.status === 400 && /reasoning/i.test(detail)) throw new AiError('other', EFFORT_UNSUPPORTED)
      throw new AiError('other', `服务出错（${res.status}）${detail ? '：' + detail : ''}`)
    }
    return res
  }

  return {
    async run(req) {
      const messages = [{ role: 'system', content: req.system ?? SYSTEM }, ...req.turns.map((t) => ({ role: t.role, content: t.role === 'assistant' ? stripCitations(t.text) : t.text }))]
      // OpenAI 兼容接口的 reasoning_effort 只有 low / medium / high
      const reasoning = req.effort ? { reasoning_effort: req.effort === 'max' || req.effort === 'xhigh' ? 'high' : req.effort } : {}
      const res = await post({ model: config.model, messages, stream: true, stream_options: { include_usage: true }, ...reasoning }, req.signal)
      let text = ''
      let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
      let model = config.model
      try {
        for await (const data of sseData(res)) {
          if (data === '[DONE]') break
          let j: { model?: string; choices?: { delta?: { content?: string | null } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } }
          try {
            j = JSON.parse(data)
          } catch {
            continue
          }
          if (j.model) model = j.model
          const d = j.choices?.[0]?.delta?.content
          if (d) {
            text += d
            req.onText(d)
          }
          if (j.usage) {
            const cached = j.usage.prompt_tokens_details?.cached_tokens ?? 0
            usage = { inputTokens: (j.usage.prompt_tokens ?? 0) - cached, outputTokens: j.usage.completion_tokens ?? 0, cacheReadTokens: cached, cacheWriteTokens: 0 }
          }
        }
      } catch (e) {
        if (req.signal.aborted) throw new AiError('cancelled', '已停止')
        throw new AiError('network', `连接中断：${e instanceof Error ? e.message : String(e)}`)
      }
      return { text, model, usage: { ...usage, costUsd: costOf(model, usage) } }
    },
    async models(signal) {
      const res = await post(null, signal, `${base}/models`)
      const j = (await res.json().catch(() => ({}))) as { data?: { id?: unknown; name?: unknown; supported_parameters?: unknown }[] }
      const list = Array.isArray(j.data) ? j.data : []
      return list
        .filter((m): m is { id: string; name?: unknown; supported_parameters?: unknown } => typeof m.id === 'string' && !NOT_CHAT.test(m.id))
        .map((m) => {
          // OpenRouter 这类服务会列出模型认哪些参数；大多数服务不列，就不知道
          const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : null
          const efforts: AiModel['efforts'] = params ? (params.includes('reasoning_effort') || params.includes('reasoning') ? ['low', 'medium', 'high'] : []) : undefined
          return { id: m.id, name: typeof m.name === 'string' && m.name !== m.id ? m.name : undefined, ...(efforts ? { efforts } : {}) }
        })
        .sort((a, b) => a.id.localeCompare(b.id))
    }
  }
}

/** 逐条读出 SSE 的 data 字段 */
export async function* sseData(res: Response): AsyncGenerator<string> {
  if (!res.body) return
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '')
      buf = buf.slice(i + 1)
      if (line.startsWith('data:')) yield line.slice(5).trim()
    }
  }
  if (buf.startsWith('data:')) yield buf.slice(5).trim()
}

export function makeProvider(config: AiConfig, key: string | null, fetch: FetchLike): Provider {
  return config.provider === 'anthropic' ? anthropicProvider(config, key, fetch) : openaiProvider(config, key, fetch)
}
