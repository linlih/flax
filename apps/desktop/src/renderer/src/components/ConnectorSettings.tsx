// 设置 › 浏览器插件：开关、端口、现在的状态。
import { useEffect, useState } from 'react'
import type { ConnectorSettings as Settings, ConnectorState } from '../../../shared/api'
import { api } from '../lib/library'
import { Icon } from './Icon'

function stateText(s: ConnectorState | null): { text: string; error?: boolean; ok?: boolean } {
  if (!s) return { text: '' }
  if (s.kind === 'off') return { text: '已关闭，插件连不上 Flax' }
  if (s.kind === 'listening') return { text: `插件可以连接（端口 ${s.port}）`, ok: true }
  if (s.kind === 'port_in_use') return { text: `端口 ${s.port} 被别的程序占用了。换一个端口，插件的选项里也要改成一样的。`, error: true }
  return { text: `没能打开端口 ${s.port}：${s.message}`, error: true }
}

export function ConnectorSettings() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [state, setState] = useState<ConnectorState | null>(null)
  const [port, setPort] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    void api.connector.status().then((r) => {
      setSettings(r.settings)
      setState(r.state)
      setPort(String(r.settings.port))
    })
    return api.connector.onState(setState)
  }, [])
  const change = async (patch: Partial<Settings>) => {
    setError('')
    try {
      const s = await api.connector.set(patch)
      setSettings(s)
      setPort(String(s.port))
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
    }
  }
  if (!settings) return null
  const st = stateText(state)
  const portChanged = port.trim() !== String(settings.port)

  return (
    <section className="tray settings" aria-labelledby="h-ext">
      <div className="tray-h">
        <h2 id="h-ext" className="lbl" style={{ margin: 0 }}>浏览器插件</h2>
        <p className="hint" style={{ margin: 0 }}>在 Chrome、Edge 里点一下，把正在看的论文存进文献库。插件只和这台电脑上的 Flax 连接。</p>
      </div>
      <div className="card">
        <div className="settings-row">
          <span className="rt">
            <b>允许插件连接</b>
            <small className={st.error ? 'ai-error' : st.ok ? 'ok' : undefined}>{st.ok && <Icon name="done" size={14} />}{st.text}</small>
          </span>
          <div className="seg" role="group" aria-label="允许插件连接">
            <button type="button" aria-pressed={settings.enabled} onClick={() => void change({ enabled: true })}>开</button>
            <button type="button" aria-pressed={!settings.enabled} onClick={() => void change({ enabled: false })}>关</button>
          </div>
        </div>
        <div className="settings-row">
          <span className="rt">
            <b>端口</b>
            <small>{error ? <span className="ai-error">{error}</span> : '一般不用改。改了以后，插件的选项里也要改成一样的。'}</small>
          </span>
          <input className="input" style={{ width: 96 }} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))} onKeyDown={(e) => e.key === 'Enter' && portChanged && void change({ port: Number(port) })} aria-label="端口" />
          <button type="button" className="btn btn-s" disabled={!portChanged || !port} onClick={() => void change({ port: Number(port) })}>应用</button>
        </div>
      </div>
    </section>
  )
}
