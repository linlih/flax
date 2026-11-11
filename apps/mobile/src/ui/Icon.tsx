// 线性图标：和桌面同一套路径（packages/ui/icons.ts），用 react-native-svg 画。
import Svg, { Path } from 'react-native-svg'
import { ICON_PATHS, iconStroke, type IconName as PathName } from '@flax/ui/icons'

// 手机上早先用的名字，对到共用的图标上
const ALIAS = {
  back: 'arrowBack',
  add: 'plus',
  more: 'moreV',
  check: 'done',
  ai: 'sparkle',
  note: 'notes',
  list: 'menu'
} as const satisfies Record<string, PathName>

export type IconName = PathName | keyof typeof ALIAS

export function Icon({ name, size = 22, color }: { name: IconName; size?: number; color: string }) {
  const p: PathName = name in ALIAS ? ALIAS[name as keyof typeof ALIAS] : (name as PathName)
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={iconStroke(p)} strokeLinecap="round" strokeLinejoin="round" accessible={false}>
      <Path d={ICON_PATHS[p]} />
    </Svg>
  )
}
