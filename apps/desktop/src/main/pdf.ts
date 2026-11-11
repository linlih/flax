// 读 PDF 的文字和自带信息，给识别用。只读前两页，大文件也很快。读法在 core 的 pdfFactsFromDoc（手机也用）。
import { NotAPdfError, pdfFactsFromDoc, type PdfFacts } from '@flax/core'

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
let pdfjs: Promise<PdfJs> | null = null
const load = () => (pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs'))

// 不是 PDF 时抛的错误在 core 里定义，导入流程（core 的 Importer）才认得
export { NotAPdfError }

export async function readPdfFacts(data: Uint8Array, fileName: string): Promise<PdfFacts> {
  const { getDocument } = await load()
  // pdfjs 会接管传进去的缓冲区，复制一份避免调用方的数据被清空
  const task = getDocument({ data: data.slice(), disableFontFace: true, useSystemFonts: false, verbosity: 0 })
  let doc
  try {
    doc = await task.promise
  } catch (e) {
    throw new NotAPdfError(e instanceof Error ? e.message : String(e))
  }
  try {
    return await pdfFactsFromDoc(doc, fileName)
  } finally {
    await task.destroy()
  }
}
