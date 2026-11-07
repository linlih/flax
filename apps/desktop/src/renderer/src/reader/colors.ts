// 标注颜色，阅读器和工具栏共用（单独放一个文件，组件文件只导出组件，热更新才能生效）
import type { HighlightColor } from '@paper/core'

export const COLORS: { id: HighlightColor; label: string }[] = [
  { id: 'yellow', label: '黄色' },
  { id: 'green', label: '绿色' },
  { id: 'blue', label: '蓝色' },
  { id: 'pink', label: '粉色' },
  { id: 'purple', label: '紫色' }
]
