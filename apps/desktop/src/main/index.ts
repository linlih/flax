import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { cp, mkdir, rename } from 'node:fs/promises'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, safeStorage, shell, type MenuItemConstructorOptions } from 'electron'
import { Library, toBibTeX, toRIS, type AnnotationPatch, type NewAnnotation, type PaperMeta, type PaperPatch, type ReadingPosition } from '@paper/core'
import type { ImportNotice, LibrarySnapshot, MenuCommand } from '../shared/api'
import { Importer } from './importer'
import { createNet } from './net'
import { createHandler, SCHEME, SCHEME_PRIVILEGES } from './protocol'
import { createAppearance } from './appearance'
import { AiService } from './ai/service'
import { AiSettings } from './ai/settings'
import { AppleTranslator } from './ai/apple'
import { NoteStore } from './notes'
import { Updater, realUpdater } from './updater'
import { FileStore } from './store'

app.setName('Flax')

/** 应用图标（源文件在 brand/，这里是 macOS 网格留边版）。打包后由 .icns 接管，这里主要给开发态的 Dock 和 Windows/Linux 窗口用 */
const iconPath = join(__dirname, '../../resources/icon.png')

// 必须在 ready 之前登记，渲染进程才能用 fetch 读 paper://
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: SCHEME_PRIVILEGES }])

/** 数据目录：数据库和 PDF。测试时可以用环境变量换到别处。
 *  目录名仍是改名前的 Paper：直接改会让已有的库“消失”，等做数据迁移时再一起改 */
const dataDir = process.env['PAPER_DATA_DIR'] ?? join(app.getPath('appData'), 'Paper')

let win: BrowserWindow | null = null
let updater: Updater | null = null
mkdirSync(dataDir, { recursive: true })
const appearance = createAppearance(dataDir, () => setMenu())

const isMac = process.platform === 'darwin'

/** Windows 右上角窗口按钮的底色和图标色，跟着浅色 / 深色走（和 tokens.css 的 --bg、--text 一致） */
function overlay(): { color: string; symbolColor: string; height: number } {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#121212', symbolColor: '#E6E6E6', height: 36 }
    : { color: '#FFFFFF', symbolColor: '#1F1F1F', height: 36 }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: '文献库',
    icon: iconPath,
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 18 }, backgroundColor: '#00000000' }
      // Windows / Linux：去掉系统标题栏，右上角留系统自己的最小化、最大化、关闭按钮
      : { titleBarStyle: 'hidden' as const, titleBarOverlay: overlay(), backgroundColor: overlay().color }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.on('closed', () => (win = null))
  // 外部链接用系统浏览器打开，不在应用里导航
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function setup(): void {
  const db = new DatabaseSync(join(dataDir, 'library.sqlite'))
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  const library = new Library(db)
  const store = new FileStore(dataDir)
  const send = (channel: string, payload?: unknown) => win?.webContents.send(channel, payload)
  const importer = new Importer({
    library,
    store,
    ...createNet((url, init) => net.fetch(String(url), init)),
    onChanged: () => send('library:changed'),
    onNotice: (n: ImportNotice) => send('library:notice', n)
  })
  const changed = () => send('library:changed')
  protocol.handle(SCHEME, createHandler({
    fileFor: (hash) => {
      try {
        return library.findDuplicate({ hash }) ? store.pathFor(hash) : null
      } catch {
        return null
      }
    }
  }))

  const str = (v: unknown, name: string): string => {
    if (typeof v !== 'string') throw new Error(`${name} must be a string`)
    return v
  }
  const mainFile = (id: string) => {
    const p = library.getPaper(id)
    const f = p?.files.find((x) => x.role === 'main') ?? p?.files[0]
    return f ? store.pathFor(f.hash) : null
  }
  const handle = (channel: string, fn: (...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (e, ...args) => {
      // 只接受自己窗口的请求
      if (e.sender !== win?.webContents) throw new Error('unknown sender')
      return fn(...args)
    })

  handle('app:appearance', () => appearance.get())
  handle('app:setAppearance', (v) => appearance.set(v))
  handle('app:info', () => ({ version: app.getVersion(), dataDir }))
  handle('app:updateState', () => updater?.get() ?? { kind: 'idle' })
  handle('app:checkUpdate', () => updater?.check(true) ?? { kind: 'dev', manual: true })
  handle('app:installUpdate', () => updater?.install())
  handle('app:showData', () => void shell.openPath(dataDir))
  // Windows 没有菜单栏：侧栏左上角的按钮弹出同一份菜单
  handle('app:popupMenu', (x, y) => {
    if (win) Menu.getApplicationMenu()?.popup({ window: win, x: Math.round(Number(x) || 0), y: Math.round(Number(y) || 0) })
  })
  // 从备份恢复：现在的资料先整体挪到资料文件夹旁边的"恢复前"文件夹（不删任何东西），再把备份拷进来，然后重启
  handle('app:restore', async () => {
    if (!win) return false
    const r = await dialog.showOpenDialog(win, { title: '选择一个 Flax 备份文件夹', buttonLabel: '从这个备份恢复', properties: ['openDirectory'] })
    const src = r.filePaths[0]
    if (r.canceled || !src) return false
    if (!existsSync(join(src, 'library.sqlite'))) throw new Error('这个文件夹不是 Flax 的备份：里面没有 library.sqlite。')
    if (src === dataDir) throw new Error('这就是现在用的资料文件夹。')
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const aside = `${dataDir} 恢复前 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    const ok = await dialog.showMessageBox(win, {
      type: 'warning',
      message: '用这个备份替换现在的资料库？',
      detail: `现在的论文、批注和笔记会先挪到旁边的文件夹，不会删除：\n${aside}\n\n恢复后 ${app.name} 会重新打开。API Key 保留现在的。`,
      buttons: ['恢复', '取消'],
      defaultId: 1,
      cancelId: 1
    })
    if (ok.response !== 0) return false
    const items = ['library.sqlite', 'library.sqlite-wal', 'library.sqlite-shm', 'files', 'notes', 'prefs.json', join('ai', 'conversations'), join('ai', 'settings.json')]
    db.close()
    await mkdir(join(aside, 'ai'), { recursive: true })
    for (const name of items) if (existsSync(join(dataDir, name))) await rename(join(dataDir, name), join(aside, name))
    for (const name of items) if (existsSync(join(src, name))) await cp(join(src, name), join(dataDir, name), { recursive: true })
    app.relaunch()
    app.exit(0)
    return true
  })
  // 备份：数据库用 VACUUM INTO 拷一份一致的快照，再复制 PDF、笔记、AI 对话和偏好；Key 是本机加密的，不备份
  handle('app:backup', async () => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, { title: '选择备份放在哪里', buttonLabel: '备份到这里', properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const target = join(r.filePaths[0], `${app.name} 备份 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`)
    if (existsSync(target)) throw new Error('那里已经有一个同名的备份了，过一分钟再试。')
    await mkdir(target, { recursive: true })
    db.exec(`VACUUM INTO '${join(target, 'library.sqlite').replace(/'/g, "''")}'`)
    for (const name of ['files', 'notes', 'prefs.json', join('ai', 'conversations'), join('ai', 'settings.json')]) {
      const from = join(dataDir, name)
      if (existsSync(from)) await cp(from, join(target, name), { recursive: true })
    }
    return target
  })

  handle('library:snapshot', (): LibrarySnapshot => ({
    papers: library.listPapers(),
    folders: library.listFolders(),
    tags: library.listTags(),
    annotationCounts: library.annotationCounts(),
    terms: library.listTerms(),
    importing: importer.importingIds(),
    downloading: importer.downloadingIds()
  }))
  handle('library:importPaths', (paths) => {
    if (!Array.isArray(paths)) throw new Error('paths must be an array')
    return importer.importPaths(paths.map((p) => str(p, 'path')))
  })
  handle('library:pickAndImport', async () => {
    if (!win) return
    const r = await dialog.showOpenDialog(win, { title: '选择 PDF', properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    if (!r.canceled) await importer.importPaths(r.filePaths)
  })
  // 从 Zotero 等导入：读 BibTeX，PDF 按 file 字段一起导进来
  handle('library:importBibTeX', async () => {
    if (!win) return
    const r = await dialog.showOpenDialog(win, { title: '选择 BibTeX 文件', message: '在 Zotero 里：文件 › 导出文献库…，格式选 BibTeX，勾选"导出文件"', properties: ['openFile'], filters: [{ name: 'BibTeX', extensions: ['bib', 'bibtex', 'txt'] }] })
    if (r.canceled || !r.filePaths[0]) return
    const result = await importer.importBibTeX(readFileSync(r.filePaths[0], 'utf8'))
    send('library:notice', { kind: 'bib_done', ...result } satisfies ImportNotice)
  })
  // 导出参考文献：ids 为空就是全部
  handle('library:exportCitations', async (ids, format) => {
    if (!win) return false
    const want = Array.isArray(ids) && ids.length ? new Set(ids.map((x) => str(x, 'id'))) : null
    const papers = library.listPapers().filter((p) => !want || want.has(p.id))
    if (!papers.length) return false
    const ris = format === 'ris'
    const r = await dialog.showSaveDialog(win, { title: '导出参考文献', defaultPath: `${papers.length === 1 ? papers[0]!.title.slice(0, 60).replace(/[/\\:*?"<>|]/g, ' ') : 'Flax 文献'}.${ris ? 'ris' : 'bib'}`, filters: [ris ? { name: 'RIS', extensions: ['ris'] } : { name: 'BibTeX', extensions: ['bib'] }] })
    if (r.canceled || !r.filePath) return false
    writeFileSync(r.filePath, ris ? toRIS(papers) : toBibTeX(papers))
    return true
  })
  handle('library:addFromText', (text) => importer.addFromText(str(text, 'text')))
  handle('library:update', (id, patch) => {
    library.updatePaper(str(id, 'id'), patch as PaperPatch)
    changed()
  })
  handle('library:remove', (id) => {
    library.removePaper(str(id, 'id'))
    changed()
  })
  handle('library:restore', (id) => {
    library.restorePaper(str(id, 'id'))
    changed()
  })
  handle('library:retryLookup', (id) => importer.retry(str(id, 'id')))
  handle('library:downloadPdf', (id) => importer.startDownload(str(id, 'id')))
  handle('library:searchCandidates', (id) => importer.candidates(str(id, 'id')))
  handle('library:applyCandidate', (id, meta) => importer.applyCandidate(str(id, 'id'), meta as PaperMeta))
  handle('library:resolveDuplicate', (token, action) => importer.resolveDuplicate(str(token, 'token'), action === 'add_version' ? 'add_version' : 'skip'))
  handle('library:openFile', async (id) => {
    const p = mainFile(str(id, 'id'))
    if (p) await shell.openPath(p)
  })
  handle('library:fileMissing', (id) => {
    const p = mainFile(str(id, 'id'))
    return !p || !existsSync(p)
  })
  handle('library:relink', async (id) => {
    if (!win) return 'cancel'
    const r = await dialog.showOpenDialog(win, { title: '重新选择这篇论文的 PDF', properties: ['openFile'], filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    if (r.canceled || !r.filePaths[0]) return 'cancel'
    return importer.relink(str(id, 'id'), r.filePaths[0])
  })
  // 进入阅读器：记打开时间；收件箱和待读里的论文变成"在读"
  handle('library:markOpened', (id) => {
    const p = library.getPaper(str(id, 'id'))
    if (!p) return
    const patch: PaperPatch = { lastOpenedAt: new Date().toISOString() }
    if (p.readingStatus === 'inbox' || p.readingStatus === 'to_read') patch.readingStatus = 'reading'
    library.updatePaper(p.id, patch)
    changed()
  })
  // 阅读位置滚动时频繁保存，不通知界面刷新
  // 关阅读器时最后存一次（final），这时才通知界面刷新
  handle('library:savePosition', (id, pos, final) => {
    const p = pos as ReadingPosition
    if (!p || typeof p.page !== 'number' || typeof p.fileHash !== 'string') throw new Error('bad position')
    if (library.getPaper(str(id, 'id'))) library.updatePaper(str(id, 'id'), { readingPosition: p })
    if (final === true) changed()
  })
  handle('library:annotations', (id) => library.listAnnotations(str(id, 'id')))
  handle('library:addAnnotation', (a) => {
    const n = a as NewAnnotation
    if (!n || !library.getPaper(str(n.paperId, 'paperId'))) throw new Error('paper not found')
    const r = library.addAnnotation(n)
    changed()
    return r
  })
  handle('library:updateAnnotation', (id, patch) => library.updateAnnotation(str(id, 'id'), patch as AnnotationPatch))
  handle('library:removeAnnotation', (id) => {
    library.removeAnnotation(str(id, 'id'))
    changed()
  })
  handle('library:restoreAnnotation', (id) => {
    library.restoreAnnotation(str(id, 'id'))
    changed()
  })
  handle('library:annotation', (id) => library.getAnnotation(str(id, 'id')))

  // —— 笔记：notes/ 目录里的 .md 文件 ——
  const notes = new NoteStore(join(dataDir, 'notes'), { trash: (p) => shell.trashItem(p) })
  const notesChanged = () => send('notes:changed')
  notes.watch(notesChanged)
  app.on('before-quit', () => notes.close())
  handle('notes:list', () => notes.list())
  handle('notes:read', (id) => notes.read(str(id, 'id')))
  handle('notes:create', (opts) => {
    const o = (opts ?? {}) as { title?: unknown; paperId?: unknown; body?: unknown }
    const paperId = typeof o.paperId === 'string' ? o.paperId : undefined
    const title = typeof o.title === 'string' ? o.title : paperId ? library.getPaper(paperId)?.title : undefined
    const note = notes.create({ title, paperId, body: typeof o.body === 'string' ? o.body : '' })
    notesChanged()
    return note
  })
  handle('notes:save', (id, body) => {
    const note = notes.save(str(id, 'id'), typeof body === 'string' ? body : '')
    notesChanged()
    return note
  })
  handle('notes:rename', (id, title) => {
    const note = notes.rename(str(id, 'id'), str(title, 'title'))
    notesChanged()
    return note
  })
  handle('notes:remove', async (id) => {
    await notes.remove(str(id, 'id'))
    notesChanged()
  })
  handle('notes:showInFinder', (id) => {
    const n = notes.read(str(id, 'id'))
    if (n) shell.showItemInFolder(join(notes.dir, `${n.note.title}.md`))
  })

  // —— AI：Key 用系统钥匙串加密；请求走 Electron 的网络栈（跟随系统代理）——
  const aiDir = join(dataDir, 'ai')
  // macOS 自带翻译的小助手：打包后放在 Resources/bin，开发时用 native/out 里编好的
  const apple = new AppleTranslator(app.isPackaged ? join(process.resourcesPath, 'bin', 'flax-translate') : join(app.getAppPath(), 'native', 'out', 'flax-translate'))
  app.on('will-quit', () => apple.stop())
  const ai = new AiService({
    apple,
    dir: aiDir,
    settings: new AiSettings(aiDir, {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (t) => safeStorage.encryptString(t),
      decrypt: (b) => safeStorage.decryptString(b)
    }),
    emit: (e) => send('ai:event', e),
    onStatus: (st) => send('ai:status', st),
    fetch: (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init)
  })
  void ai.checkApple()
  handle('ai:status', () => ai.status())
  handle('ai:saveService', (service, key) => ai.saveService(service, key === null ? null : typeof key === 'string' ? key : undefined))
  handle('ai:removeService', (id) => ai.removeService(str(id, 'id')))
  handle('ai:models', (id, refresh) => ai.models(str(id, 'id'), refresh === true))
  handle('ai:select', (sel) => ai.select(sel))
  handle('ai:setEffort', (e) => ai.setEffort(e))
  handle('ai:conversation', (paperId, id) => ai.conversation(str(paperId, 'paperId'), typeof id === 'string' ? id : undefined))
  handle('ai:conversations', (paperId) => ai.conversations(str(paperId, 'paperId')))
  handle('ai:newConversation', (paperId) => ai.newConversation(str(paperId, 'paperId')))
  handle('ai:openConversation', (paperId, id) => ai.openConversation(str(paperId, 'paperId'), str(id, 'id')))
  handle('ai:renameConversation', (paperId, id, title) => ai.renameConversation(str(paperId, 'paperId'), str(id, 'id'), str(title, 'title')))
  handle('ai:deleteConversation', (paperId, id) => ai.deleteConversation(str(paperId, 'paperId'), str(id, 'id')))
  handle('ai:ask', (paperId, question, quote) => ai.ask(str(paperId, 'paperId'), str(question, 'question'), typeof quote === 'string' ? quote : undefined))
  handle('ai:translate', (text) => {
    const t = str(text, 'text')
    return ai.translate(t, library.termsIn(t).map(({ term, translation }) => ({ term, translation })))
  })
  handle('ai:setTranslateEngine', (e) => ai.setTranslateEngine(e))
  handle('ai:saveTranslateAccount', (a, secret) => ai.saveTranslateAccount(a, secret === null ? null : typeof secret === 'string' ? secret : undefined))
  handle('ai:testTranslate', (e) => ai.testTranslate(e))
  handle('ai:checkAppleTranslate', () => ai.checkApple())
  // 系统设置 › 通用 › 语言与地区（翻译语言在这一页的最下面）
  handle('ai:openTranslateLanguages', () => shell.openExternal('x-apple.systempreferences:com.apple.Localization-Settings.extension'))
  handle('ai:cancel', (requestId) => ai.cancel(str(requestId, 'requestId')))

  handle('library:showInFinder', (id) => {
    const p = mainFile(str(id, 'id'))
    if (p) shell.showItemInFolder(p)
  })
  handle('library:createFolder', (name) => {
    const f = library.createFolder(str(name, 'name'))
    changed()
    return f
  })
  handle('library:renameFolder', (id, name) => {
    library.renameFolder(str(id, 'id'), str(name, 'name'))
    changed()
  })
  handle('library:removeFolder', (id) => {
    library.removeFolder(str(id, 'id'))
    changed()
  })
  handle('library:renameTag', (from, to) => {
    library.renameTag(str(from, 'from'), str(to, 'to'))
    changed()
  })
  handle('library:addTerm', (t) => {
    const o = (t ?? {}) as Record<string, unknown>
    const term = library.addTerm({ term: str(o['term'], 'term'), translation: str(o['translation'], 'translation'), note: typeof o['note'] === 'string' ? o['note'] : undefined, paperId: typeof o['paperId'] === 'string' ? o['paperId'] : undefined })
    changed()
    return term
  })
  handle('library:updateTerm', (id, patch) => {
    const o = (patch ?? {}) as Record<string, unknown>
    const pick = (k: string) => (typeof o[k] === 'string' ? { [k]: o[k] as string } : {})
    const term = library.updateTerm(str(id, 'id'), { ...pick('term'), ...pick('translation'), ...pick('note') })
    changed()
    return term
  })
  handle('library:removeTerm', (id) => {
    library.removeTerm(str(id, 'id'))
    changed()
  })
  handle('library:restoreTerm', (id) => {
    library.restoreTerm(str(id, 'id'))
    changed()
  })
}

/** 自己的菜单：去掉默认的"实际大小 / 放大 / 缩小"，⌘0 ⌘+ ⌘- 留给阅读器缩放页面 */
function setMenu(): void {
  const cmd = (c: MenuCommand) => () => {
    if (!win) createWindow()
    win?.webContents.send('app:menu', c)
  }
  const settings: MenuItemConstructorOptions = { label: '设置…', accelerator: 'CmdOrCtrl+,', click: cmd('settings') }
  const checkUpdate: MenuItemConstructorOptions = { label: '检查更新…', click: () => { if (!win) createWindow(); updater?.check(true) } }
  const fileItems: MenuItemConstructorOptions[] = [
    { label: '导入 PDF…', accelerator: 'CmdOrCtrl+O', click: cmd('importPdf') },
    { label: '从 Zotero 或 BibTeX 导入…', click: cmd('importBib') },
    { label: '新建笔记', accelerator: 'CmdOrCtrl+N', click: cmd('newNote') },
    { type: 'separator' },
    { label: '导出全部为 BibTeX…', click: cmd('exportBib') },
    { label: '导出全部为 RIS…', click: cmd('exportRis') }
  ]
  // macOS 有应用菜单（关于、设置、服务、隐藏）；Windows 没有，设置和退出放进"文件"
  const head: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.name,
          submenu: [
            { role: 'about', label: `关于 ${app.name}` },
            checkUpdate,
            { type: 'separator' },
            settings,
            { type: 'separator' },
            { role: 'services', label: '服务' },
            { type: 'separator' },
            { role: 'hide', label: `隐藏 ${app.name}` },
            { role: 'hideOthers', label: '隐藏其他' },
            { role: 'unhide', label: '全部显示' },
            { type: 'separator' },
            { role: 'quit', label: `退出 ${app.name}` }
          ]
        },
        { label: '文件', submenu: [...fileItems, { type: 'separator' }, { role: 'close', label: '关闭窗口' }] }
      ]
    : [{ label: '文件', submenu: [...fileItems, { type: 'separator' }, settings, { type: 'separator' }, { role: 'quit', label: '退出' }] }]
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...head,
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        ...(isMac ? [{ role: 'pasteAndMatchStyle' as const, label: '粘贴并匹配样式' }] : []),
        { role: 'delete', label: '删除' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '显示',
      submenu: [
        {
          label: '外观',
          submenu: ([['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']] as const).map(([value, label]) => ({
            label,
            type: 'radio' as const,
            checked: appearance.get() === value,
            click: () => appearance.set(value)
          }))
        },
        { type: 'separator' as const },
        { label: '批注和笔记', accelerator: 'Alt+CmdOrCtrl+N', click: cmd('toggleNotes') },
        { label: 'AI', accelerator: 'Alt+CmdOrCtrl+A', click: cmd('toggleAi') },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const, label: '进入全屏幕' },
        ...(app.isPackaged ? [] : [{ type: 'separator' as const }, { role: 'toggleDevTools' as const, label: '开发者工具' }])
      ]
    },
    {
      label: '窗口',
      role: 'windowMenu',
      submenu: isMac
        ? [{ role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' }, { type: 'separator' }, { role: 'front', label: '前置全部窗口' }]
        : [{ role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭窗口' }]
    },
    {
      label: '帮助',
      role: 'help',
      submenu: [
        { label: '键盘快捷键', accelerator: 'CmdOrCtrl+/', click: cmd('shortcuts') },
        ...(isMac ? [] : [{ type: 'separator' as const }, checkUpdate, { role: 'about' as const, label: `关于 ${app.name}` }])
      ]
    }
  ]))
}

app.whenReady().then(() => {
  // 打包后的图标来自 .icns；开发时用 png 换掉 Electron 的默认图标。图标出问题不能挡住窗口打开
  if (process.platform === 'darwin' && !app.isPackaged) {
    try {
      app.dock?.setIcon(iconPath)
    } catch {}
  }
  setMenu()
  setup()
  createWindow()
  // Windows 的窗口按钮不会自己跟着深浅色变
  if (!isMac) nativeTheme.on('updated', () => win?.setTitleBarOverlay(overlay()))
  // 打开一会儿后悄悄检查更新，之后每 6 小时一次
  void realUpdater().catch((e: unknown) => (console.error('updater:', e), null)).then((u) => {
    updater = new Updater(u, (st) => win?.webContents.send('app:update', st))
    setTimeout(() => updater?.check(), 10_000)
    setInterval(() => updater?.check(), 6 * 3600_000)
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
