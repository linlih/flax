// 几个通用控件，按手机原型（Material 3）的尺寸：触控区至少 48dp，圆角按钮 52 高，描边输入框 56 高。
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, TextInput, View, type TextInputInstance, type TextInputProps, type ViewStyle } from 'react-native'
import { router } from 'expo-router'
import { currentNotice, useVersion } from '../services'
import { useTheme } from './theme'
import { Icon, type IconName } from './Icon'

export function IconButton({ icon, label, onPress, color, size = 22 }: { icon: IconName; label: string; onPress: () => void; color?: string; size?: number }) {
  const t = useTheme()
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={4} android_ripple={{ color: t.line, borderless: true, radius: 24 }} style={styles.iconBtn}>
      <Icon name={icon} size={size} color={color ?? t.text} />
    </Pressable>
  )
}

export function Button({ title, onPress, kind = 'filled', busy, disabled, style }: { title: string; onPress: () => void; kind?: 'filled' | 'tonal' | 'outline' | 'text' | 'danger'; busy?: boolean; disabled?: boolean; style?: ViewStyle }) {
  const t = useTheme()
  const bg = kind === 'filled' ? t.accent : kind === 'tonal' ? t.container : 'transparent'
  const fg = kind === 'filled' ? t.onAccent : kind === 'tonal' ? t.onContainer : kind === 'danger' ? t.danger : t.accentText
  const off = disabled || busy
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      disabled={off}
      onPress={onPress}
      android_ripple={{ color: t.dark ? '#ffffff22' : '#00000018' }}
      style={[styles.btn, { backgroundColor: bg, opacity: off && !busy ? 0.45 : 1 }, kind === 'outline' || kind === 'danger' ? { borderWidth: 1, borderColor: kind === 'danger' ? t.danger : t.outline } : null, style]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[styles.btnText, { color: fg }]}>{title}</Text>}
    </Pressable>
  )
}

/** 描边输入框，标签压在边框上 */
export function Field({ label, hint, error, autoFocus, ...rest }: TextInputProps & { label: string; hint?: string; error?: string }) {
  const t = useTheme()
  const [focus, setFocus] = useState(false)
  // 底部面板、对话框里的 autoFocus 在弹出动画结束前触发，键盘不出来：等动画完再聚焦
  const input = useRef<TextInputInstance>(null)
  useEffect(() => {
    if (!autoFocus) return
    const timer = setTimeout(() => input.current?.focus(), 350)
    return () => clearTimeout(timer)
  }, [autoFocus])
  const color = error ? t.danger : focus ? t.accent : t.outline
  return (
    <View style={{ gap: 4 }}>
      <View>
        <TextInput
          ref={input}
          accessibilityLabel={label}
          {...rest}
          onFocus={(e) => {
            setFocus(true)
            rest.onFocus?.(e)
          }}
          onBlur={(e) => {
            setFocus(false)
            rest.onBlur?.(e)
          }}
          placeholderTextColor={t.placeholder}
          style={[styles.field, { borderColor: color, borderWidth: focus ? 2 : 1, color: t.text, paddingHorizontal: focus ? 15 : 16 }, rest.multiline ? { height: undefined, minHeight: 56, paddingVertical: 14, textAlignVertical: 'top' } : null]}
        />
        <Text importantForAccessibility="no" pointerEvents="none" style={[styles.fieldLabel, { backgroundColor: t.bg, color: focus ? t.accent : error ? t.danger : t.body }]}>{label}</Text>
      </View>
      {error ? <Text style={[styles.hint, { color: t.danger }]}>{error}</Text> : hint ? <Text style={[styles.hint, { color: t.sub }]}>{hint}</Text> : null}
    </View>
  )
}

export function Chip({ label, onPress, selected, dashed, color, onLongPress }: { label: string; onPress?: () => void; selected?: boolean; dashed?: boolean; color?: string; onLongPress?: () => void }) {
  const t = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!onPress && !onLongPress}
      style={[styles.chip, selected ? { backgroundColor: t.container, borderColor: t.container } : { borderColor: dashed ? t.placeholder : t.chipLine, borderStyle: dashed ? 'dashed' : 'solid' }]}
    >
      {color ? <View style={[styles.dot, { backgroundColor: color }]} /> : null}
      <Text style={{ color: selected ? t.onContainer : dashed ? t.sub : t.body, fontSize: 14, fontWeight: selected ? '600' : '400' }}>{label}</Text>
    </Pressable>
  )
}

/** 顶部的分段标签（在读 / 待读 / 全部） */
export function Tabs<K extends string>({ tabs, value, onChange }: { tabs: { key: K; label: string }[]; value: K; onChange: (k: K) => void }) {
  const t = useTheme()
  return (
    <View accessibilityRole="tablist" style={[styles.tabs, { borderColor: t.line }]}>
      {tabs.map((tab) => {
        const on = tab.key === value
        return (
          <Pressable key={tab.key} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => onChange(tab.key)} style={[styles.tab, on ? { borderBottomColor: t.accent } : null]}>
            <Text style={{ color: on ? t.accentText : t.body, fontWeight: on ? '600' : '400', fontSize: 15 }}>{tab.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export function Row({ title, sub, onPress, right, danger }: { title: string; sub?: string; onPress?: () => void; right?: ReactNode; danger?: boolean }) {
  const t = useTheme()
  return (
    <Pressable accessibilityRole={onPress ? 'button' : undefined} onPress={onPress} disabled={!onPress} android_ripple={{ color: t.line }} style={styles.row}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: danger ? t.danger : t.text, fontSize: 16 }}>{title}</Text>
        {sub ? <Text style={{ color: t.sub, fontSize: 13 }}>{sub}</Text> : null}
      </View>
      {right ?? (onPress ? <Icon name="chevron" color={t.sub} /> : null)}
    </Pressable>
  )
}

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  const t = useTheme()
  return (
    <View>
      <View style={styles.sectionHead}>
        <Text style={{ color: t.text, fontSize: 15, fontWeight: '600', flex: 1 }}>{title}</Text>
        {action}
      </View>
      {children}
    </View>
  )
}

export function Empty({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  const t = useTheme()
  return (
    <View style={styles.empty}>
      <Text style={{ color: t.text, fontSize: 17, fontWeight: '600', textAlign: 'center' }}>{title}</Text>
      {sub ? <Text style={{ color: t.sub, fontSize: 14, textAlign: 'center', lineHeight: 20 }}>{sub}</Text> : null}
      {children}
    </View>
  )
}

/** 屏幕底部的一条提示，几秒后自己消失；带论文的点一下打开，带操作的（撤销）点一下执行 */
/** bottom：离底边多远（默认在底部标签栏和右下角"添加"按钮的上面，不挡按钮）。
 *  onlyNew：面板里的那份只显示面板打开以后出的提示，不把之前的"撤销"盖在面板的选项上 */
export function Snackbar({ bottom = 164, onlyNew = false }: { bottom?: number; onlyNew?: boolean } = {}) {
  const t = useTheme()
  useVersion('notice')
  const since = useRef(onlyNew ? (currentNotice()?.id ?? 0) : -1).current
  const latest = currentNotice()
  const n = latest && latest.id > since ? latest : null
  const [shown, setShown] = useState<typeof n>(null)
  const fade = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (!n || n.id === shown?.id) return
    setShown(n)
    fade.setValue(0)
    Animated.timing(fade, { toValue: 1, duration: 150, useNativeDriver: true }).start()
    // 带"撤销"这类操作的多留一会儿，来得及点
    const timer = setTimeout(() => Animated.timing(fade, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => setShown(null)), n.action ? 8000 : 4000)
    return () => clearTimeout(timer)
  }, [n?.id])
  if (!shown) return null
  return (
    <Animated.View pointerEvents="box-none" style={[styles.snackWrap, { bottom, opacity: fade }]}>
      <Pressable
        accessibilityLiveRegion="polite"
        onPress={() => {
          if (shown.action) shown.action.run()
          else if (shown.paperId) router.push(`/paper/${shown.paperId}`)
          setShown(null)
        }}
        style={[styles.snack, { backgroundColor: t.dark ? '#E6E6E6' : '#2B2B2E' }]}
      >
        <Text style={{ color: t.dark ? '#111' : '#fff', fontSize: 14, flex: 1 }}>{shown.text}</Text>
        {shown.action || shown.paperId ? <Text style={{ color: t.dark ? '#155DFC' : '#8AB4FF', fontWeight: '600' }}>{shown.action?.label ?? '打开'}</Text> : null}
      </Pressable>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  iconBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 24 },
  btn: { height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, overflow: 'hidden' },
  btnText: { fontSize: 16, fontWeight: '600' },
  field: { height: 56, borderRadius: 4, fontSize: 16 },
  fieldLabel: { position: 'absolute', left: 12, top: -9, paddingHorizontal: 4, fontSize: 12 },
  hint: { fontSize: 12, paddingHorizontal: 16, lineHeight: 17 },
  chip: { height: 32, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  tabs: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  tab: { flex: 1, height: 48, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 3, borderBottomColor: 'transparent' },
  row: { minHeight: 56, paddingHorizontal: 16, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 12 },
  sectionHead: { minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
  empty: { padding: 32, gap: 8, alignItems: 'center' },
  // 在底部标签栏（80 高）上面
  snackWrap: { position: 'absolute', left: 12, right: 12, bottom: 92 },
  snack: { minHeight: 48, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12, elevation: 6 }
})
