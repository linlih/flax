// 别的应用（浏览器、文件、微信…）分享过来的东西：PDF 导入；文字或链接里有 DOI / arXiv 编号就按"粘贴链接"添加。
// 配置在 app.json 的 expo-sharing 插件里（接收 application/pdf 和 text/plain）。
// iOS 要另做一个分享扩展（app group），还没做：iOS 上不接收，调用会报错。
import { useEffect, useRef } from 'react'
import { Platform } from 'react-native'
import { File } from 'expo-file-system'
import { useIncomingShare as useExpoShare } from 'expo-sharing'
import { router } from 'expo-router'
import { app, showNotice } from './services'
import { importFiles } from './importPdf'

/**
 * 只在 Android 上接收：Platform.OS 在运行时不变，钩子调用的顺序稳定。
 * enabled 为 false 时（资料库打不开）收到了也不处理
 */
export const useIncomingShare: (enabled?: boolean) => void = Platform.OS === 'android' ? useIncomingShareHandler : () => {}

function useIncomingShareHandler(enabled = true): void {
  const { sharedPayloads, resolvedSharedPayloads, clearSharedPayloads, isResolving, error } = useExpoShare()
  // 同一批只处理一次（解析完会再渲染一遍）；同样的内容再分享一次是新的一批，照样处理
  const handled = useRef<unknown>(null)

  useEffect(() => {
    if (!enabled || isResolving || !sharedPayloads.length || handled.current === sharedPayloads) return
    // 文件要等解析完（expo-sharing 会拷一份到缓存目录，给出文件名）；刚启动的第一帧还没开始解析
    if (sharedPayloads.some((p) => p.shareType !== 'text' && p.shareType !== 'url') && !resolvedSharedPayloads.length && !error) return
    handled.current = sharedPayloads
    const files: { uri: string; name: string }[] = []
    const texts: string[] = []
    for (const p of sharedPayloads) {
      if (p.shareType === 'text' || p.shareType === 'url') texts.push(p.value)
      else {
        const r = resolvedSharedPayloads.find((x) => x.value === p.value)
        // 解析出来的是 file:/data/…（只有一个斜杠），File 认 file:///data/…
        const cached = r?.contentUri ? new File(r.contentUri.replace(/^file:\/(?!\/)/, 'file:///')) : null
        // 拷贝失败时（expo-sharing 不报错，只是没有文件）直接读分享方给的 content:// 地址
        files.push({ uri: cached?.exists ? cached.uri : p.value, name: r?.originalName ?? '' })
      }
    }
    if (!files.length && !texts.length) return
    router.dismissTo('/')
    void (async () => {
      // 先导入再清：清的时候 expo-sharing 会删掉它拷到缓存里的那份
      if (files.length) await importFiles(files.map((f) => new File(f.uri)), files.map((f) => f.name))
      clearSharedPayloads()
      for (const text of texts) {
        try {
          const ok = await app().importer.addFromText(text)
          if (!ok) showNotice('分享过来的内容里没认出 DOI 或 arXiv 编号')
        } catch (e) {
          showNotice(e instanceof Error ? e.message : String(e))
        }
      }
    })()
  }, [enabled, sharedPayloads, resolvedSharedPayloads, isResolving, error])
}
