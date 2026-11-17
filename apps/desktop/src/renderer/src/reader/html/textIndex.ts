// 网页正文的文字：把看得见的文字节点按顺序接成一个字符串，记住每个节点从哪开始。
// 找批注、算选区都在这个字符串上做，再换回 DOM 的位置。
// 不算进来的：公式的 LaTeX 源码（<annotation>）、脚注的内容（点了才展开，PDF 里也在页脚）、我们自己加的标记。
// 换段的地方补一个换行，前后两段的词不会粘在一起。

export interface TextIndex {
  text: string
  nodes: { node: Text; start: number }[]
}

const SKIP = 'annotation, annotation-xml, .ltx_note_outer, .fx-skip, style, script'
const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL', 'TABLE', 'TR', 'TD', 'TH', 'FIGURE', 'FIGCAPTION', 'BLOCKQUOTE', 'DT', 'DD', 'PRE'])

function blockOf(n: Node, root: Element): Element {
  for (let el = n.parentElement; el && el !== root; el = el.parentElement) {
    if (BLOCK.has(el.tagName) || (el.namespaceURI?.endsWith('MathML') && el.getAttribute('display') === 'block')) return el
  }
  return root
}

export function buildIndex(root: Element): TextIndex {
  const nodes: TextIndex['nodes'] = []
  let text = ''
  let lastBlock: Element | null = null
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  })
  for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
    if (!n.data) continue
    const b = blockOf(n, root)
    if (lastBlock && b !== lastBlock && !text.endsWith('\n')) text += '\n'
    lastBlock = b
    nodes.push({ node: n, start: text.length })
    text += n.data
  }
  return { text, nodes }
}

/** 第一个起点不小于 at 的节点的下标（二分） */
function nodeAt(ix: TextIndex, at: number): number {
  let lo = 0
  let hi = ix.nodes.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ix.nodes[mid]!.start <= at) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** DOM 位置 (node, offset) 在文字里的位置。落在不算的地方（脚注、公式源码）就取它后面最近的字 */
export function toOffset(ix: TextIndex, node: Node, offset: number): number {
  if (node.nodeType === Node.TEXT_NODE) {
    const i = ix.nodes.findIndex((e) => e.node === node)
    if (i >= 0) return ix.nodes[i]!.start + Math.min(offset, (node as Text).data.length)
  }
  const r = document.createRange()
  try {
    r.setStart(node, node.nodeType === Node.TEXT_NODE ? Math.min(offset, (node as Text).data.length) : offset)
  } catch {
    return 0
  }
  // 第一个在这个位置后面的文字节点
  let lo = 0
  let hi = ix.nodes.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (r.comparePoint(ix.nodes[mid]!.node, 0) < 0) lo = mid + 1
    else hi = mid
  }
  return lo < ix.nodes.length ? ix.nodes[lo]!.start : ix.text.length
}

/** 文字里的 [start, end) 换成 DOM 的 Range */
export function toRange(ix: TextIndex, start: number, end: number): Range | null {
  if (!ix.nodes.length || end <= start) return null
  const a = ix.nodes[nodeAt(ix, start)]!
  const b = ix.nodes[nodeAt(ix, Math.max(start, end - 1))]!
  const r = document.createRange()
  r.setStart(a.node, Math.max(0, Math.min(start - a.start, a.node.data.length)))
  r.setEnd(b.node, Math.max(0, Math.min(end - b.start, b.node.data.length)))
  return r
}

/** 和 [start, end) 有重叠的节点，以及各自重叠的那一段（节点内的位置） */
export function nodesIn(ix: TextIndex, start: number, end: number): { node: Text; from: number; to: number }[] {
  const out: { node: Text; from: number; to: number }[] = []
  for (let i = nodeAt(ix, start); i < ix.nodes.length; i++) {
    const e = ix.nodes[i]!
    if (e.start >= end) break
    const from = Math.max(0, start - e.start)
    const to = Math.min(e.node.data.length, end - e.start)
    if (to > from) out.push({ node: e.node, from, to })
  }
  return out
}
