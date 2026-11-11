// 设置 › 关于 › 自检：确认这台手机上的加密、数据库和桌面兼容。
import { useEffect, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { Stack } from 'expo-router'
import { runSelfTest, type CheckResult } from '../../src/selftest'
import { useTheme } from '../../src/ui/theme'

export default function SelfTest() {
  const t = useTheme()
  const [results, setResults] = useState<CheckResult[]>([])
  const [done, setDone] = useState(false)
  useEffect(() => {
    let alive = true
    void runSelfTest((r) => {
      console.log(`[selftest] ${r.ok ? 'PASS' : 'FAIL'} ${r.name} (${r.ms}ms): ${r.detail}`)
      if (alive) setResults((x) => [...x, r])
    }).then((all) => {
      console.log(`[selftest] done ${all.filter((r) => r.ok).length}/${all.length}`)
      if (alive) setDone(true)
    })
    return () => {
      alive = false
    }
  }, [])
  const failed = results.filter((r) => !r.ok).length
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={styles.wrap}>
      <Stack.Screen options={{ title: '自检' }} />
      <Text style={[styles.summary, { color: t.text }]}>{done ? (failed ? `${failed} 项没通过` : `全部 ${results.length} 项通过`) : '正在检查…'}</Text>
      {results.map((r) => (
        <View key={r.name} style={[styles.row, { borderColor: t.line }]}>
          <Text style={[styles.mark, { color: r.ok ? t.ok : t.danger }]}>{r.ok ? '✓' : '✗'}</Text>
          <View style={{ flex: 1 }}>
            <Text style={[styles.name, { color: t.text }]}>{r.name}</Text>
            <Text style={[styles.detail, { color: r.ok ? t.sub : t.danger }]}>{r.detail}</Text>
          </View>
          <Text style={[styles.ms, { color: t.sub }]}>{r.ms} ms</Text>
        </View>
      ))}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  wrap: { padding: 16, gap: 4 },
  summary: { fontSize: 16, fontWeight: '600', marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  mark: { fontSize: 18, width: 20, textAlign: 'center' },
  name: { fontSize: 15 },
  detail: { fontSize: 13, marginTop: 2 },
  ms: { fontSize: 12 }
})
