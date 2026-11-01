'use strict';

/**
 * Hard-constraint matcher for the AI Concierge (PRD section 6.2).
 *
 * A venue is only ever suggestible when it satisfies *all* active constraints:
 *   1. budget ceiling      - price per person <= ceiling
 *   2. dietary compatibility - venue carries every group dietary tag
 *   3. operating hours     - open/close fully contains the slot + travel buffer
 *   4. proximity           - within radius of the anchor event
 *
 * Invalid candidates are returned with the failing rule so the concierge can
 * explain (and so tests can assert 100% compliance).
 */

const { haversineKm } = require('../utils/geo');
const { isWithinHours } = require('../utils/time');

const RULES = ['budget', 'dietary', 'hours', 'proximity'];

function priceCents(venue) {
  if (Number.isFinite(venue.pricePerPersonCents)) return venue.pricePerPersonCents;
  return Math.round((venue.pricePerPerson || 0) * 100);
}

/**
 * @param {Array} venues authored venue metadata
 * @param {object} constraints
 * @param {number|null} constraints.maxPriceCents
 * @param {string[]} constraints.dietaryTags  tags every candidate must carry
 * @param {{startTime:string,endTime:string}|null} constraints.slot
 * @param {number} constraints.bufferMinutes
 * @param {{lat:number,lng:number}|null} constraints.anchor
 * @param {number} constraints.radiusKm
 * @param {number[]} constraints.excludeVenueIds
 * @param {number|null} constraints.dayOfWeek 0-6, venue closed days are respected when known
 */
function filterVenues(venues, constraints = {}) {
  const {
    maxPriceCents = null,
    dietaryTags = [],
    slot = null,
    bufferMinutes = 30,
    anchor = null,
    radiusKm = 2,
    excludeVenueIds = [],
    dayOfWeek = null,
  } = constraints;

  const valid = [];
  const rejected = [];

  for (const venue of venues) {
    if (excludeVenueIds.map(String).includes(String(venue.venueId))) {
      rejected.push({ venueId: venue.venueId, name: venue.name, reasons: ['already_pinned'] });
      continue;
    }

    const reasons = [];
    const detail = {};

    // 1. Budget ceiling
    const price = priceCents(venue);
    if (maxPriceCents !== null && Number.isFinite(maxPriceCents) && price > maxPriceCents) {
      reasons.push('budget');
      detail.budget = { priceCents: price, ceilingCents: maxPriceCents, overByCents: price - maxPriceCents };
    }

    // 2. Dietary compatibility (must carry every group tag)
    const venueTags = (venue.dietaryTags || []).map((t) => t.toLowerCase());
    const missingTags = dietaryTags.filter((tag) => !venueTags.includes(String(tag).toLowerCase()));
    if (missingTags.length > 0) {
      reasons.push('dietary');
      detail.dietary = { missingTags, venueTags };
    }

    // 3. Operating hours + travel buffer
    if (slot && slot.startTime && slot.endTime) {
      const closedToday =
        dayOfWeek !== null && Array.isArray(venue.closedDays) && venue.closedDays.includes(Number(dayOfWeek));
      if (closedToday) {
        reasons.push('hours');
        detail.hours = { closedDay: Number(dayOfWeek), hours: venue.hours };
      } else if (!isWithinHours(venue.hours, slot.startTime, slot.endTime, bufferMinutes)) {
        reasons.push('hours');
        detail.hours = { hours: venue.hours, slot, bufferMinutes };
      }
    }

    // 4. Proximity to anchor
    let distanceKm = null;
    if (anchor && Number.isFinite(anchor.lat) && Number.isFinite(anchor.lng) && venue.coordinates) {
      distanceKm = haversineKm(anchor, venue.coordinates);
      if (distanceKm > radiusKm) {
        reasons.push('proximity');
        detail.proximity = { distanceKm: round(distanceKm), radiusKm };
      }
    }

    if (reasons.length > 0) {
      rejected.push({ venueId: venue.venueId, name: venue.name, reasons, detail, distanceKm: distanceKm === null ? null : round(distanceKm) });
    } else {
      valid.push({ ...venue, distanceKm: distanceKm === null ? null : round(distanceKm) });
    }
  }

  return {
    valid,
    rejected,
    stats: {
      evaluated: venues.length,
      valid: valid.length,
      rejected: rejected.length,
      violations: RULES.reduce((acc, rule) => {
        acc[rule] = rejected.filter((r) => r.reasons.includes(rule)).length;
        return acc;
      }, {}),
    },
  };
}

/** Deterministic score used only over already-valid candidates. */
function scoreCandidate(venue, { anchor, maxPriceCents, radiusKm = 2, weights }) {
  const w = weights || { proximity: 0.4, rating: 0.3, budgetHeadroom: 0.3 };
  const distanceKm = venue.distanceKm !== null && venue.distanceKm !== undefined
    ? venue.distanceKm
    : anchor && venue.coordinates
      ? haversineKm(anchor, venue.coordinates)
      : radiusKm;

  const proximityScore = Math.max(0, 1 - distanceKm / radiusKm);
  const ratingScore = (Number(venue.rating) || 0) / 5 * 0.7 + (Number(venue.popularity) || 50) / 100 * 0.3;
  const ceiling = maxPriceCents && maxPriceCents > 0 ? maxPriceCents : priceCents(venue) || 1;
  const budgetHeadroomScore = Math.max(0, Math.min(1, (ceiling - priceCents(venue)) / ceiling));

  const score =
    w.proximity * proximityScore + w.rating * ratingScore + w.budgetHeadroom * budgetHeadroomScore;

  return {
    score: round(score),
    breakdown: {
      proximity: round(proximityScore),
      rating: round(ratingScore),
      budgetHeadroom: round(budgetHeadroomScore),
    },
    distanceKm: round(distanceKm),
  };
}

function rankCandidates(valid, options) {
  return valid
    .map((venue) => ({ venue, ...scoreCandidate(venue, options) }))
    .sort((a, b) => b.score - a.score || a.venue.venueId.localeCompare(b.venue.venueId));
}

/** Does a candidate satisfy the active constraints? Used by compliance tests. */
function isConstraintValid(venue, constraints) {
  return filterVenues([venue], constraints).valid.length === 1;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

module.exports = { filterVenues, scoreCandidate, rankCandidates, isConstraintValid, priceCents, RULES };
