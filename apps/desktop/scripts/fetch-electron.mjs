// 打包前先把 Electron 的 zip 下到 .electron-dist/，electron-builder 从这里拿（build.electronDist），自己不再下载。
// 为什么：GitHub 的 Release 下载经常 504 / 超时，electron-builder 失败一次就整个打包失败（v0.1.2 连着挂了三次）。
// 这里每个文件先从 GitHub 下，失败就等一会儿重试；GitHub 一直不行再用 Electron 文档里列的镜像（npmmirror）。
// 不管从哪下，都用 electron 包自带的 checksums.json（来自 npm，和版本号绑定）核对 SHA-256，对不上就丢掉，所以镜像也换不了文件。
// CI 里这个文件夹按 Electron 版本缓存，下过一次以后就不用再下。
//
// 用法：node scripts/fetch-electron.mjs darwin-arm64 darwin-x64   （不写就按当前系统：Mac 两个架构，Windows x64）
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', '.electron-dist')
const require = createRequire(import.meta.url)
const pkgDir = dirname(require.resolve('electron/package.json'))
const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version
const sums = JSON.parse(readFileSync(join(pkgDir, 'checksums.json'), 'utf8'))

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : process.platform === 'darwin' ? ['darwin-arm64', 'darwin-x64'] : process.platform === 'win32' ? ['win32-x64'] : ['linux-x64']

const SOURCES = [
  { name: 'GitHub', url: (f) => `https://github.com/electron/electron/releases/download/v${version}/${f}`, tries: 4 },
  { name: 'npmmirror', url: (f) => `https://npmmirror.com/mirrors/electron/${version}/${f}`, tries: 3 }
]
// @electron/get 平时的缓存（npm install electron 时下过的）：本机打包时直接拿来用，不用再下
const CACHES = [
  join(homedir(), 'Library', 'Caches', 'electron'),
  join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'electron', 'Cache'),
  join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'electron')
]
function fromCache(file, want) {
  for (const dir of CACHES) {
    if (!existsSync(dir)) continue
    for (const sub of readdirSync(dir)) {
      const p = join(dir, sub, file)
      if (existsSync(p) && sha256(readFileSync(p)) === want) return p
    }
  }
  return null
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

async function download(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function fetchOne(target) {
  const file = `electron-v${version}-${target}.zip`
  const want = sums[file]
  if (!want) throw new Error(`checksums.json 里没有 ${file}`)
  const dest = join(out, file)
  if (existsSync(dest) && sha256(readFileSync(dest)) === want) return console.log(`  ✓ ${file}（已有）`)
  const cached = fromCache(file, want)
  if (cached) {
    copyFileSync(cached, dest)
    return console.log(`  ✓ ${file}（本机缓存）`)
  }
  for (const src of SOURCES) {
    for (let i = 1; i <= src.tries; i++) {
      try {
        const buf = await download(src.url(file))
        if (sha256(buf) !== want) throw new Error('SHA-256 对不上')
        writeFileSync(dest + '.part', buf)
        renameSync(dest + '.part', dest)
        return console.log(`  ✓ ${file}（${src.name}，${(buf.length / 1048576).toFixed(0)} MB）`)
      } catch (e) {
        console.warn(`  · ${file} 从 ${src.name} 下载失败（第 ${i} 次）：${e instanceof Error ? e.message : e}`)
        rmSync(dest + '.part', { force: true })
        if (i < src.tries) await sleep(15_000 * i)
      }
    }
  }
  throw new Error(`下载不了 ${file}`)
}

mkdirSync(out, { recursive: true })
console.log(`Electron ${version} → ${out}`)
for (const t of targets) await fetchOne(t)
