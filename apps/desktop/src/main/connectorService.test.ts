import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConnectorState } from './connector'
import { ConnectorService } from './connectorService'

let dir: string
let services: ConnectorService[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flax-connector-'))
  services = []
})
afterEach(() => {
  for (const s of services) s.stop()
  rmSync(dir, { recursive: true, force: true })
})

const save = (port: number, url: string) => new Promise<number>((resolve) => {
  const req = request({ host: '127.0.0.1', port, path: '/save', method: 'POST', headers: { 'X-Flax-Connector': '1', 'Content-Type': 'application/json' } }, (res) => {
    res.resume()
    res.on('end', () => resolve(res.statusCode ?? 0))
  })
  req.on('error', () => resolve(0))
  req.end(JSON.stringify({ url }))
})

function make(states: ConnectorState[], notes: string[][]) {
  let n = 0
  const s = new ConnectorService({
    configDir: dir,
    deps: {
      version: '1',
      findPage: () => null,
      addFromPage: async (p) => ({ paperId: `id${++n}`, title: `T${n}`, hasPdf: false, status: p.url.includes('old') ? 'existing' : 'added' }),
      open: () => true
    },
    notify: (title, body) => notes.push([title, body]),
    onState: (st) => states.push(st),
    mergeMs: 50
  })
  services.push(s)
  return s
}
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 10))
}

describe('ConnectorService', () => {
  it('defaults to on at 27183 and remembers changes', () => {
    const s = make([], [])
    expect(s.settings()).toEqual({ enabled: true, port: 27183 })
    s.set({ enabled: false })
    expect(JSON.parse(readFileSync(join(dir, 'connector.json'), 'utf8'))).toEqual({ enabled: false, port: 27183 })
    expect(make([], []).settings()).toEqual({ enabled: false, port: 27183 })
    expect(() => s.set({ port: 80 })).toThrow(/1024/)
    expect(() => s.set({ port: '28000' })).toThrow()
  })

  it('listens on the chosen port and merges notifications for papers saved in a row', async () => {
    const states: ConnectorState[] = []
    const notes: string[][] = []
    const s = make(states, notes)
    s.set({ port: 27999 })
    await until(() => s.state().kind === 'listening')
    expect(s.state()).toEqual({ kind: 'listening', port: 27999 })
    expect(await save(27999, 'https://a')).toBe(200)
    expect(await save(27999, 'https://b')).toBe(200)
    expect(await save(27999, 'https://old')).toBe(200)
    await until(() => notes.length > 0)
    expect(notes).toEqual([['已存进文献库：2 篇', 'T1\nT2']])
    s.set({ enabled: false })
    expect(s.state()).toEqual({ kind: 'off' })
    expect(await save(27999, 'https://c')).toBe(0)
  })
})
