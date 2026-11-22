// 在插件里下载 PDF：浏览器会带上这个网站的 cookie（有主机权限的插件请求算同站），
// 所以学校、单位买了的出版社 PDF 也能下，Flax 自己去下就没有这个登录状态。
const MAX = 200 * 1024 * 1024

export async function downloadPdf(url: string): Promise<{ data: ArrayBuffer; name: string }> {
  let res: Response
  try {
    res = await fetch(url, { credentials: 'include', redirect: 'follow', signal: AbortSignal.timeout(100_000) })
  } catch {
    throw new Error('PDF 下载失败，请检查网络')
  }
  if (res.status === 401 || res.status === 403) throw new Error('这个网站要登录或者订阅才能下载 PDF')
  if (!res.ok) throw new Error(`PDF 下载失败（网站返回 ${res.status}）`)
  if (Number(res.headers.get('Content-Length') ?? 0) > MAX) throw new Error('PDF 超过 200 MB')
  const data = await res.arrayBuffer()
  if (data.byteLength > MAX) throw new Error('PDF 超过 200 MB')
  const head = new TextDecoder('latin1').decode(new Uint8Array(data, 0, Math.min(1024, data.byteLength)))
  // 很多网站下不了的时候回一个登录页或人机验证页
  if (!head.includes('%PDF-')) throw new Error('网站给的不是 PDF（可能要登录，或者要先过人机验证）')
  return { data, name: fileName(res, url) }
}

function fileName(res: Response, url: string): string {
  const cd = res.headers.get('Content-Disposition') ?? ''
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(cd)?.[1]
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd)?.[1]
  let name = ''
  try {
    name = star ? decodeURIComponent(star.trim().replace(/^"|"$/g, '')) : plain?.trim() ?? ''
  } catch {
    name = plain?.trim() ?? ''
  }
  if (!name) {
    try {
      name = decodeURIComponent(new URL(res.url || url).pathname.split('/').pop() ?? '')
    } catch {
      name = ''
    }
  }
  name = name.replace(/[\\/\0]/g, '').slice(0, 150)
  if (!name) name = 'paper.pdf'
  return name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`
}
