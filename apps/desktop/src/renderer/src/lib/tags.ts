import type { TagColor } from '@flax/core'

/** 把一篇论文的标签 old 改成 next：位置不变；改成空就是删掉；改成已有的标签就合并成一个 */
export function renameTag(tags: string[], old: string, next: string): string[] {
  const t = next.trim().replace(/^#/, '')
  if (t === old) return tags
  if (!t || (tags.includes(t))) return tags.filter((x) => x !== old)
  return tags.map((x) => (x === old ? t : x))
}

export const TAG_COLOR_LABEL: Record<TagColor, string> = { red: '红色', orange: '橙色', yellow: '黄色', green: '绿色', blue: '蓝色', purple: '紫色', gray: '灰色' }

/** 标签 → 颜色 */
export function tagColorMap(tags: { tag: string; color?: TagColor }[]): Map<string, TagColor> {
  return new Map(tags.flatMap((t) => (t.color ? [[t.tag, t.color] as const] : [])))
}
