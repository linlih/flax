// 开发用的 WebDAV 服务器：把一个文件夹当同步的地方，手机通过 adb reverse 连本机测同步。
// 只实现同步用到的几个方法：PROPFIND（Depth 1）、GET、PUT、DELETE、MKCOL。要账号密码（Basic）。
//   node apps/mobile/scripts/dav.mjs <文件夹> [端口=8090] [用户=flax] [密码=flax]
//   adb reverse tcp:8090 tcp:8090   # 手机上的地址填 http://localhost:8090/dav/
import { createServer } from 'node:http'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, normalize } from 'node:path'

const [root = './.dav', port = '8090', user = 'flax', pass = 'flax'] = process.argv.slice(2)
const PREFIX = '/dav/'
const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
let count = 0

const local = (urlPath) => {
  const rel = decodeURIComponent(urlPath.slice(PREFIX.length))
  const p = normalize(join(root, rel))
  if (!p.startsWith(normalize(root))) throw new Error('bad path')
  return p
}

const body = (req) =>
  new Promise((ok) => {
    const parts = []
    req.on('data', (c) => parts.push(c))
    req.on('end', () => ok(Buffer.concat(parts)))
  })

const entry = (href, dir) =>
  `<d:response><d:href>${href.split('/').map(encodeURIComponent).join('/')}</d:href><d:propstat><d:prop><d:resourcetype>${dir ? '<d:collection/>' : ''}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const done = (status, data = '', type) => {
    res.writeHead(status, type ? { 'Content-Type': type } : {})
    res.end(data)
    console.log(`${++count} ${req.method} ${decodeURIComponent(url.pathname)} → ${status}`)
  }
  try {
    if (req.headers.authorization !== auth) return done(401)
    if (!url.pathname.startsWith(PREFIX) && url.pathname + '/' !== PREFIX) return done(404)
    const path = url.pathname + '/' === PREFIX ? root : local(url.pathname)
    const st = await stat(path).catch(() => null)
    switch (req.method) {
      case 'PROPFIND': {
        await body(req)
        if (!st) return done(404)
        const base = url.pathname.replace(/\/*$/, st.isDirectory() ? '/' : '')
        let xml = entry(decodeURIComponent(base), st.isDirectory())
        if (st.isDirectory())
          for (const d of await readdir(path, { withFileTypes: true })) xml += entry(decodeURIComponent(base) + d.name + (d.isDirectory() ? '/' : ''), d.isDirectory())
        return done(207, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${xml}</d:multistatus>`, 'application/xml')
      }
      case 'GET':
        if (!st || st.isDirectory()) return done(404)
        return done(200, await readFile(path), 'application/octet-stream')
      case 'PUT': {
        const data = await body(req)
        const parent = path.slice(0, path.lastIndexOf('/'))
        if (!(await stat(parent).catch(() => null))) return done(409)
        await writeFile(path, data)
        return done(st ? 204 : 201)
      }
      case 'DELETE':
        if (!st) return done(404)
        await rm(path, { recursive: true })
        return done(204)
      case 'MKCOL':
        await body(req)
        if (st) return done(405)
        await mkdir(path)
        return done(201)
      default:
        return done(405)
    }
  } catch (e) {
    console.error(e)
    done(500)
  }
}).listen(Number(port), async () => {
  await mkdir(root, { recursive: true })
  console.log(`WebDAV on http://localhost:${port}${PREFIX} → ${root}  (${user} / ${pass})`)
})
