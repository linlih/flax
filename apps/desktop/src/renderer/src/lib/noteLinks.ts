// 笔记里 ⌘ 点击的位置落在哪个链接上
type Hit = { kind: 'note' | 'annotation' | 'web'; target: string }
export function linkAt(line: string, col: number): Hit | null {
  for (const m of line.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
    if (col >= m.index! && col <= m.index! + m[0].length) return { kind: 'note', target: m[1]!.split('|')[0]!.split('#')[0]!.trim() }
  }
  for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)|(https?:\/\/[^\s)>\]]+)/g)) {
    if (col < m.index! || col > m.index! + m[0].length) continue
    const url = m[1] ?? m[2]!
    const anno = /^paper:\/\/annotation\/(.+)$/.exec(url)
    if (anno) return { kind: 'annotation', target: anno[1]! }
    if (/^https?:/.test(url)) return { kind: 'web', target: url }
  }
  return null
}

