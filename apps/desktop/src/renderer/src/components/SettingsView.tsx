// 设置：AI 服务、翻译、外观、同步、数据（资料文件夹、备份）、关于。
// AI 服务可以加好几家，每家填自己的 Key；用哪个模型在对话里选，这里不管。
import { useEffect, useState } from 'react'
import { AI_VENDORS, vendorOf } from '../../../shared/aiVendors'
import type { AiService, AiStatus, Appearance, UpdateState } from '../../../shared/api'
import { host, serviceName, useAiStatus } from '../lib/ai'
import { api } from '../lib/library'
import { FILES_APP, kbd, KEYCHAIN } from '../lib/platform'
import { Icon, Spinner } from './Icon'
import { SyncSettings } from './SyncSettings'
import { TranslateSettings } from './TranslateSettings'

const GROUPS = ['国际', '国内', '其他'] as const
type Check = { state: 'checking' } | { state: 'ok'; count: number } | { state: 'error'; message: string } | { state: 'nokey' }

const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))

export function SettingsView({ onShortcuts }: { onShortcuts: () => void }) {
  const status = useAiStatus()
  const [editing, setEditing] = useState<string | null>(null) // 服务 id，或 'new'
  const [checks, setChecks] = useState<Record<string, Check>>({})

  const check = async (s: AiService, refresh = false) => {
    if (!s.hasKey && !vendorOf(s.vendor)?.keyOptional) return setChecks((c) => ({ ...c, [s.id]: { state: 'nokey' } }))
    setChecks((c) => ({ ...c, [s.id]: { state: 'checking' } }))
    const r = await api.ai.models(s.id, refresh)
    setChecks((c) => ({ ...c, [s.id]: r.ok ? { state: 'ok', count: r.models.length } : { state: 'error', message: r.message } }))
  }

  // 打开设置时检查每个服务连不连得上（列模型不花钱）
  const ids = status?.services.map((s) => `${s.id}:${s.hasKey}:${s.baseUrl}`).join(',')
  useEffect(() => {
    status?.services.forEach((s) => void check(s))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids])

  if (!status) return <div className="settings-page" />
  const adding = editing === 'new' || status.services.length === 0

  return (
    <div className="settings-page">
    <section className="tray settings" aria-labelledby="h-ai">
      <div className="tray-h">
        <h2 id="h-ai" className="lbl" style={{ margin: 0 }}>AI 服务</h2>
        <p className="hint" style={{ margin: 0 }}>可以加好几家，用哪个模型在对话里选。</p>
      </div>

      <div className="card svc-list">
        {status.services.map((s) =>
          editing === s.id ? (
            <ServiceForm key={s.id} status={status} service={s} onDone={(id) => { setEditing(null); if (id) void check({ ...s, hasKey: true }, true) }} />
          ) : (
            <div key={s.id} className="svc-row">
              <div className="svc-main">
                <span className="svc-name">{serviceName(s)}</span>
                <span className="hint">{s.baseUrl ? host(s.baseUrl) : s.vendor === 'anthropic' ? 'api.anthropic.com' : host(vendorOf(s.vendor)?.baseUrl ?? '')}</span>
              </div>
              <CheckLabel check={checks[s.id]} onRetry={() => void check(s, true)} />
              <button type="button" className="link" onClick={() => setEditing(s.id)}>编辑</button>
            </div>
          )
        )}
        {adding ? (
          <ServiceForm status={status} onDone={() => setEditing(null)} cancelable={status.services.length > 0} />
        ) : (
          <button type="button" className="svc-add" onClick={() => setEditing('new')}><Icon name="plus" size={16} />添加服务</button>
        )}
      </div>
      <p className="hint settings-note">
        Key 只保存在这台电脑上，用{KEYCHAIN}加密。
        {!status.canEncrypt && <span className="ai-error"> {KEYCHAIN}不可用，暂时不能保存 Key。</span>}
      </p>
    </section>
    <TranslateSettings status={status} />
    <AppearanceSection />
    <SyncSettings />
    <DataSection />
    <AboutSection onShortcuts={onShortcuts} />
    </div>
  )
}

const LOOKS: [Appearance, string][] = [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']]

function AppearanceSection() {
  const [look, setLook] = useState<Appearance | null>(null)
  useEffect(() => {
    void api.appearance().then(setLook)
  }, [])
  return (
    <section className="tray settings" aria-labelledby="h-look">
      <div className="tray-h"><h2 id="h-look" className="lbl" style={{ margin: 0 }}>外观</h2></div>
      <div className="card settings-row">
        <span className="rt"><b>主题</b><small>深色时，阅读器里的 PDF 页面也换成深色</small></span>
        <div className="seg" role="group" aria-label="主题">
          {LOOKS.map(([v, label]) => (
            <button key={v} type="button" aria-pressed={look === v} onClick={() => { setLook(v); void api.setAppearance(v) }}>{label}</button>
          ))}
        </div>
      </div>
    </section>
  )
}

function DataSection() {
  const [dir, setDir] = useState('')
  const [restoreError, setRestoreError] = useState('')
  const [moveError, setMoveError] = useState('')
  const [backup, setBackup] = useState<{ state: 'busy' } | { state: 'done'; path: string } | { state: 'error'; message: string } | null>(null)
  useEffect(() => {
    void api.info().then((i) => setDir(i.dataDir))
  }, [])
  const run = async () => {
    setBackup({ state: 'busy' })
    try {
      const path = await api.backup()
      setBackup(path ? { state: 'done', path } : null)
    } catch (e) {
      setBackup({ state: 'error', message: errText(e) })
    }
  }
  return (
    <section className="tray settings" aria-labelledby="h-data">
      <div className="tray-h">
        <h2 id="h-data" className="lbl" style={{ margin: 0 }}>数据</h2>
        <p className="hint" style={{ margin: 0 }}>论文、批注、笔记都存在这台电脑上：PDF 原样保存，笔记是普通 Markdown 文件。</p>
      </div>
      <div className="card">
        <div className="settings-row">
          <span className="rt">
            <b>资料文件夹</b>
            <small className="path" title={dir}>{dir}</small>
            {moveError && <small className="ai-error">{moveError}</small>}
          </span>
          <button type="button" className="btn btn-s" onClick={() => void api.showData()}>在{FILES_APP}中显示</button>
          <button type="button" className="btn btn-s" onClick={() => { setMoveError(''); void api.moveData().catch((e: unknown) => setMoveError(errText(e))) }}>更改…</button>
        </div>
        <div className="settings-row">
          <span className="rt">
            <b>备份</b>
            <small>
              {backup?.state === 'done' ? <>已备份到 {backup.path}</> : backup?.state === 'error' ? <span className="ai-error">{backup.message}</span> : '复制一份完整的资料库到你选的位置，比如移动硬盘。API Key 不会备份。'}
            </small>
          </span>
          <button type="button" className="btn btn-s" disabled={backup?.state === 'busy'} onClick={() => void run()}>{backup?.state === 'busy' ? <><Spinner />正在备份</> : '备份…'}</button>
        </div>
        <div className="settings-row">
          <span className="rt">
            <b>从备份恢复</b>
            <small>{restoreError ? <span className="ai-error">{restoreError}</span> : '用备份替换现在的资料库。现在的资料会先挪到旁边的文件夹，不会删除。'}</small>
          </span>
          <button type="button" className="btn btn-s" onClick={() => { setRestoreError(''); void api.restore().catch((e: unknown) => setRestoreError(errText(e))) }}>恢复…</button>
        </div>
      </div>
    </section>
  )
}

function updateText(u: UpdateState): string | null {
  if (u.kind === 'checking') return '正在检查更新…'
  if (u.kind === 'latest') return '已经是最新版本'
  if (u.kind === 'available') return `发现新版本 ${u.version}`
  if (u.kind === 'downloading') return `正在下载 ${u.version}${u.percent !== undefined ? `（${u.percent}%）` : ''}`
  if (u.kind === 'ready') return `${u.version} 已经下载好，正在重启…`
  if (u.kind === 'error') return `检查更新失败：${u.message}`
  if (u.kind === 'dev') return '开发版不检查更新'
  return null
}

function AboutSection({ onShortcuts }: { onShortcuts: () => void }) {
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<UpdateState>({ kind: 'idle' })
  useEffect(() => {
    void api.info().then((i) => setVersion(i.version))
    void api.update.state().then(setUpdate)
    return api.update.onState(setUpdate)
  }, [])
  return (
    <section className="tray settings" aria-labelledby="h-about">
      <div className="tray-h"><h2 id="h-about" className="lbl" style={{ margin: 0 }}>关于</h2></div>
      <div className="card">
        <div className="settings-row">
          <span className="rt"><b>Flax {version}</b><small>{updateText(update) ?? '开源软件，AGPL-3.0 许可'}</small></span>
          {update.kind === 'available' ? (
            <button type="button" className="btn btn-s btn-p" onClick={() => void api.update.install()}>立即更新</button>
          ) : (
            <button type="button" className="btn btn-s" disabled={update.kind === 'checking' || update.kind === 'downloading'} onClick={() => void api.update.check()}>检查更新</button>
          )}
        </div>
        <div className="settings-row">
          <span className="rt"><b>键盘快捷键</b><small>{kbd('⌘/')} 随时打开</small></span>
          <button type="button" className="btn btn-s" onClick={onShortcuts}>查看</button>
        </div>
      </div>
    </section>
  )
}

function CheckLabel({ check, onRetry }: { check?: Check; onRetry: () => void }) {
  if (!check) return <span className="svc-state" />
  if (check.state === 'checking') return <span className="svc-state hint"><Spinner />检查中</span>
  if (check.state === 'ok') return <span className="svc-state ok"><Icon name="done" size={14} />已连接 · {check.count} 个模型</span>
  if (check.state === 'nokey') return <span className="svc-state ai-error">还没有填 Key</span>
  return (
    <span className="svc-state ai-error" title={check.message}>
      连不上<button type="button" className="link" onClick={onRetry}>重试</button>
    </span>
  )
}

/** 添加或编辑一个服务 */
function ServiceForm({ status, service, onDone, cancelable = true }: { status: AiStatus; service?: AiService; onDone: (savedId?: string) => void; cancelable?: boolean }) {
  const taken = new Set(status.services.filter((s) => s.vendor !== 'custom').map((s) => s.vendor))
  const firstFree = AI_VENDORS.find((v) => !taken.has(v.id))?.id ?? 'custom'
  const [vendorId, setVendorId] = useState(service?.vendor ?? firstFree)
  const [name, setName] = useState(service?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(service?.baseUrl ?? '')
  const [key, setKey] = useState('')
  const [changeKey, setChangeKey] = useState(!service?.hasKey)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const vendor = vendorOf(vendorId)!

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const id = await api.ai.saveService({ id: service?.id, vendor: vendorId, name, baseUrl }, key.trim() ? key.trim() : undefined)
      onDone(id)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!service) return
    await api.ai.removeService(service.id)
    onDone()
  }
  const canSave = !busy && (vendorId !== 'custom' || /^https?:\/\/.+/.test(baseUrl)) && (!!service || !!key.trim() || !!vendor.keyOptional)

  return (
    <form className="svc-form fields" onSubmit={(e) => { e.preventDefault(); if (canSave) void save() }}>
      {service ? (
        <div className="svc-form-h"><span className="svc-name">{serviceName(service)}</span></div>
      ) : (
        <label className="field">
          <span className="field-l">服务</span>
          <select className="input" value={vendorId} onChange={(e) => { setVendorId(e.target.value); setBaseUrl(''); setName('') }}>
            {GROUPS.map((g) => (
              <optgroup key={g} label={g}>
                {AI_VENDORS.filter((v) => v.group === g).map((v) => (
                  <option key={v.id} value={v.id} disabled={taken.has(v.id)}>{v.name}{taken.has(v.id) ? '（已添加）' : ''}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      )}

      {vendorId === 'custom' && (
        <div className="field-pair">
          <label className="field">
            <span className="field-l">服务地址</span>
            <input className="input" type="url" placeholder="例如 http://localhost:8000/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value.trim())} spellCheck={false} />
          </label>
          <label className="field">
            <span className="field-l">名字（可选）</span>
            <input className="input" type="text" placeholder="例如 本机模型" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>
      )}
      {vendorId === 'custom' && <span className="hint svc-tip">任何兼容 OpenAI 接口的服务，包括在这台电脑或局域网里运行的模型。</span>}

      <div className="field">
        <span className="field-l">API Key{vendor.keyOptional ? '（没有可以不填）' : ''}</span>
        {changeKey ? (
          <input className="input" type="password" autoComplete="off" placeholder={`${vendor.name} 的 API Key`} value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} disabled={!status.canEncrypt} autoFocus={!!service} />
        ) : (
          <div className="key-row">
            <span><Icon name="done" size={14} />已保存在{KEYCHAIN}</span>
            <button type="button" className="link" onClick={() => setChangeKey(true)}>更换</button>
          </div>
        )}
      </div>

      {vendorId !== 'custom' && (
        <details className="field adv" open={baseUrl ? true : undefined}>
          <summary className="field-l">服务地址（走代理时才需要改）</summary>
          <input className="input" type="url" placeholder={vendor.baseUrl || 'https://api.anthropic.com'} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value.trim())} spellCheck={false} />
        </details>
      )}

      <div className="field act-row">
        <button type="submit" className="btn btn-p" disabled={!canSave}>{busy ? <Spinner /> : null}{service ? '保存' : '添加'}</button>
        {cancelable && <button type="button" className="btn" onClick={() => onDone()}>取消</button>}
        {error && <span className="ai-error" role="status">{error}</span>}
        {service && <button type="button" className="link danger svc-remove" onClick={() => void remove()}>删除这个服务</button>}
      </div>
    </form>
  )
}
