'use strict';

/**
 * Hybrid recommender: content-based + collaborative (item co-occurrence) with a
 * group-affinity boost from co-travelers.
 *
 * The rail is recomputed from live interaction data on every request, so new
 * interactions change recommendations immediately; the offline artifact written by
 * `npm run train` adds smoothed item-item similarity and a popularity prior
 * (batch retrain is optional, not required, for the rail to work).
 */

const fs = require('fs');
const path = require('path');

const MODEL_PATH = path.join(__dirname, '..', '..', 'artifacts', 'recommender.json');

// Content signals dominate on purpose: with sparse interaction histories, item
// co-occurrence adds breadth but category/spend affinity is what actually
// predicts what a traveler will pick next.
const WEIGHTS = {
  content: 0.22,
  affinity: 0.34,
  tags: 0.16,
  collaborative: 0.12,
  price: 0.06,
  popularity: 0.1,
};

function priceBand(cents) {
  if (cents < 1500) return 'price_budget';
  if (cents < 4000) return 'price_mid';
  if (cents < 10000) return 'price_premium';
  return 'price_luxury';
}

function ratingBand(rating) {
  if (!rating) return 'rating_unknown';
  if (rating >= 4.7) return 'rating_top';
  if (rating >= 4.3) return 'rating_high';
  if (rating >= 3.8) return 'rating_mid';
  return 'rating_low';
}

/** Sparse feature vector for a venue, values in [0, 1]. */
function venueFeatures(venue) {
  const features = {};
  const add = (key, weight = 1) => {
    features[key] = (features[key] || 0) + weight;
  };
  add(`cat:${venue.category}`, 1);
  add(`band:${priceBand(venue.pricePerPersonCents || 0)}`, 0.7);
  add(`rated:${ratingBand(venue.rating)}`, 0.5);
  for (const tag of venue.dietaryTags || []) add(`diet:${tag}`, 0.8);
  for (const tag of venue.tags || []) add(`tag:${tag}`, 1);
  return normalize(features);
}

function normalize(vector) {
  const magnitude = Math.sqrt(Object.values(vector).reduce((sum, v) => sum + v * v, 0));
  if (!magnitude) return {};
  const out = {};
  for (const [key, value] of Object.entries(vector)) out[key] = value / magnitude;
  return out;
}

function cosine(a, b) {
  let dot = 0;
  const [small, large] = Object.keys(a).length < Object.keys(b).length ? [a, b] : [b, a];
  for (const [key, value] of Object.entries(small)) {
    if (large[key]) dot += value * large[key];
  }
  return dot;
}

/**
 * Build a traveler preference profile from their interactions (and optionally
 * their co-travelers' interactions, which is the group-affinity signal).
 */
function buildProfile({ user, interactions, coTravelerInteractions = [] }) {
  const vector = {};
  const add = (features, weight) => {
    for (const [key, value] of Object.entries(features)) {
      vector[key] = (vector[key] || 0) + value * weight;
    }
  };

  for (const interaction of interactions) {
    const weight =
      interaction.event === 'liked' ? 1.5 : interaction.event === 'pinned' ? 1.2 : interaction.event === 'voted' ? 1.1 : 0.6;
    add(venueFeaturesFromInteraction(interaction), weight);
  }
  for (const interaction of coTravelerInteractions) {
    add(venueFeaturesFromInteraction(interaction), 0.35);
  }
  for (const category of (user.preferences && user.preferences.favoriteCategories) || []) {
    add({ [`cat:${category}`]: 1 }, 1.4);
  }
  for (const tag of user.dietaryTags || []) {
    add({ [`diet:${tag}`]: 1 }, 1.1);
  }
  return normalize(vector);
}

// Interactions only carry category + venueId; expand with the venue record when available.
const venueCache = new Map();
function rememberVenues(venues) {
  for (const venue of venues) venueCache.set(venue.venueId, venue);
}
function venueFeaturesFromInteraction(interaction) {
  const venue = venueCache.get(interaction.venueId);
  if (venue) return venueFeatures(venue);
  return normalize({ [`cat:${interaction.category}`]: 1 });
}

/** Item-item co-occurrence similarity (collaborative filtering signal). */
function buildItemSimilarity(interactions) {
  const byUser = new Map();
  for (const interaction of interactions) {
    const key = String(interaction.userId);
    if (!byUser.has(key)) byUser.set(key, new Set());
    byUser.get(key).add(interaction.venueId);
  }

  const counts = new Map();
  for (const venues of byUser.values()) {
    const list = [...venues];
    for (const a of list) {
      if (!counts.has(a)) counts.set(a, new Map());
      for (const b of list) {
        if (a === b) continue;
        counts.get(a).set(b, (counts.get(a).get(b) || 0) + 1);
      }
    }
  }

  const totals = new Map();
  for (const [venue, peers] of counts) {
    totals.set(venue, [...peers.values()].reduce((sum, v) => sum + v, 0));
  }

  const similarity = {};
  for (const [a, peers] of counts) {
    similarity[a] = {};
    for (const [b, cooccur] of peers) {
      similarity[a][b] = cooccur / Math.sqrt((totals.get(a) || 1) * (totals.get(b) || 1));
    }
  }
  return similarity;
}

function loadModel() {
  try {
    if (!fs.existsSync(MODEL_PATH)) return null;
    return JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Rank candidate venues for a traveler.
 *
 * @returns {Array} rail entries with score and human-readable reasons
 */
/** Category + spend affinity learned from the traveler's own history. */
function buildAffinity(user, interactions) {
  const categoryTotals = {};
  const tagTotals = {};
  let total = 0;
  let tagTotal = 0;
  const prices = [];

  for (const interaction of interactions) {
    const weight = interaction.event === 'liked' ? 1.5 : interaction.event === 'pinned' ? 1.2 : interaction.event === 'voted' ? 1.1 : 0.6;
    categoryTotals[interaction.category] = (categoryTotals[interaction.category] || 0) + weight;
    total += weight;

    const venue = venueCache.get(interaction.venueId);
    if (!venue) continue;
    if (Number.isFinite(venue.pricePerPersonCents)) prices.push(venue.pricePerPersonCents);
    for (const tag of new Set([...(venue.tags || []), ...(venue.dietaryTags || [])])) {
      tagTotals[tag] = (tagTotals[tag] || 0) + weight;
      tagTotal += weight;
    }
  }

  const categoryAffinity = {};
  for (const [category, weight] of Object.entries(categoryTotals)) {
    categoryAffinity[category] = total > 0 ? weight / total : 0;
  }

  // Declared interests count for a quarter of the affinity, so a new traveler
  // with a thin history still gets sensible recommendations.
  const declared = (user && user.preferences && user.preferences.favoriteCategories) || [];
  if (declared.length) {
    for (const [category, value] of Object.entries(categoryAffinity)) {
      categoryAffinity[category] = value * 0.75;
    }
    for (const category of declared) {
      categoryAffinity[category] = (categoryAffinity[category] || 0) + 0.25 / declared.length;
    }
  }

  const tagAffinity = {};
  for (const [tag, weight] of Object.entries(tagTotals)) {
    tagAffinity[tag] = tagTotal > 0 ? weight / tagTotal : 0;
  }

  prices.sort((a, b) => a - b);
  const medianPriceCents = prices.length ? prices[Math.floor(prices.length / 2)] : null;

  return {
    categoryAffinity,
    tagAffinity,
    medianPriceCents,
    topCategory: Object.entries(categoryAffinity).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    topTags: Object.entries(tagAffinity)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tag]) => tag),
  };
}

function recommend({ user, venues, interactions = [], coTravelerInteractions = [], model = null, limit = 8, seenVenueIds = [] }) {
  rememberVenues(venues);
  const profile = buildProfile({ user, interactions, coTravelerInteractions });
  const affinity = buildAffinity(user, interactions);
  const likedVenues = new Set(interactions.map((i) => i.venueId));
  const excluded = new Set([...seenVenueIds, ...likedVenues]);

  const liveSimilarity = buildItemSimilarity([...interactions, ...coTravelerInteractions]);
  const similarity = model && model.itemSimilarity ? model.itemSimilarity : liveSimilarity;
  const popularityPrior = (model && model.popularity) || {};
  const maxPopularity = Math.max(1, ...Object.values(popularityPrior), 1);

  const results = [];
  for (const venue of venues) {
    if (excluded.has(venue.venueId)) continue;

    const features = venueFeatures(venue);
    const contentScore = cosine(profile, features);

    let collaborativeScore = 0;
    let bestPeer = null;
    const peers = similarity[venue.venueId] || {};
    for (const [otherId, similarityScore] of Object.entries(peers)) {
      if (!likedVenues.has(otherId)) continue;
      if (similarityScore > collaborativeScore) {
        collaborativeScore = similarityScore;
        bestPeer = otherId;
      }
    }

    const popularityScore =
      ((popularityPrior[venue.venueId] || 0) / maxPopularity) * 0.6 +
      ((Number(venue.rating) || 3.5) / 5) * 0.4;

    const categoryAffinity = affinity.categoryAffinity[venue.category] || 0;

    // How strongly the venue's tags overlap the traveler's historical tags.
    const venueTags = new Set([...(venue.tags || []), ...(venue.dietaryTags || [])]);
    let tagMatch = 0;
    for (const tag of venueTags) tagMatch += affinity.tagAffinity[tag] || 0;
    tagMatch = Math.min(1, tagMatch * 2);

    let priceCloseness = 0.5;
    if (affinity.medianPriceCents) {
      const delta = Math.abs((venue.pricePerPersonCents || 0) - affinity.medianPriceCents);
      priceCloseness = Math.max(0, 1 - delta / Math.max(affinity.medianPriceCents, 1));
    }

    const score =
      WEIGHTS.content * contentScore +
      WEIGHTS.affinity * categoryAffinity +
      WEIGHTS.tags * tagMatch +
      WEIGHTS.collaborative * collaborativeScore +
      WEIGHTS.price * priceCloseness +
      WEIGHTS.popularity * popularityScore;

    const reasons = [];
    if (categoryAffinity >= 0.4) {
      reasons.push(`Strong match for your ${venue.category} picks (${Math.round(categoryAffinity * 100)}% of your history)`);
    } else if (contentScore > 0.15) {
      if ((user.preferences?.favoriteCategories || []).includes(venue.category)) {
        reasons.push(`Matches your interest in ${venue.category}`);
      } else if (profile[`cat:${venue.category}`]) {
        reasons.push(`Similar to ${venue.category} spots you engaged with`);
      }
    }
    if (affinity.medianPriceCents && Math.abs((venue.pricePerPersonCents || 0) - affinity.medianPriceCents) <= affinity.medianPriceCents * 0.25) {
      reasons.push('In the price range you usually book');
    }
    if (tagMatch > 0.25) {
      const shared = [...venueTags].filter((tag) => affinity.topTags.includes(tag)).slice(0, 2);
      if (shared.length) reasons.push(`Shares your interest in ${shared.join(' / ')}`);
    }
    if (bestPeer) {
      const peerVenue = venueCache.get(bestPeer);
      reasons.push(`Travelers who picked ${peerVenue ? peerVenue.name : bestPeer} also chose this`);
    }
    const sharedDiet = (venue.dietaryTags || []).filter((tag) => (user.dietaryTags || []).includes(tag));
    if (sharedDiet.length) reasons.push(`Fits your ${sharedDiet.join(' / ')} preference`);
    if (venue.pricePerPersonCents <= (user.preferences?.maxPerPersonBudgetCents || Infinity)) {
      reasons.push(`Within your $${Math.round((user.preferences?.maxPerPersonBudgetCents || 0) / 100)} per-person budget`);
    }
    if (!reasons.length) reasons.push(`Popular in ${venue.destination || 'this destination'}`);

    results.push({
      venueId: venue.venueId,
      name: venue.name,
      destination: venue.destination,
      category: venue.category,
      pricePerPersonCents: venue.pricePerPersonCents,
      pricePerPerson: (venue.pricePerPersonCents || 0) / 100,
      rating: venue.rating,
      dietaryTags: venue.dietaryTags,
      description: venue.description,
      score: Math.round(score * 1000) / 1000,
      breakdown: {
        content: Math.round(contentScore * 1000) / 1000,
        affinity: Math.round(categoryAffinity * 1000) / 1000,
        tags: Math.round(tagMatch * 1000) / 1000,
        collaborative: Math.round(collaborativeScore * 1000) / 1000,
        price: Math.round(priceCloseness * 1000) / 1000,
        popularity: Math.round(popularityScore * 1000) / 1000,
      },
      reasons: reasons.slice(0, 3),
    });
  }

  const ranked = results.sort((a, b) => b.score - a.score || a.venueId.localeCompare(b.venueId));
  return diversify(ranked, limit, affinity.categoryAffinity);
}

/**
 * Proportional category quotas so a mixed-taste traveler's rail reflects the mix
 * instead of being monopolised by their single strongest category. Slots are
 * filled in score order within each quota, then any remainder goes to the
 * highest-scoring leftovers.
 */
function diversify(ranked, limit, categoryAffinity) {
  const entries = Object.entries(categoryAffinity || {}).filter(([, value]) => value >= 0.15);
  if (entries.length < 2) return ranked.slice(0, limit);

  const quotas = new Map();
  let assigned = 0;
  for (const [category, value] of entries) {
    const quota = Math.max(1, Math.round(limit * value));
    quotas.set(category, quota);
    assigned += quota;
  }

  // Never let quotas exceed the requested rail length.
  if (assigned > limit) {
    const scale = limit / assigned;
    assigned = 0;
    for (const [category, quota] of quotas) {
      const scaled = Math.max(1, Math.floor(quota * scale));
      quotas.set(category, scaled);
      assigned += scaled;
    }
  }

  const chosen = [];
  const used = new Set();
  const counts = new Map();

  for (const entry of ranked) {
    if (chosen.length >= limit) break;
    const quota = quotas.get(entry.category);
    if (quota === undefined) continue;
    if ((counts.get(entry.category) || 0) >= quota) continue;
    chosen.push(entry);
    used.add(entry.venueId);
    counts.set(entry.category, (counts.get(entry.category) || 0) + 1);
  }

  for (const entry of ranked) {
    if (chosen.length >= limit) break;
    if (used.has(entry.venueId)) continue;
    chosen.push(entry);
  }

  return chosen.sort((a, b) => b.score - a.score || a.venueId.localeCompare(b.venueId));
}

module.exports = {
  recommend,
  buildProfile,
  buildAffinity,
  buildItemSimilarity,
  venueFeatures,
  loadModel,
  cosine,
  diversify,
  WEIGHTS,
  MODEL_PATH,
  priceBand,
  rememberVenues,
};
