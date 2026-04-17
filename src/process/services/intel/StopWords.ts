/**
 * Domain-tuned stop-word list for intel search query preprocessing.
 *
 * Covers three categories:
 *   - Generic English stop-words (articles, pronouns, common verbs).
 *   - Interrogatives the analyst types conversationally ("what's", "where",
 *     "why") that carry zero signal for FTS.
 *   - Filler adjectives / adverbs common in natural-language queries
 *     ("latest", "recent", "current" — but NOT domain-meaningful words
 *     like "escalating" or "imminent").
 *
 * We DO NOT include substantive domain vocabulary even if it's frequent
 * (e.g. "attack", "threat", "intelligence") — those are signal.
 *
 * All entries must be lower-case. Matched after normalisation.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  // articles
  'a', 'an', 'the',
  // conjunctions
  'and', 'or', 'but', 'nor', 'so', 'yet', 'for', 'if', 'as', 'than',
  // pronouns
  'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'you', 'your', 'yours',
  'he', 'him', 'his', 'she', 'her', 'it', 'its', 'they', 'them', 'their',
  'this', 'that', 'these', 'those',
  // be-verbs + common aux
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'done', 'doing',
  'have', 'has', 'had', 'having',
  'will', 'would', 'could', 'should', 'may', 'might', 'must', 'can', 'shall',
  // prepositions
  'of', 'in', 'on', 'at', 'to', 'from', 'with', 'without', 'by', 'about',
  'into', 'onto', 'over', 'under', 'through', 'during', 'before', 'after',
  'above', 'below', 'between', 'among', 'against', 'toward', 'towards',
  // interrogatives / conversational
  'what', 'whats', 'whos', 'wheres', 'whens', 'whys', 'hows', 'whose',
  'who', 'whom', 'where', 'when', 'why', 'how', 'which',
  'tell', 'show', 'give', 'find', 'search', 'lookup', 'look', 'help',
  'please', 'lets', 'let', 'hey', 'hi', 'hello',
  // vague temporal markers — NOT "today's date" specific years; those carry signal
  'latest', 'recent', 'recently', 'current', 'currently', 'today', 'now',
  'lately', 'new', 'newer', 'newest', 'old', 'older',
  // intensifiers / fillers
  'very', 'really', 'quite', 'rather', 'also', 'too', 'just', 'only',
  'some', 'any', 'all', 'each', 'every', 'few', 'many', 'much', 'more',
  'most', 'several', 'other', 'another', 'same', 'such', 'both', 'either',
  'neither', 'own', 'own',
  // contractions leftover chunks
  'dont', 'doesnt', 'didnt', 'wont', 'wouldnt', 'couldnt', 'shouldnt',
  'cant', 'cannot', 'isnt', 'arent', 'wasnt', 'werent',
  // generic verbs that are too common in monitoring language
  'going', 'get', 'gets', 'got', 'getting',
  'make', 'made', 'making', 'take', 'took', 'taking',
  'come', 'came', 'coming', 'go', 'went', 'gone',
  'say', 'said', 'saying', 'like',
  // copula / existence
  'there', 'here',
  // misc
  'yes', 'no', 'not', 'nope',
  // numbers as words (not digits — digits carry signal)
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'first', 'second', 'third', 'last', 'next'
])

/** Strip stop-words from a token list. Case-insensitive; returns lower-case tokens. */
export function removeStopWords(tokens: string[]): string[] {
  return tokens.map((t) => t.toLowerCase()).filter((t) => !STOP_WORDS.has(t))
}
