// 平台差异：macOS 用 ⌘，Windows / Linux 用 Ctrl。快捷键的写法统一按 macOS 的符号写（⌘⌥⇧⌃↩），
// 显示时用 kbd() 换成当前平台的样子；判断按键时用 mod() 代替 e.metaKey。
const platform = typeof window !== 'undefined' ? window.api?.platform : undefined

export const isMac = platform === undefined || platform === 'darwin'
export const isWindows = platform === 'win32'

/** 系统里的叫法：访达 / 资源管理器，废纸篓 / 回收站 */
export const FILES_APP = isMac ? '访达' : '资源管理器'
export const TRASH = isMac ? '废纸篓' : '回收站'
export const KEYCHAIN = isMac ? '系统钥匙串' : '系统的加密存储'

/** 专注模式：macOS 跟系统全屏一样用 ⌃⌘F，其他平台用 Ctrl+Shift+F */
export const FOCUS_KEY = isMac ? '⌃⌘F' : '⇧⌘F'

/** 主修饰键：macOS 的 ⌘，其他平台的 Ctrl */
export function mod(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey
}

const MODS: Record<string, string> = { '⌃': 'Ctrl', '⌘': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift' }
const KEYS: Record<string, string> = { '↩': 'Enter', '⌫': 'Backspace', '⎋': 'Esc' }
const ORDER = ['Ctrl', 'Alt', 'Shift']

/** 把一段文字里的 macOS 快捷键（如 "⌥⌘S"、"⌘↩"）换成当前平台的写法（"Ctrl+Alt+S"、"Ctrl+Enter"） */
export function kbd(text: string, mac = isMac): string {
  if (mac) return text
  return text.replace(/([⌃⌘⌥⇧]+)([^\s\u3000-\u9fff\uff00-\uffef])?/g, (_m, ms: string, key: string | undefined, at: number, all: string) => {
    const mods = [...new Set([...ms].map((c) => MODS[c]!))]
    mods.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
    if (key) return [...mods, KEYS[key] ?? key.toUpperCase()].join('+')
    // "⌘点击"、"⇧空格"：修饰键直接接着一个词
    const next = all[at + ms.length]
    return mods.join('+') + (next && !/\s/.test(next) ? '+' : '')
  }).replace(/[↩⌫⎋]/g, (c) => KEYS[c]!)
}
