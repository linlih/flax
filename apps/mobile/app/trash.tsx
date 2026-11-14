// 废纸篓：删掉的论文先到这里，可以放回文献库，也可以永久删除（先问一次）。和桌面的 TrashView 对应。
// 从文献库右上角"更多 → 废纸篓"进来，有东西才有这一项。
import { useLayoutEffect, useMemo, useState } from 'react'
import { FlatList, Pressable, Text, View } from 'react-native'
import { Stack, useNavigation } from 'expo-router'
import { addedLabel, authorLine, type TrashedPaper } from '@flax/core'
import { app, showNotice, useVersion } from '../src/services'
import { purgePapers, restoreFromTrash } from '../src/actions'
import { Empty } from '../src/ui/kit'
import { ActionSheet } from '../src/ui/sheets'
import { useTheme } from '../src/ui/theme'

export default function TrashScreen() {
  const t = useTheme()
  const v = useVersion('library')
  const nav = useNavigation()
  const [picked, setPicked] = useState<TrashedPaper | null>(null)
  const papers = useMemo(() => app().library.listTrash(), [v])

  useLayoutEffect(() => {
    nav.setOptions({
      headerRight: () =>
        papers.length ? (
          <Text accessibilityRole="button" onPress={() => void purgePapers([])} style={{ color: t.danger, fontSize: 15, fontWeight: '500', padding: 8 }}>
            全部删除
          </Text>
        ) : null
    })
  }, [nav, papers.length, t])

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Stack.Screen options={{ title: '废纸篓' }} />
      <FlatList
        data={papers}
        keyExtractor={(p) => p.id}
        contentContainerStyle={{ paddingBottom: 40, flexGrow: 1 }}
        ListHeaderComponent={papers.length ? <Text style={{ color: t.sub, fontSize: 13, lineHeight: 19, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 }}>点一篇放回文献库或永久删除。永久删除在所有设备上生效。</Text> : undefined}
        renderItem={({ item: p }) => {
          const meta = [authorLine(p, 1), p.year].filter(Boolean).join(' · ')
          return (
            <Pressable accessibilityRole="button" accessibilityHint="放回或永久删除" onPress={() => setPicked(p)} android_ripple={{ color: t.line }} style={{ paddingHorizontal: 16, paddingVertical: 14, gap: 4 }}>
              <Text style={{ color: t.text, fontSize: 16, fontWeight: '600', lineHeight: 21 }}>{p.title}</Text>
              <Text style={{ color: t.sub, fontSize: 14 }} numberOfLines={1}>
                {[meta, `${addedLabel(p.deletedAt)}删除`].filter(Boolean).join(' · ')}
              </Text>
            </Pressable>
          )
        }}
        ListEmptyComponent={<Empty title="废纸篓是空的" sub="在文献库里删掉的论文会先放在这里。" />}
      />
      <ActionSheet
        open={!!picked}
        onClose={() => setPicked(null)}
        title={picked?.title}
        actions={
          picked
            ? [
                {
                  label: '放回文献库',
                  icon: 'undo',
                  onPress: () => {
                    restoreFromTrash(picked.id)
                    showNotice(`放回了文献库：${picked.title}`)
                  }
                },
                { label: '永久删除…', icon: 'trash', danger: true, onPress: () => void purgePapers([picked.id]) }
              ]
            : []
        }
      />
    </View>
  )
}
