// 设置：同步、AI 服务、翻译、外观、关于（版本、检查更新、自检）。和桌面的 SettingsView 对应。
import { useEffect, useRef, useState } from 'react'
import { AppState, Linking, Platform, ScrollView, Text, View } from 'react-native'
import { router } from 'expo-router'
import { addedLabel, sizeLabel } from '@flax/core'
import { app, useVersion } from '../../src/services'
import { look, setLook, type Look } from '../../src/actions'
import { checkUpdate, currentVersion, inAppUpdate, type UpdateCheck } from '../../src/update'
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
        <Row title="检查更新" sub={update === 'busy' ? '正在检查…' : !update ? '看看 GitHub 上有没有新版本' : update.kind === 'latest' ? `已经是最新版本（${update.version}）` : update.kind === 'no_apk' ? `最新的 ${update.version} 还没有${Platform.OS === 'ios' ? ' iOS ' : ' Android '}安装包` : update.kind === 'error' ? update.message : `有新版本 ${update.version}${update.size ? `（${sizeLabel(update.size)}）` : ''}`} onPress={update === 'busy' ? undefined : () => void check()} />
        {update && update !== 'busy' && update.kind === 'available' ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 12, gap: 8 }}>
            {update.notes ? (
              <Text style={{ color: t.body, fontSize: 14, lineHeight: 20 }} numberOfLines={8}>
                {update.notes}
              </Text>
            ) : null}
            {inAppUpdate ? (
              <InstallUpdate url={update.url} version={update.version} size={update.size} />
            ) : (
              <>
                <Button title="用浏览器下载安装包" kind="tonal" onPress={() => void Linking.openURL(update.url)} />
                <Text style={{ color: t.sub, fontSize: 12, lineHeight: 17 }}>{Platform.OS === 'ios' ? '下载完用 AltStore 或 Sideloadly 装上（和第一次装一样）。资料都在手机上，装新版不会丢。' : '下载完点开安装。资料都在手机上，装新版不会丢。'}</Text>
              </>
            )}
          </View>
        ) : null}
        <Row title="自检" sub="检查加密、数据库和桌面版兼容" onPress={() => router.push('/settings/selftest')} />
      </Group>
      <ActionSheet open={lookOpen} onClose={() => setLookOpen(false)} title="主题" actions={LOOKS.map(([k, label]) => ({ label, checked: cur === k, onPress: () => setLook(k) }))} />
    </ScrollView>
  )
}

type Dl = { state: 'idle' } | { state: 'downloading'; done: number; total: number } | { state: 'ready'; path: string } | { state: 'error'; message: string }

/** Android：在应用里下载新版本的安装包，下好交给系统安装（不用去浏览器） */
function InstallUpdate({ url, version, size }: { url: string; version: string; size?: number }) {
  const t = useTheme()
  const native = inAppUpdate!
  const [dl, setDl] = useState<Dl>({ state: 'idle' })
  const [hint, setHint] = useState<string | null>(null)
  // 去系统设置里允许"安装未知应用"了：回来后接着装
  const askedPermission = useRef<string | null>(null)

  const install = async (path: string) => {
    setHint(null)
    try {
      const r = await native.install(path)
      if (r === 'permission') {
        askedPermission.current = path
        setHint('在打开的设置里允许 Flax 安装应用，回来后会接着安装。')
      }
    } catch (e) {
      setHint(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      const path = askedPermission.current
      if (st !== 'active' || !path) return
      askedPermission.current = null
      if (native.canInstall()) void install(path)
      else setHint('还没允许安装应用：再点一次"安装"，在设置里打开"允许来自此来源的应用"。')
    })
    return () => sub.remove()
  }, [])

  useEffect(() => () => native.cancel(), [])

  const download = async () => {
    setHint(null)
    setDl({ state: 'downloading', done: 0, total: size ?? 0 })
    const sub = native.addListener('progress', (p) => setDl({ state: 'downloading', done: p.done, total: p.total || size || 0 }))
    try {
      const path = await native.download(url, `flax-${version}.apk`)
      setDl({ state: 'ready', path })
      void install(path)
    } catch (e) {
      const code = (e as { code?: string }).code
      setDl(code === 'cancelled' ? { state: 'idle' } : { state: 'error', message: e instanceof Error ? e.message.replace(/^.*?(Error|Exception):\s*/, '') : String(e) })
    } finally {
      sub.remove()
    }
  }

  const pct = dl.state === 'downloading' && dl.total > 0 ? Math.min(1, dl.done / dl.total) : 0
  return (
    <View style={{ gap: 8 }}>
      {dl.state === 'downloading' ? (
        <View style={{ gap: 6 }}>
          <View style={{ height: 6, borderRadius: 3, backgroundColor: t.surface, overflow: 'hidden' }}>
            <View style={{ width: `${pct * 100}%`, height: '100%', backgroundColor: t.accent }} />
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ color: t.sub, fontSize: 13 }}>
              正在下载 {sizeLabel(dl.done)}
              {dl.total ? ` / ${sizeLabel(dl.total)}` : ''}
            </Text>
            <Text style={{ color: t.accentText, fontSize: 14, padding: 4 }} onPress={() => native.cancel()}>
              取消
            </Text>
          </View>
        </View>
      ) : dl.state === 'ready' ? (
        <Button title="安装" onPress={() => void install(dl.path)} />
      ) : (
        <Button title={dl.state === 'error' ? '重新下载' : `下载并安装${size ? `（${sizeLabel(size)}）` : ''}`} onPress={() => void download()} />
      )}
      {dl.state === 'error' ? <Text style={{ color: t.danger, fontSize: 13, lineHeight: 18 }}>{dl.message}</Text> : null}
      {hint ? <Text style={{ color: t.body, fontSize: 13, lineHeight: 18 }}>{hint}</Text> : null}
      <Text style={{ color: t.sub, fontSize: 12, lineHeight: 17 }}>
        从 GitHub 下载，下好直接打开系统的安装界面。资料都在手机上，装新版不会丢。
        {dl.state === 'error' ? (
          <Text style={{ color: t.accentText }} onPress={() => void Linking.openURL(url)}>
            {' '}
            也可以用浏览器下载
          </Text>
        ) : null}
      </Text>
    </View>
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
