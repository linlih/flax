# Flax

开源、本地优先的论文阅读工具，给大量读英文论文的中文读者用。现在只有 macOS 版（Apple 芯片和 Intel 都能用）。

- **文献库**：拖进 PDF 自动识别标题、作者、年份（能在线查 arXiv / DOI 时会补全）；可以从 Zotero 或 BibTeX 导入；导出 BibTeX / RIS；搜索、分组、标签。
- **阅读器**：高亮、批注，摘录直接进笔记；深色模式；⌘ + 滚轮缩放。
- **笔记**：Markdown，存成普通文件，可以用别的编辑器打开。
- **翻译和问 AI**：选中文字，右键"翻译"或"问 AI"。术语表让同一个词全文译法一致。
- **数据在自己电脑上**：一个文件夹，随时备份和恢复。

## AI 和隐私

Flax 不会自己读你的论文，也不会把论文发出去。只有你选中、并且点了"翻译"或"问 AI"的那段文字，才会发给你在设置里配好的模型服务（Anthropic、OpenAI 兼容服务，或者本机的 Ollama）。API Key 用系统钥匙串加密存在本机，不进备份。

## 安装

到 [Releases](https://github.com/linlih/flax/releases) 下载 `Flax-<版本>-universal.dmg`。装好后会自动检查更新。

## 开发

需要 Node.js 22 或更高版本。

```bash
npm install
npm run dev        # 开发模式启动
npm test           # 单元测试
npm run typecheck  # 类型检查
npm run dist -w @paper/desktop   # 打未签名的 macOS 安装包，输出在 apps/desktop/dist
```

签名、公证和发布新版本的步骤见 [docs/10-桌面MVP实施计划.md](docs/10-桌面MVP实施计划.md) 的 M7 一节。完整设计文档在 [docs/](docs/README.md)。

## 许可

[AGPL-3.0](LICENSE)
