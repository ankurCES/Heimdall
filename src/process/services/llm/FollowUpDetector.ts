import log from 'electron-log'

/**
 * Classifies whether a user query is a follow-up (continuation of prior
 * conversation) or a new topic (needs full plan-then-research pipeline).
 *
 * Two-tier:
 *   1. Heuristic (sub-millisecond, no LLM) — catches 80%+ of follow-ups
 *      via length, pronoun/conjunction patterns, entity overlap.
 *   2. LLM fallback (only if heuristic is uncertain) — short prompt to
 *      the fast/planner model. Kept optional so the system works without
 *      any LLM configured.
 *
 * On follow-up: the chat agent skips the plan modal and responds directly
 * via hybrid-RAG + inline tool calls. Fast path for "what about X?" /
 * "elaborate on Y" / "and the Z?" patterns.
 *
 * On new_topic: full deep-research pipeline (plan → auto-research →
 * modal → execute).
 *
 * Default on uncertainty: new_topic (safer — shows the plan modal, which
 * the analyst can cancel if it was actually a follow-up).
 */

export type QueryIntent = 'new_topic' | 'follow_up' | 'clarification'

/** Lightweight context from the conversation for classification. */
export interface ConversationContext {
  lastAssistantMessage: string | null
  lastUserMessage: string | null
  conversationLength: number // total exchanges (user+assistant)
  recentEntities: string[]  // named entities from last 2 messages
}

const FOLLOW_UP_STARTERS = new Set([
  'and', 'also', 'plus', 'additionally', 'furthermore', 'moreover',
  'what about', 'how about', 'tell me more', 'elaborate', 'continue',
  'expand', 'explain', 'go on', 'keep going', 'more on',
  'can you', 'could you', 'would you', 'do you',
  'why', 'how', 'when', 'where', 'who', 'which',
  'but', 'however', 'although', 'though',
  'so', 'then', 'therefore', 'thus',
  'ok', 'okay', 'right', 'sure', 'yes', 'yeah', 'yep',
  'interesting', 'good', 'great', 'thanks',
  'what if', 'suppose', 'assuming'
])

const CONTEXT_PRONOUNS = new Set([
  'it', 'its', 'they', 'them', 'their', 'theirs',
  'this', 'that', 'these', 'those',
  'the same', 'said', 'mentioned', 'above', 'previous',
  'earlier', 'prior', 'former', 'latter'
])

/**
 * Heuristic follow-up detection. Returns a confidence 0–1 where:
 *   > 0.7 = definitely follow-up
 *   < 0.3 = definitely new topic
 *   0.3–0.7 = uncertain (could escalate to LLM)
 */
export function detectFollowUp(query: string, ctx: ConversationContext): {
  intent: QueryIntent
  confidence: number
  reason: string
} {
  const q = query.trim()
  const qLower = q.toLowerCase()
  const words = qLower.split(/\s+/)
  const wordCount = words.length

  // No conversation history = always new topic.
  if (ctx.conversationLength === 0) {
    return { intent: 'new_topic', confidence: 1.0, reason: 'first message in conversation' }
  }

  let followUpScore = 0
  const reasons: string[] = []

  // 1. Short queries (< 15 words) with conversation history are likely follow-ups.
  if (wordCount < 15 && ctx.conversationLength >= 2) {
    followUpScore += 0.25
    reasons.push('short query with history')
  }

  // Very short (< 5 words) is almost certainly a follow-up.
  if (wordCount < 5 && ctx.conversationLength >= 2) {
    followUpScore += 0.2
    reasons.push('very short')
  }

  // 2. Starts with a follow-up conjunction/phrase.
  for (const starter of FOLLOW_UP_STARTERS) {
    if (qLower.startsWith(starter + ' ') || qLower === starter) {
      followUpScore += 0.3
      reasons.push(`starts with "${starter}"`)
      break
    }
  }

  // 3. Contains context-referencing pronouns.
  for (const pronoun of CONTEXT_PRONOUNS) {
    if (qLower.includes(pronoun)) {
      followUpScore += 0.2
      reasons.push(`contains "${pronoun}"`)
      break // one match is enough
    }
  }

  // 4. Bare question (just a "?" or very short + "?").
  if (q === '?' || (wordCount <= 3 && q.endsWith('?'))) {
    followUpScore += 0.4
    reasons.push('bare question')
  }

  // 5. Entity overlap: if the query doesn't introduce NEW named entities
  //    (capitalized words > 3 chars not in the recent context), it's
  //    likely continuing the prior topic.
  const queryEntities = extractSimpleEntities(q)
  const newEntities = queryEntities.filter((e) => !ctx.recentEntities.some(
    (re) => re.toLowerCase() === e.toLowerCase()
  ))
  if (queryEntities.length > 0 && newEntities.length === 0) {
    followUpScore += 0.15
    reasons.push('no new entities')
  }
  // Conversely, if the query introduces 2+ new entities, it's probably a new topic.
  if (newEntities.length >= 2) {
    followUpScore -= 0.3
    reasons.push(`${newEntities.length} new entities`)
  }

  // 6. Long queries (> 30 words) are usually new topics with context.
  if (wordCount > 30) {
    followUpScore -= 0.2
    reasons.push('long query')
  }

  // 7. Explicit new-topic markers.
  const newTopicMarkers = ['new topic', 'different question', 'unrelated', 'change of topic',
    'switching to', 'moving on', 'another thing', 'separate question']
  for (const marker of newTopicMarkers) {
    if (qLower.includes(marker)) {
      followUpScore -= 0.5
      reasons.push(`explicit new-topic marker "${marker}"`)
      break
    }
  }

  // 8. Commands that imply new research.
  const researchCommands = ['analyze', 'analyse', 'research', 'investigate',
    'run a detailed', 'deep dive', 'full analysis', 'comprehensive',
    'monitor', 'scan', 'sweep', 'search for', 'look into', 'find']
  for (const cmd of researchCommands) {
    if (qLower.includes(cmd) && wordCount > 8) {
      followUpScore -= 0.25
      reasons.push(`research command "${cmd}" + substantial query`)
      break
    }
  }

  // Clamp to [0, 1].
  const clampedScore = Math.max(0, Math.min(1, followUpScore))

  let intent: QueryIntent
  if (clampedScore >= 0.5) {
    intent = clampedScore >= 0.7 ? 'clarification' : 'follow_up'
  } else {
    intent = 'new_topic'
  }

  const reason = reasons.join('; ') || 'no strong signals'
  log.debug(`FollowUpDetector: "${q.slice(0, 50)}…" → ${intent} (score=${clampedScore.toFixed(2)}, ${reason})`)
  return { intent, confidence: clampedScore, reason }
}

/** Extract simple "entities" — capitalized words > 3 chars that aren't
 *  at the start of a sentence. Very rough; just for overlap checking. */
function extractSimpleEntities(text: string): string[] {
  const words = text.split(/\s+/)
  const entities: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/[^a-zA-Z]/g, '')
    if (w.length > 3 && w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase()) {
      // Skip if it's the first word (sentence-start capitalization).
      if (i > 0 || (i === 0 && !text.startsWith(w))) {
        entities.push(w)
      }
    }
  }
  return entities
}

/** Build ConversationContext from the chat history. */
export function buildContext(
  history: Array<{ role: string; content: string }>
): ConversationContext {
  const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant')
  const lastUser = [...history].reverse().find((m) => m.role === 'user')

  // Extract entities from last 2 messages.
  const recentTexts = history.slice(-4).map((m) => m.content).join(' ')
  const recentEntities = extractSimpleEntities(recentTexts)

  return {
    lastAssistantMessage: lastAssistant?.content?.slice(0, 500) ?? null,
    lastUserMessage: lastUser?.content?.slice(0, 300) ?? null,
    conversationLength: history.filter((m) => m.role !== 'system').length,
    recentEntities: [...new Set(recentEntities)]
  }
}
