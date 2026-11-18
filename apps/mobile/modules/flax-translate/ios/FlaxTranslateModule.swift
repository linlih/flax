// iPhone 自带的翻译（Apple 的 Translation 框架，iOS 18 起）：在手机上翻，不联网、不用 Key。
// 这个框架只能通过 SwiftUI 的 .translationTask 拿到会话，所以放一个看不见的 SwiftUI 视图在窗口里，
// 每次翻译换一下它的配置，会话就交过来。语言没下载时系统自己弹出下载的面板。
import ExpoModulesCore
import SwiftUI
#if canImport(Translation)
import Translation
#endif

public class FlaxTranslateModule: Module {
  public func definition() -> ModuleDefinition {
    Name("FlaxTranslate")

    /// installed：能用；supported：要先下载英语和中文；unsupported：系统太旧
    AsyncFunction("status") { () async -> String in
      #if canImport(Translation)
      if #available(iOS 18.0, *) { return await TranslateHost.status() }
      #endif
      return "unsupported"
    }

    /// 下载英语和中文（系统弹出确认面板）。返回下载后的状态
    AsyncFunction("prepare") { () async throws -> String in
      #if canImport(Translation)
      if #available(iOS 18.0, *) {
        try await TranslateHost.shared.run(.prepare, toEnglish: false)
        return await TranslateHost.status()
      }
      #endif
      return "unsupported"
    }

    AsyncFunction("translate") { (text: String, toEnglish: Bool) async throws -> String in
      #if canImport(Translation)
      if #available(iOS 18.0, *) {
        return try await TranslateHost.shared.run(.translate(text), toEnglish: toEnglish)
      }
      #endif
      throw TranslateException("unsupported", "这台手机的系统太旧，用不了系统翻译（要 iOS 18 或更新）。")
    }
  }
}

func TranslateException(_ code: String, _ message: String) -> Exception {
  Exception(name: "TranslateError", description: message, code: code)
}

#if canImport(Translation)
@available(iOS 18.0, *)
enum TranslateJob {
  case prepare
  case translate(String)
}

@available(iOS 18.0, *)
@MainActor
final class TranslateHost: ObservableObject {
  static let shared = TranslateHost()

  static let en = Locale.Language(identifier: "en")
  static let zh = Locale.Language(identifier: "zh-Hans")

  static func status() async -> String {
    switch await LanguageAvailability().status(from: en, to: zh) {
    case .installed: return "installed"
    case .supported: return "supported"
    default: return "unsupported"
    }
  }

  @Published var config: TranslationSession.Configuration?
  private var job: (TranslateJob, CheckedContinuation<String, Error>)?
  /** 系统把会话交过来了（交过来之前卡住说明视图没挂好：过一会儿报错，别让后面的翻译一直排队） */
  private var started = false
  private var serial = 0
  private var queue: [(TranslateJob, Bool, CheckedContinuation<String, Error>)] = []
  private var hosting: UIHostingController<HostView>?

  @discardableResult
  func run(_ job: TranslateJob, toEnglish: Bool) async throws -> String {
    try await withCheckedThrowingContinuation { cont in
      queue.append((job, toEnglish, cont))
      next()
    }
  }

  /// 一次只翻一段：上一段完了再换配置开始下一段
  private func next() {
    guard job == nil, !queue.isEmpty else { return }
    let (j, toEnglish, cont) = queue.removeFirst()
    guard attach() else {
      cont.resume(throwing: TranslateException("unavailable", "系统翻译现在用不了。"))
      return next()
    }
    job = (j, cont)
    started = false
    serial += 1
    let mine = serial
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 12_000_000_000)
      guard self.serial == mine, !self.started, let (_, c) = self.job else { return }
      self.job = nil
      self.config = nil
      self.detach()
      c.resume(throwing: TranslateException("unavailable", "系统翻译没有响应。退出 Flax 再打开试试；还不行就到系统的\"设置 → App → 翻译\"里下载英语和中文。"))
      self.next()
    }
    let source = toEnglish ? Self.zh : Self.en
    let target = toEnglish ? Self.en : Self.zh
    if var c = config, c.source == source, c.target == target {
      c.invalidate()
      config = c
    } else {
      config = TranslationSession.Configuration(source: source, target: target)
    }
  }

  func perform(_ session: TranslationSession) async {
    guard let (j, cont) = job else { return }
    started = true
    do {
      switch j {
      case .prepare:
        try await session.prepareTranslation()
        cont.resume(returning: "")
      case .translate(let text):
        let r = try await session.translate(text)
        cont.resume(returning: r.targetText)
      }
    } catch {
      cont.resume(throwing: Self.describe(error))
    }
    job = nil
    next()
  }

  private static func describe(_ error: Error) -> Error {
    if let e = error as? TranslationError {
      switch e {
      case .unsupportedLanguagePairing, .unsupportedSourceLanguage, .unsupportedTargetLanguage:
        return TranslateException("unsupported", "系统翻译不支持这两种语言。")
      case .unableToIdentifyLanguage:
        return TranslateException("other", "认不出这段是什么语言。")
      default: break
      }
    }
    if error is CancellationError || (error as NSError).code == NSUserCancelledError {
      return TranslateException("not_installed", "还没有下载英语和中文：在\"设置 → 翻译\"里下载。")
    }
    return TranslateException("other", error.localizedDescription)
  }

  /// 把看不见的视图挂到最上层的页面上（下载面板要从它弹出来：挂在被盖住的页面上弹不出来）
  private func attach() -> Bool {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    guard let window = scenes.flatMap({ $0.windows }).first(where: { $0.isKeyWindow }) ?? scenes.first?.windows.first,
          var root = window.rootViewController else { return false }
    while let p = root.presentedViewController, !p.isBeingDismissed { root = p }
    if let h = hosting, h.view.window != nil, h.parent === root { return true }
    detach()
    let h = UIHostingController(rootView: HostView(host: self))
    h.view.frame = CGRect(x: 0, y: 0, width: 2, height: 2)
    // 透明度太低（≤0.01）系统当成看不见
    h.view.alpha = 0.02
    h.view.isUserInteractionEnabled = false
    h.view.backgroundColor = .clear
    root.addChild(h)
    root.view.addSubview(h.view)
    h.didMove(toParent: root)
    hosting = h
    return true
  }

  private func detach() {
    guard let h = hosting else { return }
    h.willMove(toParent: nil)
    h.view.removeFromSuperview()
    h.removeFromParent()
    hosting = nil
  }
}

@available(iOS 18.0, *)
struct HostView: View {
  @ObservedObject var host: TranslateHost
  var body: some View {
    Color.clear
      .frame(width: 1, height: 1)
      .translationTask(host.config) { session in
        await host.perform(session)
      }
  }
}
#endif
