// 设置 › AI 服务：加一家服务（填 Key），连上后选模型。Key 存在 Android Keystore 里（expo-secure-store）。
// 规则都在 core 的 AiSettings / AiService，这里只是界面。
import { useEffect, useMemo, useState } from 'react'
import { Alert, KeyboardAvoidingView, Modal, Pressable, ScrollView, Text, View } from 'react-native'
import { Stack } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AI_VENDORS, vendorOf, type AiModel } from '@flax/core'
import { app, useVersion } from '../../src/services'
import { Button, Field, Row } from '../../src/ui/kit'
import { useTheme } from '../../src/ui/theme'

export default function AiSettings() {
  const t = useTheme()
  useVersion('ai')
  const s = app()
  const st = s.ai.status()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<{ id?: string; vendor: string } | null>(null)
  const sel = st.selection

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ paddingBottom: 48 }}>
      <Stack.Screen options={{ title: 'AI 服务' }} />
      <Text style={{ color: t.sub, fontSize: 13, lineHeight: 19, padding: 16 }}>
        问 AI 和翻译用你自己的 Key，直接从手机连到服务商，不经过别的服务器。只发你选中的文字和问题，不会把整篇论文发出去。
      </Text>
      {st.services.map((svc) => (
        <Row
          key={svc.id}
          title={svc.name || vendorOf(svc.vendor)?.name || svc.vendor}
          sub={svc.hasKey || vendorOf(svc.vendor)?.keyOptional ? (sel?.service === svc.id ? `正在用 · ${sel.model}` : '已填 Key') : '还没有填 Key'}
          onPress={() => setEditing({ id: svc.id, vendor: svc.vendor })}
        />
      ))}
      <View style={{ padding: 16 }}>
        <Button title="添加服务" kind="tonal" onPress={() => setAdding(true)} />
      </View>
      {adding ? <AddService onClose={() => setAdding(false)} onPick={(vendor) => (setAdding(false), setEditing({ vendor }))} /> : null}
      {editing ? <EditService start={editing} onClose={() => setEditing(null)} /> : null}
    </ScrollView>
  )
}

function AddService({ onClose, onPick }: { onClose: () => void; onPick: (vendor: string) => void }) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const taken = new Set(app().ai.status().services.map((x) => x.vendor))
  const groups = ['国际', '国内', '其他'] as const
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable accessibilityLabel="关闭" style={{ flex: 1, backgroundColor: t.scrim }} onPress={onClose} />
      <View style={{ maxHeight: '75%', backgroundColor: t.bg, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingTop: 16 }}>
        <Text style={{ color: t.text, fontSize: 20, fontWeight: '600', paddingHorizontal: 20, paddingBottom: 8 }}>选一家服务</Text>
        <ScrollView contentContainerStyle={{ paddingBottom: 16 + insets.bottom }}>
          {groups.map((g) => (
            <View key={g}>
              <Text style={{ color: t.accentText, fontSize: 13, fontWeight: '600', paddingHorizontal: 20, paddingTop: 12 }}>{g}</Text>
              {AI_VENDORS.filter((v) => v.group === g && (v.id === 'custom' || !taken.has(v.id))).map((v) => (
                <Row
                  key={v.id}
                  title={v.name}
                  onPress={() => onPick(v.id)}
                />
              ))}
            </View>
          ))}
        </ScrollView>
      </View>
    </Modal>
  )
}

// 新加的服务（start.id 为空）先填好再保存，保存时才真正加进去
function EditService({ start, onClose }: { start: { id?: string; vendor: string }; onClose: () => void }) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const s = app()
  const [id, setId] = useState(start.id)
  const saved = id ? s.aiSettings.service(id) : null
  const svc = saved ?? { vendor: start.vendor, name: '', baseUrl: '', hasKey: false }
  const vendor = vendorOf(svc.vendor)
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(svc.baseUrl ?? '')
  const [models, setModels] = useState<AiModel[] | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('')
  const sel = s.ai.status().selection

  const load = async (sid: string, refresh = false) => {
    setBusy(true)
    setErr('')
    const r = await s.ai.models(sid, refresh)
    setBusy(false)
    if (r.ok) setModels(r.models)
    else setErr(r.message)
  }
  useEffect(() => {
    if (id && (svc.hasKey || vendor?.keyOptional)) void load(id)
  }, [])

  const shown = useMemo(() => (models ?? []).filter((m) => !filter.trim() || m.id.toLowerCase().includes(filter.trim().toLowerCase())).slice(0, 60), [models, filter])
  if (!vendor) return null

  const save = async () => {
    try {
      const sid = s.ai.saveService({ ...(id ? { id } : {}), vendor: svc.vendor, name: svc.name, baseUrl: baseUrl.trim() }, key.trim() ? key : undefined)
      setId(sid)
      setKey('')
      await load(sid, true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }
  const remove = () =>
    Alert.alert(`删除 ${vendor.name}？`, '这台手机上存的 Key 一起删掉。', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          if (id) s.ai.removeService(id)
          onClose()
        }
      }
    ])

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior="height" style={{ flex: 1 }}>
        <Pressable accessibilityLabel="关闭" style={{ flex: 1, backgroundColor: t.scrim }} onPress={onClose} />
        <View style={{ maxHeight: '85%', backgroundColor: t.bg, borderTopLeftRadius: 28, borderTopRightRadius: 28 }}>
          <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 20 + insets.bottom, gap: 16 }} keyboardShouldPersistTaps="handled">
            <Text style={{ color: t.text, fontSize: 20, fontWeight: '600' }}>{svc.name || vendor.name}</Text>
            {vendor.id === 'custom' || vendor.id === 'ollama' ? <Field label="服务地址" value={baseUrl} onChangeText={setBaseUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder={vendor.baseUrl || 'https://…/v1'} /> : null}
            <Field label="API Key" value={key} onChangeText={setKey} secureTextEntry autoCapitalize="none" autoCorrect={false} importantForAutofill="no" placeholder={svc.hasKey ? '已保存（填新的会替换）' : vendor.keyOptional ? '可以不填' : ''} hint="只存在这台手机上，用 Android 的密钥库加密。" />
            <Button title={svc.hasKey ? '保存并重新连接' : '保存并连接'} onPress={() => void save()} busy={busy} disabled={(!key.trim() && !svc.hasKey && !vendor.keyOptional) || (vendor.id === 'custom' && !baseUrl.trim())} />
            {err ? <Text style={{ color: t.danger, fontSize: 14 }}>{err}</Text> : null}
            {models ? (
              <View style={{ gap: 4 }}>
                <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>选模型</Text>
                {models.length > 8 ? <Field label="筛选" value={filter} onChangeText={setFilter} autoCapitalize="none" autoCorrect={false} /> : null}
                {shown.map((m) => {
                  const on = !!id && sel?.service === id && sel?.model === m.id
                  return (
                    <Pressable
                      key={m.id}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: on }}
                      onPress={() => id && s.ai.select({ service: id, model: m.id })}
                      style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 4 }}
                    >
                      <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: on ? t.accent : t.outline, alignItems: 'center', justifyContent: 'center' }}>{on ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: t.accent }} /> : null}</View>
                      <Text style={{ color: t.text, fontSize: 15, flex: 1 }}>{m.name || m.id}</Text>
                    </Pressable>
                  )
                })}
              </View>
            ) : null}
            {id ? <Button title="删除这个服务" kind="danger" onPress={remove} /> : null}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}
