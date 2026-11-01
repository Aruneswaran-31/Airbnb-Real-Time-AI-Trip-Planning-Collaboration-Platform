'use strict';

const mongoose = require('mongoose');

const BallotSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    candidateItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'ItineraryItem', required: true },
    castAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const VoteSchema = new mongoose.Schema(
  {
    tripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
    slot: {
      dayIndex: { type: Number, required: true },
      startTime: { type: String, required: true },
      endTime: { type: String, required: true },
    },
    candidateItemIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ItineraryItem' }],
    ballots: { type: [BallotSchema], default: [] },
    openedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    closesAt: { type: Date, required: true },
    status: { type: String, enum: ['open', 'resolved', 'cancelled'], default: 'open', index: true },
    winningItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'ItineraryItem', default: null },
    resolvedAt: { type: Date, default: null },
    resolution: { type: String, enum: ['tallied', 'tie-break', 'expired', 'leader-override'], default: 'tallied' },
  },
  { timestamps: true }
);

VoteSchema.index({ tripId: 1, status: 1 });
// A slot can only have one live vote at a time.
VoteSchema.index(
  { tripId: 1, 'slot.dayIndex': 1, 'slot.startTime': 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'open' } }
);

VoteSchema.methods.toPublicJSON = function toPublicJSON() {
  const obj = this.toObject({ virtuals: false });
  obj.voteId = String(this._id);
  delete obj._id;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('Vote', VoteSchema);
