// 数据模型，对应 docs/04-数据模型.md。只放类型，不依赖任何平台 API。

export type UUID = string

/** 每条记录都带这三个字段，以后接 CRDT 同步时只改仓储层。 */
export interface Versioned {
  id: UUID
  updatedAt: string // ISO 时间
  deviceId: string
}

export interface Author {
  given?: string
  family: string
}

export type ReadingStatus = 'inbox' | 'to_read' | 'reading' | 'done'

export interface Identifiers {
  doi?: string
  arxiv?: string
  pmid?: string
  isbn?: string
  url?: string
}

export interface FileRef {
  /** SHA-256，同时是存储里的文件名 */
  hash: string
  size: number
  mime: 'application/pdf'
  pageCount?: number
  role: 'main' | 'preprint' | 'supplement'
  sourceVersion?: string
  /** 导入时的原始文件名，导出和"在访达中显示"时参考 */
  originalName?: string
  addedAt: string
}

export type MetadataSource = 'arxiv' | 'crossref' | 'openalex' | 'pdf' | 'filename' | 'user'

/** 识别不完整的原因，界面据此给出不同的提示 */
export type MatchIssue = 'no_id' | 'lookup_failed' | 'not_found'

export interface Paper extends Versioned {
  title: string
  authors: Author[]
  year?: number
  venue?: string
  identifiers: Identifiers
  abstract?: string
  files: FileRef[]
  folderIds: UUID[]
  tags: string[]
  readingStatus: ReadingStatus
  rating?: number
  addedAt: string
  lastOpenedAt?: string
  /** 上次读到的位置，下次打开从这里接着读 */
  readingPosition?: ReadingPosition
  metadataSource: MetadataSource
  /** 识别不完整时为 true，界面显示"需要匹配" */
  needsMatch: boolean
  matchIssue?: MatchIssue
}

export interface Folder extends Versioned {
  name: string
  parentId?: UUID
  order: number
}

export interface ReadingPosition {
  fileHash: string
  /** 从 1 开始，和 PDF.js 一致 */
  page: number
  /** 页面坐标（pt，原点左下），视口左上角落在这里 */
  left: number
  top: number
  /** 'page-width' 等预设，或数字缩放比例 */
  scale: string
  updatedAt: string
}

/** 高亮的颜色。存语义名，具体色值由界面 token 决定，深色模式下换成深色版本 */
export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple'

/** PDF 页面坐标（pt，原点左下）：[x0, y0, x1, y1] */
export type PdfRect = [number, number, number, number]

export interface TextQuote {
  exact: string
  prefix: string
  suffix: string
}

/** 批注，对应 docs/04-数据模型.md。M2 只做文本类：高亮、下划线；附言写在 comment 里 */
export interface Annotation extends Versioned {
  paperId: UUID
  /** 绑定到具体文件，预印本和正式版的批注不会混 */
  fileHash: string
  type: 'highlight' | 'underline'
  origin: 'select' | 'gesture' | 'ai'
  color: HighlightColor
  /** 从 0 开始 */
  page: number
  /** 双保险：优先用 rects 显示，对不上时用 quote 在页面文字里重新找 */
  target: { rects: PdfRect[]; quote: TextQuote }
  comment?: string
  createdAt: string
}

/** 从外部来源或 PDF 里识别出的元数据，还没写进文献库 */
export interface PaperMeta {
  title: string
  authors: Author[]
  year?: number
  venue?: string
  abstract?: string
  identifiers: Identifiers
  source: MetadataSource
}

/** 术语表里的一条：读论文时从翻译卡片加入，翻译时按这里的译法保持一致 */
export interface Term {
  id: UUID
  /** 原文写法，例如 "attention head" */
  term: string
  /** 译法，例如 "注意力头" */
  translation: string
  note?: string
  /** 第一次在哪篇论文里加入 */
  paperId?: UUID
  createdAt: string
  updatedAt: string
  deviceId: string
}
