// 机器翻译：腾讯、百度、有道、DeepL、微软的官方 API。只发用户选中要翻译的那段文字。
// 英文（或其他外文）译成简体中文，中文译成英文。
import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { MtEngine } from '../../shared/api'
import { AiError } from './providers'

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface MtAccount {
  /** APP ID / SecretId；DeepL 不用 */
  id: string
  secret: string
  /** 微软资源的区域，比如 eastasia；全局资源可以不填 */
  region: string
}

export interface MtRequest {
  text: string
  signal: AbortSignal
  fetch: FetchLike
  /** 测试时固定时间和随机数 */
  now?: () => number
  salt?: () => string
}

/** 主要是中文就译成英文，否则译成中文 */
export function toEnglish(text: string): boolean {
  const han = text.match(/[㐀-鿿]/g)?.length ?? 0
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0
  return han > 0 && han * 2 >= latin
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex')
const hmac = (key: string | Buffer, s: string) => createHmac('sha256', key).update(s, 'utf8').digest()

const AUTH = (name: string) => new AiError('auth', `${name}的密钥不对。`)
const QUOTA = (name: string) => new AiError('quota', `${name}的额度用完了，可以换一家翻译。`)
const RATE = () => new AiError('rate_limit', '请求太频繁了，稍等一下再试。')

export async function machineTranslate(engine: MtEngine, account: MtAccount, req: MtRequest): Promise<string> {
  const text = req.text
  const en = toEnglish(text)
  const now = req.now ?? Date.now
  const salt = req.salt ?? (() => randomBytes(8).toString('hex'))
  let res: Response
  const send = async (url: string, init: RequestInit) => {
    try {
      return await req.fetch(url, { ...init, signal: req.signal })
    } catch (e) {
      if (req.signal.aborted) throw new AiError('cancelled', '已停止')
      throw new AiError('network', `连不上翻译服务：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const json = async (): Promise<Record<string, unknown>> => {
    try {
      return (await res.json()) as Record<string, unknown>
    } catch {
      throw new AiError('other', `翻译服务返回了看不懂的结果（HTTP ${res.status}）`)
    }
  }

  switch (engine) {
    case 'tencent': {
      // 腾讯云 API 3.0，TC3-HMAC-SHA256 签名
      const host = 'tmt.tencentcloudapi.com'
      const body = JSON.stringify({ SourceText: text, Source: 'auto', Target: en ? 'en' : 'zh', ProjectId: 0 })
      const ts = Math.floor(now() / 1000)
      const date = new Date(ts * 1000).toISOString().slice(0, 10)
      const ctype = 'application/json; charset=utf-8'
      const canonical = ['POST', '/', '', `content-type:${ctype}`, `host:${host}`, 'x-tc-action:texttranslate', '', 'content-type;host;x-tc-action', sha256(body)].join('\n')
      const scope = `${date}/tmt/tc3_request`
      const toSign = ['TC3-HMAC-SHA256', String(ts), scope, sha256(canonical)].join('\n')
      const key = hmac(hmac(hmac(`TC3${account.secret}`, date), 'tmt'), 'tc3_request')
      const signature = createHmac('sha256', key).update(toSign, 'utf8').digest('hex')
      res = await send(`https://${host}`, {
        method: 'POST',
        headers: {
          Authorization: `TC3-HMAC-SHA256 Credential=${account.id}/${scope}, SignedHeaders=content-type;host;x-tc-action, Signature=${signature}`,
          'Content-Type': ctype,
          'X-TC-Action': 'TextTranslate',
          'X-TC-Timestamp': String(ts),
          'X-TC-Version': '2018-03-21',
          'X-TC-Region': account.region || 'ap-guangzhou'
        },
        body
      })
      const r = ((await json())['Response'] ?? {}) as { TargetText?: string; Error?: { Code?: string; Message?: string } }
      if (r.Error) {
        const code = r.Error.Code ?? ''
        if (code.startsWith('AuthFailure')) throw AUTH('腾讯翻译君')
        if (/NoFreeAmount|ServiceIsolate|UserNotRegistered|ResourceInsufficient/.test(code)) throw QUOTA('腾讯翻译君')
        if (code.startsWith('RequestLimitExceeded')) throw RATE()
        throw new AiError('other', `腾讯翻译君：${r.Error.Message ?? code}`)
      }
      return r.TargetText ?? ''
    }

    case 'baidu': {
      const s = salt()
      const form = new URLSearchParams({ q: text, from: 'auto', to: en ? 'en' : 'zh', appid: account.id, salt: s, sign: md5(account.id + text + s + account.secret) })
      res = await send('https://fanyi-api.baidu.com/api/trans/vip/translate', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() })
      const r = (await json()) as { trans_result?: { dst: string }[]; error_code?: string | number; error_msg?: string }
      const code = r.error_code === undefined ? '' : String(r.error_code)
      if (code && code !== '52000') {
        if (['52003', '54001'].includes(code)) throw AUTH('百度翻译')
        if (code === '54004') throw QUOTA('百度翻译')
        if (['54003', '54005'].includes(code)) throw RATE()
        throw new AiError('other', `百度翻译：${r.error_msg ?? code}`)
      }
      return (r.trans_result ?? []).map((x) => x.dst).join('\n')
    }

    case 'youdao': {
      const s = salt()
      const curtime = String(Math.floor(now() / 1000))
      const chars = [...text]
      const input = chars.length <= 20 ? text : chars.slice(0, 10).join('') + chars.length + chars.slice(-10).join('')
      const form = new URLSearchParams({ q: text, from: 'auto', to: en ? 'en' : 'zh-CHS', appKey: account.id, salt: s, sign: sha256(account.id + input + s + curtime + account.secret), signType: 'v3', curtime })
      res = await send('https://openapi.youdao.com/api', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() })
      const r = (await json()) as { errorCode?: string; translation?: string[]; basic?: { explains?: string[] } }
      const code = String(r.errorCode ?? '')
      if (code !== '0') {
        if (['108', '110', '111', '202'].includes(code)) throw AUTH('有道智云')
        if (code === '401') throw QUOTA('有道智云')
        if (code === '411' || code === '412') throw RATE()
        throw new AiError('other', `有道智云出错了（错误码 ${code}）`)
      }
      const main = (r.translation ?? []).join('\n')
      // 查的是一个词时，有道会给出几条释义，放在第二行
      const explains = r.basic?.explains?.filter(Boolean) ?? []
      return explains.length ? `${main}\n${explains.join('；')}` : main
    }

    case 'deepl': {
      const free = account.secret.trim().endsWith(':fx')
      res = await send(`https://${free ? 'api-free' : 'api'}.deepl.com/v2/translate`, {
        method: 'POST',
        headers: { Authorization: `DeepL-Auth-Key ${account.secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: [text], target_lang: en ? 'EN-US' : 'ZH' })
      })
      if (res.status === 401 || res.status === 403) throw AUTH('DeepL ')
      if (res.status === 456) throw QUOTA('DeepL ')
      if (res.status === 429) throw RATE()
      const r = (await json()) as { translations?: { text: string }[]; message?: string }
      if (!res.ok) throw new AiError('other', `DeepL：${r.message ?? `HTTP ${res.status}`}`)
      return (r.translations ?? []).map((x) => x.text).join('\n')
    }

    case 'microsoft': {
      res = await send(`https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${en ? 'en' : 'zh-Hans'}`, {
        method: 'POST',
        headers: { 'Ocp-Apim-Subscription-Key': account.secret, ...(account.region ? { 'Ocp-Apim-Subscription-Region': account.region } : {}), 'Content-Type': 'application/json' },
        body: JSON.stringify([{ Text: text }])
      })
      const r = (await json()) as unknown
      if (!res.ok) {
        const err = (r as { error?: { code?: number; message?: string } }).error
        if (res.status === 401) throw AUTH('微软翻译')
        if (res.status === 403) throw QUOTA('微软翻译')
        if (res.status === 429) throw RATE()
        throw new AiError('other', `微软翻译：${err?.message ?? `HTTP ${res.status}`}`)
      }
      return ((r as { translations?: { text: string }[] }[])[0]?.translations ?? []).map((x) => x.text).join('\n')
    }
  }
}
