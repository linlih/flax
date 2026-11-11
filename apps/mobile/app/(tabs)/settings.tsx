// 设置：同步、AI 服务、翻译、外观、关于（版本、检查更新、自检）。和桌面的 SettingsView 对应。
import { useState } from 'react'
import { Linking, ScrollView, Text, View } from 'react-native'
import { router } from 'expo-router'
import { addedLabel, sizeLabel } from '@flax/core'
import { app, useVersion } from '../../src/services'
import { look, setLook, type Look } from '../../src/actions'
import { checkUpdate, currentVersion, type UpdateCheck } from '../../src/update'
import { Button, Row } from '../../src/ui/kit'
import { ActionSheet } from '../../src/ui/sheets'
import { useTheme } from '../../src/ui/theme'

const LOOKS: [Look, string][] = [
  ['system', '跟随系统'],
  ['light', '浅色'],
  ['dark', '深色']
]
const ENGINE: Record<string, string> = { ai: 'AI 模型', tencent: '腾讯翻译君', baidu: '百度翻译', youdao: '有道智云', deepl: 'DeepL', microsoft: '微软翻译', apple: '系统翻译' }

export default function SettingsScreen() {
  const t = useTheme()
  useVersion('sync')
  useVersion('ai')
  useVersion('notice')
  const s = app()
  const [lookOpen, setLookOpen] = useState(false)
  const [update, setUpdate] = useState<UpdateCheck | 'busy' | null>(null)
  const sync = s.sync.get()
  const syncSub = !sync.config
    ? '没有开启'
    : sync.state === 'error'
      ? `出错了：${sync.error ?? ''}`
      : sync.state === 'syncing'
        ? '正在同步…'
        : sync.lastSync
          ? `${sync.config.username} · 上次同步：${addedLabel(sync.lastSync)} ${new Date(sync.lastSync).toTimeString().slice(0, 5)}`
          : sync.config.username
  const ai = s.ai.status()
  const aiSub = ai.services.length ? (ai.ready ? `${ai.services.find((x) => x.id === ai.selection?.service)?.name || ai.services[0]!.name || '已设置'} · ${ai.selection?.model ?? ''}` : '还没选模型') : '没有设置'
  const tr = ai.translate
  const trSub = `${ENGINE[tr.engine] ?? tr.engine}${tr.ready ? '' : ' · 还不能用'}`
  const cur = look()

  const check = async () => {
    setUpdate('busy')
    setUpdate(await checkUpdate())
  }

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ paddingBottom: 32 }}>
      <Group title="同步">
        <Row title="同步" sub={syncSub} onPress={() => router.push('/settings/sync')} />
      </Group>
      <Group title="AI">
        <Row title="AI 服务" sub={aiSub} onPress={() => router.push('/settings/ai')} />
        <Row title="翻译" sub={trSub} onPress={() => router.push('/settings/translate')} />
      </Group>
      <Group title="外观">
        <Row title="主题" sub={LOOKS.find((x) => x[0] === cur)![1]} onPress={() => setLookOpen(true)} />
      </Group>
      <Group title="关于">
        <Row title="Flax" sub={`版本 ${currentVersion()} · 设备 ${s.library.deviceId.slice(0, 8)}`} />
        <Row title="检查更新" sub={update === 'busy' ? '正在检查…' : !update ? '看看 GitHub 上有没有新版本' : update.kind === 'latest' ? `已经是最新版本（${update.version}）` : update.kind === 'no_apk' ? `最新的 ${update.version} 还没有 Android 安装包` : update.kind === 'error' ? update.message : `有新版本 ${update.version}${update.size ? `（${sizeLabel(update.size)}）` : ''}`} onPress={update === 'busy' ? undefined : () => void check()} />
        {update && update !== 'busy' && update.kind === 'available' ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 12, gap: 8 }}>
            {update.notes ? (
              <Text style={{ color: t.body, fontSize: 14, lineHeight: 20 }} numberOfLines={8}>
                {update.notes}
              </Text>
            ) : null}
            <Button title="用浏览器下载安装包" kind="tonal" onPress={() => void Linking.openURL(update.url)} />
            <Text style={{ color: t.sub, fontSize: 12, lineHeight: 17 }}>下载完点开安装。资料都在手机上，装新版不会丢。</Text>
          </View>
        ) : null}
        <Row title="自检" sub="检查加密、数据库和桌面版兼容" onPress={() => router.push('/settings/selftest')} />
      </Group>
      <ActionSheet open={lookOpen} onClose={() => setLookOpen(false)} title="主题" actions={LOOKS.map(([k, label]) => ({ label, checked: cur === k, onPress: () => setLook(k) }))} />
    </ScrollView>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  const t = useTheme()
  return (
    <View style={{ marginTop: 8 }}>
      <Text style={{ color: t.accentText, fontSize: 14, fontWeight: '600', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }}>{title}</Text>
      {children}
    </View>
  )
}
