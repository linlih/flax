// 界面上显示的文字：状态、来源、时间、大小。
import type { MatchIssue, MetadataSource, Paper, ReadingStatus } from '@paper/core'

export const STATUS_LABEL: Record<ReadingStatus, string> = { inbox: '未读', to_read: '待读', reading: '在读', done: '读过' }

export const MATCH_HINT: Record<MatchIssue, string> = {
  no_id: '没有找到 DOI 或 arXiv 编号',
  lookup_failed: '联网查询失败，可以重试',
  not_found: '编号没有查到对应的论文'
}

export const SOURCE_LABEL: Record<MetadataSource, string> = {
  arxiv: '来自 arXiv',
  crossref: '来自 Crossref',
  openalex: '来自 OpenAlex',
  pdf: '从 PDF 文字识别',
  filename: '用的是文件名',
  user: '手动编辑过'
}

export function authorLine(p: Pick<Paper, 'authors'>, max = 3): string {
  const names = p.authors.map((a) => [a.given, a.family].filter(Boolean).join(' '))
  if (names.length <= max) return names.join(', ')
  return `${names.slice(0, max).join(', ')} 等 ${names.length} 人`
}

export function addedLabel(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const mins = (now.getTime() - d.getTime()) / 60000
  if (mins < 2) return '刚刚'
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86400000)
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
