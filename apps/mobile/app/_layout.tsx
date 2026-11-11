// 必须最先 import：补上 core 用到的全局接口（crypto、TextDecoder…）
import '../src/platform/polyfills'
import { useEffect } from 'react'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { Snackbar } from '../src/ui/kit'
import { PdfFactsHost } from '../src/pdfFacts'
import { useTheme } from '../src/ui/theme'
import { applyLook } from '../src/actions'
import { useIncomingShare } from '../src/share'

export default function Layout() {
  const t = useTheme()
  // 自己选的浅色/深色（设置 → 外观）
  useEffect(() => applyLook(), [])
  // 别的应用分享过来的 PDF 或链接
  useIncomingShare()
  return (
    <SafeAreaProvider>
      <StatusBar style={t.dark ? 'light' : 'dark'} />
      <View style={{ flex: 1, backgroundColor: t.bg }}>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: t.bg },
            headerTintColor: t.text,
            headerTitleStyle: { fontSize: 20, fontWeight: '600' },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: t.bg },
            animation: 'slide_from_right'
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="read/[id]" options={{ headerShown: false, animation: 'fade' }} />
        </Stack>
        <Snackbar />
        <PdfFactsHost />
      </View>
    </SafeAreaProvider>
  )
}
