import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AppleTranslator } from './apple'

// 用一个假的小助手（node 脚本）试 JSON 一行一条的来回，真的小助手要 macOS 26 和下载好的语言
function fakeHelper(): string {
  const bin = join(mkdtempSync(join(tmpdir(), 'flax-apple-')), 'helper')
  writeFileSync(bin, `#!/usr/bin/env node
console.log(JSON.stringify({ ready: true }))
let buf = ''
process.stdin.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
    if (m.op === 'status') console.log(JSON.stringify({ id: m.id, status: 'installed' }))
    else if (m.text === 'missing') console.log(JSON.stringify({ id: m.id, error: 'x', code: 'notInstalled' }))
    else if (m.text === 'slow') {}
    else console.log(JSON.stringify({ id: m.id, text: (m.toEnglish ? 'EN:' : 'ZH:') + m.text }))
  }
})
`)
  chmodSync(bin, 0o755)
  return bin
}

describe.runIf(process.platform === 'darwin')('apple translator', () => {
  it('talks to the helper, maps errors and can be cancelled', async () => {
    const t = new AppleTranslator(fakeHelper())
    try {
      expect(await t.status()).toBe('installed')
      const signal = new AbortController().signal
      const [a, b] = await Promise.all([t.translate('robust', false, signal), t.translate('稳健', true, signal)])
      expect([a, b]).toEqual(['ZH:robust', 'EN:稳健'])
      await expect(t.translate('missing', false, signal)).rejects.toMatchObject({ code: 'no_key' })
      const ac = new AbortController()
      const slow = t.translate('slow', false, ac.signal)
      ac.abort()
      await expect(slow).rejects.toMatchObject({ code: 'cancelled' })
    } finally {
      t.stop()
    }
  })

  it('says unavailable without a helper', async () => {
    expect(await new AppleTranslator('/nonexistent/flax-translate').status()).toBe('unavailable')
  })
})
