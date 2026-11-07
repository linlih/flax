// 标题比较和文件名：查重、按标题匹配、导出时都用到。
import type { Author } from './model'

/** 去掉大小写、标点、重音和多余空格，用来比较两个标题是不是同一篇 */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** 两个标题的相似度，0 到 1。用字符二元组的 Dice 系数，对少量拼写差异不敏感 */
export function titleSimilarity(a: string, b: string): number {
  const x = bigrams(normalizeTitle(a))
  const y = bigrams(normalizeTitle(b))
  if (!x.size || !y.size) return 0
  let both = 0
  for (const [g, n] of x) both += Math.min(n, y.get(g) ?? 0)
  return (2 * both) / (sum(x) + sum(y))
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>()
  const t = s.replace(/ /g, '')
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2)
    m.set(g, (m.get(g) ?? 0) + 1)
  }
  return m
}

function sum(m: Map<string, number>): number {
  let n = 0
  for (const v of m.values()) n += v
  return n
}

/** 作者名的简短写法：一位写姓，两位写"A 和 B"，更多写"A 等" */
export function shortAuthors(authors: Author[]): string {
  const [a, b] = authors
  if (!a) return ''
  if (!b) return a.family
  if (authors.length === 2) return `${a.family} 和 ${b.family}`
  return `${a.family} 等`
}

/** 按"第一作者 年份 - 标题"命名，例如 "Vaswani 2017 - Attention Is All You Need.pdf" */
export function suggestFileName(p: { title: string; authors: Author[]; year?: number }): string {
  const who = [p.authors[0]?.family, p.year].filter(Boolean).join(' ')
  // 去掉文件系统不允许或容易出问题的字符
  const title = p.title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim()
  const short = title.length > 80 ? title.slice(0, 80).replace(/\s+\S*$/, '') : title
  const name = [who, short].filter(Boolean).join(' - ')
  return (name || '未命名论文') + '.pdf'
}
