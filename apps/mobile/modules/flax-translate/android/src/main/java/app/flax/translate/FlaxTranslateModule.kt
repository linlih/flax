// Android 上的系统翻译：Google ML Kit 的离线翻译。英语、中文的语言包第一次下载（各约 30 MB），之后在手机上翻、不联网、不用 Key。
// 语言包从 Google 的服务器下载：连不上 Google 的网络下载会失败（已经下好的照常用）。
package app.flax.translate

import com.google.mlkit.common.model.DownloadConditions
import com.google.mlkit.common.model.RemoteModelManager
import com.google.mlkit.nl.translate.TranslateLanguage
import com.google.mlkit.nl.translate.TranslateRemoteModel
import com.google.mlkit.nl.translate.Translation
import com.google.mlkit.nl.translate.Translator
import com.google.mlkit.nl.translate.TranslatorOptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class FlaxTranslateModule : Module() {
  private var toZh: Translator? = null
  private var toEn: Translator? = null

  private fun translator(toEnglish: Boolean): Translator {
    val cur = if (toEnglish) toEn else toZh
    if (cur != null) return cur
    val opts = TranslatorOptions.Builder()
      .setSourceLanguage(if (toEnglish) TranslateLanguage.CHINESE else TranslateLanguage.ENGLISH)
      .setTargetLanguage(if (toEnglish) TranslateLanguage.ENGLISH else TranslateLanguage.CHINESE)
      .build()
    val t = Translation.getClient(opts)
    if (toEnglish) toEn = t else toZh = t
    return t
  }

  /** installed：英语和中文都下好了；supported：要先下载 */
  private fun status(done: (String) -> Unit, fail: (Exception) -> Unit) {
    RemoteModelManager.getInstance().getDownloadedModels(TranslateRemoteModel::class.java)
      .addOnSuccessListener { models ->
        val langs = models.map { it.language }.toSet()
        done(if (TranslateLanguage.CHINESE in langs && TranslateLanguage.ENGLISH in langs) "installed" else "supported")
      }
      .addOnFailureListener { fail(it) }
  }

  override fun definition() = ModuleDefinition {
    Name("FlaxTranslate")

    AsyncFunction("status") { promise: Promise ->
      status({ promise.resolve(it) }, { promise.resolve("supported") })
    }

    AsyncFunction("prepare") { promise: Promise ->
      translator(false).downloadModelIfNeeded(DownloadConditions.Builder().build())
        .addOnSuccessListener { status({ promise.resolve(it) }, { promise.resolve("installed") }) }
        .addOnFailureListener { promise.reject("download", "语言包下载不了：${it.message ?: "连不上 Google 的服务器"}", it) }
    }

    AsyncFunction("translate") { text: String, toEnglish: Boolean, promise: Promise ->
      status({ st ->
        if (st != "installed") {
          promise.reject("not_installed", "还没有下载英语和中文：在\"设置 → 翻译\"里下载。", null)
        } else {
          translator(toEnglish).translate(text)
            .addOnSuccessListener { promise.resolve(it) }
            .addOnFailureListener { promise.reject("other", it.message ?: "翻译失败", it) }
        }
      }, { promise.reject("other", it.message ?: "翻译失败", it) })
    }

    OnDestroy {
      toZh?.close()
      toEn?.close()
      toZh = null
      toEn = null
    }
  }
}
