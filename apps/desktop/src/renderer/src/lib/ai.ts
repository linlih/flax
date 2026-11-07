// 渲染进程这边的 AI：连接状态，以及按 requestId 收流式结果。
// 主进程可能在返回 requestId 之前就发出事件（比如没有 Key 时立刻报错），所以先缓存起来。
import { useEffect, useState } from 'react'
import { vendorOf } from '../../../shared/aiVendors'
import type { AiEvent, AiService, AiStatus } from '../../../shared/api'
import { api } from './library'

type Handler = (e: AiEvent) => void
const handlers = new Map<string, Handler>()
const early = new Map<string, AiEvent[]>()
let subscribed = false

function ensure(): void {
  if (subscribed) return
  subscribed = true
  api.ai.onEvent((e) => {
    const h = handlers.get(e.requestId)
    if (h) return h(e)
    const q = early.get(e.requestId) ?? []
    q.push(e)
    early.set(e.requestId, q)
  })
}

export interface StreamHandlers {
  onDelta?: (text: string, all: string) => void
  onDone?: (e: Extract<AiEvent, { type: 'done' }>) => void
  onError?: (e: Extract<AiEvent, { type: 'error' }>) => void
}

/** 发起请求并跟踪结果；返回 requestId（用来停止）。 */
export async function stream(start: () => Promise<string>, h: StreamHandlers): Promise<string> {
  ensure()
  const id = await start()
  let all = ''
  const handle: Handler = (e) => {
    if (e.type === 'delta') {
      all += e.text
      h.onDelta?.(e.text, all)
    } else {
      handlers.delete(id)
      if (e.type === 'done') h.onDone?.(e)
      else h.onError?.(e)
    }
  }
  handlers.set(id, handle)
  const queued = early.get(id)
  early.delete(id)
  queued?.forEach(handle)
  return id
}

export function useAiStatus(): AiStatus | null {
  const [s, setS] = useState<AiStatus | null>(null)
  useEffect(() => {
    let alive = true
    void api.ai.status().then((x) => alive && setS(x))
    const off = api.ai.onStatus((x) => setS(x))
    return () => {
      alive = false
      off()
    }
  }, [])
  return s
}

/** 服务显示的名字：自定义地址用起的名字或地址 */
export function serviceName(s: AiService): string {
  if (s.vendor === 'custom') return s.name || host(s.baseUrl)
  return vendorOf(s.vendor)?.name ?? s.vendor
}

/** 告诉用户论文会发到哪里 */
export function serviceLabel(s: AiService): string {
  const name = serviceName(s)
  return s.vendor !== 'custom' && s.baseUrl ? `${name}（经 ${host(s.baseUrl)}）` : name
}

/** 能发请求的服务（有 Key，或不要 Key 的自定义地址） */
export function usableServices(st: AiStatus | null): AiService[] {
  return (st?.services ?? []).filter((s) => s.hasKey || vendorOf(s.vendor)?.keyOptional)
}

export function host(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
