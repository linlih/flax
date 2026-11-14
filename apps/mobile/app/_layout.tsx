// 必须最先 import：补上 core 用到的全局接口（crypto、TextDecoder…）
import '../src/platform/polyfills'
import { useEffect, useState } from 'react'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { Text, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { Snackbar } from '../src/ui/kit'
import { PdfFactsHost } from '../src/pdfFacts'
import { useTheme } from '../src/ui/theme'
import { applyLook } from '../src/actions'
import { useIncomingShare } from '../src/share'
import { openProblem } from '../src/services'

export default function Layout() {
  const t = useTheme()
  // 资料库打不开（更新版本的 Flax 建的）：只显示提示，别的都不碰
  const [problem] = useState(openProblem)
  // 自己选的浅色/深色（设置 → 外观）
  useEffect(() => applyLook(), [])
  // 别的应用分享过来的 PDF 或链接
  useIncomingShare(!problem)
  if (problem)
    return (
      <SafeAreaProvider>
        <StatusBar style={t.dark ? 'light' : 'dark'} />
        <View style={{ flex: 1, backgroundColor: t.bg, justifyContent: 'center', padding: 32, gap: 12 }}>
          <Text style={{ color: t.text, fontSize: 22, fontWeight: '600' }}>打不开资料库</Text>
          <Text style={{ color: t.body, fontSize: 16, lineHeight: 24 }}>{problem}</Text>
          <Text style={{ color: t.sub, fontSize: 14, lineHeight: 21 }}>手机上的论文、批注和笔记都还在，没有改动。装上最新版本后就能打开。</Text>
        </View>
      </SafeAreaProvider>
    )
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
            // iOS 的返回按钮默认带上一页的名字（这里会是"(tabs)"）：只留箭头，和 Android 一样
            headerBackButtonDisplayMode: 'minimal',
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
