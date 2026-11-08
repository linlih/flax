// 按行的三方合并：两边从同一个基础版本出发各改了一些地方，改的不是同一处就自动合并。
// 改了同一处（而且改得不一样）就算冲突，返回 null，由调用方留一份冲突副本。

/** base → x 的最长公共子序列，返回 base 的行号 → x 的行号 */
function match(base: string[], x: string[]): Map<number, number> {
  // 先去掉共同的开头和结尾，大部分修改只动中间一小段，剩下的再做动态规划
  let lo = 0
  while (lo < base.length && lo < x.length && base[lo] === x[lo]) lo++
  let hb = base.length
  let hx = x.length
  while (hb > lo && hx > lo && base[hb - 1] === x[hx - 1]) {
    hb--
    hx--
  }
  const out = new Map<number, number>()
  for (let i = 0; i < lo; i++) out.set(i, i)
  const n = hb - lo
  const m = hx - lo
  if (n && m) {
    const w = m + 1
    const t = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        t[i * w + j] = base[lo + i] === x[lo + j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!)
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (base[lo + i] === x[lo + j]) {
        out.set(lo + i, lo + j)
        i++
        j++
      } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) i++
      else j++
    }
  }
  for (let k = 0; hb + k < base.length; k++) out.set(hb + k, hx + k)
  return out
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i])

/** 合并成功返回合并后的文字，冲突返回 null */
export function merge3(base: string, a: string, b: string): string | null {
  if (a === b) return a
  if (a === base) return b
  if (b === base) return a
  const O = base.split('\n')
  const A = a.split('\n')
  const B = b.split('\n')
  const ma = match(O, A)
  const mb = match(O, B)
  const out: string[] = []
  let i = 0
  let j = 0
  let k = 0
  const chunk = (oi: number, aj: number, bk: number): boolean => {
    const o = O.slice(i, oi)
    const x = A.slice(j, aj)
    const y = B.slice(k, bk)
    if (same(x, o)) out.push(...y)
    else if (same(y, o) || same(x, y)) out.push(...x)
    else return false
    return true
  }
  for (;;) {
    let ib = i
    while (ib < O.length && !(ma.has(ib) && mb.has(ib))) ib++
    if (ib >= O.length) {
      if (!chunk(O.length, A.length, B.length)) return null
      break
    }
    const ja = ma.get(ib)!
    const kb = mb.get(ib)!
    if (ib === i && ja === j && kb === k) {
      out.push(O[i]!)
      i++
      j++
      k++
      continue
    }
    if (!chunk(ib, ja, kb)) return null
    i = ib
    j = ja
    k = kb
  }
  return out.join('\n')
}
