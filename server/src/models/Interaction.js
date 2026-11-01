'use strict';

const mongoose = require('mongoose');

const InteractionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', default: null, index: true },
    destinationSlug: { type: String, required: true, index: true },
    venueId: { type: String, required: true, index: true },
    category: { type: String, required: true },
    event: {
      type: String,
      enum: ['pinned', 'liked', 'ai_suggested', 'viewed', 'voted'],
      default: 'viewed',
    },
    liked: { type: Boolean, default: false },
    score: { type: Number, default: 1 },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

InteractionSchema.index({ userId: 1, venueId: 1 });
InteractionSchema.index({ destinationSlug: 1, venueId: 1 });

module.exports = mongoose.model('Interaction', InteractionSchema);
