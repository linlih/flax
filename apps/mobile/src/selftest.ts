// 自检（设置 › 关于 › 自检）：手机上跑一遍 core 依赖的东西，确认和桌面兼容。
// 每一项单独报告通过或失败，不会因为一项失败就停下。
import { checkCodec, Library, open, seal, utf8, fromUtf8, parseMultistatus, type SqlDb } from '@flax/core'
import { openDatabaseSync } from 'expo-sqlite'
import { rnCodec } from './platform/codec'
import { expoDb } from './platform/db'
import { sha256 } from './platform/hash'

export interface CheckResult {
  name: string
  ok: boolean
  detail: string
  ms: number
}

type Check = [string, () => Promise<string | void> | string | void]

function memDb(): SqlDb {
  return expoDb(openDatabaseSync(':memory:'))
}

const CHECKS: Check[] = [
  [
    '全局接口',
    () => {
      const missing = ['fetch', 'AbortController', 'TextEncoder', 'TextDecoder', 'btoa', 'atob', 'URL', 'URLSearchParams'].filter((k) => typeof (globalThis as Record<string, unknown>)[k] === 'undefined')
      if (typeof crypto?.randomUUID !== 'function') missing.push('crypto.randomUUID')
      if (typeof crypto?.getRandomValues !== 'function') missing.push('crypto.getRandomValues')
      if (missing.length) throw new Error(`缺少：${missing.join('、')}`)
      if (fromUtf8(utf8('同步 ✓ 𝛼')) !== '同步 ✓ 𝛼') throw new Error('UTF-8 编解码不对')
    }
  ],
  [
    'URL',
    () => {
      const u = new URL('https://dav.jianguoyun.com:443/dav/Flax/a%20b/?x=1')
      if (u.host !== 'dav.jianguoyun.com') throw new Error(`host = ${u.host}`)
      if (u.pathname !== '/dav/Flax/a%20b/') throw new Error(`pathname = ${u.pathname}`)
      const r = new URL('/dav/Flax/log/', 'https://dav.jianguoyun.com/dav/Flax/')
      if (r.pathname !== '/dav/Flax/log/') throw new Error(`相对地址 = ${r.pathname}`)
      const names = parseMultistatus(
        '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/Flax/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response><d:response><d:href>/dav/Flax/log/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response><d:response><d:href>/dav/Flax/flax.json</d:href><d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response></d:multistatus>',
        'https://dav.jianguoyun.com/dav/Flax/'
      )
      if (names.join(',') !== 'log/,flax.json') throw new Error(`PROPFIND 解析 = ${names.join(',')}`)
      return 'host、pathname、PROPFIND 解析都对'
    }
  ],
  [
    '正则',
    () => {
      // core 的笔记链接用到后行断言
      const m = [...'![[a]] [[b|c]]'.matchAll(/(?<!!)\[\[([^\]\n]+?)\]\]/g)].map((x) => x[1])
      if (m.join() !== 'b|c') throw new Error(`得到 ${m.join()}`)
      if (!/\p{Script=Han}/u.test('中')) throw new Error('不支持 Unicode 属性')
    }
  ],
  [
    'SQLite',
    () => {
      const db = memDb()
      const v = db.prepare('PRAGMA user_version').get() as { user_version?: number }
      if (v?.user_version !== 0) throw new Error(`user_version 读出 ${JSON.stringify(v)}`)
      db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, data TEXT)')
      db.exec('BEGIN')
      db.prepare('INSERT INTO t VALUES (?, ?)').run('a', '{"x":{"y":2}}')
      db.exec('ROLLBACK')
      if (db.prepare('SELECT * FROM t').all().length) throw new Error('ROLLBACK 没生效')
      const r = db.prepare('INSERT INTO t VALUES (?, ?)').run('a', '{"x":{"y":2}}') as { changes?: number }
      if (r.changes !== 1) throw new Error(`run 返回 ${JSON.stringify(r)}`)
      const j = db.prepare("SELECT json_extract(data, '$.x.y') AS y FROM t").get() as { y: number }
      if (j.y !== 2) throw new Error('没有 JSON1')
      if (db.prepare('SELECT * FROM t WHERE id = ?').get('zz') !== undefined) throw new Error('查不到时没返回 undefined')
      return 'user_version、事务、changes、json_extract 都对'
    }
  ],
  [
    '文献库',
    () => {
      const lib = new Library(memDb())
      const p = lib.addPaper({ title: 'Attention Is All You Need', authors: [{ given: 'Ashish', family: 'Vaswani' }], year: 2017, identifiers: { arxiv: '1706.03762' }, source: 'arxiv' })
      lib.updatePaper(p.id, { tags: ['transformer'], readingStatus: 'reading' })
      const a = lib.addAnnotation({ paperId: p.id, fileHash: 'f'.repeat(64), type: 'highlight', origin: 'select', color: 'yellow', page: 0, target: { rects: [[0, 0, 10, 10]], quote: { exact: 'x', prefix: '', suffix: '' } } })
      if (lib.listAnnotations(p.id)[0]?.id !== a.id) throw new Error('批注没存上')
      if (lib.findDuplicate({ arxiv: '1706.03762' })?.paper.id !== p.id) throw new Error('查重不对')
      if (lib.listTags()[0]?.tag !== 'transformer') throw new Error('标签不对')
      const conv = lib.conversations()
      if (!conv) throw new Error('没有对话')
      return '论文、批注、查重、标签都对'
    }
  ],
  ['SHA-256', () => {
    if (sha256(utf8('abc')) !== 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') throw new Error('结果不对')
  }],
  ['加密和压缩（1000 次）', async () => {
    await checkCodec(rnCodec, false)
    const key = rnCodec.random(32)
    const sealed = await seal(rnCodec, key, utf8('Flax'), true)
    if (fromUtf8(await open(rnCodec, key, sealed)) !== 'Flax') throw new Error('seal/open 来回不对')
    return '和桌面的测试数据一致'
  }],
  ['加密（600000 次，真实参数）', async () => {
    const t = Date.now()
    await checkCodec(rnCodec, true)
    return `派生用了 ${((Date.now() - t) / 1000).toFixed(1)} 秒`
  }]
]

export async function runSelfTest(onResult: (r: CheckResult) => void): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  for (const [name, fn] of CHECKS) {
    const t = Date.now()
    let r: CheckResult
    try {
      const detail = await fn()
      r = { name, ok: true, detail: detail || '通过', ms: Date.now() - t }
    } catch (e) {
      r = { name, ok: false, detail: e instanceof Error ? e.message : String(e), ms: Date.now() - t }
    }
    out.push(r)
    onResult(r)
  }
  return out
}
