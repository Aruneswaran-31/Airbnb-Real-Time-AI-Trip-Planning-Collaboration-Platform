'use strict';

/**
 * Seeds a complete, demo-ready dataset:
 *  - authored venue catalogs (Lisbon + Porto)
 *  - four demo accounts covering all four roles
 *  - one live Trip Room with a pinned itinerary, chat history, presence and an
 *    intentional schedule overlap so the conflict detector has something to show
 *  - one completed trip with interactions + events so dashboard analytics and the
 *    recommendation rail have real history
 *
 * Usage: npm run seed            (add --reset to wipe first)
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const config = require('./config');
const { connect, disconnect } = require('./db');
const { validateVenuePayload } = require('./services/datasetValidator');
const { generateInviteCode, shortId } = require('./utils/ids');
const { slugify } = require('./utils/sanitize');

const User = require('./models/User');
const Trip = require('./models/Trip');
const ItineraryItem = require('./models/ItineraryItem');
const Vote = require('./models/Vote');
const ChatMessage = require('./models/ChatMessage');
const Venue = require('./models/Venue');
const Interaction = require('./models/Interaction');
const Event = require('./models/Event');

const DEMO_PASSWORD = 'Demo1234!';

function loadVenues() {
  const files = ['lisbon.venues.json', 'porto.venues.json'];
  const all = [];
  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', file), 'utf8'));
    const result = validateVenuePayload(raw);
    if (!result.ok) {
      const detail = result.errors.map((e) => `#${e.index} ${e.field}: ${e.message}`).join('\n');
      throw new Error(`Venue dataset ${file} failed validation:\n${detail}`);
    }
    all.push(...result.venues.map((venue) => ({ ...venue, datasetVersion: '1.0.0' })));
  }
  return all;
}

async function seedVenues() {
  const venues = loadVenues();
  await Venue.deleteMany({});
  await Venue.insertMany(venues);
  const byId = new Map(venues.map((v) => [v.venueId, v]));
  console.log(`seeded ${venues.length} venues across ${new Set(venues.map((v) => v.destination)).size} destinations`);
  return byId;
}

async function seedUsers() {
  await User.deleteMany({});
  const specs = [
    {
      email: 'arun@demo.dev',
      displayName: 'Arun (Trip Leader)',
      globalRole: 'planner',
      dietaryTags: ['vegan', 'vegetarian'],
      preferences: {
        maxPerPersonBudgetCents: 120000,
        categoryCeilings: { lodging: 80000, food: 30000, activity: 25000, transport: 15000, other: 10000 },
        favoriteCategories: ['food', 'activity'],
      },
    },
    {
      email: 'maya@demo.dev',
      displayName: 'Maya',
      globalRole: 'planner',
      dietaryTags: ['vegetarian'],
      preferences: {
        maxPerPersonBudgetCents: 90000,
        categoryCeilings: { lodging: 60000, food: 25000, activity: 20000, transport: 12000, other: 8000 },
        favoriteCategories: ['activity', 'food'],
      },
    },
    {
      email: 'leo@demo.dev',
      displayName: 'Leo (Viewer)',
      globalRole: 'viewer',
      dietaryTags: [],
      preferences: {
        maxPerPersonBudgetCents: 150000,
        favoriteCategories: ['activity'],
      },
    },
    {
      email: 'admin@demo.dev',
      displayName: 'Dataset Admin',
      globalRole: 'admin',
      dietaryTags: [],
      preferences: { maxPerPersonBudgetCents: 200000, favoriteCategories: [] },
    },
  ];

  const users = {};
  for (const spec of specs) {
    const user = new User(spec);
    await user.setPassword(DEMO_PASSWORD);
    user.lastLoginAt = new Date();
    await user.save();
    users[spec.email.split('@')[0]] = user;
  }
  console.log(`seeded ${Object.keys(users).length} demo users (password: ${DEMO_PASSWORD})`);
  return users;
}

function venueItem(venue, { tripId, dayIndex, startTime, endTime, pinnedBy, stage = 'drafting' }) {
  return {
    tripId,
    venueId: venue.venueId,
    title: venue.name,
    category: venue.category,
    dayIndex,
    startTime,
    endTime,
    pricePerPersonCents: venue.pricePerPersonCents,
    dietaryTags: venue.dietaryTags,
    coordinates: venue.coordinates,
    lifecycleStage: stage,
    pinnedByUserId: pinnedBy._id,
    pinnedByName: pinnedBy.displayName,
    venueSnapshot: {
      name: venue.name,
      category: venue.category,
      pricePerPersonCents: venue.pricePerPersonCents,
      dietaryTags: venue.dietaryTags,
      hours: venue.hours,
      rating: venue.rating,
      description: venue.description,
      transit: venue.transit,
    },
  };
}

async function seedLiveTrip({ venuesById, users }) {
  await Trip.deleteMany({});
  await ItineraryItem.deleteMany({});
  await Vote.deleteMany({});
  await ChatMessage.deleteMany({});
  await Interaction.deleteMany({});
  await Event.deleteMany({});

  const leader = users.arun;
  const maya = users.maya;
  const leo = users.leo;

  const trip = await Trip.create({
    destination: 'Lisbon, Portugal',
    destinationSlug: slugify('Lisbon, Portugal'),
    coordinates: { lat: 38.7139, lng: -9.1394 },
    startDate: '2026-11-10',
    endDate: '2026-11-13',
    totalBudgetCents: 360000,
    currency: 'USD',
    maxParticipants: 8,
    inviteCode: generateInviteCode(),
    leaderUserId: leader._id,
    members: [
      { userId: leader._id, role: 'leader', weight: 1, joinedAt: new Date(Date.now() - 3 * 3600 * 1000) },
      { userId: maya._id, role: 'planner', weight: 1.2, joinedAt: new Date(Date.now() - 2.5 * 3600 * 1000) },
      { userId: leo._id, role: 'viewer', weight: 1, joinedAt: new Date(Date.now() - 2 * 3600 * 1000) },
    ],
    status: 'drafting',
    budgetMode: 'even',
    correlationId: shortId('cid'),
    planningStartedAt: new Date(Date.now() - 3 * 3600 * 1000),
  });

  const picks = [
    { id: 'v_3440', day: 0, start: '09:00', end: '09:45', by: leader },
    { id: 'v_3392', day: 0, start: '12:00', end: '13:30', by: leader },
    { id: 'v_3410', day: 0, start: '15:00', end: '17:00', by: maya },
    { id: 'v_3417', day: 0, start: '17:00', end: '18:00', by: maya },
    { id: 'v_3412', day: 0, start: '20:00', end: '21:00', by: leader, stage: 'locked' },
    { id: 'v_3415', day: 1, start: '08:00', end: '17:00', by: maya },
    { id: 'v_3397', day: 1, start: '19:00', end: '21:00', by: leader },
    { id: 'v_3395', day: 2, start: '07:00', end: '08:00', by: leader },
    // Deliberate overlap: Tram 28 runs 10:00-12:30 and Sakura lunch starts at 12:00.
    { id: 'v_3413', day: 2, start: '10:00', end: '12:30', by: maya },
    { id: 'v_3400', day: 2, start: '12:00', end: '13:30', by: leader },
    { id: 'v_3430', day: 2, start: '15:00', end: '18:00', by: leader },
    { id: 'v_3391', day: 3, start: '12:00', end: '13:30', by: maya },
    { id: 'v_3414', day: 3, start: '15:00', end: '17:00', by: leo },
    { id: 'v_3443', day: 3, start: '18:00', end: '18:30', by: leader },
  ];

  const items = [];
  for (const pick of picks) {
    const venue = venuesById.get(pick.id);
    if (!venue) throw new Error(`Seed references unknown venue ${pick.id}`);
    items.push(venueItem(venue, { tripId: trip._id, dayIndex: pick.day, startTime: pick.start, endTime: pick.end, pinnedBy: pick.by, stage: pick.stage || 'drafting' }));
  }
  const createdItems = await ItineraryItem.insertMany(items);

  // Chat + AI transcript.
  const messages = [
    { msgType: 'system', authorName: 'System', body: `Trip room created. Invite code ${trip.inviteCode}.`, userId: null },
    { msgType: 'chat', authorName: leadName(leader), userId: leader._id, body: 'Lisbon is booked! Four days, three of us. Budget is $3,600 for the group.' },
    { msgType: 'chat', authorName: 'Maya', userId: maya._id, body: 'I pinned the tile museum and the sunset viewpoint for day one. Bring a jacket for Belém.' },
    { msgType: 'chat', authorName: 'Leo', userId: leo._id, body: 'I cannot pin anything as a viewer, so I am heckling from here.' },
    {
      msgType: 'ai_answer',
      authorName: 'AI Concierge',
      userId: null,
      body:
        'Cantinho Verde is your best fit — about 11 minutes on foot from your 17:00 Miradouro de São Pedro de Alcântara. It runs $18 per person, leaving $7 of headroom under your $25 ceiling. Dietary tags on file: vegan, vegetarian, dairy-free, nut-free. It is open 12:00-23:00, which covers your 18:00-19:30 slot with travel buffer. Grounded in venue records: v_3392.',
      meta: { suggestedVenueId: 'v_3392', sourceEvents: ['v_3392'], engine: 'grounded-template' },
    },
  ];
  const createdMessages = await ChatMessage.insertMany(
    messages.map((m, index) => ({ ...m, tripId: trip._id, tsSeconds: Math.floor(Date.now() / 1000) - (messages.length - index) * 60 }))
  );

  // One resolved contested-slot vote from earlier in the session (board history).
  const switched = createdItems.filter((i) => ['v_3410', 'v_3414'].includes(i.venueId));
  const resolvedVote = await Vote.create({
    tripId: trip._id,
    slot: { dayIndex: 0, startTime: '15:00', endTime: '17:00' },
    candidateItemIds: switched.map((i) => i._id),
    ballots: [
      { userId: leader._id, candidateItemId: switched[0]._id },
      { userId: maya._id, candidateItemId: switched[0]._id },
      { userId: leo._id, candidateItemId: switched[0]._id },
    ],
    openedByUserId: leader._id,
    closesAt: new Date(Date.now() - 40 * 60 * 1000),
    status: 'resolved',
    winningItemId: switched[0]._id,
    resolvedAt: new Date(Date.now() - 39 * 60 * 1000),
    resolution: 'tallied',
  });

  // Event log: item pinning, presence, chat, AI, vote and the intentional overlap.
  const events = [];
  const base = Date.now() - 3 * 3600 * 1000;
  events.push({ tripId: trip._id, type: 'trip.created', userId: leader._id, ts: new Date(base) });
  events.push({ tripId: trip._id, type: 'presence.joined', userId: leader._id, ts: new Date(base + 1000) });
  events.push({ tripId: trip._id, type: 'presence.joined', userId: maya._id, ts: new Date(base + 2000) });
  events.push({ tripId: trip._id, type: 'presence.joined', userId: leo._id, ts: new Date(base + 3000) });

  createdItems.forEach((item, index) => {
    events.push({
      tripId: trip._id,
      type: 'item.pinned',
      userId: item.pinnedByUserId,
      itemId: item._id,
      venueId: item.venueId,
      pricePerPersonCents: item.pricePerPersonCents,
      dayIndex: item.dayIndex,
      ts: new Date(base + 60000 + index * 30000),
    });
  });

  events.push({
    tripId: trip._id,
    type: 'vote.opened',
    userId: leader._id,
    ts: new Date(Date.now() - 45 * 60 * 1000),
    payload: { voteId: String(resolvedVote._id) },
  });
  events.push({
    tripId: trip._id,
    type: 'vote.resolved',
    userId: leader._id,
    ts: new Date(Date.now() - 39 * 60 * 1000),
    payload: { voteId: String(resolvedVote._id), winnerItemId: String(switched[0]._id) },
  });
  events.push({
    tripId: trip._id,
    type: 'conflict.flagged',
    ts: new Date(Date.now() - 30 * 60 * 1000),
    payload: { conflictType: 'overlap', itemIds: [String(createdItems[8]._id), String(createdItems[9]._id)] },
  });
  events.push({ tripId: trip._id, type: 'ai.asked', userId: maya._id, ts: new Date(Date.now() - 25 * 60 * 1000), payload: { question: 'Suggest a dinner spot near our 5 PM sunset under $25/person' } });
  events.push({ tripId: trip._id, type: 'ai.answered', userId: null, ts: new Date(Date.now() - 25 * 60 * 1000 + 120), payload: { suggestedVenueId: 'v_3392', engine: 'grounded-template' } });
  createdMessages.forEach((m, index) => {
    events.push({ tripId: trip._id, type: 'chat.message', userId: m.userId, ts: new Date(base + 120000 + index * 1000), payload: { msgType: m.msgType } });
  });
  await Event.insertMany(events);

  // Interaction data (drives the recommender and the preference profile).
  const interactions = [];
  for (const item of createdItems) {
    interactions.push({
      userId: item.pinnedByUserId,
      tripId: trip._id,
      destinationSlug: trip.destinationSlug,
      venueId: item.venueId,
      category: item.category,
      event: 'pinned',
      score: 1.2,
      createdAt: item.createdAt,
    });
  }
  interactions.push(
    { userId: maya._id, tripId: trip._id, destinationSlug: trip.destinationSlug, venueId: 'v_3397', category: 'food', event: 'liked', liked: true, score: 1.5 },
    { userId: leo._id, tripId: trip._id, destinationSlug: trip.destinationSlug, venueId: 'v_3432', category: 'lodging', event: 'viewed', score: 0.6 },
    { userId: leader._id, tripId: trip._id, destinationSlug: trip.destinationSlug, venueId: 'v_3419', category: 'activity', event: 'viewed', score: 0.6 }
  );
  await Interaction.insertMany(interactions);

  return { trip, items: createdItems, resolvedVote };
}

async function seedPastTrip({ venuesById, users }) {
  const leader = users.arun;
  const maya = users.maya;
  const startedAt = new Date('2026-09-04T09:00:00Z');
  const endedAt = new Date('2026-09-06T20:00:00Z');

  const trip = await Trip.create({
    destination: 'Porto, Portugal',
    destinationSlug: slugify('Porto, Portugal'),
    coordinates: { lat: 41.1469, lng: -8.6112 },
    startDate: '2026-09-04',
    endDate: '2026-09-06',
    totalBudgetCents: 180000,
    currency: 'USD',
    maxParticipants: 4,
    inviteCode: generateInviteCode(),
    leaderUserId: leader._id,
    members: [
      { userId: leader._id, role: 'leader', weight: 1, joinedAt: startedAt },
      { userId: maya._id, role: 'planner', weight: 1, joinedAt: new Date(startedAt.getTime() + 3600 * 1000) },
    ],
    status: 'completed',
    budgetMode: 'even',
    peakConcurrentPlanners: 2,
    planningStartedAt: startedAt,
    endedAt,
  });

  const picks = [
    { id: 'v_porto_05', day: 0, start: '10:00', end: '11:00', by: leader },
    { id: 'v_porto_02', day: 0, start: '13:00', end: '14:30', by: leader },
    { id: 'v_porto_01', day: 0, start: '16:00', end: '18:00', by: maya },
    { id: 'v_porto_03', day: 1, start: '17:00', end: '19:00', by: maya },
    { id: 'v_porto_04', day: 1, start: '10:00', end: '12:00', by: leader },
    { id: 'v_porto_06', day: 1, start: '20:00', end: '21:00', by: leader, stage: 'locked' },
  ];

  const items = picks.map((pick) => venueItem(venuesById.get(pick.id), {
    tripId: trip._id,
    dayIndex: pick.day,
    startTime: pick.start,
    endTime: pick.end,
    pinnedBy: pick.by,
    stage: pick.stage || 'locked',
  }));

  const createdItems = await ItineraryItem.insertMany(items.map((item) => ({ ...item })));

  const events = [{ tripId: trip._id, type: 'trip.created', userId: leader._id, ts: startedAt }];
  events.push({ tripId: trip._id, type: 'presence.joined', userId: leader._id, ts: new Date(startedAt.getTime() + 5000) });
  events.push({ tripId: trip._id, type: 'presence.joined', userId: maya._id, ts: new Date(startedAt.getTime() + 6000) });
  createdItems.forEach((item, index) => {
    events.push({
      tripId: trip._id,
      type: 'item.pinned',
      userId: item.pinnedByUserId,
      itemId: item._id,
      venueId: item.venueId,
      pricePerPersonCents: item.pricePerPersonCents,
      dayIndex: item.dayIndex,
      ts: new Date(startedAt.getTime() + 600000 + index * 60000),
    });
    events.push({
      tripId: trip._id,
      type: 'item.locked',
      userId: leader._id,
      itemId: item._id,
      ts: new Date(startedAt.getTime() + 900000 + index * 60000),
    });
  });
  events.push({ tripId: trip._id, type: 'ai.asked', userId: maya._id, ts: new Date(startedAt.getTime() + 1200000), payload: { question: 'Where should we eat near Ribeira under $30?' } });
  events.push({ tripId: trip._id, type: 'ai.answered', userId: null, ts: new Date(startedAt.getTime() + 1200400), payload: { suggestedVenueId: 'v_porto_03' } });
  events.push({ tripId: trip._id, type: 'presence.left', userId: maya._id, ts: new Date(endedAt.getTime() - 300000) });
  await Event.insertMany(events);

  await Interaction.insertMany([
    { userId: leader._id, tripId: trip._id, destinationSlug: trip.destinationSlug, venueId: 'v_porto_05', category: 'activity', event: 'pinned', score: 1.2, createdAt: startedAt },
    { userId: leader._id, tripId: trip._id, destinationSlug: trip.destinationSlug, venueId: 'v_porto_02', category: 'food', event: 'pinned', score: 1.2, createdAt: startedAt },
    { userId: leader._id, tripId: trip._id, destinationSlug: trip.destinationSlug, venueId: 'v_porto_01', category: 'activity', event: 'liked', liked: true, score: 1.5, createdAt: endedAt },
    { userId: maya._id, tripId: trip._id, destinationSlug: trip.destinationSlug, venueId: 'v_porto_03', category: 'food', event: 'liked', liked: true, score: 1.5, createdAt: startedAt },
    { userId: maya._id, tripId: trip._id, destinationSlug: trip.destinationSlug, venueId: 'v_porto_04', category: 'activity', event: 'viewed', score: 0.6, createdAt: startedAt },
    { userId: maya._id, tripId: trip._id, destinationSlug: trip.destinationSlug, venueId: 'v_porto_06', category: 'lodging', event: 'viewed', score: 0.6, createdAt: startedAt },
  ]);

  return trip;
}

function leadName(user) {
  return user.displayName;
}

async function main() {
  if (config.env === 'production' && !process.argv.includes('--force')) {
    throw new Error('Refusing to reseed in production without --force');
  }

  await connect();
  if (process.argv.includes('--reset')) {
    for (const model of [User, Trip, ItineraryItem, Vote, ChatMessage, Venue, Interaction, Event]) {
      await model.deleteMany({});
    }
  }

  const venuesById = await seedVenues();
  const users = await seedUsers();
  const live = await seedLiveTrip({ venuesById, users });
  const past = await seedPastTrip({ venuesById, users });

  const totals = await Promise.all([
    ItineraryItem.countDocuments(),
    Event.countDocuments(),
    Interaction.countDocuments(),
  ]);

  console.log('\n=== Demo data ready ===');
  console.log(`Live trip:  ${live.trip.destination} | invite code ${live.trip.inviteCode} | ${live.items.length} items`);
  console.log(`Past trip:  ${past.destination} (completed)`);
  console.log(`Items: ${totals[0]} | events: ${totals[1]} | interactions: ${totals[2]}`);
  console.log('\nAccounts (password Demo1234!):');
  console.log('  arun@demo.dev   planner + trip Leader');
  console.log('  maya@demo.dev   planner');
  console.log('  leo@demo.dev    viewer (read-only)');
  console.log('  admin@demo.dev  admin (venue dataset upload)');
  console.log(`\nInvite code: ${live.trip.inviteCode}`);
  console.log(`Trip URL:    /trips/${live.trip._id}\n`);

  await disconnect();
}

main().catch(async (err) => {
  console.error('seed failed:', err);
  try {
    await mongoose.disconnect();
    await disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
