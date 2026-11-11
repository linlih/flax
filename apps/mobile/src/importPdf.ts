// 选一个或几个 PDF 导入。系统文件选择器给的是 content:// 地址，文件名要从选到的文件上拿，
// 所以先拷到缓存目录（保留原文件名，core 用文件名找 arXiv 编号），导入完删掉。
import { Directory, File, Paths } from 'expo-file-system'
import { app, showNotice } from './services'
import { afterModalClose } from './platform/modal'

export async function pickAndImport(): Promise<void> {
  let picked: File[]
  await afterModalClose()
  try {
    const r = await File.pickFileAsync({ mimeTypes: ['application/pdf'], multipleFiles: true })
    if (r.canceled) return
    picked = r.result
  } catch (e) {
    showNotice(`没能打开文件选择器：${e instanceof Error ? e.message : String(e)}`)
    return
  }
  await importFiles(picked)
}

/** names：文件名（分享过来的 content:// 地址上拿不到原名时，由分享方给） */
export async function importFiles(files: File[], names: string[] = []): Promise<void> {
  const tmp = new Directory(Paths.cache, 'import')
  if (!tmp.exists) tmp.create({ intermediates: true, idempotent: true })
  const copies: File[] = []
  for (const [i, f] of files.entries()) {
    const name = (names[i] || f.name || 'paper.pdf').replace(/[\\/]/g, '_')
    const dest = new File(tmp, name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`)
    try {
      if (dest.exists) dest.delete()
      try {
        f.copySync(dest)
      } catch {
        // 分享来的 content://media/… 不能直接拷：读出字节再写
        dest.create()
        dest.writeSync(await f.bytes())
      }
      copies.push(dest)
    } catch (e) {
      if (dest.exists) dest.delete()
      showNotice(`${name} 读不了：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (!copies.length) return
  const before = new Set(app().library.listPapers().map((p) => p.id))
  await app().importer.importPaths(copies.map((c) => c.uri))
  for (const c of copies) if (c.exists) c.delete()
  const added = app().library.listPapers().filter((p) => !before.has(p.id))
  if (added.length === 1) showNotice(`加进来了：${added[0]!.title}`, added[0]!.id)
  else if (added.length > 1) showNotice(`加进来了 ${added.length} 篇`)
}

/** 从 Zotero、JabRef 导出的 .bib 读入。手机上 file 字段里的电脑路径读不到，PDF 之后靠同步或手动添加 */
export async function pickBibTeX(): Promise<void> {
  let f: File
  await afterModalClose()
  try {
    const r = await File.pickFileAsync({ mimeTypes: ['application/x-bibtex', 'text/x-bibtex', 'text/plain', 'application/octet-stream'] })
    if (r.canceled) return
    f = Array.isArray(r.result) ? r.result[0]! : r.result
  } catch (e) {
    showNotice(`没能打开文件选择器：${e instanceof Error ? e.message : String(e)}`)
    return
  }
  try {
    const r = await app().importer.importBibTeX(f.textSync())
    if (!r.added && !r.existing) return showNotice('这个文件里没有认得出的条目')
    showNotice([r.added ? `加进来 ${r.added} 篇` : '', r.existing ? `${r.existing} 篇库里已有` : '', r.missingFiles ? `${r.missingFiles} 篇的 PDF 没找到` : ''].filter(Boolean).join('，'))
  } catch (e) {
    showNotice(`读不了这个文件：${e instanceof Error ? e.message : String(e)}`)
  }
}
