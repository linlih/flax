// 主进程和渲染进程之间的接口。渲染进程只能通过 window.api 调这些方法。
import type { Annotation, AnnotationPatch, Folder, NewAnnotation, Paper, PaperMeta, PaperPatch, ReadingPosition, Term } from '@paper/core'

export interface LibrarySnapshot {
  papers: Paper[]
  folders: Folder[]
  tags: { tag: string; count: number }[]
  annotationCounts: Record<string, number>
  /** 术语表 */
  terms: Term[]
  /** 正在识别元数据的论文 */
  importing: string[]
  /** 正在下载 PDF 的论文 */
  downloading: string[]
}

export interface Candidate extends PaperMeta {
  similarity: number
}

/** 导入时需要告诉用户的事 */
export type ImportNotice =
  | { kind: 'same_file'; paperId: string; title: string }
  | { kind: 'same_paper'; token: string; fileName: string; existing: { id: string; title: string; venue?: string; year?: number; files: number } }
  | { kind: 'not_pdf'; fileName: string }
  | { kind: 'failed'; fileName: string; message: string }
  /** 拖进来的 PDF 直接配给了库里还没有文件的那条 */
  | { kind: 'attached'; paperId: string; title: string }
  | { kind: 'download_failed'; paperId: string; title: string; message: string }
  /** 从 BibTeX（Zotero 等）导入完：新加几篇、库里已有几篇、找不到的 PDF 几个 */
  | { kind: 'bib_done'; added: number; existing: number; missingFiles: number }

export interface LibraryApi {
  snapshot(): Promise<LibrarySnapshot>
  importPaths(paths: string[]): Promise<void>
  pickAndImport(): Promise<void>
  /** 选一个 .bib 文件导入（Zotero 导出的带 PDF） */
  importBibTeX(): Promise<void>
  /** 导出 BibTeX 或 RIS；ids 为空导出全部。用户取消时返回 false */
  exportCitations(ids: string[], format: 'bibtex' | 'ris'): Promise<boolean>
  /** 粘贴的 DOI、arXiv 编号或链接；没有识别出编号时返回 false */
  addFromText(text: string): Promise<boolean>
  update(id: string, patch: PaperPatch): Promise<void>
  remove(id: string): Promise<void>
  restore(id: string): Promise<void>
  retryLookup(id: string): Promise<void>
  /** 从 arXiv 下载 PDF；没有 arXiv 编号时返回 false */
  downloadPdf(id: string): Promise<boolean>
  searchCandidates(id: string): Promise<Candidate[]>
  applyCandidate(id: string, meta: PaperMeta): Promise<void>
  resolveDuplicate(token: string, action: 'add_version' | 'skip'): Promise<void>
  /** 用系统默认程序打开 */
  openFile(id: string): Promise<void>
  markOpened(id: string): Promise<void>
  savePosition(id: string, pos: ReadingPosition, final?: boolean): Promise<void>
  /** 按 id 取一条批注；删掉了就是 null */
  annotation(id: string): Promise<Annotation | null>
  annotations(paperId: string): Promise<Annotation[]>
  addAnnotation(a: NewAnnotation): Promise<Annotation>
  updateAnnotation(id: string, patch: AnnotationPatch): Promise<Annotation>
  removeAnnotation(id: string): Promise<void>
  restoreAnnotation(id: string): Promise<void>
  /** 这篇的 PDF 在资料文件夹里还在不在 */
  fileMissing(id: string): Promise<boolean>
  /** PDF 找不到时让用户重新选一个；other_paper：选的文件属于库里另一篇 */
  relink(id: string): Promise<'ok' | 'cancel' | 'not_pdf' | 'other_paper'>
  showInFinder(id: string): Promise<void>
  createFolder(name: string): Promise<Folder>
  renameFolder(id: string, name: string): Promise<void>
  removeFolder(id: string): Promise<void>
  renameTag(from: string, to: string): Promise<void>
  /** 术语表：同一个词已经有了就改译法 */
  addTerm(t: { term: string; translation: string; note?: string; paperId?: string }): Promise<Term>
  updateTerm(id: string, patch: { term?: string; translation?: string; note?: string }): Promise<Term>
  removeTerm(id: string): Promise<void>
  restoreTerm(id: string): Promise<void>
  onChanged(cb: () => void): () => void
  onNotice(cb: (n: ImportNotice) => void): () => void
}

export type Appearance = 'system' | 'light' | 'dark'

/** 笔记列表里的一条；正文要单独读 */
export interface NoteSummary {
  id: string
  /** 就是文件名（不带 .md） */
  title: string
  paperId?: string
  createdAt: string
  updatedAt: string
  excerpt: string
  /** 正文里的 [[链接]] */
  links: string[]
  /** 正文里引用的批注 id */
  annotationRefs: string[]
}

export interface NotesApi {
  list(): Promise<NoteSummary[]>
  read(id: string): Promise<{ note: NoteSummary; body: string } | null>
  /** 不给标题时：论文笔记用论文标题，独立笔记叫"未命名笔记" */
  create(opts: { title?: string; paperId?: string; body?: string }): Promise<NoteSummary>
  save(id: string, body: string): Promise<NoteSummary>
  rename(id: string, title: string): Promise<NoteSummary>
  remove(id: string): Promise<void>
  showInFinder(id: string): Promise<void>
  /** 笔记有变化（包括用别的编辑器改了文件） */
  onChanged(cb: () => void): () => void
}

export interface PaperApi {
  platform: string
  /** 拖进来的 File 对应的本地路径 */
  pathForFile(file: File): string
  /** 整个应用的外观；网页里的 prefers-color-scheme 会跟着变 */
  appearance(): Promise<Appearance>
  setAppearance(value: Appearance): Promise<void>
  /** 版本号和资料文件夹位置 */
  info(): Promise<{ version: string; dataDir: string }>
  showData(): Promise<void>
  /** 选一个文件夹，把整个资料库备份进去；返回备份的位置，取消时是 null */
  backup(): Promise<string | null>
  /** 选一个备份恢复：现在的资料挪到一旁，然后应用重启；取消时返回 false */
  restore(): Promise<boolean>
  library: LibraryApi
  notes: NotesApi
  ai: AiApi
  /** 自动更新 */
  update: {
    state(): Promise<UpdateState>
    /** 手动检查：结果会通过 onState 告诉界面 */
    check(): Promise<UpdateState>
    /** 新版本已经下好：重启并安装 */
    install(): Promise<void>
    onState(cb: (s: UpdateState) => void): () => void
  }
  /** 菜单栏里点了某一项 */
  onMenu(cb: (cmd: MenuCommand) => void): () => void
}

/** 更新状态。manual：这次检查是用户点的，结果要告诉他 */
export type UpdateState = (
  | { kind: 'idle' | 'checking' | 'latest' | 'dev' }
  | { kind: 'downloading'; version: string; percent?: number }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string }
) & { manual?: boolean }

export type MenuCommand = 'settings' | 'importPdf' | 'importBib' | 'newNote' | 'exportBib' | 'exportRis' | 'shortcuts'

// —— AI ——
export type AiProviderKind = 'anthropic' | 'openai'

/** 发请求时用的连接信息（主进程内部用） */
export interface AiConfig {
  /** 哪一家服务，见 shared/aiVendors.ts */
  vendor: string
  /** 接口类型，由 vendor 决定 */
  provider: AiProviderKind
  model: string
  /** 留空用这家的默认地址 */
  baseUrl: string
}

/** 设置里加的一个 AI 服务（不含 Key；Key 只在主进程，用系统钥匙串加密存盘） */
export interface AiService {
  /** 服务本身的 id：官方服务就是 vendor，自定义地址是 custom-xxxx */
  id: string
  vendor: string
  /** 自定义地址可以起个名字 */
  name: string
  /** 留空用这家的默认地址；自定义地址必须填 */
  baseUrl: string
  hasKey: boolean
}

export interface AiModel {
  id: string
  name?: string
}

/** 对话里选的模型 */
export interface AiSelection {
  service: string
  model: string
}

export interface AiStatus {
  services: AiService[]
  /** 当前选的模型；还没选是 null */
  selection: AiSelection | null
  /** 有选好的模型、它的服务也连得上（有 Key 或不要 Key） */
  ready: boolean
  /** 系统钥匙串能不能用；不能用时不保存 Key */
  canEncrypt: boolean
  usage: AiUsageTotal
}

export interface AiUsageTotal {
  inputTokens: number
  outputTokens: number
  /** 只有知道价格的模型才算钱（美元） */
  costUsd: number
  calls: number
}

/** 一次调用的用量 */
export interface AiUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number | null
}

export interface AiChatTurn {
  role: 'user' | 'assistant'
  /** 显示用的文字；回答里的原文定位写成 ⟦页码|原文⟧ */
  text: string
  /** 提问时附带的选中文字 */
  quote?: string
  /** 回答用的模型 */
  model?: string
  usage?: AiUsage
  error?: string
  at: string
}

/** 流式结果：同一个 requestId 的 delta 依次拼起来，最后来一个 done 或 error */
export type AiEvent =
  | { requestId: string; type: 'delta'; text: string }
  | { requestId: string; type: 'done'; text: string; usage: AiUsage }
  | { requestId: string; type: 'error'; message: string; code?: AiErrorCode }

export type AiErrorCode = 'no_key' | 'auth' | 'rate_limit' | 'network' | 'refusal' | 'too_long' | 'cancelled' | 'other'

export interface AiApi {
  status(): Promise<AiStatus>
  /** 加一个服务或改它的设置；key 为 null 表示删除，undefined 表示不改。返回服务 id */
  saveService(service: { id?: string; vendor: string; name?: string; baseUrl: string }, key?: string | null): Promise<string>
  removeService(id: string): Promise<void>
  /** 这个服务能用的模型（会缓存）；refresh 重新向服务要 */
  models(serviceId: string, refresh?: boolean): Promise<{ ok: true; models: AiModel[] } | { ok: false; message: string }>
  /** 对话里换模型 */
  select(selection: AiSelection): Promise<AiStatus>
  /** 这篇论文的问答记录 */
  conversation(paperId: string): Promise<AiChatTurn[]>
  /** 提一个问题；quote 是用户选中拿来问的那段文字。会话记录由主进程保存 */
  ask(paperId: string, question: string, quote?: string): Promise<string>
  /** 清空这篇的问答，重新开始 */
  resetConversation(paperId: string): Promise<void>
  /** 翻译选中的文字（只发这段和其中出现的术语译法），返回 requestId，结果走 onEvent */
  translate(text: string): Promise<string>
  cancel(requestId: string): Promise<void>
  onEvent(cb: (e: AiEvent) => void): () => void
  onStatus(cb: (s: AiStatus) => void): () => void
}
