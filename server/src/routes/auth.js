'use strict';

const express = require('express');
const { z } = require('zod');

const User = require('../models/User');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate } = require('../middleware/validate');
const { writeLimiter } = require('../middleware/rateLimit');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  requireAuth,
} = require('../middleware/auth');
const { sanitizeText } = require('../utils/sanitize');

const router = express.Router();

const registerSchema = z.object({
  email: z.string().email().max(160),
  password: z.string().min(8).max(128),
  displayName: z.string().min(2).max(60),
  dietaryTags: z
    .array(z.enum(['vegetarian', 'vegan', 'halal', 'gluten-free', 'nut-free', 'dairy-free', 'pescatarian']))
    .optional(),
  globalRole: z.enum(['viewer', 'planner']).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function authPayload(user) {
  return {
    accessToken: signAccessToken(user),
    refreshToken: signRefreshToken(user),
    user: user.toJSON(),
    expiresInSeconds: 45 * 60,
  };
}

router.post(
  '/register',
  writeLimiter,
  validate({ body: registerSchema }),
  asyncHandler(async (req, res) => {
    const { email, password, displayName, dietaryTags, globalRole } = req.body;
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) throw ApiError.conflict('email_taken', 'An account with that email already exists');

    const user = new User({
      email: email.toLowerCase(),
      displayName: sanitizeText(displayName, { maxLength: 60 }),
      dietaryTags: dietaryTags || [],
      globalRole: globalRole || 'planner',
      lastLoginAt: new Date(),
    });
    await user.setPassword(password);
    await user.save();

    res.status(201).json(authPayload(user));
  })
);

router.post(
  '/login',
  writeLimiter,
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const user = await User.findOne({ email: req.body.email.toLowerCase() }).select('+passwordHash');
    const ok = user ? await user.verifyPassword(req.body.password) : false;
    if (!ok) throw ApiError.unauthorized('invalid_credentials', 'Email or password is incorrect');

    user.lastLoginAt = new Date();
    await user.save();

    res.json(authPayload(user));
  })
);

router.post(
  '/refresh',
  validate({ body: z.object({ refreshToken: z.string().min(10) }) }),
  asyncHandler(async (req, res) => {
    const claims = verifyRefreshToken(req.body.refreshToken);
    const user = await User.findById(claims.sub);
    if (!user) throw ApiError.unauthorized('unknown_user', 'User no longer exists');
    if ((user.tokenVersion || 0) !== claims.tv) {
      throw ApiError.unauthorized('token_revoked', 'Refresh token was revoked');
    }
    res.json(authPayload(user));
  })
);

router.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    req.user.tokenVersion = (req.user.tokenVersion || 0) + 1;
    await req.user.save();
    res.json({ revoked: true });
  })
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: req.user.toJSON() });
  })
);

router.patch(
  '/me',
  requireAuth,
  validate({
    body: z.object({
      displayName: z.string().min(2).max(60).optional(),
      dietaryTags: z.array(z.string()).optional(),
      preferences: z
        .object({
          maxPerPersonBudgetCents: z.number().min(0).max(100000000).optional(),
          categoryCeilings: z.record(z.string(), z.number().min(0)).optional(),
          favoriteCategories: z.array(z.enum(['lodging', 'food', 'activity', 'transport', 'other'])).optional(),
        })
        .optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { displayName, dietaryTags, preferences } = req.body;
    if (displayName) req.user.displayName = sanitizeText(displayName, { maxLength: 60 });
    if (dietaryTags) {
      const vocabulary = ['vegetarian', 'vegan', 'halal', 'gluten-free', 'nut-free', 'dairy-free', 'pescatarian'];
      const invalid = dietaryTags.filter((tag) => !vocabulary.includes(tag));
      if (invalid.length) {
        throw ApiError.badRequest('invalid_dietary_tags', `Unknown dietary tags: ${invalid.join(', ')}`);
      }
      req.user.dietaryTags = dietaryTags;
    }
    if (preferences) {
      req.user.preferences = {
        ...req.user.preferences.toObject?.(),
        ...req.user.preferences,
        ...preferences,
      };
    }
    await req.user.save();
    res.json({ user: req.user.toJSON() });
  })
);

module.exports = router;
