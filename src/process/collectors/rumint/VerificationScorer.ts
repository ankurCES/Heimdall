// Credibility scoring for unverified intelligence (RUMINT)
// Score range: 0-100, where 100 = highest credibility

interface ScoreInput {
  sourceTier: 'official' | 'established' | 'community' | 'anonymous' | 'unverified'
  hasCorroboration: boolean
  specificity: 'high' | 'medium' | 'low'
  age: number // hours since publication
  authorHistory?: 'known-reliable' | 'new' | 'known-unreliable'
}

const SOURCE_TIER_SCORES: Record<string, number> = {
  official: 40,
  established: 30,
  community: 20,
  anonymous: 10,
  unverified: 5
}

export class VerificationScorer {
  score(input: ScoreInput): number {
    let score = 0

    // Source reliability (0-40 points)
    score += SOURCE_TIER_SCORES[input.sourceTier] ?? 5

    // Corroboration (0-25 points)
    if (input.hasCorroboration) {
      score += 25
    }

    // Specificity of information (0-20 points)
    switch (input.specificity) {
      case 'high': score += 20; break
      case 'medium': score += 12; break
      case 'low': score += 5; break
    }

    // Freshness — newer info scores higher (0-10 points)
    if (input.age < 1) score += 10
    else if (input.age < 6) score += 7
    else if (input.age < 24) score += 4
    else if (input.age < 72) score += 2
    else score += 0

    // Author history bonus/penalty (0-5 points)
    if (input.authorHistory === 'known-reliable') score += 5
    else if (input.authorHistory === 'known-unreliable') score -= 10

    return Math.max(0, Math.min(100, score))
  }
}
