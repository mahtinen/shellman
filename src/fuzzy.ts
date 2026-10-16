/**
 * Small fuzzy matcher: every query character must appear in order. Matches at
 * word starts and consecutive runs score higher. Returns null for no match.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct + (direct === 0 || /[\s\\/._-]/.test(t[direct - 1]) ? 200 : 0);

  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    const wordStart = found === 0 || /[\s\\/._-]/.test(t[found - 1]);
    score += 10 + (found === prev + 1 ? 15 : 0) + (wordStart ? 20 : 0) - Math.min(9, found - ti);
    prev = found;
    ti = found + 1;
  }
  return score;
}

/** Scores an item by its best-matching field (the first field is weighted up). */
export function fuzzyBest(query: string, fields: string[]): number | null {
  let best: number | null = null;
  fields.forEach((f, i) => {
    const s = fuzzyScore(query, f);
    if (s === null) return;
    const weighted = i === 0 ? s * 1.5 : s;
    if (best === null || weighted > best) best = weighted;
  });
  return best;
}
