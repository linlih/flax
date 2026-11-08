// AI 服务设置：可以加好几家服务，每家一个 Key；对话里选用哪个模型。
// Key 用系统钥匙串加密（Electron safeStorage）后存盘，不进渲染进程、不写日志；系统不支持加密时不保存 Key。
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AI_VENDORS, guessVendor, vendorOf } from '../../shared/aiVendors'
import { AI_EFFORTS, type AiConfig, type AiEffort, type AiSelection, type AiService, type AiUsage, type AiUsageTotal, type MtAccountInfo, type MtEngine, type TranslateEngine } from '../../shared/api'
import { mtEngineOf } from '../../shared/mtEngines'
import type { MtAccount } from './mt'

export interface Crypt {
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

type StoredService = Omit<AiService, 'hasKey'>
type StoredMt = Omit<MtAccountInfo, 'hasSecret'>
interface TranslateState {
  engine: TranslateEngine
  /** 用户自己选过；没选过时由服务按情况挑（系统翻译能用就用它） */
  chosen: boolean
  accounts: StoredMt[]
}

const validEngine = (e: unknown): e is TranslateEngine => e === 'ai' || e === 'apple' || (typeof e === 'string' && !!mtEngineOf(e))
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

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
  private state: { services: StoredService[]; selection: AiSelection | null; effort: AiEffort; usage: AiUsageTotal; translate: TranslateState }

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
    const effort = AI_EFFORTS.includes(saved['effort'] as AiEffort) ? (saved['effort'] as AiEffort) : 'auto'
    const t = (saved['translate'] ?? {}) as Partial<Record<keyof TranslateState, unknown>>
    const accounts: StoredMt[] = []
    for (const a of Array.isArray(t.accounts) ? (t.accounts as Record<string, unknown>[]) : []) {
      if (a && mtEngineOf(String(a['engine'])) && !accounts.some((x) => x.engine === a['engine'])) accounts.push({ engine: a['engine'] as MtEngine, id: clean(a['id'], 200), region: clean(a['region'], 40) })
    }
    this.state = { services, selection, effort, usage, translate: { engine: validEngine(t.engine) ? t.engine : 'ai', chosen: t.chosen === true, accounts } }

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

  effort(): AiEffort {
    return this.state.effort
  }

  setEffort(e: unknown): void {
    if (!AI_EFFORTS.includes(e as AiEffort)) throw new Error('思考深度不对')
    this.state.effort = e as AiEffort
    this.write()
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

  // —— 翻译 ——
  /** 用户选的那家；没选过是 null */
  translateEngine(): TranslateEngine | null {
    return this.state.translate.chosen ? this.state.translate.engine : null
  }

  mtAccounts(): MtAccountInfo[] {
    return this.state.translate.accounts.map((a) => ({ ...a, hasSecret: this.hasKey(`mt-${a.engine}`) }))
  }

  /** 发请求用的账号；没填全就是 null */
  mtAccount(engine: MtEngine): MtAccount | null {
    const a = this.state.translate.accounts.find((x) => x.engine === engine)
    const info = mtEngineOf(engine)
    const secret = this.key(`mt-${engine}`)
    if (!a || !info || !secret || (info.idLabel && !a.id)) return null
    return { id: a.id, secret, region: a.region }
  }

  setTranslateEngine(e: unknown): void {
    if (!validEngine(e)) throw new Error('不认识的翻译服务')
    this.state.translate.engine = e
    this.state.translate.chosen = true
    this.write()
  }

  /** 填某家翻译的账号；secret：字符串换新的，null 删掉这家，undefined 不动 */
  saveMtAccount(input: unknown, secret?: string | null): void {
    const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    const info = mtEngineOf(String(o['engine']))
    if (!info) throw new Error('不认识的翻译服务')
    const engine = info.id
    const t = this.state.translate
    if (secret === null) {
      rmSync(this.keyPath(`mt-${engine}`), { force: true })
      t.accounts = t.accounts.filter((a) => a.engine !== engine)
      if (t.engine === engine) t.chosen = false
      return this.write()
    }
    const id = clean(o['id'], 200)
    const region = clean(o['region'], 40)
    if (info.idLabel && !id) throw new Error(`请填写 ${info.idLabel}`)
    if (region && !/^[a-z0-9-]+$/i.test(region)) throw new Error('区域只能是字母、数字和横线，比如 eastasia')
    if (typeof secret === 'string' && secret.trim()) {
      if (!this.canEncrypt()) throw new Error('系统钥匙串不可用，不能安全地保存密钥')
      mkdirSync(this.keyDir, { recursive: true })
      writeFileSync(this.keyPath(`mt-${engine}`), this.crypt.encrypt(secret.trim()), { mode: 0o600 })
    } else if (!this.hasKey(`mt-${engine}`)) {
      throw new Error(`请填写 ${info.secretLabel}`)
    }
    const next = { engine, id: info.idLabel ? id : '', region: info.regionLabel ? region : '' }
    const i = t.accounts.findIndex((a) => a.engine === engine)
    if (i >= 0) t.accounts[i] = next
    else t.accounts.push(next)
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
