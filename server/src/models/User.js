'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const DIETARY_TAGS = [
  'vegetarian',
  'vegan',
  'halal',
  'gluten-free',
  'nut-free',
  'dairy-free',
  'pescatarian',
];

const CATEGORIES = ['lodging', 'food', 'activity', 'transport', 'other'];
const GLOBAL_ROLES = ['viewer', 'planner', 'admin'];

const UserSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: { type: String, required: true, select: false },
    displayName: { type: String, required: true, trim: true, maxlength: 60 },
    globalRole: { type: String, enum: GLOBAL_ROLES, default: 'planner', index: true },
    dietaryTags: [{ type: String, enum: DIETARY_TAGS }],
    preferences: {
      maxPerPersonBudgetCents: { type: Number, default: 150000, min: 0 },
      categoryCeilings: {
        lodging: { type: Number, default: 80000 },
        food: { type: Number, default: 30000 },
        activity: { type: Number, default: 25000 },
        transport: { type: Number, default: 15000 },
        other: { type: Number, default: 10000 },
      },
      favoriteCategories: [{ type: String, enum: CATEGORIES }],
    },
    // Bumped on logout-all / password change, which invalidates issued refresh tokens.
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.userId = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        delete ret.passwordHash;
        return ret;
      },
    },
  }
);

UserSchema.methods.setPassword = async function setPassword(plain) {
  this.passwordHash = await bcrypt.hash(plain, 10);
};

UserSchema.methods.verifyPassword = function verifyPassword(plain) {
  if (!this.passwordHash) return Promise.resolve(false);
  return bcrypt.compare(plain, this.passwordHash);
};

UserSchema.statics.publicFields = 'email displayName globalRole dietaryTags preferences lastLoginAt';

module.exports = mongoose.model('User', UserSchema);
module.exports.DIETARY_TAGS = DIETARY_TAGS;
module.exports.CATEGORIES = CATEGORIES;
module.exports.GLOBAL_ROLES = GLOBAL_ROLES;
