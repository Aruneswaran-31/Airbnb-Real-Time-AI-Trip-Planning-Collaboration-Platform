'use strict';

/**
 * Validation for admin venue-dataset uploads (PRD 6.3 acceptance criteria).
 * Rejects invalid price, dietary vocabulary, coordinates and hours with
 * field-level messages instead of accepting and corrupting the catalog.
 */

const { DIETARY_TAGS, CATEGORIES } = require('../models/User');
const { isValidTime } = require('../utils/time');
const { isValidCoordinate } = require('../utils/geo');
const { slugify } = require('../utils/sanitize');

function validateVenuePayload(input) {
  const errors = [];
  if (!Array.isArray(input)) {
    return { ok: false, errors: [{ index: null, field: 'body', message: 'Payload must be an array of venues' }] };
  }
  if (input.length === 0) {
    return { ok: false, errors: [{ index: null, field: 'body', message: 'Payload contains no venues' }] };
  }

  const seen = new Set();
  const venues = [];

  input.forEach((raw, index) => {
    const push = (field, message) => errors.push({ index, field, message });

    if (!raw || typeof raw !== 'object') {
      push('venue', 'Each venue must be an object');
      return;
    }

    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) push('name', 'name is required');

    const venueId = typeof raw.venueId === 'string' && raw.venueId.trim() ? raw.venueId.trim() : `v_${slugify(name) || index}`;
    if (seen.has(venueId)) push('venueId', `duplicate venueId "${venueId}"`);
    seen.add(venueId);

    const destination = typeof raw.destination === 'string' ? raw.destination.trim() : '';
    if (!destination) push('destination', 'destination is required');

    const category = raw.category;
    if (!CATEGORIES.includes(category)) {
      push('category', `category must be one of: ${CATEGORIES.join(', ')}`);
    }

    const price = raw.pricePerPersonCents !== undefined ? raw.pricePerPersonCents : Math.round((raw.pricePerPerson || 0) * 100);
    if (!Number.isFinite(price) || price < 0) {
      push('pricePerPerson', 'pricePerPerson must be a positive number');
    }

    const dietaryTags = Array.isArray(raw.dietaryTags) ? raw.dietaryTags : [];
    for (const tag of dietaryTags) {
      if (!DIETARY_TAGS.includes(tag)) {
        push('dietaryTags', `"${tag}" is not in the dietary vocabulary (${DIETARY_TAGS.join(', ')})`);
      }
    }

    const lat = raw.coordinates?.lat;
    const lng = raw.coordinates?.lng;
    if (!isValidCoordinate(lat, lng)) {
      push('coordinates', 'coordinates must include lat (-90..90) and lng (-180..180)');
    }

    const open = raw.hours?.open;
    const close = raw.hours?.close;
    if (!isValidTime(open) || !isValidTime(close)) {
      push('hours', 'hours.open and hours.close must be valid HH:MM times');
    }

    const rating = raw.rating === undefined ? 4 : Number(raw.rating);
    if (!Number.isFinite(rating) || rating < 0 || rating > 5) push('rating', 'rating must be between 0 and 5');

    const description = typeof raw.description === 'string' ? raw.description.trim() : '';
    if (!description) push('description', 'description is required for RAG grounding');

    const closedDays = Array.isArray(raw.closedDays) ? raw.closedDays : [];
    for (const day of closedDays) {
      if (!Number.isInteger(day) || day < 0 || day > 6) push('closedDays', 'closedDays entries must be integers 0-6');
    }

    venues.push({
      venueId,
      destination,
      destinationSlug: slugify(destination),
      name,
      category,
      pricePerPersonCents: Math.round(price),
      dietaryTags,
      hours: { open, close },
      closedDays,
      coordinates: { lat, lng },
      rating,
      popularity: Number.isFinite(Number(raw.popularity)) ? Number(raw.popularity) : 50,
      description,
      tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
      transit: typeof raw.transit === 'string' ? raw.transit : '',
      weatherNote: typeof raw.weatherNote === 'string' ? raw.weatherNote : '',
      lodging: {
        sleeps: Number(raw.lodging?.sleeps) || 0,
        bedrooms: Number(raw.lodging?.bedrooms) || 0,
      },
      datasetVersion: typeof raw.datasetVersion === 'string' ? raw.datasetVersion : '1.0.0',
    });
  });

  return { ok: errors.length === 0, errors, venues };
}

module.exports = { validateVenuePayload };
