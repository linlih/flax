// 左边栏里的目录：PDF 自带的书签，按层级缩进，可以折叠，现在读到的那一节标出来。
import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { ancestors, currentItem, visibleItems, type OutlineItem } from './toc'

export function Outline({ items, current, onGo }: { items: OutlineItem[]; current: number; onGo: (it: OutlineItem) => void }) {
  const listRef = useRef<HTMLDivElement>(null)
  const now = useMemo(() => currentItem(items, current), [items, current])
  // 条目不多就全展开；多的只展开第一层，读到哪一节再把那一节的上层打开
  const [open, setOpen] = useState<Set<number>>(() => new Set(items.length <= 40 ? items.filter((i) => i.hasKids).map((i) => i.id) : []))
  useEffect(() => {
    if (now < 0) return
    const up = ancestors(items, now)
    setOpen((o) => (up.every((id) => o.has(id)) ? o : new Set([...o, ...up])))
  }, [items, now])
  useEffect(() => {
    listRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [now, open])

  const toggle = (id: number) =>
    setOpen((o) => {
      const n = new Set(o)
      if (!n.delete(id)) n.add(id)
      return n
    })

  return (
    <div ref={listRef} className="toc-list">
      {visibleItems(items, open).map((it) => (
        <div key={it.id} className="toc-row" style={{ paddingLeft: 4 + Math.min(it.level, 5) * 12 }} aria-current={it.id === now ? 'true' : undefined}>
          {it.hasKids ? (
            <button type="button" className="toc-fold" aria-expanded={open.has(it.id)} aria-label={`${open.has(it.id) ? '收起' : '展开'}“${it.title}”`} onClick={() => toggle(it.id)}><Icon name="chevron" size={12} /></button>
          ) : (
            <span className="toc-fold" />
          )}
          <button type="button" className="toc-go" title={it.title} disabled={it.page === undefined} onClick={() => onGo(it)}>
            <span className="toc-t">{it.title}</span>
            {it.page !== undefined && <span className="toc-p num">{it.page}</span>}
          </button>
        </div>
      ))}
    </div>
  )
}
