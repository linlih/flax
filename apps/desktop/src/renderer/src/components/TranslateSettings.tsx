// 设置里的"翻译"：macOS 自带的翻译（免费，不用注册，默认用它）、AI 模型，或者某家翻译服务的官方 API（用户自己的 Key）。
// 系统翻译第一次用要在系统设置里下载语言，这里带着去；选了一家还没填 Key 的，先填好再换过去。
import { useEffect, useState } from 'react'
import type { AiStatus, MtEngine, TranslateEngine } from '../../../shared/api'
import { MT_ENGINES, mtEngineOf } from '../../../shared/mtEngines'
import { api } from '../lib/library'
import { Icon, Spinner } from './Icon'

const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
type Test = { state: 'busy' } | { state: 'ok' } | { state: 'error'; message: string }

export function TranslateSettings({ status }: { status: AiStatus }) {
  const t = status.translate
  // 在下拉里选了还没填 Key 的那家：先显示表单，存好才真的换过去
  const [picked, setPicked] = useState<MtEngine | null>(null)
  const shown: TranslateEngine = picked ?? t.engine
  const info = shown === 'ai' || shown === 'apple' ? undefined : mtEngineOf(shown)
  const account = t.accounts.find((a) => a.engine === shown)
  const hasApple = t.apple === 'installed' || t.apple === 'supported'

  const choose = (e: TranslateEngine) => {
    if (e !== 'ai' && e !== 'apple' && !t.accounts.some((a) => a.engine === e && a.hasSecret)) return setPicked(e)
    setPicked(null)
    void api.ai.setTranslateEngine(e)
  }

  // 还没下载翻译语言时：打开设置页、从系统设置切回来，都再查一次
  const needsDownload = shown === 'apple' && t.apple === 'supported'
  const [checking, setChecking] = useState(false)
  const [notYet, setNotYet] = useState(false)
  const recheck = () => {
    setChecking(true)
    setNotYet(false)
    void api.ai.checkAppleTranslate()
      .then((st) => setNotYet(st.translate.apple !== 'installed'))
      .finally(() => setChecking(false))
  }
  useEffect(() => {
    if (!needsDownload) return
    void api.ai.checkAppleTranslate()
    const back = () => void api.ai.checkAppleTranslate()
    window.addEventListener('focus', back)
    return () => window.removeEventListener('focus', back)
  }, [needsDownload])

  return (
    <section className="tray settings" aria-labelledby="h-trans">
      <div className="tray-h">
        <h2 id="h-trans" className="lbl" style={{ margin: 0 }}>翻译</h2>
        <p className="hint" style={{ margin: 0 }}>选中文字右键"翻译"，或者双击一个词。只发你要翻译的那段。</p>
      </div>
      <div className="card">
        <div className="settings-row">
          <span className="rt">
            <b>翻译用</b>
            <small>
              {shown === 'apple'
                ? needsDownload ? '第一次用要下载英语和中文的翻译语言，下载一次就好' : '免费，不用注册。在这台 Mac 上翻，文字不离开电脑'
                : shown === 'ai'
                ? status.ready ? '对话里选的模型，会按术语表的译法翻' : <span className="ai-error">还没有连接 AI 服务。在上面添加一个，或者换一家翻译服务。</span>
                : <>{info?.free}。<a className="link" href={info?.url} target="_blank" rel="noreferrer">去申请 Key</a></>}
            </small>
          </span>
          <select className="input trans-engine" aria-label="翻译用" value={shown} onChange={(e) => choose(e.target.value as TranslateEngine)}>
            {(hasApple || shown === 'apple') && <option value="apple">macOS 系统翻译</option>}
            <option value="ai">AI 模型</option>
            {MT_ENGINES.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
        {needsDownload && (
          <div className="trans-apple">
            <ol className="hint">
              <li>打开系统设置 › 通用 › 语言与地区，拉到最下面点"翻译语言…"</li>
              <li>下载"英语"和"中文（简体）"</li>
            </ol>
            <div className="act-row">
              <button type="button" className="btn btn-p" onClick={() => void api.ai.openTranslateLanguages()}>打开系统设置</button>
              <button type="button" className="btn" onClick={recheck} disabled={checking}>{checking ? <Spinner /> : null}下载好了</button>
              {notYet && <span className="hint" role="status">还没有下载好，两种语言都要下载</span>}
            </div>
          </div>
        )}
        {info && <MtForm key={info.id} engine={info.id} account={account} canEncrypt={status.canEncrypt} onDone={() => setPicked(null)} />}
      </div>
    </section>
  )
}

function MtForm({ engine, account, canEncrypt, onDone }: { engine: MtEngine; account?: AiStatus['translate']['accounts'][number]; canEncrypt: boolean; onDone: () => void }) {
  const info = mtEngineOf(engine)!
  const [id, setId] = useState(account?.id ?? '')
  const [region, setRegion] = useState(account?.region ?? '')
  const [secret, setSecret] = useState('')
  const [editing, setEditing] = useState(!account?.hasSecret)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [test, setTest] = useState<Test | null>(null)

  const runTest = async () => {
    setTest({ state: 'busy' })
    const r = await api.ai.testTranslate(engine)
    setTest(r.ok ? { state: 'ok' } : { state: 'error', message: r.message })
  }
  // 打开时检查一下填好的这家还能不能用
  useEffect(() => {
    if (account?.hasSecret) void runTest()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const dirty = editing || id !== (account?.id ?? '') || region !== (account?.region ?? '')
  const canSave = !busy && (!info.idLabel || !!id.trim()) && (!editing || !!secret.trim())
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.ai.saveTranslateAccount({ engine, id, region }, secret.trim() || undefined)
      setSecret('')
      setEditing(false)
      onDone()
      void runTest()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="svc-form fields trans-form" onSubmit={(e) => { e.preventDefault(); if (canSave) void save() }}>
      {(info.idLabel || info.regionLabel) && (
        <div className={info.idLabel && info.regionLabel ? 'field-pair' : undefined}>
          {info.idLabel && (
            <label className="field">
              <span className="field-l">{info.idLabel}</span>
              <input className="input" value={id} onChange={(e) => setId(e.target.value.trim())} spellCheck={false} autoComplete="off" autoFocus={!account} />
            </label>
          )}
          {info.regionLabel && (
            <label className="field">
              <span className="field-l">{info.regionLabel}（全局资源可以不填）</span>
              <input className="input" placeholder="例如 eastasia" value={region} onChange={(e) => setRegion(e.target.value.trim())} spellCheck={false} autoComplete="off" />
            </label>
          )}
        </div>
      )}
      <div className="field">
        <span className="field-l">{info.secretLabel}</span>
        {editing ? (
          <input className="input" type="password" autoComplete="off" placeholder={`${info.name}的${/^[A-Za-z]/.test(info.secretLabel) ? ' ' : ''}${info.secretLabel}`} value={secret} onChange={(e) => setSecret(e.target.value)} spellCheck={false} disabled={!canEncrypt} autoFocus={!!account || !info.idLabel} />
        ) : (
          <div className="key-row">
            <span><Icon name="done" size={14} />已保存在系统钥匙串</span>
            <button type="button" className="link" onClick={() => setEditing(true)}>更换</button>
          </div>
        )}
      </div>
      <div className="field act-row">
        {dirty ? (
          <>
            <button type="submit" className="btn btn-p" disabled={!canSave}>{busy ? <Spinner /> : null}{account ? '保存' : '保存并使用'}</button>
            {account?.hasSecret ? <button type="button" className="btn" onClick={() => { setEditing(false); setSecret(''); setId(account.id); setRegion(account.region); setError(null) }}>取消</button> : <button type="button" className="btn" onClick={onDone}>取消</button>}
          </>
        ) : test?.state === 'busy' ? (
          <span className="svc-state hint"><Spinner />正在试译</span>
        ) : test?.state === 'ok' ? (
          <span className="svc-state ok"><Icon name="done" size={14} />可以用</span>
        ) : test?.state === 'error' ? (
          <span className="svc-state ai-error" title={test.message}>{test.message}<button type="button" className="link" onClick={() => void runTest()}>重试</button></span>
        ) : null}
        {error && <span className="ai-error" role="status">{error}</span>}
        {account && !dirty && <button type="button" className="link danger svc-remove" onClick={() => void api.ai.saveTranslateAccount({ engine }, null).then(onDone)}>删除这家</button>}
      </div>
    </form>
  )
}
