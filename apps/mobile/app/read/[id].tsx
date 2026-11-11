// 阅读器：WebView 里跑 PDF.js（reader-web），这边负责数据：读批注、写批注、存阅读位置。
// 长按选字 → 底部操作面板（五种颜色、下划线、摘录、评论、翻译、问 AI、复制）；点批注 → 改颜色、写评论、翻译、摘录、删除。
// 顶栏：查找、问 AI、更多（跳页、缩放、页面深色、批注列表、笔记、详情）。读到最后一页提示"标为读过"。和桌面的 Reader 对应。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BackHandler, Linking, Pressable, StyleSheet, Text, TextInput, useColorScheme, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { WebView, type WebViewMessageEvent, type WebViewProps } from 'react-native-webview'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { nearEnd, STATUS_LABEL, type Annotation, type AnnotationPatch, type HighlightColor, type PdfRect, type ReadingPosition, type TextQuote } from '@flax/core'
import { quoteBlock } from '@flax/core'
import { app, bump, showNotice } from '../../src/services'
import { pdfFile } from '../../src/platform/files'
import { readerProps } from '../../src/reader'
import { appendToPaperNote, copyText, pageDark, setPageDark, setStatus } from '../../src/actions'
import { Button, Chip, Empty, Field, IconButton } from '../../src/ui/kit'
import { ActionSheet, BottomSheet, Prompt } from '../../src/ui/sheets'
import { SWATCH, useTheme } from '../../src/ui/theme'
import { AiChat } from '../../src/ui/AiChat'
import { TranslateSheet } from '../../src/ui/TranslateSheet'

// react-native-webview 的类组件类型在 TS 7 + React 19 的类型下所有属性都变成 never；运行时没问题，这里给一个正确的类型
const Web = WebView as unknown as React.ComponentType<WebViewProps & { ref?: React.Ref<WebView> }>
const COLORS: { id: HighlightColor; label: string }[] = [
  { id: 'yellow', label: '黄色' },
  { id: 'green', label: '绿色' },
  { id: 'blue', label: '蓝色' },
  { id: 'pink', label: '粉色' },
  { id: 'purple', label: '紫色' }
]
type ListFilter = 'all' | 'highlight' | 'underline' | 'note'
const FILTERS: [ListFilter, string][] = [
  ['all', '全部'],
  ['highlight', '高亮'],
  ['underline', '下划线'],
  ['note', '评论']
]

interface Part {
  page: number
  rects: PdfRect[]
  quote: TextQuote
}
interface FindState {
  current: number
  total: number
  pending: boolean
  notFound?: boolean
}

export default function ReadScreen() {
  const t = useTheme()
  const systemDark = useColorScheme() === 'dark'
  const insets = useSafeAreaInsets()
  const { id, page: jumpPage, anno: jumpAnno } = useLocalSearchParams<{ id: string; page?: string; anno?: string }>()
  const s = app()
  const paper = useMemo(() => s.library.getPaper(id), [id])
  const file = paper ? (paper.files.find((f) => f.role === 'main') ?? paper.files[0]) : undefined
  const web = useRef<WebView>(null)
  const reader = useMemo(readerProps, [])
  const [chrome, setChrome] = useState(true)
  const [page, setPage] = useState<{ page: number; total: number } | null>(null)
  const [selection, setSelection] = useState<Part[] | null>(null)
  const [active, setActive] = useState<Annotation | null>(null)
  /** 写评论：改已有批注的评论，或者给选中的文字新建一条评论批注 */
  const [comment, setComment] = useState<{ anno: Annotation } | { parts: Part[] } | null>(null)
  const [error, setError] = useState('')
  const [list, setList] = useState(false)
  const [listFilter, setListFilter] = useState<ListFilter>('all')
  const [annoMenu, setAnnoMenu] = useState<Annotation | null>(null)
  const [menu, setMenu] = useState(false)
  const [jumping, setJumping] = useState(false)
  const [finding, setFinding] = useState(false)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<FindState | null>(null)
  const [dark, setDark] = useState(() => pageDark(systemDark))
  const [translating, setTranslating] = useState<string | null>(null)
  /** 问 AI 面板：null 关着；字符串是带上的选中文字（空串是不带） */
  const [asking, setAsking] = useState<string | null>(null)
  /** 别的设备上读得更晚：提示一下，点了才跳，不自己跳（和桌面一样） */
  const [elsewhere, setElsewhere] = useState<{ device: string; page: number } | null>(null)
  /** 翻到最后一页：问一次要不要标为读过 */
  const [atEnd, setAtEnd] = useState(false)
  const endOffered = useRef(false)
  const startPage = useRef<number | null>(null)
  const lastPos = useRef<ReadingPosition | null>(null)

  const send = useCallback((m: Record<string, unknown>) => {
    web.current?.injectJavaScript(`window.flaxReader && window.flaxReader.receive(${JSON.stringify(m)}); true;`)
  }, [])
  const annotations = useCallback(() => (paper && file ? s.library.listAnnotations(paper.id).filter((a) => a.fileHash === file.hash) : []), [paper, file])
  const pushAnnotations = useCallback((activeId: string | null = null) => send({ type: 'annotations', annotations: annotations(), active: activeId }), [send, annotations])

  useEffect(() => {
    if (!paper) return
    s.library.updatePaper(paper.id, { lastOpenedAt: new Date().toISOString() })
    s.changed()
    return () => {
      if (lastPos.current) {
        s.library.savePosition(paper.id, lastPos.current, s.deviceName)
        s.changed()
      }
    }
  }, [paper?.id])

  const clearSelection = () => {
    setSelection(null)
    send({ type: 'clearSelection' })
  }
  const closeFind = () => {
    setFinding(false)
    setFound(null)
    send({ type: 'closeFind' })
  }

  // 返回键：先收起选中、批注面板、查找，再退出阅读器
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selection) return clearSelection(), true
      if (active) {
        setActive(null)
        pushAnnotations(null)
        return true
      }
      if (finding) return closeFind(), true
      return false
    })
    return () => sub.remove()
  }, [selection, active, finding])

  if (!paper || !file) return <Empty title="打不开这篇论文" sub="没有 PDF。" />
  const uri = pdfFile(file.hash).uri

  const onMessage = (e: WebViewMessageEvent) => {
    let m: Record<string, unknown>
    try {
      m = JSON.parse(e.nativeEvent.data) as Record<string, unknown>
    } catch {
      return
    }
    switch (m['type']) {
      case 'ready': {
        const pos = paper.readingPosition?.fileHash === file.hash ? paper.readingPosition : null
        send({
          type: 'open',
          url: uri,
          annotations: annotations(),
          position: pos ? { page: pos.page, left: pos.left, top: pos.top, scale: pos.scale } : null,
          jump: jumpPage ? { page: Number(jumpPage), ...(jumpAnno ? { anno: jumpAnno } : {}) } : null,
          dark
        })
        break
      }
      case 'loaded': {
        const total = Number(m['pages'])
        const o = s.library.positionElsewhere(paper.id)
        const mine = paper.readingPosition?.fileHash === file.hash ? paper.readingPosition.page : 1
        if (!jumpPage && o && o.fileHash === file.hash && o.page !== mine && o.page <= total) {
          setElsewhere({ device: o.device, page: o.page })
          setTimeout(() => setElsewhere(null), 8000)
        }
        // 同步过来的论文可能不知道页数：补上，列表里才能显示进度
        if (total && file.pageCount !== total) {
          const p = s.library.getPaper(paper.id)
          if (p) {
            s.library.addFile(paper.id, { ...file, pageCount: total })
            s.changed()
          }
        }
        break
      }
      case 'page': {
        const pg = Number(m['page'])
        const total = Number(m['total'])
        setPage({ page: pg, total })
        if (startPage.current === null) startPage.current = pg
        // 真的往下读了（翻过一页）：未读、待读变成在读
        else if (pg !== startPage.current) {
          const p = s.library.getPaper(paper.id)
          if (p && (p.readingStatus === 'inbox' || p.readingStatus === 'to_read')) {
            s.library.updatePaper(paper.id, { readingStatus: 'reading' })
            s.changed()
          }
          if (p && p.readingStatus !== 'done' && nearEnd(pg, total) && !endOffered.current) {
            endOffered.current = true
            setAtEnd(true)
            setTimeout(() => setAtEnd(false), 10000)
          }
        }
        break
      }
      case 'position': {
        // 滚动时只存本机的位置；会同步的"在哪台设备读到第几页"离开阅读器时再记一次，免得每翻一页都同步
        const pos = { fileHash: file.hash, page: Number(m['page']), left: Number(m['left']), top: Number(m['top']), scale: String(m['scale']), updatedAt: new Date().toISOString() }
        lastPos.current = pos
        s.library.savePosition(paper.id, pos)
        bump('library')
        break
      }
      case 'selection':
        setActive(null)
        setSelection((m['parts'] as Part[] | null) ?? null)
        break
      case 'tapAnno': {
        const a = s.library.getAnnotation(String(m['id']))
        if (a) {
          setSelection(null)
          setActive(a)
          pushAnnotations(a.id)
        }
        break
      }
      case 'tap':
        if (active) {
          setActive(null)
          pushAnnotations(null)
        } else setChrome((c) => !c)
        break
      case 'find':
        setFound({ current: Number(m['current']), total: Number(m['total']), pending: !!m['pending'], ...(m['notFound'] ? { notFound: true } : {}) })
        break
      case 'link': {
        // 论文里的外部链接（参考文献的 DOI、项目主页）：交给浏览器
        const url = String(m['url'])
        if (/^(https?|mailto):/i.test(url)) Linking.openURL(url).catch(() => showNotice('打不开这个链接'))
        break
      }
      case 'error':
        console.warn('[reader]', m['message'])
        if (!page) setError(String(m['message']))
        break
    }
  }

  const addFromSelection = (color: HighlightColor, type: Annotation['type'] = 'highlight', commentText?: string, parts = selection): Annotation[] => {
    if (!parts) return []
    const made = parts.map((p) => s.library.addAnnotation({ paperId: paper.id, fileHash: file.hash, type, origin: 'select', color, page: p.page, target: { rects: p.rects, quote: p.quote }, ...(commentText ? { comment: commentText } : {}) }))
    clearSelection()
    pushAnnotations()
    s.changed()
    return made
  }

  const toNote = (as: Annotation[]) => appendToPaperNote(paper.id, as.map((a) => quoteBlock(a.target.quote.exact, a.page + 1, a.id, a.comment)).join('\n\n'))

  const copy = (text: string) => {
    clearSelection()
    void copyText(text)
  }

  const updateAnno = (a: Annotation, patch: AnnotationPatch) => {
    const next = s.library.updateAnnotation(a.id, patch)
    if (active?.id === a.id) setActive(next)
    pushAnnotations(active?.id === a.id ? next.id : (active?.id ?? null))
    s.changed()
  }
  const removeAnno = (a: Annotation) => {
    s.library.removeAnnotation(a.id)
    if (active?.id === a.id) setActive(null)
    pushAnnotations(null)
    s.changed()
    showNotice('删掉了一条批注', {
      action: {
        label: '撤销',
        run: () => {
          s.library.restoreAnnotation(a.id)
          pushAnnotations()
          s.changed()
        }
      }
    })
  }

  const selText = selection ? selection.map((p) => p.quote.exact).join(' ') : ''
  const all = list ? annotations().sort((a, b) => a.page - b.page || (b.target.rects[0]?.[1] ?? 0) - (a.target.rects[0]?.[1] ?? 0)) : []
  const shownList = listFilter === 'all' ? all : listFilter === 'note' ? all.filter((a) => a.type === 'note' || !!a.comment) : all.filter((a) => a.type === listFilter)
  const annotatedPages = jumping ? [...new Set(annotations().map((a) => a.page + 1))].sort((a, b) => a - b) : []

  return (
    <View style={{ flex: 1, backgroundColor: t.desk }}>
      <Web
        ref={web}
        {...reader}
        domStorageEnabled
        setSupportMultipleWindows={false}
        onMessage={onMessage}
        style={{ flex: 1, backgroundColor: t.desk, marginTop: insets.top }}
        textZoom={100}
        overScrollMode="never"
      />

      {chrome || finding ? (
        <View style={[styles.top, { paddingTop: insets.top, backgroundColor: t.bg, borderBottomColor: t.line }]}>
          {finding ? (
            <>
              <IconButton icon="back" label="关闭查找" onPress={closeFind} />
              <TextInput
                autoFocus
                value={query}
                onChangeText={(q) => {
                  setQuery(q)
                  send({ type: 'find', query: q })
                }}
                onSubmitEditing={() => send({ type: 'find', query, again: true })}
                blurOnSubmit={false}
                returnKeyType="search"
                placeholder="在这篇论文里查找"
                placeholderTextColor={t.placeholder}
                accessibilityLabel="查找"
                style={{ flex: 1, color: t.text, fontSize: 16, paddingVertical: 8 }}
              />
              <Text style={{ color: found?.notFound ? t.danger : t.sub, fontSize: 13, minWidth: 44, textAlign: 'right' }} accessibilityLiveRegion="polite">
                {!query.trim() || !found ? '' : found.notFound ? '没找到' : found.total ? `${found.current}/${found.total}` : found.pending ? '…' : ''}
              </Text>
              <IconButton icon="up" label="上一个" onPress={() => send({ type: 'find', query, again: true, previous: true })} />
              <IconButton icon="down" label="下一个" onPress={() => send({ type: 'find', query, again: true })} />
            </>
          ) : (
            <>
              <IconButton icon="back" label="返回" onPress={() => router.back()} />
              <Text numberOfLines={1} style={{ flex: 1, color: t.text, fontSize: 16, fontWeight: '500' }}>
                {paper.title}
              </Text>
              <IconButton icon="search" label="查找" onPress={() => setFinding(true)} />
              <IconButton icon="ai" label="问 AI" onPress={() => setAsking('')} />
              <IconButton icon="more" label="更多" onPress={() => setMenu(true)} />
            </>
          )}
        </View>
      ) : null}
      {page && !selection && !active ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`第 ${page.page} 页，共 ${page.total} 页，点一下跳页`} onPress={() => setJumping(true)} style={[styles.pill, { bottom: insets.bottom + 20 }]}>
          <Text style={{ color: '#fff', fontSize: 13 }}>
            第 {page.page} / {page.total} 页
          </Text>
        </Pressable>
      ) : null}
      {elsewhere || atEnd ? (
        <View style={[styles.banner, { bottom: insets.bottom + 60, backgroundColor: t.dark ? '#E6E6E6' : '#2B2B2E' }]}>
          <Text style={{ color: t.dark ? '#111' : '#fff', fontSize: 14, flex: 1 }}>{elsewhere ? `在 ${elsewhere.device} 上读到第 ${elsewhere.page} 页` : '读到最后了'}</Text>
          <Text
            accessibilityRole="button"
            onPress={() => {
              if (elsewhere) {
                send({ type: 'goto', page: elsewhere.page })
                setElsewhere(null)
              } else {
                setStatus(paper.id, 'done')
                setAtEnd(false)
              }
            }}
            style={{ color: t.dark ? '#155DFC' : '#8AB4FF', fontWeight: '600', fontSize: 14, padding: 8 }}
          >
            {elsewhere ? '跳过去' : `标为${STATUS_LABEL.done}`}
          </Text>
        </View>
      ) : null}
      {error ? (
        <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg }]}>
          <Empty title="PDF 打不开" sub={error}>
            <Button title="返回" kind="tonal" onPress={() => router.back()} style={{ marginTop: 12 }} />
          </Empty>
        </View>
      ) : null}

      {selection ? (
        <Sheet bottom={insets.bottom}>
          <View style={styles.swatches}>
            {COLORS.map((c) => (
              <Pressable key={c.id} accessibilityRole="button" accessibilityLabel={`${c.label}高亮`} onPress={() => addFromSelection(c.id)} style={styles.swatchBtn}>
                <View style={[styles.swatch, { backgroundColor: SWATCH[c.id] }]} />
              </Pressable>
            ))}
            <Pressable accessibilityRole="button" accessibilityLabel="下划线" onPress={() => addFromSelection('blue', 'underline')} style={styles.swatchBtn}>
              <Text style={{ color: t.text, fontSize: 20, textDecorationLine: 'underline', fontWeight: '600' }}>U</Text>
            </Pressable>
          </View>
          <View style={styles.actions}>
            <Action label="摘录" onPress={() => toNote(addFromSelection('yellow'))} />
            <Action label="评论" onPress={() => setComment({ parts: selection })} />
            <Action
              label="翻译"
              onPress={() => {
                setTranslating(selText)
                clearSelection()
              }}
            />
            <Action
              label="问 AI"
              onPress={() => {
                setAsking(selText)
                clearSelection()
              }}
            />
            <Action label="复制" onPress={() => copy(selText)} />
          </View>
        </Sheet>
      ) : null}

      {active ? (
        <Sheet bottom={insets.bottom}>
          <Text numberOfLines={3} style={{ color: t.body, fontSize: 14, lineHeight: 20, paddingHorizontal: 4 }}>
            {active.target.quote.exact}
          </Text>
          {active.comment ? <Text style={{ color: t.text, fontSize: 15, paddingHorizontal: 4 }}>💬 {active.comment}</Text> : null}
          <View style={styles.swatches}>
            {COLORS.map((c) => (
              <Pressable key={c.id} accessibilityRole="button" accessibilityLabel={c.label} accessibilityState={{ selected: active.color === c.id && active.type === 'highlight' }} onPress={() => updateAnno(active, { color: c.id, type: 'highlight' })} style={styles.swatchBtn}>
                <View style={[styles.swatch, { backgroundColor: SWATCH[c.id] }, active.color === c.id && active.type === 'highlight' ? { borderWidth: 3, borderColor: t.text } : null]} />
              </Pressable>
            ))}
            <Pressable accessibilityRole="button" accessibilityLabel="改成下划线" accessibilityState={{ selected: active.type === 'underline' }} onPress={() => updateAnno(active, { type: 'underline' })} style={styles.swatchBtn}>
              <Text style={{ color: active.type === 'underline' ? t.accentText : t.text, fontSize: 20, textDecorationLine: 'underline', fontWeight: '600' }}>U</Text>
            </Pressable>
          </View>
          <View style={styles.actions}>
            <Action label={active.comment ? '改评论' : '评论'} onPress={() => setComment({ anno: active })} />
            <Action label="摘录" onPress={() => toNote([active])} />
            <Action label="翻译" onPress={() => setTranslating(active.target.quote.exact)} />
            <Action label="复制" onPress={() => copy(active.target.quote.exact)} />
            <Action label="删除" danger onPress={() => removeAnno(active)} />
          </View>
        </Sheet>
      ) : null}

      <Prompt
        open={!!comment}
        title="评论"
        label="评论"
        placeholder="写点什么"
        multiline
        allowEmpty={!!comment && 'anno' in comment}
        initial={comment && 'anno' in comment ? (comment.anno.comment ?? '') : ''}
        onClose={() => setComment(null)}
        onSubmit={(text) => {
          if (!comment) return
          if ('anno' in comment) updateAnno(comment.anno, { comment: text })
          else addFromSelection('yellow', 'note', text, comment.parts)
        }}
      />

      {translating !== null ? <TranslateSheet text={translating} paperId={paper.id} onClose={() => setTranslating(null)} /> : null}

      {asking !== null ? (
        <AiChat
          paperId={paper.id}
          quote={asking || null}
          onClose={() => setAsking(null)}
          onCite={(pg) => {
            setAsking(null)
            send({ type: 'goto', page: pg })
          }}
        />
      ) : null}

      <ActionSheet
        open={menu}
        onClose={() => setMenu(false)}
        actions={[
          { label: '跳到第几页', icon: 'page', onPress: () => setJumping(true) },
          { label: '批注列表', icon: 'list', onPress: () => setList(true) },
          { label: '放大', icon: 'plus', onPress: () => send({ type: 'zoom', dir: 1 }) },
          { label: '缩小', icon: 'minus', onPress: () => send({ type: 'zoom', dir: -1 }) },
          { label: '适合宽度', icon: 'fit', onPress: () => send({ type: 'zoom', dir: 0 }) },
          {
            label: '页面深色显示',
            icon: 'moon',
            checked: dark,
            onPress: () => {
              setDark(!dark)
              setPageDark(!dark)
              send({ type: 'dark', on: !dark })
            }
          },
          {
            label: '这篇的笔记',
            icon: 'notes',
            onPress: () => {
              const n = s.notes.forPaper(paper.id)[0] ?? s.notes.create({ paperId: paper.id, title: paper.title })
              s.notesChanged()
              router.push(`/note/${encodeURIComponent(n.id)}`)
            }
          },
          { label: '论文详情', icon: 'info', onPress: () => router.push(`/paper/${paper.id}`) }
        ]}
      />

      <JumpSheet
        open={jumping}
        total={page?.total ?? 0}
        current={page?.page ?? 1}
        annotated={annotatedPages}
        onClose={() => setJumping(false)}
        onJump={(pg) => {
          setJumping(false)
          send({ type: 'goto', page: pg })
        }}
      />

      <BottomSheet open={list && !annoMenu} onClose={() => setList(false)} title={`批注 · ${all.length}`} maxHeight="75%">
        <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 20, paddingBottom: 8 }}>
          {FILTERS.map(([k, label]) => (
            <Chip key={k} label={label} selected={listFilter === k} onPress={() => setListFilter(k)} />
          ))}
        </View>
        {shownList.length === 0 ? <Text style={{ color: t.sub, paddingHorizontal: 20, paddingVertical: 12 }}>{all.length ? '这一类没有批注。' : '还没有批注。长按文字选中，再选一个颜色。'}</Text> : null}
        {shownList.map((a) => (
          <Pressable
            key={a.id}
            accessibilityHint="长按有更多操作"
            onPress={() => {
              setList(false)
              send({ type: 'goto', page: a.page + 1, anno: a.id })
            }}
            onLongPress={() => setAnnoMenu(a)}
            android_ripple={{ color: t.line }}
            style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 20, paddingVertical: 10 }}
          >
            <View style={{ width: 4, borderRadius: 2, backgroundColor: a.type === 'note' ? t.chipLine : SWATCH[a.color] }} />
            <View style={{ flex: 1 }}>
              <Text numberOfLines={3} style={{ color: t.body, fontSize: 15, textDecorationLine: a.type === 'underline' ? 'underline' : 'none' }}>
                {a.target.quote.exact}
              </Text>
              <Text style={{ color: t.sub, fontSize: 13 }}>
                第 {a.page + 1} 页{a.comment ? ` · ${a.comment}` : ''}
              </Text>
            </View>
            <IconButton icon="more" label="批注操作" onPress={() => setAnnoMenu(a)} color={t.sub} />
          </Pressable>
        ))}
      </BottomSheet>
      <ActionSheet
        open={!!annoMenu}
        onClose={() => setAnnoMenu(null)}
        title={annoMenu ? `第 ${annoMenu.page + 1} 页` : undefined}
        sub={annoMenu?.target.quote.exact.slice(0, 120)}
        actions={
          annoMenu
            ? [
                {
                  label: '跳过去',
                  icon: 'page',
                  onPress: () => {
                    setList(false)
                    send({ type: 'goto', page: annoMenu.page + 1, anno: annoMenu.id })
                  }
                },
                { label: annoMenu.comment ? '改评论' : '写评论', icon: 'edit', onPress: () => setComment({ anno: annoMenu }) },
                { label: '摘录到笔记', icon: 'notes', onPress: () => toNote([annoMenu]) },
                { label: '复制', icon: 'copy', onPress: () => void copyText(annoMenu.target.quote.exact) },
                {
                  label: '删除',
                  icon: 'trash',
                  danger: true,
                  onPress: () => {
                    // 关掉列表：底部的"撤销"提示在面板下面会被挡住
                    setList(false)
                    removeAnno(annoMenu)
                  }
                }
              ]
            : []
        }
      />
    </View>
  )
}

/** 跳页：输入页码，或者点有批注的那几页 */
function JumpSheet({ open, total, current, annotated, onClose, onJump }: { open: boolean; total: number; current: number; annotated: number[]; onClose: () => void; onJump: (page: number) => void }) {
  const t = useTheme()
  const [v, setV] = useState('')
  useEffect(() => {
    if (open) setV('')
  }, [open])
  const n = Number(v)
  const ok = Number.isInteger(n) && n >= 1 && n <= total
  return (
    <BottomSheet open={open} onClose={onClose} title="跳到第几页">
      <View style={{ paddingHorizontal: 20, gap: 14 }}>
        <Field label={`页码（1–${total || '?'}）`} value={v} onChangeText={setV} keyboardType="number-pad" placeholder={`现在第 ${current} 页`} onSubmitEditing={() => ok && onJump(n)} returnKeyType="go" autoFocus error={v && !ok ? `只有 ${total} 页` : undefined} />
        <Button title="跳过去" onPress={() => onJump(n)} disabled={!ok} />
        {annotated.length ? (
          <>
            <Text style={{ color: t.sub, fontSize: 13 }}>有批注的页</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {annotated.map((p) => (
                <Chip key={p} label={String(p)} selected={p === current} onPress={() => onJump(p)} />
              ))}
            </View>
          </>
        ) : null}
      </View>
    </BottomSheet>
  )
}

function Sheet({ children, bottom }: { children: React.ReactNode; bottom: number }) {
  const t = useTheme()
  return <View style={[styles.sheet, { backgroundColor: t.bg, paddingBottom: bottom + 16 }]}>{children}</View>
}

function Action({ label, onPress, danger }: { label: string; onPress: () => void; danger?: boolean }) {
  const t = useTheme()
  return (
    <Pressable accessibilityRole="button" onPress={onPress} android_ripple={{ color: t.line }} style={[styles.action, { backgroundColor: t.surface }]}>
      <Text style={{ color: danger ? t.danger : t.text, fontSize: 15, fontWeight: '500' }}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  top: { position: 'absolute', left: 0, right: 0, top: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth, elevation: 2 },
  banner: { position: 'absolute', left: 12, right: 12, minHeight: 48, borderRadius: 8, paddingLeft: 16, paddingRight: 8, flexDirection: 'row', alignItems: 'center', elevation: 6 },
  pill: { position: 'absolute', alignSelf: 'center', height: 32, paddingHorizontal: 14, borderRadius: 16, backgroundColor: 'rgba(30,30,30,0.72)', justifyContent: 'center' },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 12, paddingTop: 16, gap: 10, elevation: 12 },
  swatches: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 4 },
  swatchBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  swatch: { width: 28, height: 28, borderRadius: 14 },
  actions: { flexDirection: 'row', gap: 6 },
  action: { flex: 1, height: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }
})
