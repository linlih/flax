// monorepo：Metro 要能看到仓库根的 node_modules 和 packages/core 的 TS 源码。
const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const root = path.resolve(__dirname, '../..')
const config = getDefaultConfig(__dirname)

config.watchFolders = [path.join(root, 'packages')]
config.resolver.nodeModulesPaths = [path.join(__dirname, 'node_modules'), path.join(root, 'node_modules')]
// @flax/core 的 "exports"（./ai/runtime）
config.resolver.unstable_enablePackageExports = true

// 桌面用 react 19.3.1，装在仓库根；手机版的 19.3.0（SDK 58 指定，RN 的渲染器要求版本一致）装在 apps/mobile/node_modules。
// 根目录的 react-native、expo-router 等也会 require('react')，统一指到手机版这一份，免得打包进两份。
const ownReact = path.join(__dirname, 'node_modules')
config.resolver.resolveRequest = (ctx, name, platform) => {
  if (name === 'react' || name.startsWith('react/')) {
    return ctx.resolveRequest({ ...ctx, originModulePath: path.join(ownReact, 'index.js') }, name, platform)
  }
  // Anthropic SDK 的 .mjs 里有循环的 `export { X } from`，Metro 按顺序执行时拿到 undefined
  // （"Cannot read property 'BetaToolRunner' of undefined"）。CommonJS 版用 getter 导出，循环没问题
  if (name === '@anthropic-ai/sdk' || name.startsWith('@anthropic-ai/sdk/') || ctx.originModulePath.includes('/@anthropic-ai/sdk/')) {
    return ctx.resolveRequest({ ...ctx, unstable_conditionNames: ['require', 'react-native', 'default'], preferNativePlatform: false }, name, platform)
  }
  return ctx.resolveRequest(ctx, name, platform)
}

module.exports = config
