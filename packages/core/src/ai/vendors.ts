// 可以直接选的 AI 服务。除了 Anthropic，都走 OpenAI 兼容接口（/chat/completions、/models）。
// 地址是各家公开文档里的默认地址；走代理或私有部署时可以在设置里改。

export type AiVendorKind = 'anthropic' | 'openai'

export interface AiVendor {
  id: string
  name: string
  kind: AiVendorKind
  /** 默认地址；空字符串表示用官方 SDK 的默认地址（Anthropic），或必须自己填（自定义） */
  baseUrl: string
  /** 不要 Key（自定义地址：本机或局域网里的服务通常不要） */
  keyOptional?: boolean
  group: '国际' | '国内' | '其他'
}

export const AI_VENDORS: readonly AiVendor[] = [
  { id: 'anthropic', name: 'Anthropic（Claude）', kind: 'anthropic', baseUrl: '', group: '国际' },
  { id: 'openai', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', group: '国际' },
  { id: 'gemini', name: 'Google Gemini', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', group: '国际' },
  { id: 'xai', name: 'xAI（Grok）', kind: 'openai', baseUrl: 'https://api.x.ai/v1', group: '国际' },
  { id: 'mistral', name: 'Mistral', kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', group: '国际' },
  { id: 'groq', name: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', group: '国际' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', group: '国际' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', group: '国内' },
  { id: 'qwen', name: '阿里云百炼（通义千问）', kind: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', group: '国内' },
  { id: 'kimi', name: '月之暗面（Kimi）', kind: 'openai', baseUrl: 'https://api.moonshot.cn/v1', group: '国内' },
  { id: 'zhipu', name: '智谱（GLM）', kind: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', group: '国内' },
  { id: 'doubao', name: '火山方舟（豆包）', kind: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', group: '国内' },
  { id: 'hunyuan', name: '腾讯混元', kind: 'openai', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', group: '国内' },
  { id: 'qianfan', name: '百度千帆（文心）', kind: 'openai', baseUrl: 'https://qianfan.baidubce.com/v2', group: '国内' },
  { id: 'minimax', name: 'MiniMax', kind: 'openai', baseUrl: 'https://api.minimaxi.com/v1', group: '国内' },
  { id: 'siliconflow', name: '硅基流动', kind: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', group: '国内' },
  { id: 'ollama', name: 'Ollama（本机）', kind: 'openai', baseUrl: 'http://localhost:11434/v1', keyOptional: true, group: '其他' },
  { id: 'custom', name: '自定义地址', kind: 'openai', baseUrl: '', keyOptional: true, group: '其他' }
]

export function vendorOf(id: string): AiVendor | undefined {
  return AI_VENDORS.find((v) => v.id === id)
}

/** 实际请求的地址：自己填的优先，没填用默认 */
export function endpointOf(vendorId: string, baseUrl: string): string {
  return baseUrl || vendorOf(vendorId)?.baseUrl || ''
}

/** 旧设置（只有 provider + baseUrl）对应到哪一家 */
export function guessVendor(kind: string, baseUrl: string): string {
  if (kind === 'anthropic') return 'anthropic'
  const host = (u: string) => {
    try {
      return new URL(u).host
    } catch {
      return ''
    }
  }
  const h = host(baseUrl)
  return AI_VENDORS.find((v) => v.baseUrl && host(v.baseUrl) === h)?.id ?? 'custom'
}
