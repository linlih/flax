import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PageInfo } from '@flax/core'
import { createConnectorHandler, startConnector, type ConnectorDeps, type ConnectorState } from './connector'

const EXT = 'chrome-extension://kjdhkdkafjonnlfddilohdmikgpneghl'
const UA = 'Mozilla/5.0 (Macintosh) Chrome/157.0.0.0'

let server: Server
let port: number
let saved: PageInfo[]
let opened: string[]
let files: { size: number; name: string; paperId?: string }[]
let notified: boolean[]

const deps = (): ConnectorDeps => ({
  version: '9.9.9',
  findPage: (p) => (p.url.includes('known') ? { paperId: 'p1', title: 'Known', hasPdf: true, pdf: 'yes' } : null),
  addFromPage: async (p) => {
    saved.push(p)
    return p.url.includes('nothing') ? null : { paperId: 'p2', title: 'Saved', hasPdf: false, pdf: 'no', status: 'added' }
  },
  addPdfData: async (data, name, paperId) => {
    if (!new TextDecoder().decode(data.subarray(0, 5)).startsWith('%PDF')) throw new Error('下载到的不是 PDF。')
    files.push({ size: data.byteLength, name, ...(paperId ? { paperId } : {}) })
    return { paperId: paperId ?? 'p3', title: 'From PDF', hasPdf: true, pdf: 'yes', status: paperId ? 'existing' : 'added' }
  },
  findOpenPdf: async (id) => ({ paperId: id, title: 'Saved', hasPdf: false, pdf: 'no' }),
  saveTargets: () => ({ folders: [{ id: 'f1', name: 'Reading', depth: 0 }], tags: ['ml'] }),
  updateSaved: (id, patch) => ({ paperId: id, title: JSON.stringify(patch), hasPdf: false, pdf: 'no' }),
  open: (id) => (opened.push(id), id === 'p1'),
  onSaved: (_r, quiet) => notified.push(quiet)
})

/** 发一个原始请求，能随便设 Host、Origin 这些头。连接被断开时 status 是 0 */
function call(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'POST', headers: opts.headers ?? {} }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.on('error', () => resolve({ status: 0, body: '', headers: {} }))
    req.end(opts.body)
  })
}
const ext = (extra: Record<string, string> = {}) => ({ 'User-Agent': UA, Origin: EXT, 'X-Flax-Connector': '1', 'Content-Type': 'application/json', ...extra })

beforeEach(async () => {
  saved = []
  opened = []
  files = []
  notified = []
  server = createServer(createConnectorHandler(deps()))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})
afterEach(() => new Promise<void>((r) => server.close(() => r())))

describe('connector', () => {
  it('takes PDF bytes from the extension, for a saved paper or on their own', async () => {
    const pdf = { ...ext({ 'Content-Type': 'application/pdf' }) }
    const body = '%PDF-1.7 fake'
    const r = await call('/file?paperId=p2&name=paper', { headers: pdf, body })
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toMatchObject({ paperId: 'p2', pdf: 'yes' })
    // 直接打开的 PDF：没有 paperId，算新存的一篇，插件自己显示了结果就不发通知
    expect(JSON.parse((await call('/file?name=a%2F..%2Fb.pdf&quiet=1', { headers: pdf, body })).body)).toMatchObject({ paperId: 'p3', status: 'added' })
    expect(files).toEqual([{ size: body.length, name: 'paper.pdf', paperId: 'p2' }, { size: body.length, name: 'a..b.pdf' }])
    expect(notified).toEqual([true])
    // 不是 PDF：把原因告诉插件
    const bad = await call('/file?paperId=p2', { headers: pdf, body: '<html>' })
    expect(bad.status).toBe(500)
    expect(JSON.parse(bad.body)).toEqual({ error: 'failed', message: '下载到的不是 PDF。' })
    // 别的类型、没有插件头的网页都不收
    expect((await call('/file', { headers: ext(), body })).status).toBe(415)
    expect((await call('/file', { headers: { 'User-Agent': UA, 'Content-Type': 'application/pdf' }, body })).status).toBe(0)
  })

  it('lists folders and applies folder and tag changes', async () => {
    expect(JSON.parse((await call('/targets', { headers: ext(), body: '{}' })).body)).toEqual({ folders: [{ id: 'f1', name: 'Reading', depth: 0 }], tags: ['ml'] })
    const r = await call('/update', { headers: ext(), body: JSON.stringify({ paperId: 'p2', patch: { addFolder: 'f1', addTags: ['ml'] } }) })
    expect(JSON.parse(r.body)).toMatchObject({ paperId: 'p2', title: '{"addFolder":"f1","addTags":["ml"]}' })
    expect((await call('/update', { headers: ext(), body: '{}' })).status).toBe(400)
    expect(JSON.parse((await call('/findPdf', { headers: ext(), body: '{"paperId":"p2"}' })).body)).toMatchObject({ pdf: 'no' })
  })

  it('answers the extension', async () => {
    const r = await call('/ping', { headers: ext(), body: '{}' })
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toEqual({ app: 'flax', version: '9.9.9', apiVersion: 2 })
    expect(r.headers['x-flax-version']).toBe('9.9.9')
    expect(r.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('saves, looks up and opens papers', async () => {
    const page = { url: 'https://arxiv.org/abs/2101.01234', ids: { arxiv: '2101.01234' } }
    expect(JSON.parse((await call('/save', { headers: ext(), body: JSON.stringify(page) })).body)).toMatchObject({ paperId: 'p2', status: 'added' })
    expect(saved).toEqual([page])
    expect(JSON.parse((await call('/lookup', { headers: ext(), body: JSON.stringify({ url: 'https://x/known' }) })).body)).toEqual({ paper: { paperId: 'p1', title: 'Known', hasPdf: true, pdf: 'yes' } })
    expect(JSON.parse((await call('/lookup', { headers: ext(), body: JSON.stringify({ url: 'https://x/other' }) })).body)).toEqual({ paper: null })
    expect((await call('/save', { headers: ext(), body: JSON.stringify({ url: 'https://x/nothing' }) })).status).toBe(422)
    expect((await call('/open', { headers: ext(), body: JSON.stringify({ paperId: 'p1' }) })).status).toBe(200)
    expect((await call('/open', { headers: ext(), body: JSON.stringify({ paperId: 'gone' }) })).status).toBe(404)
    expect(opened).toEqual(['p1', 'gone'])
  })

  it('drops browser requests without the custom header (what a web page can send)', async () => {
    const r = await call('/save', { headers: { 'User-Agent': UA, Origin: 'https://evil.example', 'Content-Type': 'text/plain' }, body: '{"url":"x"}' })
    expect(r.status).toBe(0)
    expect((await call('/ping', { headers: { 'User-Agent': UA, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(0)
    expect(saved).toEqual([])
  })

  it('refuses web page origins even with the header, and never allows CORS', async () => {
    expect((await call('/save', { headers: ext({ Origin: 'https://evil.example' }), body: '{"url":"x"}' })).status).toBe(403)
    expect((await call('/save', { headers: ext({ Origin: 'null' }), body: '{"url":"x"}' })).status).toBe(403)
    const pre = await call('/save', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-flax-connector' } })
    expect(pre.status).toBe(204)
    expect(pre.headers['access-control-allow-origin']).toBeUndefined()
    expect(pre.headers['access-control-allow-headers']).toBeUndefined()
    expect(saved).toEqual([])
  })

  it('drops requests whose Host is not this machine (DNS rebinding)', async () => {
    expect((await call('/ping', { headers: ext({ Host: 'evil.example:27183' }), body: '{}' })).status).toBe(0)
    expect((await call('/ping', { headers: ext({ Host: `localhost:${port}` }), body: '{}' })).status).toBe(200)
  })

  it('lets a person check it from the address bar', async () => {
    const r = await call('/ping', { method: 'GET', headers: { 'User-Agent': UA, 'Sec-Fetch-Mode': 'navigate' } })
    expect(r).toMatchObject({ status: 200, body: 'Flax 正在运行' })
    expect((await call('/save', { method: 'GET', headers: { 'User-Agent': UA, 'Sec-Fetch-Mode': 'navigate' } })).status).toBe(0)
  })

  it('rejects bad requests', async () => {
    expect((await call('/ping', { method: 'GET', headers: ext() })).status).toBe(405)
    expect((await call('/save', { headers: ext({ 'Content-Type': 'text/plain' }), body: '{}' })).status).toBe(415)
    expect((await call('/save', { headers: ext(), body: '{not json' })).status).toBe(400)
    expect((await call('/save', { headers: ext(), body: '{"url":1}' })).status).toBe(400)
    expect((await call('/save', { headers: ext(), body: JSON.stringify({ url: 'x'.repeat(1024 * 1024 + 10) }) })).status).toBeOneOf([0, 413])
    expect((await call('/nope', { headers: ext(), body: '{}' })).status).toBe(404)
    expect((await call('/ping', { headers: ext({ 'X-Flax-Connector': '0' }), body: '{}' })).status).toBe(412)
  })

  it('reports a port that is already taken', async () => {
    const states: ConnectorState[] = []
    const c = startConnector(deps(), port, (s) => states.push(s))
    await new Promise((r) => setTimeout(r, 100))
    expect(states).toEqual([{ kind: 'port_in_use', port }])
    c.stop()
  })
})
