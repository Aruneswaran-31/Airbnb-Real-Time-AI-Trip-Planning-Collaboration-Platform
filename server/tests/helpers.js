'use strict';

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const db = require('../src/db');
const User = require('../src/models/User');
const Trip = require('../src/models/Trip');
const ItineraryItem = require('../src/models/ItineraryItem');
const Venue = require('../src/models/Venue');
const Event = require('../src/models/Event');
const Interaction = require('../src/models/Interaction');
const { validateVenuePayload } = require('../src/services/datasetValidator');
const { slugify } = require('../src/utils/sanitize');
const { generateInviteCode } = require('../src/utils/ids');

const PASSWORD = 'Passw0rd!';

async function startDb() {
  await db.connect({ persist: false });
}

async function stopDb() {
  await db.disconnect();
}

async function clearDb() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
}

function loadLisbonVenues() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'lisbon.venues.json'), 'utf8'));
  const validation = validateVenuePayload(raw);
  if (!validation.ok) throw new Error('fixture dataset invalid');
  return validation.venues;
}

async function createUser({ email, name, role = 'planner', dietaryTags = [], preferences = {} }) {
  const user = new User({
    email,
    displayName: name,
    globalRole: role,
    dietaryTags,
    preferences: {
      maxPerPersonBudgetCents: 120000,
      categoryCeilings: { lodging: 80000, food: 30000, activity: 25000, transport: 15000, other: 10000 },
      favoriteCategories: ['food'],
      ...preferences,
    },
  });
  await user.setPassword(PASSWORD);
  await user.save();
  return user;
}

async function seedFixtures() {
  await clearDb();
  const venues = loadLisbonVenues();
  await Venue.insertMany(venues);
  const byId = new Map(venues.map((v) => [v.venueId, v]));

  const leader = await createUser({ email: 'leader@test.dev', name: 'Leader', role: 'planner', dietaryTags: ['vegan', 'vegetarian'] });
  const planner = await createUser({ email: 'planner@test.dev', name: 'Planner', role: 'planner', dietaryTags: ['vegetarian'] });
  const viewer = await createUser({ email: 'viewer@test.dev', name: 'Viewer', role: 'viewer' });
  const admin = await createUser({ email: 'admin@test.dev', name: 'Admin', role: 'admin' });

  const trip = await Trip.create({
    destination: 'Lisbon, Portugal',
    destinationSlug: slugify('Lisbon, Portugal'),
    coordinates: { lat: 38.7139, lng: -9.1394 },
    startDate: '2026-11-10',
    endDate: '2026-11-13',
    totalBudgetCents: 360000,
    maxParticipants: 8,
    inviteCode: generateInviteCode(),
    leaderUserId: leader._id,
    members: [
      { userId: leader._id, role: 'leader', weight: 1, joinedAt: new Date(Date.now() - 3000) },
      { userId: planner._id, role: 'planner', weight: 1.5, joinedAt: new Date(Date.now() - 2000) },
      { userId: viewer._id, role: 'viewer', weight: 1, joinedAt: new Date(Date.now() - 1000) },
    ],
    planningStartedAt: new Date(Date.now() - 3600000),
  });

  const specs = [
    { id: 'v_3417', day: 0, start: '17:00', end: '18:00', by: planner },
    { id: 'v_3410', day: 0, start: '10:00', end: '12:00', by: leader },
    { id: 'v_3413', day: 1, start: '10:00', end: '12:30', by: planner },
    // Overlapping with the tram on purpose.
    { id: 'v_3400', day: 1, start: '12:00', end: '13:30', by: leader },
    { id: 'v_3391', day: 2, start: '19:00', end: '21:00', by: leader, stage: 'locked' },
  ];

  const items = [];
  for (const spec of specs) {
    const venue = byId.get(spec.id);
    items.push({
      tripId: trip._id,
      venueId: venue.venueId,
      title: venue.name,
      category: venue.category,
      dayIndex: spec.day,
      startTime: spec.start,
      endTime: spec.end,
      pricePerPersonCents: venue.pricePerPersonCents,
      dietaryTags: venue.dietaryTags,
      coordinates: venue.coordinates,
      lifecycleStage: spec.stage || 'drafting',
      pinnedByUserId: spec.by._id,
      pinnedByName: spec.by.displayName,
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
    });
  }
  const createdItems = await ItineraryItem.insertMany(items);

  await Event.insertMany([
    { tripId: trip._id, type: 'trip.created', userId: leader._id, ts: new Date(Date.now() - 3600000) },
    { tripId: trip._id, type: 'presence.joined', userId: leader._id, ts: new Date(Date.now() - 3500000) },
    { tripId: trip._id, type: 'presence.joined', userId: planner._id, ts: new Date(Date.now() - 3400000) },
    ...createdItems.map((item, index) => ({
      tripId: trip._id,
      type: 'item.pinned',
      userId: item.pinnedByUserId,
      itemId: item._id,
      venueId: item.venueId,
      pricePerPersonCents: item.pricePerPersonCents,
      dayIndex: item.dayIndex,
      ts: new Date(Date.now() - 3000000 + index * 1000),
    })),
    { tripId: trip._id, type: 'ai.asked', userId: planner._id, ts: new Date(Date.now() - 2000000) },
  ]);

  await Interaction.insertMany([
    { userId: leader._id, destinationSlug: trip.destinationSlug, venueId: 'v_3391', category: 'food', event: 'pinned', score: 1.2 },
    { userId: leader._id, destinationSlug: trip.destinationSlug, venueId: 'v_3412', category: 'activity', event: 'liked', liked: true, score: 1.5 },
    { userId: planner._id, destinationSlug: trip.destinationSlug, venueId: 'v_3392', category: 'food', event: 'pinned', score: 1.2 },
    { userId: planner._id, destinationSlug: trip.destinationSlug, venueId: 'v_3397', category: 'food', event: 'liked', liked: true, score: 1.5 },
    { userId: viewer._id, destinationSlug: trip.destinationSlug, venueId: 'v_3432', category: 'lodging', event: 'viewed', score: 0.6 },
  ]);

  return { trip, items: createdItems, venues, byId, users: { leader, planner, viewer, admin } };
}

module.exports = {
  PASSWORD,
  startDb,
  stopDb,
  clearDb,
  createUser,
  seedFixtures,
  loadLisbonVenues,
};
