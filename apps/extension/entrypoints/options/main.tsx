// 选项：只有端口。Flax 设置里改了端口，这里也要改成一样的
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../style.css'
import { DEFAULT_PORT, flax, getPort } from '../../utils/flax'

function Options() {
  const [port, setPort] = useState('')
  const [msg, setMsg] = useState('')
  useEffect(() => void getPort().then((p) => setPort(String(p))), [])
  const apply = async () => {
    const n = Number(port)
    if (!Number.isInteger(n) || n < 1024 || n > 65535) return setMsg('端口要是 1024 到 65535 之间的整数')
    await browser.storage.local.set({ port: n })
    setMsg('已保存，正在连接…')
    setMsg(await flax.ping().then((r) => `已连上 Flax ${r.version}`, () => '已保存。现在连不上 Flax：确认它开着，端口和 Flax 设置里的一样。'))
  }
  return (
    <main>
      <div className="card">
        <label>
          <b>Flax 的端口</b>
          <span className="sub">一般不用改（默认 {DEFAULT_PORT}）。要和 Flax 设置 › 浏览器插件里的一样。</span>
          <span className="actions">
            <input inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))} onKeyDown={(e) => e.key === 'Enter' && void apply()} aria-label="端口" />
            <button type="button" className="primary" onClick={() => void apply()}>保存</button>
          </span>
        </label>
        {msg && <p className="status">{msg}</p>}
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Options />)
