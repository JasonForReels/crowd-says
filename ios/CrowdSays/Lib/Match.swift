import Foundation

/*
  Forgiving answer matching: "spiderman", "Spider-Man" and "spidermen" all hit.
  A direct port of src/lib/match.js so the app and the web game judge a guess
  the same way.
*/

private let stopWords: Set<String> = ["the", "a", "an", "my", "your", "some", "their"]

private func norm(_ s: String) -> String {
    // Decompose, then drop combining marks, so "café" reads as "cafe".
    let stripped = s.lowercased()
        .decomposedStringWithCanonicalMapping
        .unicodeScalars
        .filter { !(0x0300...0x036F).contains($0.value) }
        .reduce(into: "") { $0.unicodeScalars.append($1) }

    let expanded = stripped.replacingOccurrences(of: "&", with: " and ")

    // Keep only letters, digits and spaces; anything else is dropped rather
    // than spaced out, so "spider-man" keys the same as "spiderman".
    let kept = String(expanded.filter { c in
        (c.isASCII && (c.isLetter || c.isNumber)) || c == " "
    })

    // Drop leading noise words, then collapse the gaps they leave behind.
    return kept.split(separator: " ", omittingEmptySubsequences: true)
        .filter { !stopWords.contains(String($0)) }
        .joined(separator: " ")
}

private func stem(_ w: String) -> String {
    guard w.count > 3 else { return w }
    var s = w
    if s.hasSuffix("ies") { s = String(s.dropLast(3)) + "y" }
    if s.hasSuffix("es") { s = String(s.dropLast(2)) }
    else if s.hasSuffix("s") { s = String(s.dropLast()) }
    return s
}

/// Normalised, stemmed form — the shape guesses and answers are compared in.
func matchKey(_ s: String) -> String {
    norm(s).split(separator: " ").map { stem(String($0)) }.joined(separator: " ")
}

private func levenshtein(_ a: [Character], _ b: [Character]) -> Int {
    if a.isEmpty { return b.count }
    if b.isEmpty { return a.count }
    var row = Array(0...b.count)
    for i in 1...a.count {
        var prev = row[0]
        row[0] = i
        for j in 1...b.count {
            let cur = row[j]
            row[j] = min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] == b[j - 1] ? 0 : 1))
            prev = cur
        }
    }
    return row[b.count]
}

/// Lower is better; nil means no match at all.
private func score(_ g: String, _ c: String) -> Double? {
    if g == c { return 0 }
    let gc = g.replacingOccurrences(of: " ", with: "")
    let cc = c.replacingOccurrences(of: " ", with: "")
    if gc == cc { return 0.5 } // "spider man" vs "spiderman"

    let gw = g.split(separator: " ").map(String.init)
    let cw = c.split(separator: " ").map(String.init)
    // Whole-word containment either way ("pizza hut" ↔ "pizza").
    if (cw.count > 1 && g.count >= 3 && cw.contains(g)) || (gw.count > 1 && c.count >= 3 && gw.contains(c)) {
        return 1
    }

    let tol = cc.count <= 4 ? 0 : (cc.count <= 7 ? 1 : 2)
    let d = levenshtein(Array(gc), Array(cc))
    return d <= tol ? Double(1 + d) : nil
}

/// Index of the answer the guess matches, or nil.
func findAnswer(_ guess: String, in answers: [Answer]) -> Int? {
    let g = matchKey(guess)
    guard !g.isEmpty else { return nil }
    var best: Int?
    var bestScore = Double.infinity
    for (i, ans) in answers.enumerated() {
        for cand in [ans.text] + ans.aliases {
            if let s = score(g, matchKey(cand)), s < bestScore {
                bestScore = s
                best = i
            }
        }
    }
    return best
}
