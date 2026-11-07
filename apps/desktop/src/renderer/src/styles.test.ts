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
