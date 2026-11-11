// 只在开发版里有用：flax://dev-import?name=x.pdf 导入缓存目录里的 x.pdf，走和文件选择器一样的 importFiles。
// 系统文件选择器不接受 adb 模拟的点击，自动测试导入时用它（先 adb push 到 /data/local/tmp，再 run-as 拷进 cache/）。
import { useEffect } from 'react'
import { router, useLocalSearchParams } from 'expo-router'
import { File, Paths } from 'expo-file-system'
import { importFiles } from '../src/importPdf'
import { showNotice } from '../src/services'

export default function DevImport() {
  const { name } = useLocalSearchParams<{ name?: string }>()
  useEffect(() => {
    void (async () => {
      if (__DEV__ && name && !/[\\/]/.test(name)) {
        const f = new File(Paths.cache, name)
        if (f.exists) await importFiles([f])
        else showNotice(`缓存目录里没有 ${name}`)
      }
      if (router.canGoBack()) router.back()
      else router.replace('/')
    })()
  }, [name])
  return null
}
