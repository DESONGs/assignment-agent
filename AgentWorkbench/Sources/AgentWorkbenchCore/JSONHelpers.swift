import Foundation

enum JSONHelpers {
  static func loadJSON(_ url: URL) -> Any? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONSerialization.jsonObject(with: data, options: [])
  }

  static func object(_ value: Any?) -> [String: Any] {
    value as? [String: Any] ?? [:]
  }

  static func array(_ value: Any?) -> [Any] {
    value as? [Any] ?? []
  }

  static func string(_ object: [String: Any], _ keys: String...) -> String? {
    for key in keys {
      if let value = object[key] as? String, !value.isEmpty { return value }
      if let value = object[key] { return String(describing: value) }
    }
    return nil
  }

  static func int(_ object: [String: Any], _ keys: String...) -> Int? {
    for key in keys {
      if let value = object[key] as? Int { return value }
      if let value = object[key] as? Double { return Int(value) }
      if let value = object[key] as? String, let intValue = Int(value) { return intValue }
    }
    return nil
  }

  static func stringArray(_ object: [String: Any], _ key: String) -> [String] {
    if let values = object[key] as? [String] { return values }
    if let values = object[key] as? [Any] { return values.map { String(describing: $0) } }
    return []
  }

  static func recursiveText(_ value: Any?, maxDepth: Int = 8) -> String {
    func walk(_ item: Any?, depth: Int, into output: inout [String]) {
      guard depth <= maxDepth, let item else { return }
      if let string = item as? String {
        output.append(string)
      } else if let dict = item as? [String: Any] {
        for value in dict.values { walk(value, depth: depth + 1, into: &output) }
      } else if let array = item as? [Any] {
        for value in array { walk(value, depth: depth + 1, into: &output) }
      }
    }
    var parts: [String] = []
    walk(value, depth: 0, into: &parts)
    return parts.joined(separator: " ")
  }

  static func relativePath(_ url: URL, root: URL) -> String {
    let rootPath = root.standardizedFileURL.path
    let path = url.standardizedFileURL.path
    if path.hasPrefix(rootPath) {
      let start = path.index(path.startIndex, offsetBy: rootPath.count)
      return String(path[start...]).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
    return url.lastPathComponent
  }

  static func modificationTime(_ url: URL) -> String? {
    guard let date = try? FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date else {
      return nil
    }
    return ISO8601DateFormatter().string(from: date)
  }

  static func fileSize(_ url: URL) -> Int64 {
    (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int64) ?? 0
  }
}
