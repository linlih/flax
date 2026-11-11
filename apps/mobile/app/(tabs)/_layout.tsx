// 底部 4 个标签：文献库、笔记、术语、设置（和桌面侧栏对应，见 docs/11 第 11 节）
import { Tabs } from 'expo-router'
import { View } from 'react-native'
import { Icon, type IconName } from '../../src/ui/Icon'
import { useTheme } from '../../src/ui/theme'

const ICON: Record<string, IconName> = { index: 'library', notes: 'notes', terms: 'terms', settings: 'settings' }

export default function TabsLayout() {
  const t = useTheme()
  return (
    <Tabs
      screenOptions={({ route }) => ({
        headerStyle: { backgroundColor: t.bg },
        headerTintColor: t.text,
        headerTitleStyle: { fontSize: 22, fontWeight: '600' },
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: t.bg },
        tabBarStyle: { backgroundColor: t.bar, borderTopWidth: 0, height: 80, paddingTop: 8, elevation: 0 },
        tabBarActiveTintColor: t.text,
        tabBarInactiveTintColor: t.body,
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600', marginTop: 4 },
        tabBarIcon: ({ focused }) => (
          <View style={{ width: 64, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: focused ? t.container : 'transparent' }}>
            <Icon name={ICON[route.name] ?? 'file'} size={22} color={focused ? t.onContainer : t.body} />
          </View>
        )
      })}
    >
      <Tabs.Screen name="index" options={{ title: '文献库' }} />
      <Tabs.Screen name="notes" options={{ title: '笔记' }} />
      <Tabs.Screen name="terms" options={{ title: '术语' }} />
      <Tabs.Screen name="settings" options={{ title: '设置' }} />
    </Tabs>
  )
}
