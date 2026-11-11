// 阅读时选中文字点"翻译"：只把这段文字（和其中出现的术语译法）发给选的翻译服务，译文流式显示。
// 选的是一个词或短语时，可以加进术语表（已有就改译法）。和桌面的 TranslateCard 对应。
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { router } from 'expo-router'
import type { AiEvent } from '@flax/core'
import { app } from '../services'
import { copyText } from '../actions'
import { Button } from './kit'
import { BottomSheet } from './sheets'
import { TermSheet } from './TermSheet'
import { useTheme } from './theme'

/** 多长以内算"词或短语"，可以加进术语表 */
const TERM_MAX = 60

export function TranslateSheet({ text, paperId, onClose }: { text: string; paperId: string; onClose: () => void }) {
  const t = useTheme()
  const s = app()
  const [out, setOut] = useState('')
  const [state, setState] = useState<'busy' | 'done' | { error: string; noKey: boolean }>('busy')
  const [adding, setAdding] = useState<{ term: string; translation: string } | null>(null)
  const rid = useRef<string | null>(null)

  const clean = text.replace(/\s+/g, ' ').trim()
  const short = clean.length <= TERM_MAX && !/[\n。．.!?！？;；]\s*\S/.test(clean)
  const known = short ? s.library.listTerms().find((x) => x.term.toLowerCase() === clean.toLowerCase()) : undefined
  const glossary = s.library.termsIn(text)

  useEffect(() => {
    rid.current = null
    let all = ''
    const handle = (e: AiEvent) => {
      if (e.type === 'delta') setOut((all += e.text))
      else if (e.type === 'done') {
        setOut(e.text)
        setState('done')
      } else setState({ error: e.code === 'cancelled' ? '已停止' : e.message, noKey: e.code === 'no_key' || e.code === 'auth' || e.code === 'quota' })
    }
    // 没设好服务时，出错的事件在 translate() 返回 id 之前就发出来了：先攒着，拿到 id 再对
    const early: AiEvent[] = []
    const off = s.onAi((e) => {
      if (rid.current === null) early.push(e)
      else if (e.requestId === rid.current) handle(e)
    })
    try {
      rid.current = s.ai.translate(text, glossary.map((g) => ({ term: g.term, translation: g.translation })))
      for (const e of early) if (e.requestId === rid.current) handle(e)
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : String(e), noKey: false })
    }
    return () => {
      off()
      if (rid.current) s.ai.cancel(rid.current)
    }
  }, [text])

  const firstLine =
    out
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  const engine = s.ai.status().translate

  return (
    <>
      <BottomSheet open={!adding} onClose={onClose} title="翻译">
        <View style={{ paddingHorizontal: 20, gap: 12 }}>
          <Text style={{ color: t.sub, fontSize: 14, lineHeight: 20 }} numberOfLines={4}>
            {clean}
          </Text>
          {known ? (
            <Text style={{ color: t.text, fontSize: 15 }}>
              <Text style={{ color: t.accentText, fontWeight: '600' }}>术语表 </Text>
              {known.translation}
            </Text>
          ) : null}
          <View accessibilityLiveRegion="polite" style={{ minHeight: 48, gap: 6 }}>
            {typeof state === 'object' ? (
              <Text style={{ color: t.danger, fontSize: 15, lineHeight: 22 }}>{state.error}</Text>
            ) : out ? (
              out
                .split('\n')
                .filter((l) => l.trim())
                .map((l, i) => (
                  <Text key={i} selectable style={{ color: i > 0 && short ? t.sub : t.text, fontSize: i > 0 && short ? 14 : 17, lineHeight: i > 0 && short ? 20 : 26 }}>
                    {l}
                  </Text>
                ))
            ) : (
              <ActivityIndicator color={t.sub} style={{ alignSelf: 'flex-start' }} />
            )}
          </View>
          {glossary.length ? <Text style={{ color: t.sub, fontSize: 13 }}>按术语表：{glossary.map((g) => `${g.term} → ${g.translation}`).join('，')}</Text> : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {state === 'busy' && rid.current ? <Button title="停止" kind="tonal" onPress={() => rid.current && s.ai.cancel(rid.current)} /> : null}
            {state === 'done' ? <Button title="复制译文" kind="tonal" onPress={() => void copyText(out.trim())} /> : null}
            {state === 'done' && short ? <Button title={known ? '改译法' : '加入术语表'} kind="tonal" onPress={() => setAdding({ term: clean, translation: known?.translation ?? firstLine })} /> : null}
            {typeof state === 'object' && state.noKey ? (
              <Button
                title="去设置"
                kind="tonal"
                onPress={() => {
                  onClose()
                  router.push('/settings/translate')
                }}
              />
            ) : null}
          </View>
          <Text style={{ color: t.placeholder, fontSize: 12 }}>{engine.engine === 'ai' ? '用 AI 服务翻译' : `用 ${engineName(engine.engine)} 翻译`} · 在"设置 → 翻译"里换</Text>
        </View>
      </BottomSheet>
      <TermSheet term={adding ? (known ?? 'new') : null} initial={adding ?? undefined} paperId={paperId} onClose={() => setAdding(null)} />
    </>
  )
}

const NAMES: Record<string, string> = { tencent: '腾讯翻译君', baidu: '百度翻译', youdao: '有道智云', deepl: 'DeepL', microsoft: '微软翻译', apple: '系统翻译' }
const engineName = (e: string) => NAMES[e] ?? e
