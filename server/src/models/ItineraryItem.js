'use strict';

const mongoose = require('mongoose');
const { CATEGORIES } = require('./User');

const LIFECYCLE_STAGES = ['drafting', 'voting', 'locked'];
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const ItineraryItemSchema = new mongoose.Schema(
  {
    tripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
    venueId: { type: String, default: null, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    category: { type: String, enum: CATEGORIES, default: 'activity' },
    dayIndex: { type: Number, required: true, min: 0, max: 60 },
    startTime: {
      type: String,
      required: true,
      validate: { validator: (v) => TIME_RE.test(v), message: 'startTime must be HH:MM' },
    },
    endTime: {
      type: String,
      required: true,
      validate: { validator: (v) => TIME_RE.test(v), message: 'endTime must be HH:MM' },
    },
    pricePerPersonCents: { type: Number, default: 0, min: 0 },
    dietaryTags: [{ type: String }],
    coordinates: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    lifecycleStage: { type: String, enum: LIFECYCLE_STAGES, default: 'drafting', index: true },
    // Optimistic concurrency token: bumped on every accepted move/edit.
    positionVersion: { type: Number, default: 1 },
    pinnedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    pinnedByName: { type: String, default: '' },
    note: { type: String, default: '', maxlength: 500 },
    // Immutable copy of the venue metadata used when pinning (RAG grounding + offline board).
    venueSnapshot: {
      name: { type: String, default: '' },
      category: { type: String, default: '' },
      pricePerPersonCents: { type: Number, default: 0 },
      dietaryTags: [{ type: String }],
      hours: { open: String, close: String },
      rating: { type: Number, default: null },
      description: { type: String, default: '' },
      transit: { type: String, default: '' },
    },
    lockedAt: { type: Date, default: null },
    lockedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

ItineraryItemSchema.index({ tripId: 1, dayIndex: 1, startTime: 1 });
ItineraryItemSchema.index({ tripId: 1, lifecycleStage: 1 });

ItineraryItemSchema.methods.toPublicJSON = function toPublicJSON() {
  const obj = this.toObject({ virtuals: false });
  obj.itemId = String(this._id);
  delete obj._id;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('ItineraryItem', ItineraryItemSchema);
module.exports.LIFECYCLE_STAGES = LIFECYCLE_STAGES;
