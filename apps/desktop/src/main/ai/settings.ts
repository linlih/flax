// AI 服务设置：可以加好几家服务，每家一个 Key；对话里选用哪个模型。
// Key 用系统钥匙串加密（Electron safeStorage）后存盘，不进渲染进程、不写日志；系统不支持加密时不保存 Key。
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AI_VENDORS, guessVendor, vendorOf } from '../../shared/aiVendors'
import type { AiConfig, AiSelection, AiService, AiUsage, AiUsageTotal } from '../../shared/api'

export interface Crypt {
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

type StoredService = Omit<AiService, 'hasKey'>

const ZERO: AiUsageTotal = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }
const ID = /^[a-z0-9-]{1,40}$/

/** 检查并整理一个服务的设置 */
export function validService(v: unknown): Omit<StoredService, 'id'> & { id?: string } {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '')
  const vendor = vendorOf(str('vendor'))
  if (!vendor) throw new Error('不认识的服务')
  const baseUrl = str('baseUrl').replace(/\/+$/, '')
  if (baseUrl && !/^https?:\/\/[^\s]+$/.test(baseUrl)) throw new Error('服务地址要以 http:// 或 https:// 开头')
  if (vendor.id === 'custom' && !baseUrl) throw new Error('请填写服务地址')
  const id = str('id') || undefined
  if (id && !ID.test(id)) throw new Error('bad service id')
  return { id, vendor: vendor.id, name: str('name').slice(0, 40), baseUrl: baseUrl === vendor.baseUrl ? '' : baseUrl }
}

export class AiSettings {
  private file: string
  private keyDir: string
  private state: { services: StoredService[]; selection: AiSelection | null; usage: AiUsageTotal }

  constructor(private dir: string, private crypt: Crypt) {
    this.file = join(dir, 'settings.json')
    this.keyDir = join(dir, 'keys')
    let saved: Record<string, unknown> = {}
    try {
      saved = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>
    } catch {
      /* 第一次用 */
    }
    const u = (saved['usage'] ?? {}) as Partial<AiUsageTotal>
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
    const usage = { inputTokens: num(u.inputTokens), outputTokens: num(u.outputTokens), costUsd: num(u.costUsd), calls: num(u.calls) }

    const services: StoredService[] = []
    for (const s of Array.isArray(saved['services']) ? saved['services'] : []) {
      try {
        const v = validService(s)
        if (v.id && !services.some((x) => x.id === v.id)) services.push({ ...v, id: v.id })
      } catch {
        /* 坏的条目跳过 */
      }
    }
    const sel = saved['selection'] as AiSelection | null | undefined
    let selection = sel && typeof sel.service === 'string' && typeof sel.model === 'string' && sel.model ? { service: sel.service, model: sel.model } : null
    this.state = { services, selection, usage }

    // 旧设置：只有一个 config（以及最早的 key.bin）
    const old = saved['config'] as Record<string, unknown> | undefined
    if (old && !Array.isArray(saved['services'])) this.migrate(old)
    selection = this.state.selection
    if (selection && !this.state.services.some((s) => s.id === selection!.service)) this.state.selection = null
  }

  private migrate(old: Record<string, unknown>): void {
    const str = (k: string) => (typeof old[k] === 'string' ? (old[k] as string).trim().replace(/\/+$/, '') : '')
    const vendor = str('vendor') || guessVendor(str('provider'), str('baseUrl'))
    try {
      mkdirSync(this.keyDir, { recursive: true })
      if (existsSync(join(this.dir, 'key.bin'))) renameSync(join(this.dir, 'key.bin'), this.keyPath(vendor))
    } catch {
      /* 下次再试 */
    }
    // 存了 Key 的每一家都算加过；当时选的那家带上它的地址
    for (const { id: v } of AI_VENDORS) {
      const current = v === vendor
      if (!existsSync(this.keyPath(v)) && !(current && v === 'custom')) continue
      try {
        const s = validService({ id: v, vendor: v, baseUrl: current ? str('baseUrl') : '' })
        this.state.services.push({ ...s, id: v })
      } catch {
        /* 自定义地址没填就不加 */
      }
    }
    if (str('model') && this.state.services.some((s) => s.id === vendor)) this.state.selection = { service: vendor, model: str('model') }
    this.write()
  }

  services(): AiService[] {
    return this.state.services.map((s) => ({ ...s, hasKey: this.hasKey(s.id) }))
  }

  service(id: string): AiService | undefined {
    return this.services().find((s) => s.id === id)
  }

  selection(): AiSelection | null {
    return this.state.selection
  }

  usage(): AiUsageTotal {
    return this.state.usage
  }

  canEncrypt(): boolean {
    try {
      return this.crypt.available()
    } catch {
      return false
    }
  }

  key(serviceId: string): string | null {
    try {
      return this.crypt.decrypt(readFileSync(this.keyPath(serviceId))) || null
    } catch {
      return null
    }
  }

  hasKey(serviceId: string): boolean {
    try {
      return existsSync(this.keyPath(serviceId))
    } catch {
      return false
    }
  }

  /** 这个服务能不能发请求：有 Key，或者是不要 Key 的自定义地址 */
  usable(serviceId: string): boolean {
    const s = this.state.services.find((x) => x.id === serviceId)
    return !!s && (this.hasKey(s.id) || !!vendorOf(s.vendor)?.keyOptional)
  }

  ready(): boolean {
    const sel = this.state.selection
    return !!sel && this.usable(sel.service)
  }

  /** 发请求用的连接信息；默认用对话里选的模型 */
  connection(sel: AiSelection | null = this.state.selection): { config: AiConfig; key: string | null } | null {
    if (!sel) return null
    const s = this.state.services.find((x) => x.id === sel.service)
    const v = s && vendorOf(s.vendor)
    if (!s || !v) return null
    return { config: { vendor: s.vendor, provider: v.kind, model: sel.model, baseUrl: s.baseUrl }, key: this.key(s.id) }
  }

  /** 加服务或改设置；key：字符串换新的，null 删除，undefined 不动。返回服务 id */
  saveService(input: unknown, key?: string | null): string {
    const v = validService(input)
    let id = v.id
    if (id && !this.state.services.some((s) => s.id === id)) throw new Error('这个服务已经删掉了')
    if (!id) {
      // 官方服务每家只加一次；自定义地址可以加好几个
      if (v.vendor !== 'custom' && this.state.services.some((s) => s.vendor === v.vendor)) throw new Error('这家服务已经加过了')
      id = v.vendor === 'custom' ? `custom-${randomBytes(3).toString('hex')}` : v.vendor
    }
    if (typeof key === 'string' && key.trim()) {
      if (!this.canEncrypt()) throw new Error('系统钥匙串不可用，不能安全地保存 Key')
      mkdirSync(this.keyDir, { recursive: true })
      writeFileSync(this.keyPath(id), this.crypt.encrypt(key.trim()), { mode: 0o600 })
    } else if (key === null) {
      rmSync(this.keyPath(id), { force: true })
    }
    const next: StoredService = { id, vendor: v.vendor, name: v.name, baseUrl: v.baseUrl }
    const i = this.state.services.findIndex((s) => s.id === id)
    if (i >= 0) this.state.services[i] = next
    else this.state.services.push(next)
    this.write()
    return id
  }

  removeService(id: string): void {
    this.state.services = this.state.services.filter((s) => s.id !== id)
    if (ID.test(id)) rmSync(this.keyPath(id), { force: true })
    if (this.state.selection?.service === id) this.state.selection = null
    this.write()
  }

  select(sel: unknown): void {
    const o = (sel && typeof sel === 'object' ? sel : {}) as Record<string, unknown>
    const service = typeof o['service'] === 'string' ? o['service'] : ''
    const model = typeof o['model'] === 'string' ? o['model'].trim() : ''
    if (!this.state.services.some((s) => s.id === service)) throw new Error('没有这个服务')
    if (!model || model.length > 200) throw new Error('模型名不对')
    this.state.selection = { service, model }
    this.write()
  }

  addUsage(u: AiUsage): void {
    const t = this.state.usage
    this.state.usage = {
      inputTokens: t.inputTokens + u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens,
      outputTokens: t.outputTokens + u.outputTokens,
      costUsd: t.costUsd + (u.costUsd ?? 0),
      calls: t.calls + 1
    }
    this.write()
  }

  private keyPath(id: string): string {
    if (!ID.test(id)) throw new Error('bad service id')
    return join(this.keyDir, `${id}.bin`)
  }

  private write(): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.state, null, 2))
    } catch {
      /* 写不了就只在这次运行里有效 */
    }
  }
}
