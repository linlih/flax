// 文献库：最上面"继续读"（最近打开的那篇），搜索框一直在，下面一排状态筛选（全部 / 在读 / 待读 / 读过 / 未读），
// 列表默认按最近活动（打开或加入）排。点一篇去读；右滑标待读，左滑删除（可撤销）；长按分组的操作菜单。
// iOS 用大标题、右上角"+"；Android 用 Material 的顶栏和右下角"添加"按钮。和桌面的论文表格（LibraryTable）、侧栏（Sidebar）对应。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Animated, FlatList, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native'
import { router, useLocalSearchParams, useNavigation } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { authorLine, filterPapers, shortVenue, formatCitation, isNew, isStale, MATCH_HINT, progress, STATUS_LABEL, STATUSES, tagColorMap, toBibTeX, toRIS, type CiteStyle, type Paper, type ReadingStatus } from '@flax/core'
import { app, showNotice, useVersion } from '../../src/services'
import { fetchingIds, openPaper } from '../../src/openPaper'
import { hasPdf } from '../../src/platform/files'
import { pickAndImport, pickBibTeX } from '../../src/importPdf'
import { copyText, removePaper, setStatus, shareTextFile } from '../../src/actions'
import { Button, Chip, Empty, Field, IconButton } from '../../src/ui/kit'
import { ActionSheet, BottomSheet, DIVIDER, OptionRow, Prompt } from '../../src/ui/sheets'
import { Icon } from '../../src/ui/Icon'
import { TAG, useTheme } from '../../src/ui/theme'

/** 只有 Android 能从别的应用分享进来（iOS 要另做分享扩展，见 src/share.ts） */
const CAN_RECEIVE_SHARE = Platform.OS === 'android'
const IOS = Platform.OS === 'ios'

type Sort = 'recent' | 'added' | 'title' | 'year'
const SORTS: [Sort, string][] = [
  ['recent', '最近打开或加入'],
  ['added', '加入时间'],
  ['title', '标题'],
  ['year', '年份']
]
const STYLES: [CiteStyle, string][] = [
  ['apa', 'APA'],
  ['gbt7714', 'GB/T 7714'],
  ['bibtex', 'BibTeX']
]
/** 筛选条上状态的顺序：常用的在前 */
const STATUS_CHIPS: ReadingStatus[] = ['reading', 'to_read', 'done', 'inbox']

interface Filter {
  folder: string
  tag: string
  sort: Sort
}
const NO_FILTER: Filter = { folder: '', tag: '', sort: 'recent' }

export default function LibraryScreen() {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const v = useVersion('library')
  useVersion('sync')
  const nav = useNavigation()
  const [status, setStatusFilter] = useState<ReadingStatus | ''>('')
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [filter, setFilter] = useState<Filter>(NO_FILTER)
  const [filtering, setFiltering] = useState(false)
  const [menu, setMenu] = useState(false)
  const [folders, setFolders] = useState(false)
  const [rowMenu, setRowMenu] = useState<Paper | null>(null)
  const [statusMenu, setStatusMenu] = useState<Paper | null>(null)
  const [cite, setCite] = useState<Paper | null>(null)
  const s = app()
  // 从论文详情点"只看这个标签的论文"过来
  const { tag: tagParam } = useLocalSearchParams<{ tag?: string }>()
  useEffect(() => {
    if (tagParam) {
      setFilter((f) => ({ ...f, tag: tagParam }))
      setStatusFilter('')
    }
  }, [tagParam])

  const { papers, trashCount, tagColors, allFolders, allTags, importing, downloading } = useMemo(() => {
    const lib = s.library
    const tags = lib.listTags()
    return { papers: lib.listPapers(), trashCount: lib.listTrash().length, tagColors: tagColorMap(tags), allTags: tags, allFolders: lib.listFolders(), importing: new Set(s.importer.importingIds()), downloading: new Set([...s.importer.downloadingIds(), ...fetchingIds()]) }
  }, [v])

  const counts = useMemo(() => {
    const c: Record<string, number> = { '': papers.length }
    for (const p of papers) c[p.readingStatus] = (c[p.readingStatus] ?? 0) + 1
    return c
  }, [papers])

  // 继续读：最近打开过、有 PDF、还没读完的那篇
  const current = useMemo(() => {
    let best: Paper | null = null
    for (const p of papers) if (p.lastOpenedAt && p.files.length && p.readingStatus !== 'done' && (!best || p.lastOpenedAt > best.lastOpenedAt!)) best = p
    return best
  }, [papers])

  const narrowed = !!(filter.folder || filter.tag)
  const shown = useMemo(() => {
    let base = query.trim() ? filterPapers(papers, query) : papers
    if (filter.folder) base = base.filter((p) => p.folderIds.includes(filter.folder))
    if (filter.tag) base = base.filter((p) => p.tags.includes(filter.tag))
    if (status) base = base.filter((p) => p.readingStatus === status)
    return sortBy([...base], filter.sort)
  }, [papers, status, query, filter])

  const openMenu = () => setMenu(true)
  useLayoutEffect(() => {
    nav.setOptions(IOS ? { headerShown: false } : { headerRight: () => <IconButton icon="more" label="更多" onPress={openMenu} /> })
  }, [nav])

  const sync = s.sync.get()
  // 下拉刷新的圈只在自己下拉时转：打开应用时的自动同步在后台悄悄做，不挡着列表
  const [pulled, setPulled] = useState(false)
  const syncing = pulled && sync.state === 'syncing'
  const pull = () => {
    setPulled(true)
    s.sync
      .syncNow()
      .catch((e: Error) => showNotice(e.message))
      .finally(() => setPulled(false))
  }
  const folderName = (id: string) => allFolders.find((f) => f.id === id)?.name ?? '文件夹'

  const exportList = async (format: 'bibtex' | 'ris') => {
    const list = shown.length ? shown : papers
    if (!list.length) return showNotice('没有可以导出的论文')
    const name = list.length === 1 ? list[0]!.title.slice(0, 60) : 'Flax 文献'
    await shareTextFile(`${name}.${format === 'ris' ? 'ris' : 'bib'}`, format === 'ris' ? toRIS(list) : toBibTeX(list), format === 'ris' ? 'application/x-research-info-systems' : 'application/x-bibtex', '导出参考文献')
  }

  const searching = !!query.trim()
  // 列表上面的部分：放在 FlatList 的表头里跟着滚（传元素不传组件，打字时输入框不会被重建）
  const header = (
    <View>
      {IOS ? (
        <View style={[styles.iosHead, { paddingTop: insets.top + 6 }]}>
          <Text accessibilityRole="header" style={{ color: t.text, fontSize: 32, fontWeight: '700', flex: 1 }}>
            文献库
          </Text>
          <IconButton icon="add" label="添加论文" onPress={() => setAdding(true)} color={t.accentText} size={26} />
          <IconButton icon="more" label="更多" onPress={openMenu} color={t.accentText} />
        </View>
      ) : null}
      <View style={styles.searchWrap}>
        <View style={[styles.search, { backgroundColor: t.surface }]}>
          <Icon name="search" size={18} color={t.sub} />
          <TextInput value={query} onChangeText={setQuery} placeholder="搜索标题、作者、期刊、年份、标签" placeholderTextColor={t.placeholder} accessibilityLabel="搜索文献库" returnKeyType="search" clearButtonMode="while-editing" style={{ flex: 1, color: t.text, fontSize: 16, paddingVertical: 0 }} />
          {query && !IOS ? <IconButton icon="close" label="清除搜索" onPress={() => setQuery('')} size={18} color={t.sub} /> : null}
        </View>
      </View>
      {current && !searching && !status && !narrowed ? <ContinueCard p={current} /> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.filterBar}>
        <Chip label={`全部 ${counts[''] ?? 0}`} selected={!status} onPress={() => setStatusFilter('')} />
        {STATUS_CHIPS.filter((st) => counts[st] || status === st).map((st) => (
          <Chip key={st} label={`${STATUS_LABEL[st]} ${counts[st] ?? 0}`} selected={status === st} onPress={() => setStatusFilter(status === st ? '' : st)} />
        ))}
        {filter.folder ? <Chip label={`文件夹：${folderName(filter.folder)} ✕`} selected onPress={() => setFilter({ ...filter, folder: '' })} /> : null}
        {filter.tag ? <Chip label={`标签：${filter.tag} ✕`} selected onPress={() => setFilter({ ...filter, tag: '' })} /> : null}
        <Chip label={filter.sort !== 'recent' ? `按${SORTS.find((x) => x[0] === filter.sort)![1]}` : '筛选和排序'} dashed={filter.sort === 'recent'} selected={filter.sort !== 'recent'} onPress={() => setFiltering(true)} />
      </ScrollView>
    </View>
  )

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <FlatList
        data={shown}
        keyExtractor={(p) => p.id}
        ListHeaderComponent={header}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: 120, flexGrow: 1 }}
        refreshing={syncing}
        onRefresh={sync.config ? pull : undefined}
        renderItem={({ item }) => (
          <SwipeRow
            right={item.readingStatus === 'to_read' ? { label: '移出待读', icon: 'inbox', color: t.sub, run: () => setStatus(item.id, 'inbox') } : { label: '标为待读', icon: 'toread', color: t.accent, run: () => setStatus(item.id, 'to_read') }}
            left={{ label: '删除', icon: 'trash', color: t.danger, run: () => removePaper(item.id), away: true }}
          >
            <PaperRow p={item} tagColors={tagColors} busy={importing.has(item.id)} downloading={downloading.has(item.id)} onLong={() => setRowMenu(item)} />
          </SwipeRow>
        )}
        ListEmptyComponent={<EmptyList kind={searching || narrowed ? 'search' : status || 'all'} hasAny={papers.length > 0} syncOn={!!sync.config} onAdd={() => setAdding(true)} />}
      />
      {!IOS ? (
        <Pressable accessibilityRole="button" accessibilityLabel="添加论文" onPress={() => setAdding(true)} style={[styles.fab, { backgroundColor: t.container }]} android_ripple={{ color: '#00000018' }}>
          <Icon name="add" size={24} color={t.onContainer} />
          <Text style={{ color: t.onContainer, fontWeight: '600', fontSize: 16 }}>添加</Text>
        </Pressable>
      ) : null}

      <AddSheet open={adding} onClose={() => setAdding(false)} />

      <ActionSheet
        open={menu}
        onClose={() => setMenu(false)}
        actions={[
          { label: '文件夹', icon: 'folder', onPress: () => setFolders(true) },
          { label: '筛选和排序', icon: 'search', onPress: () => setFiltering(true) },
          DIVIDER,
          { label: '从 Zotero 或 BibTeX 导入', icon: 'upload', onPress: () => void pickBibTeX() },
          !!papers.length && { label: `导出 BibTeX（${shown.length || papers.length} 篇）`, icon: 'share', onPress: () => void exportList('bibtex') },
          !!papers.length && { label: `导出 RIS（${shown.length || papers.length} 篇）`, icon: 'share', onPress: () => void exportList('ris') },
          DIVIDER,
          // 和桌面侧栏一样：有东西才出现
          trashCount > 0 && { label: `废纸篓（${trashCount} 篇）`, icon: 'trash', onPress: () => router.push('/trash') }
        ]}
      />

      <BottomSheet open={filtering} onClose={() => setFiltering(false)} title="筛选和排序">
        <SheetHead label="排序" />
        {SORTS.map(([k, label]) => (
          <OptionRow key={k} label={label} checked={filter.sort === k} onPress={() => setFilter({ ...filter, sort: k })} />
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
        {filter.sort !== 'recent' || narrowed ? (
          <View style={{ padding: 16 }}>
            <Button title="恢复默认" kind="text" onPress={() => setFilter(NO_FILTER)} />
          </View>
        ) : null}
      </BottomSheet>

      <FolderSheet open={folders} onClose={() => setFolders(false)} onPick={(id) => setFilter({ ...filter, folder: id })} />

      {/* 长按：三组常用的，状态收进下一层，删除放最后 */}
      <ActionSheet
        open={!!rowMenu}
        onClose={() => setRowMenu(null)}
        title={rowMenu?.title}
        actions={
          rowMenu
            ? [
                rowMenu.files.length > 0 && { label: '开始读', icon: 'reading', onPress: () => void openPaper(rowMenu, 'list') },
                { label: '论文详情', icon: 'info', onPress: () => router.push(`/paper/${rowMenu.id}`) },
                DIVIDER,
                { label: '复制引用', icon: 'copy', onPress: () => setCite(rowMenu) },
                { label: '导出 BibTeX', icon: 'share', onPress: () => void shareTextFile(`${rowMenu.title.slice(0, 60)}.bib`, toBibTeX([rowMenu]), 'application/x-bibtex', '导出参考文献') },
                DIVIDER,
                { label: '阅读状态', icon: 'done', value: STATUS_LABEL[rowMenu.readingStatus], submenu: true, onPress: () => setStatusMenu(rowMenu) },
                DIVIDER,
                { label: '删除', icon: 'trash' as const, danger: true, onPress: () => removePaper(rowMenu.id) }
              ]
            : []
        }
      />
      <ActionSheet open={!!statusMenu} onClose={() => setStatusMenu(null)} title="阅读状态" actions={statusMenu ? STATUSES.map((st) => ({ label: STATUS_LABEL[st], checked: statusMenu.readingStatus === st, onPress: () => setStatus(statusMenu.id, st) })) : []} />
      <ActionSheet open={!!cite} onClose={() => setCite(null)} title="复制引用" actions={STYLES.map(([style, name]) => ({ label: name, onPress: () => cite && void copyText(formatCitation(cite, style), `已复制 ${name} 引用`) }))} />
    </View>
  )
}

function sortBy(list: Paper[], sort: Sort): Paper[] {
  switch (sort) {
    case 'recent': {
      const at = (p: Paper) => (p.lastOpenedAt && p.lastOpenedAt > p.addedAt ? p.lastOpenedAt : p.addedAt)
      return list.sort((a, b) => at(b).localeCompare(at(a)))
    }
    case 'title':
      return list.sort((a, b) => a.title.localeCompare(b.title))
    case 'year':
      return list.sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
    default:
      return list.sort((a, b) => b.addedAt.localeCompare(a.addedAt))
  }
}

/** 继续读：最近打开的那篇，点一下接着读 */
function ContinueCard({ p }: { p: Paper }) {
  const t = useTheme()
  const pr = progress(p)
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`继续读：${p.title}${pr ? `，第 ${pr.page} 页，共 ${pr.total} 页` : ''}`} onPress={() => void openPaper(p, 'list')} android_ripple={{ color: t.line }} style={[styles.card, { backgroundColor: t.surface }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Icon name="reading" size={16} color={t.accentText} />
        <Text style={{ color: t.accentText, fontSize: 13, fontWeight: '600', flex: 1 }}>继续读</Text>
        {pr ? <Text style={{ color: t.sub, fontSize: 13 }}>第 {pr.page} / {pr.total} 页</Text> : null}
      </View>
      <Text numberOfLines={2} style={{ color: t.text, fontSize: 17, fontWeight: '600', lineHeight: 23 }}>
        {p.title}
      </Text>
      {pr ? (
        <View style={[styles.track, { backgroundColor: t.desk, flex: 0 }]}>
          <View style={{ width: `${Math.round((pr.page / pr.total) * 100)}%`, height: 4, backgroundColor: t.accent }} />
        </View>
      ) : null}
    </Pressable>
  )
}

interface Swipe {
  label: string
  icon: 'trash' | 'toread' | 'inbox'
  color: string
  run: () => void
  /** 执行后这一行滑出去（删除）；否则弹回来 */
  away?: boolean
}

/** 列表行左右滑：滑过一段距离松手就执行（和邮件一样）；露出来的底色和字说明会做什么 */
function SwipeRow({ left, right, children }: { left: Swipe; right: Swipe; children: React.ReactNode }) {
  const t = useTheme()
  const { width } = useWindowDimensions()
  const x = useRef(new Animated.Value(0)).current
  const [dir, setDir] = useState<0 | 1 | -1>(0)
  const [armed, setArmed] = useState(false)
  const TRIGGER = Math.min(120, width * 0.3)
  const pan = useMemo(
    () =>
      PanResponder.create({
        // 横着拖得明显比竖着多才接手，竖着滚列表不受影响
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 2,
        onPanResponderTerminationRequest: () => false,
        onPanResponderMove: (_, g) => {
          x.setValue(g.dx)
          setDir(g.dx > 0 ? 1 : g.dx < 0 ? -1 : 0)
          setArmed(Math.abs(g.dx) > TRIGGER)
        },
        onPanResponderRelease: (_, g) => {
          const act = g.dx > TRIGGER ? right : g.dx < -TRIGGER ? left : null
          if (act?.away) {
            Animated.timing(x, { toValue: Math.sign(g.dx) * width, duration: 180, useNativeDriver: true }).start(() => {
              act.run()
              x.setValue(0)
              setDir(0)
            })
            return
          }
          act?.run()
          Animated.spring(x, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start(() => setDir(0))
          setArmed(false)
        },
        onPanResponderTerminate: () => {
          Animated.spring(x, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start(() => setDir(0))
          setArmed(false)
        }
      }),
    [left, right, width]
  )
  const act = dir > 0 ? right : left
  return (
    <View
      accessibilityActions={[
        { name: 'right', label: right.label },
        { name: 'left', label: left.label }
      ]}
      onAccessibilityAction={(e) => (e.nativeEvent.actionName === 'right' ? right.run() : left.run())}
    >
      {dir !== 0 ? (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: armed ? act.color : t.surface, flexDirection: 'row', alignItems: 'center', justifyContent: dir > 0 ? 'flex-start' : 'flex-end', paddingHorizontal: 24, gap: 8 }]}>
          <Icon name={act.icon} size={20} color={armed ? '#fff' : act.color} />
          <Text style={{ color: armed ? '#fff' : act.color, fontSize: 15, fontWeight: '600' }}>{act.label}</Text>
        </View>
      ) : null}
      <Animated.View {...pan.panHandlers} style={{ transform: [{ translateX: x }], backgroundColor: t.bg }}>
        {children}
      </Animated.View>
    </View>
  )
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
  const meta = [authorLine(p, 1), [p.venue && shortVenue(p.venue), p.year].filter(Boolean).join(' ')].filter(Boolean).join(' · ')
  const stale = p.readingStatus === 'reading' && isStale(p)
  const status = busy ? '正在识别标题和作者…' : downloading ? '正在下载 PDF…' : null
  return (
    <Pressable accessibilityRole="button" accessibilityHint="打开阅读；长按有论文详情和更多操作；右滑标为待读，左滑删除" onPress={() => void openPaper(p, 'list')} onLongPress={onLong} android_ripple={{ color: t.line }} style={styles.row}>
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

function EmptyList({ kind, hasAny, syncOn, onAdd }: { kind: ReadingStatus | 'all' | 'search'; hasAny: boolean; syncOn: boolean; onAdd: () => void }) {
  if (kind === 'search') return <Empty title="没有找到" sub="换个词或者清除筛选试试：标题、作者、期刊、年份、标签都能搜。" />
  if (!hasAny)
    return (
      <Empty title="文献库是空的" sub={syncOn ? `正在从云端同步，或者点"添加"导入 PDF。` : `开启同步后，电脑上的论文、批注和笔记都会过来。也可以导入 PDF${CAN_RECEIVE_SHARE ? '，或者在别的应用里把 PDF 分享给 Flax' : ''}。`}>
        {!syncOn ? <Button title="开启同步" kind="tonal" onPress={() => router.push('/settings/sync')} style={{ marginTop: 12 }} /> : <Button title="添加论文" kind="tonal" onPress={onAdd} style={{ marginTop: 12 }} />}
      </Empty>
    )
  if (kind === 'all') return null
  return <Empty title={`没有${STATUS_LABEL[kind]}的论文`} sub="在列表里右滑可以标为待读，长按可以改阅读状态。" />
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
  iosHead: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 4, paddingBottom: 2 },
  searchWrap: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  search: { height: 44, borderRadius: 22, paddingLeft: 14, paddingRight: 4, flexDirection: 'row', alignItems: 'center', gap: 8 },
  card: { marginHorizontal: 16, marginTop: 4, marginBottom: 8, padding: 14, borderRadius: 16, gap: 8, overflow: 'hidden' },
  filterBar: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8, gap: 8 },
  row: { paddingHorizontal: 16, paddingVertical: 14, gap: 4 },
  newDot: { width: 8, height: 8, borderRadius: 4, marginTop: 7 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  track: { flex: 1, height: 4, borderRadius: 2, overflow: 'hidden' },
  fab: { position: 'absolute', right: 16, bottom: 16, height: 56, paddingLeft: 16, paddingRight: 20, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: 10, elevation: 4 }
})
