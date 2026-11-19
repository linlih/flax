// 从网页上读论文信息（docs/12-浏览器插件.md 第 5.1 节）。
// extractPage 用 chrome.scripting.executeScript 注入到页面里跑，所以必须自给自足：不能用外面的变量和 import。
// 这里只管读，编号格式对不对由桌面端按粘贴文字的规则再认一遍。

export interface PageInfo {
  url: string
  ids: { doi?: string; arxiv?: string }
  meta: { title?: string; authors?: string[]; year?: number; venue?: string; abstract?: string }
  /** 网页上的 PDF 链接（第 2 阶段在浏览器里下载） */
  pdfUrl?: string
  /** 当前标签页直接就是 PDF */
  isPdf: boolean
}

export function extractPage(): PageInfo {
  const all = (name: string): string[] =>
    Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name],meta[property]'))
      .filter((m) => (m.getAttribute('name') ?? m.getAttribute('property') ?? '').toLowerCase() === name)
      .map((m) => (m.content ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
  const first = (...names: string[]): string | undefined => {
    for (const n of names) {
      const v = all(n)[0]
      if (v) return v
    }
    return undefined
  }
  const doiIn = (s: string | undefined) => (s ? /\b(10\.\d{4,9}\/[^\s"'<>]+)/.exec(s)?.[1]?.replace(/[.,;)\]]+$/, '') : undefined)

  const info: PageInfo = { url: location.href, ids: {}, meta: {}, isPdf: document.contentType === 'application/pdf' }

  // 1. Google Scholar 要求的 citation_*，大部分出版商、arXiv、OpenReview、ACL Anthology 都有
  const doi = doiIn(first('citation_doi', 'prism.doi', 'bepress_citation_doi')) ?? all('dc.identifier').map(doiIn).find(Boolean)
  if (doi) info.ids.doi = doi
  const arxiv = first('citation_arxiv_id')
  if (arxiv) info.ids.arxiv = arxiv
  const title = first('citation_title', 'dc.title', 'bepress_citation_title')
  if (title) info.meta.title = title
  let authors = all('citation_author')
  if (!authors.length) authors = all('dc.creator')
  if (authors.length) info.meta.authors = authors
  const date = first('citation_publication_date', 'citation_date', 'citation_online_date', 'citation_year', 'dc.date', 'prism.publicationdate')
  const year = date ? /\b(1[5-9]\d\d|2\d\d\d)\b/.exec(date)?.[1] : undefined
  if (year) info.meta.year = Number(year)
  const venue = first('citation_journal_title', 'citation_conference_title', 'citation_inbook_title', 'citation_publisher', 'prism.publicationname')
  if (venue) info.meta.venue = venue
  const abstract = first('citation_abstract', 'dc.description')
  if (abstract) info.meta.abstract = abstract
  const pdf = first('citation_pdf_url')
  if (pdf) {
    try { info.pdfUrl = new URL(pdf, location.href).href } catch { /* 不是网址 */ }
  }

  // 2. JSON-LD 里的 ScholarlyArticle（有些出版商只有这个）
  if (!info.meta.title || !info.ids.doi) {
    for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
      let data: unknown
      try { data = JSON.parse(s.textContent ?? '') } catch { continue }
      const items = (Array.isArray(data) ? data : [data]).flatMap((d) => (d && typeof d === 'object' && Array.isArray((d as Record<string, unknown>)['@graph']) ? ((d as Record<string, unknown>)['@graph'] as unknown[]) : [d]))
      for (const it of items) {
        if (!it || typeof it !== 'object') continue
        const o = it as Record<string, unknown>
        const type = ([] as unknown[]).concat(o['@type'] ?? [])
        if (!type.some((t) => typeof t === 'string' && /ScholarlyArticle|Article$|Report|Thesis/.test(t) && t !== 'NewsArticle' && t !== 'BlogPosting')) continue
        if (!info.meta.title && typeof o['headline'] === 'string') info.meta.title = o['headline']
        if (!info.meta.title && typeof o['name'] === 'string') info.meta.title = o['name']
        if (!info.meta.authors?.length) {
          const names = ([] as unknown[]).concat(o['author'] ?? []).map((a) => (typeof a === 'string' ? a : a && typeof a === 'object' && typeof (a as Record<string, unknown>)['name'] === 'string' ? ((a as Record<string, unknown>)['name'] as string) : '')).filter(Boolean)
          if (names.length) info.meta.authors = names
        }
        if (!info.ids.doi) {
          const d = ([] as unknown[]).concat(o['identifier'] ?? [], o['sameAs'] ?? [], o['@id'] ?? []).map((x) => doiIn(typeof x === 'string' ? x : x && typeof x === 'object' ? String((x as Record<string, unknown>)['value'] ?? '') : '')).find(Boolean)
          if (d) info.ids.doi = d
        }
        if (!info.meta.year && typeof o['datePublished'] === 'string') {
          const y = /\b(1[5-9]\d\d|2\d\d\d)\b/.exec(o['datePublished'])?.[1]
          if (y) info.meta.year = Number(y)
        }
      }
    }
  }
  return info
}

/** 打不进页面时（PDF 阅读器、浏览器自己的页面）只看网址 */
export function pageFromUrl(url: string): PageInfo {
  return { url, ids: {}, meta: {}, isPdf: /\.pdf(?:$|[?#])/i.test(url) }
}

const PAPER_URLS = [
  /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|html)\/[\w./-]+/i,
  /^https?:\/\/(?:dx\.)?doi\.org\/10\.\d{4,9}\//i,
  /^https?:\/\/openreview\.net\/(?:forum|pdf)\?id=/i,
  /^https?:\/\/aclanthology\.org\/[\w.-]+\/?$/i,
  /\/10\.\d{4,9}\/[^\s/]+/
]

/** 这个页面上有没有能存的论文：有编号，或者有 citation_title，或者网址是论文页 */
export function looksLikePaper(p: PageInfo): boolean {
  return !!(p.ids.doi || p.ids.arxiv || p.meta.title || PAPER_URLS.some((re) => re.test(p.url)))
}
