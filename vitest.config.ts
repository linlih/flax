import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    // 第一次加载 pdf.js 要几秒；Windows 的 Actions 机器只有几个核，和同步测试（加密很吃 CPU）一起跑时会超过默认的 5 秒
    testTimeout: 20_000
  }
})
