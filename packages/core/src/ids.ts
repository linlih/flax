// 从 PDF 文字、元数据或文件名里找出 DOI 和 arXiv 编号。

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
