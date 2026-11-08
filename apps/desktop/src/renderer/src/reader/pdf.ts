// PDF.js 的初始化：worker、字体、CMap、wasm 解码器都从本地读，不联网。
import * as pdfjsLib from 'pdfjs-dist'
import { getDocument, GlobalWorkerOptions, PDFWorker, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl
// pdf_viewer.mjs 在加载时读 globalThis.pdfjsLib，所以 Reader 要先导入这个文件
;(globalThis as unknown as { pdfjsLib: typeof pdfjsLib }).pdfjsLib = pdfjsLib

const ASSETS = 'flax://pdfjs'

// 启动 worker 要一两秒（解析 1 MB 多的脚本）。应用打开后空闲时先启动好，所有文档共用一个
let worker: PDFWorker | null = null
export function warmUp(): PDFWorker {
  worker ??= new PDFWorker()
  return worker
}

export function fileUrl(hash: string): string {
  return `flax://file/${hash}`
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
    enableHWA: true,
    // 字体的名字要带到这边来，下面按名字认衬线体
    fontExtraProperties: true
  })
  return { promise: task.promise.then(fixTextLayerFonts), destroy: () => void task.destroy() }
}

/** 名字像衬线体的字体（Times 的各种仿制、LaTeX 的 Computer Modern 等） */
const SERIF = /times|roman|nimbusrom|^cm(r|bx|ti|sl|csc|u)\d|^lmroman|^sfrm|^sfbx|^sfti|minion|garamond|georgia|palatino|pagella|termes|stix|cambria|charter|utopia|bookman|century|baskerville|caslon|didot|bodoni|cochin|serif(?!.*sans)|song|ming|fangsong|kai|batang|mincho/i

/**
 * 文字层（看不见、用来选文字的那层）用浏览器字体按 PDF 给的行宽拉伸。PDF.js 只认得一小部分衬线体，
 * 像 LaTeX 论文常用的 NimbusRomNo9L、CMR10 会被当成无衬线体，文字层的字和画出来的字就错开好几个像素，
 * 从一个词的开头拖，选中的会从第二个字母开始。这里按字体名把它们改回衬线体。
 */
function fixTextLayerFonts(doc: PDFDocumentProxy): PDFDocumentProxy {
  const getPage = doc.getPage.bind(doc)
  doc.getPage = async (n: number) => {
    const page = await getPage(n)
    const stream = page.streamTextContent.bind(page)
    page.streamTextContent = (params) =>
      stream(params).pipeThrough(
        new TransformStream({
          transform(chunk: { styles?: Record<string, { fontFamily: string }> }, ctl) {
            for (const [id, style] of Object.entries(chunk.styles ?? {})) {
              if (style.fontFamily !== 'sans-serif' || !page.commonObjs.has(id)) continue
              const name = String((page.commonObjs.get(id) as { name?: string }).name ?? '').replace(/^[A-Z]{6}\+/, '')
              if (SERIF.test(name)) style.fontFamily = 'serif'
            }
            ctl.enqueue(chunk)
          }
        })
      ) as ReturnType<typeof stream>
    return page
  }
  return doc
}
