'use strict';

/**
 * Budget engine. All arithmetic is performed on integer cents and every split
 * distributes remainders deterministically (largest-remainder method), so the
 * sum of per-person shares always equals the group total exactly.
 *
 * This module is deliberately free of database/HTTP concerns so it can be
 * unit-tested against manually verified ground truth.
 */

/** Split `totalCents` across `weights` so the parts sum exactly to the total. */
function allocate(totalCents, weights) {
  const total = Math.round(totalCents);
  const n = weights.length;
  if (n === 0) return [];

  let effective = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  let weightSum = effective.reduce((a, b) => a + b, 0);
  if (weightSum <= 0) {
    effective = effective.map(() => 1);
    weightSum = n;
  }

  const exact = effective.map((w) => (total * w) / weightSum);
  const parts = exact.map((v) => Math.floor(v));
  const assigned = parts.reduce((a, b) => a + b, 0);
  let remainder = total - assigned;

  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  let k = 0;
  while (remainder > 0) {
    parts[order[k % n].i] += 1;
    remainder -= 1;
    k += 1;
  }
  return parts;
}

function splitEven(totalCents, count) {
  return allocate(totalCents, new Array(count).fill(1));
}

function splitWeighted(totalCents, weights) {
  return allocate(totalCents, weights);
}

/**
 * Compute the full budget picture for a trip.
 *
 * @param {object} input
 * @param {object} input.trip        trip document/plain object (totalBudgetCents, budgetMode, currency)
 * @param {Array}  input.members     [{ userId, name, role, weight, ceilings: { overallCents, categories } }]
 * @param {Array}  input.items       itinerary items [{ itemId, title, category, pricePerPersonCents, lifecycleStage }]
 */
function computeBudget({ trip, members = [], items = [] }) {
  const travelers = members.length;
  const participantCount = travelers || 1;
  const currency = trip.currency || 'USD';

  const categories = {};
  let perPersonSubtotal = 0;

  const lineItems = items.map((item) => {
    const price = Math.round(item.pricePerPersonCents || 0);
    perPersonSubtotal += price;
    const key = item.category || 'other';
    categories[key] = categories[key] || { perPersonCents: 0, groupCents: 0, items: 0 };
    categories[key].perPersonCents += price;
    categories[key].items += 1;
    return {
      itemId: String(item.itemId || item._id),
      title: item.title,
      category: key,
      pricePerPersonCents: price,
      lifecycleStage: item.lifecycleStage,
      groupCents: price * participantCount,
    };
  });

  for (const key of Object.keys(categories)) {
    categories[key].groupCents = categories[key].perPersonCents * participantCount;
  }

  const groupTotal = perPersonSubtotal * participantCount;
  const weights = trip.budgetMode === 'weighted' ? members.map((m) => m.weight || 1) : new Array(travelers).fill(1);
  const shares = allocate(groupTotal, weights);

  const memberRows = members.map((member, index) => {
    const share = shares[index] || 0;
    const ceilings = member.ceilings || {};
    const overallCeiling = Number.isFinite(ceilings.overallCents) ? ceilings.overallCents : null;
    const categoryBreaches = [];
    if (ceilings.categories) {
      for (const [key, ceiling] of Object.entries(ceilings.categories)) {
        const spent = categories[key] ? categories[key].perPersonCents : 0;
        if (Number.isFinite(ceiling) && spent > ceiling) {
          categoryBreaches.push({ category: key, ceilingCents: ceiling, spentCents: spent, overByCents: spent - ceiling });
        }
      }
    }
    return {
      userId: String(member.userId),
      name: member.name || 'Traveler',
      role: member.role || 'planner',
      weight: member.weight || 1,
      shareCents: share,
      overallCeilingCents: overallCeiling,
      overCeiling: overallCeiling !== null ? share > overallCeiling : false,
      overByCents: overallCeiling !== null && share > overallCeiling ? share - overallCeiling : 0,
      categoryBreaches,
    };
  });

  const totalBudget = Math.round(trip.totalBudgetCents || 0);
  const remaining = totalBudget - groupTotal;

  return {
    currency,
    mode: trip.budgetMode || 'even',
    travelers,
    participantCount,
    totalBudgetCents: totalBudget,
    perPersonSubtotalCents: perPersonSubtotal,
    groupTotalCents: groupTotal,
    remainingCents: remaining,
    utilizationPct: totalBudget > 0 ? Math.round((groupTotal / totalBudget) * 1000) / 10 : 0,
    isOverBudget: groupTotal > totalBudget,
    categories,
    members: memberRows,
    items: lineItems,
    // Invariant the tests assert on: shares always reconcile to the group total.
    sharesSumCents: shares.reduce((a, b) => a + b, 0),
  };
}

/**
 * Re-derive spend from the append-only event log so analytics can be proven to
 * reconcile with the same numbers the live budget panel shows.
 */
function replaySpendFromEvents(events, { travelers }) {
  const count = travelers || 1;
  const state = new Map();
  let perPerson = 0;

  for (const event of [...events].sort((a, b) => new Date(a.ts) - new Date(b.ts))) {
    if (event.type === 'item.pinned') {
      const price = Math.round(event.pricePerPersonCents || 0);
      const itemId = String(event.itemId || event.payload?.itemId || '');
      if (!state.has(itemId)) {
        state.set(itemId, price);
        perPerson += price;
      }
    } else if (event.type === 'item.removed') {
      const itemId = String(event.itemId || event.payload?.itemId || '');
      if (state.has(itemId)) {
        perPerson -= state.get(itemId);
        state.delete(itemId);
      }
    }
  }

  return { perPersonSubtotalCents: perPerson, groupTotalCents: perPerson * count, itemCount: state.size };
}

module.exports = { allocate, splitEven, splitWeighted, computeBudget, replaySpendFromEvents };
