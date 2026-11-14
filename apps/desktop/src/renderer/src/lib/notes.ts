// 渲染进程这边的笔记列表：拿列表、订阅变化（包括在别的编辑器里改了文件）。
import { useCallback, useEffect, useState } from 'react'
import type { NoteSummary } from '../../../shared/api'
import { api } from './library'

export function useNotes() {
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [loaded, setLoaded] = useState(false)
  const refresh = useCallback(async () => {
    setNotes(await api.notes.list())
    setLoaded(true)
  }, [])
  useEffect(() => {
    void refresh()
    return api.notes.onChanged(() => void refresh())
  }, [refresh])
  return { notes, loaded, refresh }
}

/** 笔记更新时间的简短说法 */
export function editedLabel(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const mins = Math.round((now.getTime() - d.getTime()) / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  if (d.toDateString() === now.toDateString()) return `今天 ${d.toTimeString().slice(0, 5)}`
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return '昨天'
  return d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
