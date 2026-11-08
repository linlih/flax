// 机器翻译服务：各家官方 API，用户自己申请 Key（大多每月有免费额度）。设置页和主进程共用这份清单。
import type { MtEngine } from './api'

export interface MtEngineInfo {
  id: MtEngine
  name: string
  /** 除了密钥还要填的那一项（APP ID、SecretId…）；没有就不填 */
  idLabel?: string
  secretLabel: string
  /** 微软要填资源所在的区域 */
  regionLabel?: string
  /** 免费额度，写在设置里帮用户选；以各家官网为准 */
  free: string
  /** 去哪里申请 */
  url: string
}

export const MT_ENGINES: MtEngineInfo[] = [
  { id: 'tencent', name: '腾讯翻译君', idLabel: 'SecretId', secretLabel: 'SecretKey', free: '每月 500 万字符免费', url: 'https://console.cloud.tencent.com/tmt' },
  { id: 'baidu', name: '百度翻译', idLabel: 'APP ID', secretLabel: '密钥', free: '个人认证后每月 100 万字符免费', url: 'https://fanyi-api.baidu.com/' },
  { id: 'youdao', name: '有道智云', idLabel: '应用 ID', secretLabel: '应用密钥', free: '新用户有体验额度，之后按量付费', url: 'https://ai.youdao.com/' },
  { id: 'deepl', name: 'DeepL', secretLabel: 'API Key', free: '免费版每月 50 万字符', url: 'https://www.deepl.com/pro-api' },
  { id: 'microsoft', name: '微软翻译', secretLabel: 'Key', regionLabel: '区域', free: '免费层每月 200 万字符', url: 'https://portal.azure.com/#create/Microsoft.CognitiveServicesTextTranslation' }
]

export const mtEngineOf = (id: string): MtEngineInfo | undefined => MT_ENGINES.find((e) => e.id === id)
