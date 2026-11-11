// 线性图标，1.6px 描边，跟随文字颜色。路径在 packages/ui/icons.ts，手机也用
import { ICON_PATHS as PATHS, iconStroke, type IconName } from '@flax/ui/icons'

export type { IconName }

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={iconStroke(name)} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  )
}

export function Spinner({ size = 12 }: { size?: number }) {
  return (
    <svg className="spin" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth={3} strokeLinecap="round" aria-hidden="true">
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  )
}
