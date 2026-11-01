# What I've Built

**AI Trip War Room — Collaborative Group Itinerary Canvas & Real-Time Logistics Engine**

Built from the internship PRD as **Track A (Full-Stack)** on **Option B: MERN**
(MongoDB + Express + React + Node.js/Socket.io), JavaScript throughout, pushed to
[GitHub](https://github.com/Aruneswaran-31/Airbnb-Real-Time-AI-Trip-Planning-Collaboration-Platform).

---

## Backend Infrastructure

- **Node.js + Express API** on port **4000** (`/api/v1`) with JWT access + rotating refresh tokens,
  revocation via `tokenVersion`, and **RBAC enforced server-side on both HTTP and WebSocket paths**
  (global roles `viewer / planner / admin`, per-trip roles `viewer / planner / leader`).
- **MongoDB via Mongoose** with 8 collections: `users`, `trips`, `itineraryitems`, `votes`,
  `chatmessages`, `venues`, `events`, `interactions`.
- **Zero-install local database:** when `MONGODB_URI` is unset in development the server boots an
  embedded MongoDB (`mongodb-memory-server`) persisted to `server/.data/mongo`; production requires a
  real `MONGODB_URI`. The PRD's MongoDB model is unchanged either way.
- **4 demo accounts** covering every role (leader, planner, viewer, admin) plus an optional script that
  generates 6 traveler personas with distinct tastes, to produce recommender training data.
- **2 seeded trips:** Lisbon (live room, $3,600, 3 members, 14 itinerary items, chat history, one
  resolved vote, one **intentional schedule overlap** so the conflict detector has something to show)
  and Porto ($1,800, 2 members, completed — history for the dashboard and recommender).
- **36 authored venues across 2 destinations** (28 Lisbon, 8 Porto): food, activities, lodging,
  transport, covering every dietary tag, a $95 budget-breaching venue, restrictive hours, and one
  venue 28 km out to exercise the radius rule.
- Ops: `/healthz`, `/readyz`, structured JSON logs, helmet, CORS allow-list, rate limits per route class,
  zod validation on every body/query, sanitised free text, append-only event log.

## Features Implemented

- **Real-time trip room** — Socket.io room per trip with board fan-out, presence with per-user latency,
  typing indicators, chat with emoji reactions, vote events, conflict events and AI answers.
- **Shared itinerary canvas** — day columns, venue pins or custom cards, reschedule, item lifecycle
  `drafting → voting → locked`, leader lock override, room lock, mute/remove, leader transfer.
- **Optimistic concurrency** — moves are an atomic `findOneAndUpdate` filtered on `positionVersion`;
  the loser gets `409 stale_version` plus a `trip.board.conflict` + `trip.sync.resync` so its board
  reconciles instead of overwriting.
- **Budget tracking** — integer cents, even and weighted splits with largest-remainder distribution
  (per-person shares always sum to the group total), category ceilings, per-traveler ceilings, and
  reconciliation against the event log.
- **Group voting** — timed contested-slot vote, one open vote per slot (partial unique index),
  deterministic tie-break, winner applied and locked, losing candidates removed.
- **Conflict detection** — schedule overlap, group budget breach, per-person breach, hours violation,
  capacity; raised/resolved events only when the fingerprint set changes.
- **Invite flow & membership** — invite codes (rotateable), capacity limits, join by code.
- **Session analytics** — items added, votes held, messages, AI questions, budget utilisation, peak
  concurrent planners, all derived from the append-only event log.
- **Admin dataset management** — authenticated venue upload with field-level validation (negative
  price, unknown dietary tag, out-of-range coordinates, malformed hours, missing description),
  dataset stats, delete.

## AI Travel Concierge (Core Differentiator)

- **Pipeline:** parse question → **hard constraint filter** (budget ceiling, union of the group's
  dietary tags, opening hours + 30-min travel buffer, radius, closed weekdays) → **BM25 retrieval over
  survivors only** → **weighted ranking** (40% proximity / 30% rating / 30% budget headroom) →
  **grounded answer** citing `venueId`s.
- **Grounded by construction:** retrieval runs after filtering, so it cannot reintroduce a violation;
  every cited venue, price and opening hour exists in the dataset. The answer reports the constraint
  set, the candidate funnel (`28 → 6 → 4 → 3 → 2`), and each rejection with the rule it failed.
- **Refuses correctly:** an impossible request ("vegan dinner under $5 at 3am") is declined with the
  rules that removed everything and the closest near-misses — no invented venue, no silent relaxation.
- **Optional LLM upgrade:** set `AI_API_KEY` (any OpenAI-compatible endpoint via `AI_BASE_URL` /
  `AI_MODEL`) to generate prose with the model; its citations are validated against the candidate set
  and discarded on any out-of-set `venueId`. Without a key the deterministic grounded generator answers,
  so the project runs with zero external services. The response always reports which engine ran.
- **Group-safe by default:** the union of every member's dietary tags is applied even when the question
  does not mention food.
- **Recommendation rail:** hybrid content + category/tag affinity + item co-occurrence + popularity,
  with category diversity quotas, feedback endpoint, and an offline trainer (`npm run train`).
  Precision@5 measured **0.55** against the PRD's 0.60 — documented honestly with the ceiling analysis.

## Frontend (React + Vite, plain JavaScript per PRD)

- **Auth pages** — login / register with one-click demo account buttons for each role.
- **Dashboard** — active and completed trips, travel stats, preference profile, recommendation rail.
- **Trip War Room** — day-by-day canvas, budget panel with per-person shares, participants with roles
  and live latency, conflict banner, chat, vote panel, AI Concierge chat with citations and rejections,
  role-aware controls (viewers see no write controls at all).
- **Admin panel** — dataset upload with per-field error reporting and dataset stats.
- Socket client with reconnect, resync and ack-based mutations; API wrapper with automatic token refresh.

## Verified Flows (All Passing)

- ✅ Login as any role (leader / planner / viewer / admin) with JWT + refresh rotation
- ✅ Two planners in one room receive the same board snapshot and see each other's presence and typing
- ✅ Pinning and rescheduling fan out to the other client in **p95 5 ms** (target < 100 ms)
- ✅ Four simultaneous moves on one item resolve to **exactly 1 accepted / 3 rejected** with the loser
  resynced to the authoritative state
- ✅ Budget splits reconcile exactly to the group total in even and weighted modes
- ✅ Contested-slot vote opens, tallies, applies the winner and removes the losing candidate
- ✅ Conflict detector flags an overlap, and clears it when the overlap is resolved
- ✅ AI Concierge answers with a valid venue, price, hours and citations; **100% constraint compliance
  across 20 simulated requests**
- ✅ AI Concierge refuses off-topic/impossible constraints with reasons instead of inventing a venue
- ✅ Viewer is read-only on the server (403 on write and on AI), not just in the UI
- ✅ Admin dataset upload rejects invalid records with field-level errors and accepts valid ones
- ✅ Leader disconnect promotes the longest-standing online planner; reconnecting client receives a fresh snapshot
- ✅ **66/66 automated tests pass** (7 suites, 35.7 s), `npm run build` succeeds (267 kB JS / 83 kB gzipped)
- ✅ Load test with 6 concurrent travelers: board REST latency p95 **46 ms** (target < 200 ms), concierge
  p95 **9 ms** (target < 3000 ms)
- ✅ 20-check end-to-end API smoke script passes against the running server

## Challenges Faced

**1. A real concurrency bug that the happy path hid.** Moves first read the item, compared
`positionVersion` in JavaScript, then saved. Four simultaneous moves were **all accepted** — the last
writer would silently erase two other planners' edits. Fixed by pushing the version predicate into
`findOneAndUpdate`'s filter so MongoDB performs compare-and-set atomically; the socket test now asserts
exactly one winner and three notified losers.

**2. Measuring the wrong interval and reporting it confidently.** The first "drift" number was ~80 ms
because the timer started at the mutating client's click and included the DB write and ack. The PRD
means *server emit → peer receipt*. I fixed the harness to timestamp the server emit explicitly: fan-out
was already 5 ms p95, and the real cost was in the ack path. Both numbers are now published separately.

**3. Route mounting mistakes.** Admin routes were double-prefixed (`/api/v1/admin/admin/...`), and an
auth-guarded recommendation router mounted at `/api/v1` was swallowing the **public** venue catalog
routes. Fixed by correcting the mount order and splitting public catalog routes into their own router —
found by the smoke script, not by clicking around.

**4. Vote could be opened twice for one slot under load.** The application-level check was a
check-then-act race. Fixed with a partial unique index on `(tripId, slot, status: 'open')`, so the
database itself guarantees one live vote per slot.

**5. Recommender evaluation was wrong three times.** First it counted explicit "skip" views as relevant
(Precision@5 read 0.225). Then a venue pinned *and* liked by the same user could be split across
train/held-out, guaranteeing misses. Then the rail was drawing from **all** destinations, so unseen Porto
venues outranked Lisbon venues the traveler already knew. Fixed by scoring positive signal only,
splitting on unique venues, scoping the rail to the trip's destination, adding declared-preference
affinity and category diversity. Result: 0.55 — short of 0.60, and I documented why the gap is data
volume rather than a tuning knob instead of tuning on the held-out set.

**6. Windows environment friction with this project path.** The path contains `&` and spaces, which
`npx`/`cmd` mangled, and port 4000 was held by an unrelated process. Fixed by invoking Jest and Vite
through relative `node <bin>` paths with a dedicated Jest config, and by making ports configurable
(`PORT`, `VITE_PORT`, `VITE_API_URL`).

**7. Fan-out ordering.** Awaiting analytics and interaction writes before broadcasting doubled
emit→peer latency. Fixed by broadcasting the board update first and letting append-only analytics trail
(the reconciliation test still proves event-log spend equals live spend).

**8. Keeping AI grounded.** An early generator path could quote a price for a venue that had already
been filtered out. Fixed by generating only from the filtered candidate set and validating every citation
against it — with the deterministic engine as fallback whenever the model's output fails validation.

## Key Files & Links

**Repository:** https://github.com/Aruneswaran-31/Airbnb-Real-Time-AI-Trip-Planning-Collaboration-Platform
**Branch:** `main` · **Remote:** `origin` → `https://github.com/Aruneswaran-31/Airbnb-Real-Time-AI-Trip-Planning-Collaboration-Platform.git`

| Document | What it covers |
| --- | --- |
| [README.md](README.md) | Quick start, scripts, stack, feature matrix, limitations |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Realtime design, concurrency, budget, voting, AI pipeline |
| [docs/API.md](docs/API.md) | REST + WebSocket reference with payloads |
| [docs/SCHEMA.md](docs/SCHEMA.md) | Data model, indexes, invariants |
| [docs/TEST_REPORT.md](docs/TEST_REPORT.md) | 66 tests by suite, plus failures found and fixed |
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md) | Measured latency, concurrency results, Precision@5 analysis |
| [docs/RETROSPECTIVE.md](docs/RETROSPECTIVE.md) | Deviations from the PRD and what I'd do next |
| [docs/DEMO.md](docs/DEMO.md) | 5-minute two-browser demo script |
| [postman/trip-war-room.postman_collection.json](postman/trip-war-room.postman_collection.json) | Runnable collection with token capture |

**Run it:**

```bash
npm install
npm run seed
npm run dev        # API :4000, web client :5173
```

## Demo Accounts

| Role | Email | Password | Trip role in the seeded Lisbon room |
| --- | --- | --- | --- |
| Trip Leader / Planner | arun@demo.dev | `Demo1234!` | **Leader** — locks, moderation, votes, transfer |
| Planner | maya@demo.dev | `Demo1234!` | Planner — pin/move/vote |
| Viewer | leo@demo.dev | `Demo1234!` | Viewer — read-only board + chat |
| Admin | admin@demo.dev | `Demo1234!` | Admin — venue dataset upload |
