// 颜色：和 packages/ui/tokens.css 同一套，加上 Material 3 在 Android 上用的几个容器色（见手机原型）。
import { useColorScheme } from 'react-native'
import type { HighlightColor, TagColor } from '@flax/core'

const light = {
  dark: false,
  bg: '#FFFFFF',
  surface: '#F4F5F8',
  bar: '#F4F5F8',
  desk: '#E4E4E6',
  card: '#FFFFFF',
  line: '#EBEBEB',
  outline: '#A1A4AD',
  chipLine: '#C9CBD2',
  text: '#0A0A0A',
  body: '#404040',
  sub: '#6B6B6B',
  placeholder: '#A1A1A1',
  accent: '#155DFC',
  accentText: '#155DFC',
  onAccent: '#FFFFFF',
  container: '#DCE7FF',
  onContainer: '#0B3BA8',
  ok: '#1F7A43',
  danger: '#C62828',
  scrim: 'rgba(0,0,0,0.32)'
}

const dark: typeof light = {
  dark: true,
  bg: '#121212',
  surface: '#1E1F22',
  bar: '#1A1B1E',
  desk: '#0A0A0A',
  card: '#242424',
  line: '#333333',
  outline: '#6B6E76',
  chipLine: '#4A4C52',
  text: '#F2F2F2',
  body: '#C8C8C8',
  sub: '#A3A3A3',
  placeholder: '#737373',
  accent: '#3D7BFF',
  accentText: '#6AA5FF',
  onAccent: '#FFFFFF',
  container: '#1C2A40',
  onContainer: '#BFD7FF',
  ok: '#5CC98A',
  danger: '#FF8A80',
  scrim: 'rgba(0,0,0,0.5)'
}

export type Theme = typeof light

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light
}

/** 高亮色块（工具条、批注列表左边那条）：深浅模式都用原色 */
export const SWATCH: Record<HighlightColor, string> = { yellow: '#FFD43B', green: '#51CF66', blue: '#4DABF7', pink: '#F783AC', purple: '#B197FC' }

/** 标签颜色，和桌面 styles.css 的 .tc-* 一样 */
export const TAG: Record<TagColor, string> = { red: '#E5484D', orange: '#F76B15', yellow: '#E2A400', green: '#30A46C', blue: '#3E7BFA', purple: '#8E4EC6', gray: '#8B8D98' }
