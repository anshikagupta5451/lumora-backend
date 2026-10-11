// Finds which product a photo of its front shows, from the text the phone
// read off the pack (on-device ML Kit text recognition — the photo never
// reaches us). Pure string matching, no AI: every candidate's brand and
// name are compared word by word with what was read, allowing for the
// small misreads text recognition makes ("caffeine" for "mCaffeine",
// "lotlon" for "lotion").
//
// Bigger text counts for more: the brand and product name are nearly
// always the largest print on the front, while claims and net quantity
// are small.

export interface ReadLine {
  text: string;
  // Line height in pixels, relative to the other lines of the same photo.
  size: number;
}

export interface MatchCandidate {
  brand: string;
  name: string;
}

// Pack filler that says nothing about which product this is.
const STOPWORDS = new Set([
  "a", "an", "and", "the", "of", "for", "with", "to", "in", "on", "your", "by",
  "new", "net", "qty", "quantity", "ml", "gm", "g", "kg", "oz", "fl", "mrp", "rs", "inr",
  "incl", "taxes", "made", "india", "tested", "dermatologically", "clinically", "free",
  "paraben", "parabens", "sulphate", "sulfate", "use", "only", "external", "all", "types",
  "www", "com", "batch", "mfg", "exp", "best", "before",
]);

function normalize(s: string) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(s: string) {
  return normalize(s)
    .split(" ")
    .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

function levenshtein(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

// How confidently one product word was seen on the pack: 1 for an exact
// read, less for a near miss. Short words must match exactly.
function closeness(word: string, seen: string) {
  if (word === seen) return 1;
  if (word.length >= 4 && seen.length >= 4 && levenshtein(word, seen) <= (word.length >= 8 ? 2 : 1)) {
    return 0.8;
  }
  return 0;
}

export class ReadText {
  // Every word read, with the relative size (0.3–1) of the biggest line it appeared on.
  readonly words = new Map<string, number>();
  // All words run together, so a brand split across lines ("m" / "caffeine")
  // or spaced oddly is still found.
  readonly joined: string;

  constructor(lines: ReadLine[]) {
    const biggest = Math.max(1, ...lines.map((l) => l.size || 1));
    for (const line of lines) {
      const weight = 0.3 + 0.7 * ((line.size || 1) / biggest);
      for (const t of tokens(line.text)) {
        this.words.set(t, Math.max(this.words.get(t) ?? 0, weight));
      }
    }
    this.joined = lines.map((l) => normalize(l.text).replace(/ /g, "")).join("");
  }

  get isEmpty() {
    return this.words.size === 0;
  }

  // Search phrases to send to Open Beauty Facts, whose search needs every
  // word to match: so try the biggest words alone and in small groups.
  searchQueries(knownBrand: string | null): string[] {
    const bySize = [...this.words.entries()]
      .filter(([w]) => w.length >= 3)
      .sort((a, b) => b[1] - a[1])
      .map(([w]) => w);
    const queries = [
      knownBrand,
      bySize[0],
      bySize.slice(0, 2).join(" "),
      bySize.slice(0, 3).join(" "),
    ].filter((q): q is string => Boolean(q && q.trim()));
    return [...new Set(queries)].slice(0, 3);
  }

  private seen(word: string) {
    let best = 0;
    for (const [w, weight] of this.words) {
      const c = closeness(word, w);
      if (c) best = Math.max(best, c * (0.6 + 0.4 * weight));
    }
    return best;
  }

  brandScore(brand: string) {
    const b = normalize(brand).replace(/ /g, "");
    if (b.length < 2) return 0;
    if (this.joined.includes(b)) return 1;
    // A read word that is most of the brand: "caffeine" for "mcaffeine".
    for (const w of this.words.keys()) {
      if (w.length >= 4 && b.includes(w) && w.length / b.length >= 0.7) return 0.8;
      if (closeness(b, w) > 0) return 0.8;
    }
    return 0;
  }

  // Size-weighted share of what was read that this product accounts for,
  // so "lakme sun expert" prefers Sun Expert over a product named "Lakme".
  private coverage(c: MatchCandidate) {
    const own = tokens(`${c.brand} ${c.name}`);
    const ownJoined = normalize(`${c.brand} ${c.name}`).replace(/ /g, "");
    let found = 0;
    let total = 0;
    for (const [w, weight] of this.words) {
      total += weight;
      if ((w.length >= 3 && ownJoined.includes(w)) || own.some((o) => closeness(o, w) > 0)) {
        found += weight;
      }
    }
    return total ? found / total : 0;
  }

  // 0–100: how well this product's brand and name match what was read.
  score(c: MatchCandidate) {
    const brandWords = new Set(tokens(c.brand));
    const nameWords = [...new Set(tokens(c.name))].filter((w) => !brandWords.has(w));
    const brand = this.brandScore(c.brand);
    // A "name" that's only the brand (common in OBF) identifies nothing.
    const recall = nameWords.length
      ? nameWords.reduce((sum, w) => sum + this.seen(w), 0) / nameWords.length
      : 0;
    const score = 0.3 * brand + 0.45 * recall + 0.25 * this.coverage(c);
    // A brand that's on the product but nowhere in what was read is strong
    // evidence against it ("body lotion" alone shouldn't pick CeraVe).
    const wrongBrand = brand === 0 && normalize(c.brand).length > 1;
    return Math.round(100 * score * (wrongBrand ? 0.7 : 1));
  }
}

// Anything below this is noise rather than a plausible match.
export const MIN_MATCH_SCORE = 35;
