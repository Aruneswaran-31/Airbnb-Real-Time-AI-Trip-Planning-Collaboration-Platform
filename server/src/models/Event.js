'use strict';

const mongoose = require('mongoose');

/**
 * Append-only event log. Session analytics and the budget reconciliation check
 * are derived from this log rather than from denormalized counters, so numbers
 * can always be re-derived and proven to match.
 */
const EventSchema = new mongoose.Schema(
  {
    tripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
    type: {
      type: String,
      required: true,
      enum: [
        'trip.created',
        'trip.joined',
        'trip.left',
        'trip.locked',
        'item.pinned',
        'item.moved',
        'item.removed',
        'item.locked',
        'item.unlocked',
        'item.promoted',
        'vote.opened',
        'vote.cast',
        'vote.resolved',
        'ai.asked',
        'ai.answered',
        'conflict.flagged',
        'conflict.resolved',
        'chat.message',
        'presence.joined',
        'presence.left',
        'leader.changed',
      ],
    },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    dayIndex: { type: Number, default: null },
    itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'ItineraryItem', default: null },
    venueId: { type: String, default: null },
    pricePerPersonCents: { type: Number, default: null },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    ts: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

EventSchema.index({ tripId: 1, type: 1, ts: 1 });

module.exports = mongoose.model('Event', EventSchema);
