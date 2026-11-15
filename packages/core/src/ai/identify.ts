// 让 AI 看 PDF 的前几页，读出书名、作者、出版社这些。只在用户点了"用 AI 识别"以后才用。
// 有文字层的发文字（便宜，不能看图的模型也行）；扫描版发页面图片（要能看图的模型）。
import { extractDoi, extractIsbn } from '../ids'
import { splitName } from '../metadata'
import type { PaperMeta } from '../model'

export interface PageImage {
  mime: 'image/jpeg' | 'image/png'
  /** 不带 data: 前缀的 base64 */
  base64: string
}

/** 发给 AI 的前几页：文字和图片给一样就行 */
export interface IdentifyInput {
  text?: string
  images?: PageImage[]
}

/** 文字最多发这么长：封面、扉页、版权页加起来用不了这么多 */
export const IDENTIFY_TEXT_MAX = 6000
export const IDENTIFY_IMAGES_MAX = 4

export const IDENTIFY_SYSTEM = [
  '你会收到一份 PDF 文献最前面几页的内容（文字，或者页面图片），通常是封面、扉页和版权页。',
  '读出这份文献的：标题（书名，有副标题的话用冒号接上）、作者、出版社（论文则是期刊或会议名）、出版年份、ISBN、DOI。',
  '只写页面上看得到的，看不出来的填 null，不要猜，也不要翻译标题和人名。译著的作者写原作者，不写译者。',
  '只输出一个 JSON 对象，不要别的文字：{"title": string|null, "authors": string[], "publisher": string|null, "year": number|null, "isbn": string|null, "doi": string|null}'
].join('\n')

export function identifyPrompt(input: IdentifyInput): string {
  const text = input.text?.trim().slice(0, IDENTIFY_TEXT_MAX)
  return text ? `下面是这份 PDF 前几页的文字：\n\n${text}` : '上面是这份 PDF 前几页的图片。'
}

/** 从模型的回答里取出识别结果；回答不是要的格式、或者连标题都没读出来时返回 null */
export function parseIdentified(answer: string): PaperMeta | null {
  const from = answer.indexOf('{')
  const to = answer.lastIndexOf('}')
  if (from < 0 || to <= from) return null
  let j: Record<string, unknown>
  try {
    j = JSON.parse(answer.slice(from, to + 1)) as Record<string, unknown>
  } catch {
    return null
  }
  const str = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')
  const title = str(j['title']).slice(0, 300)
  if (!title) return null
  const meta: PaperMeta = { title, authors: [], identifiers: {}, source: 'ai' }
  if (Array.isArray(j['authors'])) meta.authors = j['authors'].map(str).filter(Boolean).slice(0, 50).map(splitName)
  const venue = str(j['publisher']).slice(0, 200)
  if (venue) meta.venue = venue
  const year = Number(j['year'])
  if (Number.isInteger(year) && year >= 1400 && year <= 2100) meta.year = year
  const isbn = extractIsbn(str(j['isbn']), true) ?? extractIsbn(`ISBN ${str(j['isbn'])}`)
  if (isbn) meta.identifiers.isbn = isbn
  const doi = extractDoi(str(j['doi']))
  if (doi) meta.identifiers.doi = doi
  return meta
}
