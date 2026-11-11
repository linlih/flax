// 联网请求的限速和超时在 core（@flax/core 的 net.ts），这里只换上桌面的标识。
import { createNet as coreNet, type FetchBytes } from '@flax/core'

export type { FetchBytes }

export function createNet(fetchImpl: typeof fetch = fetch, opts: { textTimeoutMs?: number; fileTimeoutMs?: number } = {}): ReturnType<typeof coreNet> {
  return coreNet(fetchImpl, { ...opts, userAgent: 'Flax/0.1 (open-source desktop reference manager)' })
}
