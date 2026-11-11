// 术语表：搜索、加一条、点一条改原文/译法/备注、删除（能撤销）。和桌面的 TermsView 对应。
// 阅读时翻译用这里的译法；也可以在翻译面板里"加入术语表"。
import { useMemo, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { app, useVersion } from '../../src/services'
import { Empty } from '../../src/ui/kit'
import { TermSheet } from '../../src/ui/TermSheet'
import { Icon } from '../../src/ui/Icon'
import { useTheme } from '../../src/ui/theme'
import type { Term } from '@flax/core'

export default function TermsScreen() {
  const t = useTheme()
  const v = useVersion('library')
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<Term | 'new' | null>(null)
  const s = app()
  const terms = useMemo(() => s.library.listTerms().sort((a, b) => a.term.localeCompare(b.term)), [v])
  const titles = useMemo(() => new Map(s.library.listPapers().map((p) => [p.id, p.title])), [v])
  const shown = useMemo(() => {
    const w = q.trim().toLowerCase()
    return w ? terms.filter((x) => x.term.toLowerCase().includes(w) || x.translation.toLowerCase().includes(w) || (x.note ?? '').toLowerCase().includes(w)) : terms
  }, [terms, q])
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
        <TextInput value={q} onChangeText={setQ} placeholder={`搜索 ${terms.length} 条术语`} placeholderTextColor={t.placeholder} accessibilityLabel="搜索术语" style={{ height: 48, borderRadius: 24, paddingHorizontal: 20, fontSize: 16, backgroundColor: t.surface, color: t.text }} />
      </View>
      <FlatList
        data={shown}
        keyExtractor={(x) => x.id}
        contentContainerStyle={{ paddingBottom: 96, flexGrow: 1 }}
        ListEmptyComponent={<Empty title={q ? '没有找到' : '术语表是空的'} sub={q ? undefined : '读论文时在翻译面板里"加入术语表"，或者点"添加"。翻译时会按这里的译法。'} />}
        renderItem={({ item: x }) => (
          <Pressable accessibilityRole="button" accessibilityHint="改这一条" onPress={() => setEditing(x)} android_ripple={{ color: t.line }} style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 2 }}>
            <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>{x.term}</Text>
            <Text style={{ color: t.body, fontSize: 15 }}>{x.translation}</Text>
            {x.note || (x.paperId && titles.get(x.paperId)) ? (
              <Text style={{ color: t.sub, fontSize: 13 }} numberOfLines={2}>
                {[x.note, x.paperId && titles.get(x.paperId) && `来自 ${titles.get(x.paperId)}`].filter(Boolean).join(' · ')}
              </Text>
            ) : null}
          </Pressable>
        )}
      />
      <Pressable accessibilityRole="button" accessibilityLabel="添加术语" onPress={() => setEditing('new')} style={[styles.fab, { backgroundColor: t.container }]} android_ripple={{ color: '#00000018' }}>
        <Icon name="add" size={24} color={t.onContainer} />
        <Text style={{ color: t.onContainer, fontWeight: '600', fontSize: 16 }}>添加</Text>
      </Pressable>
      <TermSheet term={editing} onClose={() => setEditing(null)} />
    </View>
  )
}

const styles = StyleSheet.create({
  fab: { position: 'absolute', right: 16, bottom: 16, height: 56, paddingLeft: 16, paddingRight: 20, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: 10, elevation: 4 }
})
