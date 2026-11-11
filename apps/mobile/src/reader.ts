// 阅读器网页（reader-web/dist）在哪、WebView 怎么打开它。阅读器和导入时读 PDF 信息（pdfFacts.tsx）都用。
// Android：prebuild 时拷进 assets（plugins/withReaderAssets.js），从 file:///android_asset 打开，能读应用里任何文件。
// iOS：拷进应用包里的 reader 文件夹。WKWebView 只许页面读"允许读的文件夹"里的文件，而应用包和资料文件夹不在一处，
// 所以启动后先把网页拷到缓存目录，允许读整个应用目录（资料在 Documents，导入时的临时文件在 Library/Caches）。
import { Platform } from 'react-native'
import { Directory, Paths } from 'expo-file-system'

const ANDROID = 'file:///android_asset/reader/index.html'

let copied: Directory | null = null

/** iOS：每次启动拷一次（不到 2 MB），应用更新后网页也跟着换 */
function iosReader(): Directory {
  if (copied?.exists) return copied
  const from = new Directory(Paths.bundle, 'reader')
  const to = new Directory(Paths.cache, 'reader')
  if (to.exists) to.delete()
  from.copy(to)
  copied = to
  return to
}

/** 给 <WebView> 的 source 和读文件的设置 */
export function readerProps() {
  const common = {
    originWhitelist: ['*'],
    allowFileAccess: true,
    allowFileAccessFromFileURLs: true,
    allowUniversalAccessFromFileURLs: true,
    javaScriptEnabled: true,
    onShouldStartLoadWithRequest: (r: { url: string }) => r.url.startsWith('file://') || r.url.startsWith('blob:') || r.url === 'about:blank'
  }
  if (Platform.OS !== 'ios') return { ...common, source: { uri: ANDROID } }
  const dir = iosReader()
  const root = Paths.document.parentDirectory.uri
  return { ...common, source: { uri: `${dir.uri.replace(/\/?$/, '/')}index.html` }, allowingReadAccessToURL: root }
}
