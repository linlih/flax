// 测试用：生成只含文字的最小 PDF。不依赖任何库，也不用别人的论文文件。

export interface PdfLine {
  text: string
  size: number
  /** 页面坐标，原点在左下角，页面高 792 */
  y: number
  x?: number
}

export function makePdf(pages: PdfLine[][], info: { title?: string; author?: string } = {}): Uint8Array {
  const objs: string[] = []
  const add = (s: string) => objs.push(s) // 返回值就是对象编号
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => '\\' + c)

  add('<< /Type /Catalog /Pages 2 0 R >>')
  add('PAGES') // 稍后填
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  const pageIds: number[] = []
  for (const lines of pages) {
    const body = lines.map((l) => `BT /F1 ${l.size} Tf ${l.x ?? 72} ${l.y} Td (${esc(l.text)}) Tj ET`).join('\n')
    const contentId = add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`)
    pageIds.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`))
  }
  objs[1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`
  const infoParts = [info.title && `/Title (${esc(info.title)})`, info.author && `/Author (${esc(info.author)})`].filter(Boolean)
  const infoId = infoParts.length ? add(`<< ${infoParts.join(' ')} >>`) : 0

  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R${infoId ? ` /Info ${infoId} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}
