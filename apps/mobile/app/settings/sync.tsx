// 设置 › 同步。没开启时：填坚果云（或其他 WebDAV）账号 → 先连一下看那里有没有同步库 →
// 有就输入当时的同步密码加入，没有就设一个新的同步密码建库。开启后显示状态、立即同步、停用。
import { useState } from 'react'
import { Alert, KeyboardAvoidingView, ScrollView, Text, View } from 'react-native'
import { Stack } from 'expo-router'
import { addedLabel, plainHttp, PLAIN_HTTP_HINT } from '@flax/core'
import { app, useVersion } from '../../src/services'
import { JIANGUOYUN } from '../../src/sync'
import { Button, Chip, Field } from '../../src/ui/kit'
import { useTheme } from '../../src/ui/theme'

type Probe = { exists: boolean; encrypted: boolean }

export default function SyncSettings() {
  const t = useTheme()
  useVersion('sync')
  const s = app()
  const st = s.sync.get()
  return (
    <KeyboardAvoidingView behavior="height" style={{ flex: 1, backgroundColor: t.bg }}>
      <Stack.Screen options={{ title: '同步' }} />
      {st.config ? <Connected /> : <Connect />}
    </KeyboardAvoidingView>
  )
}

function Connected() {
  const t = useTheme()
  const s = app()
  const st = s.sync.get()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const now = async () => {
    setBusy(true)
    setErr('')
    try {
      await s.sync.syncNow()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const stop = () =>
    Alert.alert('在这台手机上停用同步？', '云端和别的设备上的数据不动。这台手机上已有的论文、批注和笔记也留着。', [
      { text: '取消', style: 'cancel' },
      { text: '停用', style: 'destructive', onPress: () => void s.sync.disconnect() }
    ])
  const state = st.state === 'syncing' ? '正在同步…' : st.state === 'error' ? '出错了' : st.lastSync ? `上次同步：${addedLabel(st.lastSync)} ${new Date(st.lastSync).toTimeString().slice(0, 5)}` : '还没同步过'
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      <View style={{ backgroundColor: t.surface, borderRadius: 16, padding: 16, gap: 6 }}>
        <Text style={{ color: t.text, fontSize: 17, fontWeight: '600' }}>{st.config!.url === JIANGUOYUN ? '坚果云' : 'WebDAV'}</Text>
        <Text selectable style={{ color: t.body, fontSize: 14 }}>{st.config!.username}</Text>
        <Text selectable style={{ color: t.sub, fontSize: 13 }}>
          {st.config!.url}
          {st.config!.folder}
        </Text>
        <Text style={{ color: t.sub, fontSize: 13 }}>{st.encrypted ? '端到端加密：云端只存加密后的数据' : '没有加密'}</Text>
        <Text style={{ color: st.state === 'error' ? t.danger : t.body, fontSize: 14, marginTop: 4 }}>{state}</Text>
        {st.files?.left ? <Text style={{ color: t.sub, fontSize: 13 }}>还有 {st.files.left} 个 PDF 要上传</Text> : null}
        {st.state === 'error' && st.error ? <Text style={{ color: t.danger, fontSize: 13 }}>{st.error}</Text> : null}
        {err && err !== st.error ? <Text style={{ color: t.danger, fontSize: 13 }}>{err}</Text> : null}
      </View>
      <Text style={{ color: t.sub, fontSize: 13, lineHeight: 19 }}>论文信息、批注、笔记、AI 对话随时同步。别的设备加的 PDF 不自动下载，打开时才下载，省手机空间。</Text>
      <Button title="立即同步" onPress={() => void now()} busy={busy || st.state === 'syncing'} />
      <Button title="停用同步" kind="danger" onPress={stop} />
    </ScrollView>
  )
}

function Connect() {
  const t = useTheme()
  const s = app()
  const [kind, setKind] = useState<'jgy' | 'dav'>('jgy')
  const [url, setUrl] = useState('')
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [folder, setFolder] = useState('Flax')
  const [probe, setProbe] = useState<Probe | null>(null)
  const [syncPass, setSyncPass] = useState('')
  const [syncPass2, setSyncPass2] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const conn = () => ({ url: kind === 'jgy' ? JIANGUOYUN : url.trim(), username: user, password: pass, folder })
  const reset = () => {
    setProbe(null)
    setErr('')
  }

  const check = async () => {
    setBusy(true)
    setErr('')
    try {
      setProbe(await s.sync.probe(conn()))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const join = async () => {
    if (!probe) return
    if (!probe.exists && syncPass && syncPass !== syncPass2) return setErr('两次输入的同步密码不一样')
    if (!probe.exists && syncPass && syncPass.length < 8) return setErr('同步密码至少 8 个字')
    setBusy(true)
    setErr('')
    try {
      await s.sync.connect(conn(), probe.encrypted || (!probe.exists && syncPass) ? syncPass : null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const ready = user.trim() && pass && (kind === 'jgy' || /^https?:\/\//.test(url.trim()))

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 20 }} keyboardShouldPersistTaps="handled">
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Chip label="坚果云" selected={kind === 'jgy'} onPress={() => (setKind('jgy'), reset())} />
        <Chip label="其他 WebDAV" selected={kind === 'dav'} onPress={() => (setKind('dav'), reset())} />
      </View>
      {kind === 'dav' ? <Field label="服务器地址" value={url} onChangeText={(x) => (setUrl(x), reset())} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="https://nas.example.com/dav/" hint={plainHttp(url) ? PLAIN_HTTP_HINT : undefined} /> : null}
      <Field label={kind === 'jgy' ? '坚果云账号' : '用户名'} value={user} onChangeText={(x) => (setUser(x), reset())} autoCapitalize="none" autoCorrect={false} keyboardType={kind === 'jgy' ? 'email-address' : 'default'} textContentType="username" />
      <Field
        label={kind === 'jgy' ? '应用密码' : '密码'}
        value={pass}
        onChangeText={(x) => (setPass(x), reset())}
        secureTextEntry
        autoCapitalize="none"
        hint={kind === 'jgy' ? '坚果云网页版 › 账户信息 › 安全选项 › 第三方应用管理，添加一个应用密码。不是登录密码。' : undefined}
      />
      {kind === 'dav' ? <Field label="文件夹" value={folder} onChangeText={(x) => (setFolder(x), reset())} autoCapitalize="none" autoCorrect={false} /> : null}

      {probe ? (
        probe.exists ? (
          probe.encrypted ? (
            <Field label="同步密码" value={syncPass} onChangeText={setSyncPass} secureTextEntry autoFocus importantForAutofill="no" autoComplete="off" placeholder="在电脑上设置的那个" hint="同步密码不是坚果云的密码。这台手机的资料会和云端合并，不会丢东西。" />
          ) : (
            <Text style={{ color: t.body, fontSize: 14 }}>这里有一个没加密的 Flax 同步库，加入后这台手机的资料会和它合并。</Text>
          )
        ) : (
          <View style={{ gap: 16 }}>
            <Text style={{ color: t.body, fontSize: 14, lineHeight: 20 }}>那里还没有 Flax 同步库，会新建一个。设一个同步密码：云端只存加密后的数据，别的设备加入时要输入它。忘了就找不回来。</Text>
            <Field label="同步密码" value={syncPass} onChangeText={setSyncPass} secureTextEntry importantForAutofill="no" autoComplete="off" hint="至少 8 个字。留空就不加密。" />
            {syncPass ? <Field label="再输入一次" value={syncPass2} onChangeText={setSyncPass2} secureTextEntry importantForAutofill="no" autoComplete="off" /> : null}
          </View>
        )
      ) : null}
      {probe && !err ? <Text style={{ color: t.ok, fontSize: 13 }}>已连上{probe.exists ? `。这里有一个${probe.encrypted ? '加密的' : ''} Flax 同步库。` : '。'}</Text> : null}
      {err ? <Text style={{ color: t.danger, fontSize: 14 }}>{err}</Text> : null}
      {probe ? (
        <Button title={probe.exists ? '加入同步' : '开启同步'} onPress={() => void join()} busy={busy} disabled={probe.encrypted && !syncPass} />
      ) : (
        <Button title="连接" onPress={() => void check()} busy={busy} disabled={!ready} />
      )}
      {busy && probe?.encrypted ? <Text style={{ color: t.sub, fontSize: 13, textAlign: 'center' }}>正在用同步密码解锁，要几秒钟…</Text> : null}
    </ScrollView>
  )
}
