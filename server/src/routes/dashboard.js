'use strict';

const express = require('express');
const mongoose = require('mongoose');

const Trip = require('../models/Trip');
const ItineraryItem = require('../models/ItineraryItem');
const Interaction = require('../models/Interaction');
const Event = require('../models/Event');
const Vote = require('../models/Vote');

const { asyncHandler } = require('../middleware/errors');
const { requireAuth } = require('../middleware/auth');
const { buildRail } = require('./recommendations');

const router = express.Router();

router.use(requireAuth);

/**
 * Personal dashboard: trip history, preference profile, quick rejoin and the
 * personalized recommendation rail.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const trips = await Trip.find({ 'members.userId': req.user._id }).sort({ createdAt: -1 }).lean();
    const tripIds = trips.map((t) => t._id);

    const [spendAgg, interactions, aiCount, voteCount, conflictCount] = await Promise.all([
      ItineraryItem.aggregate([
        { $match: { tripId: { $in: tripIds } } },
        { $group: { _id: '$tripId', perPerson: { $sum: '$pricePerPersonCents' }, count: { $sum: 1 } } },
      ]),
      Interaction.find({ userId: req.user._id }).lean(),
      Event.countDocuments({ tripId: { $in: tripIds }, type: 'ai.asked' }),
      Vote.countDocuments({ tripId: { $in: tripIds } }),
      Event.countDocuments({ tripId: { $in: tripIds }, type: 'conflict.flagged' }),
    ]);

    const spendByTrip = new Map(spendAgg.map((row) => [String(row._id), row]));

    const tripRows = trips.map((trip) => {
      const spend = spendByTrip.get(String(trip._id)) || { perPerson: 0, count: 0 };
      const participants = trip.members.length;
      return {
        tripId: String(trip._id),
        destination: trip.destination,
        startDate: trip.startDate,
        endDate: trip.endDate,
        status: trip.status,
        inviteCode: trip.inviteCode,
        role: String(trip.leaderUserId) === String(req.user._id) ? 'leader' : (trip.members.find((m) => String(m.userId) === String(req.user._id))?.role || 'viewer'),
        participants,
        itemCount: spend.count,
        groupSpendCents: spend.perPerson * participants,
        totalBudgetCents: trip.totalBudgetCents,
        createdAt: trip.createdAt,
        endedAt: trip.endedAt,
      };
    });

    // Aggregate travel preference profile from real interaction data.
    const categoryTotals = {};
    const venues = new Set();
    for (const interaction of interactions) {
      categoryTotals[interaction.category] = (categoryTotals[interaction.category] || 0) + (interaction.score || 1);
      venues.add(interaction.venueId);
    }
    const totalWeight = Object.values(categoryTotals).reduce((a, b) => a + b, 0) || 1;
    const favoriteCategories = Object.entries(categoryTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([category, weight]) => ({
        category,
        affinity: Math.round((weight / totalWeight) * 100),
      }));

    // Recommendations are scoped to the destination of the trip being planned
    // (most recent active trip), falling back to the whole catalog.
    const activeTrip = trips.find((t) => t.status !== 'completed') || trips[0] || null;
    const { rail, signals } = await buildRail({
      user: req.user,
      limit: 6,
      destinationSlug: activeTrip ? activeTrip.destinationSlug : undefined,
    });

    res.json({
      user: req.user.toJSON(),
      stats: {
        trips: trips.length,
        activeTrips: trips.filter((t) => t.status === 'drafting').length,
        completedTrips: trips.filter((t) => t.status === 'completed').length,
        destinations: new Set(trips.map((t) => t.destination)).size,
        venuesEngaged: venues.size,
        aiQuestionsAsked: aiCount,
        votesRun: voteCount,
        conflictsFlagged: conflictCount,
      },
      trips: {
        active: tripRows.filter((t) => t.status !== 'completed'),
        past: tripRows.filter((t) => t.status === 'completed'),
      },
      preferenceProfile: {
        dietaryTags: req.user.dietaryTags,
        favoriteCategories,
        maxPerPersonBudgetCents: req.user.preferences?.maxPerPersonBudgetCents ?? null,
        categoryCeilings: req.user.preferences?.categoryCeilings ?? {},
      },
      recommendations: rail,
      recommendationSignals: { ...signals, scopedTo: activeTrip ? activeTrip.destination : 'all destinations' },
      generatedAt: new Date().toISOString(),
    });
  })
);

/** Aggregated analytics across all of the caller's trips. */
router.get(
  '/analytics',
  asyncHandler(async (req, res) => {
    const trips = await Trip.find({ 'members.userId': req.user._id }).select('_id destination status').lean();
    const tripIds = trips.map((t) => t._id);

    const events = await Event.find({ tripId: { $in: tripIds } }).lean();
    const byType = events.reduce((acc, event) => {
      acc[event.type] = (acc[event.type] || 0) + 1;
      return acc;
    }, {});

    res.json({
      totals: byType,
      trips: trips.length,
      itemsPinned: byType['item.pinned'] || 0,
      aiQuestions: byType['ai.asked'] || 0,
      conflictsFlagged: byType['conflict.flagged'] || 0,
      conflictsResolved: byType['conflict.resolved'] || 0,
      votes: byType['vote.opened'] || 0,
      tripsByStatus: trips.reduce((acc, trip) => {
        acc[trip.status] = (acc[trip.status] || 0) + 1;
        return acc;
      }, {}),
      generatedAt: new Date().toISOString(),
    });
  })
);

module.exports = router;
