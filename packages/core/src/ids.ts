// 从 PDF 文字、元数据或文件名里找出 DOI、arXiv 编号和书的 ISBN。

/** 新式 arXiv 编号：YYMM.NNNNN，可带版本号 vN */
const ARXIV_NEW = /(?:arxiv[:\s/]*|abs\/|pdf\/)?\b(\d{4}\.\d{4,5})(v\d+)?\b/i
/** 旧式 arXiv 编号：archive/YYMMNNN，例如 hep-th/9901001 */
const ARXIV_OLD = /\b([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?\b/
/** DOI：10.前缀/后缀。结尾的标点通常是句子的一部分，要去掉 */
const DOI = /\b(10\.\d{4,9}\/[^\s"<>]+)/i

export interface ArxivId {
  id: string
  version?: string
}

export function extractArxivId(text: string): ArxivId | null {
  const m = ARXIV_NEW.exec(text)
  if (m && m[1] && isPlausibleNewArxiv(m[1])) {
    return m[2] ? { id: m[1], version: m[2] } : { id: m[1] }
  }
  const o = /arxiv/i.test(text) ? ARXIV_OLD.exec(text) : null
  if (o && o[1]) return o[2] ? { id: o[1], version: o[2] } : { id: o[1] }
  return null
}

/** YYMM 里的月份要在 01–12，年份从 07 开始（新式编号 2007 年 4 月启用） */
function isPlausibleNewArxiv(id: string): boolean {
  const yy = Number(id.slice(0, 2))
  const mm = Number(id.slice(2, 4))
  const seq = id.split('.')[1] ?? ''
  if (mm < 1 || mm > 12 || yy < 7) return false
  // 2015 年起序号是 5 位，之前是 4 位
  return yy >= 15 ? seq.length === 5 : seq.length === 4
}

export function extractDoi(text: string): string | null {
  const m = DOI.exec(text)
  if (!m || !m[1]) return null
  let doi = m[1].replace(/[.,;:)\]}>'"]+$/, '')
  // 括号不配对时去掉多出来的右括号，例如 "(doi:10.1/abc)"
  while (count(doi, ')') > count(doi, '(') && doi.endsWith(')')) doi = doi.slice(0, -1)
  return doi.toLowerCase()
}

function count(s: string, ch: string): number {
  return s.split(ch).length - 1
}

/** "ISBN" 后面跟着的一串数字；可以带连字符、空格，10 位的最后一位可以是 X */
const ISBN = /ISBN(?:[-\s]?1[03])?[\s:：]*([0-9][0-9\-\s‐–]{8,18}[0-9Xx]?)/gi

/**
 * 找书的 ISBN，校验位对得上才算，统一成 13 位数字。
 * 版权页常常印好几个（精装、平装、电子版），取第一个。bare 为 true 时整段文字就是一个 ISBN 也认（用户粘贴的）。
 */
export function extractIsbn(text: string, bare = false): string | null {
  for (const m of text.matchAll(ISBN)) {
    const v = validIsbn((m[1] ?? '').replace(/[^0-9Xx]/g, ''))
    if (v) return v
  }
  if (bare && /^[\d\-\s‐–]{10,20}[\dXx]?$/.test(text.trim())) return validIsbn(text.replace(/[^0-9Xx]/g, ''))
  return null
}

/** 一串数字开头的 13 位或 10 位是不是合法的 ISBN；是就返回 13 位的写法 */
function validIsbn(d: string): string | null {
  const a = d.slice(0, 13)
  if (/^97[89]\d{10}$/.test(a)) {
    const sum = [...a].reduce((n, c, i) => n + Number(c) * (i % 2 ? 3 : 1), 0)
    if (sum % 10 === 0) return a
  }
  const b = d.slice(0, 10).toUpperCase()
  if (/^\d{9}[\dX]$/.test(b)) {
    const sum = [...b].reduce((n, c, i) => n + (c === 'X' ? 10 : Number(c)) * (10 - i), 0)
    if (sum % 11 === 0) {
      const body = '978' + b.slice(0, 9)
      const check = (10 - ([...body].reduce((n, c, i) => n + Number(c) * (i % 2 ? 3 : 1), 0) % 10)) % 10
      return body + check
    }
  }
  return null
}
