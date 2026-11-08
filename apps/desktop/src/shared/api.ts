// 主进程和渲染进程之间的接口。渲染进程只能通过 window.api 调这些方法。
import type { Annotation, AnnotationPatch, Folder, NewAnnotation, Paper, PaperMeta, PaperPatch, ReadingPosition, TagColor, Term } from '@flax/core'

export interface LibrarySnapshot {
  papers: Paper[]
  folders: Folder[]
  tags: { tag: string; count: number; color?: TagColor }[]
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
  /** 标签颜色在整个库里通用；null 去掉颜色 */
  setTagColor(tag: string, color: TagColor | null): Promise<void>
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
  /** 在 (x, y) 弹出应用菜单（Windows 没有菜单栏时用） */
  popupMenu(x: number, y: number): Promise<void>
  /** 选一个文件夹，把整个资料库备份进去；返回备份的位置，取消时是 null */
  backup(): Promise<string | null>
  /** 换资料文件夹：选空文件夹就搬过去，选已有的资料文件夹就改用它；成功后应用重启。取消时返回 false */
  moveData(): Promise<boolean>
  /** 选一个备份恢复：现在的资料挪到一旁，然后应用重启；取消时返回 false */
  restore(): Promise<boolean>
  library: LibraryApi
  notes: NotesApi
  ai: AiApi
  sync: SyncApi
  /** 自动更新 */
  update: {
    state(): Promise<UpdateState>
    /** 手动检查：结果会通过 onState 告诉界面 */
    check(): Promise<UpdateState>
    /** 立即更新：下载新版本，下好后重启安装 */
    install(): Promise<void>
    onState(cb: (s: UpdateState) => void): () => void
  }
  /** 菜单栏里点了某一项 */
  onMenu(cb: (cmd: MenuCommand) => void): () => void
}

// —— 同步 ——

/** 怎么连到同步的地方。坚果云就是 WebDAV，地址是 https://dav.jianguoyun.com/dav/ */
export type SyncConnect =
  | { kind: 'webdav'; url: string; username: string; password: string; folder?: string }
  | { kind: 'folder'; path: string }

export interface SyncStatus {
  /** 没开启同步时是 null（不含密码） */
  config: { kind: 'webdav'; url: string; username: string; folder: string } | { kind: 'folder'; path: string } | null
  encrypted: boolean
  state: 'off' | 'idle' | 'syncing' | 'error'
  /** 上次成功同步的时间 */
  lastSync?: string
  error?: string
  /** 还有几个 PDF 要传或下载 */
  files?: { left: number }
  /** 系统钥匙串能不能用（不能用就不能保存密码） */
  canEncrypt: boolean
}

export interface SyncApi {
  status(): Promise<SyncStatus>
  /** 那里有没有已经建好的同步库、加没加密 */
  probe(c: SyncConnect): Promise<{ exists: boolean; encrypted: boolean }>
  /** 开启同步：已有同步库时 syncPassword 是当时设的同步密码；新建时 null 表示不加密 */
  connect(c: SyncConnect, syncPassword: string | null): Promise<void>
  /** 选一个本地文件夹当同步的地方 */
  pickFolder(): Promise<string | null>
  /** 这台设备停用同步，云端的数据不动 */
  disconnect(): Promise<void>
  syncNow(): Promise<void>
  onStatus(cb: (s: SyncStatus) => void): () => void
}

/** 更新状态。manual：这次检查是用户点的，结果要告诉他 */
export type UpdateState = (
  | { kind: 'idle' | 'checking' | 'latest' | 'dev' }
  /** 有新版本，等用户决定（不会自己下载） */
  | { kind: 'available'; version: string; notes?: string }
  | { kind: 'downloading'; version: string; percent?: number }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string }
) & { manual?: boolean }

export type MenuCommand = 'settings' | 'importPdf' | 'addLink' | 'importBib' | 'newNote' | 'exportBib' | 'exportRis' | 'shortcuts' | 'toggleNotes' | 'toggleAi'

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
  /** 这个模型能选的思考深度（服务说了才有）；空数组表示不能调，没有这项表示不知道 */
  efforts?: Exclude<AiEffort, 'auto'>[]
}

/** 问 AI 时模型想多深。auto：不指定，用模型自己的默认 */
export type AiEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const AI_EFFORTS: AiEffort[] = ['auto', 'low', 'medium', 'high', 'xhigh', 'max']

/** 对话里选的模型 */
export interface AiSelection {
  service: string
  model: string
}

export interface AiStatus {
  services: AiService[]
  /** 当前选的模型；还没选是 null */
  selection: AiSelection | null
  /** 问 AI 时的思考深度（翻译固定用 low） */
  effort: AiEffort
  /** 有选好的模型、它的服务也连得上（有 Key 或不要 Key） */
  ready: boolean
  /** 系统钥匙串能不能用；不能用时不保存 Key */
  canEncrypt: boolean
  usage: AiUsageTotal
  translate: TranslateStatus
}

/** 机器翻译服务（各家官方 API，用户自己的 Key） */
export type MtEngine = 'tencent' | 'baidu' | 'youdao' | 'deepl' | 'microsoft'
/** 翻译用哪家：apple 是 macOS 自带的翻译（免费、不用注册），ai 是对话里选的模型 */
export type TranslateEngine = 'apple' | 'ai' | MtEngine
/** macOS 自带翻译的状态。installed：能用；supported：要先在系统设置里下载英语和中文；unsupported / unavailable：用不了 */
export type AppleTranslateStatus = 'installed' | 'supported' | 'unsupported' | 'unavailable'

export interface MtAccountInfo {
  engine: MtEngine
  /** APP ID / SecretId（不是秘密，可以显示） */
  id: string
  region: string
  hasSecret: boolean
}

export interface TranslateStatus {
  /** 现在用的那家 */
  engine: TranslateEngine
  /** 用户没选过：系统翻译能用就用它，不然用 AI */
  auto: boolean
  apple: AppleTranslateStatus
  /** 现在翻译能不能用（选的那家填好了 Key） */
  ready: boolean
  accounts: MtAccountInfo[]
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

export interface AiConversationSummary {
  id: string
  /** 默认是第一个问题，可以改 */
  title: string
  updatedAt: string
  /** 问了几个问题 */
  questions: number
}

export interface AiConversationList {
  /** 正在用的对话；null 表示新对话、还没问 */
  current: string | null
  list: AiConversationSummary[]
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

export type AiErrorCode = 'no_key' | 'quota' | 'auth' | 'rate_limit' | 'network' | 'refusal' | 'too_long' | 'cancelled' | 'other'

export interface AiApi {
  status(): Promise<AiStatus>
  /** 加一个服务或改它的设置；key 为 null 表示删除，undefined 表示不改。返回服务 id */
  saveService(service: { id?: string; vendor: string; name?: string; baseUrl: string }, key?: string | null): Promise<string>
  removeService(id: string): Promise<void>
  /** 这个服务能用的模型（会缓存）；refresh 重新向服务要 */
  models(serviceId: string, refresh?: boolean): Promise<{ ok: true; models: AiModel[] } | { ok: false; message: string }>
  /** 对话里换模型 */
  select(selection: AiSelection): Promise<AiStatus>
  /** 对话里换思考深度 */
  setEffort(effort: AiEffort): Promise<AiStatus>
  /** 一个对话的内容；不给 id 是当前那个 */
  conversation(paperId: string, id?: string): Promise<AiChatTurn[]>
  /** 这篇论文的全部对话 */
  conversations(paperId: string): Promise<AiConversationList>
  /** 开新对话（旧的留在历史里） */
  newConversation(paperId: string): Promise<void>
  /** 切到历史里的一个对话，返回它的内容 */
  openConversation(paperId: string, id: string): Promise<AiChatTurn[]>
  renameConversation(paperId: string, id: string, title: string): Promise<void>
  deleteConversation(paperId: string, id: string): Promise<void>
  /** 提一个问题；quote 是用户选中拿来问的那段文字。会话记录由主进程保存 */
  ask(paperId: string, question: string, quote?: string): Promise<string>
  /** 翻译选中的文字（只发这段和其中出现的术语译法），返回 requestId，结果走 onEvent */
  translate(text: string): Promise<string>
  /** 翻译换一家 */
  setTranslateEngine(engine: TranslateEngine): Promise<AiStatus>
  /** 填某家翻译的账号；secret 为 null 表示删掉这家，undefined 表示不改 */
  saveTranslateAccount(account: { engine: MtEngine; id?: string; region?: string }, secret?: string | null): Promise<AiStatus>
  /** 重新看一下系统翻译能不能用（用户去系统设置下载完语言回来时） */
  checkAppleTranslate(): Promise<AiStatus>
  /** 打开系统设置里下载翻译语言的地方 */
  openTranslateLanguages(): Promise<void>
  /** 用这家翻一个词，看看 Key 对不对 */
  testTranslate(engine: MtEngine): Promise<{ ok: true; text: string } | { ok: false; message: string }>
  cancel(requestId: string): Promise<void>
  onEvent(cb: (e: AiEvent) => void): () => void
  onStatus(cb: (s: AiStatus) => void): () => void
}
