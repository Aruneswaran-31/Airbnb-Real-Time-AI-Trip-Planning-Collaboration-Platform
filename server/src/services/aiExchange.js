'use strict';

/**
 * One AI Concierge exchange: resolve the anchor, ask the engine, persist the
 * answer as a chat message, and write the analytics event. Shared by the REST
 * route and the socket gateway so both produce identical state.
 */

const ItineraryItem = require('../models/ItineraryItem');
const ChatMessage = require('../models/ChatMessage');
const { askConcierge } = require('./concierge');
const boardService = require('./boardService');
const logger = require('../logger');

async function performAiAsk({ trip, user, question, anchorItemId, usersById }) {
  const anchorItem = anchorItemId ? await ItineraryItem.findOne({ _id: anchorItemId, tripId: trip._id }) : null;

  const usersMap = usersById || (await boardService.loadMembers(trip)).usersById;

  await boardService.logEvent(trip._id, 'ai.asked', {
    userId: user._id,
    payload: { question, anchorItemId: anchorItemId || null },
  });

  const result = await askConcierge({
    trip,
    user,
    question,
    anchorItem: anchorItem ? anchorItem.toObject() : null,
    members: trip.members,
    usersById: usersMap,
  });

  const message = await ChatMessage.create({
    tripId: trip._id,
    userId: null,
    authorName: 'AI Concierge',
    msgType: 'ai_answer',
    body: `${user.displayName}: ${question}\n\n${result.answer}`,
    meta: {
      questionId: result.questionId,
      suggestedVenueId: result.suggestedVenueId,
      sourceEvents: result.sourceEvents,
      engine: result.engine,
      constraints: result.constraints,
      latencyMs: result.latencyMs,
    },
  });

  await boardService.logEvent(trip._id, 'ai.answered', {
    userId: user._id,
    venueId: result.suggestedVenueId,
    payload: {
      questionId: result.questionId,
      engine: result.engine,
      latencyMs: result.latencyMs,
      sourceEvents: result.sourceEvents,
    },
  });

  if (result.suggestedVenueId) {
    await boardService.recordInteraction({
      user,
      trip,
      venueId: result.suggestedVenueId,
      category: result.suggestedVenue?.category || 'activity',
      event: 'ai_suggested',
      score: 0.8,
    });
  }

  logger.info('ai.concierge.answered', {
    tripId: String(trip._id),
    userId: String(user._id),
    engine: result.engine,
    latencyMs: result.latencyMs,
    suggestedVenueId: result.suggestedVenueId,
  });

  return { result, message };
}

module.exports = { performAiAsk };
