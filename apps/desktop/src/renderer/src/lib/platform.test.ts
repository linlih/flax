import { describe, expect, it } from 'vitest'
import { kbd } from './platform'

describe('kbd', () => {
  it('keeps macOS symbols on macOS', () => expect(kbd('返回（⌘[）', true)).toBe('返回（⌘[）'))
  it('turns symbols into Windows names', () => {
    expect(kbd('⌘K', false)).toBe('Ctrl+K')
    expect(kbd('隐藏缩略图（⌥⌘S）', false)).toBe('隐藏缩略图（Ctrl+Alt+S）')
    expect(kbd('写点什么…（⌘↩ 保存）', false)).toBe('写点什么…（Ctrl+Enter 保存）')
    expect(kbd('⇧⌘Z', false)).toBe('Ctrl+Shift+Z')
    expect(kbd('⌘[ 和 ⌘]', false)).toBe('Ctrl+[ 和 Ctrl+]')
    expect(kbd('⌘点击', false)).toBe('Ctrl+点击')
    expect(kbd('⌘ 点击打开', false)).toBe('Ctrl 点击打开')
    expect(kbd('空格 / ⇧空格', false)).toBe('空格 / Shift+空格')
    expect(kbd('⇧↩', false)).toBe('Shift+Enter')
    expect(kbd('⌘+ / ⌘− / ⌘0', false)).toBe('Ctrl++ / Ctrl+− / Ctrl+0')
    expect(kbd('⌘,', false)).toBe('Ctrl+,')
  })
})
