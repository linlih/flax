// 文献库：在读 / 待读 / 全部，搜索，筛选（文件夹、标签、状态）和排序，"添加"浮动按钮（选 PDF、粘贴链接、从 Zotero 导入）。
// 长按一篇：复制引用、导出、改状态、删除。和桌面的论文表格（LibraryTable）、侧栏（Sidebar）对应。
import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { ActivityIndicator, FlatList, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { router, Stack, useLocalSearchParams, useNavigation } from 'expo-router'
import { authorLine, filterPapers, formatCitation, isNew, isStale, MATCH_HINT, progress, sortReading, STATUS_LABEL, STATUSES, tagColorMap, toBibTeX, toRIS, type CiteStyle, type Paper, type ReadingStatus } from '@flax/core'
import { app, showNotice, useVersion } from '../../src/services'
import { hasPdf } from '../../src/platform/files'
import { pickAndImport, pickBibTeX } from '../../src/importPdf'
import { copyText, removePaper, setStatus, shareTextFile } from '../../src/actions'
import { Button, Chip, Empty, Field, IconButton, Tabs } from '../../src/ui/kit'
import { ActionSheet, BottomSheet, OptionRow, Prompt } from '../../src/ui/sheets'
import { Icon } from '../../src/ui/Icon'
import { TAG, useTheme } from '../../src/ui/theme'

/** 只有 Android 能从别的应用分享进来（iOS 要另做分享扩展，见 src/share.ts） */
const CAN_RECEIVE_SHARE = Platform.OS === 'android'

type View3 = 'reading' | 'to_read' | 'all'
type Sort = 'added' | 'opened' | 'title' | 'year'
const SORTS: [Sort, string][] = [
  ['added', '加入时间'],
  ['opened', '上次打开'],
  ['title', '标题'],
  ['year', '年份']
]
const STYLES: [CiteStyle, string][] = [
  ['apa', 'APA'],
  ['gbt7714', 'GB/T 7714'],
  ['bibtex', 'BibTeX']
]

interface Filter {
  folder: string
  tag: string
  status: ReadingStatus | ''
  sort: Sort
}
const NO_FILTER: Filter = { folder: '', tag: '', status: '', sort: 'added' }

export default function LibraryScreen() {
  const t = useTheme()
  const v = useVersion('library')
  useVersion('sync')
  const nav = useNavigation()
  const [tab, setTab] = useState<View3>('reading')
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [adding, setAdding] = useState(false)
  const [filter, setFilter] = useState<Filter>(NO_FILTER)
  const [filtering, setFiltering] = useState(false)
  const [menu, setMenu] = useState(false)
  const [folders, setFolders] = useState(false)
  const [rowMenu, setRowMenu] = useState<Paper | null>(null)
  const [cite, setCite] = useState<Paper | null>(null)
  const s = app()
  // 从论文详情点"只看这个标签的论文"过来
  const { tag: tagParam } = useLocalSearchParams<{ tag?: string }>()
  useEffect(() => {
    if (tagParam) {
      setFilter((f) => ({ ...f, tag: tagParam }))
      setTab('all')
    }
  }, [tagParam])

  const { papers, tagColors, allFolders, allTags, importing, downloading } = useMemo(() => {
    const lib = s.library
    const tags = lib.listTags()
    return { papers: lib.listPapers(), tagColors: tagColorMap(tags), allTags: tags, allFolders: lib.listFolders(), importing: new Set(s.importer.importingIds()), downloading: new Set(s.importer.downloadingIds()) }
  }, [v])

  const counts = useMemo(
    () => ({
      reading: papers.filter((p) => p.readingStatus === 'reading').length,
      to_read: papers.filter((p) => p.readingStatus === 'to_read').length,
      all: papers.length
    }),
    [papers]
  )

  const filtered = filter.folder || filter.tag || filter.status || filter.sort !== 'added'
  const shown = useMemo(() => {
    let base = query.trim() ? filterPapers(papers, query) : papers
    if (filter.folder) base = base.filter((p) => p.folderIds.includes(filter.folder))
    if (filter.tag) base = base.filter((p) => p.tags.includes(filter.tag))
    if (filter.status) base = base.filter((p) => p.readingStatus === filter.status)
    if (!query.trim() && !filtered) {
      if (tab === 'reading') return sortReading(base.filter((p) => p.readingStatus === 'reading'))
      if (tab === 'to_read') base = base.filter((p) => p.readingStatus === 'to_read')
    } else if (!query.trim() && tab !== 'all' && !filter.status) base = base.filter((p) => p.readingStatus === tab)
    return sortBy([...base], filter.sort)
  }, [papers, tab, query, filter])

  useLayoutEffect(() => {
    nav.setOptions({
      headerRight: () => (
        <View style={{ flexDirection: 'row', marginRight: 4 }}>
          <IconButton
            icon={searching ? 'close' : 'search'}
            label={searching ? '关闭搜索' : '搜索'}
            onPress={() => {
              setSearching((x) => !x)
              setQuery('')
            }}
          />
          <IconButton icon="more" label="更多" onPress={() => setMenu(true)} />
        </View>
      )
    })
  }, [nav, searching])

  const sync = s.sync.get()
  const syncing = sync.state === 'syncing'
  const folderName = (id: string) => allFolders.find((f) => f.id === id)?.name ?? '文件夹'

  const exportList = async (format: 'bibtex' | 'ris') => {
    const list = shown.length ? shown : papers
    if (!list.length) return showNotice('没有可以导出的论文')
    const name = list.length === 1 ? list[0]!.title.slice(0, 60) : 'Flax 文献'
    await shareTextFile(`${name}.${format === 'ris' ? 'ris' : 'bib'}`, format === 'ris' ? toRIS(list) : toBibTeX(list), format === 'ris' ? 'application/x-research-info-systems' : 'application/x-bibtex', '导出参考文献')
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Stack.Screen options={{ title: '文献库' }} />
      {searching ? (
        <View style={styles.searchWrap}>
          <TextInput autoFocus value={query} onChangeText={setQuery} placeholder="标题、作者、期刊、年份、标签" placeholderTextColor={t.placeholder} accessibilityLabel="搜索文献库" returnKeyType="search" style={[styles.search, { backgroundColor: t.surface, color: t.text }]} />
        </View>
      ) : (
        <Tabs<View3>
          value={tab}
          onChange={setTab}
          tabs={[
            { key: 'reading', label: `在读 ${counts.reading}` },
            { key: 'to_read', label: `待读 ${counts.to_read}` },
            { key: 'all', label: `全部 ${counts.all}` }
          ]}
        />
      )}
      {filtered ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterBar}>
          {filter.folder ? <Chip label={`文件夹：${folderName(filter.folder)}`} selected onPress={() => setFilter({ ...filter, folder: '' })} /> : null}
          {filter.tag ? <Chip label={`标签：${filter.tag}`} selected onPress={() => setFilter({ ...filter, tag: '' })} /> : null}
          {filter.status ? <Chip label={STATUS_LABEL[filter.status]} selected onPress={() => setFilter({ ...filter, status: '' })} /> : null}
          {filter.sort !== 'added' ? <Chip label={`按${SORTS.find((x) => x[0] === filter.sort)![1]}`} selected onPress={() => setFilter({ ...filter, sort: 'added' })} /> : null}
          <Chip label="清除筛选" dashed onPress={() => setFilter(NO_FILTER)} />
        </ScrollView>
      ) : null}
      <FlatList
        data={shown}
        keyExtractor={(p) => p.id}
        contentContainerStyle={{ paddingBottom: 120, flexGrow: 1 }}
        refreshing={syncing}
        onRefresh={sync.config ? () => void s.sync.syncNow().catch((e: Error) => showNotice(e.message)) : undefined}
        renderItem={({ item }) => <PaperRow p={item} tagColors={tagColors} busy={importing.has(item.id)} downloading={downloading.has(item.id)} onLong={() => setRowMenu(item)} />}
        ListEmptyComponent={<EmptyList tab={query.trim() || filtered ? 'search' : tab} hasAny={papers.length > 0} syncOn={!!sync.config} onAdd={() => setAdding(true)} />}
      />
      <Pressable accessibilityRole="button" accessibilityLabel="添加论文" onPress={() => setAdding(true)} style={[styles.fab, { backgroundColor: t.container }]} android_ripple={{ color: '#00000018' }}>
        <Icon name="add" size={24} color={t.onContainer} />
        <Text style={{ color: t.onContainer, fontWeight: '600', fontSize: 16 }}>添加</Text>
      </Pressable>

      <AddSheet open={adding} onClose={() => setAdding(false)} />

      <ActionSheet
        open={menu}
        onClose={() => setMenu(false)}
        actions={[
          { label: '筛选和排序', icon: 'search', onPress: () => setFiltering(true) },
          { label: '文件夹', icon: 'folder', onPress: () => setFolders(true) },
          { label: '从 Zotero 或 BibTeX 导入', icon: 'upload', onPress: () => void pickBibTeX() },
          { label: `导出 BibTeX（${shown.length || papers.length} 篇）`, icon: 'share', onPress: () => void exportList('bibtex'), disabled: !papers.length },
          { label: `导出 RIS（${shown.length || papers.length} 篇）`, icon: 'share', onPress: () => void exportList('ris'), disabled: !papers.length }
        ]}
      />

      <BottomSheet open={filtering} onClose={() => setFiltering(false)} title="筛选和排序">
        <SheetHead label="排序" />
        {SORTS.map(([k, label]) => (
          <OptionRow key={k} label={label} checked={filter.sort === k} onPress={() => setFilter({ ...filter, sort: k })} />
        ))}
        <SheetHead label="阅读状态" />
        <OptionRow label="全部状态" checked={!filter.status} onPress={() => setFilter({ ...filter, status: '' })} />
        {STATUSES.map((st) => (
          <OptionRow key={st} label={STATUS_LABEL[st]} checked={filter.status === st} onPress={() => setFilter({ ...filter, status: st })} />
        ))}
        {allFolders.length ? <SheetHead label="文件夹" /> : null}
        {allFolders.length ? <OptionRow label="全部论文" checked={!filter.folder} onPress={() => setFilter({ ...filter, folder: '' })} /> : null}
        {allFolders.map((f) => (
          <OptionRow key={f.id} label={f.name} sub={`${papers.filter((p) => p.folderIds.includes(f.id)).length} 篇`} checked={filter.folder === f.id} onPress={() => setFilter({ ...filter, folder: f.id })} />
        ))}
        {allTags.length ? <SheetHead label="标签" /> : null}
        {allTags.length ? <OptionRow label="全部标签" checked={!filter.tag} onPress={() => setFilter({ ...filter, tag: '' })} /> : null}
        {allTags.map((tg) => (
          <OptionRow key={tg.tag} label={tg.tag} sub={`${tg.count} 篇`} checked={filter.tag === tg.tag} onPress={() => setFilter({ ...filter, tag: tg.tag })} icon={<View style={[styles.dot, { backgroundColor: tg.color ? TAG[tg.color] : t.placeholder }]} />} />
        ))}
      </BottomSheet>

      <FolderSheet open={folders} onClose={() => setFolders(false)} onPick={(id) => setFilter({ ...filter, folder: id })} />

      <ActionSheet
        open={!!rowMenu}
        onClose={() => setRowMenu(null)}
        title={rowMenu?.title}
        actions={
          rowMenu
            ? [
                rowMenu.files.length > 0 && { label: '开始读', icon: 'reading', onPress: () => router.push(`/read/${rowMenu.id}`) },
                { label: '论文详情', icon: 'info', onPress: () => router.push(`/paper/${rowMenu.id}`) },
                { label: '复制引用', icon: 'copy', onPress: () => setCite(rowMenu) },
                { label: '导出 BibTeX', icon: 'share', onPress: () => void shareTextFile(`${rowMenu.title.slice(0, 60)}.bib`, toBibTeX([rowMenu]), 'application/x-bibtex', '导出参考文献') },
                ...STATUSES.map((st) => ({ label: `标为${STATUS_LABEL[st]}`, checked: rowMenu.readingStatus === st, onPress: () => setStatus(rowMenu.id, st) })),
                { label: '删除', icon: 'trash' as const, danger: true, onPress: () => removePaper(rowMenu.id) }
              ]
            : []
        }
      />
      <ActionSheet open={!!cite} onClose={() => setCite(null)} title="复制引用" actions={STYLES.map(([style, name]) => ({ label: name, onPress: () => cite && void copyText(formatCitation(cite, style), `已复制 ${name} 引用`) }))} />
    </View>
  )
}

function sortBy(list: Paper[], sort: Sort): Paper[] {
  switch (sort) {
    case 'opened':
      return list.sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''))
    case 'title':
      return list.sort((a, b) => a.title.localeCompare(b.title))
    case 'year':
      return list.sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
    default:
      return list.sort((a, b) => b.addedAt.localeCompare(a.addedAt))
  }
}

function SheetHead({ label }: { label: string }) {
  const t = useTheme()
  return <Text style={{ color: t.accentText, fontSize: 13, fontWeight: '600', paddingHorizontal: 20, paddingTop: 14, paddingBottom: 4 }}>{label}</Text>
}

/** 文件夹：新建、改名、删除；点一个只看这个文件夹里的论文。一篇论文可以在好几个文件夹里，在论文详情里勾选 */
function FolderSheet({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (id: string) => void }) {
  const t = useTheme()
  useVersion('library')
  const s = app()
  const list = s.library.listFolders()
  const papers = s.library.listPapers()
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [menu, setMenu] = useState<{ id: string; name: string } | null>(null)
  return (
    <>
      <BottomSheet open={open && !creating && !renaming && !menu} onClose={onClose} title="文件夹">
        {list.length === 0 ? <Text style={{ color: t.sub, fontSize: 14, paddingHorizontal: 20, paddingBottom: 8, lineHeight: 20 }}>把论文分组。一篇可以在好几个文件夹里，在论文详情里勾选。</Text> : null}
        {list.map((f) => (
          <Pressable
            key={f.id}
            accessibilityRole="button"
            android_ripple={{ color: t.line }}
            onPress={() => {
              onPick(f.id)
              onClose()
            }}
            onLongPress={() => setMenu(f)}
            style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20 }}
          >
            <Icon name="folder" size={22} color={t.body} />
            <Text style={{ flex: 1, color: t.text, fontSize: 16 }}>{f.name}</Text>
            <Text style={{ color: t.sub, fontSize: 13 }}>{papers.filter((p) => p.folderIds.includes(f.id)).length}</Text>
            <IconButton icon="more" label={`${f.name} 的操作`} onPress={() => setMenu(f)} />
          </Pressable>
        ))}
        <View style={{ padding: 16 }}>
          <Button title="新建文件夹" kind="tonal" onPress={() => setCreating(true)} />
        </View>
      </BottomSheet>
      <ActionSheet
        open={!!menu}
        onClose={() => setMenu(null)}
        title={menu?.name}
        actions={[
          { label: '重命名', icon: 'edit', onPress: () => menu && setRenaming(menu) },
          {
            label: '删除文件夹（论文不会被删除）',
            icon: 'trash',
            danger: true,
            onPress: () => {
              if (!menu) return
              s.library.removeFolder(menu.id)
              s.changed()
            }
          }
        ]}
      />
      <Prompt
        open={creating}
        title="新建文件夹"
        label="文件夹名称"
        okLabel="新建"
        onClose={() => setCreating(false)}
        onSubmit={(name) => {
          try {
            s.library.createFolder(name)
            s.changed()
          } catch (e) {
            showNotice(e instanceof Error ? e.message : String(e))
          }
        }}
      />
      <Prompt
        open={!!renaming}
        title="重命名文件夹"
        label="文件夹名称"
        initial={renaming?.name}
        onClose={() => setRenaming(null)}
        onSubmit={(name) => {
          if (!renaming) return
          try {
            s.library.renameFolder(renaming.id, name)
            s.changed()
          } catch (e) {
            showNotice(e instanceof Error ? e.message : String(e))
          }
        }}
      />
    </>
  )
}

function PaperRow({ p, tagColors, busy, downloading, onLong }: { p: Paper; tagColors: Map<string, string>; busy: boolean; downloading: boolean; onLong: () => void }) {
  const t = useTheme()
  const pr = progress(p)
  const main = p.files.find((f) => f.role === 'main') ?? p.files[0]
  const cloud = main && !hasPdf(main.hash)
  const meta = [authorLine(p, 1), [p.venue, p.year].filter(Boolean).join(' ')].filter(Boolean).join(' · ')
  const stale = p.readingStatus === 'reading' && isStale(p)
  const status = busy ? '正在识别标题和作者…' : downloading ? '正在下载 PDF…' : null
  return (
    <Pressable accessibilityRole="button" accessibilityHint="长按有更多操作" onPress={() => router.push(`/paper/${p.id}`)} onLongPress={onLong} android_ripple={{ color: t.line }} style={styles.row}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
        {isNew(p) ? <View accessibilityLabel="新加的" style={[styles.newDot, { backgroundColor: t.accent }]} /> : null}
        <Text style={{ color: t.text, fontSize: 16, fontWeight: '600', lineHeight: 21, flex: 1 }}>{p.title}</Text>
      </View>
      {meta ? (
        <Text style={{ color: t.sub, fontSize: 14 }} numberOfLines={1}>
          {meta}
        </Text>
      ) : null}
      {p.tags.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 2 }}>
          {p.tags.map((tag) => (
            <Text key={tag} style={{ fontSize: 13, color: t.sub }}>
              <Text style={{ color: tagColors.has(tag) ? TAG[tagColors.get(tag) as keyof typeof TAG] : t.placeholder }}>● </Text>
              {tag}
            </Text>
          ))}
        </View>
      ) : null}
      {pr ? (
        <View style={styles.progress}>
          <View style={[styles.track, { backgroundColor: t.desk }]}>
            <View style={{ width: `${Math.round((pr.page / pr.total) * 100)}%`, height: 4, backgroundColor: t.accent }} />
          </View>
          <Text style={{ fontSize: 13, color: t.sub }}>
            第 {pr.page} / {pr.total} 页{stale ? ' · 最近没碰' : ''}
          </Text>
        </View>
      ) : stale ? (
        <Text style={{ fontSize: 13, color: t.sub }}>最近没碰 · 超过 30 天没打开</Text>
      ) : null}
      {status ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <ActivityIndicator size="small" color={t.sub} />
          <Text style={{ fontSize: 13, color: t.sub }}>{status}</Text>
        </View>
      ) : p.needsMatch ? (
        <Text style={{ fontSize: 13, color: t.danger }}>{p.matchIssue ? MATCH_HINT[p.matchIssue] : '信息可能不完整'}，在详情里匹配</Text>
      ) : !main ? (
        <Text style={{ fontSize: 13, color: t.sub }}>没有 PDF</Text>
      ) : cloud ? (
        <Text style={{ fontSize: 13, color: t.sub }}>PDF 在云端，打开时下载</Text>
      ) : null}
    </Pressable>
  )
}

function EmptyList({ tab, hasAny, syncOn, onAdd }: { tab: View3 | 'search'; hasAny: boolean; syncOn: boolean; onAdd: () => void }) {
  if (tab === 'search') return <Empty title="没有找到" sub="换个词或者清除筛选试试：标题、作者、期刊、年份、标签都能搜。" />
  if (!hasAny)
    return (
      <Empty title="文献库是空的" sub={syncOn ? '正在从云端同步，或者点"添加"导入 PDF。' : `开启同步后，电脑上的论文、批注和笔记都会过来。也可以导入 PDF${CAN_RECEIVE_SHARE ? '，或者在别的应用里把 PDF 分享给 Flax' : ''}。`}>
        {!syncOn ? <Button title="开启同步" kind="tonal" onPress={() => router.push('/settings/sync')} style={{ marginTop: 12 }} /> : <Button title="添加论文" kind="tonal" onPress={onAdd} style={{ marginTop: 12 }} />}
      </Empty>
    )
  if (tab === 'reading') return <Empty title="没有在读的论文" sub="打开一篇读一会儿，它就会出现在这里。" />
  return <Empty title="没有待读的论文" sub="在论文详情里把状态改成待读。" />
}

function AddSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTheme()
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const close = () => {
    setLink('')
    setError('')
    onClose()
  }
  const addLink = async () => {
    setBusy(true)
    setError('')
    try {
      const ok = await app().importer.addFromText(link)
      if (!ok) setError('没认出 DOI 或 arXiv 编号')
      else close()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <BottomSheet open={open} onClose={close} title="添加论文">
      <View style={{ paddingHorizontal: 20, gap: 16 }}>
        <Button
          title="选择 PDF 文件"
          kind="tonal"
          onPress={() => {
            close()
            void pickAndImport()
          }}
        />
        <Text style={{ color: t.sub, fontSize: 13, textAlign: 'center' }}>或者</Text>
        <Field label="DOI 或 arXiv 链接" value={link} onChangeText={setLink} autoCapitalize="none" autoCorrect={false} placeholder="例如 arxiv.org/abs/1706.03762" error={error} onSubmitEditing={() => void addLink()} returnKeyType="done" />
        <Button title="添加" onPress={() => void addLink()} busy={busy} disabled={!link.trim()} />
        <Button
          title="从 Zotero 或 BibTeX 导入"
          kind="text"
          onPress={() => {
            close()
            void pickBibTeX()
          }}
        />
        {CAN_RECEIVE_SHARE ? <Text style={{ color: t.sub, fontSize: 13, lineHeight: 19 }}>也可以在别的应用（浏览器、文件、微信…）里把 PDF 或论文链接分享给 Flax。</Text> : null}
      </View>
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  searchWrap: { paddingHorizontal: 16, paddingVertical: 8 },
  search: { height: 48, borderRadius: 24, paddingHorizontal: 20, fontSize: 16 },
  filterBar: { paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
  row: { paddingHorizontal: 16, paddingVertical: 14, gap: 4 },
  newDot: { width: 8, height: 8, borderRadius: 4, marginTop: 7 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  track: { flex: 1, height: 4, borderRadius: 2, overflow: 'hidden' },
  fab: { position: 'absolute', right: 16, bottom: 16, height: 56, paddingLeft: 16, paddingRight: 20, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: 10, elevation: 4 }
})
