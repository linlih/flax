// macOS 自带的翻译：通过随 App 带的小助手（native/translate）调用，在这台 Mac 上翻，不联网、不用 Key。
// 小助手第一次用时启动，之后一直开着；它退出了下次再启动。
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { AiError } from './providers'

/** installed：能用；supported：系统支持，但英语、中文的翻译语言还没下载；unsupported / unavailable：用不了（系统太旧、没有小助手） */
export type AppleStatus = 'installed' | 'supported' | 'unsupported' | 'unavailable'

type Reply = { id?: string; text?: string; status?: string; error?: string; code?: string; ready?: boolean }

export class AppleTranslator {
  private proc: ChildProcessWithoutNullStreams | null = null
  private waiting = new Map<string, (r: Reply) => void>()
  private next = 0
  private buf = ''

  constructor(private bin: string) {}

  available(): boolean {
    return process.platform === 'darwin' && existsSync(this.bin)
  }

  async status(): Promise<AppleStatus> {
    if (!this.available()) return 'unavailable'
    try {
      const r = await this.call({ op: 'status' }, 10_000)
      return r.status === 'installed' || r.status === 'supported' || r.status === 'unsupported' ? r.status : 'unavailable'
    } catch {
      return 'unavailable'
    }
  }

  async translate(text: string, toEnglish: boolean, signal: AbortSignal): Promise<string> {
    if (!this.available()) throw new AiError('other', '这台电脑用不了系统翻译。')
    const r = await this.call({ op: 'translate', text, toEnglish }, 30_000, signal)
    if (r.error) {
      if (r.code === 'notInstalled') throw new AiError('no_key', '第一次用系统翻译，要先在系统设置里下载英语和中文的翻译语言。')
      if (r.code === 'unsupported') throw new AiError('other', '系统翻译不支持这种语言。')
      throw new AiError('other', `系统翻译出错了：${r.error}`)
    }
    return r.text ?? ''
  }

  stop(): void {
    this.proc?.kill()
    this.proc = null
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc
    const p = spawn(this.bin, [], { stdio: 'pipe' })
    p.stdout.setEncoding('utf8')
    p.stdout.on('data', (chunk: string) => {
      this.buf += chunk
      let i: number
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 1)
        try {
          const r = JSON.parse(line) as Reply
          if (r.id) this.waiting.get(r.id)?.(r)
        } catch {
          /* 不是 JSON 的行不管 */
        }
      }
    })
    const gone = () => {
      if (this.proc !== p) return
      this.proc = null
      this.buf = ''
      for (const done of this.waiting.values()) done({ error: '系统翻译小助手退出了', code: 'other' })
      this.waiting.clear()
    }
    p.on('exit', gone)
    p.on('error', gone)
    p.stdin.on('error', () => {})
    this.proc = p
    return p
  }

  private call(msg: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<Reply> {
    const id = String(++this.next)
    return new Promise<Reply>((resolve, reject) => {
      const finish = (fn: () => void) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.waiting.delete(id)
        fn()
      }
      const timer = setTimeout(() => finish(() => reject(new AiError('network', '系统翻译没有响应，稍后再试。'))), timeoutMs)
      const onAbort = () => finish(() => reject(new AiError('cancelled', '已停止')))
      signal?.addEventListener('abort', onAbort)
      this.waiting.set(id, (r) => finish(() => resolve(r)))
      try {
        this.start().stdin.write(JSON.stringify({ ...msg, id }) + '\n')
      } catch (e) {
        finish(() => reject(new AiError('other', e instanceof Error ? e.message : String(e))))
      }
    })
  }
}
