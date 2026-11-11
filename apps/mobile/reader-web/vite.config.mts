// 阅读器的网页：打包成一个普通脚本（不是 ES 模块，file:// 打开的页面加载模块脚本会被拦），
// pdf.js 的 worker 内联成 Blob，字体和 CMap 拷到输出目录。输出直接放进 Android 的 assets（见 ../plugins/withReaderAssets.js）。
import { defineConfig } from 'vite'
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, 'dist')
const pdfjs = dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')))

export default defineConfig({
  root: here,
  base: './',
  build: {
    outDir: out,
    emptyOutDir: true,
    target: 'chrome100',
    cssCodeSplit: false,
    lib: { entry: resolve(here, 'src/main.ts'), name: 'FlaxReader', formats: ['iife'], fileName: () => 'reader.js', cssFileName: 'reader' },
    rollupOptions: { output: { inlineDynamicImports: true } }
  },
  worker: { format: 'iife' },
  plugins: [
    {
      name: 'flax-reader-assets',
      closeBundle() {
        for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
          try {
            cpSync(join(pdfjs, d), join(out, d), { recursive: true })
          } catch {
            /* 这一版的 pdf.js 没有这个目录 */
          }
        }
        mkdirSync(out, { recursive: true })
        writeFileSync(
          join(out, 'index.html'),
          `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<link rel="stylesheet" href="reader.css">
</head>
<body>
<div id="scroll"><div id="viewer" class="pdfViewer"></div></div>
<script src="reader.js"></script>
</body>
</html>
`
        )
      }
    }
  ]
})
