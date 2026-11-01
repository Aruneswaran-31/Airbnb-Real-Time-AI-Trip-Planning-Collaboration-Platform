'use strict';

/**
 * Admin-only venue dataset management (PRD 6.3): upload a destination dataset
 * through an authenticated endpoint, with validation instead of hand-editing files.
 */

const express = require('express');

const Venue = require('../models/Venue');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { requireAuth, requireGlobalRole } = require('../middleware/auth');
const { validateVenuePayload } = require('../services/datasetValidator');
const { slugify } = require('../utils/sanitize');

const router = express.Router();

router.use(requireAuth);
router.use(requireGlobalRole('admin'));

/** Upload / upsert a venue dataset. */
router.post(
  '/venues',
  asyncHandler(async (req, res) => {
    const validation = validateVenuePayload(req.body?.venues ?? req.body);
    if (!validation.ok) {
      throw new ApiError(422, 'invalid_dataset', 'Dataset failed validation', validation.errors.slice(0, 25));
    }

    const operations = validation.venues.map((venue) => ({
      updateOne: {
        filter: { destinationSlug: venue.destinationSlug, venueId: venue.venueId },
        update: { $set: { ...venue, uploadedByUserId: req.user._id } },
        upsert: true,
      },
    }));

    const result = await Venue.bulkWrite(operations);
    const destinationSlugs = [...new Set(validation.venues.map((v) => v.destinationSlug))];

    res.status(201).json({
      accepted: validation.venues.length,
      inserted: result.upsertedCount || 0,
      updated: result.modifiedCount || 0,
      destinations: destinationSlugs,
      datasetVersion: validation.venues[0]?.datasetVersion || '1.0.0',
    });
  })
);

/** Inspect a destination dataset. */
router.get(
  '/venues',
  asyncHandler(async (req, res) => {
    const filter = req.query.destinationSlug ? { destinationSlug: slugify(String(req.query.destinationSlug)) } : {};
    const venues = await Venue.find(filter).sort({ destinationSlug: 1, name: 1 }).limit(500).lean();
    res.json({ count: venues.length, venues: venues.map((v) => new Venue(v).toPublicJSON()) });
  })
);

router.delete(
  '/venues/:venueId',
  asyncHandler(async (req, res) => {
    const filter = { venueId: req.params.venueId };
    if (req.query.destinationSlug) filter.destinationSlug = slugify(String(req.query.destinationSlug));
    const result = await Venue.deleteOne(filter);
    if (result.deletedCount === 0) throw ApiError.notFound('venue_not_found', 'No venue with that id');
    res.json({ deleted: req.params.venueId });
  })
);

/** Dataset coverage report: categories + dietary tags per destination. */
router.get(
  '/dataset-stats',
  asyncHandler(async (_req, res) => {
    const rows = await Venue.aggregate([
      {
        $group: {
          _id: { slug: '$destinationSlug', destination: '$destination' },
          venues: { $sum: 1 },
          categories: { $addToSet: '$category' },
          dietaryTags: { $addToSet: '$dietaryTags' },
          minPriceCents: { $min: '$pricePerPersonCents' },
          maxPriceCents: { $max: '$pricePerPersonCents' },
        },
      },
      { $sort: { '_id.destination': 1 } },
    ]);

    const allTags = await Venue.distinct('dietaryTags');

    res.json({
      vocabulary: { dietaryTags: allTags.sort() },
      destinations: rows.map((row) => ({
        destination: row._id.destination,
        destinationSlug: row._id.slug,
        venues: row.venues,
        categories: row.categories.sort(),
        dietaryTags: [...new Set(row.dietaryTags.flat())].sort(),
        minPriceCents: row.minPriceCents,
        maxPriceCents: row.maxPriceCents,
      })),
    });
  })
);

module.exports = router;
