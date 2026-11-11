// 阅读状态在界面上怎么显示。规则在 core 里（桌面和手机共用），这里加上桌面的图标
import type { ReadingStatus } from '@flax/core'
import type { IconName } from '../components/Icon'

export { STATUSES, isNew, progress, STALE_DAYS, isStale, sortReading, nearEnd } from '@flax/core'

export const STATUS_ICON: Record<Exclude<ReadingStatus, 'inbox'>, IconName> = { to_read: 'toread', reading: 'reading', done: 'done' }
