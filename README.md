# Flax

开源、本地优先的论文阅读工具，给大量读英文论文的中文读者用。有 macOS 版（Apple 芯片和 Intel 都能用）和 Windows 版（64 位）。

- **文献库**：拖进 PDF 自动识别标题、作者、年份（能在线查 arXiv / DOI 时会补全）；可以从 Zotero 或 BibTeX 导入；导出 BibTeX / RIS；搜索、分组、标签。
- **阅读器**：高亮、批注，摘录直接进笔记；深色模式；⌘ + 滚轮缩放。
- **笔记**：Markdown，存成普通文件，可以用别的编辑器打开。
- **翻译和问 AI**：选中文字，右键"翻译"或"问 AI"。术语表让同一个词全文译法一致。
- **数据在自己电脑上**：一个文件夹，随时备份和恢复。

## AI 和隐私

Flax 不会自己读你的论文，也不会把论文发出去。在 macOS 上，翻译默认用系统自带的翻译，在本机完成。只有你选中、并且点了"问 AI"（或者在设置里把翻译换成 AI、某家翻译服务）的那段文字，才会发给你配好的服务（Anthropic、OpenAI 兼容服务、本机的 Ollama，或腾讯、百度、有道、DeepL、微软的翻译 API）。API Key 用系统的密钥存储（macOS 钥匙串、Windows DPAPI）加密存在本机，不进备份。

## 安装

到 [Releases](https://github.com/linlih/flax/releases) 下载：macOS 用 `Flax-<版本>-universal.dmg`，Windows 用 `Flax-<版本>-setup.exe`。装好后会自动检查更新。

安装包用 Flax 自己的证书签名，没有经过苹果公证：第一次打开时 macOS 会拦一下，到"系统设置 › 隐私与安全性"里点"仍要打开"就行，之后的更新不会再问。Windows 版没有代码签名证书，第一次运行时 SmartScreen 会提示"Windows 已保护你的电脑"，点"更多信息 › 仍要运行"。

Windows 上没有系统翻译，翻译用 AI 或在设置里配一家翻译服务。

## 开发

需要 Node.js 22 或更高版本。

```bash
npm install
npm run dev        # 开发模式启动
npm test           # 单元测试
npm run typecheck  # 类型检查
npm run dist       # 打 macOS 安装包，输出在 apps/desktop/dist
npm run dist:win -w @paper/desktop   # 在 Windows 上打安装包
npm run release -- 0.1.2 -m "发布说明" --push   # 发布新版本，GitHub Actions 打包上传
```

签名和发布的细节见 [docs/10-桌面MVP实施计划.md](docs/10-桌面MVP实施计划.md) 的 M7 一节。完整设计文档在 [docs/](docs/README.md)。

## 许可

[AGPL-3.0](LICENSE)
