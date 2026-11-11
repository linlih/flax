// 底部面板、操作菜单、一行输入的对话框。Android 没有系统的操作表，统一用这几个。
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, Text, TextInput, type TextInputInstance, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon, type IconName } from './Icon'
import { Snackbar } from './kit'
import { useTheme } from './theme'

/** 从底部滑上来的面板；键盘弹出时跟着往上挪 */
export function BottomSheet({ open, onClose, title, children, scroll = true, maxHeight = '85%' }: { open: boolean; onClose: () => void; title?: string; children: ReactNode; scroll?: boolean; maxHeight?: `${number}%` }) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  if (!open) return null
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior="height" style={{ flex: 1 }}>
        <Pressable accessibilityLabel="关闭" style={{ flex: 1, backgroundColor: t.scrim }} onPress={onClose} />
        <View style={{ maxHeight, backgroundColor: t.bg, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingTop: 10 }}>
          <View style={{ alignSelf: 'center', width: 32, height: 4, borderRadius: 2, backgroundColor: t.chipLine, marginBottom: 6 }} />
          {title ? <Text style={{ color: t.text, fontSize: 20, fontWeight: '600', paddingHorizontal: 20, paddingTop: 6 }}>{title}</Text> : null}
          {scroll ? (
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingTop: 8, paddingBottom: insets.bottom + 16 }}>
              {children}
            </ScrollView>
          ) : (
            <View style={{ paddingBottom: insets.bottom + 16, flexShrink: 1 }}>{children}</View>
          )}
        </View>
      </KeyboardAvoidingView>
      {/* 面板盖住了根上的提示条：面板里也放一个（"已复制""撤销"…） */}
      <Snackbar onlyNew />
    </Modal>
  )
}

export interface MenuAction {
  label: string
  icon?: IconName
  onPress: () => void
  danger?: boolean
  /** 打勾（单选的一组里当前那个） */
  checked?: boolean
  disabled?: boolean
}

/** 长按、"更多"弹出的操作菜单 */
export function ActionSheet({ open, onClose, title, sub, actions }: { open: boolean; onClose: () => void; title?: string; sub?: string; actions: (MenuAction | null | false)[] }) {
  const t = useTheme()
  return (
    <BottomSheet open={open} onClose={onClose} title={title}>
      {sub ? <Text style={{ color: t.sub, fontSize: 14, paddingHorizontal: 20, paddingBottom: 8 }}>{sub}</Text> : null}
      {actions.filter((a): a is MenuAction => !!a).map((a) => (
        <Pressable
          key={a.label}
          accessibilityRole="button"
          accessibilityState={{ disabled: !!a.disabled, ...(a.checked !== undefined ? { checked: a.checked } : {}) }}
          disabled={a.disabled}
          android_ripple={{ color: t.line }}
          onPress={() => {
            onClose()
            a.onPress()
          }}
          style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, opacity: a.disabled ? 0.4 : 1 }}
        >
          {a.icon ? <Icon name={a.icon} size={22} color={a.danger ? t.danger : t.body} /> : null}
          <Text style={{ flex: 1, color: a.danger ? t.danger : t.text, fontSize: 16 }}>{a.label}</Text>
          {a.checked ? <Icon name="done" size={20} color={t.accent} /> : null}
        </Pressable>
      ))}
    </BottomSheet>
  )
}

/** 填一行字：重命名、新建文件夹、写评论… */
export function Prompt({ open, title, label, initial = '', placeholder, multiline, okLabel = '保存', allowEmpty, onSubmit, onClose }: { open: boolean; title: string; label: string; initial?: string; placeholder?: string; multiline?: boolean; okLabel?: string; allowEmpty?: boolean; onSubmit: (v: string) => void; onClose: () => void }) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const [v, setV] = useState(initial)
  const input = useRef<TextInputInstance>(null)
  useEffect(() => {
    if (!open) return
    setV(initial)
    // 对话框淡入以后再聚焦，键盘才会弹出来
    const timer = setTimeout(() => input.current?.focus(), 250)
    return () => clearTimeout(timer)
  }, [open, initial])
  if (!open) return null
  const ok = allowEmpty || !!v.trim()
  const submit = () => {
    if (!ok) return
    onSubmit(v.trim())
    onClose()
  }
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      {/* 放在上半屏：键盘弹出来也挡不住按钮 */}
      <View style={{ flex: 1, backgroundColor: t.scrim, padding: 24, paddingTop: insets.top + 72 }}>
        <View style={{ backgroundColor: t.bg, borderRadius: 28, padding: 24, gap: 16 }}>
          <Text style={{ color: t.text, fontSize: 20, fontWeight: '600' }}>{title}</Text>
          <TextInput
            ref={input}
            value={v}
            onChangeText={setV}
            multiline={multiline}
            accessibilityLabel={label}
            placeholder={placeholder ?? label}
            placeholderTextColor={t.placeholder}
            onSubmitEditing={multiline ? undefined : submit}
            returnKeyType={multiline ? 'default' : 'done'}
            style={{ color: t.text, fontSize: 16, minHeight: multiline ? 96 : 48, textAlignVertical: multiline ? 'top' : 'center', borderBottomWidth: 2, borderBottomColor: t.accent }}
          />
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
            <Text accessibilityRole="button" onPress={onClose} style={{ color: t.accentText, fontSize: 15, fontWeight: '600', padding: 12 }}>
              取消
            </Text>
            <Text accessibilityRole="button" accessibilityState={{ disabled: !ok }} onPress={submit} style={{ color: ok ? t.accentText : t.placeholder, fontSize: 15, fontWeight: '600', padding: 12 }}>
              {okLabel}
            </Text>
          </View>
        </View>
      </View>
    </Modal>
  )
}

/** 面板里的一行选项（带勾） */
export function OptionRow({ label, sub, checked, onPress, icon }: { label: string; sub?: string; checked?: boolean; onPress: () => void; icon?: ReactNode }) {
  const t = useTheme()
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ checked: !!checked }} onPress={onPress} android_ripple={{ color: t.line }} style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 8 }}>
      {icon}
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.text, fontSize: 16 }}>{label}</Text>
        {sub ? <Text style={{ color: t.sub, fontSize: 13 }}>{sub}</Text> : null}
      </View>
      {checked ? <Icon name="done" size={20} color={t.accent} /> : null}
    </Pressable>
  )
}
