// 渲染进程这边的文献库状态：拿快照、订阅变化、收导入提示。
import { useCallback, useEffect, useState } from 'react'
import type { Paper, ReadingStatus } from '@flax/core'
import type { ImportNotice, LibrarySnapshot, PaperApi } from '../../../shared/api'

declare global {
  interface Window {
    api: PaperApi
  }
}

export const api = window.api

const EMPTY: LibrarySnapshot = { papers: [], folders: [], tags: [], annotationCounts: {}, terms: [], importing: [], downloading: [] }

export function useLibrary() {
  const [snap, setSnap] = useState<LibrarySnapshot>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [notices, setNotices] = useState<(ImportNotice & { key: number })[]>([])

  const refresh = useCallback(async () => {
    setSnap(await api.library.snapshot())
    setLoaded(true)
  }, [])

  useEffect(() => {
    void refresh()
    let key = 0
    const offChanged = api.library.onChanged(() => void refresh())
    const offNotice = api.library.onNotice((n) => setNotices((list) => [...list, { ...n, key: ++key }]))
    return () => {
      offChanged()
      offNotice()
    }
  }, [refresh])

  const dismiss = useCallback((key: number) => setNotices((list) => list.filter((n) => n.key !== key)), [])
  return { ...snap, loaded, notices, dismiss, refresh }
}

// —— 视图 ——

export type StatusView = 'inbox' | 'reading' | 'toread' | 'done' | 'all'
export type View = StatusView | 'terms' | 'notes' | 'settings' | `folder:${string}`

export const STATUS_OF: Partial<Record<View, ReadingStatus>> = { inbox: 'inbox', reading: 'reading', toread: 'to_read', done: 'done' }

export function papersIn(view: View, papers: Paper[]): Paper[] {
  if (view.startsWith('folder:')) {
    const id = view.slice(7)
    return papers.filter((p) => p.folderIds.includes(id))
  }
  const st = STATUS_OF[view]
  return st ? papers.filter((p) => p.readingStatus === st) : papers
}
