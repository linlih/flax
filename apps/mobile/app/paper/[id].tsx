// 论文详情：接着读、状态、需要匹配、可以改的信息、文件夹和标签、批注、笔记、文件。
// 和桌面的 PaperDetail 对应；信息的每一项点开改，失去焦点保存。
import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, type TextInputInstance, View } from 'react-native'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { addedLabel, authorLine, formatCitation, MATCH_HINT, progress, sizeLabel, SOURCE_LABEL, splitName, STATUS_LABEL, STATUSES, suggestFileName, TAG_COLOR_LABEL, TAG_COLORS, tagColorMap, toBibTeX, toRIS, type Author, type Candidate, type CiteStyle, type Paper, type PaperMeta, type PaperPatch, type TagColor } from '@flax/core'
import { app, showNotice, useVersion } from '../../src/services'
import { hasPdf } from '../../src/platform/files'
import { copyText, removePaper, setStatus, shareTextFile } from '../../src/actions'
import { Button, Chip, Empty, IconButton, Section } from '../../src/ui/kit'
import { ActionSheet, OptionRow, BottomSheet, Prompt } from '../../src/ui/sheets'
import { SWATCH, TAG, useTheme } from '../../src/ui/theme'

const ROLE_LABEL = { main: '主文件', preprint: '预印本', published: '正式版', supplement: '补充材料', other: '其他版本' } as Record<string, string>
const STYLES: [CiteStyle, string][] = [
  ['apa', 'APA'],
  ['gbt7714', 'GB/T 7714'],
  ['bibtex', 'BibTeX']
]

export default function PaperScreen() {
  const t = useTheme()
  const { id } = useLocalSearchParams<{ id: string }>()
  const v = useVersion('library')
  const nv = useVersion('notes')
  useVersion('sync')
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState(false)
  const [cite, setCite] = useState(false)
  const [tagDraft, setTagDraft] = useState<string | null>(null)
  const [tagMenu, setTagMenu] = useState<string | null>(null)
  const [tagRename, setTagRename] = useState<string | null>(null)
  const [tagColor, setTagColor] = useState<string | null>(null)
  const [focusTitle, setFocusTitle] = useState(0)

  const s = app()
  const paper = useMemo(() => s.library.getPaper(id), [id, v])
  const annotations = useMemo(() => (paper ? s.library.listAnnotations(paper.id).sort((a, b) => a.page - b.page || a.createdAt.localeCompare(b.createdAt)) : []), [paper])
  const notes = useMemo(() => (paper ? s.notes.forPaper(paper.id) : []), [paper, nv])
  const allTags = useMemo(() => s.library.listTags(), [v])
  const tagColors = useMemo(() => tagColorMap(allTags), [allTags])
  const folders = useMemo(() => s.library.listFolders(), [v])

  if (!paper) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg }}>
        <Stack.Screen options={{ title: '' }} />
        <Empty title="这篇论文不在了" sub="可能删掉了，或者在别的设备上删掉了。" />
      </View>
    )
  }

  const update = (patch: PaperPatch) => {
    s.library.updatePaper(paper.id, patch)
    s.changed()
  }
  const main = paper.files.find((f) => f.role === 'main') ?? paper.files[0]
  const local = main ? hasPdf(main.hash) : false
  const elsewhere = s.library.positionElsewhere(paper.id)
  const page = paper.readingPosition?.page
  const downloading = s.importer.downloadingIds().includes(paper.id)
  const matching = s.importer.importingIds().includes(paper.id)
  const hasIds = !!(paper.identifiers.arxiv || paper.identifiers.doi)
  const pr = progress(paper)

  const open = async () => {
    if (!main) {
      if (s.importer.startDownload(paper.id)) showNotice('正在从 arXiv 下载 PDF')
      else showNotice('这篇论文没有 PDF。可以从"添加"里选一个 PDF，名字或 DOI 对得上会自动配给它。')
      s.changed()
      return
    }
    if (!local) {
      if (!s.sync.enabled) return showNotice('PDF 不在这台手机上。开启同步后可以从云端下载。')
      setBusy(true)
      try {
        const ok = await s.sync.download(main.hash)
        if (!ok) return showNotice('云端也没有这个 PDF：可能那台电脑还没传上去。')
      } catch (e) {
        return showNotice(`下载失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setBusy(false)
      }
    }
    router.push(`/read/${paper.id}`)
  }

  const readLabel = !main ? (paper.identifiers.arxiv ? (downloading ? '正在下载 PDF…' : '从 arXiv 下载 PDF') : '没有 PDF') : !local ? `下载 PDF 并打开${main.size ? `（${sizeLabel(main.size)}）` : ''}` : page ? `接着读 · 第 ${page} 页` : '开始读'

  const addTag = () => {
    const tag = (tagDraft ?? '').trim().replace(/^#/, '')
    setTagDraft(null)
    if (tag && !paper.tags.includes(tag)) update({ tags: [...paper.tags, tag] })
  }
  const suggestions = tagDraft !== null ? allTags.filter((x) => !paper.tags.includes(x.tag) && x.tag.toLowerCase().includes(tagDraft.trim().toLowerCase())).slice(0, 6) : []

  const newNote = () => {
    const n = s.notes.create({ title: paper.title, paperId: paper.id })
    s.notesChanged()
    router.push(`/note/${encodeURIComponent(n.id)}`)
  }

  const retry = async () => {
    try {
      await s.importer.retry(paper.id)
    } catch (e) {
      showNotice(`没查到：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: '', headerRight: () => <IconButton icon="more" label="更多" onPress={() => setMenu(true)} /> }} />
      <View style={styles.head}>
        <Text selectable style={[styles.title, { color: t.text }]}>
          {paper.title}
        </Text>
        <Text selectable style={{ color: t.sub, fontSize: 15 }}>
          {[authorLine(paper, 3), [paper.venue, paper.year].filter(Boolean).join(' ')].filter(Boolean).join(' · ')}
        </Text>
      </View>

      <View style={{ paddingHorizontal: 16, gap: 8, marginTop: 14 }}>
        <Button title={readLabel} onPress={() => void open()} busy={busy} disabled={(!main && !paper.identifiers.arxiv) || downloading} />
        {elsewhere ? <Text style={{ color: t.sub, fontSize: 13, textAlign: 'center' }}>在 {elsewhere.device} 上读到第 {elsewhere.page} 页</Text> : null}
      </View>

      <View style={styles.chips} accessibilityLabel="阅读状态">
        {STATUSES.map((st) => (
          <Chip key={st} label={STATUS_LABEL[st]} selected={paper.readingStatus === st} onPress={() => setStatus(paper.id, st)} />
        ))}
      </View>
      {paper.readingStatus === 'reading' && (pr || paper.lastOpenedAt) ? <Text style={{ color: t.sub, fontSize: 13, paddingHorizontal: 16, marginTop: 8 }}>{[pr && `读到第 ${pr.page} / ${pr.total} 页`, paper.lastOpenedAt && `${addedLabel(paper.lastOpenedAt)}打开过`].filter(Boolean).join(' · ')}</Text> : null}

      {paper.needsMatch || matching ? <MatchCard paper={paper} busy={matching} onManual={() => setFocusTitle((x) => x + 1)} /> : null}

      <View style={{ marginTop: 16 }}>
        <Section title="批注" action={annotations.length ? <Text style={{ color: t.sub, fontSize: 14, padding: 8 }}>{annotations.length}</Text> : undefined}>
          {annotations.length === 0 ? <Text style={[styles.muted, { color: t.sub }]}>还没有批注。阅读时长按选中文字就能高亮、划线或写评论。</Text> : null}
          {annotations.map((a) => (
            <Pressable key={a.id} onPress={() => (local ? router.push(`/read/${paper.id}?page=${a.page + 1}&anno=${a.id}`) : void open())} android_ripple={{ color: t.line }} style={styles.anno}>
              <View style={[styles.bar, { backgroundColor: a.type === 'note' ? t.chipLine : SWATCH[a.color] }]} />
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={{ color: t.body, fontSize: 15, lineHeight: 21, textDecorationLine: a.type === 'underline' ? 'underline' : 'none' }} numberOfLines={4}>
                  {a.target.quote.exact}
                </Text>
                <Text style={{ color: t.sub, fontSize: 13 }} numberOfLines={2}>
                  第 {a.page + 1} 页{a.comment ? ` · ${a.comment}` : ''}
                </Text>
              </View>
            </Pressable>
          ))}
        </Section>

        <Section title="笔记" action={<Text accessibilityRole="button" onPress={newNote} style={{ color: t.accentText, fontSize: 15, fontWeight: '500', padding: 8 }}>新建</Text>}>
          {notes.length === 0 ? <Text style={[styles.muted, { color: t.sub }]}>还没有这篇论文的笔记。</Text> : null}
          {notes.map((n) => (
            <Pressable key={n.id} onPress={() => router.push(`/note/${encodeURIComponent(n.id)}`)} style={[styles.noteCard, { backgroundColor: t.surface }]}>
              <Text style={{ color: t.text, fontWeight: '500', fontSize: 15 }}>{n.title}</Text>
              {n.excerpt ? (
                <Text style={{ color: t.sub, fontSize: 13 }} numberOfLines={2}>
                  {n.excerpt}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </Section>

        <Section title="整理">
          <Text style={[styles.label, { color: t.sub }]}>文件夹</Text>
          <View style={styles.chipsIn}>
            {folders.length === 0 ? <Text style={{ color: t.sub, fontSize: 14 }}>还没有文件夹。在文献库右上角"更多 → 文件夹"里新建。</Text> : null}
            {folders.map((f) => {
              const on = paper.folderIds.includes(f.id)
              return <Chip key={f.id} label={f.name} selected={on} onPress={() => update({ folderIds: on ? paper.folderIds.filter((x) => x !== f.id) : [...paper.folderIds, f.id] })} />
            })}
          </View>
          <Text style={[styles.label, { color: t.sub }]}>标签</Text>
          <View style={styles.chipsIn}>
            {paper.tags.map((tag) => (
              <Chip key={tag} label={tag} color={tagColors.has(tag) ? TAG[tagColors.get(tag)!] : undefined} onPress={() => setTagMenu(tag)} onLongPress={() => setTagMenu(tag)} />
            ))}
            {tagDraft === null ? (
              <Chip label="＋ 标签" dashed onPress={() => setTagDraft('')} />
            ) : (
              <TextInput
                autoFocus
                value={tagDraft}
                onChangeText={setTagDraft}
                onSubmitEditing={addTag}
                onBlur={addTag}
                placeholder="标签名"
                placeholderTextColor={t.placeholder}
                accessibilityLabel="新标签"
                returnKeyType="done"
                style={[styles.tagInput, { borderColor: t.accent, color: t.text }]}
              />
            )}
          </View>
          {suggestions.length ? (
            <View style={[styles.chipsIn, { marginTop: -4 }]}>
              {suggestions.map((x) => (
                <Chip
                  key={x.tag}
                  label={`${x.tag} · ${x.count}`}
                  dashed
                  onPress={() => {
                    setTagDraft(null)
                    update({ tags: [...paper.tags, x.tag] })
                  }}
                />
              ))}
            </View>
          ) : null}
        </Section>

        <Section
          title="信息"
          action={
            hasIds ? (
              <Text accessibilityRole="button" accessibilityState={{ disabled: matching }} onPress={matching ? undefined : () => void retry()} style={{ color: matching ? t.placeholder : t.accentText, fontSize: 15, fontWeight: '500', padding: 8 }}>
                重新获取
              </Text>
            ) : undefined
          }
        >
          <Text style={{ color: t.sub, fontSize: 13, paddingHorizontal: 16, marginTop: -4, marginBottom: 4 }}>{SOURCE_LABEL[paper.metadataSource]}</Text>
          <EditField label="标题" value={paper.title} multiline focusKey={focusTitle} onCommit={(x) => x && update({ title: x })} />
          <EditField label="作者" value={paper.authors.map(nameOf).join(', ')} placeholder="用逗号分隔，例如 Ada Lovelace, Alan Turing" onCommit={(x) => update({ authors: parseAuthors(x) })} />
          <EditField
            label="年份"
            value={paper.year ? String(paper.year) : ''}
            placeholder="例如 2024"
            numeric
            onCommit={(x) => {
              const y = Number(x)
              update({ year: x && Number.isInteger(y) && y > 1000 && y < 3000 ? y : undefined })
            }}
          />
          <EditField label="发表" value={paper.venue ?? ''} placeholder="期刊或会议" onCommit={(x) => update({ venue: x || undefined })} />
          <EditField label="DOI" value={paper.identifiers.doi ?? ''} placeholder="10.1145/…" mono onCommit={(x) => update({ identifiers: withId(paper, 'doi', x.toLowerCase()) })} />
          <EditField label="arXiv" value={paper.identifiers.arxiv ?? ''} placeholder="2401.01234" mono onCommit={(x) => update({ identifiers: withId(paper, 'arxiv', x) })} />
          <EditField label="摘要" value={paper.abstract ?? ''} multiline placeholder="没有摘要" onCommit={(x) => update({ abstract: x || undefined })} />
        </Section>

        {paper.files.length ? (
          <Section title={`文件 · ${paper.files.length} 个`}>
            {paper.files.map((f, i) => (
              <View key={f.hash} style={{ paddingHorizontal: 16, paddingVertical: 8, gap: 2 }}>
                <Text style={{ color: t.text, fontSize: 15, fontWeight: '500' }}>{i === 0 ? '主文件' : (ROLE_LABEL[f.role] ?? '其他版本')}</Text>
                <Text style={{ color: t.sub, fontSize: 13 }} numberOfLines={2}>
                  {[f.originalName, f.pageCount && `${f.pageCount} 页`, f.size && sizeLabel(f.size), hasPdf(f.hash) ? '在这台手机上' : '在云端'].filter(Boolean).join(' · ')}
                </Text>
              </View>
            ))}
            <View style={{ paddingHorizontal: 16, paddingVertical: 8, gap: 2 }}>
              <Text style={{ color: t.sub, fontSize: 13 }}>导出文件名</Text>
              <Text selectable style={{ color: t.body, fontSize: 14 }}>
                {suggestFileName(paper)}
              </Text>
            </View>
          </Section>
        ) : null}
        <Text style={{ color: t.sub, fontSize: 13, paddingHorizontal: 16, marginTop: 8 }}>{addedLabel(paper.addedAt)}加入</Text>
      </View>

      <ActionSheet
        open={menu}
        onClose={() => setMenu(false)}
        actions={[
          { label: '复制引用', icon: 'copy', onPress: () => setCite(true) },
          { label: '导出 BibTeX', icon: 'share', onPress: () => void shareTextFile(`${suggestFileName(paper).replace(/\.pdf$/i, '')}.bib`, toBibTeX([paper]), 'application/x-bibtex', '导出参考文献') },
          { label: '导出 RIS', icon: 'share', onPress: () => void shareTextFile(`${suggestFileName(paper).replace(/\.pdf$/i, '')}.ris`, toRIS([paper]), 'application/x-research-info-systems', '导出参考文献') },
          {
            label: '删除论文',
            icon: 'trash',
            danger: true,
            onPress: () => {
              router.back()
              removePaper(paper.id)
            }
          }
        ]}
      />
      <ActionSheet open={cite} onClose={() => setCite(false)} title="复制引用" actions={STYLES.map(([style, name]) => ({ label: name, onPress: () => void copyText(formatCitation(paper, style), `已复制 ${name} 引用`) }))} />
      <ActionSheet
        open={!!tagMenu}
        onClose={() => setTagMenu(null)}
        title={tagMenu ? `标签：${tagMenu}` : undefined}
        actions={[
          { label: '从这篇论文去掉', icon: 'close', onPress: () => tagMenu && update({ tags: paper.tags.filter((x) => x !== tagMenu) }) },
          { label: '重命名（所有论文）', icon: 'edit', onPress: () => setTagRename(tagMenu) },
          { label: '颜色', icon: 'tag', onPress: () => setTagColor(tagMenu) },
          {
            label: '只看这个标签的论文',
            icon: 'library',
            onPress: () => tagMenu && router.dismissTo({ pathname: '/', params: { tag: tagMenu } })
          }
        ]}
      />
      <Prompt
        open={!!tagRename}
        title="重命名标签"
        label="新名字"
        initial={tagRename ?? ''}
        onClose={() => setTagRename(null)}
        onSubmit={(to) => {
          if (!tagRename || to === tagRename) return
          const n = s.library.renameTag(tagRename, to.replace(/^#/, ''))
          s.changed()
          showNotice(`改了 ${n} 篇论文上的标签`)
        }}
      />
      <BottomSheet open={!!tagColor} onClose={() => setTagColor(null)} title={tagColor ? `"${tagColor}"的颜色` : undefined}>
        <OptionRow
          label="不设颜色"
          checked={!!tagColor && !tagColors.has(tagColor)}
          onPress={() => {
            if (tagColor) s.library.setTagColor(tagColor, null)
            s.changed()
            setTagColor(null)
          }}
        />
        {TAG_COLORS.map((c: TagColor) => (
          <OptionRow
            key={c}
            label={TAG_COLOR_LABEL[c]}
            checked={!!tagColor && tagColors.get(tagColor) === c}
            icon={<View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: TAG[c] }} />}
            onPress={() => {
              if (tagColor) s.library.setTagColor(tagColor, c)
              s.changed()
              setTagColor(null)
            }}
          />
        ))}
      </BottomSheet>
    </ScrollView>
  )
}

/** 需要匹配：按标题搜候选，选一个；或者手动改；或者确认信息没问题 */
function MatchCard({ paper: p, busy, onManual }: { paper: Paper; busy: boolean; onManual: () => void }) {
  const t = useTheme()
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [list, setList] = useState<Candidate[]>([])
  useEffect(() => setState('idle'), [p.id])
  const s = app()

  const search = async () => {
    setState('loading')
    try {
      setList(await s.importer.candidates(p.id))
      setState('done')
    } catch {
      setState('error')
    }
  }
  const use = (c: Candidate) => {
    const { similarity: _s, ...meta } = c
    s.importer.applyCandidate(p.id, meta as PaperMeta)
    showNotice('信息已更新')
  }

  return (
    <View style={[styles.match, { backgroundColor: t.surface }]} accessibilityLiveRegion="polite">
      {busy ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <ActivityIndicator size="small" color={t.sub} />
          <Text style={{ color: t.text, fontSize: 15, fontWeight: '500' }}>正在识别标题和作者…</Text>
        </View>
      ) : (
        <>
          <Text style={{ color: t.accentText, fontSize: 13, fontWeight: '600' }}>需要匹配</Text>
          <Text style={{ color: t.text, fontSize: 15, lineHeight: 21 }}>
            {p.matchIssue ? MATCH_HINT[p.matchIssue] : '信息可能不完整'}。{state === 'done' ? (list.length ? '按标题搜到这些，选一个：' : '按标题没有搜到相近的论文。') : '可以按标题搜索，或者手动填写。'}
          </Text>
          {state === 'done'
            ? list.map((c, i) => (
                <Pressable key={i} accessibilityRole="button" accessibilityHint="用这条信息" onPress={() => use(c)} android_ripple={{ color: t.line }} style={[styles.cand, { borderColor: t.line }]}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ color: t.text, fontSize: 15, fontWeight: '500' }}>{c.title}</Text>
                    <Text style={{ color: t.sub, fontSize: 13 }}>{[c.source === 'arxiv' ? 'arXiv' : 'Crossref', c.year, authorLine(c, 2), c.similarity > 0.9 ? '标题相似度高' : '部分匹配'].filter(Boolean).join(' · ')}</Text>
                  </View>
                  <Text style={{ color: t.accentText, fontSize: 14, fontWeight: '600' }}>用这个</Text>
                </Pressable>
              ))
            : null}
          {state === 'error' ? <Text style={{ color: t.danger, fontSize: 13 }}>搜索失败：检查网络后再试。</Text> : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {state !== 'done' ? <Button title="按标题搜索" kind="tonal" busy={state === 'loading'} onPress={() => void search()} /> : null}
            <Button title="手动填写" kind="text" onPress={onManual} />
            <Button title="信息没问题" kind="text" onPress={() => {
              s.library.updatePaper(p.id, { title: p.title })
              s.changed()
            }} />
          </View>
        </>
      )}
    </View>
  )
}

/** 一项可以改的信息：失去焦点或按完成时保存 */
function EditField({ label, value, placeholder, multiline, numeric, mono, focusKey, onCommit }: { label: string; value: string; placeholder?: string; multiline?: boolean; numeric?: boolean; mono?: boolean; focusKey?: number; onCommit: (v: string) => void }) {
  const t = useTheme()
  const [v, setV] = useState(value)
  const [focused, setFocused] = useState(false)
  const input = useRef<TextInputInstance>(null)
  useEffect(() => {
    if (!focused) setV(value)
  }, [value, focused])
  useEffect(() => {
    if (focusKey) input.current?.focus()
  }, [focusKey])
  const commit = () => {
    setFocused(false)
    const x = v.trim()
    if (x !== value.trim()) onCommit(x)
  }
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 6 }}>
      <Text style={{ color: focused ? t.accentText : t.sub, fontSize: 12, fontWeight: '500' }}>{label}</Text>
      <TextInput
        ref={input}
        value={v}
        onChangeText={setV}
        onFocus={() => setFocused(true)}
        onBlur={commit}
        onSubmitEditing={multiline && label !== '标题' ? undefined : () => input.current?.blur()}
        blurOnSubmit={!multiline || label === '标题'}
        multiline={multiline}
        placeholder={placeholder}
        placeholderTextColor={t.placeholder}
        accessibilityLabel={label}
        keyboardType={numeric ? 'number-pad' : 'default'}
        autoCapitalize={mono ? 'none' : 'sentences'}
        autoCorrect={!mono}
        style={{ color: t.text, fontSize: 15, lineHeight: 21, paddingVertical: 6, paddingHorizontal: 0, fontFamily: mono ? 'monospace' : undefined, borderBottomWidth: focused ? 2 : 1, borderBottomColor: focused ? t.accent : t.line, textAlignVertical: 'top' }}
      />
    </View>
  )
}

function nameOf(a: Author): string {
  return [a.given, a.family].filter(Boolean).join(' ')
}

function parseAuthors(s: string): Author[] {
  return s
    .split(/\s*[,，;；]\s*|\s+and\s+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map(splitName)
}

function withId(p: Paper, key: 'doi' | 'arxiv', v: string) {
  const ids = { ...p.identifiers }
  if (v) ids[key] = v
  else delete ids[key]
  return ids
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: 16, paddingTop: 4, gap: 6 },
  title: { fontSize: 26, fontWeight: '600', lineHeight: 32 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, marginTop: 14 },
  chipsIn: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  label: { fontSize: 12, fontWeight: '500', paddingHorizontal: 16, paddingBottom: 6 },
  tagInput: { height: 32, minWidth: 100, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 0, fontSize: 14 },
  muted: { paddingHorizontal: 16, fontSize: 14, paddingBottom: 8 },
  anno: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  bar: { width: 4, borderRadius: 2 },
  noteCard: { marginHorizontal: 16, marginBottom: 8, padding: 14, borderRadius: 12, gap: 2 },
  match: { marginHorizontal: 16, marginTop: 16, padding: 16, borderRadius: 16, gap: 10 },
  cand: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth }
})
