'use strict';

const mongoose = require('mongoose');

const TRIP_ROLES = ['viewer', 'planner', 'leader'];
const TRIP_STATUS = ['drafting', 'voting', 'locked', 'completed'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MemberSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: TRIP_ROLES, default: 'planner' },
    weight: { type: Number, default: 1, min: 0.1, max: 10 },
    muted: { type: Boolean, default: false },
    joinedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const TripSchema = new mongoose.Schema(
  {
    destination: { type: String, required: true, trim: true, maxlength: 120 },
    // Lowercased slug used to look up the authored venue dataset.
    destinationSlug: { type: String, required: true, lowercase: true, index: true },
    coordinates: {
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
    },
    startDate: {
      type: String,
      required: true,
      validate: { validator: (v) => DATE_RE.test(v), message: 'startDate must be YYYY-MM-DD' },
    },
    endDate: {
      type: String,
      required: true,
      validate: { validator: (v) => DATE_RE.test(v), message: 'endDate must be YYYY-MM-DD' },
    },
    totalBudgetCents: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD', maxlength: 3 },
    maxParticipants: { type: Number, default: 8, min: 2, max: 50 },
    inviteCode: { type: String, required: true, unique: true, index: true },
    leaderUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    members: { type: [MemberSchema], default: [] },
    status: { type: String, enum: TRIP_STATUS, default: 'drafting', index: true },
    // Leader room switch that freezes all writes (moderation control).
    roomLocked: { type: Boolean, default: false },
    budgetMode: { type: String, enum: ['even', 'weighted'], default: 'even' },
    viewPolicy: { type: String, enum: ['open', 'authenticated'], default: 'authenticated' },
    peakConcurrentPlanners: { type: Number, default: 0 },
    planningStartedAt: { type: Date, default: Date.now },
    endedAt: { type: Date, default: null },
    correlationId: { type: String, index: true },
  },
  { timestamps: true }
);

TripSchema.index({ 'members.userId': 1, createdAt: -1 });
TripSchema.index({ destinationSlug: 1, startDate: -1 });

TripSchema.methods.memberFor = function memberFor(userId) {
  const id = String(userId);
  return this.members.find((m) => String(m.userId) === id) || null;
};

TripSchema.methods.roleFor = function roleFor(user) {
  const id = String(user && user._id ? user._id : user);
  if (user && user.globalRole === 'admin') return 'admin';
  if (String(this.leaderUserId) === id) return 'leader';
  const member = this.memberFor(id);
  if (member) return member.role;
  return null;
};

TripSchema.methods.toPublicJSON = function toPublicJSON() {
  const obj = this.toObject({ virtuals: false });
  obj.tripId = String(this._id);
  delete obj._id;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('Trip', TripSchema);
module.exports.TRIP_ROLES = TRIP_ROLES;
module.exports.TRIP_STATUS = TRIP_STATUS;
