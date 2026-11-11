// prebuild 时给 release 构建配上自己的签名：apps/mobile/signing/release.properties 里写着 keystore 在哪、密码是什么。
// 这个文件夹不进 git（见根目录 .gitignore）。没有它时 release 还用 debug 签名，只能自己装着试，不能发布。
// 换了签名的 APK 装不上旧版本之上：keystore 一定要备份好。
const { withAppBuildGradle } = require('expo/config-plugins')

const BLOCK = `
    // Flax：发布用的签名（plugins/withReleaseSigning.js）
    def flaxSigning = new Properties()
    def flaxSigningFile = new File(projectDir, '../../signing/release.properties')
    if (flaxSigningFile.exists()) flaxSigningFile.withInputStream { flaxSigning.load(it) }
`

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (c) => {
    let g = c.modResults.contents
    if (g.includes('flaxSigning')) return c
    g = g.replace(/android \{\n/, (m) => m + BLOCK)
    g = g.replace(
      /signingConfigs \{\n(\s+)debug \{/,
      (m, sp) =>
        `signingConfigs {\n${sp}if (flaxSigningFile.exists()) {\n${sp}    release {\n${sp}        storeFile new File(flaxSigningFile.parentFile, flaxSigning['storeFile'])\n${sp}        storePassword flaxSigning['storePassword']\n${sp}        keyAlias flaxSigning['keyAlias']\n${sp}        keyPassword flaxSigning['keyPassword']\n${sp}    }\n${sp}}\n${sp}debug {`
    )
    g = g.replace(/(release \{\n(?:\s*\/\/.*\n)*\s+)signingConfig signingConfigs\.debug/, '$1signingConfig flaxSigningFile.exists() ? signingConfigs.release : signingConfigs.debug')
    c.modResults.contents = g
    return c
  })
}
