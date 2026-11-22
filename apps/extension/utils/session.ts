// 一次保存的状态：后台（background.ts）负责存，网页里的保存窗口（save-window.content）只负责显示和改文件夹、标签。
// 两边靠这些消息说话。

/** PDF 这一行：none 还没开始；page 插件正在从网页下；flax Flax 正在找、正在下；done 有了；missing 没拿到（reason 是下载出错的原因） */
export type PdfStep =
  | { kind: 'none' }
  | { kind: 'page' }
  | { kind: 'flax' }
  | { kind: 'done' }
  | { kind: 'missing'; reason?: string }

export type SaveState =
  | { phase: 'reading' }
  | { phase: 'saving'; title?: string; pdfTab: boolean }
  | { phase: 'saved'; paperId: string; title: string; status: 'added' | 'existing'; pdf: PdfStep; folder: string | null }
  | { phase: 'no_paper' }
  | { phase: 'offline'; waking: boolean }
  | { phase: 'error'; message: string }

/** 后台 → 窗口 */
export type ToWindow = { type: 'flax:state'; state: SaveState } | { type: 'flax:show' }

/** 窗口 → 后台 */
export type ToBackground =
  | { type: 'flax:hello' }
  | { type: 'flax:targets' }
  | { type: 'flax:folder'; folder: string | null }
  | { type: 'flax:tags'; add?: string[]; remove?: string[] }
  | { type: 'flax:open' }
  | { type: 'flax:wake' }
  | { type: 'flax:retry' }

/** 还在做事（窗口不自动关；再点图标不重新存） */
export function busy(s: SaveState): boolean {
  return s.phase === 'reading' || s.phase === 'saving' || (s.phase === 'offline' && s.waking) || (s.phase === 'saved' && (s.pdf.kind === 'page' || s.pdf.kind === 'flax'))
}
