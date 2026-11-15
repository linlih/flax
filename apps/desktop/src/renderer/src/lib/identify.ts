// 用户同意"用 AI 识别"以后：取出 PDF 前几页，交给主进程发给 AI。
// 前几页有文字就发文字；没有（扫描版、封面是图）才把页面画成图片发。
import { IDENTIFY_IMAGES_MAX, IDENTIFY_TEXT_MAX, type IdentifyInput, type PageImage, type Paper } from '@flax/core'
import { loadDocument } from '../reader/pdf'
import { api } from './library'

/** 文字少于这么多就当成没有文字层 */
const MIN_TEXT = 200
/** 图片长边的像素：够看清版权页的小字，又不至于太费额度 */
const IMAGE_SIDE = 1400

export async function firstPages(hash: string): Promise<IdentifyInput> {
  const task = loadDocument(hash)
  try {
    const doc = await task.promise
    let text = ''
    for (let n = 1; n <= Math.min(6, doc.numPages) && text.length < IDENTIFY_TEXT_MAX; n++) {
      const page = await doc.getPage(n)
      const items = (await page.getTextContent()).items as { str?: string; hasEOL?: boolean }[]
      const t = items.map((it) => (it.str ?? '') + (it.hasEOL ? '\n' : ' ')).join('').trim()
      if (t) text += `【第 ${n} 页】\n${t}\n\n`
    }
    if (text.replace(/\s|【第 \d+ 页】/g, '').length >= MIN_TEXT) return { text: text.slice(0, IDENTIFY_TEXT_MAX) }

    const images: PageImage[] = []
    for (let n = 1; n <= Math.min(IDENTIFY_IMAGES_MAX, doc.numPages); n++) {
      const page = await doc.getPage(n)
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: IMAGE_SIDE / Math.max(base.width, base.height) })
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      // intent: 'print'：pdf.js 就不用 requestAnimationFrame 分段画。窗口被挡住或者切到别的程序时那个不触发，会一直卡着
      await page.render({ canvas, viewport, intent: 'print' }).promise
      images.push({ mime: 'image/jpeg', base64: canvas.toDataURL('image/jpeg', 0.75).split(',')[1] ?? '' })
    }
    return { images }
  } finally {
    task.destroy()
  }
}

export async function identifyWithAi(paper: Paper): Promise<{ ok: true } | { ok: false; message: string }> {
  const file = paper.files.find((f) => f.role === 'main') ?? paper.files[0]
  if (!file) return { ok: false, message: '这一条没有 PDF。' }
  try {
    return await api.library.identifyWithAi(paper.id, await firstPages(file.hash))
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}
