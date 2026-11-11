// 检查更新：看 GitHub 上最新发布的版本（和桌面的自动更新同一个仓库），里面有 .apk 就给下载链接。
// 不在应用里自己装：交给浏览器下载，用户点开安装（Android 会问一次"允许安装未知应用"）。
import Constants from 'expo-constants'

const LATEST = 'https://api.github.com/repos/linlih/flax/releases/latest'

export type UpdateCheck = { kind: 'latest'; version: string } | { kind: 'no_apk'; version: string } | { kind: 'available'; version: string; url: string; notes: string; size?: number } | { kind: 'error'; message: string }

export function currentVersion(): string {
  return Constants.expoConfig?.version ?? '0.0.0'
}

/** 1.2.10 > 1.2.9；前面的 v 和后面的 -beta 不算 */
export function newer(a: string, b: string): boolean {
  const p = (v: string) => v.replace(/^v/, '').split('-')[0]!.split('.').map((x) => Number(x) || 0)
  const x = p(a)
  const y = p(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

export async function checkUpdate(): Promise<UpdateCheck> {
  try {
    const res = await fetch(LATEST, { headers: { Accept: 'application/vnd.github+json' } })
    if (res.status === 404) return { kind: 'error', message: '还没有发布过可以更新的版本。' }
    if (!res.ok) return { kind: 'error', message: `检查失败（${res.status}），稍后再试。` }
    const r = (await res.json()) as { tag_name?: string; body?: string; assets?: { name: string; browser_download_url: string; size: number }[] }
    const version = (r.tag_name ?? '').replace(/^v/, '')
    const apk = r.assets?.find((a) => a.name.toLowerCase().endsWith('.apk'))
    if (!version || !newer(version, currentVersion())) return { kind: 'latest', version: currentVersion() }
    // 新版本只发了电脑版：说清楚，不说"已是最新"
    if (!apk) return { kind: 'no_apk', version }
    return { kind: 'available', version, url: apk.browser_download_url, notes: (r.body ?? '').trim(), size: apk.size }
  } catch {
    return { kind: 'error', message: '连不上 GitHub，检查网络后再试。' }
  }
}
