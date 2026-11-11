// 导入 PDF 时读标题、作者和前两页文字：手机上没有 Node 版的 pdf.js，借一个看不见的 WebView 跑阅读器网页里的 pdf.js
// （reader-web 的 facts 消息），读法和桌面同一份（core 的 pdfFactsFromDoc），识别结果一样。
// <PdfFactsHost /> 挂在根布局里，一直在；readPdfFacts() 把数据写成临时文件交给它，等它回话。
import { useEffect, useRef } from 'react'
import { View } from 'react-native'
import { WebView, type WebViewMessageEvent, type WebViewProps } from 'react-native-webview'
import { Directory, File, Paths } from 'expo-file-system'
import { NotAPdfError, type PdfFacts } from '@flax/core'

const READER = 'file:///android_asset/reader/index.html'
const Web = WebView as unknown as React.ComponentType<WebViewProps & { ref?: React.Ref<WebView> }>
const TIMEOUT_MS = 30_000

interface Pending {
  resolve: (f: PdfFacts) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

let web: WebView | null = null
let ready = false
let waiting: (() => void)[] = []
const pending = new Map<string, Pending>()
let seq = 0

function whenReady(): Promise<void> {
  return ready ? Promise.resolve() : new Promise((r) => waiting.push(r))
}

/** 给 core 的 Importer 用：不是 PDF 抛 NotAPdfError */
export async function readPdfFacts(data: Uint8Array, fileName: string): Promise<PdfFacts> {
  const head = String.fromCharCode(...data.subarray(0, 1024))
  if (!head.includes('%PDF-')) throw new NotAPdfError()
  const dir = new Directory(Paths.cache, 'facts')
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true })
  const id = `f${++seq}`
  const tmp = new File(dir, `${id}.pdf`)
  if (tmp.exists) tmp.delete()
  tmp.create()
  tmp.writeSync(data)
  try {
    await whenReady()
    return await new Promise<PdfFacts>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('读 PDF 超时了'))
      }, TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      web?.injectJavaScript(`window.flaxReader && window.flaxReader.receive(${JSON.stringify({ type: 'facts', id, url: tmp.uri, fileName })}); true;`)
    })
  } catch (e) {
    // 读不出来（加密的 PDF、超时）：照样导入，标题用文件名，之后可以手动匹配
    if (e instanceof NotAPdfError) throw e
    console.warn('pdf facts', e)
    return { fileName, info: {}, text: '', lines: [], pageCount: 0 }
  } finally {
    if (tmp.exists) tmp.delete()
  }
}

export function PdfFactsHost() {
  const ref = useRef<WebView>(null)
  useEffect(() => {
    web = ref.current
    return () => {
      web = null
      ready = false
    }
  }, [])
  const onMessage = (e: WebViewMessageEvent) => {
    let m: { type?: string; id?: string; facts?: PdfFacts; error?: string; notPdf?: boolean }
    try {
      m = JSON.parse(e.nativeEvent.data)
    } catch {
      return
    }
    if (m.type === 'ready') {
      ready = true
      web = ref.current
      const w = waiting
      waiting = []
      for (const f of w) f()
      return
    }
    if (m.type !== 'facts' || !m.id) return
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    clearTimeout(p.timer)
    if (m.facts) p.resolve(m.facts)
    else p.reject(m.notPdf ? new NotAPdfError(m.error) : new Error(m.error ?? '读不了'))
  }
  return (
    <View pointerEvents="none" style={{ position: 'absolute', width: 1, height: 1, opacity: 0, left: -10, top: -10 }}>
      <Web
        ref={ref}
        source={{ uri: READER }}
        originWhitelist={['*']}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        javaScriptEnabled
        onMessage={onMessage}
        onShouldStartLoadWithRequest={(r) => r.url.startsWith('file://') || r.url.startsWith('blob:') || r.url === 'about:blank'}
      />
    </View>
  )
}
