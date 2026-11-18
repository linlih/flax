// 在应用里更新：把 GitHub 发布里的 .apk 下载到缓存目录，再交给系统的安装程序（不用去浏览器）。
// 第一次装会让用户在系统设置里允许 Flax"安装未知应用"。装的包签名要和手机上的一样，不然系统不让装。
package app.flax.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/** 单独一个类：别的库（expo-sharing 等）也声明了 androidx 的 FileProvider，同一个类在清单里只能出现一次 */
class UpdateFileProvider : FileProvider()

class FlaxUpdateModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private fun dir(): File = File(context.cacheDir, "updates")

  /** 下载的包和装着的应用是不是同一个签名（看不出来时当成一样，交给系统判断） */
  @Suppress("DEPRECATION")
  private fun sameSigner(file: File): Boolean = runCatching {
    val pm = context.packageManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      val flag = android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES
      val apk = pm.getPackageArchiveInfo(file.path, flag)?.signingInfo ?: return@runCatching true
      val mine = pm.getPackageInfo(context.packageName, flag).signingInfo ?: return@runCatching true
      val theirs = (if (apk.hasMultipleSigners()) apk.apkContentsSigners else apk.signingCertificateHistory).map { it.toCharsString() }.toSet()
      val ours = (if (mine.hasMultipleSigners()) mine.apkContentsSigners else mine.signingCertificateHistory).map { it.toCharsString() }.toSet()
      theirs.intersect(ours).isNotEmpty()
    } else {
      val flag = android.content.pm.PackageManager.GET_SIGNATURES
      val apk = pm.getPackageArchiveInfo(file.path, flag)?.signatures ?: return@runCatching true
      val mine = pm.getPackageInfo(context.packageName, flag).signatures ?: return@runCatching true
      apk.map { it.toCharsString() }.toSet() == mine.map { it.toCharsString() }.toSet()
    }
  }.getOrDefault(true)

  /** 正在下载的那一个：再点下载先停掉它 */
  private var cancel: AtomicBoolean? = null

  override fun definition() = ModuleDefinition {
    Name("FlaxUpdate")
    Events("progress")

    // 上次下的包要么已经装上了，要么不要了
    OnCreate {
      runCatching { dir().listFiles()?.forEach { it.delete() } }
    }

    /** 下载到缓存目录，返回文件路径；下载中发 progress { done, total }（total 不知道时是 0） */
    AsyncFunction("download") { url: String, name: String, promise: Promise ->
      cancel?.set(true)
      val stop = AtomicBoolean(false)
      cancel = stop
      Thread {
        val out = File(dir(), name.replace(Regex("[^A-Za-z0-9._-]"), "_"))
        val part = File(out.path + ".part")
        try {
          dir().mkdirs()
          var conn = URL(url).openConnection() as HttpURLConnection
          // GitHub 的下载链接会跳到另一个域名；跳几次都跟着
          var hops = 0
          while (true) {
            conn.connectTimeout = 20_000
            conn.readTimeout = 30_000
            conn.instanceFollowRedirects = false
            val code = conn.responseCode
            if (code in 300..399 && hops < 5) {
              val next = conn.getHeaderField("Location") ?: break
              conn.disconnect()
              conn = URL(URL(url), next).openConnection() as HttpURLConnection
              hops++
              continue
            }
            if (code !in 200..299) throw Exception("服务器返回 $code")
            break
          }
          val total = conn.contentLengthLong.coerceAtLeast(0)
          var done = 0L
          var lastSent = 0L
          conn.inputStream.use { input ->
            part.outputStream().use { output ->
              val buf = ByteArray(64 * 1024)
              while (true) {
                if (stop.get()) throw InterruptedException()
                val n = input.read(buf)
                if (n < 0) break
                output.write(buf, 0, n)
                done += n
                val now = System.currentTimeMillis()
                if (now - lastSent > 250) {
                  lastSent = now
                  sendEvent("progress", mapOf("done" to done, "total" to total))
                }
              }
            }
          }
          conn.disconnect()
          if (total > 0 && done != total) throw Exception("没下载完整")
          out.delete()
          if (!part.renameTo(out)) throw Exception("保存失败")
          sendEvent("progress", mapOf("done" to done, "total" to total))
          promise.resolve(out.absolutePath)
        } catch (e: InterruptedException) {
          part.delete()
          promise.reject("cancelled", "已取消", null)
        } catch (e: Exception) {
          part.delete()
          promise.reject("download", "下载失败：${e.message ?: e.javaClass.simpleName}", e)
        }
      }.start()
    }

    Function("cancel") {
      cancel?.set(true)
      cancel = null
    }

    /** 打开系统安装界面。还没允许"安装未知应用"时先打开那个设置页，返回 "permission"；打开了安装界面返回 "started" */
    AsyncFunction("install") { path: String, promise: Promise ->
      try {
        val file = File(path)
        if (file.parentFile?.canonicalPath != dir().canonicalPath || !file.exists()) {
          promise.reject("missing", "安装包不见了，重新下载一次", null)
          return@AsyncFunction
        }
        val activity = appContext.currentActivity ?: throw Exceptions.MissingActivity()
        // 签名和手机上装的不一样，系统只会说"未安装应用"：先说清楚
        if (!sameSigner(file)) {
          promise.reject("mismatch", "这个安装包的签名和手机上的 Flax 不一样（手机上的大概是自己编译装的），系统不让直接覆盖。要先卸载再装：卸载会删掉手机上的资料，先同步一次。", null)
          return@AsyncFunction
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
          activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName)))
          promise.resolve("permission")
          return@AsyncFunction
        }
        val uri = FileProvider.getUriForFile(activity, activity.packageName + ".flax.update", file)
        activity.startActivity(Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(uri, "application/vnd.android.package-archive")
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        })
        promise.resolve("started")
      } catch (e: Exception) {
        promise.reject("install", "打不开安装界面：${e.message ?: e.javaClass.simpleName}", e)
      }
    }

    /** 能不能直接装（已经允许"安装未知应用"） */
    Function("canInstall") {
      Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()
    }
  }
}
