import { defineConfig } from 'wxt'

// 设计见 docs/12-浏览器插件.md。权限按第 5.2 节：本机（连 Flax）加所有网站（读论文页面；第 2 阶段在浏览器里下 PDF）
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Flax',
    description: '把正在看的论文存进 Flax 文献库。只和这台电脑上的 Flax 连接。',
    permissions: ['storage', 'scripting'],
    host_permissions: ['http://127.0.0.1/*', 'http://*/*', 'https://*/*'],
    action: { default_title: '存进 Flax' }
  }
})
