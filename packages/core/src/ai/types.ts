// AI 和翻译用到的类型：桌面的主进程、渲染进程和手机版共用。
export type AiProviderKind = 'anthropic' | 'openai'

/** 发请求时用的连接信息（主进程内部用） */
export interface AiConfig {
  /** 哪一家服务，见 ai/vendors.ts */
  vendor: string
  /** 接口类型，由 vendor 决定 */
  provider: AiProviderKind
  model: string
  /** 留空用这家的默认地址 */
  baseUrl: string
}

/** 设置里加的一个 AI 服务（不含 Key；Key 只在主进程，用系统钥匙串加密存盘） */
export interface AiService {
  /** 服务本身的 id：官方服务就是 vendor，自定义地址是 custom-xxxx */
  id: string
  vendor: string
  /** 自定义地址可以起个名字 */
  name: string
  /** 留空用这家的默认地址；自定义地址必须填 */
  baseUrl: string
  hasKey: boolean
}

export interface AiModel {
  id: string
  name?: string
  /** 这个模型能选的思考深度（服务说了才有）；空数组表示不能调，没有这项表示不知道 */
  efforts?: Exclude<AiEffort, 'auto'>[]
}

/** 问 AI 时模型想多深。auto：不指定，用模型自己的默认 */
export type AiEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const AI_EFFORTS: AiEffort[] = ['auto', 'low', 'medium', 'high', 'xhigh', 'max']

/** 对话里选的模型 */
export interface AiSelection {
  service: string
  model: string
}

export interface AiStatus {
  services: AiService[]
  /** 当前选的模型；还没选是 null */
  selection: AiSelection | null
  /** 问 AI 时的思考深度（翻译固定用 low） */
  effort: AiEffort
  /** 有选好的模型、它的服务也连得上（有 Key 或不要 Key） */
  ready: boolean
  /** 系统钥匙串能不能用；不能用时不保存 Key */
  canEncrypt: boolean
  usage: AiUsageTotal
  translate: TranslateStatus
}

/** 机器翻译服务（各家官方 API，用户自己的 Key） */
export type MtEngine = 'tencent' | 'baidu' | 'youdao' | 'deepl' | 'microsoft'
/** 翻译用哪家：apple 是 macOS 自带的翻译（免费、不用注册），ai 是对话里选的模型 */
export type TranslateEngine = 'apple' | 'ai' | MtEngine
/** macOS 自带翻译的状态。installed：能用；supported：要先在系统设置里下载英语和中文；unsupported / unavailable：用不了 */
export type AppleTranslateStatus = 'installed' | 'supported' | 'unsupported' | 'unavailable'

export interface MtAccountInfo {
  engine: MtEngine
  /** APP ID / SecretId（不是秘密，可以显示） */
  id: string
  region: string
  hasSecret: boolean
}

export interface TranslateStatus {
  /** 现在用的那家 */
  engine: TranslateEngine
  /** 用户没选过：系统翻译能用就用它，不然用 AI */
  auto: boolean
  apple: AppleTranslateStatus
  /** 现在翻译能不能用（选的那家填好了 Key） */
  ready: boolean
  accounts: MtAccountInfo[]
}

export interface AiUsageTotal {
  inputTokens: number
  outputTokens: number
  /** 只有知道价格的模型才算钱（美元） */
  costUsd: number
  calls: number
}

/** 一次调用的用量 */
export interface AiUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number | null
}

export interface AiConversationSummary {
  id: string
  /** 默认是第一个问题，可以改 */
  title: string
  updatedAt: string
  /** 问了几个问题 */
  questions: number
}

export interface AiConversationList {
  /** 正在用的对话；null 表示新对话、还没问 */
  current: string | null
  list: AiConversationSummary[]
}

export interface AiChatTurn {
  role: 'user' | 'assistant'
  /** 显示用的文字；回答里的原文定位写成 ⟦页码|原文⟧ */
  text: string
  /** 提问时附带的选中文字 */
  quote?: string
  /** 回答用的模型 */
  model?: string
  usage?: AiUsage
  error?: string
  at: string
}

/** 流式结果：同一个 requestId 的 delta 依次拼起来，最后来一个 done 或 error */
export type AiEvent =
  | { requestId: string; type: 'delta'; text: string }
  | { requestId: string; type: 'done'; text: string; usage: AiUsage }
  | { requestId: string; type: 'error'; message: string; code?: AiErrorCode }

export type AiErrorCode = 'no_key' | 'quota' | 'auth' | 'rate_limit' | 'network' | 'refusal' | 'too_long' | 'cancelled' | 'other'
