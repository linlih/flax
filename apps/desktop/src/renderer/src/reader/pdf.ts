// PDF.js 的初始化：worker、字体、CMap、wasm 解码器都从本地读，不联网。
import * as pdfjsLib from 'pdfjs-dist'
import { getDocument, GlobalWorkerOptions, PDFWorker, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl
// pdf_viewer.mjs 在加载时读 globalThis.pdfjsLib，所以 Reader 要先导入这个文件
;(globalThis as unknown as { pdfjsLib: typeof pdfjsLib }).pdfjsLib = pdfjsLib

const ASSETS = 'paper://pdfjs'

// 启动 worker 要一两秒（解析 1 MB 多的脚本）。应用打开后空闲时先启动好，所有文档共用一个
let worker: PDFWorker | null = null
export function warmUp(): PDFWorker {
  worker ??= new PDFWorker()
  return worker
}

export function fileUrl(hash: string): string {
  return `paper://file/${hash}`
}

export function loadDocument(hash: string): { promise: Promise<PDFDocumentProxy>; destroy: () => void } {
  const task = getDocument({
    url: fileUrl(hash),
    worker: warmUp(),
    cMapUrl: `${ASSETS}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${ASSETS}/standard_fonts/`,
    wasmUrl: `${ASSETS}/wasm/`,
    iccUrl: `${ASSETS}/iccs/`,
    // 先显示第一页：按需分段读，不等整个文件
    disableAutoFetch: true,
    rangeChunkSize: 256 * 1024,
    enableHWA: true
  })
  return { promise: task.promise, destroy: () => void task.destroy() }
}
