// prebuild 时把阅读器的网页（reader-web/dist，先跑 npm run build:reader）拷进 Android 的 assets，
// WebView 从 file:///android_asset/reader/index.html 打开。
const { withDangerousMod } = require('expo/config-plugins')
const fs = require('fs')
const path = require('path')

module.exports = function withReaderAssets(config) {
  return withDangerousMod(config, [
    'android',
    async (c) => {
      const from = path.join(c.modRequest.projectRoot, 'reader-web', 'dist')
      const to = path.join(c.modRequest.platformProjectRoot, 'app', 'src', 'main', 'assets', 'reader')
      if (!fs.existsSync(path.join(from, 'index.html'))) throw new Error('阅读器还没打包：先在 apps/mobile 里跑 npm run build:reader')
      fs.rmSync(to, { recursive: true, force: true })
      fs.cpSync(from, to, { recursive: true })
      return c
    }
  ])
}
