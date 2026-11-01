'use strict';

/**
 * Public venue/listing catalog + the mandatory proximity-filtered endpoint from
 * the PRD:
 *   GET /api/v1/destinations/:destination/venues?near={lat,lng}&radiusKm={n}
 */

const express = require('express');
const { z } = require('zod');

const Venue = require('../models/Venue');
const { asyncHandler } = require('../middleware/errors');
const { validate } = require('../middleware/validate');
const { optionalAuth } = require('../middleware/auth');
const { filterVenues } = require('../services/constraints');
const { haversineKm } = require('../utils/geo');
const { slugify } = require('../utils/sanitize');
const config = require('../config');

const router = express.Router();

router.use(optionalAuth);

/** Destinations that have an authored dataset. */
router.get(
  '/destinations',
  asyncHandler(async (_req, res) => {
    const destinations = await Venue.aggregate([
      {
        $group: {
          _id: { slug: '$destinationSlug', destination: '$destination' },
          venues: { $sum: 1 },
          categories: { $addToSet: '$category' },
          coordinates: { $first: '$coordinates' },
          avgPriceCents: { $avg: '$pricePerPersonCents' },
        },
      },
      { $sort: { '_id.destination': 1 } },
    ]);

    res.json({
      destinations: destinations.map((d) => ({
        destination: d._id.destination,
        destinationSlug: d._id.slug,
        venueCount: d.venues,
        categories: d.categories.sort(),
        coordinates: d.coordinates,
        averagePricePerPersonCents: Math.round(d.avgPriceCents || 0),
      })),
    });
  })
);

const venueQuerySchema = z.object({
  near: z.string().regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/).optional(),
  radiusKm: z.coerce.number().min(0.1).max(50).optional(),
  category: z.enum(['lodging', 'food', 'activity', 'transport', 'other']).optional(),
  maxPricePerPerson: z.coerce.number().min(0).optional(),
  dietary: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** Venue metadata for a destination, optionally filtered by proximity. */
router.get(
  '/destinations/:destination/venues',
  validate({ query: venueQuerySchema }),
  asyncHandler(async (req, res) => {
    const destinationSlug = slugify(decodeURIComponent(req.params.destination));
    const all = await Venue.find({ destinationSlug }).lean();
    if (all.length === 0) {
      const available = await Venue.distinct('destination');
      return res.status(404).json({
        error: { code: 'unknown_destination', message: `No dataset for "${req.params.destination}"`, details: { available } },
      });
    }

    let venues = all;
    if (req.query.category) venues = venues.filter((v) => v.category === req.query.category);

    let anchor = null;
    if (req.query.near) {
      const [lat, lng] = req.query.near.split(',').map(Number);
      anchor = { lat, lng };
    }

    const dietaryTags = req.query.dietary ? req.query.dietary.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const maxPriceCents =
      req.query.maxPricePerPerson !== undefined ? Math.round(req.query.maxPricePerPerson * 100) : null;

    const { valid } = filterVenues(venues, {
      maxPriceCents,
      dietaryTags,
      anchor,
      radiusKm: req.query.radiusKm ?? config.constraints.defaultRadiusKm,
      slot: null,
    });

    const enriched = valid.map((v) => ({
      venueId: v.venueId,
      name: v.name,
      category: v.category,
      pricePerPerson: v.pricePerPersonCents / 100,
      pricePerPersonCents: v.pricePerPersonCents,
      dietaryTags: v.dietaryTags,
      hours: v.hours,
      coordinates: v.coordinates,
      rating: v.rating,
      description: v.description,
      tags: v.tags,
      transit: v.transit,
      distanceKm: anchor ? round(haversineKm(anchor, v.coordinates)) : null,
    }));

    enriched.sort((a, b) =>
      anchor ? a.distanceKm - b.distanceKm : b.rating - a.rating || a.name.localeCompare(b.name)
    );

    return res.json({
      destination: all[0].destination,
      destinationSlug,
      count: enriched.length,
      filters: {
        near: anchor,
        radiusKm: anchor ? req.query.radiusKm ?? config.constraints.defaultRadiusKm : null,
        category: req.query.category || null,
        maxPricePerPersonCents: maxPriceCents,
        dietaryTags,
      },
      venues: req.query.limit ? enriched.slice(0, req.query.limit) : enriched,
    });
  })
);

function round(value) {
  return Math.round(value * 1000) / 1000;
}

module.exports = router;
