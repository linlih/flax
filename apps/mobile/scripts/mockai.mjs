// 测试用的 OpenAI 兼容服务：GET /v1/models，POST /v1/chat/completions（流式）。
// Key 必须是 test-key，否则 401。用法：node apps/mobile/scripts/mockai.mjs 8091 [每段间隔毫秒]
import http from 'node:http'
const port = Number(process.argv[2] ?? 8091)
const delay = Number(process.argv[3] ?? 150) // 每段回答之间隔多少毫秒
http
  .createServer((req, res) => {
    const auth = req.headers.authorization
    console.log(req.method, req.url, auth ? 'auth' : 'no-auth')
    if (auth !== 'Bearer test-key') return res.writeHead(401).end('{"error":"bad key"}')
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ data: [{ id: 'mock-small' }, { id: 'mock-large' }, { id: 'text-embedding-x' }] }))
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', async () => {
        const j = JSON.parse(body)
        const last = j.messages.at(-1)?.content ?? ''
        console.log('model', j.model, 'q:', last.slice(0, 200))
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const words = ['这是', '模拟', '回答：', '你问的是「', last.slice(-20), '」。', '见第 2 页', '⟦2|The dominant sequence⟧', '。']
        for (const w of words) {
          res.write(`data: ${JSON.stringify({ model: j.model, choices: [{ delta: { content: w } }] })}\n\n`)
          await new Promise((r) => setTimeout(r, delay))
        }
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n`)
        res.end('data: [DONE]\n\n')
      })
      return
    }
    res.writeHead(404).end()
  })
  .listen(port, () => console.log('mock ai on', port))
