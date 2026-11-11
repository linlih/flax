// prebuild 时把阅读器的网页（reader-web/dist，先跑 npm run build:reader）放进应用里：
// Android 拷进 assets，WebView 从 file:///android_asset/reader/index.html 打开；
// iOS 拷进 ios/<项目>/reader，作为文件夹资源加进 Xcode 工程，打包后在应用包的 reader/ 里（src/reader.ts 再拷出来打开）。
const { withDangerousMod, withXcodeProject, IOSConfig } = require('expo/config-plugins')
const fs = require('fs')
const path = require('path')

function copyReader(projectRoot, to) {
  const from = path.join(projectRoot, 'reader-web', 'dist')
  if (!fs.existsSync(path.join(from, 'index.html'))) throw new Error('阅读器还没打包：先在 apps/mobile 里跑 npm run build:reader')
  fs.rmSync(to, { recursive: true, force: true })
  fs.cpSync(from, to, { recursive: true })
}

module.exports = function withReaderAssets(config) {
  config = withDangerousMod(config, [
    'android',
    async (c) => {
      copyReader(c.modRequest.projectRoot, path.join(c.modRequest.platformProjectRoot, 'app', 'src', 'main', 'assets', 'reader'))
      return c
    }
  ])
  config = withDangerousMod(config, [
    'ios',
    async (c) => {
      copyReader(c.modRequest.projectRoot, path.join(c.modRequest.platformProjectRoot, c.modRequest.projectName, 'reader'))
      return c
    }
  ])
  return withXcodeProject(config, (c) => {
    const proj = c.modResults
    const name = IOSConfig.XcodeUtils.getProjectName(c.modRequest.projectRoot)
    const group = proj.findPBXGroupKey({ name }) ?? proj.findPBXGroupKey({ path: name })
    // 文件夹引用（蓝色文件夹）：整个目录原样进应用包，里面加减文件不用改工程。
    // 这个组没有自己的目录，组里的文件都写成 <项目>/文件名
    const file = `${name}/reader`
    if (!proj.hasFile(file)) proj.addResourceFile(file, { lastKnownFileType: 'folder', target: proj.getFirstTarget().uuid }, group)
    return c
  })
}
