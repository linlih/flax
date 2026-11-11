// 加一条术语或改一条：术语表页和阅读器的翻译面板（"加入术语表""改译法"）都用。
import { useState } from 'react'
import { View } from 'react-native'
import type { Term } from '@flax/core'
import { app, showNotice } from '../services'
import { Button, Field } from './kit'
import { BottomSheet } from './sheets'

/** 加一条或改一条；读论文时翻译面板里"加入术语表""改译法"也用它 */
export function TermSheet({ term, initial, paperId, onClose }: { term: Term | 'new' | null; initial?: { term?: string; translation?: string }; paperId?: string; onClose: () => void }) {
  const s = app()
  const isNew = term === 'new'
  const base = term && term !== 'new' ? term : null
  const [src, setSrc] = useState('')
  const [tr, setTr] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  // 打开时（或换了一条）填一次表单；按 id 比，列表每次给的是新对象
  const key = term === 'new' ? 'new' : (term?.id ?? null)
  const [openFor, setOpenFor] = useState<string | null>(null)
  if (key && openFor !== key) {
    setOpenFor(key)
    setSrc(base?.term ?? initial?.term ?? '')
    setTr(base?.translation ?? initial?.translation ?? '')
    setNote(base?.note ?? '')
    setError('')
  }
  if (!key && openFor) setOpenFor(null)

  const save = () => {
    if (!src.trim() || !tr.trim()) return setError('原文和译法都要填')
    try {
      if (base) s.library.updateTerm(base.id, { term: src.trim(), translation: tr.trim(), note: note.trim() })
      else {
        const dup = s.library.listTerms().find((x) => x.term.toLowerCase() === src.trim().toLowerCase())
        if (dup) s.library.updateTerm(dup.id, { translation: tr.trim(), ...(note.trim() ? { note: note.trim() } : {}) })
        else s.library.addTerm({ term: src.trim(), translation: tr.trim(), ...(note.trim() ? { note: note.trim() } : {}), ...(paperId ? { paperId } : {}) })
        showNotice(dup ? `改了"${dup.term}"的译法` : `加入术语表：${src.trim()} → ${tr.trim()}`)
      }
      s.changed()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const remove = () => {
    if (!base) return
    s.library.removeTerm(base.id)
    s.changed()
    onClose()
    showNotice(`删掉了术语：${base.term}`, {
      action: {
        label: '撤销',
        run: () => {
          s.library.restoreTerm(base.id)
          s.changed()
        }
      }
    })
  }
  return (
    <BottomSheet open={!!term} onClose={onClose} title={isNew ? '添加术语' : '改术语'}>
      <View style={{ paddingHorizontal: 20, gap: 14 }}>
        <Field label="原文" value={src} onChangeText={setSrc} autoCapitalize="none" placeholder="例如 attention head" autoFocus={isNew && !initial?.term} />
        <Field label="译法" value={tr} onChangeText={setTr} placeholder="例如 注意力头" autoFocus={isNew && !!initial?.term} error={error} />
        <Field label="备注（可选）" value={note} onChangeText={setNote} placeholder="什么场合这么译" />
        <Button title="保存" onPress={save} disabled={!src.trim() || !tr.trim()} />
        {base ? <Button title="删除这一条" kind="danger" onPress={remove} /> : null}
      </View>
    </BottomSheet>
  )
}
