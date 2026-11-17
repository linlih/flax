// 手机自带的翻译：iOS 用 Apple 的 Translation 框架（iOS 18 起），Android 用 Google ML Kit 的离线翻译。
// 免费、不用 Key、在手机上翻；要先下载英语和中文的语言包。原生部分在 modules/flax-translate。
// 接到 AiService 的"系统翻译"（engine 'apple'，桌面上是 macOS 自带的翻译）。
import { requireOptionalNativeModule } from 'expo'
import { AiError, type AppleEngine } from '@flax/core/ai/runtime'
import type { AppleTranslateStatus } from '@flax/core'

interface Native {
  status(): Promise<string>
  prepare(): Promise<string>
  translate(text: string, toEnglish: boolean): Promise<string>
}

const native = requireOptionalNativeModule<Native>('FlaxTranslate')
if (!native) console.warn('[systemTranslate] native module missing')

const asStatus = (s: string): AppleTranslateStatus => (s === 'installed' || s === 'supported' || s === 'unsupported' ? s : 'unavailable')

function asError(e: unknown): AiError {
  const code = (e as { code?: string }).code ?? ''
  const msg = e instanceof Error ? e.message.replace(/^.*?(Error|Exception):\s*/, '') : String(e)
  // 没下载语言包：当成"没设好"，翻译面板会给出"去设置"
  if (code === 'not_installed' || code === 'ERR_NOT_INSTALLED') return new AiError('no_key', '还没有下载英语和中文：在"设置 → 翻译"里下载。')
  return new AiError('other', msg || '系统翻译失败')
}

export const systemTranslate: AppleEngine | undefined = native
  ? {
      status: async () => {
        // 查状态卡住（个别系统上 ML Kit 迟迟不回）时别让"系统翻译"一直不出现：当成要下载
        const r = await Promise.race([native.status().catch((e: unknown) => (console.warn('[systemTranslate] status', e), 'unavailable')), new Promise<string>((ok) => setTimeout(() => ok('timeout'), 5000))])
        if (r === 'timeout') console.warn('[systemTranslate] status timed out')
        return r === 'timeout' ? 'supported' : asStatus(r)
      },
      translate: (text, toEnglish, signal) =>
        new Promise<string>((resolve, reject) => {
          if (signal.aborted) return reject(new AiError('cancelled', '已停止'))
          const onAbort = () => reject(new AiError('cancelled', '已停止'))
          signal.addEventListener('abort', onAbort, { once: true })
          native.translate(text, toEnglish).then(
            (r) => {
              signal.removeEventListener('abort', onAbort)
              resolve(r)
            },
            (e: unknown) => {
              signal.removeEventListener('abort', onAbort)
              reject(asError(e))
            }
          )
        })
    }
  : undefined

/** 下载英语和中文的语言包（iOS 弹出系统的确认面板）。返回下载后的状态 */
export async function prepareSystemTranslate(): Promise<AppleTranslateStatus> {
  if (!native) return 'unavailable'
  try {
    return asStatus(await native.prepare())
  } catch (e) {
    throw asError(e)
  }
}
