'use strict';

/**
 * Turns a natural-language concierge question into explicit, testable filters.
 * Everything the parser extracts is also echoed back in the response payload,
 * so the AI's answer is explainable ("here is what I searched for").
 */

const { DIETARY_TAGS } = require('../models/User');
const { parseTime, formatTime } = require('../utils/time');

const DIETARY_ALIASES = {
  vegetarian: ['vegetarian', 'veggie'],
  vegan: ['vegan', 'plant-based', 'plant based'],
  halal: ['halal'],
  'gluten-free': ['gluten-free', 'gluten free', 'coeliac', 'celiac'],
  'nut-free': ['nut-free', 'nut free', 'nut allergy', 'peanut allergy'],
  'dairy-free': ['dairy-free', 'dairy free', 'lactose'],
  pescatarian: ['pescatarian', 'seafood only'],
};

const CATEGORY_HINTS = {
  food: ['dinner', 'lunch', 'breakfast', 'brunch', 'eat', 'food', 'restaurant', 'cafe', 'coffee', 'drinks', 'bar', 'tapas', 'dining', 'meal'],
  lodging: ['hotel', 'stay', 'lodging', 'airbnb', 'apartment', 'hostel', 'sleep', 'accommodation'],
  activity: ['tour', 'museum', 'activity', 'hike', 'walk', 'sightseeing', 'attraction', 'gallery', 'class', 'show', 'viewpoint', 'beach'],
  transport: ['transport', 'train', 'metro', 'taxi', 'bus', 'ferry', 'tram', 'transfer', 'airport'],
};

function extractBudgetCents(question) {
  const patterns = [
    /\$\s?(\d{1,5}(?:\.\d{1,2})?)/i,
    /\bunder\s+(\d{1,5}(?:\.\d{1,2})?)\s*(?:usd|dollars?|bucks|\/\s*(?:person|pp|head))?/i,
    /\bmax(?:imum)?\s+(\d{1,5}(?:\.\d{1,2})?)/i,
  ];
  for (const re of patterns) {
    const match = re.exec(question);
    if (match) return Math.round(Number(match[1]) * 100);
  }
  return null;
}

function extractDietaryTags(question) {
  const lower = question.toLowerCase();
  const found = new Set();
  for (const tag of DIETARY_TAGS) {
    const aliases = DIETARY_ALIASES[tag] || [tag];
    if (aliases.some((alias) => lower.includes(alias))) found.add(tag);
  }
  return [...found];
}

function extractCategory(question) {
  const lower = question.toLowerCase();
  let best = null;
  let bestHits = 0;
  for (const [category, words] of Object.entries(CATEGORY_HINTS)) {
    const hits = words.filter((word) => lower.includes(word)).length;
    if (hits > bestHits) {
      best = category;
      bestHits = hits;
    }
  }
  return best;
}

/** "5 PM" / "17:30" / "7.30pm" -> { startTime, endTime } with a 90 minute default duration. */
function extractTimeSlot(question, fallbackDurationMinutes = 90) {
  const lower = question.toLowerCase();
  let startMinutes = null;

  const ampm = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/.exec(lower);
  if (ampm) {
    let hour = Number(ampm[1]) % 12;
    if (ampm[3] === 'pm') hour += 12;
    const minutes = ampm[2] ? Number(ampm[2]) : 0;
    startMinutes = hour * 60 + minutes;
  } else if (/\bnoon\b/.test(lower)) {
    startMinutes = 12 * 60;
  } else if (/\bmidnight\b/.test(lower)) {
    startMinutes = 23 * 60;
  } else {
    const hhmm = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(lower);
    if (hhmm) startMinutes = Number(hhmm[1]) * 60 + Number(hhmm[2]);
  }

  if (startMinutes === null) return null;

  // "for 2 hours" widens the requested slot.
  const durationMatch = /\bfor\s+(\d{1,2})\s*(?:hours?|hrs?)\b/.exec(lower);
  const duration = durationMatch ? Number(durationMatch[1]) * 60 : fallbackDurationMinutes;
  const end = Math.min(startMinutes + duration, 23 * 60 + 59);

  return { startTime: formatTime(startMinutes), endTime: formatTime(end) };
}

function extractRadiusKm(question, fallbackKm) {
  const match = /\b(\d{1,2}(?:\.\d)?)\s*km\b/i.exec(question);
  if (match) return Number(match[1]);
  const miles = /\b(\d{1,2}(?:\.\d)?)\s*miles?\b/i.exec(question);
  if (miles) return Math.round(Number(miles[1]) * 1.609 * 10) / 10;
  return fallbackKm;
}

/**
 * @param {string} question
 * @param {object} defaults { dietaryTags, maxPriceCents, radiusKm, category, slot }
 */
function parseQuestion(question, defaults = {}) {
  const dietaryFromQuestion = extractDietaryTags(question);
  const groupTags = defaults.dietaryTags || [];
  const dietaryTags = [...new Set([...groupTags, ...dietaryFromQuestion])];

  const explicitBudget = extractBudgetCents(question);
  const category = extractCategory(question) || defaults.category || null;
  const slot = extractTimeSlot(question) || defaults.slot || null;

  return {
    raw: question,
    maxPriceCents: explicitBudget !== null ? explicitBudget : defaults.maxPriceCents ?? null,
    budgetSource: explicitBudget !== null ? 'question' : defaults.maxPriceCents != null ? 'traveler_profile' : 'none',
    dietaryTags,
    dietarySource: dietaryFromQuestion.length ? 'question+group' : groupTags.length ? 'group' : 'none',
    category,
    slot,
    radiusKm: extractRadiusKm(question, defaults.radiusKm ?? 2),
    anchorItemId: defaults.anchorItemId || null,
  };
}

module.exports = { parseQuestion, extractBudgetCents, extractDietaryTags, extractCategory, extractTimeSlot, parseTime };
