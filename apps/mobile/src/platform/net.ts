// 网络：expo/fetch 走原生的 OkHttp，没有跨域限制，支持流式读（AI 边生成边显示）和 PROPFIND 这类方法（WebDAV）。
import { fetch as expoFetch } from 'expo/fetch'
import { createNet, type HttpFetch } from '@flax/core'
import type { FetchLike } from '@flax/core/ai/runtime'

export const fetchLike: FetchLike = expoFetch as unknown as FetchLike

export const httpFetch: HttpFetch = async (url, init) => {
  const r = await expoFetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body ? { body: init.body as unknown as ArrayBuffer } : {}),
    ...(init.signal ? { signal: init.signal as AbortSignal } : {})
  })
  return { status: r.status, text: () => r.text(), arrayBuffer: () => r.arrayBuffer() }
}

/** 元数据查询和下载 PDF：限速和超时在 core */
export const net = createNet(expoFetch as unknown as Parameters<typeof createNet>[0], { userAgent: 'Flax/0.1 (open-source reference manager; Android)' })
