# AI Trip War Room — Collaborative Group Itinerary Canvas & Real-Time Logistics Engine

A full-stack, multiplayer trip-planning platform: a live day-by-day itinerary canvas, exact budget
tracking, contested-slot voting, group chat and an **AI Travel Concierge** that only ever suggests
venues satisfying the group's real constraints (budget ceiling, dietary tags, opening hours, proximity)
and cites the venue records it used.

Built as the "AI Trip War Room" internship specification — **Track A (Full-Stack)** on
**Option B: MongoDB + Express + React + Node.js (Socket.io)**, JavaScript throughout.

---

## What works end-to-end

| Area | Implemented |
| --- | --- |
| Auth | Register / login, JWT access (45 min) + rotating refresh token, revocation via `tokenVersion` |
| RBAC | Four roles — Viewer, Planner, Leader, Admin — enforced server-side on **both** HTTP and WebSocket entry points |
| Trip rooms | Create with destination/dates/budget/capacity, invite code, join flow, capacity limits, leader transfer, room lock, mute/remove, archive |
| Itinerary canvas | Day columns, pin venue or custom card, drag to reschedule, optimistic-concurrency moves, item lifecycle `drafting → voting → locked`, leader lock overrides |
| Real-time | Socket.io room per trip: board fan-out, presence, typing, chat + emoji reactions, vote events, conflict events, AI answers, `sync.ping/pong`, reconnect resync |
| Conflicts | Continuous detection of schedule overlaps, group budget breach, per-traveler ceiling breach and pinned-outside-hours; raised/resolved events |
| Voting | Timed contested-slot vote: opens, freezes candidates, tallies, deterministic tie-break, applies winner, clears losers |
| Budget | Integer-cent arithmetic, even and weighted splits with largest-remainder distribution, per-person totals, category ceilings, event-log reconciliation |
| AI Concierge | Hard constraint filter → BM25 retrieval over venue metadata → weighted ranking (40% proximity / 30% rating / 30% budget headroom) → grounded answer citing `venueId`s, with rejection reasons |
| Recommendations | Hybrid content-based + item co-occurrence + group affinity, category diversity, feedback endpoint, offline trainer with Precision@5 evaluation |
| Dashboard | Trip history, live rooms, travel preference profile, recommendation rail, per-session analytics reconciled against the event log |
| Admin | Authenticated dataset upload with field-level validation (price, dietary vocabulary, coordinates, hours, description) |
| Ops | `/healthz`, `/readyz`, structured JSON logs, rate limiting, sanitised input, automated tests, load-test harness |

---

## Stack

- **Client:** React 18 + Vite + socket.io-client (plain JavaScript)
- **API:** Node.js 20 + Express 4 + Socket.io 4
- **Database:** MongoDB via Mongoose 8 (the PRD's required choice for this option)
- **Auth:** JWT (`jsonwebtoken`) + bcrypt
- **Validation:** zod
- **Tests:** Jest + Supertest + socket.io-client
- **AI:** any OpenAI-compatible chat-completions endpoint, **optional** — see [AI Concierge](#ai-concierge)

### About MongoDB in development

You do **not** need to install MongoDB to run this project. When `MONGODB_URI` is unset and
`NODE_ENV !== 'production'`, the server starts a local MongoDB instance through
`mongodb-memory-server`, persisted to `server/.data/mongo`, so data survives restarts.

For a real deployment set `MONGODB_URI` (e.g. `mongodb://localhost:27017/trip_war_room`) — the embedded
fallback is disabled in production and the server refuses to start without it.

> First run downloads a ~600 MB MongoDB binary once into `server/.cache/mongo-bin` (git-ignored).
> Subsequent starts are immediate.

---

## Quick start

```bash
git clone https://github.com/Aruneswaran-31/Airbnb-Real-Time-AI-Trip-Planning-Collaboration-Platform.git
cd Airbnb-Real-Time-AI-Trip-Planning-Collaboration-Platform

npm install          # installs server + web workspaces

cp .env.example server/.env     # optional: adjust PORT / secrets / AI key (Vite needs no .env on default ports)
npm run seed         # venue datasets, demo accounts, a live trip + a completed trip

npm run dev          # API on :4000, web client on :5173
```

Open <http://localhost:5173> and sign in as any demo account.

### Demo accounts (password `Demo1234!`)

| Email | Global role | Trip role in the demo room |
| --- | --- | --- |
| `arun@demo.dev` | planner | **Leader** (locks, moderation, votes, transfer) |
| `maya@demo.dev` | planner | Planner (pin/move/vote) |
| `leo@demo.dev` | viewer | Viewer (read-only board + chat) |
| `admin@demo.dev` | admin | Admin (venue dataset upload) |

The seeded Lisbon room already contains a live itinerary, chat history, an AI exchange, a resolved
vote and **one intentional schedule overlap** so the conflict detector has something to show.

### Ports

- API `4000`, web dev `5173` (Vite proxies `/api` and `/socket.io` to the API, so no CORS setup needed).
- If a port is taken: `PORT=4310 npm run dev:server` and `VITE_API_URL=http://localhost:4310 npm run dev:web`
  (or set them in `server/.env`).

---

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | API + web client together (concurrently) |
| `npm run seed` | Reset and seed venues, users, trips, events, interactions |
| `npm test` | 66 automated tests: board state machine, budget math, constraints, RBAC, AI grounding, sockets, voting, analytics |
| `npm run train` | Train + evaluate the recommender, writes `server/artifacts/recommender.json` |
| `npm run loadtest` | 6 simulated travelers: fan-out drift, API latency, AI latency, concurrent-move conflicts |
| `node server/scripts/simulate-travelers.js` | Generate realistic interaction data through the real REST API |
| `node server/scripts/smoke-api.js` | 20-check end-to-end smoke run against a live API |

---

## Architecture at a glance

```
CLIENT (React)                        API (Express)                  SYNC GATEWAY (Socket.io)
 canvas · budget · chat · AI   ⇄  REST /api/v1 + JWT / RBAC   ⇄   one room per trip, fan-out,
 dashboard · admin                 trips · items · votes · venues      presence, chat, votes, AI
                                          │                                   │
                                          └──────────────┬────────────────────┘
                                                         ▼
                                          APPLICATION SERVICES (shared)
                                    boardService · budget · constraints · conflicts
                                    votes · concierge · analytics · recommendation
                                                         │
                                       ┌─────────────────┴──────────────────┐
                                       ▼                                    ▼
                               MongoDB (Mongoose)                   AI Concierge Engine
                          users · trips · items · votes            BM25 retrieval → hard filter
                          chat · venues · events · interactions    → weighted rank → grounded answer
```

- Full detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- REST + WebSocket reference with payloads: [docs/API.md](docs/API.md)
- Data model / schema: [docs/SCHEMA.md](docs/SCHEMA.md)
- Test report: [docs/TEST_REPORT.md](docs/TEST_REPORT.md)
- Measured performance: [docs/PERFORMANCE.md](docs/PERFORMANCE.md)
- Retrospective: [docs/RETROSPECTIVE.md](docs/RETROSPECTIVE.md)
- 5-minute demo script: [docs/DEMO.md](docs/DEMO.md)

### Concurrency model

Every itinerary mutation bumps `positionVersion`. Moves are an **atomic conditional update**
(`findOneAndUpdate` filtered on the version the client last saw), so two planners dragging the same
card at the same instant cannot both win: the loser receives a `trip.board.conflict` event with
`conflictType: 'version'` and the current item, and its UI reconciles instead of overwriting.

Verified by `tests/sockets.test.js` (4 concurrent moves → exactly 1 accepted, 3 rejected).

### Budget accuracy

All money is integer cents. Even and weighted splits use the largest-remainder method, so
`Σ per-person shares === group total` always — asserted across hundreds of totals in
`tests/budget.test.js`, and reconciled against the append-only event log in session analytics.

---

## AI Concierge

The concierge pipeline:

1. **Parse** the question into explicit filters (budget `$25`, dietary terms, category, time slot, radius)
2. **Hard filter** the destination dataset: budget ceiling · every group dietary tag · hours + 30 min
   travel buffer · radius from the anchor event · closed weekdays
3. **Retrieve** (BM25) over the *already valid* candidates only
4. **Rank** by `0.4 × proximity + 0.3 × rating/popularity + 0.3 × budget headroom`
5. **Generate** a grounded answer that cites `venueId`s, with the constraint set, candidate counts and
   rejection reasons returned in the payload

The suggested venue is always drawn from the filtered set — enforced in code and covered by a test
asserting 100% constraint compliance across 20 simulated requests.

**Two engines, one contract:**

- With `AI_API_KEY` set (any OpenAI-compatible endpoint: `AI_BASE_URL`, `AI_MODEL`), answers are
  generated by the model, then **validated**: any citation outside the candidate set is discarded and
  the deterministic answer is used instead.
- Without a key, the deterministic grounded generator produces the answer directly from venue
  metadata. This is the mode used throughout the recorded demo and tests, and it means the project
  runs with zero external services.

The concierge never invents a venue, price or opening hour, and when nothing satisfies every
constraint it says so and lists the closest near-misses with the rules they failed.

---

## Venue datasets

Authored, mocked metadata (as the PRD requires) lives in `server/src/data/`:

- **Lisbon, Portugal** — 28 venues: 10 food, 10 activities, 4 lodging, 4 transport. Covers every
  dietary tag, at least one budget breaching venue ($95 tasting menu), restrictive hours
  (breakfast-only, evening-only, early-close) and one venue 28 km out to exercise the radius rule.
- **Porto, Portugal** — 8 venues to prove the constraint engine generalises.

Admins can upload further datasets at **Datasets** in the UI or via `POST /api/v1/admin/venues`.
Invalid records are rejected with field-level errors (negative price, unknown dietary tag, out-of-range
coordinates, malformed hours, missing description).

---

## Testing

```bash
npm test
```

66 tests across 7 suites, all passing:

- `boardState` — lifecycle transitions, permission matrix, slot validation, optimistic concurrency
- `budget` — exact splits, remainder distribution, weighted mode, ceilings, event-log replay
- `constraints` — budget/dietary/hours/weekday/proximity rules, ranking weights, 20-request compliance
- `rbac` — all four roles on HTTP, viewer/planner/leader/admin boundaries, dataset validation
- `ai` — parsing, grounding (no fabricated venues), constraint compliance, graceful refusal, latency
- `sockets` — join/snapshot, fan-out drift, concurrent-move conflict notification, presence, typing,
  chat, leader-disconnect promotion, reconnect resync
- `analytics` — event-log reconciliation, peak concurrency, vote open/cast/resolve/apply

See [docs/TEST_REPORT.md](docs/TEST_REPORT.md) for the full run output and
[docs/PERFORMANCE.md](docs/PERFORMANCE.md) for measured numbers.

---

## Docker (provided, not exercised in the reference environment)

```bash
docker compose up --build
```

Brings up MongoDB, the API and the built web client behind nginx. The reference environment had no
Docker daemon, so this path is untested here; the documented `npm` workflow above is the verified one.

---

## Deliberate limitations

- **No payments.** Budget tracking is arithmetic only.
- **Recommendation Precision@5 measured 0.55** against the PRD's 0.6 target — analysis and the reason
  the ceiling is structural (4 held-out items per traveler, 10 venues per category) in
  [docs/PERFORMANCE.md](docs/PERFORMANCE.md) and [docs/RETROSPECTIVE.md](docs/RETROSPECTIVE.md).
- The LLM path is implemented and cited, but was not exercised against a live provider in this
  environment (no API key); the deterministic grounded engine was used for every recorded result.
- Load-tested with 6 concurrent travelers, not the 50-planner design target. The architecture holds no
  single-room or fixed-capacity assumptions.
- Local/private deployment only — no public CDN, no multi-tenant billing.

## Project layout

```
server/
  src/
    ai/            questionParser · retriever (BM25) · generator · llm client
    middleware/    auth (JWT + RBAC) · validation · errors · rate limiting
    models/        User · Trip · ItineraryItem · Vote · ChatMessage · Venue · Interaction · Event
    realtime/      hub (fan-out, presence, conflicts) · gateway (Socket.io handlers)
    routes/        auth · trips · items · votes · ai · venues · recommendations · dashboard · admin
    services/      boardService · budget · constraints · conflicts · votes · concierge · analytics · recommendation · datasetValidator
    data/          lisbon.venues.json · porto.venues.json
    seed.js        demo data
  tests/           7 Jest suites
  scripts/         train-recommender · loadtest · simulate-travelers · smoke-api
web/
  src/
    pages/         Login · Register · Dashboard · TripRoom · Admin
    components/    TopBar
    api.js         fetch wrapper with refresh handling
    socket.js      socket factory + ack helper
postman/           API collection
docs/              architecture · API · schema · test report · performance · retrospective · demo
```
