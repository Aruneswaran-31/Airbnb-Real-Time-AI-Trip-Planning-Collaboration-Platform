'use strict';

/**
 * AI Concierge orchestrator.
 *
 * Question -> explicit constraints -> hard filter (constraints.js)
 *          -> retrieval over the authored venue corpus (BM25)
 *          -> weighted ranking (40/30/30 per PRD 6.2)
 *          -> grounded, cited generation (LLM if configured, template otherwise)
 *
 * The invariant enforced here: the suggested venue is always drawn from the
 * filtered candidate set, and only those venue ids can be cited.
 */

const config = require('../config');
const Venue = require('../models/Venue');
const { parseQuestion } = require('../ai/questionParser');
const { filterVenues, rankCandidates, priceCents } = require('./constraints');
const { retrieve } = require('../ai/retriever');
const { generateAnswer } = require('../ai/generator');
const { toDateOnly } = require('../utils/time');
const { shortId } = require('../utils/ids');

function groupDietaryTags(members, usersById = {}) {
  const tags = new Set();
  for (const member of members || []) {
    const user = usersById[String(member.userId)];
    for (const tag of (user && user.dietaryTags) || []) tags.add(tag);
  }
  return [...tags];
}

function perPersonTripBudget(trip, travelers) {
  const count = travelers || 1;
  return Math.round((trip.totalBudgetCents || 0) / count);
}

function categoryCeiling(user, category) {
  const ceilings = (user && user.preferences && user.preferences.categoryCeilings) || {};
  const value = category && ceilings[category] !== undefined ? ceilings[category] : null;
  return Number.isFinite(value) ? value : null;
}

function dayOfWeekFor(trip, dayIndex) {
  if (!trip.startDate || dayIndex === null || dayIndex === undefined) return null;
  const base = toDateOnly(trip.startDate);
  base.setUTCDate(base.getUTCDate() + Number(dayIndex));
  return base.getUTCDay();
}

/**
 * @param {object} input
 * @param {object} input.trip
 * @param {object} input.user          requesting traveler
 * @param {string} input.question
 * @param {object|null} input.anchorItem
 * @param {Array} input.members        trip members
 * @param {object} input.usersById     map of userId -> user doc (for dietary constraints)
 */
async function askConcierge({ trip, user, question, anchorItem = null, members = [], usersById = {} }) {
  const startedAt = Date.now();
  const travelers = members.length || 1;

  const venues = await Venue.find({ destinationSlug: trip.destinationSlug }).lean();
  const venuesHydrated = venues.map((v) => ({ ...v, pricePerPersonCents: priceCents(v) }));

  const groupTags = groupDietaryTags(members, usersById);
  const parsed = parseQuestion(question, {
    dietaryTags: groupTags,
    maxPriceCents: null,
    radiusKm: config.constraints.defaultRadiusKm,
    anchorItemId: anchorItem ? String(anchorItem._id || anchorItem.itemId) : null,
  });

  // Budget ceiling precedence: explicit in question > traveler category ceiling > trip per-person budget.
  let maxPriceCents = parsed.maxPriceCents;
  let budgetSource = parsed.budgetSource;
  if (maxPriceCents === null) {
    const ceiling = categoryCeiling(user, parsed.category);
    if (ceiling !== null) {
      maxPriceCents = ceiling;
      budgetSource = 'category_ceiling';
    } else {
      maxPriceCents = perPersonTripBudget(trip, travelers);
      budgetSource = 'trip_budget_per_person';
    }
  }

  const anchor = anchorItem
    ? {
        itemId: String(anchorItem._id || anchorItem.itemId),
        title: anchorItem.title,
        coordinates: anchorItem.coordinates && anchorItem.coordinates.lat !== null ? anchorItem.coordinates : null,
        startTime: anchorItem.startTime,
        endTime: anchorItem.endTime,
        dayIndex: anchorItem.dayIndex,
      }
    : null;

  const slot = parsed.slot || (anchor && anchor.startTime ? { startTime: anchor.startTime, endTime: anchor.endTime } : null);
  const dayIndex = anchor && anchor.dayIndex !== undefined && anchor.dayIndex !== null ? anchor.dayIndex : null;

  const constraints = {
    destination: trip.destination,
    destinationSlug: trip.destinationSlug,
    dayIndex,
    dayOfWeek: dayOfWeekFor(trip, dayIndex),
    category: parsed.category,
    maxPriceCents,
    budgetSource,
    dietaryTags: parsed.dietaryTags,
    dietarySource: parsed.dietarySource,
    slot,
    bufferMinutes: config.constraints.defaultHoursBufferMinutes,
    anchor: anchor ? anchor.coordinates : null,
    radiusKm: parsed.radiusKm,
    excludeVenueIds: [],
  };

  const pool = parsed.category ? venuesHydrated.filter((v) => v.category === parsed.category) : venuesHydrated;
  const filtered = filterVenues(pool, constraints);

  // Retrieval over the *valid* candidates only, so RAG can never surface a
  // venue that fails a hard rule.
  let candidates = filtered.valid;
  if (candidates.length > 0 && question) {
    const retrieved = retrieve(question, candidates, 12);
    if (retrieved.length > 0) candidates = retrieved.map((r) => r.venue);
  }

  const ranked = rankCandidates(candidates, {
    anchor: constraints.anchor,
    maxPriceCents: constraints.maxPriceCents,
    radiusKm: constraints.radiusKm,
    weights: config.constraints.weights,
  });

  const generation = await generateAnswer({
    question,
    candidates: ranked,
    rejected: filtered.rejected,
    constraints,
    anchor,
    currency: trip.currency,
    destination: trip.destination,
  });

  const latencyMs = Date.now() - startedAt;
  const sources = ranked.slice(0, 3).map((c) => ({
    venueId: c.venue.venueId,
    name: c.venue.name,
    category: c.venue.category,
    pricePerPersonCents: c.venue.pricePerPersonCents,
    dietaryTags: c.venue.dietaryTags,
    hours: c.venue.hours,
    rating: c.venue.rating,
    distanceKm: c.distanceKm,
    description: c.venue.description,
    score: c.score,
    scoreBreakdown: c.breakdown,
  }));

  return {
    questionId: shortId('q'),
    question,
    answer: generation.answer,
    suggestedVenueId: generation.suggestedVenueId,
    alternatives: generation.alternatives,
    sourceEvents: generation.sourceEvents,
    sources,
    suggestedVenue: sources.find((s) => s.venueId === generation.suggestedVenueId) || null,
    engine: generation.engine,
    llmReason: generation.llmReason,
    constraints: {
      maxPriceCents,
      budgetSource,
      dietaryTags: constraints.dietaryTags,
      dietarySource: constraints.dietarySource,
      slot,
      radiusKm: constraints.radiusKm,
      category: constraints.category,
      anchorItemId: anchor ? anchor.itemId : null,
      anchorLabel: anchor ? `${anchor.startTime} ${anchor.title}` : null,
      bufferMinutes: constraints.bufferMinutes,
      dayOfWeek: constraints.dayOfWeek,
    },
    candidateStats: filtered.stats,
    rejected: filtered.rejected.slice(0, 6),
    latencyMs,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { askConcierge, groupDietaryTags, perPersonTripBudget, dayOfWeekFor };
