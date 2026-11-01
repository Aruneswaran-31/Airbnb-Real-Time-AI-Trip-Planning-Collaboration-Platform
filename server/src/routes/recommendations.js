'use strict';

const express = require('express');
const { z } = require('zod');

const Trip = require('../models/Trip');
const Venue = require('../models/Venue');
const Interaction = require('../models/Interaction');

const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { recommend, loadModel } = require('../services/recommendation');

const router = express.Router();

router.use(requireAuth);

async function buildRail({ user, limit, destinationSlug }) {
  const myInteractions = await Interaction.find({ userId: user._id }).lean();

  // Group affinity: travelers who share a trip with this user.
  const trips = await Trip.find({ 'members.userId': user._id }).select('members').lean();
  const coTravelerIds = new Set();
  for (const trip of trips) {
    for (const member of trip.members) {
      if (String(member.userId) !== String(user._id)) coTravelerIds.add(String(member.userId));
    }
  }
  const coTravelerInteractions = coTravelerIds.size
    ? await Interaction.find({ userId: { $in: [...coTravelerIds] } }).limit(500).lean()
    : [];

  const venueFilter = destinationSlug ? { destinationSlug } : {};
  const venues = await Venue.find(venueFilter).lean();

  const model = loadModel();
  const rail = recommend({
    user: user.toObject(),
    venues,
    interactions: myInteractions,
    coTravelerInteractions,
    model,
    limit,
  });

  return {
    rail,
    signals: {
      interactions: myInteractions.length,
      coTravelers: coTravelerIds.size,
      coTravelerInteractions: coTravelerInteractions.length,
      candidates: venues.length,
      model: model ? { trainedAt: model.trainedAt, source: 'artifact' } : { source: 'live' },
      weights: require('../services/recommendation').WEIGHTS,
    },
    generatedAt: new Date().toISOString(),
  };
}

router.get(
  '/',
  validate({
    query: z.object({
      limit: z.coerce.number().int().min(1).max(20).optional(),
      destinationSlug: z.string().min(2).max(120).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await buildRail({
      user: req.user,
      limit: req.query.limit || 8,
      destinationSlug: req.query.destinationSlug,
    });
    res.json(result);
  })
);

/**
 * Record recommendation feedback (save / dismiss) as an interaction. This is the
 * signal the offline trainer learns from, so the rail improves immediately.
 */
router.post(
  '/feedback',
  validate({
    body: z.object({
      venueId: z.string().min(2).max(64),
      liked: z.boolean(),
      destinationSlug: z.string().min(2).max(120).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const venue = await Venue.findOne({ venueId: req.body.venueId }).lean();
    if (!venue) throw ApiError.notFound('venue_not_found', 'That venue is not in the catalog');

    const interaction = await Interaction.findOneAndUpdate(
      { userId: req.user._id, venueId: venue.venueId },
      {
        $set: {
          destinationSlug: venue.destinationSlug,
          category: venue.category,
          event: req.body.liked ? 'liked' : 'viewed',
          liked: req.body.liked,
          score: req.body.liked ? 1.5 : 0.4,
          createdAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );

    res.status(201).json({
      recorded: true,
      interaction: {
        venueId: interaction.venueId,
        liked: interaction.liked,
        event: interaction.event,
      },
    });
  })
);

module.exports = router;
module.exports.buildRail = buildRail;
