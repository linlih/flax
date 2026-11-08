// 笔记就是磁盘上的 .md 文件：文件名就是标题（和 Obsidian 一样，[[标题]] 按文件名找），
// 开头一段 YAML 头信息记 id、关联的论文和创建时间。这里只放纯函数，读写文件在桌面端。

export interface NoteHead {
  id: string
  /** 挂在哪篇论文下；独立的主题笔记没有 */
  paperId?: string
  createdAt: string
}

export interface ParsedNote {
  head: Partial<NoteHead>
  /** 头信息后面的正文 */
  body: string
  /** 头信息里不认识的行，原样保留，写回时不丢 */
  extra: string[]
}

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** 读出头信息和正文。只认简单的 `key: value`，别的行原样保留 */
export function parseNote(text: string): ParsedNote {
  const m = FRONT.exec(text)
  if (!m) return { head: {}, body: text, extra: [] }
  const head: Partial<NoteHead> = {}
  const extra: string[] = []
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line)
    const value = kv?.[2]?.replace(/^["']|["']$/g, '').trim()
    if (kv && value && kv[1] === 'id') head.id = value
    else if (kv && value && kv[1] === 'paper') head.paperId = value
    else if (kv && value && kv[1] === 'created') head.createdAt = value
    else if (line.trim()) extra.push(line)
  }
  return { head, body: text.slice(m[0].length), extra }
}

export function serializeNote(head: NoteHead, body: string, extra: string[] = []): string {
  const lines = [`id: ${head.id}`, head.paperId ? `paper: ${head.paperId}` : '', `created: ${head.createdAt}`, ...extra].filter(Boolean)
  return `---\n${lines.join('\n')}\n---\n${body}`
}

/** 能当文件名的标题：去掉文件系统和 [[链接]] 里不能用的字符 */
export function safeNoteTitle(title: string): string {
  const t = title
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim()
  return t || '未命名笔记'
}

/** 正文里的 [[链接]]（去掉 |别名 和 #小标题），去重 */
export function extractLinks(body: string): string[] {
  const out = new Set<string>()
  for (const m of body.matchAll(/(?<!!)\[\[([^\]\n]+?)\]\]/g)) {
    const target = m[1]!.split('|')[0]!.split('#')[0]!.trim()
    if (target) out.add(target)
  }
  return [...out]
}

/** 正文里引用的批注 id：链接写成 flax://annotation/<id>（改名前写的 paper:// 也认） */
export function extractAnnotationRefs(body: string): string[] {
  return [...new Set([...body.matchAll(/(?:flax|paper):\/\/annotation\/([0-9a-f-]{8,})/gi)].map((m) => m[1]!))]
}

/** 列表里显示的一句摘要：跳过标题、引用和空行 */
export function noteExcerpt(body: string, max = 80): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('>') || line.startsWith('---')) continue
    const plain = line.replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (_, a, __, b) => b ?? a).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/~~/g, '').replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '').replace(/[*_`]/g, '')
    if (plain) return plain.length > max ? plain.slice(0, max - 1) + '…' : plain
  }
  return ''
}

/** 批注变成笔记里的引用块，末尾带一个能跳回原文的链接 */
export function quoteBlock(quote: string, page: number, annotationId: string, comment?: string): string {
  const lines = quote.replace(/\s+/g, ' ').trim()
  const parts = [`> ${lines}`, `> [第 ${page} 页](flax://annotation/${annotationId})`]
  if (comment?.trim()) parts.push('', comment.trim())
  return parts.join('\n')
}
