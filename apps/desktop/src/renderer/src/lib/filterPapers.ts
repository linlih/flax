// 文献库的筛选：标题、作者、期刊、年份、标签，多个词都要命中。
// 每篇的检索文字算一次就缓存（论文对象一改就是新对象，缓存自然失效），1 万篇里每敲一个字也很快。
import { normalizeTitle, type Paper } from '@flax/core'
import { authorLine } from './format'

const hayCache = new WeakMap<Paper, string>()

function hay(p: Paper): string {
  let h = hayCache.get(p)
  if (h === undefined) {
    h = normalizeTitle([p.title, authorLine(p, 99), p.venue ?? '', p.year ?? '', p.tags.join(' ')].join(' '))
    hayCache.set(p, h)
  }
  return h
}

export function filterPapers(papers: Paper[], query: string, tag = ''): Paper[] {
  const words = normalizeTitle(query).split(' ').filter(Boolean)
  return papers.filter((p) => (!tag || p.tags.includes(tag)) && (!words.length || words.every((w) => hay(p).includes(w))))
}
