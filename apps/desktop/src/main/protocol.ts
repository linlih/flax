// paper:// 协议：给渲染进程读 PDF 和 PDF.js 的资源文件。
//   paper://file/<sha256>      库里的 PDF，支持 Range，大文件也能先显示第一页
//   paper://pdfjs/<dir>/<name> PDF.js 的字体、CMap（中日韩文字）、wasm 解码器
// 渲染进程拿不到任意路径，只能按哈希读库里的文件。
import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'
import { Readable } from 'node:stream'

export const SCHEME = 'paper'
export const SCHEME_PRIVILEGES = { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }

const PDFJS_DIRS = new Set(['cmaps', 'standard_fonts', 'wasm', 'iccs'])

export interface ProtocolDeps {
  /** 哈希对应的本地路径；不是库里的文件就返回 null */
  fileFor: (hash: string) => string | null
  pdfjsRoot?: string
}

export function createHandler(d: ProtocolDeps): (req: Request) => Promise<Response> {
  const pdfjsRoot = d.pdfjsRoot ?? dirname(require.resolve('pdfjs-dist/package.json'))
  return async (req) => {
    try {
      const url = new URL(req.url)
      const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean)
      if (url.host === 'file' && parts.length === 1) {
        const path = d.fileFor(parts[0]!)
        if (!path) return notFound()
        return await serveFile(path, req.headers.get('range'), 'application/pdf')
      }
      if (url.host === 'pdfjs' && parts.length === 2 && PDFJS_DIRS.has(parts[0]!)) {
        const path = normalize(join(pdfjsRoot, parts[0]!, parts[1]!))
        if (!path.startsWith(join(pdfjsRoot, parts[0]!) + sep)) return notFound()
        return await serveFile(path, null, parts[1]!.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream')
      }
      return notFound()
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return notFound()
      return new Response(String(e), { status: 500 })
    }
  }
}

function notFound(): Response {
  return new Response('not found', { status: 404 })
}

async function serveFile(path: string, range: string | null, type: string): Promise<Response> {
  const size = (await stat(path)).size
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    // 开发时页面来自 http://localhost，读 paper:// 算跨域；PDF.js 要读这几个响应头才会分段加载
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range, Content-Length'
  }
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2])
    let end = m[1] && m[2] ? Number(m[2]) : size - 1
    start = Math.max(0, start)
    end = Math.min(size - 1, end)
    if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    const fh = await open(path, 'r')
    try {
      const buf = Buffer.alloc(end - start + 1)
      await fh.read(buf, 0, buf.length, start)
      return new Response(buf, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(buf.length) } })
    } finally {
      await fh.close()
    }
  }
  const body = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>
  return new Response(body, { status: 200, headers: { ...headers, 'Content-Length': String(size) } })
}
