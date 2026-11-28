/**
 * Finds the most repeated themes among free-text "other" return reasons.
 *
 * Runs fully on the server (no paid service, nothing leaves the machine): Persian text is
 * normalised, stop-words removed, light suffix stripping applied, and one- and two-word phrases are
 * counted by how many distinct reasons mention them. Identical reasons are grouped as well.
 */

export const OTHER_REASON = 'سایر';

export interface ReasonTheme {
  phrase: string;
  count: number;
  examples: string[];
}

export interface OtherReasonsInsight {
  count: number;
  themes: ReasonTheme[];
  recent: Array<{ text: string; at: string; by: string; customer: string }>;
}

const STOP = new Set(
  `و در به از که این آن را با برای تا یا هم نیز اما ولی اگر چون چه هر همه یک دو سه ها های ای است هست بود شد شده شود می نمی کرد کرده کند کنید کنند داشت دارد دارند باشد باشند خواهد بر روی پس قبل بعد بین درباره مورد موارد لطفا لطفاً باید نباید فقط خیلی بیشتر کمتر هنوز دیگر دیگری اون این‌ها آن‌ها ما شما او ایشان من تو نه بله چیزی چیز طور طوری جهت وجود ندارد نیست نشده نشد مشتری سفارش`.split(
    /\s+/,
  ),
);

export function normalizeReason(s: string): string {
  return s
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[ۀة]/g, 'ه')
    .replace(/[أإآ]/g, 'ا')
    .replace(/[ً-ٰٟ]/g, '') // diacritics
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/‌/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Very light Persian stemming so "قیمت‌ها" / "قیمتهای" / "قیمت" count together. */
function stem(w: string): string {
  for (const suf of ['هایی', 'های', 'ها']) {
    if (w.length - suf.length >= 3 && w.endsWith(suf)) return w.slice(0, -suf.length);
  }
  return w;
}

/** Comparable keys plus the readable surface form of each kept word. */
function tokens(text: string): Array<{ key: string; surface: string }> {
  const readable = text
    .replace(/\u200c/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out: Array<{ key: string; surface: string }> = [];
  for (const w of readable) {
    const norm = normalizeReason(w);
    if (norm.length <= 1 || STOP.has(norm) || /^\d+$/.test(norm)) continue;
    out.push({ key: stem(norm), surface: w.replace(/ي/g, 'ی').replace(/ك/g, 'ک') });
  }
  return out;
}

export function findReasonThemes(texts: string[], max = 8): ReasonTheme[] {
  const docs = texts.map((t) => t.trim()).filter(Boolean);
  // phrase -> set of doc indexes, and the surface form seen first
  const hits = new Map<string, Set<number>>();
  const surface = new Map<string, string>();
  const add = (key: string, shown: string, i: number) => {
    const set = hits.get(key) || new Set<number>();
    set.add(i);
    hits.set(key, set);
    if (!surface.has(key)) surface.set(key, shown);
  };
  const exact = new Map<string, Set<number>>();
  docs.forEach((d, i) => {
    const norm = normalizeReason(d);
    if (norm) {
      const set = exact.get(norm) || new Set<number>();
      set.add(i);
      exact.set(norm, set);
    }
    const tk = tokens(d);
    const seen = new Set<string>();
    tk.forEach((w, j) => {
      if (!seen.has(w.key)) add(w.key, w.surface, i);
      seen.add(w.key);
      if (j + 1 < tk.length) {
        const bi = `${w.key} ${tk[j + 1].key}`;
        if (!seen.has(bi)) add(bi, `${w.surface} ${tk[j + 1].surface}`, i);
        seen.add(bi);
      }
    });
  });

  const candidates: Array<{ phrase: string; docs: Set<number>; words: number }> = [];
  for (const [phrase, set] of exact) {
    if (set.size >= 2) candidates.push({ phrase, docs: set, words: 99 });
  }
  for (const [phrase, set] of hits) {
    if (set.size >= 2) candidates.push({ phrase, docs: set, words: phrase.split(' ').length });
  }
  // More reasons first; on a tie prefer the longer (more specific) phrase.
  candidates.sort((a, b) => b.docs.size - a.docs.size || b.words - a.words);

  const picked: typeof candidates = [];
  for (const c of candidates) {
    // Skip a phrase whose reasons are already covered by a picked phrase that contains it (or vice versa).
    // Skip a phrase that covers exactly the same reasons as a related, already picked phrase.
    const redundant = picked.some((p) => {
      const sameDocs = p.docs.size === c.docs.size && [...c.docs].every((i) => p.docs.has(i));
      const related = p.phrase.includes(c.phrase) || c.phrase.includes(p.phrase);
      return sameDocs && related;
    });
    if (!redundant) picked.push(c);
    if (picked.length >= max) break;
  }

  return picked.map((c) => ({
    phrase: c.words === 99 ? docs[[...c.docs][0]] : surface.get(c.phrase) || c.phrase,
    count: c.docs.size,
    examples: [...c.docs].slice(0, 3).map((i) => docs[i]),
  }));
}
