// 自动更新：从 GitHub Releases（package.json 的 build.publish）找新版本。
// 打开应用一会儿后悄悄检查；有新版本只告诉用户（版本号和发布说明），不自己下载。
// 用户点"立即更新"才下载，下好就重启安装。菜单和设置里可以手动检查，手动检查才把"已经是最新""检查失败"告诉用户。
// macOS 上只有签了名的应用才能自动更新；开发时不检查。
import { app } from 'electron'
import type { UpdateState } from '../shared/api'

/** 测试和开发时换成假的 */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: string, fn: (...args: never[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
}

export class Updater {
  private state: UpdateState = { kind: 'idle' }
  private manual = false

  constructor(private u: UpdaterLike | null, private send: (s: UpdateState) => void) {
    if (!u) return
    // 不自己下载：用户点了"立即更新"才下（下好的版本退出时也会装上，但只有用户同意过才会有下好的版本）
    u.autoDownload = false
    u.autoInstallOnAppQuit = true
    u.on('checking-for-update', () => this.set({ kind: 'checking' }))
    u.on('update-not-available', () => this.set({ kind: 'latest' }))
    u.on('update-available', (info: { version: string; releaseNotes?: unknown }) => {
      const notes = notesText(info.releaseNotes)
      this.set(notes ? { kind: 'available', version: info.version, notes } : { kind: 'available', version: info.version })
    })
    u.on('download-progress', (p: { percent: number }) => {
      if (this.state.kind === 'downloading') this.set({ ...this.state, percent: Math.round(p.percent) })
    })
    // 用户点的是"立即更新"，下好就直接重启安装，不再问一遍
    u.on('update-downloaded', (info: { version: string }) => {
      this.set({ kind: 'ready', version: info.version })
      this.u?.quitAndInstall()
    })
    u.on('error', (e: Error) => this.set({ kind: 'error', message: friendly(e) }))
  }

  get(): UpdateState {
    return this.state
  }

  /** manual：用户点的"检查更新"，结果要告诉他 */
  check(manual = false): UpdateState {
    if (!this.u) return this.set({ kind: 'dev', manual })
    if (this.state.kind === 'available' || this.state.kind === 'downloading' || this.state.kind === 'ready') return this.set({ ...this.state, manual })
    this.manual = manual
    void this.u.checkForUpdates().catch((e: unknown) => this.set({ kind: 'error', message: friendly(e) }))
    return this.state
  }

  /** 用户点了"立即更新"：下载，下好后重启安装 */
  install(): void {
    if (!this.u) return
    if (this.state.kind === 'ready') return this.u.quitAndInstall()
    if (this.state.kind !== 'available') return
    this.set({ kind: 'downloading', version: this.state.version, manual: true })
    void this.u.downloadUpdate().catch((e: unknown) => this.set({ kind: 'error', message: friendly(e), manual: true }))
  }

  private set(s: UpdateState): UpdateState {
    this.state = { ...s, manual: s.manual ?? this.manual }
    this.send(this.state)
    return this.state
  }
}

/** GitHub 给的发布说明是 HTML（有时是按版本分的数组），变成纯文本列表显示 */
export function notesText(n: unknown): string {
  const html = Array.isArray(n) ? n.map((x: { note?: string | null }) => x?.note ?? '').join('\n') : typeof n === 'string' ? n : ''
  return html
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>|<\/(p|div|h\d|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' })[e]!)
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
    .slice(0, 2000)
}

function friendly(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  if (/404|Not Found|Cannot find latest/i.test(m)) return '还没有发布过可以更新的版本。'
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::ERR/i.test(m)) return '连不上更新服务器，检查一下网络。'
  if (/signature|code sign/i.test(m)) return '这个版本没有签名，不能自动更新，请到官网下载新版本。'
  return m.split('\n')[0]!.slice(0, 160)
}

/** 打包后的应用才用真的 electron-updater */
export async function realUpdater(): Promise<UpdaterLike | null> {
  if (!app.isPackaged) return null
  // electron-updater 是 CommonJS，autoUpdater 是个 getter：用 import() 拿时具名导出可能是空的，要从 default 上取
  const m = (await import('electron-updater')) as unknown as { autoUpdater?: UpdaterLike; default?: { autoUpdater?: UpdaterLike } }
  return m.autoUpdater ?? m.default?.autoUpdater ?? null
}
