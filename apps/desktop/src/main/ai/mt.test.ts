import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { machineTranslate, toEnglish } from './mt'

type Call = { url: string; init: RequestInit }
function fake(status: number, body: unknown) {
  const calls: Call[] = []
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { calls, fetch }
}
const base = { signal: new AbortController().signal, now: () => 1_700_000_000_000, salt: () => 'abc' }
const acct = { id: 'APPID', secret: 'SECRET', region: '' }
const md5 = (s: string) => createHash('md5').update(s).digest('hex')
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

describe('machine translation', () => {
  it('picks the direction from the text', () => {
    expect(toEnglish('attention mechanism')).toBe(false)
    expect(toEnglish('注意力机制')).toBe(true)
    expect(toEnglish('我们用 Transformer 做实验')).toBe(true)
    expect(toEnglish('We use 注意 here in a long English sentence')).toBe(false)
  })

  it('signs Baidu requests and joins lines', async () => {
    const f = fake(200, { trans_result: [{ src: 'a', dst: '甲' }, { src: 'b', dst: '乙' }] })
    const out = await machineTranslate('baidu', acct, { ...base, text: 'robust', fetch: f.fetch })
    expect(out).toBe('甲\n乙')
    const form = new URLSearchParams(String(f.calls[0]!.init.body))
    expect(form.get('sign')).toBe(md5('APPID' + 'robust' + 'abc' + 'SECRET'))
    expect(form.get('to')).toBe('zh')
  })

  it('maps Baidu errors', async () => {
    await expect(machineTranslate('baidu', acct, { ...base, text: 'x', fetch: fake(200, { error_code: '54001', error_msg: 'Invalid Sign' }).fetch })).rejects.toMatchObject({ code: 'auth' })
    await expect(machineTranslate('baidu', acct, { ...base, text: 'x', fetch: fake(200, { error_code: '54004' }).fetch })).rejects.toMatchObject({ code: 'quota' })
  })

  it('signs Youdao with the shortened input for long text and adds word senses', async () => {
    const long = 'abcdefghijklmnopqrstuvwxyz'
    const f = fake(200, { errorCode: '0', translation: ['译文'] })
    await machineTranslate('youdao', acct, { ...base, text: long, fetch: f.fetch })
    const form = new URLSearchParams(String(f.calls[0]!.init.body))
    expect(form.get('sign')).toBe(sha256('APPID' + 'abcdefghij26qrstuvwxyz' + 'abc' + '1700000000' + 'SECRET'))
    const w = await machineTranslate('youdao', acct, { ...base, text: 'robust', fetch: fake(200, { errorCode: '0', translation: ['稳健的'], basic: { explains: ['adj. 强健的', '稳固的'] } }).fetch })
    expect(w).toBe('稳健的\nadj. 强健的；稳固的')
  })

  it('signs Tencent with TC3 headers and reads its errors', async () => {
    const f = fake(200, { Response: { TargetText: '鲁棒的' } })
    expect(await machineTranslate('tencent', acct, { ...base, text: 'robust', fetch: f.fetch })).toBe('鲁棒的')
    const h = f.calls[0]!.init.headers as Record<string, string>
    expect(h['Authorization']).toMatch(/^TC3-HMAC-SHA256 Credential=APPID\/2023-11-14\/tmt\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/)
    expect(h['X-TC-Timestamp']).toBe('1700000000')
    expect(JSON.parse(String(f.calls[0]!.init.body))).toMatchObject({ Source: 'auto', Target: 'zh' })
    await expect(machineTranslate('tencent', acct, { ...base, text: 'x', fetch: fake(200, { Response: { Error: { Code: 'FailedOperation.NoFreeAmount' } } }).fetch })).rejects.toMatchObject({ code: 'quota' })
    await expect(machineTranslate('tencent', acct, { ...base, text: 'x', fetch: fake(200, { Response: { Error: { Code: 'AuthFailure.SignatureFailure' } } }).fetch })).rejects.toMatchObject({ code: 'auth' })
  })

  it('uses the DeepL free host for :fx keys and maps status codes', async () => {
    const f = fake(200, { translations: [{ text: '稳健' }] })
    expect(await machineTranslate('deepl', { ...acct, secret: 'k:fx' }, { ...base, text: 'robust', fetch: f.fetch })).toBe('稳健')
    expect(f.calls[0]!.url).toBe('https://api-free.deepl.com/v2/translate')
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ text: ['robust'], target_lang: 'ZH' })
    await expect(machineTranslate('deepl', acct, { ...base, text: 'x', fetch: fake(456, {}).fetch })).rejects.toMatchObject({ code: 'quota' })
  })

  it('sends the Microsoft region only when set', async () => {
    const f = fake(200, [{ translations: [{ text: 'robust' }] }])
    expect(await machineTranslate('microsoft', { ...acct, region: 'eastasia' }, { ...base, text: '稳健', fetch: f.fetch })).toBe('robust')
    expect(f.calls[0]!.url).toContain('to=en')
    expect((f.calls[0]!.init.headers as Record<string, string>)['Ocp-Apim-Subscription-Region']).toBe('eastasia')
    await expect(machineTranslate('microsoft', acct, { ...base, text: 'x', fetch: fake(401, { error: { code: 401000 } }).fetch })).rejects.toMatchObject({ code: 'auth' })
  })

  it('reports a network failure', async () => {
    const fetch = async () => {
      throw new Error('ENOTFOUND')
    }
    await expect(machineTranslate('baidu', acct, { ...base, text: 'x', fetch })).rejects.toMatchObject({ code: 'network' })
  })
})
