# Data model

MongoDB via Mongoose. Eight collections; every collection has a `toPublicJSON()`/`toJSON()` projection
that maps `_id` to a stable public id (`userId`, `tripId`, `itemId`, `voteId`, `messageId`) and never
leaks `passwordHash` or internal timestamps that the client does not need.

```
User ──members──► Trip ◄──tripId── ItineraryItem
                   │  ▲                  ▲
                   │  └──candidateItemIds┘
                   ├──► Vote
                   ├──► ChatMessage
                   ├──► Event
                   └──► Interaction ──► Venue (venueId)
```

`Venue` is the catalog, keyed by `(destinationSlug, venueId)`. Itinerary items keep a `venueSnapshot` so
the board, the concierge and the budget keep working from immutable data even if an admin later edits or
removes the catalog row.

---

## User

| Field | Type | Notes |
| --- | --- | --- |
| `_id` | ObjectId | exposed as `userId` |
| `email` | string | unique, lowercased, trimmed |
| `passwordHash` | string | bcrypt(10), `select: false` — never returned |
| `displayName` | string | 2–60 chars |
| `globalRole` | enum `viewer \| planner \| admin` | platform-wide capability |
| `dietaryTags` | enum[] | `vegetarian, vegan, halal, gluten-free, nut-free, dairy-free, pescatarian` |
| `preferences.maxPerPersonBudgetCents` | number | default 150000 |
| `preferences.categoryCeilings` | map | per-category defaults (lodging 80000, food 30000, activity 25000, transport 15000, other 10000) |
| `preferences.favoriteCategories` | enum[] | `lodging, food, activity, transport, other` |
| `tokenVersion` | number | bumped on logout / password change → invalidates outstanding refresh tokens |
| `lastLoginAt` | date | |

Indexes: `email` unique, `globalRole`.

Methods: `setPassword(plain)`, `verifyPassword(plain)`.

---

## Trip

| Field | Type | Notes |
| --- | --- | --- |
| `destination` | string | display name from the dataset |
| `destinationSlug` | string | lowercase slug used for dataset lookup, indexed |
| `coordinates` | `{ lat, lng }` | centroid of the destination's venues (anchor for proximity) |
| `startDate` / `endDate` | `YYYY-MM-DD` | validated, `end >= start`, ≤ 30 days |
| `totalBudgetCents` | int ≥ 0 | group ceiling |
| `currency` | string(3) | default `USD` |
| `maxParticipants` | int 2–50 | capacity, default 8 |
| `inviteCode` | string unique | rotateable by the leader |
| `leaderUserId` | ObjectId → User | exactly one leader at a time |
| `members[]` | `{ userId, role: viewer\|planner\|leader, weight 0.1–10, muted, joinedAt }` | roster with per-member voting/budget weight |
| `status` | enum `drafting \| voting \| locked \| completed` | room-level lifecycle |
| `roomLocked` | bool | leader moderation freeze on all board writes |
| `budgetMode` | enum `even \| weighted` | split strategy |
| `viewPolicy` | enum `open \| authenticated` | visibility of the room |
| `peakConcurrentPlanners` | int | high-water mark maintained from presence |
| `planningStartedAt` / `endedAt` | date | analytics window |
| `correlationId` | string | trace id shared by the room's events |

Indexes: `members.userId + createdAt`, `destinationSlug + startDate`, `status`, `inviteCode` unique.

Methods: `memberFor(userId)`, `roleFor(user)` (admin ⇒ `'admin'`, leader ⇒ `'leader'`, else member role).

---

## ItineraryItem

| Field | Type | Notes |
| --- | --- | --- |
| `tripId` | ObjectId → Trip | indexed |
| `venueId` | string \| null | null for a custom card |
| `title` | string ≤ 120 | |
| `category` | enum | `lodging, food, activity, transport, other` |
| `dayIndex` | int 0–60 | day column on the canvas |
| `startTime` / `endTime` | `HH:MM` | `end > start` |
| `pricePerPersonCents` | int ≥ 0 | budget input |
| `dietaryTags` | string[] | copied from the venue |
| `coordinates` | `{ lat, lng }` | drives proximity ranking |
| `lifecycleStage` | enum `drafting \| voting \| locked` | |
| `positionVersion` | int | **optimistic concurrency token**, bumped on each accepted write |
| `pinnedByUserId` / `pinnedByName` | ObjectId / string | attribution |
| `note` | string ≤ 500 | |
| `venueSnapshot` | `{ name, category, pricePerPersonCents, dietaryTags, hours{open,close}, rating, description, transit }` | immutable copy |
| `lockedAt` / `lockedByUserId` | date / ObjectId | |

Indexes: `tripId + dayIndex + startTime`, `tripId + lifecycleStage`, `venueId`.

Lifecycle: `drafting → voting → locked`; `locked → drafting` only via leader unlock. Transitions are
validated by `services/boardState.js` with a permission matrix (planner may draft/lock-own, leader may
force any transition).

---

## Vote

| Field | Type | Notes |
| --- | --- | --- |
| `tripId` | ObjectId → Trip | |
| `slot` | `{ dayIndex, startTime, endTime }` | the contested slot |
| `candidateItemIds` | ObjectId[] | 2–6 frozen candidates |
| `ballots[]` | `{ userId, candidateItemId, castAt }` | one ballot per user |
| `openedByUserId` | ObjectId | |
| `closesAt` | date | 15–900 s window |
| `status` | enum `open \| resolved \| cancelled` | |
| `winningItemId` | ObjectId \| null | |
| `resolvedAt` | date \| null | |
| `resolution` | enum `tallied \| tie-break \| expired \| leader-override` | |

Index: `tripId + status`; **partial unique** index on `tripId + slot.dayIndex + slot.startTime` where
`status: 'open'` — the database itself guarantees one live vote per slot.

---

## ChatMessage

| Field | Type | Notes |
| --- | --- | --- |
| `tripId` | ObjectId → Trip | |
| `userId` | ObjectId \| null | null for AI/system |
| `authorName` | string | denormalised for rendering |
| `msgType` | enum `chat \| ai_answer \| system \| conflict` | |
| `body` | string ≤ 2000 | |
| `reactions[]` | `{ emoji, userIds[] }` | toggled per user |
| `meta` | mixed | for AI answers: citations, constraints, latency |
| `tsSeconds` | int | epoch seconds for client ordering |

Index: `tripId + createdAt`.

---

## Venue

| Field | Type | Notes |
| --- | --- | --- |
| `venueId` | string | stable dataset id, e.g. `v_3392` (Lisbon) or `v_porto_03` (Porto) |
| `destination` / `destinationSlug` | string | e.g. `Lisbon` / `lisbon` |
| `name`, `category` | string / enum | |
| `pricePerPersonCents` | int ≥ 0 | |
| `dietaryTags` | string[] | controlled vocabulary |
| `hours` | `{ open, close }` | `HH:MM`, used by the hours constraint |
| `closedDays` | int[] 0–6 | 0 = Sunday |
| `coordinates` | `{ lat, lng }` | validated ranges |
| `rating` | 0–5 | ranking feature |
| `popularity` | 0–100 | ranking feature |
| `description` | string 10–1000 | BM25 corpus |
| `tags` | string[] | BM25 + affinity features |
| `transit` | string | logistics note shown to travellers |
| `weatherNote` | string | |
| `lodging` | `{ sleeps, bedrooms }` | lodging-specific |
| `datasetVersion`, `uploadedByUserId` | string / ObjectId | provenance |

Indexes: `destinationSlug + venueId` unique, `destinationSlug + category`, `destinationSlug + coordinates`.

---

## Interaction

Recommender feedback signal, one row per `(userId, venueId)` (upserted).

| Field | Type | Notes |
| --- | --- | --- |
| `userId`, `tripId`, `destinationSlug`, `venueId`, `category` | | |
| `event` | enum `pinned \| liked \| ai_suggested \| viewed \| voted` | |
| `liked` | bool | |
| `score` | number | implicit weight (pinned 2, liked 1.5, voted 1.2, ai_suggested 0.8, viewed 0.4) |
| `createdAt` | date | |

Indexes: `userId + venueId`, `destinationSlug + venueId`, `userId`, `createdAt`.

---

## Event (append-only audit log)

| Field | Type | Notes |
| --- | --- | --- |
| `tripId` | ObjectId | |
| `type` | enum | `trip.created, trip.joined, trip.left, trip.locked, item.pinned, item.moved, item.removed, item.locked, item.unlocked, item.promoted, vote.opened, vote.cast, vote.resolved, ai.asked, ai.answered, conflict.flagged, conflict.resolved, chat.message, presence.joined, presence.left, leader.changed` |
| `userId`, `itemId`, `venueId` | ids | null when not applicable |
| `dayIndex`, `pricePerPersonCents` | number | denormalised for budget replay |
| `payload` | mixed | event-specific data |
| `ts` | date | |

Index: `tripId + type + ts`.

Why this exists: session analytics, budget reconciliation and the audit trail are all *derived* from this
log rather than from counters. `replaySpendFromEvents()` recomputes spend from `item.*` events and the
analytics endpoint compares it with the live item sums — a mismatch would surface a lost update, and the
test asserts `driftCents === 0`.

---

## Relationship to the PRD's schema

The PRD asked for user profiles with dietary preferences and budget bands, trips with budget and dates,
day-wise itinerary items, votes with ballots, chat, venue metadata (price, dietary tags, hours,
coordinates, description, transit, weather) and analytics. Each maps 1:1 above; the additions are
`positionVersion` (concurrency), `venueSnapshot` (immutability), `tokenVersion` (session revocation),
`Interaction` (recommendation training data) and `Event` (derivation + audit).
