// 浏览器插件连接服务的开关、端口和存好以后的系统通知。
// 设置存在配置目录的 connector.json（每台电脑自己的，不放资料文件夹，不跟着同步走）。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConnectorSettings } from '../shared/api'
import { CONNECTOR_PORT, startConnector, type ConnectorDeps, type ConnectorState } from './connector'

export interface ConnectorServiceOptions {
  configDir: string
  deps: Omit<ConnectorDeps, 'onSaved'>
  /** 发一条系统通知；点了它调 onClick */
  notify(title: string, body: string, onClick: () => void): void
  onState(s: ConnectorState): void
  /** 合并通知的等待时间（测试用） */
  mergeMs?: number
}

const validPort = (p: unknown): p is number => Number.isInteger(p) && (p as number) >= 1024 && (p as number) <= 65535

export class ConnectorService {
  private file: string
  private current: ConnectorSettings
  private running: { stop(): void } | null = null
  private st: ConnectorState = { kind: 'off' }
  private pending: { paperId: string; title: string }[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private o: ConnectorServiceOptions) {
    this.file = join(o.configDir, 'connector.json')
    let saved: Partial<ConnectorSettings> = {}
    try { saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ConnectorSettings> } catch { /* 第一次用 */ }
    this.current = { enabled: saved.enabled !== false, port: validPort(saved.port) ? saved.port : CONNECTOR_PORT }
  }

  settings(): ConnectorSettings {
    return { ...this.current }
  }

  state(): ConnectorState {
    return this.st
  }

  start(): void {
    this.running?.stop()
    this.running = null
    if (!this.current.enabled) return this.setState({ kind: 'off' })
    this.running = startConnector({ ...this.o.deps, onSaved: (r, quiet) => r.status === 'added' && !quiet && this.saved(r) }, this.current.port, (s) => this.setState(s))
  }

  stop(): void {
    this.running?.stop()
    this.running = null
    if (this.timer) clearTimeout(this.timer)
  }

  set(patch: { enabled?: unknown; port?: unknown }): ConnectorSettings {
    const next = { ...this.current }
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
    if (patch.port !== undefined) {
      if (!validPort(patch.port)) throw new Error('端口要是 1024 到 65535 之间的整数')
      next.port = patch.port
    }
    this.current = next
    try { writeFileSync(this.file, JSON.stringify(next, null, 2)) } catch (e) { console.error('connector settings:', e) }
    this.start()
    return this.settings()
  }

  private setState(s: ConnectorState): void {
    this.st = s
    this.o.onState(s)
  }

  /** 连着存几篇时合并成一条通知 */
  private saved(r: { paperId: string; title: string }): void {
    this.pending.push(r)
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      const list = this.pending.splice(0)
      if (list.length === 1) this.o.notify('已存进文献库', list[0]!.title, () => this.o.deps.open(list[0]!.paperId))
      else if (list.length > 1) this.o.notify(`已存进文献库：${list.length} 篇`, list.map((x) => x.title).join('\n'), () => this.o.deps.open(list.at(-1)!.paperId))
    }, this.o.mergeMs ?? 1500)
  }
}
