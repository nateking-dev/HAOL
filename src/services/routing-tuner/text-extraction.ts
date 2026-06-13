// ---------------------------------------------------------------------------
// Text extraction: derive candidate "contains" keywords from prompts
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "need",
  "dare",
  "ought",
  "used",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "because",
  "but",
  "and",
  "or",
  "if",
  "while",
  "about",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "she",
  "they",
  "them",
  "what",
  "which",
  "who",
  "whom",
  "please",
  "help",
  "want",
  "like",
  "make",
  "get",
  "give",
  "tell",
]);

/**
 * Extracts the most distinctive keyword from a prompt for use as a
 * "contains" routing rule. Strips stop words and picks the longest
 * remaining word that appears in at least `minFrequency` prompts.
 */
export function extractKeyPhrases(prompts: string[], minFrequency: number): Map<string, number> {
  const wordCounts = new Map<string, number>();

  for (const prompt of prompts) {
    // Deduplicate words per prompt to count document frequency
    const words = new Set(
      prompt
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !STOP_WORDS.has(w)),
    );
    for (const word of words) {
      wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
    }
  }

  // Filter to words appearing in >= minFrequency prompts
  const result = new Map<string, number>();
  for (const [word, count] of wordCounts) {
    if (count >= minFrequency) {
      result.set(word, count);
    }
  }
  return result;
}
