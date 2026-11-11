// 别的应用分享过来时，系统用 flax:///expo-sharing 打开 Flax。真正的处理在根布局的 useIncomingShare（src/share.ts），
// 这个页面只是让路由有个落脚的地方，马上回文献库。
import { Redirect } from 'expo-router'

export default function SharedIn() {
  return <Redirect href="/" />
}
