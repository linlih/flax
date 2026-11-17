// 双击查词：双击一个词就把它标出来，交给 RN 翻译（底部弹出小卡片）。PDF 和网页版共用。
// 单击要等一下（看是不是双击），所以单击的动作晚 ~260ms 才做；长按选字照旧。
type Tap = (e: PointerEvent) => void

const DOUBLE_MS = 300
const DOUBLE_PX = 30
const SINGLE_DELAY = 260

/** 分开单击和双击：第二下在 300ms、30px 以内算双击，第一下的单击动作就不做了 */
export function makeTapper(single: Tap, double: Tap): Tap {
  let last: { x: number; y: number; t: number } | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  return (e) => {
    const now = Date.now()
    if (last && now - last.t < DOUBLE_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < DOUBLE_PX) {
      clearTimeout(timer)
      last = null
      double(e)
      return
    }
    last = { x: e.clientX, y: e.clientY, t: now }
    clearTimeout(timer)
    timer = setTimeout(() => single(e), SINGLE_DELAY)
  }
}

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null }
  if (d.caretRangeFromPoint) {
    const r = d.caretRangeFromPoint(x, y)
    return r ? { node: r.startContainer, offset: r.startOffset } : null
  }
  const p = d.caretPositionFromPoint?.(x, y)
  return p ? { node: p.offsetNode, offset: p.offset } : null
}

const WORDISH = /[\p{L}\p{N}]/u

/** 点到的那个词（连字符连着的词算一个，如 grouped-query）。没点在字上就是 null */
/** 点在字框外面一点（PDF 文字层的字框比画出来的字窄）：找同一行上最近的字框，取它靠近的那一头 */
function nearestText(x: number, y: number, within: Element): { node: Node; offset: number } | null {
  let best: { node: Node; offset: number } | null = null
  let bd = Infinity
  for (const el of within.querySelectorAll('span')) {
    const tn = el.firstChild
    if (!tn || tn.nodeType !== Node.TEXT_NODE || !tn.textContent) continue
    const q = el.getBoundingClientRect()
    if (y < q.top - 4 || y > q.bottom + 4) continue
    const d = x < q.left ? q.left - x : x > q.right ? x - q.right : 0
    if (d < bd && d <= Math.max(6, q.height)) {
      bd = d
      best = { node: tn, offset: x > q.right ? tn.textContent.length : 0 }
    }
  }
  return best
}

export function wordAt(x: number, y: number, within: Element): Range | null {
  let c = caretAt(x, y)
  if (!c || c.node.nodeType !== Node.TEXT_NODE || !within.contains(c.node)) c = within.classList.contains('textLayer') ? nearestText(x, y, within) : null
  if (!c) return null
  const text = c.node.textContent ?? ''
  if (!text) return null
  const seg = new Intl.Segmenter(undefined, { granularity: 'word' })
  const words = [...seg.segment(text)].filter((s) => s.isWordLike)
  // caret 可能落在词的后边界上：前后都试
  let i = words.findIndex((w) => c.offset >= w.index && c.offset < w.index + w.segment.length)
  if (i < 0) i = words.findIndex((w) => c.offset === w.index + w.segment.length)
  if (i < 0) return null
  let a = words[i]!.index
  let b = a + words[i]!.segment.length
  // 用连字符接起来的前后词
  for (let j = i; j > 0 && text[words[j]!.index - 1] === '-' && words[j - 1]!.index + words[j - 1]!.segment.length === words[j]!.index - 1; j--) a = words[j - 1]!.index
  for (let j = i; j < words.length - 1 && text[words[j]!.index + words[j]!.segment.length] === '-' && words[j + 1]!.index === words[j]!.index + words[j]!.segment.length + 1; j++) b = words[j + 1]!.index + words[j + 1]!.segment.length
  if (!WORDISH.test(text.slice(a, b))) return null
  const r = document.createRange()
  r.setStart(c.node, a)
  r.setEnd(c.node, b)
  // caret 会落到最近的字上：点在空白处时别把远处的词当成点中了。
  // 左右放宽一个字高：PDF 文字层的字框比画出来的字窄一点，点在词尾也要算
  const hit = [...r.getClientRects()].some((q) => {
    const sx = Math.max(6, q.height)
    return x >= q.left - sx && x <= q.right + sx && y >= q.top - 6 && y <= q.bottom + 6
  })
  return hit ? r : null
}

/** 词所在的那句话。textOf 把一段 Range 变成干净的文字（网页版去掉公式源码，PDF 在换行处补空格） */
export function sentenceAround(word: Range, block: Element, textOf: (r: Range) => string): string {
  const before = document.createRange()
  before.setStart(block, 0)
  before.setEnd(word.startContainer, word.startOffset)
  const all = document.createRange()
  all.selectNodeContents(block)
  const full = textOf(all)
  let at = textOf(before).length
  // textOf 会去掉末尾空格：别让句首的词算到上一句里
  if (/\s/.test(full[at] ?? '')) at++
  const seg = new Intl.Segmenter(undefined, { granularity: 'sentence' })
  for (const s of seg.segment(full)) {
    if (at >= s.index && at < s.index + s.segment.length) return tidy(s.segment)
  }
  return tidy(full)
}

const tidy = (s: string) => s.replace(/(\p{L})-\s+(\p{Ll})/gu, '$1$2').replace(/\s+/g, ' ').trim().slice(0, 800)

/** PDF 文字层的文字：<br> 和各行之间补上空格 */
export function pdfTextOf(r: Range): string {
  const root = r.commonAncestorContainer
  const walker = document.createTreeWalker(root.nodeType === Node.TEXT_NODE ? root.parentNode! : root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  let out = ''
  for (let n: Node | null = walker.currentNode; n; n = walker.nextNode()) {
    if (!r.intersectsNode(n)) continue
    if (n.nodeType === Node.ELEMENT_NODE) {
      if ((n as Element).tagName === 'BR' && !out.endsWith(' ')) out += ' '
      continue
    }
    const t = n.textContent ?? ''
    const s = n === r.startContainer ? r.startOffset : 0
    const e = n === r.endContainer ? r.endOffset : t.length
    out += t.slice(s, e)
  }
  // 连字（ﬁ、ﬂ）拆开：查词、加术语表都用普通字母
  return out.replace(/[\uFB00-\uFB06]/g, (c) => c.normalize('NFKC'))
}

// —— 标出查的词（CSS Highlight，不改文字结构）——
type Highlights = { set(name: string, h: unknown): void; delete(name: string): void }
const hl = (globalThis as unknown as { CSS?: { highlights?: Highlights } }).CSS?.highlights
const HighlightCtor = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight

let marked: Range | null = null

export function markLookup(r: Range | null): void {
  if (!hl || !HighlightCtor) return
  const prev = marked
  marked = r
  if (r) hl.set('fx-lookup', new HighlightCtor(r))
  else hl.delete('fx-lookup')
  // iOS 的 WebKit 去掉 Highlight 后不重画那块：碰一下那个元素的样式逼它重画
  const el = prev?.startContainer.parentElement
  if (el && prev !== r) {
    el.style.opacity = '0.999'
    requestAnimationFrame(() => requestAnimationFrame(() => (el.style.opacity = '')))
  }
}

/** 双击后系统可能顺手选中一个词：清掉，并在一小会儿里不把选区报给 RN */
let quietUntil = 0
export function quietSelection(): void {
  quietUntil = Date.now() + 600
  document.getSelection()?.removeAllRanges()
  setTimeout(() => document.getSelection()?.removeAllRanges(), 50)
}
export const selectionQuiet = () => Date.now() < quietUntil
