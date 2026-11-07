import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AiEvent } from '../../shared/api'
import { anthropicProvider, openaiProvider, type Provider, type RunRequest } from './providers'
import { AiService } from './service'
import { AiSettings, type Crypt } from './settings'

const fakeCrypt = (ok = true): Crypt => ({
  available: () => ok,
  encrypt: (t) => Buffer.from('enc:' + t),
  decrypt: (b) => b.toString().replace(/^enc:/, '')
})
const tmp = () => mkdtempSync(join(tmpdir(), 'paper-ai-'))

function sse(events: unknown[]): Response {
  const body = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

function req(over: Partial<RunRequest> = {}): RunRequest & { got: string[] } {
  const got: string[] = []
  return { turns: [{ role: 'user', text: '方法是什么？' }], signal: new AbortController().signal, onText: (t) => got.push(t), got, ...over }
}

describe('settings', () => {
  it('stores each key encrypted and never in settings.json', () => {
    const dir = tmp()
    const s = new AiSettings(dir, fakeCrypt())
    expect(s.ready()).toBe(false)
    const id = s.saveService({ vendor: 'anthropic', baseUrl: '' }, 'test-key-123')
    expect(id).toBe('anthropic')
    expect(readFileSync(join(dir, 'keys', 'anthropic.bin'), 'utf8')).toBe('enc:test-key-123')
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).not.toContain('test-key-123')
    expect(new AiSettings(dir, fakeCrypt()).key('anthropic')).toBe('test-key-123')
    expect(s.ready()).toBe(false) // 还没选模型
    s.select({ service: 'anthropic', model: 'claude-opus-5-5' })
    expect(s.ready()).toBe(true)
    expect(s.connection()).toMatchObject({ config: { vendor: 'anthropic', provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: '' }, key: 'test-key-123' })
    s.saveService({ id: 'anthropic', vendor: 'anthropic', baseUrl: '' }, null)
    expect(s.ready()).toBe(false)
  })

  it('refuses to save a key without the system keychain', () => {
    expect(() => new AiSettings(tmp(), fakeCrypt(false)).saveService({ vendor: 'anthropic', baseUrl: '' }, 'k')).toThrow(/钥匙串/)
  })

  it('holds several services at once; custom addresses need no key', () => {
    const s = new AiSettings(tmp(), fakeCrypt())
    s.saveService({ vendor: 'deepseek', baseUrl: '' }, 'ds-key')
    s.saveService({ vendor: 'anthropic', baseUrl: '' }, 'an-key')
    const local = s.saveService({ vendor: 'custom', name: '本机', baseUrl: 'http://localhost:8000/v1/' })
    const lab = s.saveService({ vendor: 'custom', name: '实验室', baseUrl: 'http://10.0.0.2/v1' })
    expect(local).toMatch(/^custom-/)
    expect(lab).not.toBe(local)
    expect(() => s.saveService({ vendor: 'deepseek', baseUrl: '' }, 'again')).toThrow(/加过/)
    expect(() => s.saveService({ vendor: 'custom', baseUrl: '' })).toThrow()
    expect(s.services().map((x) => [x.vendor, x.hasKey])).toEqual([['deepseek', true], ['anthropic', true], ['custom', false], ['custom', false]])
    expect(s.usable(local)).toBe(true)
    s.select({ service: local, model: 'qwen3:8b' })
    expect(s.connection()!.config).toEqual({ vendor: 'custom', provider: 'openai', model: 'qwen3:8b', baseUrl: 'http://localhost:8000/v1' })
    expect(s.key('deepseek')).toBe('ds-key')
    s.removeService(local)
    expect(s.selection()).toBeNull()
  })

  it('turns the old single setting into a service and keeps its model', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ config: { provider: 'openai', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' } }))
    writeFileSync(join(dir, 'key.bin'), 'enc:old')
    const s = new AiSettings(dir, fakeCrypt())
    expect(s.services()).toEqual([{ id: 'deepseek', vendor: 'deepseek', name: '', baseUrl: '', hasKey: true }])
    expect(s.selection()).toEqual({ service: 'deepseek', model: 'deepseek-chat' })
    expect(s.key('deepseek')).toBe('old')
    expect(existsSync(join(dir, 'key.bin'))).toBe(false)
  })
})

describe('anthropic provider', () => {
  it('streams text and sends only the conversation, never the paper', async () => {
    let sent: { headers: Headers; body: Record<string, unknown> } | null = null
    const fetch = async (_: string | URL | Request, init?: RequestInit) => {
      sent = { headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) }
      return sse([
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '两种都存，' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '哪个对得上用哪个。' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 40 } },
        { type: 'message_stop' }
      ])
    }
    const p = anthropicProvider({ vendor: 'anthropic', provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: '' }, 'test-key', fetch)
    const r = req()
    const out = await p.run(r)
    expect(out.text).toBe('两种都存，哪个对得上用哪个。')
    expect(r.got.join('')).toBe(out.text)
    expect(out.usage).toMatchObject({ inputTokens: 12, outputTokens: 40 })
    expect(Array.isArray(out.raw)).toBe(true)
    const body = sent!.body
    expect(body['messages']).toEqual([{ role: 'user', content: '方法是什么？' }])
    expect(JSON.stringify(body)).not.toContain('document')
    expect(body['output_config']).toEqual({ effort: 'medium' })
    expect(body['fallbacks']).toBe('default')
    expect(sent!.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01')
  })

  it('replays earlier answers exactly as the API returned them', async () => {
    let body: { messages: { role: string; content: unknown }[] } | null = null
    const fetch = async (_: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return sse([
        { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: 'message_stop' }
      ])
    }
    const raw = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'A' }]
    const p = anthropicProvider({ vendor: 'anthropic', provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: '' }, 'k', fetch)
    await p.run(req({ turns: [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'A⟦1|x⟧', raw, rawProvider: 'anthropic' }, { role: 'user', text: 'q2' }] }))
    expect(body!.messages[1]!.content).toEqual(raw)
    expect(body!.messages[2]!.content).toBe('q2')
  })

  it('reports a refusal instead of an empty answer', async () => {
    const fetch = async () => sse([
      { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'message_delta', delta: { stop_reason: 'refusal', stop_sequence: null }, usage: { output_tokens: 0 } },
      { type: 'message_stop' }
    ])
    const p = anthropicProvider({ vendor: 'anthropic', provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: '' }, 'k', fetch)
    await expect(p.run(req())).rejects.toMatchObject({ code: 'refusal' })
  })

  it('maps a bad key to a clear error', async () => {
    const fetch = async () => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401, headers: { 'content-type': 'application/json' } })
    const p = anthropicProvider({ vendor: 'anthropic', provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: '' }, 'bad', fetch)
    await expect(p.run(req())).rejects.toMatchObject({ code: 'auth' })
  })
})

describe('openai-compatible provider', () => {
  it('sends only the conversation and streams the answer', async () => {
    let body: { messages: { role: string; content: string }[] } | null = null
    const fetch = async (_: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      const chunks = ['方法', '是两种都存。']
      const lines = chunks.map((c) => `data: ${JSON.stringify({ model: 'deepseek-chat', choices: [{ delta: { content: c } }] })}\n\n`)
      lines.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 60 } } })}\n\n`, 'data: [DONE]\n\n')
      return new Response(lines.join(''), { headers: { 'content-type': 'text/event-stream' } })
    }
    const p: Provider = openaiProvider({ vendor: 'custom', provider: 'openai', model: 'deepseek-chat', baseUrl: 'https://api.example.test/v1' }, 'k', fetch)
    const r = req()
    const out = await p.run(r)
    expect(out.text).toBe('方法是两种都存。')
    expect(out.usage).toMatchObject({ inputTokens: 40, cacheReadTokens: 60, outputTokens: 9, costUsd: null })
    expect(body!.messages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(body!.messages[1]!.content).toBe('方法是什么？')
  })
})

describe('service', () => {
  const setup = (run: Provider['run']) => {
    const dir = tmp()
    const settings = new AiSettings(dir, fakeCrypt())
    settings.saveService({ vendor: 'anthropic', baseUrl: '' }, 'k')
    settings.select({ service: 'anthropic', model: 'claude-opus-5-5' })
    const events: AiEvent[] = []
    const seen: RunRequest[] = []
    const svc = new AiService({
      dir,
      settings,
      emit: (e) => events.push(e),
      onStatus: () => {},
      fetch: async () => new Response(''),
      provider: () => ({ run: (r) => (seen.push(r), run(r)), models: async () => [{ id: 'claude-opus-5-5' }] })
    })
    const settle = async () => { for (let i = 0; i < 20 && !events.some((e) => e.type !== 'delta'); i++) await new Promise((r) => setTimeout(r, 5)) }
    return { svc, events, seen, settle, settings }
  }

  it('keeps the conversation and leaves failed turns out of later requests', async () => {
    let n = 0
    const { svc, events, seen, settle, settings } = setup(async (r) => {
      n++
      if (n === 2) throw Object.assign(new Error('boom'), {})
      r.onText('答' + n)
      return { text: '答' + n, raw: [{ type: 'text', text: '答' + n }], model: 'claude-opus-5-5', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 } }
    })
    svc.ask('p1', '问1')
    await settle()
    events.length = 0
    svc.ask('p1', '问2', 'some quote')
    await settle()
    expect(events.at(-1)).toMatchObject({ type: 'error' })
    events.length = 0
    svc.ask('p1', '问3')
    await settle()
    expect(seen[2]!.turns.map((t) => t.text)).toEqual(['问1', '答1', '问3'])
    expect(seen[2]!.turns[1]!.raw).toEqual([{ type: 'text', text: '答1' }])
    const conv = svc.conversation('p1')
    expect(conv.map((t) => [t.role, t.text || t.error])).toEqual([['user', '问1'], ['assistant', '答1'], ['user', '问2'], ['assistant', 'boom'], ['user', '问3'], ['assistant', '答3']])
    expect(conv[2]!.quote).toBe('some quote')
    expect(JSON.stringify(conv)).not.toContain('"raw"')
    expect(settings.usage().calls).toBe(2)
  })

  it('sends the selected passage with the question, never the paper', async () => {
    const { svc, seen, settle } = setup(async () => ({ text: 'a', model: 'm', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } }))
    svc.ask('p3', '这是什么意思？', 'We keep  both.')
    await settle()
    expect(seen[0]!.turns).toEqual([{ role: 'user', text: '关于论文里的这段文字：「We keep both.」\n\n这是什么意思？' }])
    expect(Object.keys(seen[0]!)).not.toContain('paper')
  })

  it('translates only the selected text with the glossary, and keeps it out of the conversation', async () => {
    const { svc, seen, settle } = setup(async () => ({ text: '注意力头', model: 'm', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } }))
    svc.translate('each atten-\ntion  head', [{ term: 'attention head', translation: '注意力头' }])
    await settle()
    expect(seen[0]!.turns).toEqual([{ role: 'user', text: 'each attention head' }])
    expect(seen[0]!.system).toContain('- attention head → 注意力头')
    expect(seen[0]!.effort).toBe('low')
    expect(svc.conversation('p9')).toEqual([])
    expect(() => svc.translate('   ')).toThrow()
  })

  it('sends raw thinking back only to the model that wrote it', async () => {
    const { svc, seen, settle, settings, events } = setup(async (r) => ({ text: 'a', raw: [{ type: 'thinking', thinking: 'x' }], model: 'm', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } }))
    svc.ask('p2', 'q1')
    await settle()
    events.length = 0
    svc.ask('p2', 'q2')
    await settle()
    expect(seen[1]!.turns[1]!.raw).toBeDefined()
    events.length = 0
    settings.select({ service: 'anthropic', model: 'claude-sonnet-5-5' })
    svc.ask('p2', 'q3')
    await settle()
    expect(seen[2]!.turns[1]!.raw).toBeUndefined()
    expect(svc.conversation('p2')[1]!.model).toBe('claude-opus-5-5')
  })

  it('without a key every AI call fails gently', async () => {
    const dir = tmp()
    const events: AiEvent[] = []
    const svc = new AiService({ dir, settings: new AiSettings(dir, fakeCrypt()), emit: (e) => events.push(e), onStatus: () => {}, fetch: async () => new Response('') })
    svc.ask('p1', 'x')
    await new Promise((r) => setTimeout(r, 10))
    expect(events[0]).toMatchObject({ type: 'error', code: 'no_key' })
  })
})

describe('model lists', () => {
  it('lists chat models from an OpenAI-compatible service', async () => {
    let got = ''
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      got = String(url) + ' ' + new Headers(init?.headers).get('authorization')
      return Response.json({ data: [{ id: 'm-b' }, { id: 'text-embedding-3' }, { id: 'm-a', name: 'Model A' }] })
    }
    const p = openaiProvider({ vendor: 'deepseek', provider: 'openai', model: '', baseUrl: '' }, 'k', fetch)
    expect(await p.models(new AbortController().signal)).toEqual([{ id: 'm-a', name: 'Model A' }, { id: 'm-b', name: undefined }])
    expect(got).toBe('https://api.deepseek.com/v1/models Bearer k')
  })

  it('asks for a key before listing models, then caches the list and picks a familiar default', async () => {
    const dir = tmp()
    const settings = new AiSettings(dir, fakeCrypt())
    let calls = 0
    const svc = new AiService({ dir, settings, emit: () => {}, onStatus: () => {}, fetch: async () => new Response(''), provider: () => ({ run: async () => { throw new Error('no') }, models: async () => (calls++, [{ id: 'claude-haiku-5-5' }, { id: 'claude-opus-5-5' }]) }) })
    settings.saveService({ vendor: 'openai', baseUrl: '' })
    expect(await svc.models('openai')).toMatchObject({ ok: false, message: expect.stringContaining('Key') })
    svc.saveService({ vendor: 'anthropic', baseUrl: '' }, 'k')
    expect(await svc.models('anthropic')).toMatchObject({ ok: true })
    await svc.models('anthropic')
    expect(calls).toBe(1)
    await svc.models('anthropic', true)
    expect(calls).toBe(2)
    expect(settings.selection()).toEqual({ service: 'anthropic', model: 'claude-opus-5-5' })
  })
})
