'use strict';

const express = require('express');
const { z } = require('zod');

const ItineraryItem = require('../models/ItineraryItem');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate } = require('../middleware/validate');
const { loadTrip, requireTripRole } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const boardService = require('../services/boardService');

const router = express.Router({ mergeParams: true });

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Time must be HH:MM (24h)');

const pinSchema = z
  .object({
    venueId: z.string().min(2).max(64).optional(),
    title: z.string().min(1).max(120).optional(),
    category: z.enum(['lodging', 'food', 'activity', 'transport', 'other']).optional(),
    pricePerPerson: z.number().min(0).max(1_000_000).optional(),
    dietaryTags: z.array(z.string()).optional(),
    coordinates: z.object({ lat: z.number(), lng: z.number() }).optional(),
    dayIndex: z.number().int().min(0).max(60),
    startTime: timeSchema,
    endTime: timeSchema,
    note: z.string().max(500).optional(),
  })
  .refine((v) => Boolean(v.venueId || v.title), {
    message: 'Provide a venueId from the dataset or a custom title',
    path: ['venueId'],
  });

/** Pin a venue or custom card to the canvas. */
router.post(
  '/',
  writeLimiter,
  loadTrip,
  requireTripRole('planner'),
  validate({ body: pinSchema }),
  asyncHandler(async (req, res) => {
    const result = await boardService.pinItem({
      trip: req.trip,
      user: req.user,
      role: req.tripRole,
      input: req.body,
    });
    res.status(201).json(result);
  })
);

/** Move an item. Requires expectedVersion; stale writes get 409 + current state. */
router.patch(
  '/:itemId',
  writeLimiter,
  loadTrip,
  requireTripRole('planner'),
  validate({
    body: z.object({
      dayIndex: z.number().int().min(0).max(60),
      startTime: timeSchema,
      endTime: timeSchema,
      expectedVersion: z.number().int().min(1),
      note: z.string().max(500).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await boardService.moveItem({
      trip: req.trip,
      user: req.user,
      role: req.tripRole,
      itemId: req.params.itemId,
      ...req.body,
    });

    if (result.conflict) {
      return res.status(409).json({
        error: {
          code: 'stale_version',
          message: 'Another planner moved this item first. The board has been sent the current state so you can reconcile.',
          details: {
            expectedVersion: result.conflict.expectedVersion,
            currentVersion: result.conflict.currentVersion,
            currentItem: result.conflict.item,
          },
        },
        currentItem: result.conflict.item,
      });
    }

    return res.json(result);
  })
);

router.delete(
  '/:itemId',
  writeLimiter,
  loadTrip,
  requireTripRole('planner'),
  asyncHandler(async (req, res) => {
    const result = await boardService.removeItem({
      trip: req.trip,
      user: req.user,
      role: req.tripRole,
      itemId: req.params.itemId,
    });
    res.json(result);
  })
);

/** Lock / unlock a finalized item (Leader only). */
router.post(
  '/:itemId/lock',
  writeLimiter,
  loadTrip,
  requireTripRole('leader'),
  asyncHandler(async (req, res) => {
    const result = await boardService.setItemLock({
      trip: req.trip,
      user: req.user,
      role: req.tripRole,
      itemId: req.params.itemId,
      locked: true,
    });
    res.json(result);
  })
);

router.post(
  '/:itemId/unlock',
  writeLimiter,
  loadTrip,
  requireTripRole('leader'),
  asyncHandler(async (req, res) => {
    const result = await boardService.setItemLock({
      trip: req.trip,
      user: req.user,
      role: req.tripRole,
      itemId: req.params.itemId,
      locked: false,
    });
    res.json(result);
  })
);

/** Single item (handy for reconciliation after a lost concurrent move). */
router.get(
  '/:itemId',
  loadTrip,
  asyncHandler(async (req, res) => {
    const item = await ItineraryItem.findOne({ _id: req.params.itemId, tripId: req.trip._id });
    if (!item) throw ApiError.notFound('item_not_found', 'Itinerary item not found');
    res.json({ item: item.toPublicJSON() });
  })
);

module.exports = router;
