import { useEffect, useRef, useState } from 'react'
import { splitName, suggestFileName, type Author, type Folder, type Paper, type PaperMeta } from '@paper/core'
import type { PaperPatch } from '@paper/core'
import type { Candidate } from '../../../shared/api'
import { Icon, Spinner } from './Icon'
import { api } from '../lib/library'
import { authorLine, MATCH_HINT, sizeLabel, SOURCE_LABEL } from '../lib/format'
import { FILES_APP, TRASH } from '../lib/platform'

interface Props {
  paper: Paper
  folders: Folder[]
  allTags: { tag: string; count: number }[]
  busy: boolean
  downloading: boolean
  onClose: () => void
  onRead: () => void
  onRemove: (id: string) => void
}

const ROLE_LABEL = { main: '主文件', preprint: '另一个版本', supplement: '补充材料' } as const

/** 列表右边的详情栏：点一下论文就显示，改动随时保存 */
export function PaperDetail({ paper: p, folders, allTags, busy, downloading, onClose, onRead, onRemove }: Props) {
  const update = (patch: PaperPatch) => void api.library.update(p.id, patch)
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const hasIds = Boolean(p.identifiers.arxiv || p.identifiers.doi)
  const byline = [authorLine(p), p.year].filter(Boolean).join(' · ')

  return (
    <aside className="inspector" aria-labelledby="insp-title">
      <div className="insp-top drag">
        <span className="lbl">论文详情</span>
        <button type="button" className="icon-btn no-drag" aria-label="关闭详情" title="关闭详情（Esc）" onClick={onClose}><Icon name="close" size={16} /></button>
      </div>
      <div className="insp-scroll">
        <div className="insp-head">
          <h2 id="insp-title" className="insp-title">{p.title}</h2>
          {byline && <span className="insp-by">{byline}</span>}
          {p.files.length > 0 ? (
            <button type="button" className="btn btn-p insp-read" onClick={onRead}><Icon name="reading" size={16} />开始读</button>
          ) : downloading ? (
            <span className="hint insp-dl"><Spinner />正在从 arXiv 下载 PDF…</span>
          ) : p.identifiers.arxiv ? (
            <button type="button" className="btn insp-read" onClick={() => void api.library.downloadPdf(p.id)}><Icon name="down" size={16} />从 arXiv 下载 PDF</button>
          ) : (
            <span className="hint">还没有 PDF：把 PDF 拖到窗口里，会自动配给这篇论文。</span>
          )}
        </div>

        {(p.needsMatch || busy) && <MatchCard paper={p} busy={busy} onManual={() => titleRef.current?.focus()} />}

        <section className="tray" aria-labelledby="h-info">
          <div className="tray-h tray-h-row">
            <div style={{ flex: 1 }}>
              <h3 id="h-info" className="lbl" style={{ margin: 0 }}>信息</h3>
              <span className="hint">{SOURCE_LABEL[p.metadataSource]}</span>
            </div>
            {hasIds && (
              <button type="button" className="btn btn-s" disabled={busy} onClick={() => void api.library.retryLookup(p.id)}>
                {busy ? <Spinner /> : <Icon name="refresh" size={14} />}重新获取
              </button>
            )}
          </div>
          <div className="card fields">
            <Field label="标题" value={p.title} multiline inputRef={titleRef} onCommit={(v) => v && update({ title: v })} />
            <Field label="作者" value={p.authors.map(nameOf).join(', ')} placeholder="用逗号分隔，例如 Ada Lovelace, Alan Turing" onCommit={(v) => update({ authors: parseAuthors(v) })} />
            <div className="field-pair">
              <Field label="年份" value={p.year ? String(p.year) : ''} placeholder="例如 2024" inputMode="numeric" onCommit={(v) => {
                const y = Number(v)
                update({ year: v && Number.isInteger(y) && y > 1000 && y < 3000 ? y : undefined })
              }} />
              <Field label="发表" value={p.venue ?? ''} placeholder="期刊或会议" onCommit={(v) => update({ venue: v || undefined })} />
            </div>
            <div className="field-pair">
              <Field label="DOI" value={p.identifiers.doi ?? ''} placeholder="10.1145/…" mono onCommit={(v) => update({ identifiers: withId(p, 'doi', v.toLowerCase()) })} />
              <Field label="arXiv" value={p.identifiers.arxiv ?? ''} placeholder="2401.01234" mono onCommit={(v) => update({ identifiers: withId(p, 'arxiv', v) })} />
            </div>
            <Field label="摘要" value={p.abstract ?? ''} multiline rows={5} placeholder="没有摘要" onCommit={(v) => update({ abstract: v || undefined })} />
          </div>
        </section>

        <section className="tray" aria-labelledby="h-org">
          <div className="tray-h"><h3 id="h-org" className="lbl" style={{ margin: 0 }}>整理</h3></div>
          <div className="card fields">
            <div className="field">
              <span className="field-l" id="l-folders">文件夹</span>
              {folders.length === 0 ? (
                <span className="hint">还没有文件夹。在侧边栏"文件夹"旁边点 + 新建。</span>
              ) : (
                <div className="chips" role="group" aria-labelledby="l-folders">
                  {folders.map((f) => {
                    const on = p.folderIds.includes(f.id)
                    return (
                      <button key={f.id} type="button" className="chip toggle" aria-pressed={on} onClick={() => update({ folderIds: on ? p.folderIds.filter((x) => x !== f.id) : [...p.folderIds, f.id] })}>
                        <Icon name="folder" size={14} />{f.name}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
            <TagEditor tags={p.tags} all={allTags} onChange={(tags) => update({ tags })} />
          </div>
        </section>

        {p.files.length > 0 && (
          <section className="tray" aria-labelledby="h-files">
            <div className="tray-h"><h3 id="h-files" className="lbl" style={{ margin: 0 }}>文件 · {p.files.length} 个</h3></div>
            <div className="card">
              {p.files.map((f, i) => (
                <div className="insp-file" key={f.hash}>
                  <span className="rt">
                    <b>{i === 0 ? '主文件' : ROLE_LABEL[f.role]}</b>
                    <small title={f.originalName}>{[f.originalName, f.pageCount && `${f.pageCount} 页`, sizeLabel(f.size)].filter(Boolean).join(' · ')}</small>
                  </span>
                  {i === 0 && (
                    <div className="insp-file-actions">
                      <button type="button" className="btn btn-s" onClick={() => void api.library.openFile(p.id)}>用其他程序打开</button>
                      <button type="button" className="btn btn-s" onClick={() => void api.library.showInFinder(p.id)}>在{FILES_APP}中显示</button>
                    </div>
                  )}
                </div>
              ))}
              <div className="field">
                <span className="field-l">导出文件名</span>
                <span className="field-ro">{suggestFileName(p)}</span>
              </div>
            </div>
          </section>
        )}

        <div className="detail-foot">
          <button type="button" className="btn btn-s danger-text" onClick={() => onRemove(p.id)}><Icon name="trash" size={14} />移到{TRASH}</button>
        </div>
      </div>
    </aside>
  )
}

function MatchCard({ paper: p, busy, onManual }: { paper: Paper; busy: boolean; onManual: () => void }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [list, setList] = useState<Candidate[]>([])
  useEffect(() => setState('idle'), [p.id])

  const search = async () => {
    setState('loading')
    try {
      setList(await api.library.searchCandidates(p.id))
      setState('done')
    } catch {
      setState('error')
    }
  }
  const use = (c: Candidate) => {
    const { similarity: _s, ...meta } = c
    void api.library.applyCandidate(p.id, meta as PaperMeta)
  }

  if (busy) {
    return (
      <section className="tray match" aria-live="polite">
        <div className="tray-h tray-h-row"><Spinner size={14} /><span style={{ fontWeight: 500 }}>正在识别标题和作者…</span></div>
      </section>
    )
  }
  return (
    <section className="tray match" aria-labelledby="h-match">
      <div className="tray-h">
        <h2 id="h-match" className="lbl" style={{ margin: 0 }}>需要匹配</h2>
        <span style={{ fontWeight: 500 }}>{p.matchIssue ? MATCH_HINT[p.matchIssue] : '信息可能不完整'}。{state === 'done' ? (list.length ? '按标题搜到这些，选一个：' : '按标题没有搜到相近的论文。') : '可以按标题搜索，或者手动填写。'}</span>
      </div>
      {state === 'done' && list.length > 0 && (
        <div className="card">
          {list.map((c, i) => (
            <div className="row" key={i}>
              <span className="rt">
                <b>{c.title}</b>
                <small>{[c.source === 'arxiv' ? 'arXiv' : 'Crossref', c.year, authorLine(c, 2), c.similarity > 0.9 ? '标题相似度高' : '部分匹配'].filter(Boolean).join(' · ')}</small>
              </span>
              <button type="button" className="btn btn-s" onClick={() => use(c)}>用这个</button>
            </div>
          ))}
        </div>
      )}
      {state === 'error' && <p className="hint" style={{ margin: '0 8px' }}>搜索失败：检查网络后再试。</p>}
      <div className="match-actions">
        {state !== 'done' && (
          <button type="button" className="btn btn-s btn-p" disabled={state === 'loading'} onClick={() => void search()}>
            {state === 'loading' && <Spinner />}按标题搜索
          </button>
        )}
        <button type="button" className="btn btn-s" onClick={onManual}>手动填写</button>
        <button type="button" className="btn btn-s" onClick={() => void api.library.update(p.id, { title: p.title })}>信息没问题</button>
      </div>
    </section>
  )
}

interface FieldProps {
  label: string
  value: string
  placeholder?: string
  multiline?: boolean
  rows?: number
  mono?: boolean
  inputMode?: 'numeric'
  inputRef?: React.RefObject<HTMLTextAreaElement | null>
  onCommit: (v: string) => void
}

/** 失去焦点或按回车时保存；按 Esc 放弃修改 */
function Field({ label, value, placeholder, multiline, rows = 2, mono, inputMode, inputRef, onCommit }: FieldProps) {
  const [v, setV] = useState(value)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setV(value)
  }, [value, focused])
  const commit = () => {
    setFocused(false)
    const t = v.trim()
    if (t !== value.trim()) onCommit(t)
  }
  const common = {
    value: v,
    placeholder,
    className: 'inp' + (mono ? ' mono' : ''),
    onFocus: () => setFocused(true),
    onBlur: commit,
    onChange: (e: { target: { value: string } }) => setV(e.target.value),
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        setV(value)
        ;(e.target as HTMLElement).blur()
      }
      if (e.key === 'Enter' && (!multiline || label === '标题')) {
        e.preventDefault()
        ;(e.target as HTMLElement).blur()
      }
    }
  }
  return (
    <label className="field">
      <span className="field-l">{label}</span>
      {multiline ? <textarea ref={inputRef} rows={rows} {...common} /> : <input type="text" inputMode={inputMode} {...common} />}
    </label>
  )
}

function TagEditor({ tags, all, onChange }: { tags: string[]; all: { tag: string; count: number }[]; onChange: (t: string[]) => void }) {
  const [v, setV] = useState('')
  const add = () => {
    const t = v.trim().replace(/^#/, '')
    if (t && !tags.includes(t)) onChange([...tags, t])
    setV('')
  }
  const suggestions = all.filter((t) => !tags.includes(t.tag)).slice(0, 50)
  return (
    <div className="field">
      <label className="field-l" htmlFor="tag-input">标签</label>
      <div className="chips">
        {tags.map((t) => (
          <span key={t} className="chip">
            {t}
            <button type="button" className="chip-x" aria-label={`去掉标签 ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}><Icon name="close" size={12} /></button>
          </span>
        ))}
        <input
          id="tag-input"
          className="tag-input"
          list="tag-suggestions"
          placeholder="+ 标签"
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              add()
            }
            if (e.key === 'Backspace' && !v && tags.length) onChange(tags.slice(0, -1))
          }}
          onBlur={add}
        />
        <datalist id="tag-suggestions">
          {suggestions.map((t) => <option key={t.tag} value={t.tag}>{`${t.count} 篇`}</option>)}
        </datalist>
      </div>
    </div>
  )
}

function nameOf(a: Author): string {
  return [a.given, a.family].filter(Boolean).join(' ')
}

function parseAuthors(s: string): Author[] {
  return s.split(/\s*[,，;；]\s*|\s+and\s+/).map((x) => x.trim()).filter(Boolean).map(splitName)
}

function withId(p: Paper, key: 'doi' | 'arxiv', v: string) {
  const ids = { ...p.identifiers }
  if (v) ids[key] = v
  else delete ids[key]
  return ids
}
