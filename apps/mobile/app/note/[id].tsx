// 一篇笔记：Markdown 原文直接编辑（第一版用普通输入框，以后换成 CodeMirror），离开时保存。
// 显示时 [[别的笔记]] 和 [第 N 页](flax://annotation/…) 都能点：前者打开那篇（没有就新建），后者跳到阅读器里那一处。
// 右上角"更多"：重命名、分享成 .md、删除（能撤销）。
import { useEffect, useMemo, useRef, useState } from 'react'
import { KeyboardAvoidingView, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { app, showNotice, useVersion } from '../../src/services'
import { shareTextFile } from '../../src/actions'
import { Empty, IconButton } from '../../src/ui/kit'
import { ActionSheet, Prompt } from '../../src/ui/sheets'
import { useTheme } from '../../src/ui/theme'

export default function NoteScreen() {
  const t = useTheme()
  const { id: raw } = useLocalSearchParams<{ id: string }>()
  const s = app()
  const [id, setId] = useState(decodeURIComponent(raw))
  const v = useVersion('notes')
  const doc = useMemo(() => s.notes.read(id), [id, v])
  const [body, setBody] = useState(doc?.body ?? '')
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const saved = useRef(doc?.body ?? '')
  const idRef = useRef(id)
  const gone = useRef(false)

  // 同步改了这篇（而且这边没在改）：用新的
  useEffect(() => {
    if (doc && !editing && doc.body !== saved.current) {
      saved.current = doc.body
      setBody(doc.body)
    }
  }, [doc?.body])

  const save = () => {
    if (gone.current || body === saved.current) return
    const n = s.notes.save(idRef.current, body)
    idRef.current = n.id
    if (n.id !== id) setId(n.id)
    saved.current = body
    s.notesChanged()
  }
  // 离开页面时保存（用 ref 拿到最新的 body）
  const latest = useRef(save)
  latest.current = save
  useEffect(() => () => latest.current(), [])

  if (!doc) return <Empty title="这篇笔记不在了" sub="可能在别的设备上删掉了。" />
  const paper = doc.note.paperId ? s.library.getPaper(doc.note.paperId) : null
  const refs = doc.note.annotationRefs.map((a) => s.library.getAnnotation(a)).filter((a) => !!a)

  const openLink = (title: string) => {
    save()
    const target = s.notes.byTitle(title)
    if (target) return router.push(`/note/${encodeURIComponent(target.id)}`)
    const n = s.notes.create({ title })
    s.notesChanged()
    showNotice(`新建了笔记：${n.title}`)
    router.push(`/note/${encodeURIComponent(n.id)}`)
  }
  const openAnnotation = (annoId: string) => {
    const a = s.library.getAnnotation(annoId)
    if (!a) return showNotice('这条批注已经删掉了')
    router.push(`/read/${a.paperId}?page=${a.page + 1}&anno=${a.id}`)
  }

  const remove = () => {
    save()
    const backup = s.notes.remove(idRef.current)
    gone.current = true
    s.notesChanged()
    router.back()
    if (backup)
      showNotice(`删掉了笔记：${backup.title}`, {
        action: {
          label: '撤销',
          run: () => {
            s.notes.restore(backup)
            s.notesChanged()
          }
        }
      })
  }

  return (
    <KeyboardAvoidingView behavior="height" style={{ flex: 1, backgroundColor: t.bg }}>
      <Stack.Screen
        options={{
          title: '',
          headerRight: () => (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              {editing ? (
                <Text
                  accessibilityRole="button"
                  onPress={() => {
                    save()
                    setEditing(false)
                  }}
                  style={{ color: t.accentText, fontSize: 16, fontWeight: '600', padding: 12 }}
                >
                  完成
                </Text>
              ) : (
                <Text accessibilityRole="button" onPress={() => setEditing(true)} style={{ color: t.accentText, fontSize: 16, fontWeight: '500', padding: 12 }}>
                  编辑
                </Text>
              )}
              <IconButton icon="more" label="更多" onPress={() => setMenu(true)} />
            </View>
          )
        }}
      />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 48, gap: 12 }} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="button" accessibilityHint="点一下改标题" onPress={() => setRenaming(true)} style={{ color: t.text, fontSize: 28, fontWeight: '600', lineHeight: 34 }}>
          {doc.note.title}
        </Text>
        {paper ? (
          <Text accessibilityRole="link" onPress={() => router.push(`/paper/${paper.id}`)} style={{ color: t.accentText, fontSize: 14 }}>
            {paper.title} ›
          </Text>
        ) : null}
        {editing ? (
          <TextInput
            autoFocus
            multiline
            value={body}
            onChangeText={setBody}
            onBlur={save}
            accessibilityLabel="笔记正文"
            placeholder="直接写。[[笔记标题]] 链接到别的笔记"
            placeholderTextColor={t.placeholder}
            textAlignVertical="top"
            style={{ color: t.body, fontSize: 16, lineHeight: 26, minHeight: 300, padding: 0 }}
          />
        ) : (
          <Pressable onPress={() => setEditing(true)} accessibilityHint="点一下编辑">
            <Markdown text={body} onLink={openLink} onAnnotation={openAnnotation} />
          </Pressable>
        )}
        {!editing && refs.length && paper ? (
          <View style={{ gap: 8, marginTop: 8 }}>
            <Text style={{ color: t.sub, fontSize: 13 }}>摘录了 {refs.length} 处</Text>
            {refs.map((a) => (
              <Pressable key={a.id} onPress={() => openAnnotation(a.id)} style={{ backgroundColor: t.surface, borderRadius: 12, padding: 12 }}>
                <Text style={{ color: t.body, fontSize: 14 }} numberOfLines={2}>
                  {a.target.quote.exact}
                </Text>
                <Text style={{ color: t.accentText, fontSize: 13, marginTop: 2 }}>第 {a.page + 1} 页 ›</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {!editing ? <Backlinks title={doc.note.title} selfId={doc.note.id} /> : null}
      </ScrollView>

      <ActionSheet
        open={menu}
        onClose={() => setMenu(false)}
        title={doc.note.title}
        actions={[
          { label: '重命名', icon: 'edit', onPress: () => setRenaming(true) },
          {
            label: '分享 Markdown',
            icon: 'share',
            onPress: () => {
              save()
              void shareTextFile(`${doc.note.title}.md`, body, 'text/markdown', '分享笔记')
            }
          },
          { label: '删除笔记', icon: 'trash', danger: true, onPress: remove }
        ]}
      />
      <Prompt
        open={renaming}
        title="笔记标题"
        label="标题"
        initial={doc.note.title}
        onClose={() => setRenaming(false)}
        onSubmit={(title) => {
          save()
          try {
            const n = s.notes.rename(idRef.current, title)
            s.notesChanged()
            if (n.title !== title) showNotice(`已经有同名的笔记，改成了：${n.title}`)
          } catch (e) {
            showNotice(e instanceof Error ? e.message : String(e))
          }
        }}
      />
    </KeyboardAvoidingView>
  )
}

/** 哪些笔记链接到了这篇 */
function Backlinks({ title, selfId }: { title: string; selfId: string }) {
  const t = useTheme()
  useVersion('notes')
  const list = app()
    .notes.list()
    .filter((n) => n.id !== selfId && n.links.some((l) => l.toLowerCase() === title.toLowerCase()))
  if (!list.length) return null
  return (
    <View style={{ gap: 6, marginTop: 12 }}>
      <Text style={{ color: t.sub, fontSize: 13 }}>{list.length} 篇笔记链接到这里</Text>
      {list.map((n) => (
        <Text key={n.id} accessibilityRole="link" onPress={() => router.push(`/note/${encodeURIComponent(n.id)}`)} style={{ color: t.accentText, fontSize: 15 }}>
          {n.title} ›
        </Text>
      ))}
    </View>
  )
}

type Seg = { text: string; link?: string; anno?: string }

/** 一行里的 [[链接]]、[文字](flax://annotation/id)、[文字](paper://…) 拆出来，其余是普通文字 */
function segments(line: string): Seg[] {
  const out: Seg[] = []
  const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\((?:flax|paper):\/\/annotation\/([^)\s]+)\)/g
  let last = 0
  for (const m of line.matchAll(re)) {
    if (m.index > last) out.push({ text: line.slice(last, m.index) })
    if (m[1]) out.push({ text: m[2] ?? m[1], link: m[1].trim() })
    else out.push({ text: m[3]!, anno: m[4]! })
    last = m.index + m[0].length
  }
  if (last < line.length) out.push({ text: line.slice(last) })
  return out
}

/** 很简单的 Markdown 显示：标题、引用、列表、待办，链接能点；其余原样 */
function Markdown({ text, onLink, onAnnotation }: { text: string; onLink: (title: string) => void; onAnnotation: (id: string) => void }) {
  const t = useTheme()
  if (!text.trim()) return <Text style={{ color: t.placeholder, fontSize: 16 }}>点一下开始写</Text>
  const inline = (s: string) =>
    segments(s).map((g, i) =>
      g.link ? (
        <Text key={i} accessibilityRole="link" onPress={() => onLink(g.link!)} style={{ color: t.accentText, textDecorationLine: 'underline' }}>
          {g.text}
        </Text>
      ) : g.anno ? (
        <Text key={i} accessibilityRole="link" onPress={() => onAnnotation(g.anno!)} style={{ color: t.accentText }}>
          {g.text} ›
        </Text>
      ) : (
        g.text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
      )
    )
  return (
    <View style={{ gap: 6 }}>
      {text.split('\n').map((line, i) => {
        const h = /^(#{1,6})\s+(.*)$/.exec(line)
        if (h)
          return (
            <Text key={i} style={{ color: t.text, fontSize: h[1]!.length === 1 ? 22 : 18, fontWeight: '600', marginTop: 8 }}>
              {inline(h[2]!)}
            </Text>
          )
        if (line.startsWith('>'))
          return (
            <View key={i} style={{ borderLeftWidth: 3, borderLeftColor: t.chipLine, paddingLeft: 12 }}>
              <Text style={{ color: t.sub, fontSize: 15, lineHeight: 23 }}>{inline(line.replace(/^>\s?/, ''))}</Text>
            </View>
          )
        const todo = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line)
        if (todo)
          return (
            <Text key={i} style={{ color: todo[1] === ' ' ? t.body : t.sub, fontSize: 16, lineHeight: 25, textDecorationLine: todo[1] === ' ' ? 'none' : 'line-through' }}>
              {todo[1] === ' ' ? '☐ ' : '☑ '}
              {inline(todo[2]!)}
            </Text>
          )
        const li = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line)
        if (li)
          return (
            <Text key={i} style={{ color: t.body, fontSize: 16, lineHeight: 25 }}>
              {/^\d/.test(li[1]!) ? `  ${li[1]} ` : '  • '}
              {inline(li[2]!)}
            </Text>
          )
        if (!line.trim()) return <View key={i} style={{ height: 6 }} />
        return (
          <Text key={i} selectable style={{ color: t.body, fontSize: 16, lineHeight: 25 }}>
            {inline(line)}
          </Text>
        )
      })}
    </View>
  )
}
