// 阅读器里的"问 AI"：这篇论文的当前对话（桌面问过的也在，会同步过来），可以带一段选中的文字提问，回答逐字流进来。
// 规则在 core 的 AiService：同一篇一次只问一个问题；出错的一问一答不再发给模型。
// 回答里的 ⟦页码|原文⟧ 显示成 [1] 这样的编号，点了跳到那一页。回答可以复制、摘到笔记；出错了可以重试。
// 输入框旁边选思考深度；历史里长按一个对话可以改名、删除。和桌面的 AiPanel 对应。
import { useEffect, useRef, useState } from 'react'
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, type ScrollViewInstance, Text, TextInput, View } from 'react-native'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { levelsFor, resolveEffort, splitCitations, stripCitations, vendorOf, type AiChatTurn, type AiConversationList, type AiEffort, type AiModel } from '@flax/core'
import { app, useVersion } from '../services'
import { appendToPaperNote, copyText } from '../actions'
import { ActionSheet, Prompt } from './sheets'
import { Button, IconButton, Snackbar } from './kit'
import { useTheme } from './theme'

export function AiChat({ paperId, quote, onClose, onCite }: { paperId: string; quote: string | null; onClose: () => void; onCite: (page: number) => void }) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const s = app()
  useVersion('ai')
  const [turns, setTurns] = useState<AiChatTurn[]>(() => s.ai.conversation(paperId))
  const [q, setQ] = useState('')
  const [withQuote, setWithQuote] = useState(quote)
  const [running, setRunning] = useState<{ id: string; text: string } | null>(null)
  const scroller = useRef<ScrollViewInstance>(null)
  const runId = useRef<string | null>(null)
  const st = s.ai.status()
  const ready = st.ready
  const usable = st.services.some((x) => x.hasKey || vendorOf(x.vendor)?.keyOptional)
  const [convs, setConvs] = useState<AiConversationList>(() => s.ai.conversations(paperId))
  const [history, setHistory] = useState(false)
  const refresh = () => setConvs(s.ai.conversations(paperId))
  const [convMenu, setConvMenu] = useState<{ id: string; title: string } | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)
  const [effortOpen, setEffortOpen] = useState(false)
  const [models, setModels] = useState<{ service: string; list: AiModel[] } | null>(null)
  const sel = st.selection
  useEffect(() => {
    if (!sel) return
    let alive = true
    void s.ai.models(sel.service).then((r) => alive && r.ok && setModels({ service: sel.service, list: r.models }))
    return () => {
      alive = false
    }
  }, [sel?.service])
  const service = sel ? st.services.find((x) => x.id === sel.service) : undefined
  const model = models && sel && models.service === sel.service ? models.list.find((m) => m.id === sel.model) : undefined
  const levels = levelsFor(vendorOf(service?.vendor ?? '')?.kind ?? 'openai', model)
  const effort = resolveEffort(st.effort, levels) ?? 'auto'

  // 没设 AI 服务的设备：同步过来的对话照样能看，直接打开最近的一个（和桌面一样）
  useEffect(() => {
    const first = convs.list[0]?.id
    if (usable || convs.current !== null || !first) return
    setTurns(s.ai.openConversation(paperId, first))
    refresh()
  }, [])

  useEffect(() => {
    const off = s.onAi((e) => {
        if (e.requestId !== runId.current) return
        if (e.type === 'delta') return setRunning((r) => (r ? { ...r, text: r.text + e.text } : r))
        // done / error：core 已经把回答（或错误）写进对话了，重新读一遍
        runId.current = null
        setRunning(null)
        setTurns(s.ai.conversation(paperId))
        refresh()
    })
    return () => void off()
  }, [paperId])

  const ask = (again?: { text: string; quote?: string }) => {
    const text = again ? again.text : q.trim()
    if (!text || running) return
    try {
      const id = s.ai.ask(paperId, text, again ? again.quote : (withQuote ?? undefined))
      if (!again) {
        setQ('')
        setWithQuote(null)
      }
      setTurns(s.ai.conversation(paperId))
      refresh()
      runId.current = id
      setRunning({ id, text: '' })
    } catch (e) {
      setTurns([...turns, { role: 'assistant', text: '', error: e instanceof Error ? e.message : String(e), at: new Date().toISOString() }])
    }
  }

  const fresh = () => {
    try {
      s.ai.newConversation(paperId)
      setTurns([])
      refresh()
    } catch {
      /* 还在回答，按钮本来就不可点 */
    }
  }

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior="height" style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: t.line }}>
          <IconButton icon="close" label="关闭" onPress={onClose} />
          <Text style={{ flex: 1, color: t.text, fontSize: 18, fontWeight: '500' }}>问 AI</Text>
          {convs.list.length > (convs.current ? 1 : 0) ? <Text accessibilityRole="button" onPress={running ? undefined : () => setHistory(true)} style={{ color: running ? t.sub : t.accentText, fontSize: 15, fontWeight: '600', padding: 12 }}>历史</Text> : null}
          {turns.length && ready ? <Text accessibilityRole="button" onPress={running ? undefined : fresh} style={{ color: running ? t.sub : t.accentText, fontSize: 15, fontWeight: '600', padding: 12 }}>新对话</Text> : null}
        </View>

        <ScrollView ref={scroller} onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: true })} contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
          {turns.length === 0 && !running ? (
            <Text style={{ color: t.sub, fontSize: 14, lineHeight: 20 }}>问这篇论文的问题。选中一段文字再点"问 AI"，那段文字会和问题一起发过去。</Text>
          ) : null}
          {turns.map((turn, i) => {
            const lastUser = i === turns.length - 1 && turn.error ? [...turns].reverse().find((x) => x.role === 'user') : undefined
            return <Bubble key={i} turn={turn} onCite={onCite} onToNote={(md) => appendToPaperNote(paperId, md)} onRetry={ready && lastUser && !running ? () => ask({ text: lastUser.text, ...(lastUser.quote ? { quote: lastUser.quote } : {}) }) : undefined} />
          })}
          {running ? <Bubble turn={{ role: 'assistant', text: running.text || '…', at: '' }} onCite={onCite} /> : null}
        </ScrollView>

        {ready ? (
          <View style={{ borderTopWidth: 1, borderTopColor: t.line, padding: 12, paddingBottom: 12 + insets.bottom, gap: 8 }}>
            {withQuote ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: t.surface, borderRadius: 12, paddingLeft: 12 }}>
                <Text numberOfLines={2} style={{ flex: 1, color: t.body, fontSize: 13 }}>「{withQuote}」</Text>
                <IconButton icon="close" label="不带这段文字" onPress={() => setWithQuote(null)} />
              </View>
            ) : null}
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
              <TextInput
                value={q}
                onChangeText={setQ}
                multiline
                accessibilityLabel="问题"
                placeholder={withQuote ? '关于这段文字，想问什么？' : '想问什么？'}
                placeholderTextColor={t.placeholder}
                style={{ flex: 1, maxHeight: 120, minHeight: 48, color: t.text, fontSize: 16, backgroundColor: t.surface, borderRadius: 24, paddingHorizontal: 16, paddingVertical: 12 }}
              />
              {running ? <Button title="停止" kind="tonal" onPress={() => s.ai.cancel(running.id)} /> : <Button title="发送" onPress={() => ask()} disabled={!q.trim()} />}
            </View>
            <Text
              accessibilityRole="button"
              accessibilityState={{ disabled: levels.length === 0 }}
              onPress={levels.length ? () => setEffortOpen(true) : undefined}
              style={{ alignSelf: 'flex-start', color: levels.length ? t.accentText : t.placeholder, fontSize: 13, fontWeight: '500', paddingHorizontal: 4, paddingVertical: 14, marginVertical: -10 }}
            >
              {levels.length ? `思考深度：${EFFORT_LABEL[effort]}${effort !== st.effort ? `（这个模型没有"${EFFORT_LABEL[st.effort]}"）` : ''} ›` : '这个模型不能调思考深度'}
            </Text>
          </View>
        ) : (
          <View style={{ borderTopWidth: 1, borderTopColor: t.line, padding: 16, paddingBottom: 16 + insets.bottom, gap: 8 }}>
            <Text style={{ color: t.body, fontSize: 14 }}>{usable ? '还没有选模型。' : turns.length ? '这是别的设备上问的。在这台手机上填一个 Key 也能接着问。' : '还没有设置 AI 服务。在这台手机上填一个 Key 就能问。'}</Text>
            <Button
              title="去设置"
              kind="tonal"
              onPress={() => {
                onClose()
                router.push('/settings/ai')
              }}
            />
          </View>
        )}
      </KeyboardAvoidingView>
      {/* 全屏面板盖住了根上的提示条，这里再放一个，在输入框上面 */}
      <Snackbar bottom={insets.bottom + 150} onlyNew />

      {history ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => setHistory(false)}>
          <Pressable accessibilityLabel="关闭" style={{ flex: 1, backgroundColor: t.scrim }} onPress={() => setHistory(false)} />
          <View style={{ maxHeight: '70%', backgroundColor: t.bg, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingTop: 16, paddingBottom: insets.bottom + 12 }}>
            <Text style={{ color: t.text, fontSize: 20, fontWeight: '600', paddingHorizontal: 20, paddingBottom: 8 }}>这篇论文的对话</Text>
            <ScrollView>
              {convs.list.map((c) => (
                <Pressable
                  key={c.id}
                  accessibilityRole="button"
                  android_ripple={{ color: t.line }}
                  onPress={() => {
                    setTurns(s.ai.openConversation(paperId, c.id))
                    refresh()
                    setHistory(false)
                  }}
                  onLongPress={() => setConvMenu({ id: c.id, title: c.title })}
                  style={{ paddingHorizontal: 20, paddingVertical: 12, backgroundColor: c.id === convs.current ? t.surface : undefined }}
                >
                  <Text numberOfLines={2} style={{ color: t.text, fontSize: 15 }}>{c.title}</Text>
                  <Text style={{ color: t.sub, fontSize: 13 }}>
                    {c.questions} 个问题 · {c.updatedAt.slice(0, 10)}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </Modal>
      ) : null}

      <ActionSheet
        open={!!convMenu}
        onClose={() => setConvMenu(null)}
        title={convMenu?.title}
        actions={[
          { label: '重命名', icon: 'edit', onPress: () => setRenaming(convMenu) },
          {
            label: '删除这个对话',
            icon: 'trash',
            danger: true,
            disabled: !!running && convMenu?.id === convs.current,
            onPress: () => {
              if (!convMenu) return
              s.ai.deleteConversation(paperId, convMenu.id)
              if (convMenu.id === convs.current) setTurns([])
              refresh()
            }
          }
        ]}
      />
      <Prompt
        open={!!renaming}
        title="对话名称"
        label="名称"
        initial={renaming?.title ?? ''}
        onClose={() => setRenaming(null)}
        onSubmit={(title) => {
          if (!renaming) return
          s.ai.renameConversation(paperId, renaming.id, title)
          refresh()
        }}
      />
      <ActionSheet
        open={effortOpen}
        onClose={() => setEffortOpen(false)}
        title="思考深度"
        sub="翻译不受影响，固定用最快的。"
        actions={(['auto', ...levels] as AiEffort[]).map((e) => ({ label: `${EFFORT_LABEL[e]} · ${EFFORT_HINT[e]}`, checked: e === effort, onPress: () => s.ai.setEffort(e) }))}
      />
    </Modal>
  )
}

const EFFORT_LABEL: Record<AiEffort, string> = { auto: '自动', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' }
const EFFORT_HINT: Record<AiEffort, string> = { auto: '用模型自己的默认', low: '最快，适合查词和简单问题', medium: '一般的问题', high: '想得更久，适合推导和比较', xhigh: '比"高"更久，适合难的推导', max: '最慢，也最费 token' }

function Bubble({ turn, onCite, onToNote, onRetry }: { turn: AiChatTurn; onCite: (page: number) => void; onToNote?: (md: string) => void; onRetry?: (() => void) | undefined }) {
  const t = useTheme()
  if (turn.role === 'user')
    return (
      <View style={{ alignSelf: 'flex-end', maxWidth: '88%', gap: 4 }}>
        {turn.quote ? (
          <Text numberOfLines={4} style={{ color: t.sub, fontSize: 13, borderLeftWidth: 3, borderLeftColor: t.chipLine, paddingLeft: 8 }}>
            {turn.quote}
          </Text>
        ) : null}
        <View style={{ backgroundColor: t.container, borderRadius: 18, borderBottomRightRadius: 4, paddingHorizontal: 14, paddingVertical: 10 }}>
          <Text selectable style={{ color: t.onContainer, fontSize: 15, lineHeight: 21 }}>{turn.text}</Text>
        </View>
      </View>
    )
  return (
    <View style={{ alignSelf: 'stretch', gap: 4 }}>
      {turn.error ? (
        <Text style={{ color: t.danger, fontSize: 14 }}>
          {turn.error}
          {onRetry ? (
            <Text accessibilityRole="button" onPress={onRetry} style={{ color: t.accentText, fontWeight: '600' }}>
              {'  重试'}
            </Text>
          ) : null}
        </Text>
      ) : (
        <Text selectable style={{ color: t.text, fontSize: 15, lineHeight: 22 }}>
          {splitCitations(turn.text).map((seg, i) =>
            seg.kind === 'text' ? (
              seg.text
            ) : (
              <Text key={i} accessibilityRole="link" accessibilityLabel={`第 ${seg.page} 页：${seg.quote}`} onPress={() => onCite(seg.page)} style={{ color: t.accentText, fontSize: 13, fontWeight: '600' }}>
                {`[${seg.n}]`}
              </Text>
            )
          )}
        </Text>
      )}
      {!turn.error && turn.at && onToNote ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          {turn.model ? <Text style={{ color: t.sub, fontSize: 12, flex: 1 }} numberOfLines={1}>{turn.model}</Text> : <View style={{ flex: 1 }} />}
          <Text accessibilityRole="button" onPress={() => void copyText(stripCitations(turn.text))} style={{ color: t.accentText, fontSize: 13, fontWeight: '500', paddingVertical: 6 }}>
            复制
          </Text>
          <Text accessibilityRole="button" onPress={() => onToNote(stripCitations(turn.text))} style={{ color: t.accentText, fontSize: 13, fontWeight: '500', paddingVertical: 6 }}>
            摘到笔记
          </Text>
        </View>
      ) : turn.model ? (
        <Text style={{ color: t.sub, fontSize: 12 }}>{turn.model}</Text>
      ) : null}
    </View>
  )
}

