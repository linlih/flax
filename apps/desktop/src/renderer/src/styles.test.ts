// PDF.js 的 pdf_viewer.css 是全局样式，而且加载在我们的 styles.css 之后。
// 它顶层的类名（比如 .sidebar）一旦和我们的重名，就会悄悄覆盖我们的布局。
// 这个测试保证两边顶层类名不重叠。
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const require = createRequire(import.meta.url)

/** 写在行首（没有缩进、不是嵌套规则）的选择器里出现的类名 */
function topLevelClasses(css: string): Set<string> {
  const out = new Set<string>()
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const line of noComments.split('\n')) {
    if (!/^[^\s@}]/.test(line)) continue
    const selector = line.split('{')[0]!
    for (const m of selector.matchAll(/\.([a-zA-Z][\w-]*)/g)) out.add(m[1]!)
  }
  return out
}

test('our class names do not collide with PDF.js global classes', () => {
  const pdfjs = topLevelClasses(readFileSync(require.resolve('pdfjs-dist/web/pdf_viewer.css'), 'utf8'))
  const ours = topLevelClasses(readFileSync(join(__dirname, 'styles.css'), 'utf8'))
  // 这些是我们特意去改 PDF.js 自己元素的样式
  const intended = new Set(['pdfViewer', 'page', 'textLayer', 'canvasWrapper', 'highlight', 'selected', 'annotationLayer', 'endOfContent', 'loadingIcon'])
  const clash = [...ours].filter((c) => pdfjs.has(c) && !intended.has(c))
  expect(clash).toEqual([])
})

// 网页版里批注是 <mark class="fx-hl hl-underline …">，和 PDF 上的色块共用类名。
// highlights.css 里绝对定位的伪元素（下划线、评论的线）要是没限定在 .hl 上，就会按整个阅读区去画，
// 网页版里出现一条横跨全宽的色条（深色外观下是白条，浅色下是黑条）
test('positioned annotation pseudo-elements only apply to the PDF layer', () => {
  const css = readFileSync(require.resolve('@flax/ui/highlights.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const loose = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, sel, body]) => /position:\s*absolute/.test(body!) && /::?(after|before)/.test(sel!))
    .flatMap(([, sel]) => sel!.split(',').map((s) => s.trim()))
    .filter((s) => /\.hl-(underline|note|highlight)\b/.test(s) && !/\.hl\.hl-/.test(s))
  expect(loose).toEqual([])
})
