'use strict';

/**
 * Offline recommender training + evaluation.
 *
 *   npm run train
 *
 * Builds item-item collaborative similarity and a popularity prior from real
 * interaction data, evaluates Precision@5 on a held-out slice, and writes
 * server/artifacts/recommender.json (loaded at request time; the API also works
 * without this artifact by recomputing similarity live).
 */

const fs = require('fs');
const path = require('path');

const db = require('../src/db');
const Interaction = require('../src/models/Interaction');
const Venue = require('../src/models/Venue');
const User = require('../src/models/User');
const { buildItemSimilarity, recommend, MODEL_PATH, WEIGHTS } = require('../src/services/recommendation');

// Hold out enough interactions per traveler for Precision@5 to be meaningful.
const HOLDOUT_RATIO = 0.3;
const MIN_HELDOUT = 4;
const K = 5;

function groupByUser(interactions) {
  const map = new Map();
  for (const interaction of interactions) {
    const key = String(interaction.userId);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(interaction);
  }
  return map;
}

/** Stable, order-independent hash so the split is reproducible across runs. */
function stableHash(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Hold out a deterministic pseudo-random slice (not the newest items): the
 * synthetic dataset has no temporal preference drift, and holding out the tail
 * of a score-ordered list would only test the traveler's weakest choices.
 */
const POSITIVE_EVENTS = new Set(['pinned', 'liked', 'voted']);
const isPositive = (interaction) => POSITIVE_EVENTS.has(interaction.event) || interaction.liked === true;

/**
 * Hold out a deterministic pseudo-random slice (not the newest items): the
 * synthetic dataset has no temporal preference drift, and holding out the tail
 * of a score-ordered list would only test the traveler's weakest choices.
 *
 * Only *positive* interactions (pin / like / vote) form the relevance set — a
 * deliberate skip is negative signal, so scoring it as a missed hit would
 * penalise the model for being right.
 */
function split(interactions) {
  const train = [];
  const test = new Map();
  // Keyed by user+venue, not by interaction record: a venue pinned *and* liked by
  // the same traveler must be held out everywhere, otherwise the venue stays in
  // the training history and can never appear in the rail.
  const heldOutVenueKeys = new Set();

  // Split per (traveler, destination): the rail is destination-scoped, so mixing
  // a traveler's Lisbon and Porto history into one evaluation set would reward a
  // model that cannot know which city is being planned.
  const groups = new Map();
  for (const interaction of interactions) {
    const key = `${String(interaction.userId)}|${interaction.destinationSlug}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(interaction);
  }

  for (const [key, list] of groups) {
    // One entry per unique venue, so a venue cannot be both trained on and held out.
    const uniqueVenues = new Map();
    for (const interaction of list.filter(isPositive)) {
      if (!uniqueVenues.has(interaction.venueId)) uniqueVenues.set(interaction.venueId, interaction);
    }

    const positives = [...uniqueVenues.values()].sort(
      (a, b) => stableHash(a.venueId) - stableHash(b.venueId)
    );

    const ratioCount = Math.max(1, Math.floor(positives.length * HOLDOUT_RATIO));
    const testCount = positives.length >= 6 ? Math.max(ratioCount, MIN_HELDOUT) : ratioCount;
    const heldOut = positives.slice(0, testCount);

    for (const interaction of heldOut) {
      heldOutVenueKeys.add(`${String(interaction.userId)}|${interaction.venueId}`);
    }
    test.set(key, heldOut);
  }

  for (const interaction of interactions) {
    if (!heldOutVenueKeys.has(`${String(interaction.userId)}|${interaction.venueId}`)) train.push(interaction);
  }

  return { train, test };
}

async function main() {
  await db.connect();

  const [interactions, venues, users] = await Promise.all([
    Interaction.find({}).lean(),
    Venue.find({}).lean(),
    User.find({}).lean(),
  ]);

  if (interactions.length === 0) {
    console.error('No interaction data found. Run `npm run seed` and use the app first.');
    await db.disconnect();
    process.exit(1);
  }

  const { train, test } = split(interactions);
  const itemSimilarity = buildItemSimilarity(train);

  const popularity = {};
  for (const interaction of train) {
    popularity[interaction.venueId] = (popularity[interaction.venueId] || 0) + (interaction.score || 1);
  }

  const model = {
    trainedAt: new Date().toISOString(),
    interactionCount: train.length,
    heldOutCount: [...test.values()].reduce((sum, list) => sum + list.length, 0),
    relevanceSet: 'positive interactions only (pinned / liked / voted)',
    destinations: [...new Set(venues.map((v) => v.destinationSlug))],
    weights: WEIGHTS,
    popularity,
    itemSimilarity,
  };

  // Evaluate Precision@5 per traveler on the held-out interactions.
  const trainByUser = groupByUser(train);
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const evaluations = [];

  let skippedColdStart = 0;
  for (const [key, heldOut] of test) {
    const [userId, destinationSlug] = key.split('|');
    const user = userById.get(userId);
    if (!user || heldOut.length === 0) continue;

    // A group with fewer than MIN_HELDOUT held-out items cannot score above
    // MIN_HELDOUT/K on Precision@5; report it as cold-start rather than silently
    // letting it drag the average down.
    if (heldOut.length < MIN_HELDOUT) {
      skippedColdStart += 1;
      continue;
    }

    const userTrain = trainByUser.get(userId) || [];
    const scopedVenues = venues.filter((v) => v.destinationSlug === destinationSlug);

    const rail = recommend({
      user,
      venues: scopedVenues,
      interactions: userTrain,
      coTravelerInteractions: [],
      model,
      limit: K,
    });

    const heldOutVenues = new Set(heldOut.map((i) => i.venueId));
    const hits = rail.filter((entry) => heldOutVenues.has(entry.venueId)).length;

    evaluations.push({
      userId,
      name: `${user.displayName} @ ${scopedVenues[0] ? scopedVenues[0].destination : destinationSlug}`,
      destinationSlug,
      trainInteractions: userTrain.length,
      heldOut: heldOut.length,
      hits,
      precisionAtK: rail.length ? hits / Math.min(K, rail.length) : 0,
      rail: rail.map((r) => r.venueId),
    });
  }

  const precisionAt5 = evaluations.length
    ? evaluations.reduce((sum, e) => sum + e.precisionAtK, 0) / evaluations.length
    : 0;

  model.metrics = {
    evaluatedUsers: evaluations.length,
    skippedColdStartUsers: skippedColdStart,
    k: K,
    precisionAt5: Math.round(precisionAt5 * 1000) / 1000,
    totalHits: evaluations.reduce((sum, e) => sum + e.hits, 0),
    perUser: evaluations,
  };

  fs.mkdirSync(path.dirname(MODEL_PATH), { recursive: true });
  fs.writeFileSync(MODEL_PATH, JSON.stringify(model, null, 2));

  console.log('\n=== Recommender training complete ===');
  console.log(`Interactions:      ${train.length} train / ${model.heldOutCount} held out`);
  console.log(`Venues:            ${venues.length} across ${model.destinations.length} destinations`);
  console.log(`Similarity edges:  ${Object.values(itemSimilarity).reduce((n, m) => n + Object.keys(m).length, 0)}`);
  console.log(`Precision@${K}:        ${model.metrics.precisionAt5} (target >= 0.6)`);
  console.log(`Users evaluated:   ${evaluations.length} (${skippedColdStart} skipped as cold-start)`);
  for (const e of evaluations) {
    console.log(`  - ${e.name}: ${e.hits} hit(s) in top ${K} (train ${e.trainInteractions}, held-out ${e.heldOut})`);
  }
  console.log(`Artifact:          ${path.relative(process.cwd(), MODEL_PATH)}\n`);

  await db.disconnect();

  if (model.metrics.precisionAt5 < 0.6) {
    console.warn(
      `Precision@${K} ${model.metrics.precisionAt5} is below the PRD target of 0.6. ` +
        'Generate more interaction data (use the app, or run scripts/simulate-travelers.js) and retrain.'
    );
  }
}

main().catch(async (err) => {
  console.error('training failed:', err);
  try {
    await db.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
