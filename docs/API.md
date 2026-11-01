# API reference

Base URL: `http://localhost:4000/api/v1`
All request and response bodies are JSON. Authenticated calls send `Authorization: Bearer <accessToken>`.

A ready-to-run Postman collection lives in [postman/trip-war-room.postman_collection.json](../postman/trip-war-room.postman_collection.json)
(it logs in and stores tokens automatically).

## Conventions

- **Success:** `2xx` with a resource object or `{ ...resource }` wrapper.
- **Error:** `{ "error": { "code": "snake_case_code", "message": "human readable", "details": {...} } }`
- **Money:** integers in cents everywhere in payloads (`pricePerPersonCents`, `totalBudgetCents`).
- **Dates:** calendar days are `YYYY-MM-DD` strings; times are `HH:MM` 24h strings. Timestamps are ISO-8601.
- **Optimistic concurrency:** item mutations accept `expectedVersion`; stale writes return `409 stale_version`.
- **Rate limits** (per IP + user): global 300/min, auth 10/min, writes 90/min, AI 20/min.
  Exceeding returns `429 rate_limited` with `Retry-After`.

---

## Health

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/healthz` | – | Liveness: `{ status, uptimeSeconds, version }` |
| GET | `/readyz` | – | Readiness: checks the Mongo connection, `503` when not ready |

---

## Auth

### POST `/auth/register`
```json
{ "email": "new@demo.dev", "password": "Secret123!", "displayName": "New Traveler",
  "dietaryTags": ["vegetarian"], "globalRole": "planner" }
```
`201` →
```json
{ "accessToken": "eyJ...", "refreshToken": "eyJ...", "user": { "userId": "...", "email": "...", "displayName": "...", "globalRole": "planner", "preferences": { ... } }, "expiresInSeconds": 2700 }
```
Errors: `409 email_taken`, `422 validation_error` (password ≥ 8 chars).

### POST `/auth/login`
`{ "email", "password" }` → same payload as register. Errors: `401 invalid_credentials`.

### POST `/auth/refresh`
`{ "refreshToken" }` → new access + refresh token pair. Old refresh tokens are invalidated by `tokenVersion`.

### POST `/auth/logout`
Requires auth. Bumps `tokenVersion`, so every outstanding token for that user stops working.

### GET `/auth/me`
Returns the caller: `{ userId, email, displayName, globalRole, preferences, createdAt }`.

### PATCH `/auth/me`
Updatable: `displayName`, `dietaryTags[]`, and `preferences { maxPerPersonBudgetCents, categoryCeilings, favoriteCategories[] }`.
`dietaryTags` feed the concierge's group constraint; `favoriteCategories` and `maxPerPersonBudgetCents`
feed the recommender. Unknown dietary tags → `400 invalid_dietary_tags`.

---

## Trips

### POST `/trips` — create a Trip Room
```json
{ "destination": "Lisbon", "startDate": "2026-03-12", "endDate": "2026-03-15",
  "totalBudget": 2400, "maxParticipants": 6, "budgetMode": "even", "currency": "USD" }
```
`201` → `{ tripId, inviteCode, status, leaderUserId, destination, startDate, endDate, totalBudgetCents, maxParticipants, createdAt }`

Errors: `400 unknown_destination` (with the list of loaded destinations), `422 validation_error`
(end before start, trip longer than 30 days).

### GET `/trips`
Trips the caller belongs to, newest first, each with `spendCents`, `itemCount`, `memberCount`.
Admins may pass `?all=true`.

### GET `/trips/:id`
Trip detail: settings, roster with roles and weights, caller's `role`, invite code (members only).

### GET `/trips/:id/board`
The canvas: `{ trip, items[], budget, conflicts[], votes[], participants[] }`.

### GET `/trips/:id/conflicts`
`{ conflicts: [{ conflictKey, type, severity, message, itemIds[], userIds[] }] }`

### GET `/trips/:id/analytics`
`{ analytics: { sessionMinutes, itemsAdded, votesHeld, messages, aiQuestions, budgetUtilization, replayedSpendCents, driftCents, peakConcurrentPlanners, ... } }`

### POST `/trips/join`
`{ "inviteCode": "ABC123" }` → the trip, with the caller added as `planner`.
Errors: `404 invalid_invite_code`, `409 trip_full` (capacity), `409 already_member`.

### POST `/trips/:id/invite`
Leader only. Rotates the invite code (invalidates the old one) → `{ inviteCode }`.

### PATCH `/trips/:id`
Leader only. Any subset of `{ totalBudget, maxParticipants, budgetMode, roomLocked }`.
Broadcasts `trip.room.settings`. Lowering capacity below the roster size → `400 capacity_too_small`.

### POST `/trips/:id/complete`
Leader only. Sets `status: "completed"`, stamps `endedAt`, broadcasts the room state. The room becomes
read-only for board writes.

### PATCH `/trips/:id/members/:userId`
Leader only. `{ "role": "planner" | "viewer", "muted": true, "weight": 1.5 }`.
Promoting someone to `leader` requires the transfer endpoint instead (one leader per room).

### DELETE `/trips/:id/members/:userId`
Leader only. Removes a member (not the leader; transfer first). Broadcasts `trip.member.removed`.

### POST `/trips/:id/transfer-leader`
Leader only. `{ "userId": "..." }` → previous leader becomes `planner`. Broadcasts `trip.leader.state`.

### GET `/trips/:id/votes`
All votes for the trip, newest first, with ballots and tally.

### GET `/trips/:id/chat`
`?limit=100` (default 100, max 300) → chat transcript including `system`, `conflict` and `ai_answer`
messages, oldest first.

---

## Itinerary items

All item routes are mounted under `/trips/:id/items` and require `planner` unless noted.

### POST `/trips/:id/items` — pin a venue or a custom card
```json
{ "venueId": "v_3392", "dayIndex": 0, "startTime": "19:30", "endTime": "21:00",
  "note": "birthday dinner" }
```
or
```json
{ "title": "Sunset at Miradouro", "category": "activity", "dayIndex": 1,
  "startTime": "18:00", "endTime": "19:00", "pricePerPerson": 0 }
```
`201` → `{ item, budget, conflicts, board }`

Rules: `venueId` must exist in the destination dataset; `endTime > startTime`; `dayIndex` within trip
length. Pinning a venue copies its metadata into `venueSnapshot` so the concierge and the board work
from immutable data. Broadcasts `trip.board.update` and records a `pinned` interaction.

Errors: `404 venue_not_found`, `422 validation_error`, `403 room_locked`.

### PATCH `/trips/:id/items/:itemId` — move / reschedule
```json
{ "dayIndex": 1, "startTime": "20:00", "endTime": "21:30", "expectedVersion": 3 }
```
`200` → `{ item, budget, conflicts, board }`
`409` → `{ error: { code: "stale_version", details: { expectedVersion, currentVersion, currentItem } }, currentItem }`
and the losing client also receives `trip.board.conflict` + `trip.sync.resync` over its socket.

### DELETE `/trips/:id/items/:itemId`
Removes the item. Leader-only if the item is `locked`. Broadcasts `trip.board.update`.

### POST `/trips/:id/items/:itemId/lock` and `/unlock`
Leader only. `locked` items cannot be moved by planners and do not enter votes.
Broadcasts `trip.board.update`.

### GET `/trips/:id/items/:itemId`
Single item with its `positionVersion` and `venueSnapshot`.

---

## Votes

Mounted under `/trips/:id/votes`, all require `planner` (resolve requires `leader`).

### POST `/trips/:id/votes`
```json
{ "candidateItemIds": ["itemA", "itemB"], "closesInSeconds": 120 }
```
`201` → `{ vote, itemIds, budget, conflicts }`. One open vote per slot (partial unique index).
Errors: `409 vote_already_open`, `400 slot_mismatch` (candidates must be in the same slot),
`422 validation_error` (2–6 candidates, 15–900 s).

### POST `/trips/:id/votes/:voteId/cast`
`{ "candidateItemId": "itemB" }` → updated tally. Re-casting replaces the caller's ballot.
Errors: `409 vote_closed`, `400 candidate_not_in_vote`.

### POST `/trips/:id/votes/:voteId/resolve`
Tallies and applies the result: the winner moves into the slot and locks, losers are removed.
`resolution` is `tallied | tie-break | expired`. Leader only for manual resolution of a still-open vote.

### POST `/trips/:id/votes/:voteId/cancel`
Leader only. `resolution: "cancelled"`, broadcasts `trip.vote.resolved` with `cancelled: true`.

### GET `/trips/:id/votes/:voteId`
One vote with ballots, tally, `closesAt` and remaining seconds.

---

## AI Concierge

Mounted under `/trips/:id/ai`.

### POST `/trips/:id/ai/ask`
```json
{ "question": "Find a vegan dinner near the castle under $25 for 7:30pm", "anchorItemId": "optionalItemId" }
```
`200` →
```json
{
  "questionId": "q_...",
  "answer": "Cantinho Verde fits: $18 per person, fully vegan, open 12:00–23:00, 0.6 km from ...",
  "suggestedVenueId": "v_3392",
  "sourceEvents": ["v_3392"],
  "engine": "grounded-template",
  "latencyMs": 9,
  "sources": [{ "venueId": "v_3392", "name": "Cantinho Verde", "pricePerPersonCents": 1800, "dietaryTags": ["vegan","vegetarian","dairy-free","nut-free"], "distanceKm": 0.6 }],
  "constraints": { "maxPriceCents": 2500, "dietaryTags": ["vegan"], "afterTime": "19:30", "radiusKm": 1, "bufferMinutes": 30 },
  "candidateStats": { "total": 28, "afterDietary": 6, "afterBudget": 4, "afterHours": 3, "afterRadius": 2, "returned": 1 },
  "rejected": [{ "venueId": "v_3398", "name": "Mesa de Sintra", "reasons": ["price_over_budget"] }],
  "messageId": "..."
}
```
Requires `planner`. The union of the group's dietary tags is always applied, whether or not the question
mentions food. Answers are persisted as chat messages and broadcast as `trip.chat.message` +
`trip.ai.suggestion`.

### GET `/trips/:id/ai/history`
Last 20 concierge answers for the room, oldest first.

### GET `/trips/:id/ai/constraints`
The exact constraint set and ranking weights the concierge will use for this trip:
`{ groupDietaryTags, perPersonBudgetCents, bufferMinutes, defaultRadiusKm, rankingWeights, engine }`.

---

## Venues (public catalog)

No auth required (optional auth is read for personalisation).

### GET `/destinations`
`{ destinations: [{ destination, slug, venueCount, categories: { food: 10, ... }, priceRange: { minCents, maxCents }, updatedAt }] }`

### GET `/destinations/:destination/venues`
Query: `category`, `maxPrice` (dollars), `dietaryTags` (comma list, all must match), `q`, `limit`, `offset`.
→ `{ destination, count, venues: [...] }` with each venue's `pricePerPerson`, `hours`, `rating`,
`coordinates`, `dietaryTags`, `description`, `transit`, `weatherNote`.

---

## Recommendations

Requires auth.

### GET `/recommendations`
Query: `limit` (1–20, default 8), `destinationSlug`.
→ `{ items: [{ venueId, name, category, pricePerPersonCents, reason, score, breakdown }], strategy, weights, generatedAt }`

The rail is scoped to a destination; `reason` is a human-readable justification of the score.

### POST `/recommendations/feedback`
`{ "venueId": "v_3393", "liked": true }` → `{ interaction..., railUpdated: true }`
Records the signal the offline trainer learns from.

---

## Dashboard

### GET `/dashboard`
The logged-in overview:
```json
{
  "user": { ... },
  "activeTrips": [ ... ],
  "completedTrips": [ ... ],
  "stats": { "tripsPlanned", "daysPlanned", "itemsPinned", "votesHeld", "aiQuestions" },
  "recommendations": { "items": [ ... ] },
  "upcoming": [ ... ]
}
```

### GET `/dashboard/analytics`
`{ analytics: { perTrip: [...], totals: { itemsPinned, votesHeld, messages, aiQuestions }, budgetAccuracy: { replayedCents, liveCents, driftCents } } }`

---

## Admin

All routes require `globalRole: "admin"`.

### POST `/admin/venues`
Accepts either `{ "venues": [...] }` or a bare array. Upserts by `(destinationSlug, venueId)`.
Required per venue: `venueId`, `destination`, `name`, `category` (`lodging|food|activity|transport|other`),
`pricePerPersonCents` (or `pricePerPerson`), `dietaryTags[]`, `hours { open, close }`, `coordinates { lat, lng }`,
`description`.

`201` → `{ accepted, inserted, updated, destinations, datasetVersion }`
`422` → `{ error: { code: "invalid_dataset", details: [{ index, field, message }] } }`

Field rules: price ≥ 0, dietary tags from the controlled vocabulary, latitude −90..90, longitude
−180..180, `HH:MM` hours with `close > open`, description 10–1000 chars, `closedDays` 0–6.

### GET `/admin/venues`
`?destinationSlug=lisbon&limit=100` → dataset rows for inspection.

### DELETE `/admin/venues/:venueId`
Requires `?destinationSlug=`. Removes one venue. Pinned itinerary items keep their snapshot and are unaffected.

### GET `/admin/dataset-stats`
Per destination: venue counts, category coverage, dietary-tag coverage, price range, and the venues that
exercise each constraint type (cheapest, most expensive, earliest close, farthest from centre).

---

## WebSocket protocol

Connect to the same origin (`/socket.io`) with `auth: { token: <accessToken> }`.

```js
const socket = io(API_URL, { auth: { token }, transports: ['websocket', 'polling'] });
socket.emit('trip.join', { tripId }, (ack) => { /* snapshot arrives via trip.board.snapshot */ });
```

Client → server events and their payloads:

| Event | Payload | Ack |
| --- | --- | --- |
| `trip.join` | `{ tripId }` | `{ ok, participants[], serverTime }` |
| `trip.leave` | `{ tripId }` | – |
| `trip.board.pin` | `{ tripId, venueId?, title?, category?, dayIndex, startTime, endTime, note? }` | `{ ok, item }` |
| `trip.board.move` | `{ tripId, itemId, dayIndex, startTime, endTime, expectedVersion }` | `{ ok, item }` or `{ ok:false, code:'stale_version', currentItem }` |
| `trip.board.remove` | `{ tripId, itemId }` | `{ ok, itemId }` |
| `trip.board.lock` / `.unlock` | `{ tripId, itemId }` | `{ ok, item }` |
| `trip.chat.send` | `{ tripId, body }` | `{ ok, message }` |
| `trip.chat.typing` | `{ tripId, typing }` | – |
| `trip.chat.react` | `{ tripId, messageId, emoji }` | `{ ok, messageId, emoji, count }` |
| `trip.vote.open` | `{ tripId, candidateItemIds[], closesInSeconds? }` | `{ ok, vote }` |
| `trip.vote.cast` | `{ tripId, voteId, candidateItemId }` | `{ ok, vote }` |
| `trip.vote.resolve` | `{ tripId, voteId }` | `{ ok, resolution }` |
| `trip.ai.ask` | `{ tripId, question, anchorItemId? }` | `{ ok, answer, suggestedVenueId, latencyMs }` |
| `trip.moderate` | `{ tripId, action: 'mute'\|'unmute'\|'remove'\|'lockRoom'\|'unlockRoom', userId? }` | `{ ok }` |
| `trip.sync.ping` | `{ t0 }` | `trip.sync.pong { t0, serverTime }` |
| `trip.presence.heartbeat` | `{ tripId }` | – |

Server → client events are always `{ event, tripId, payload, ts }`. Authorisation failures on a socket
emit `trip.error` with `{ code, message }` and never mutate state. A `403` on join closes the room
membership; the socket itself stays connected so the client can retry after joining the trip.
