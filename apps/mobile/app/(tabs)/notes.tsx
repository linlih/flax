// 笔记列表：最近改过的在前；搜标题和正文；右下角新建一篇不属于哪篇论文的笔记。
import { useMemo, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { router } from 'expo-router'
import { addedLabel } from '@flax/core'
import { app, useVersion } from '../../src/services'
import { Empty } from '../../src/ui/kit'
import { Icon } from '../../src/ui/Icon'
import { useTheme } from '../../src/ui/theme'

export default function NotesScreen() {
  const t = useTheme()
  const v = useVersion('notes')
  const lv = useVersion('library')
  const [q, setQ] = useState('')
  const notes = useMemo(() => app().notes.list(), [v])
  const titles = useMemo(() => new Map(app().library.listPapers().map((p) => [p.id, p.title])), [lv])
  const shown = useMemo(() => {
    const w = q.trim().toLowerCase()
    if (!w) return notes
    return notes.filter((n) => n.title.toLowerCase().includes(w) || (app().notes.read(n.id)?.body ?? '').toLowerCase().includes(w))
  }, [notes, q])
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
        <TextInput value={q} onChangeText={setQ} placeholder="搜索笔记" placeholderTextColor={t.placeholder} accessibilityLabel="搜索笔记" style={{ height: 48, borderRadius: 24, paddingHorizontal: 20, fontSize: 16, backgroundColor: t.surface, color: t.text }} />
      </View>
      <FlatList
        data={shown}
        keyExtractor={(n) => n.id}
        contentContainerStyle={{ paddingBottom: 96, flexGrow: 1 }}
        ListEmptyComponent={<Empty title={q ? '没有找到' : '还没有笔记'} sub={q ? undefined : '点"新建"写一篇，或者在论文详情里给论文写笔记；电脑上的笔记会同步过来。'} />}
        renderItem={({ item: n }) => (
          <Pressable onPress={() => router.push(`/note/${encodeURIComponent(n.id)}`)} android_ripple={{ color: t.line }} style={{ paddingHorizontal: 16, paddingVertical: 14, gap: 3 }}>
            <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>{n.title}</Text>
            {n.excerpt ? <Text style={{ color: t.body, fontSize: 14 }} numberOfLines={2}>{n.excerpt}</Text> : null}
            <Text style={{ color: t.sub, fontSize: 13 }} numberOfLines={1}>
              {addedLabel(n.updatedAt)}
              {n.paperId && titles.get(n.paperId) ? ` · ${titles.get(n.paperId)}` : ''}
            </Text>
          </Pressable>
        )}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="新建笔记"
        onPress={() => {
          const n = app().notes.create({ title: '未命名笔记' })
          app().notesChanged()
          router.push(`/note/${encodeURIComponent(n.id)}`)
        }}
        style={[styles.fab, { backgroundColor: t.container }]}
        android_ripple={{ color: '#00000018' }}
      >
        <Icon name="add" size={24} color={t.onContainer} />
        <Text style={{ color: t.onContainer, fontWeight: '600', fontSize: 16 }}>新建</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  fab: { position: 'absolute', right: 16, bottom: 16, height: 56, paddingLeft: 16, paddingRight: 20, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: 10, elevation: 4 }
})
