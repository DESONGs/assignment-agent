import Foundation

public enum WorkbenchRedactor {
  private static let sensitiveKeyParts = [
    "token", "secret", "cookie", "authorization", "api_key", "apikey",
    "session", "password", "credential", "appsecret", "app_secret"
  ]

  private static let rawContentKeys = [
    "markdown", "transcript", "rawtranscript", "content", "delta",
    "text", "extractedtext", "rawtext", "body", "stdout", "stderr"
  ]

  public static func redactText(_ text: String, limit: Int = 600) -> String {
    var value = text
    let replacements: [(String, String)] = [
      (#"(?i)Bearer\s+[A-Za-z0-9._\-]+"#, "Bearer [redacted]"),
      (#"(?i)(authorization|cookie|session|api[_-]?key|app[_-]?secret|secret|token)\s*[:=]\s*["']?[^"',\s}]+"#, "$1=[redacted]"),
      (#"\b[A-Za-z0-9]{20,}\b"#, "[redacted-id]")
    ]
    for (pattern, replacement) in replacements {
      value = value.replacingOccurrences(
        of: pattern,
        with: replacement,
        options: [.regularExpression]
      )
    }
    value = value.replacingOccurrences(of: "\n", with: " ")
    value = value.replacingOccurrences(of: "\r", with: " ")
    return bounded(value, limit: limit)
  }

  public static func bounded(_ text: String, limit: Int = 600) -> String {
    guard text.count > limit else { return text }
    let end = text.index(text.startIndex, offsetBy: limit)
    return String(text[..<end]) + "…"
  }

  public static func sanitizedPreview(_ value: Any?, limit: Int = 900) -> String {
    guard let value else { return "" }
    let sanitized = sanitize(value, key: nil, depth: 0)
    if JSONSerialization.isValidJSONObject(sanitized),
       let data = try? JSONSerialization.data(withJSONObject: sanitized, options: [.prettyPrinted, .sortedKeys]),
       let string = String(data: data, encoding: .utf8) {
      return bounded(string, limit: limit)
    }
    return redactText(String(describing: sanitized), limit: limit)
  }

  public static func sanitize(_ value: Any, key: String?, depth: Int) -> Any {
    let normalizedKey = key?.lowercased().replacingOccurrences(of: "_", with: "") ?? ""
    if sensitiveKeyParts.contains(where: { normalizedKey.contains($0.replacingOccurrences(of: "_", with: "")) }) {
      return "[redacted]"
    }
    if depth > 8 {
      return "[bounded-depth]"
    }
    if rawContentKeys.contains(where: { normalizedKey == $0 || normalizedKey.contains($0) }) {
      if let string = value as? String {
        return "[bounded-preview] \(redactText(string, limit: 240))"
      }
    }
    if let dict = value as? [String: Any] {
      var output: [String: Any] = [:]
      for (itemKey, itemValue) in dict {
        output[itemKey] = sanitize(itemValue, key: itemKey, depth: depth + 1)
      }
      return output
    }
    if let array = value as? [Any] {
      let boundedArray = array.prefix(24).map { sanitize($0, key: key, depth: depth + 1) }
      if array.count > 24 {
        return boundedArray + ["[truncated \(array.count - 24) item(s)]"]
      }
      return boundedArray
    }
    if let string = value as? String {
      return redactText(string, limit: 600)
    }
    return value
  }

  public static func containsSensitiveLeak(_ text: String) -> Bool {
    let patterns = [
      #"(?i)authorization\s*[:=]"#,
      #"(?i)cookie\s*[:=]"#,
      #"(?i)api[_-]?key\s*[:=]"#,
      #"(?i)app[_-]?secret\s*[:=]"#,
      #"(?i)Bearer\s+[A-Za-z0-9._\-]{8,}"#
    ]
    return patterns.contains { pattern in
      text.range(of: pattern, options: .regularExpression) != nil
    }
  }
}
