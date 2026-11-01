'use strict';

const { computeBudget, replaySpendFromEvents } = require('./budget');

/** Peak concurrent planners, replayed from presence events. */
function peakConcurrency(events) {
  let current = 0;
  let peak = 0;
  const ordered = [...events].sort((a, b) => new Date(a.ts) - new Date(b.ts));
  for (const event of ordered) {
    if (event.type === 'presence.joined') {
      current += 1;
      peak = Math.max(peak, current);
    } else if (event.type === 'presence.left') {
      current = Math.max(0, current - 1);
    }
  }
  return peak;
}

/**
 * Build session analytics. Every number is derived from the append-only event
 * log (or the live board for the budget picture), and the budget is reconciled
 * against the event replay so analytics cannot silently drift.
 */
function buildSessionAnalytics({ trip, items, events, members = [], usersById = {}, now = new Date() }) {
  const budget = computeBudget({
    trip,
    members: members.map((m) => {
      const user = usersById[String(m.userId)] || {};
      return {
        userId: m.userId,
        name: user.displayName,
        role: m.role,
        weight: m.weight,
        ceilings: {
          overallCents: user.preferences?.maxPerPersonBudgetCents,
          categories: user.preferences?.categoryCeilings,
        },
      };
    }),
    items: items.map((item) => ({ ...item, itemId: String(item._id || item.itemId) })),
  });

  const count = (type) => events.filter((e) => e.type === type).length;
  const startedAt = new Date(trip.planningStartedAt || trip.createdAt || now);
  const endedAt = trip.endedAt ? new Date(trip.endedAt) : now;

  const replay = replaySpendFromEvents(events, { travelers: members.length });
  const reconciliation = {
    eventLogPerPersonSubtotalCents: replay.perPersonSubtotalCents,
    liveBoardPerPersonSubtotalCents: budget.perPersonSubtotalCents,
    deltaCents: budget.perPersonSubtotalCents - replay.perPersonSubtotalCents,
    matches: budget.perPersonSubtotalCents === replay.perPersonSubtotalCents,
  };

  return {
    tripId: String(trip._id),
    destination: trip.destination,
    status: trip.status,
    planningDurationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
    planningStartedAt: startedAt.toISOString(),
    endedAt: trip.endedAt ? new Date(trip.endedAt).toISOString() : null,
    participants: members.length,
    peakConcurrentPlanners: peakConcurrency(events),
    aiQuestionsAsked: count('ai.asked'),
    aiAnswersGiven: count('ai.answered'),
    conflictsFlagged: count('conflict.flagged'),
    conflictsResolved: count('conflict.resolved'),
    votesOpened: count('vote.opened'),
    votesResolved: count('vote.resolved'),
    chatMessages: count('chat.message'),
    itemsPinned: count('item.pinned'),
    itemsMoved: count('item.moved'),
    itemsRemoved: count('item.removed'),
    itemsLocked: count('item.locked'),
    budget,
    reconciliation,
    finalPerPersonBreakdown: budget.members.map((m) => ({
      userId: m.userId,
      name: m.name,
      shareCents: m.shareCents,
      overCeiling: m.overCeiling,
    })),
  };
}

module.exports = { buildSessionAnalytics, peakConcurrency };
