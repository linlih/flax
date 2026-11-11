// 设置 → 翻译：用 AI 模型，或者某家翻译服务的官方 API（自己申请的 Key，大多每月有免费额度）。
// 选了一家还没填 Key 的，先填好再换过去；填好的打开时试译一下。和桌面的 TranslateSettings 对应（手机上没有系统翻译）。
import { useEffect, useState } from 'react'
import { Linking, ScrollView, Text, View } from 'react-native'
import { Stack } from 'expo-router'
import { MT_ENGINES, mtEngineOf, type MtAccountInfo, type MtEngine, type TranslateEngine } from '@flax/core'
import { app, useVersion } from '../../src/services'
import { Button, Field } from '../../src/ui/kit'
import { OptionRow } from '../../src/ui/sheets'
import { useTheme } from '../../src/ui/theme'

type Test = { state: 'busy' } | { state: 'ok'; text: string } | { state: 'error'; message: string }

export default function TranslateSettings() {
  const t = useTheme()
  useVersion('ai')
  const s = app()
  const st = s.ai.status()
  const tr = st.translate
  const [picked, setPicked] = useState<MtEngine | null>(null)
  const [, force] = useState(0)
  const shown: TranslateEngine = picked ?? tr.engine
  const info = shown === 'ai' || shown === 'apple' ? undefined : mtEngineOf(shown)
  const account = tr.accounts.find((a) => a.engine === shown)

  const choose = (e: TranslateEngine) => {
    if (e !== 'ai' && !tr.accounts.some((a) => a.engine === e && a.hasSecret)) return setPicked(e as MtEngine)
    setPicked(null)
    s.ai.setTranslateEngine(e)
    force((x) => x + 1)
  }

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: '翻译' }} />
      <Text style={{ color: t.sub, fontSize: 14, lineHeight: 20, paddingHorizontal: 16, paddingBottom: 8 }}>阅读时选中文字点"翻译"。只发你要翻译的那段，按术语表的译法翻。</Text>
      <OptionRow label="AI 模型" sub={st.ready ? '问 AI 里选的模型' : '还没有连接 AI 服务：在"设置 → AI 服务"里添加一个，或者用下面的翻译服务'} checked={shown === 'ai'} onPress={() => choose('ai')} />
      {MT_ENGINES.map((m) => {
        const a = tr.accounts.find((x) => x.engine === m.id)
        return <OptionRow key={m.id} label={m.name} sub={`${m.free}${a?.hasSecret ? ' · 已填 Key' : ''}`} checked={shown === m.id} onPress={() => choose(m.id)} />
      })}
      {info ? <MtForm key={info.id} engine={info.id} account={account} picked={!!picked} onDone={() => setPicked(null)} /> : null}
    </ScrollView>
  )
}

function MtForm({ engine, account, picked, onDone }: { engine: MtEngine; account?: MtAccountInfo; picked: boolean; onDone: () => void }) {
  const t = useTheme()
  const s = app()
  const info = mtEngineOf(engine)!
  const [id, setId] = useState(account?.id ?? '')
  const [region, setRegion] = useState(account?.region ?? '')
  const [secret, setSecret] = useState('')
  const [editing, setEditing] = useState(!account?.hasSecret)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [test, setTest] = useState<Test | null>(null)

  const runTest = async () => {
    setTest({ state: 'busy' })
    const r = await s.ai.testTranslate(engine)
    setTest(r.ok ? { state: 'ok', text: r.text } : { state: 'error', message: r.message })
  }
  useEffect(() => {
    if (account?.hasSecret) void runTest()
  }, [])

  const canSave = !busy && (!info.idLabel || !!id.trim()) && (!editing || !!secret.trim())
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      s.ai.saveTranslateAccount({ engine, id: id.trim(), region: region.trim() }, secret.trim() || undefined)
      if (picked) s.ai.setTranslateEngine(engine)
      setSecret('')
      setEditing(false)
      onDone()
      void runTest()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={{ marginHorizontal: 16, marginTop: 12, padding: 16, borderRadius: 16, backgroundColor: t.surface, gap: 14 }}>
      <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>{info.name}</Text>
      <Text style={{ color: t.sub, fontSize: 13, lineHeight: 19 }}>
        {info.free}，以官网为准。
        <Text accessibilityRole="link" onPress={() => void Linking.openURL(info.url)} style={{ color: t.accentText }}>
          去申请 Key ›
        </Text>
      </Text>
      {info.idLabel ? <Field label={info.idLabel} value={id} onChangeText={(v) => setId(v.trim())} autoCapitalize="none" autoCorrect={false} importantForAutofill="no" /> : null}
      {info.regionLabel ? <Field label={`${info.regionLabel}（全局资源可以不填）`} value={region} onChangeText={(v) => setRegion(v.trim())} placeholder="例如 eastasia" autoCapitalize="none" autoCorrect={false} importantForAutofill="no" /> : null}
      {editing ? (
        <Field label={info.secretLabel} value={secret} onChangeText={setSecret} secureTextEntry autoCapitalize="none" autoCorrect={false} importantForAutofill="no" hint="只存在这台手机上，用 Android 的密钥库加密。" />
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ color: t.body, fontSize: 14, flex: 1 }}>{info.secretLabel} 已保存在这台手机上</Text>
          <Text accessibilityRole="button" onPress={() => setEditing(true)} style={{ color: t.accentText, fontSize: 14, fontWeight: '600', padding: 8 }}>
            更换
          </Text>
        </View>
      )}
      {error ? <Text style={{ color: t.danger, fontSize: 14 }}>{error}</Text> : null}
      {editing || id !== (account?.id ?? '') || region !== (account?.region ?? '') ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button title={account ? '保存' : '保存并使用'} onPress={() => void save()} disabled={!canSave} busy={busy} />
          <Button
            title="取消"
            kind="text"
            onPress={() => {
              if (account?.hasSecret) {
                setEditing(false)
                setSecret('')
                setId(account.id)
                setRegion(account.region)
                setError(null)
              } else onDone()
            }}
          />
        </View>
      ) : (
        <Text accessibilityLiveRegion="polite" style={{ color: test?.state === 'error' ? t.danger : test?.state === 'ok' ? t.accentText : t.sub, fontSize: 14 }}>
          {test?.state === 'busy' ? '正在试译…' : test?.state === 'ok' ? `可以用 · 试译：${test.text}` : test?.state === 'error' ? test.message : ''}
          {test?.state === 'error' ? (
            <Text accessibilityRole="button" onPress={() => void runTest()} style={{ color: t.accentText, fontWeight: '600' }}>
              {'  重试'}
            </Text>
          ) : null}
        </Text>
      )}
      {account && !editing ? (
        <Button
          title="删除这家"
          kind="text"
          onPress={() => {
            s.ai.saveTranslateAccount({ engine }, null)
            onDone()
          }}
        />
      ) : null}
    </View>
  )
}
