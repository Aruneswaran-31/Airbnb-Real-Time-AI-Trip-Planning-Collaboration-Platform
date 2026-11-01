'use strict';

/**
 * Conflict detector: schedule overlaps, group budget breaches and venues pinned
 * outside their operating hours. Pure functions over the current board so the
 * same logic runs on REST writes, socket writes and the periodic sweeper.
 */

const config = require('../config');
const { overlaps, isWithinHours } = require('../utils/time');
const { computeBudget } = require('./budget');

function conflictKey(conflict) {
  return [conflict.conflictType, ...conflict.itemIds.map(String).sort(), conflict.details.memberId || ''].join(':');
}

function detectConflicts({ trip, items, members = [], usersById = {} }) {
  const conflicts = [];
  const active = items.filter((item) => !item.archived);

  // 1. Time overlaps within a day.
  const byDay = new Map();
  for (const item of active) {
    if (!byDay.has(item.dayIndex)) byDay.set(item.dayIndex, []);
    byDay.get(item.dayIndex).push(item);
  }

  for (const [dayIndex, dayItems] of byDay) {
    for (let i = 0; i < dayItems.length; i += 1) {
      for (let j = i + 1; j < dayItems.length; j += 1) {
        const a = dayItems[i];
        const b = dayItems[j];
        if (a.lifecycleStage === 'locked' && b.lifecycleStage === 'locked') continue;
        if (overlaps(a, b)) {
          conflicts.push({
            conflictType: 'overlap',
            severity: 'warning',
            itemIds: [String(a._id || a.itemId), String(b._id || b.itemId)],
            details: {
              dayIndex,
              message: `"${a.title}" (${a.startTime}-${a.endTime}) overlaps "${b.title}" (${b.startTime}-${b.endTime})`,
              slots: [
                { title: a.title, startTime: a.startTime, endTime: a.endTime },
                { title: b.title, startTime: b.startTime, endTime: b.endTime },
              ],
            },
          });
        }
      }
    }
  }

  // 2. Group budget breach + per-traveler ceiling breaches.
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
    items: active.map((item) => ({ ...item, itemId: String(item._id || item.itemId) })),
  });

  if (budget.isOverBudget) {
    conflicts.push({
      conflictType: 'budgetBreach',
      severity: 'critical',
      itemIds: active.map((item) => String(item._id || item.itemId)),
      details: {
        scope: 'group',
        message: `Group spend ${(budget.groupTotalCents / 100).toFixed(0)} ${trip.currency} exceeds the ${(budget.totalBudgetCents / 100).toFixed(0)} ${trip.currency} budget by ${(Math.abs(budget.remainingCents) / 100).toFixed(0)}`,
        groupTotalCents: budget.groupTotalCents,
        totalBudgetCents: budget.totalBudgetCents,
        overByCents: -budget.remainingCents,
      },
    });
  }

  for (const member of budget.members) {
    if (member.overCeiling) {
      conflicts.push({
        conflictType: 'budgetBreach',
        severity: 'warning',
        itemIds: [],
        details: {
          scope: 'traveler',
          memberId: member.userId,
          memberName: member.name,
          message: `${member.name}'s share ${(member.shareCents / 100).toFixed(0)} ${trip.currency} exceeds their declared ceiling of ${(member.overallCeilingCents / 100).toFixed(0)} ${trip.currency}`,
          shareCents: member.shareCents,
          ceilingCents: member.overallCeilingCents,
          overByCents: member.overByCents,
        },
      });
    }
  }

  // 3. Pinned outside the venue's operating hours.
  for (const item of active) {
    const hours = item.venueSnapshot && item.venueSnapshot.hours;
    if (!hours || !hours.open || !hours.close) continue;
    if (!isWithinHours(hours, item.startTime, item.endTime, 0)) {
      conflicts.push({
        conflictType: 'hoursViolation',
        severity: 'warning',
        itemIds: [String(item._id || item.itemId)],
        details: {
          message: `"${item.title}" is pinned ${item.startTime}-${item.endTime} but the venue is open ${hours.open}-${hours.close}`,
          hours,
          slot: { startTime: item.startTime, endTime: item.endTime },
        },
      });
    }
  }

  return conflicts.map((conflict) => ({
    ...conflict,
    conflictKey: conflictKey(conflict),
    bufferMinutes: config.constraints.defaultHoursBufferMinutes,
  }));
}

function activeKeys(conflicts) {
  return new Set(conflicts.map((c) => c.conflictKey));
}

/** Diff two conflict snapshots: which are newly raised, which got resolved. */
function diffConflicts(previousKeys, nextConflicts) {
  const next = activeKeys(nextConflicts);
  const raised = nextConflicts.filter((c) => !previousKeys.has(c.conflictKey));
  const resolved = [...previousKeys].filter((key) => !next.has(key));
  return { raised, resolved, next };
}

module.exports = { detectConflicts, diffConflicts, activeKeys, conflictKey };
