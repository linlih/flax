// 开发用：在电脑上扮演"桌面版"，和手机通过同一个 WebDAV 同步，检查两边的数据能互通。
// 用的是桌面版自己的代码（node:sqlite 的 Library、syncCodec、NoteStore），不是另写的一份。
//   npx jiti apps/mobile/scripts/peer.ts <资料文件夹> <命令> [参数…]
// 命令：
//   create <同步密码>  在 WebDAV 上新建加密的同步库（像桌面上第一次开启同步）
//   join <同步密码>    加入已有的同步库
//   seed               加 2 篇论文（一篇带 PDF）、批注、标签、一篇笔记、一个术语、一段 AI 对话
//   sync               同步一次，打印收到和发出的条数
//   show               打印库里的论文、批注、笔记（看手机改的东西过来没有）
//   annotate <论文标题的一部分> <文字>   加一条批注
//   ask <论文标题的一部分> <问题> <回答>  加一段 AI 对话（像在桌面上问过）
// 环境变量：DAV（默认 http://localhost:8090/dav/）、DAV_USER、DAV_PASS（默认 flax / flax）
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLibrary, createNoteSyncStore, Library, readLibraryInfo, SyncEngine, unlockLibrary, webdav, toBase64, fromBase64, quoteBlock, type SqlDb } from '@flax/core'
import { nodeCodec } from '../../desktop/src/main/syncCodec'
import { NoteStore } from '../../desktop/src/main/notes'
import { makePdf } from '../../desktop/src/main/testing/makePdf'

const [dir, cmd, ...args] = process.argv.slice(2)
if (!dir || !cmd) {
  console.error('用法：peer.ts <资料文件夹> <create|join|seed|sync|show|annotate> …')
  process.exit(2)
}
mkdirSync(join(dir, 'files'), { recursive: true })
const db = new DatabaseSync(join(dir, 'library.sqlite')) as unknown as SqlDb
const library = new Library(db)
// 桌面把删掉的笔记移进废纸篓；这里直接删，不然下次同步会把留下的文件当成新改的再发出去
const notes = new NoteStore(join(dir, 'notes'), { trash: async (path) => rmSync(path, { force: true }) })
const backend = webdav({ url: process.env['DAV'] ?? 'http://localhost:8090/dav/', username: process.env['DAV_USER'] ?? 'flax', password: process.env['DAV_PASS'] ?? 'flax', folder: 'Flax', fetch: fetch as never })
const keyFile = join(dir, 'key.txt')
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const pdfPath = (h: string) => join(dir, 'files', h.slice(0, 2), `${h}.pdf`)

const tx = <T>(fn: () => T): T => {
  db.exec('BEGIN')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

function engine(): SyncEngine {
  const key = existsSync(keyFile) ? fromBase64(readFileSync(keyFile, 'utf8')) : null
  return new SyncEngine({
    backend,
    codec: nodeCodec,
    stores: [library.syncStore(), library.conversationSyncStore(), createNoteSyncStore(db, library.deviceId, notes.syncFiles(), tx, () => crypto.randomUUID())],
    state: { get: (k) => library.metaGet(k), set: (k, v) => library.metaSet(k, v) },
    deviceId: library.deviceId,
    deviceName: 'MacBook（测试）',
    platform: 'darwin',
    key
  })
}

async function syncOnce() {
  const e = engine()
  const r = await e.sync()
  // 和桌面一样：本机有、云端没有的 PDF 传上去；本机没有的下载下来
  const done = library.syncedFiles()
  for (const h of library.liveFileHashes()) {
    if (!done.has(h) && existsSync(pdfPath(h))) {
      await e.putFile(h, new Uint8Array(readFileSync(pdfPath(h))))
      library.markFileSynced(h)
      console.log('上传 PDF', h.slice(0, 8))
    } else if (!existsSync(pdfPath(h))) {
      const data = await e.getFile(h)
      if (data && sha(data) === h) {
        mkdirSync(join(dir, 'files', h.slice(0, 2)), { recursive: true })
        writeFileSync(pdfPath(h), data)
        console.log('下载 PDF', h.slice(0, 8))
      }
    }
  }
  console.log(`同步完成：收到 ${r.received}，发出 ${r.sent}`)
}

function seed() {
  const lines = (n: number) => [
    { text: `Attention Is All You Need — page ${n}`, size: 18, y: 720 },
    { text: 'The dominant sequence transduction models are based on complex recurrent', size: 11, y: 680 },
    { text: 'or convolutional neural networks that include an encoder and a decoder.', size: 11, y: 664 },
    { text: 'We propose a new simple network architecture, the Transformer, based', size: 11, y: 648 },
    { text: 'solely on attention mechanisms, dispensing with recurrence entirely.', size: 11, y: 632 },
    { text: `Scaled dot-product attention divides by sqrt(d_k) on page ${n}.`, size: 11, y: 600 }
  ]
  const pdf = makePdf([1, 2, 3, 4, 5].map(lines), { title: 'Attention Is All You Need', author: 'Ashish Vaswani' })
  const hash = sha(pdf)
  mkdirSync(join(dir, 'files', hash.slice(0, 2)), { recursive: true })
  writeFileSync(pdfPath(hash), pdf)
  const now = new Date().toISOString()
  const a = library.addPaper(
    { title: 'Attention Is All You Need', authors: [{ given: 'Ashish', family: 'Vaswani' }, { given: 'Noam', family: 'Shazeer' }], year: 2017, venue: 'NeurIPS', identifiers: { arxiv: '1706.03762' }, abstract: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.', source: 'arxiv' },
    { file: { hash, size: pdf.length, mime: 'application/pdf', pageCount: 5, role: 'main', originalName: 'attention.pdf', addedAt: now } }
  )
  library.updatePaper(a.id, { readingStatus: 'reading', tags: ['transformer', '毕业论文'] })
  library.savePosition(a.id, { fileHash: hash, page: 3, left: 0, top: 792, scale: 'page-width', updatedAt: now }, 'MacBook（测试）')
  library.setTagColor('transformer', 'blue')
  const anno = library.addAnnotation({ paperId: a.id, fileHash: hash, type: 'highlight', origin: 'select', color: 'yellow', page: 0, target: { rects: [[72, 645, 420, 660]], quote: { exact: 'We propose a new simple network architecture, the Transformer, based', prefix: '', suffix: '' } }, comment: '核心贡献' })
  const b = library.addPaper({ title: 'Deep Residual Learning for Image Recognition', authors: [{ given: 'Kaiming', family: 'He' }], year: 2016, venue: 'CVPR', identifiers: { doi: '10.1109/CVPR.2016.90' }, source: 'crossref' })
  library.updatePaper(b.id, { readingStatus: 'to_read' })
  notes.create({ title: 'Transformer 读书笔记', paperId: a.id, body: `# 要点\n\n${quoteBlock(anno.target.quote.exact, 1, anno.id, anno.comment)}\n\n- 只用注意力\n- 并行训练快\n` })
  library.addTerm({ term: 'attention head', translation: '注意力头', paperId: a.id })
  addChat(a.id, '这篇论文的核心贡献是什么？', '提出了只用注意力的 Transformer ⟦1|We propose a new simple network architecture⟧，训练可以并行。')
  console.log('seeded', a.id, b.id)
}

/** 像桌面问过一次 AI 一样：建一个对话，存一问一答 */
function addChat(paperId: string, q: string, answer: string) {
  const convs = library.conversations()
  const now = new Date().toISOString()
  const c = convs.create(paperId, q, now)
  convs.append(c.id, { role: 'user', text: q, at: now })
  convs.append(c.id, { role: 'assistant', text: answer, model: 'mock-desktop', at: now })
}

function show() {
  for (const p of library.listPapers()) {
    console.log(`📄 ${p.title} [${p.readingStatus}] tags=${p.tags.join(',')} files=${p.files.length} pos=${p.readingPosition?.page ?? '-'} positions=${JSON.stringify(Object.values(p.positions ?? {}).map((x) => `${x.device}:${x.page}`))}`)
    for (const a of library.listAnnotations(p.id)) console.log(`   ✎ p${a.page + 1} ${a.type}/${a.color} "${a.target.quote.exact.slice(0, 50)}"${a.comment ? ` — ${a.comment}` : ''} (${a.deviceId === library.deviceId ? '本机' : '别的设备'})`)
  }
  for (const n of notes.list()) console.log(`📝 ${n.title}: ${notes.read(n.id)!.body.replace(/\n/g, ' ⏎ ').slice(0, 120)}`)
  for (const t of library.listTerms()) console.log(`📘 ${t.term} = ${t.translation}`)
  for (const p of library.listPapers())
    for (const c of library.conversations().list(p.id)) {
      const turns = library.conversations().turns(c.id)
      console.log(`💬 ${p.title.slice(0, 20)} · ${c.title} (${c.questions} 问) 最后：${turns.at(-1)?.text.slice(0, 60) ?? ''}`)
    }
}

async function main() {
  switch (cmd) {
    case 'create': {
      const { key } = await createLibrary(backend, nodeCodec, args[0] ?? null)
      if (key) writeFileSync(keyFile, toBase64(key))
      console.log('建好了同步库', key ? '（加密）' : '')
      break
    }
    case 'join': {
      const info = await readLibraryInfo(backend)
      if (!info) throw new Error('那里没有同步库')
      const key = await unlockLibrary(info, nodeCodec, args[0] ?? null)
      if (key) writeFileSync(keyFile, toBase64(key))
      console.log('加入了同步库', info.id)
      break
    }
    case 'seed':
      seed()
      break
    case 'sync':
      await syncOnce()
      break
    case 'show':
      show()
      break
    case 'annotate': {
      const p = library.listPapers().find((x) => x.title.includes(args[0] ?? ''))
      if (!p || !p.files[0]) throw new Error('找不到论文')
      library.addAnnotation({ paperId: p.id, fileHash: p.files[0].hash, type: 'highlight', origin: 'select', color: 'green', page: 1, target: { rects: [[72, 629, 400, 644]], quote: { exact: args[1] ?? 'solely on attention mechanisms', prefix: '', suffix: '' } } })
      console.log('加了批注')
      break
    }
    case 'ask': {
      const p = library.listPapers().find((x) => x.title.includes(args[0] ?? ''))
      if (!p) throw new Error('找不到论文')
      addChat(p.id, args[1] ?? '问题', args[2] ?? '回答')
      console.log('加了一段 AI 对话')
      break
    }
    default:
      throw new Error(`不认识的命令 ${cmd}`)
  }
}

main().catch((e) => {
  console.error('出错：', e instanceof Error ? e.message : e)
  process.exit(1)
})
