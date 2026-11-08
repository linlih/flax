// AI 相关、和平台无关的小工具：回答里的原文定位标记、论文文字和页码的对应、费用、论文要点的校验。

/**
 * 回答里的原文定位写成 ⟦页码|原文⟧。
 * Anthropic 的原生引用在主进程里转成这个格式；别的服务按提示词直接写这个格式。
 * 用不常见的括号，避免和 Markdown、[[双链]] 冲突。
 */
export const CITE_OPEN = '⟦'
export const CITE_CLOSE = '⟧'

export function citeMarker(page: number, quote: string): string {
  const q = quote.replace(/[⟦⟧|]/g, ' ').replace(/\s+/g, ' ').trim()
  return `${CITE_OPEN}${page}|${q}${CITE_CLOSE}`
}

export type CitedSegment = { kind: 'text'; text: string } | { kind: 'cite'; page: number; quote: string; n: number }

/**
 * 把回答拆成文字和原文定位。流式输出时末尾可能有半个标记，先藏起来不显示。
 * 同一句原文只编一个号。
 */
export function splitCitations(text: string): CitedSegment[] {
  const open = text.lastIndexOf(CITE_OPEN)
  if (open >= 0 && text.indexOf(CITE_CLOSE, open) < 0) text = text.slice(0, open)
  const out: CitedSegment[] = []
  const numbers = new Map<string, number>()
  const re = /⟦\s*(\d+)\s*\|([^⟧]*)⟧/g
  let last = 0
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0
    if (i > last) out.push({ kind: 'text', text: text.slice(last, i) })
    const page = Number(m[1])
    const quote = (m[2] ?? '').trim()
    const key = `${page}|${quote}`
    if (!numbers.has(key)) numbers.set(key, numbers.size + 1)
    out.push({ kind: 'cite', page, quote, n: numbers.get(key)! })
    last = i + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

/** 去掉定位标记，复制或摘到笔记时用 */
export function stripCitations(text: string): string {
  return text.replace(/\s*⟦[^⟧]*⟧/g, '')
}

/** 把每页文字接成一整段，记下每页开头在哪里，用来把引用的位置换算成页码 */
export function joinPages(pages: string[]): { text: string; starts: number[] } {
  const starts: number[] = []
  let text = ''
  pages.forEach((p, i) => {
    if (i > 0) text += '\n\n'
    starts.push(text.length)
    text += p
  })
  return { text, starts }
}

/** 位置所在的页码（从 1 开始） */
export function pageOfOffset(starts: number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** 不支持原生引用的服务：每页前面标上页码，让模型照着写 ⟦页码|原文⟧ */
export function pagedText(pages: string[]): string {
  return pages.map((p, i) => `[第 ${i + 1} 页]\n${p}`).join('\n\n')
}

/** 每百万 token 的美元价格；不认识的模型不算钱 */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 }
}

export function priceOf(model: string): { input: number; output: number; cacheRead: number } | null {
  return PRICES[model] ?? null
}

/** 一次调用的费用（美元）；写缓存按输入价的 1.25 倍 */
export function costOf(model: string, u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number | null {
  const p = priceOf(model)
  if (!p) return null
  return (u.inputTokens * p.input + u.cacheWriteTokens * p.input * 1.25 + u.cacheReadTokens * p.cacheRead + u.outputTokens * p.output) / 1e6
}

export function formatCost(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

// —— 论文要点 ——
export type ReadingStepKind = 'core' | 'evidence' | 'skim' | 'skip'

export interface KeyPointsBody {
  oneLiner: string
  readingGuide: { estimatedMinutes: number; steps: { title: string; why: string; kind: ReadingStepKind; pages: number[] }[] }
  problem: string
  method: string
  datasets: string[]
  findings: string[]
  limitations: string[]
}

/** 要点的 JSON Schema：Anthropic 用它做结构化输出，别的服务写进提示词 */
export const KEY_POINTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['oneLiner', 'readingGuide', 'problem', 'method', 'datasets', 'findings', 'limitations'],
  properties: {
    oneLiner: { type: 'string', description: '一句话：这篇讲什么、结论是什么' },
    readingGuide: {
      type: 'object',
      additionalProperties: false,
      required: ['estimatedMinutes', 'steps'],
      properties: {
        estimatedMinutes: { type: 'integer', description: '精读大约要多少分钟' },
        steps: {
          type: 'array',
          description: '建议的阅读顺序，3 到 6 步',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'why', 'kind', 'pages'],
            properties: {
              title: { type: 'string', description: '读哪里，例如"先看图 1 和 3.2 节"' },
              why: { type: 'string', description: '为什么' },
              kind: { type: 'string', enum: ['core', 'evidence', 'skim', 'skip'], description: '精读 / 看依据 / 略读 / 可跳过' },
              pages: { type: 'array', items: { type: 'integer' }, description: '页码，从 1 开始' }
            }
          }
        }
      }
    },
    problem: { type: 'string', description: '要解决的问题' },
    method: { type: 'string', description: '方法' },
    datasets: { type: 'array', items: { type: 'string' }, description: '用到的数据集，没有就空' },
    findings: { type: 'array', items: { type: 'string' }, description: '主要结论' },
    limitations: { type: 'array', items: { type: 'string' }, description: '局限' }
  }
} as const

const KINDS: ReadingStepKind[] = ['core', 'evidence', 'skim', 'skip']

/** 从模型输出里取出 JSON（可能包着 ```json 代码块或前后有话） */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = fenced ? fenced[1]! : text
  const a = body.indexOf('{')
  const b = body.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('回答里没有 JSON')
  return JSON.parse(body.slice(a, b + 1))
}

/** 校验并整理模型给的要点；缺字段时补空，页码限制在论文页数内 */
export function parseKeyPoints(raw: unknown, pageCount: number): KeyPointsBody {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const list = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : [])
  const g = (o['readingGuide'] && typeof o['readingGuide'] === 'object' ? o['readingGuide'] : {}) as Record<string, unknown>
  const steps = (Array.isArray(g['steps']) ? g['steps'] : []).flatMap((s) => {
    const x = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>
    const title = str(x['title'])
    if (!title) return []
    const kind = KINDS.includes(x['kind'] as ReadingStepKind) ? (x['kind'] as ReadingStepKind) : 'core'
    const pages = (Array.isArray(x['pages']) ? x['pages'] : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= Math.max(1, pageCount))
    return [{ title, why: str(x['why']), kind, pages: [...new Set(pages)].sort((a, b) => a - b) }]
  })
  const minutes = Number(g['estimatedMinutes'])
  const body: KeyPointsBody = {
    oneLiner: str(o['oneLiner']),
    readingGuide: { estimatedMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0, steps },
    problem: str(o['problem']),
    method: str(o['method']),
    datasets: list(o['datasets']),
    findings: list(o['findings']),
    limitations: list(o['limitations'])
  }
  if (!body.oneLiner && !body.problem && !body.findings.length) throw new Error('要点是空的')
  return body
}
