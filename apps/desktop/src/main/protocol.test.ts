import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createHandler } from './protocol'

const dir = mkdtempSync(join(tmpdir(), 'paper-proto-'))
const pdf = join(dir, 'a.pdf')
writeFileSync(pdf, '0123456789')
mkdirSync(join(dir, 'pdfjs', 'cmaps'), { recursive: true })
writeFileSync(join(dir, 'pdfjs', 'cmaps', 'GBK-EUC-H.bcmap'), 'cmap')
writeFileSync(join(dir, 'secret.txt'), 'no')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const H = 'a'.repeat(64)
const handler = createHandler({ fileFor: (h) => (h === H ? pdf : null), pdfjsRoot: join(dir, 'pdfjs') })
const get = (url: string, headers: Record<string, string> = {}) => handler(new Request(url, { headers }))

describe('paper:// protocol', () => {
  it('serves a library file whole and by range', async () => {
    const all = await get(`paper://file/${H}`)
    expect(all.status).toBe(200)
    expect(all.headers.get('accept-ranges')).toBe('bytes')
    expect(await all.text()).toBe('0123456789')
    const part = await get(`paper://file/${H}`, { range: 'bytes=2-4' })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 2-4/10')
    expect(await part.text()).toBe('234')
    expect(await (await get(`paper://file/${H}`, { range: 'bytes=-3' })).text()).toBe('789')
  })

  it('serves PDF.js assets and nothing outside them', async () => {
    expect(await (await get('paper://pdfjs/cmaps/GBK-EUC-H.bcmap')).text()).toBe('cmap')
    expect((await get('paper://file/' + 'b'.repeat(64))).status).toBe(404)
    expect((await get('paper://pdfjs/cmaps/..%2F..%2Fsecret.txt')).status).toBe(404)
    expect((await get('paper://pdfjs/other/x')).status).toBe(404)
    expect((await get('paper://pdfjs/cmaps/missing.bcmap')).status).toBe(404)
  })
})
