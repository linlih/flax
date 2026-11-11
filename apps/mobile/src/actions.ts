// 几处界面都要用的操作：复制、分享文件、删除（能撤销）、摘到论文笔记、改阅读状态、应用自己的设置。
import { Appearance } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import * as Sharing from 'expo-sharing'
import { Directory, File, Paths } from 'expo-file-system'
import { STATUS_LABEL, type ReadingStatus } from '@flax/core'
import { app, bump, showNotice } from './services'
import { libraryDir } from './platform/paths'

export async function copyText(text: string, done = '已复制'): Promise<void> {
  try {
    await Clipboard.setStringAsync(text)
    showNotice(done)
  } catch {
    showNotice('没能复制，请再试一次')
  }
}

/** 写成临时文件交给系统的分享面板（存到文件、发给别的应用） */
export async function shareTextFile(name: string, text: string, mimeType: string, dialogTitle: string): Promise<void> {
  const dir = new Directory(Paths.cache, 'share')
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true })
  const f = new File(dir, name.replace(/[/\\:*?"<>|]/g, ' '))
  if (f.exists) f.delete()
  f.create()
  f.writeSync(text)
  await shareFile(f.uri, mimeType, dialogTitle)
}

export async function shareFile(uri: string, mimeType: string, dialogTitle: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) return showNotice('这台手机不能分享文件')
  await Sharing.shareAsync(uri, { mimeType, dialogTitle })
}

export function removePaper(id: string): void {
  const s = app()
  const p = s.library.getPaper(id)
  if (!p) return
  s.library.removePaper(id)
  s.changed()
  showNotice(`删掉了：${p.title}`, {
    action: {
      label: '撤销',
      run: () => {
        s.library.restorePaper(id)
        s.changed()
      }
    }
  })
}

/** 手动改阅读状态；改成读过时给个撤销（读到最后点"标为读过"） */
export function setStatus(id: string, st: ReadingStatus): void {
  const s = app()
  const p = s.library.getPaper(id)
  if (!p || p.readingStatus === st) return
  const before = p.readingStatus
  s.library.updatePaper(id, { readingStatus: st })
  s.changed()
  if (st === 'done')
    showNotice(`标为${STATUS_LABEL.done}`, {
      action: {
        label: '撤销',
        run: () => {
          s.library.updatePaper(id, { readingStatus: before })
          s.changed()
        }
      }
    })
}

/** 往这篇论文的笔记末尾加一段；没有笔记就新建一篇（标题用论文标题，和桌面一样） */
export function appendToPaperNote(paperId: string, block: string): void {
  const s = app()
  const paper = s.library.getPaper(paperId)
  if (!paper) return
  const existing = s.notes.forPaper(paperId)[0]
  if (!existing) s.notes.create({ paperId, title: paper.title, body: block.trimEnd() + '\n' })
  else {
    const body = s.notes.read(existing.id)?.body ?? ''
    const sep = !body || body.endsWith('\n\n') ? '' : body.endsWith('\n') ? '\n' : '\n\n'
    s.notes.save(existing.id, body + sep + block.trimEnd() + '\n')
  }
  s.notesChanged()
  showNotice('已摘到笔记')
}

// —— 应用自己的设置（只在这台手机上，不同步）：外观、阅读器页面深色 ——

export type Look = 'system' | 'light' | 'dark'
interface Prefs {
  appearance?: Look
  /** 阅读器里页面深色显示；没设过就跟着系统 */
  pageDark?: boolean
}

// 和桌面一样放在资料文件夹的 prefs.json
const prefsFile = () => new File(libraryDir, 'prefs.json')

function readPrefs(): Prefs {
  try {
    const f = prefsFile()
    return f.exists ? (JSON.parse(f.textSync()) as Prefs) : {}
  } catch {
    return {}
  }
}

function writePrefs(p: Prefs): void {
  try {
    const f = prefsFile()
    if (!f.exists) f.create({ intermediates: true })
    f.writeSync(JSON.stringify(p, null, 2))
  } catch {
    /* 存不下就只对这次生效 */
  }
}

export function look(): Look {
  return readPrefs().appearance ?? 'system'
}

export function setLook(v: Look): void {
  writePrefs({ ...readPrefs(), appearance: v })
  applyLook(v)
}

/** 启动时调一次 */
export function applyLook(v: Look = look()): void {
  Appearance.setColorScheme(v === 'system' ? 'unspecified' : v)
  bump('notice')
}

export function pageDark(systemDark: boolean): boolean {
  return readPrefs().pageDark ?? systemDark
}

export function setPageDark(on: boolean): void {
  writePrefs({ ...readPrefs(), pageDark: on })
}
