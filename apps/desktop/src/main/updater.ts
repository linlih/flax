// 自动更新：从 GitHub Releases（package.json 的 build.publish）找新版本。
// 打开应用一会儿后悄悄检查，有新版本就在后台下载，下好了提示"重启更新"；退出时也会自动装上。
// 菜单和设置里可以手动检查，手动检查才把"已经是最新""检查失败"告诉用户。
// macOS 上只有签了名的应用才能自动更新；开发时不检查。
import { app } from 'electron'
import type { UpdateState } from '../shared/api'

/** 测试和开发时换成假的 */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: string, fn: (...args: never[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(): void
}

export class Updater {
  private state: UpdateState = { kind: 'idle' }
  private manual = false

  constructor(private u: UpdaterLike | null, private send: (s: UpdateState) => void) {
    if (!u) return
    u.autoDownload = true
    u.autoInstallOnAppQuit = true
    u.on('checking-for-update', () => this.set({ kind: 'checking' }))
    u.on('update-not-available', () => this.set({ kind: 'latest' }))
    u.on('update-available', (info: { version: string }) => this.set({ kind: 'downloading', version: info.version }))
    u.on('download-progress', (p: { percent: number }) => {
      if (this.state.kind === 'downloading') this.set({ ...this.state, percent: Math.round(p.percent) })
    })
    u.on('update-downloaded', (info: { version: string }) => this.set({ kind: 'ready', version: info.version }))
    u.on('error', (e: Error) => this.set({ kind: 'error', message: friendly(e) }))
  }

  get(): UpdateState {
    return this.state
  }

  /** manual：用户点的"检查更新"，结果要告诉他 */
  check(manual = false): UpdateState {
    if (!this.u) return this.set({ kind: 'dev', manual })
    if (this.state.kind === 'downloading' || this.state.kind === 'ready') return this.set({ ...this.state, manual })
    this.manual = manual
    void this.u.checkForUpdates().catch((e: unknown) => this.set({ kind: 'error', message: friendly(e) }))
    return this.state
  }

  install(): void {
    if (this.state.kind === 'ready') this.u?.quitAndInstall()
  }

  private set(s: UpdateState): UpdateState {
    this.state = { ...s, manual: s.manual ?? this.manual }
    this.send(this.state)
    return this.state
  }
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
