// 这台设备给人看的名字：同步的设备列表、"在 MacBook Pro 上读到第 12 页"。
// macOS 上用"共享"设置里的电脑名（有空格、大小写），主机名（MacBook-Pro.local）留作后备
import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'

let cached: string | null = null

export function deviceName(): string {
  if (cached) return cached
  let name = ''
  if (process.platform === 'darwin') {
    try {
      name = execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }).trim()
    } catch {}
  }
  cached = name || hostname().replace(/\.local$/, '')
  return cached
}
