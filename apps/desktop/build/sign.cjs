// electron-builder 的 afterPack：用 Flax 自己的证书（scripts/macos-signing.sh 生成）签 Mac 应用。
// 不走苹果的 Developer ID 和公证，跟 Folio 一样：每个版本都用同一张证书签，macOS 才认得是同一个应用，
// 自动更新（Squirrel.Mac 要求新版本和旧版本签名一致）也能用。钥匙串里没有这张证书时退回临时签名，只能手动装新版本。
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
const { Arch } = require('electron-builder')

const NAME = process.env.FLAX_SIGN_IDENTITY || 'Flax Code Signing'

function identity() {
  try {
    const out = execFileSync('security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' })
    if (out.includes(`"${NAME}"`)) return NAME
  } catch {
    /* 没有 security 命令就当没有证书 */
  }
  console.warn(`  • 钥匙串里没有 "${NAME}"，用临时签名（装好的应用不能自动更新到这个版本）。先运行 scripts/macos-signing.sh`)
  return '-'
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  // 通用包是先分别打 x64、arm64 再合并的，只签合并后的那个：先签会让两边的签名文件不一样，合并不了
  if (context.arch !== Arch.universal) return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const id = identity()
  execFileSync('codesign', ['--force', '--deep', '--sign', id, app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  console.log(`  • 已签名：${id === '-' ? '临时签名' : id}`)
}
