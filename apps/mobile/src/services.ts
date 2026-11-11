// 把 core 的 Library、Importer、AiService 和同步组装起来，对应桌面 main/index.ts 的 setup()。
// 整个应用只有一份；界面通过 useVersion() 订阅"有东西变了"，再从 services 里读。
import { useSyncExternalStore } from 'react'
import { AppState, Platform } from 'react-native'
import { File } from 'expo-file-system'
import { Importer, Library, type ImportNotice } from '@flax/core'
import { AiService, AiSettings } from '@flax/core/ai/runtime'
import type { AiEvent, AiStatus } from '@flax/core'
import { openLibraryDb } from './platform/db'
import { putPdf } from './platform/files'
import { mtCrypto, sha256 } from './platform/hash'
import { fetchLike, net } from './platform/net'
import { NoteStore } from './platform/notes'
import { ensureDirs } from './platform/paths'
import { aiSettingsStorage, keychain } from './platform/secrets'
import { SyncService, type SyncStatus } from './sync'
import { readPdfFacts } from './pdfFacts'

// —— 订阅 ——

type Topic = 'library' | 'notes' | 'sync' | 'ai' | 'notice'
const versions: Record<Topic, number> = { library: 0, notes: 0, sync: 0, ai: 0, notice: 0 }
const listeners = new Set<() => void>()

export function bump(...topics: Topic[]): void {
  for (const t of topics) versions[t]++
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** 某一类数据的版本号：变了就重新渲染 */
export function useVersion(topic: Topic): number {
  return useSyncExternalStore(subscribe, () => versions[topic])
}

// —— 提示（导入的结果等），界面上用一条 Snackbar 显示 ——

export interface NoticeAction {
  label: string
  run: () => void
}
type Notice = { id: number; text: string; paperId?: string; action?: NoticeAction }
let lastNotice: Notice | null = null
let noticeId = 0

/** 底部提示。第二个参数：论文 id（点"打开"去详情），或者 { action }（比如"撤销"） */
export function showNotice(text: string, opt?: string | { paperId?: string; action?: NoticeAction }): void {
  const o = typeof opt === 'string' ? { paperId: opt } : (opt ?? {})
  lastNotice = { id: ++noticeId, text, ...(o.paperId ? { paperId: o.paperId } : {}), ...(o.action ? { action: o.action } : {}) }
  bump('notice')
}

export function currentNotice(): Notice | null {
  return lastNotice
}

function noticeText(n: ImportNotice): { text: string; paperId?: string; action?: NoticeAction } | null {
  switch (n.kind) {
    case 'same_file':
      return { text: `库里已经有了：${n.title}`, paperId: n.paperId }
    case 'same_paper':
      // 和桌面一样：同一篇的另一个 PDF（预印本、期刊版）可以作为新版本挂上去，不点就不导入
      return { text: `库里已经有这篇论文：${n.existing.title}`, action: { label: '加为新版本', run: () => app().importer.resolveDuplicate(n.token, 'add_version') } }
    case 'not_pdf':
      return { text: `${n.fileName} 不是 PDF` }
    case 'failed':
      return { text: `${n.fileName} 导入失败：${n.message}` }
    case 'attached':
      return { text: `PDF 配给了：${n.title}`, paperId: n.paperId }
    case 'download_failed':
      return { text: `${n.title} 的 PDF 没下载下来：${n.message}`, paperId: n.paperId }
    default:
      return null
  }
}

// —— 组装 ——

function deviceName(): string {
  // Android：Platform.constants 里有厂商和型号，例如 Google Pixel 5
  const c = Platform.constants as { Brand?: string; Model?: string; Manufacturer?: string }
  const brand = c.Brand ? c.Brand[0]!.toUpperCase() + c.Brand.slice(1) : ''
  const name = [brand, c.Model].filter(Boolean).join(' ')
  return name || (Platform.OS === 'android' ? 'Android 手机' : '手机')
}

function setup() {
  ensureDirs()
  const db = openLibraryDb()
  const library = new Library(db)
  const notes = new NoteStore()

  let syncRef: SyncService | null = null
  const changed = () => {
    bump('library')
    syncRef?.poke()
  }

  const importer = new Importer({
    library,
    store: { put: (data, hash) => putPdf(data, hash) },
    fetchText: net.fetchText,
    fetchBytes: net.fetchBytes,
    onChanged: changed,
    onNotice: (n) => {
      const t = noticeText(n)
      if (t) showNotice(t.text, { ...(t.paperId ? { paperId: t.paperId } : {}), ...(t.action ? { action: t.action } : {}) })
    },
    read: async (uri) => new File(uri).bytes(),
    hash: sha256,
    // 标题、作者从 PDF 里读：看不见的 WebView 里的 pdf.js（src/pdfFacts.tsx）
    pdfFacts: readPdfFacts
  })

  const aiListeners = new Set<(e: AiEvent) => void>()
  const aiSettings = new AiSettings(aiSettingsStorage, keychain)
  const ai = new AiService({
    settings: aiSettings,
    conversations: library.conversations(),
    emit: (e) => {
      for (const l of aiListeners) l(e)
      if (e.type !== 'delta') syncRef?.poke()
    },
    onStatus: (_s: AiStatus) => bump('ai'),
    fetch: fetchLike,
    mtCrypto
  })

  const device = deviceName()
  const sync = new SyncService({
    db,
    library,
    notes,
    deviceName: device,
    onStatus: (_s: SyncStatus) => bump('sync'),
    onReceived: () => {
      notes.scan()
      bump('library', 'notes')
    }
  })
  syncRef = sync
  sync.start()
  AppState.addEventListener('change', (s) => {
    if (s === 'active') sync.focused()
  })

  return {
    db,
    library,
    notes,
    importer,
    ai,
    aiSettings,
    sync,
    /** 设备名，显示用："在 Google Pixel 5 上读到第 12 页" */
    deviceName: device,
    /** 改了库里的东西以后调：刷新界面，几秒后同步 */
    changed,
    notesChanged: () => {
      bump('notes')
      sync.poke()
    },
    onAi: (l: (e: AiEvent) => void) => {
      aiListeners.add(l)
      return () => aiListeners.delete(l)
    }
  }
}

export type Services = ReturnType<typeof setup>

let services: Services | null = null

export function app(): Services {
  return (services ??= setup())
}
