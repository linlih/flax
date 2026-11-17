// 在另一种渲染出来的文字里找回一条批注（PDF ↔ arXiv 网页版）。原型：先量一量能对上多少。
// anchor.ts 的 findQuote 要求原文一字不差；两种渲染之间对不上的地方很多——
// 行尾断字（reli-able）、连字（ﬁ）、引号破折号、空格，还有公式（PDF 里是一堆字形，网页里是 MathML）、脚注插在正文中间。
// 做法：两边都只留字母和数字（小写、去掉重音）当"骨架"比，标点空格断字就都不影响了；
// 骨架里一字不差能找到就用前后文挑最像的一处；找不到就用 8 个字一段的小片段去对，
// 把对上的小片段串成一条（允许中间有对不上的公式），按串起来的位置算出起止。
import type { TextQuote } from './model'

export interface Skeleton {
  /** 只剩字母数字，小写 */
  s: string
  /** s 的每个字在原文里的位置 */
  map: number[]
  /** 原文（把找到的范围两头补上标点要用） */
  text: string
  /** 小片段 → 在 s 里出现的位置，第一次模糊查找时建 */
  grams?: Map<string, number[]>
}

export interface Located {
  /** 原文里的 [start, end)，按原文顺序。PDF 上连着的一段（跨过图、脚注、分栏）在网页里可能拆成几段 */
  ranges: [number, number][]
  /** exact：骨架一字不差；fuzzy：小片段串起来；context：正文全对不上（多半整段是公式），靠前后文夹出来 */
  how: 'exact' | 'fuzzy' | 'context'
  /** 正文骨架里被对上的比例，exact 是 1 */
  coverage: number
}

const KEEP = /[\p{L}\p{N}]/u

export function skeleton(text: string): Skeleton {
  let s = ''
  const map: number[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    // 连字 ﬁ → fi，全角 → 半角，é → e
    const norm = ch.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    for (const c of norm) {
      if (!KEEP.test(c)) continue
      s += c
      map.push(i)
    }
  }
  return { s, map, text }
}

const K = 8
/** 一个小片段在全文出现太多次（"ofthemodel"），对定位没帮助，跳过 */
const TOO_COMMON = 12

function grams(t: Skeleton): Map<string, number[]> {
  if (t.grams) return t.grams
  const m = new Map<string, number[]>()
  for (let i = 0; i + K <= t.s.length; i++) {
    const g = t.s.slice(i, i + K)
    const list = m.get(g)
    if (list) {
      if (list.length <= TOO_COMMON) list.push(i)
    } else m.set(g, [i])
  }
  t.grams = m
  return m
}

function commonPrefix(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}
function commonSuffix(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}

interface Pair {
  /** 在查找串 Q 里的位置 */
  i: number
  /** 在目标骨架里的位置 */
  pos: number
}

/** Q 的小片段在目标里的位置；from/to 限定只用 Q 的这一段 */
function pairsOf(t: Skeleton, Q: string, from = 0, to = Q.length): Pair[] {
  const idx = grams(t)
  const out: Pair[] = []
  for (let i = from; i + K <= to; i++) {
    const list = idx.get(Q.slice(i, i + K))
    if (!list || list.length > TOO_COMMON) continue
    for (const pos of list) out.push({ i, pos })
  }
  return out
}

/** 最长的一串：i 和 pos 都往后走，两边跳过的距离差不太多（中间夹的公式两边长短不一，给些余量） */
function bestChain(pairs: Pair[]): Pair[] {
  const n = pairs.length
  if (!n) return []
  const score = new Array<number>(n).fill(0)
  const prev = new Array<number>(n).fill(-1)
  let top = 0
  for (let j = 0; j < n; j++) {
    const pj = pairs[j]!
    score[j] = K
    for (let k = j - 1; k >= 0 && k >= j - 400; k--) {
      const pk = pairs[k]!
      const di = pj.i - pk.i
      const dp = pj.pos - pk.pos
      if (di <= 0 || dp <= 0) continue
      if (Math.abs(dp - di) > di * 0.6 + 40) continue
      const s = score[k]! + Math.min(K, di, dp)
      if (s > score[j]!) {
        score[j] = s
        prev[j] = k
      }
    }
    if (score[j]! > score[top]!) top = j
  }
  const chain: Pair[] = []
  for (let j = top; j !== -1; j = prev[j]!) chain.unshift(pairs[j]!)
  return chain
}

interface Piece {
  /** Q 里 [qs, qe) 对上了目标里 [s, e) */
  qs: number
  qe: number
  s: number
  e: number
}

/** 把一串里落在 Q 的 [a, b) 之内的部分变成一段：从串里第一个和最后一个片段出发，往外一个字一个字地比，比到对不上为止 */
function pieceOf(t: Skeleton, Q: string, chain: Pair[], a: number, b: number): Piece | null {
  const inside = chain.filter((p) => p.i + K > a && p.i < b)
  if (!inside.length) return null
  const first = inside[0]!
  const last = inside[inside.length - 1]!
  let qs = Math.max(first.i, a)
  let s = first.pos + (qs - first.i)
  while (qs > a && s > 0 && Q[qs - 1] === t.s[s - 1]) {
    qs--
    s--
  }
  let qe = Math.min(last.i + K, b)
  let e = last.pos + (qe - last.i)
  while (qe < b && e < t.s.length && Q[qe] === t.s[e]) {
    qe++
    e++
  }
  return e > s ? { qs, qe, s, e } : null
}

/** 骨架只认字母数字，选区两头的标点（"(GQA)" 的右括号）会丢；原文里紧挨着同样的标点就补回来 */
function padEdges(text: string, ranges: [number, number][], exact: string): [number, number][] {
  if (!ranges.length) return ranges
  const lead = /^[^\p{L}\p{N}\s]+/u.exec(exact.trimStart())?.[0] ?? ''
  const tail = /[^\p{L}\p{N}\s]+$/u.exec(exact.trimEnd())?.[0] ?? ''
  const first = ranges[0]!
  const last = ranges[ranges.length - 1]!
  for (let i = lead.length - 1; i >= 0 && first[0] > 0 && text[first[0] - 1] === lead[i]; i--) first[0]--
  for (let i = 0; i < tail.length && last[1] < text.length && text[last[1]] === tail[i]; i++) last[1]++
  return ranges
}

/** 在 text（或它的骨架）里找 quote */
export function locate(target: string | Skeleton, quote: TextQuote): Located | null {
  const t = typeof target === 'string' ? skeleton(target) : target
  const E = skeleton(quote.exact).s
  const P = skeleton(quote.prefix).s
  const X = skeleton(quote.suffix).s
  if (!E) return null
  const out = (pieces: [number, number][], how: Located['how'], coverage: number): Located => ({
    ranges: padEdges(t.text, pieces.sort((x, y) => x[0] - y[0]).map(([s, e]) => [t.map[s]!, t.map[e - 1]! + 1]), quote.exact),
    how,
    coverage
  })

  // 1. 骨架一字不差
  let best = -1
  let bestScore = -1
  for (let at = t.s.indexOf(E); at !== -1; at = t.s.indexOf(E, at + 1)) {
    const score = commonSuffix(t.s.slice(Math.max(0, at - P.length), at), P) + commonPrefix(t.s.slice(at + E.length, at + E.length + X.length), X)
    if (score > bestScore) {
      bestScore = score
      best = at
    }
  }
  if (best >= 0) return out([[best, best + E.length]], 'exact', 1)

  // 2. 小片段串起来。连前后文一起对，前后文帮着定位，也能夹住整段对不上的公式
  const Q = P + E + X
  const a = P.length
  const b = a + E.length
  if (Q.length < K) return null
  const chain = bestChain(pairsOf(t, Q))
  if (!chain.length) return null
  // 串里一下子跳很远的地方断开：前后两截在目标里不挨着（中间跳过了一段图注），各算一段
  const runs: Pair[][] = [[chain[0]!]]
  for (let j = 1; j < chain.length; j++) {
    const p = chain[j - 1]!
    const c = chain[j]!
    const shift = c.pos - p.pos - (c.i - p.i)
    if (Math.abs(shift) > 12 + (c.i - p.i) * 0.3) runs.push([c])
    else runs[runs.length - 1]!.push(c)
  }
  const pieces: Piece[] = runs.map((r) => pieceOf(t, Q, r, a, b)).filter((p): p is Piece => !!p)

  if (!pieces.length) {
    // 正文一点没对上（多半整段是公式）：前后文两头都在串里，才信夹出来的位置
    const pre = chain.filter((p) => p.i + K <= a).pop()
    const suf = chain.find((p) => p.i >= b)
    if (!pre || !suf) return null
    const s = pre.pos + (a - pre.i)
    const e = suf.pos - (suf.i - b)
    if (e <= s || e - s > E.length * 3 + 40) return null
    return out([[s, e]], 'context', 0)
  }

  // 正文开头或结尾有没对上的（公式），而紧挨着的前后文对上了：按前后文把边界推过去，把公式也包进来
  const head = pieces.reduce((m, p) => (p.qs < m.qs ? p : m))
  const pre = chain.filter((p) => p.i + K <= a).pop()
  if (head.qs > a && pre && pre.pos + K <= head.s) {
    const s = pre.pos + (a - pre.i)
    if (s < head.s && head.s - s <= (head.qs - a) * 3 + 20) {
      head.s = Math.max(s, pre.pos + K)
      head.qs = a
    }
  }
  const tail = pieces.reduce((m, p) => (p.qe > m.qe ? p : m))
  const suf = chain.find((p) => p.i >= b)
  if (tail.qe < b && suf && suf.pos >= tail.e) {
    const e = suf.pos - (suf.i - b)
    if (e > tail.e && e - tail.e <= (b - tail.qe) * 3 + 20) {
      tail.e = Math.min(e, suf.pos)
      tail.qe = b
    }
  }

  // 3. 正文里还有一大块没对上：PDF 上连着、网页里不连着（跨过了图、表、脚注、分栏），在别处单独找
  for (let round = 0; round < 3; round++) {
    const gaps: [number, number][] = []
    let at = a
    for (const p of [...pieces].sort((x, y) => x.qs - y.qs)) {
      if (p.qs - at >= 24) gaps.push([at, p.qs])
      at = Math.max(at, p.qe)
    }
    if (b - at >= 24) gaps.push([at, b])
    if (!gaps.length) break
    let found = false
    for (const [ga, gb] of gaps) {
      const sub = Q.slice(ga, gb)
      const hit = t.s.indexOf(sub)
      // 一字不差而且只有一处才直接用，否则串一下
      if (hit >= 0 && t.s.indexOf(sub, hit + 1) < 0) {
        pieces.push({ qs: ga, qe: gb, s: hit, e: hit + sub.length })
        found = true
        continue
      }
      const c = bestChain(pairsOf(t, Q, ga, gb))
      const p = c.length >= 2 ? pieceOf(t, Q, c, ga, gb) : null
      if (p && p.qe - p.qs >= 16) {
        pieces.push(p)
        found = true
      }
    }
    if (!found) break
  }

  let covered = 0
  for (const p of pieces) covered += p.qe - p.qs
  const coverage = Math.min(1, covered / E.length)
  if (coverage < 0.4) return null
  // 两边先后一样、中间隔得也差不多的相邻几段（中间夹着公式、图注）合成一段
  const sorted = [...pieces].sort((x, y) => x.s - y.s)
  const merged: Piece[] = []
  for (const p of sorted) {
    const last = merged[merged.length - 1]
    if (last && p.s >= last.e && p.qs >= last.qe && p.s - last.e <= (p.qs - last.qe) * 3 + 20) {
      last.e = p.e
      last.qe = p.qe
    } else merged.push({ ...p })
  }
  return out(merged.map((p) => [p.s, p.e]), 'fuzzy', coverage)
}
