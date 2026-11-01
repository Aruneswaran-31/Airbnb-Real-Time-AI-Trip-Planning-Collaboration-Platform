'use strict';

const express = require('express');
const { z } = require('zod');

const ChatMessage = require('../models/ChatMessage');
const { asyncHandler } = require('../middleware/errors');
const { validate } = require('../middleware/validate');
const { loadTrip, requireTripRole } = require('../middleware/auth');
const { aiLimiter } = require('../middleware/rateLimit');
const { groupDietaryTags, perPersonTripBudget } = require('../services/concierge');
const { performAiAsk } = require('../services/aiExchange');
const boardService = require('../services/boardService');
const hub = require('../realtime/hub');
const config = require('../config');

const router = express.Router({ mergeParams: true });

router.use(loadTrip);

/**
 * POST /api/v1/trips/:id/ai/ask
 * Constraint-bound question to the AI Travel Concierge.
 */
router.post(
  '/ask',
  aiLimiter,
  requireTripRole('planner'),
  validate({
    body: z.object({
      question: z.string().min(3).max(500),
      anchorItemId: z.string().min(3).nullish(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { result, message } = await performAiAsk({
      trip: req.trip,
      user: req.user,
      question: req.body.question,
      anchorItemId: req.body.anchorItemId,
    });

    hub.emitToTrip(req.trip._id, 'trip.chat.message', {
      message: { ...message.toPublicJSON(), tripId: String(req.trip._id), userId: null },
    });
    hub.emitToTrip(req.trip._id, 'trip.ai.suggestion', {
      questionId: result.questionId,
      userId: String(req.user._id),
      question: req.body.question,
      answer: result.answer,
      suggestedVenueId: result.suggestedVenueId,
      sourceEvents: result.sourceEvents,
      engine: result.engine,
      latencyMs: result.latencyMs,
      sources: result.sources,
      constraints: result.constraints,
      candidateStats: result.candidateStats,
      rejected: result.rejected,
      generatedAt: result.generatedAt,
    });

    res.json({ ...result, messageId: String(message._id) });
  })
);

/** Concierge transcript for the room. */
router.get(
  '/history',
  asyncHandler(async (req, res) => {
    const messages = await ChatMessage.find({ tripId: req.trip._id, msgType: 'ai_answer' })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    res.json({ messages: messages.reverse().map((m) => ({ ...m, messageId: String(m._id), _id: undefined })) });
  })
);

/** Constraint preview: what the concierge filters on for this trip. */
router.get(
  '/constraints',
  asyncHandler(async (req, res) => {
    const { usersById } = await boardService.loadMembers(req.trip);
    res.json({
      groupDietaryTags: groupDietaryTags(req.trip.members, usersById),
      perPersonBudgetCents: perPersonTripBudget(req.trip, req.trip.members.length),
      bufferMinutes: config.constraints.defaultHoursBufferMinutes,
      defaultRadiusKm: config.constraints.defaultRadiusKm,
      rankingWeights: config.constraints.weights,
      engine: config.ai.apiKey ? `llm:${config.ai.model}` : 'grounded-template',
    });
  })
);

module.exports = router;
