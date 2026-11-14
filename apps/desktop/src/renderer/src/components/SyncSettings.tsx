// 设置 › 同步：选同步的地方（坚果云、别的 WebDAV、本地文件夹），设同步密码，看同步状态。
// 两步：先填连接信息并检查那里是不是已经有 Flax 的同步库；有就输入当时的同步密码加入，没有就新建并设同步密码。
import { useEffect, useState } from 'react'
import { plainHttp, PLAIN_HTTP_HINT } from '@flax/core'
import type { SyncConnect, SyncStatus } from '../../../shared/api'
import { api } from '../lib/library'
import { KEYCHAIN } from '../lib/platform'
import { Spinner } from './Icon'

const JIANGUOYUN = 'https://dav.jianguoyun.com/dav/'
type Kind = 'jianguoyun' | 'webdav' | 'folder'
const KINDS: [Kind, string][] = [['jianguoyun', '坚果云'], ['webdav', '其他 WebDAV'], ['folder', '本地文件夹']]

const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))

function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  const d = new Date(iso)
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  return new Date(now).toDateString() === d.toDateString() ? `今天 ${time}` : `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${time}`
}

function where(c: NonNullable<SyncStatus['config']>): string {
  if (c.kind === 'folder') return c.path
  return c.url.startsWith(JIANGUOYUN) ? `坚果云 · ${c.username}` : `${c.username} @ ${c.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}`
}

export function SyncSettings() {
  const [st, setSt] = useState<SyncStatus | null>(null)
  const [setting, setSetting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [, setNow] = useState(0)
  useEffect(() => {
    void api.sync.status().then(setSt)
    const off = api.sync.onStatus(setSt)
    // "N 分钟前"跟着走
    const t = setInterval(() => setNow((n) => n + 1), 30_000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [])
  if (!st) return null

  const now = async () => {
    setError('')
    setBusy(true)
    try {
      await api.sync.syncNow()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const line = (): React.ReactNode => {
    if (st.state === 'syncing') return <><Spinner />正在同步…</>
    if (st.state === 'error') return <span className="ai-error">{st.error ?? '同步出错了'}</span>
    const parts = [st.lastSync ? `上次同步：${ago(st.lastSync)}` : '还没同步过']
    if (st.files?.left) parts.push(`还有 ${st.files.left} 个 PDF 在传`)
    return parts.join(' · ')
  }

  return (
    <section className="tray settings" aria-labelledby="h-sync">
      <div className="tray-h">
        <h2 id="h-sync" className="lbl" style={{ margin: 0 }}>同步</h2>
        <p className="hint" style={{ margin: 0 }}>在几台电脑之间同步论文、批注、笔记和 PDF。数据存在你自己的坚果云或文件夹里。</p>
      </div>
      <div className="card">
        {st.config ? (
          <>
            <div className="settings-row">
              <span className="rt">
                <b>{where(st.config)}</b>
                <small role="status">{error ? <span className="ai-error">{error}</span> : line()}</small>
              </span>
              <button type="button" className="btn btn-s" disabled={busy || st.state === 'syncing'} onClick={() => void now()}>立即同步</button>
              <button type="button" className="btn btn-s" onClick={() => { setError(''); void api.sync.disconnect() }}>停用</button>
            </div>
            <div className="settings-row">
              <span className="rt">
                <b>{st.encrypted ? '已加密' : '没有加密'}</b>
                <small>{st.encrypted ? '云端只有加密后的数据，服务商看不到内容。在其他设备上开启同步时，输入同一个同步密码。' : '云端的数据没有加密。要加密的话，停用后换一个空文件夹重新开启。'}</small>
              </span>
            </div>
          </>
        ) : setting ? (
          <SyncForm canEncrypt={st.canEncrypt} onDone={() => setSetting(false)} />
        ) : (
          <div className="settings-row">
            <span className="rt"><b>没有开启</b><small>可以用坚果云（WebDAV），或者 Dropbox、OneDrive 之类同步盘里的一个文件夹。</small></span>
            <button type="button" className="btn btn-s btn-p" onClick={() => setSetting(true)}>开启同步…</button>
          </div>
        )}
      </div>
    </section>
  )
}

function SyncForm({ canEncrypt, onDone }: { canEncrypt: boolean; onDone: () => void }) {
  const [kind, setKind] = useState<Kind>('jianguoyun')
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [path, setPath] = useState('')
  // 第二步：那里有没有同步库
  const [found, setFound] = useState<{ exists: boolean; encrypted: boolean } | null>(null)
  const [encrypt, setEncrypt] = useState(true)
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const conn = (): SyncConnect => (kind === 'folder' ? { kind: 'folder', path } : { kind: 'webdav', url: kind === 'jianguoyun' ? JIANGUOYUN : url.trim(), username: username.trim(), password })
  const step1Ok = kind === 'folder' ? !!path : !!username.trim() && !!password && (kind === 'jianguoyun' || /^https?:\/\/.+/.test(url.trim()))

  const step = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const check = () => step(async () => setFound(await api.sync.probe(conn())))
  const join = () => step(async () => {
    await api.sync.connect(conn(), found?.encrypted ? pw1 : null)
    onDone()
  })
  const create = () => step(async () => {
    await api.sync.connect(conn(), encrypt ? pw1 : null)
    onDone()
  })

  if (found) {
    const back = <button type="button" className="btn" disabled={busy} onClick={() => { setFound(null); setPw1(''); setPw2(''); setError('') }}>返回</button>
    if (found.exists) {
      return (
        <form className="svc-form fields" onSubmit={(e) => { e.preventDefault(); if (!busy && (!found.encrypted || pw1)) void join() }}>
          <span className="hint svc-tip">
            {found.encrypted ? '这里已经有一个 Flax 同步库。输入当时设置的同步密码，这台电脑的资料会和它合并。' : '这里已经有一个没有加密的 Flax 同步库，开启后这台电脑的资料会和它合并。'}
          </span>
          {found.encrypted && (
            <label className="field">
              <span className="field-l">同步密码</span>
              <input className="input" type="password" autoComplete="off" value={pw1} onChange={(e) => setPw1(e.target.value)} autoFocus />
            </label>
          )}
          <div className="field act-row">
            <button type="submit" className="btn btn-p" disabled={busy || (found.encrypted && !pw1)}>{busy ? <Spinner /> : null}{busy && found.encrypted ? '正在验证' : '开启同步'}</button>
            {back}
            {error && <span className="ai-error" role="status">{error}</span>}
          </div>
        </form>
      )
    }
    const mismatch = encrypt && !!pw2 && pw1 !== pw2
    const ok = !encrypt || (pw1.length >= 8 && pw1 === pw2)
    return (
      <form className="svc-form fields" onSubmit={(e) => { e.preventDefault(); if (!busy && ok) void create() }}>
        <label className="field-check">
          <input type="checkbox" checked={encrypt} onChange={(e) => setEncrypt(e.target.checked)} />
          <span>加密云端的数据（推荐）</span>
        </label>
        {encrypt ? (
          <>
            <span className="hint svc-tip">设一个同步密码，云端的数据用它加密，服务商也看不到内容。在其他设备上开启同步时要输入同一个密码。<b>忘了密码就打不开云端的数据</b>，只能从还有资料的电脑重新上传。</span>
            <div className="field-pair">
              <label className="field">
                <span className="field-l">同步密码（至少 8 位）</span>
                <input className="input" type="password" autoComplete="new-password" value={pw1} onChange={(e) => setPw1(e.target.value)} autoFocus />
              </label>
              <label className="field">
                <span className="field-l">再输一次</span>
                <input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} aria-invalid={mismatch} />
              </label>
            </div>
            {mismatch && <span className="ai-error svc-tip">两次输入的不一样。</span>}
          </>
        ) : (
          <span className="hint svc-tip">不加密时，能登录这个账号的人都能看到你的论文和笔记。</span>
        )}
        <div className="field act-row">
          <button type="submit" className="btn btn-p" disabled={busy || !ok}>{busy ? <Spinner /> : null}开启同步</button>
          {back}
          {error && <span className="ai-error" role="status">{error}</span>}
        </div>
      </form>
    )
  }

  return (
    <form className="svc-form fields" onSubmit={(e) => { e.preventDefault(); if (step1Ok && !busy) void check() }}>
      <div className="field">
        <span className="field-l">同步到</span>
        <div className="seg" role="group" aria-label="同步到">
          {KINDS.map(([k, label]) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => { setKind(k); setError('') }}>{label}</button>
          ))}
        </div>
      </div>
      {kind === 'folder' ? (
        <div className="field">
          <span className="field-l">文件夹</span>
          <div className="key-row">
            <span className="path" title={path}>{path || '还没选'}</span>
            <button type="button" className="btn btn-s" onClick={() => void api.sync.pickFolder().then((p) => p && setPath(p))}>选择…</button>
          </div>
          <span className="hint">选 Dropbox、OneDrive 或 iCloud 云盘里的一个文件夹，几台电脑选同一个。Flax 会在里面建一个 Flax 文件夹。</span>
        </div>
      ) : (
        <>
          {kind === 'webdav' && (
            <label className="field">
              <span className="field-l">服务器地址</span>
              <input className="input" type="url" placeholder="例如 https://nas.local:5006/" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
              {plainHttp(url) && <span className="hint">{PLAIN_HTTP_HINT}</span>}
            </label>
          )}
          <div className="field-pair">
            <label className="field">
              <span className="field-l">{kind === 'jianguoyun' ? '坚果云账号（邮箱或手机号）' : '用户名'}</span>
              <input className="input" type="text" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} spellCheck={false} />
            </label>
            <label className="field">
              <span className="field-l">{kind === 'jianguoyun' ? '应用密码' : '密码'}</span>
              <input className="input" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} disabled={!canEncrypt} />
            </label>
          </div>
          {kind === 'jianguoyun' && <span className="hint svc-tip">应用密码不是登录密码：在坚果云网页版的“账户信息 › 安全选项 › 第三方应用管理”里添加一个应用，就会生成。</span>}
          <span className="hint svc-tip">密码只保存在这台电脑上，用{KEYCHAIN}加密。{!canEncrypt && <span className="ai-error"> {KEYCHAIN}不可用，暂时不能开启同步。</span>}</span>
        </>
      )}
      <div className="field act-row">
        <button type="submit" className="btn btn-p" disabled={!step1Ok || busy}>{busy ? <><Spinner />正在连接</> : '下一步'}</button>
        <button type="button" className="btn" disabled={busy} onClick={onDone}>取消</button>
        {error && <span className="ai-error" role="status">{error}</span>}
      </div>
    </form>
  )
}
