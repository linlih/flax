// iOS 上一个弹出层（这里的底部面板、操作菜单都是 Modal）还在关的时候，再弹系统的文件选择器、分享面板会被悄悄丢掉。
// 先等它关完再弹。Android 没有这个问题，不等。
import { Platform } from 'react-native'

/** Modal 关闭动画大约 300 毫秒，多留一点 */
const IOS_DISMISS_MS = 450

export function afterModalClose(): Promise<void> {
  return Platform.OS === 'ios' ? new Promise((r) => setTimeout(r, IOS_DISMISS_MS)) : Promise.resolve()
}
