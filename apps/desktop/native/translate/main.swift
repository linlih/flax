// Flax 的翻译小助手：用 macOS 自带的翻译（Translation 框架），在这台 Mac 上翻，不联网、不用注册。
// 主进程启动它一次，之后一直开着。一行一个 JSON：
//   收 {"id":"1","op":"translate","text":"...","toEnglish":false}  回 {"id":"1","text":"..."} 或 {"id":"1","error":"...","code":"notInstalled"}
//   收 {"id":"2","op":"status"}                                      回 {"id":"2","status":"installed"|"supported"|"unsupported"}
import Foundation
import Translation

let en = Locale.Language(identifier: "en")
let zh = Locale.Language(identifier: "zh-Hans")

/// 输出一行 JSON；几个任务同时写也不会串行
actor Out {
  func send(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj), var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    FileHandle.standardOutput.write(line.data(using: .utf8)!)
  }
}

/// 两个方向各一个会话，建一次反复用
actor Sessions {
  private var cache: [Bool: TranslationSession] = [:]
  func get(toEnglish: Bool) -> TranslationSession {
    if let s = cache[toEnglish] { return s }
    let s = toEnglish ? TranslationSession(installedSource: zh, target: en) : TranslationSession(installedSource: en, target: zh)
    cache[toEnglish] = s
    return s
  }
  func drop(toEnglish: Bool) { cache[toEnglish] = nil }
}

func statusName(_ s: LanguageAvailability.Status) -> String {
  switch s {
  case .installed: return "installed"
  case .supported: return "supported"
  case .unsupported: return "unsupported"
  @unknown default: return "unsupported"
  }
}

@main struct Main {
  static func main() async {
    let out = Out()
    let sessions = Sessions()
    await out.send(["ready": true])
    do {
      for try await line in FileHandle.standardInput.bytes.lines {
        guard let data = line.data(using: .utf8),
              let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = msg["id"] as? String else { continue }
        let op = msg["op"] as? String ?? ""
        Task {
          if op == "status" {
            // 两个方向都装好才算能用
            let a = LanguageAvailability()
            let s1 = await a.status(from: en, to: zh)
            let s2 = await a.status(from: zh, to: en)
            let both = [s1, s2]
            let status = both.allSatisfy({ $0 == .installed }) ? "installed" : both.contains(.unsupported) ? "unsupported" : "supported"
            await out.send(["id": id, "status": status])
            return
          }
          guard op == "translate", let text = msg["text"] as? String else {
            await out.send(["id": id, "error": "bad request", "code": "other"])
            return
          }
          let toEnglish = msg["toEnglish"] as? Bool ?? false
          do {
            let r = try await sessions.get(toEnglish: toEnglish).translate(text)
            await out.send(["id": id, "text": r.targetText])
          } catch {
            await sessions.drop(toEnglish: toEnglish)
            let desc = String(describing: error)
            let code = desc.contains("notInstalled") ? "notInstalled" : desc.contains("unsupported") ? "unsupported" : "other"
            await out.send(["id": id, "error": desc, "code": code])
          }
        }
      }
    } catch {}
  }
}
