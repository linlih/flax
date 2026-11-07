// 整个应用的外观：跟随系统 / 浅色 / 深色。
// 用 nativeTheme.themeSource 切换，窗口、菜单和网页里的 prefers-color-scheme 一起变，
// 所以界面和阅读器的纸都不用各自再管一套。选择存在数据目录的 prefs.json 里。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nativeTheme } from 'electron'
import type { Appearance } from '../shared/api'

const VALUES: Appearance[] = ['system', 'light', 'dark']

export function createAppearance(dataDir: string, onChange: () => void) {
  const file = join(dataDir, 'prefs.json')
  const readPrefs = (): Record<string, unknown> => {
    try { return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> } catch { return {} }
  }
  const saved = readPrefs()['appearance']
  nativeTheme.themeSource = VALUES.includes(saved as Appearance) ? (saved as Appearance) : 'system'

  return {
    get: (): Appearance => nativeTheme.themeSource,
    set(value: unknown) {
      if (!VALUES.includes(value as Appearance)) throw new Error('bad appearance')
      nativeTheme.themeSource = value as Appearance
      try { writeFileSync(file, JSON.stringify({ ...readPrefs(), appearance: value }, null, 2)) } catch { /* 存不下就只对这次生效 */ }
      onChange()
    }
  }
}
