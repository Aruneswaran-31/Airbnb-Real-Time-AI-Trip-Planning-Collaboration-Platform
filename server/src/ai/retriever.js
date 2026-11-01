'use strict';

/**
 * Lightweight, dependency-free retrieval layer for the AI Concierge (the "R" in RAG).
 *
 * Documents are the authored venue metadata records. We build a small BM25 index
 * over weighted fields so answers can cite the exact venue records that grounded
 * them, with no external vector database required for a single-destination build.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'for', 'with', 'near', 'our', 'we', 'us', 'me', 'my',
  'is', 'are', 'be', 'to', 'of', 'in', 'on', 'at', 'it', 'that', 'this', 'some', 'any', 'can',
  'you', 'find', 'suggest', 'recommend', 'please', 'would', 'like', 'want', 'need', 'have',
  'under', 'over', 'per', 'person', 'people', 'group', 'trip', 'good', 'best', 'spot', 'place',
]);

const FIELD_WEIGHTS = {
  name: 3,
  category: 2,
  tags: 2,
  dietaryTags: 2,
  description: 1,
  transit: 1,
  weatherNote: 1,
};

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function documentTokens(venue) {
  const tokens = [];
  for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
    const raw = venue[field];
    const values = Array.isArray(raw) ? raw.join(' ') : raw;
    const fieldTokens = tokenize(values);
    for (let i = 0; i < weight; i += 1) tokens.push(...fieldTokens);
  }
  return tokens;
}

/** Build a BM25 index over venues. */
function buildIndex(venues) {
  const docs = [];
  const postings = new Map(); // term -> Map(docIndex -> tf)

  venues.forEach((venue, index) => {
    const tokens = documentTokens(venue);
    docs.push({ venue, length: tokens.length });
    const tf = new Map();
    for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
    for (const [token, count] of tf) {
      if (!postings.has(token)) postings.set(token, new Map());
      postings.get(token).set(index, count);
    }
  });

  const avgLength = docs.length ? docs.reduce((sum, d) => sum + d.length, 0) / docs.length : 0;
  return { docs, postings, avgLength };
}

/**
 * BM25 search. Returns [{ venue, relevance, matchedTerms }] sorted by relevance.
 */
function search(index, query, { k = 8, k1 = 1.4, b = 0.75 } = {}) {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];

  const N = index.docs.length;
  const scores = new Map();
  const matched = new Map();

  for (const term of terms) {
    const postings = index.postings.get(term);
    if (!postings) continue;
    const df = postings.size;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

    for (const [docIndex, tf] of postings) {
      const length = index.docs[docIndex].length || 1;
      const norm = tf + k1 * (1 - b + (b * length) / (index.avgLength || 1));
      const score = idf * ((tf * (k1 + 1)) / norm);
      scores.set(docIndex, (scores.get(docIndex) || 0) + score);
      if (!matched.has(docIndex)) matched.set(docIndex, []);
      matched.get(docIndex).push(term);
    }
  }

  return [...scores.entries()]
    .sort((a, b2) => b2[1] - a[1] || a[0] - b2[0])
    .slice(0, k)
    .map(([docIndex, score]) => ({
      venue: index.docs[docIndex].venue,
      relevance: Math.round(score * 1000) / 1000,
      matchedTerms: matched.get(docIndex) || [],
    }));
}

/** Convenience wrapper: retrieve top-k grounding documents for a question. */
function retrieve(query, venues, k = 8) {
  return search(buildIndex(venues), query, { k });
}

module.exports = { buildIndex, search, retrieve, tokenize };
