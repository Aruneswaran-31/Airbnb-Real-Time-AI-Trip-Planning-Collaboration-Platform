# Architecture

## 1. Shape of the system

```
┌──────────────────────────── Browser (React 18 + Vite) ────────────────────────────┐
│  Login / Register   Dashboard   Trip War Room   Datasets (admin)                   │
│        │                 │            │                                            │
│        │  fetch wrapper  │            │  socket.io-client (JWT in handshake auth)  │
└────────┼─────────────────┼────────────┼────────────────────────────────────────────┘
         │                 │            │
         ▼                 ▼            ▼
┌──────────────────────────────┐   ┌─────────────────────────────────────────────────┐
│  REST API  /api/v1           │   │  Sync Gateway (Socket.io)                        │
│  helmet · cors · rate limit  │   │  room per trip:  trip:<tripId>                   │
│  requireAuth · requireTripRole│  │  presence · typing · board · votes · chat · AI   │
└──────────────┬───────────────┘   └───────────────────────┬─────────────────────────┘
               │                                           │
               └──────────────────┬────────────────────────┘
                                  ▼
                    ┌──────────────────────────────┐
                    │  Application services        │   single source of truth for
                    │  boardService                │   any mutation, so REST and
                    │  budget · constraints        │   socket writes cannot diverge
                    │  conflicts · votes           │
                    │  concierge · analytics       │
                    │  recommendation · dataset    │
                    └───────┬───────────────┬──────┘
                            ▼               ▼
                  ┌──────────────┐   ┌─────────────────────────┐
                  │ MongoDB      │   │ AI Concierge Engine      │
                  │ (Mongoose)   │   │ parse → filter → BM25    │
                  │ 8 models     │   │ → rank → ground/validate │
                  └──────────────┘   └─────────────────────────┘
```

Design rule: **routes never mutate the board directly.** They call `boardService`, which performs
validation, the atomic write, the event log entry, conflict re-evaluation, budget recomputation and
the realtime fan-out. The socket handler calls the same functions. This is why the demo can drag a card
in one browser and see it move in another with identical semantics to a REST PATCH.

### Layers

| Layer | Location | Responsibility |
| --- | --- | --- |
| Transport | `src/routes/*`, `src/realtime/gateway.js` | Parse request, authenticate, authorise, call a service, serialise the response |
| Application | `src/services/*` | Business rules, invariants, cross-model orchestration |
| Domain helpers | `src/services/budget.js`, `constraints.js`, `boardState.js` | Pure functions — no I/O, directly unit-tested |
| Persistence | `src/models/*` | Schema, indexes, public JSON projections |
| Cross-cutting | `src/middleware/*`, `src/logger.js`, `src/config.js` | Auth, RBAC, validation, errors, rate limits, config |

Pure domain helpers are the reason the test suite can assert budget and lifecycle rules without a
database: `budget.allocate()` and `boardState.canTransition()` take plain objects and return plain
objects.

---

## 2. Real-time collaboration

### Rooms and envelopes

Each trip is one Socket.io room, `trip:<tripId>`. Every server message uses the PRD envelope:

```json
{ "event": "trip.board.update", "tripId": "65f...", "payload": { ... }, "ts": 1770000000000 }
```

Handshake authentication uses the JWT access token; the socket join handler re-reads the trip and the
member's role, and rejects non-members with `trip.error` before any room state is sent.

### Events

| Direction | Event | Purpose |
| --- | --- | --- |
| client → server | `trip.join` / `trip.leave` | Enter/exit the room; join replies with a full board snapshot |
| client → server | `trip.board.pin` / `.move` / `.remove` / `.lock` / `.unlock` | Board mutations (same services as REST) |
| client → server | `trip.chat.send` / `.typing` / `.react` | Chat, typing indicator, emoji reactions |
| client → server | `trip.vote.open` / `.cast` / `.resolve` | Contested-slot voting |
| client → server | `trip.ai.ask` | AI Concierge from the room |
| client → server | `trip.moderate` | Leader moderation (mute, remove, room lock) |
| client → server | `trip.sync.ping` / `trip.presence.heartbeat` | Clock sync and presence keep-alive |
| server → client | `trip.board.snapshot` / `trip.board.update` | Initial state and every accepted mutation |
| server → client | `trip.board.conflict` | Conflict raised/resolved, or a rejected write |
| server → client | `trip.sync.resync` | Authoritative item state after a rejected optimistic move |
| server → client | `trip.presence.update`, `trip.leader.state` | Roster with roles/latency; leader online/frozen |
| server → client | `trip.chat.message`, `trip.chat.reaction` | Chat and AI answers (system messages included) |
| server → client | `trip.vote.open`, `trip.vote.cast`, `trip.vote.resolved` | Vote lifecycle |
| server → client | `trip.ai.suggestion` | Concierge answer with citations and constraint stats |
| server → client | `trip.member.updated`, `trip.member.removed`, `trip.room.settings` | Moderation and room settings |
| server → client | `trip.sync.pong` | Clock-sync reply |

### Optimistic concurrency

Every item carries `positionVersion`. A move is:

```js
ItineraryItem.findOneAndUpdate(
  { _id: itemId, tripId, positionVersion: expectedVersion },   // ← atomically conditional
  { $set: { dayIndex, startTime, endTime }, $inc: { positionVersion: 1 } },
  { new: true }
);
```

If it returns `null`, someone else's write landed first. The server:

1. re-reads the item,
2. emits `trip.board.conflict` **to the losing socket only** with `conflictType: 'version'`,
3. emits `trip.sync.resync` with the authoritative item,
4. returns HTTP `409` with `stale_version` and `currentItem` for REST callers.

An earlier implementation read the item, compared versions in JavaScript, then wrote — a classic
check-then-act race. The socket test proved it: four simultaneous moves were **all accepted**. The fix
was to push the version predicate into the update filter so MongoDB performs compare-and-set in one
document operation. The same test now shows exactly one winner and three rejections.

### Presence and leader connectivity

`hub` keeps an in-memory `Map` per trip of `userId → { socketIds, role, latencyMs }`. A user with two
tabs is one presence entry with two socket ids. `trip.sync.ping/pong` estimates latency, which the UI
shows next to each participant.

When the leader's last socket disconnects, the room enters a deterministic fallback: after a short
grace period the hub promotes the earliest-joined planner and broadcasts `trip.leader.state`, so the
room never becomes un-moderatable. Reconnecting leaders are not silently re-promoted over an active
one — the event states who holds control.

### Fan-out ordering

A mutation broadcasts `trip.board.update` **before** analytics or interaction writes complete
(`afterMutation` awaits only the board-critical work). The tests found this mattered: awaiting the
analytics write first doubled the emit→peer latency. Since analytics is append-only and idempotent, it
can trail the fan-out safely.

---

## 3. Budget engine

Money is integer cents end-to-end; no float arithmetic touches a price.

- `totalBudgetCents` on the trip; each item has `pricePerPersonCents`.
- Group spend = `Σ pricePerPersonCents × participants` for the current roster size.
- Split modes:
  - **even** — largest-remainder distribution, so shares sum exactly to the total.
  - **weighted** — per-member `weight` (0.1–10) drives the split, same remainder guarantee.
- Outputs: total, remaining, per-person shares, per-category breakdown, per-traveler ceiling checks,
  burn rate against trip days.
- `replaySpendFromEvents()` recomputes spend from the append-only `Event` log; session analytics
  compares replayed spend with live item sums to detect drift. The test asserts they agree.

---

## 4. Conflict detection

`services/conflicts.js` computes a set of conflicts from the current board + trip:

| Type | Rule |
| --- | --- |
| `schedule_overlap` | Two items on the same day whose `[start,end)` intervals intersect |
| `budget_exceeded` | Group spend > trip budget |
| `per_person_exceeded` | A traveler's share > the group per-person budget |
| `hours_violation` | A pinned venue scheduled outside its opening hours |
| `capacity_exceeded` | Roster larger than `maxParticipants` |

Each conflict has a stable fingerprint (`type + sorted participant ids`). `boardService` diffing against
the previous fingerprint set emits `raised` only for new ones and `resolved` for cleared ones, so the UI
never flickers or re-announces an unchanged problem. Conflicts are also persisted as `Event` rows, which
is what the dashboard and analytics read.

---

## 5. Voting

A contested slot (same day + overlapping time) can be resolved by timed vote:

1. `openVote` freezes 2–6 candidate items, sets `closesAt`, and enforces **one open vote per slot**
   with a partial unique index.
2. Ballots are one per user; re-casting replaces the previous ballot rather than appending.
3. `resolveVote` tallies, breaks ties deterministically (earliest pin, then lowest item id), applies the
   winner (moves it into the slot and locks it), removes the losing candidates from the slot, and
   broadcasts the resolution.
4. Expiry is handled lazily on any vote read/mutation, and by the disconnect path — no background timer
   is required, so a restart cannot strand an open vote.

Recorded resolution modes: `tallied`, `tie-break`, `expired`, `leader-override`.

---

## 6. AI Concierge pipeline

```
question ──► parse ──► hard constraint filter ──► BM25 retrieve ──► weighted rank ──► generate ──► validate
             │              │                        │                  │              │           │
       budget $25,      budget ≤25,           scores venue         0.4 distance     grounded    citations ⊆
       vegan, 19:30,    all group dietary      text against        0.3 rating      answer      candidates
       1 km             tags, hours+30m        question terms       0.3 headroom    + venueId   else fallback
                        buffer, weekday,
                        radius from anchor
```

Details:

- **Parse** (`questionParser.js`) extracts a budget (`$25`, `under 30`, `25 usd`), dietary words from the
  controlled vocabulary, category hints, a clock time (`7:30pm`, `19:30`), and a distance (`within 2 km`).
- **Filter** (`constraints.js`) applies the group's *union* of dietary tags plus every parsed filter. A
  venue must satisfy **all** of them. Rejections are recorded with the rule that failed, which is why
  the answer can say "Taverna do Fado was excluded: $95 per person is over your $25 ceiling".
- **Retrieve** (`retriever.js`) is BM25 over name, description, tags and category of the surviving
  candidates only — retrieval can never reintroduce a constraint violation.
- **Rank** uses `config.constraints.weights` (0.4 proximity, 0.3 rating, 0.3 budget headroom), and the
  answer reports the weights it used.
- **Generate** (`generator.js`) writes the answer from venue metadata: name, price, dietary tags, hours,
  distance, why it fits, what was excluded and why. With `AI_API_KEY` set, `llm.js` calls an
  OpenAI-compatible endpoint and the model's prose is used — but its citations are validated against the
  candidate set, and any out-of-set `venueId` discards the model output in favour of the deterministic
  answer. The response always reports `engine: 'grounded-template' | 'llm:<model>'`.
- **Response payload** includes `constraints`, `candidateStats`, `rejected[]`, `sources[]`,
  `suggestedVenueId` and `latencyMs`.

The full exchange is persisted as `ChatMessage(msgType='ai_answer')` and broadcast as both
`trip.chat.message` and `trip.ai.suggestion`.

---

## 7. Recommendations

Signals (all from `Interaction`): `pinned`, `liked`, `viewed`, `skipped`, plus ratings from venues and the
traveler's declared `dietaryTags`, `favoriteCategories` and `maxPerPersonBudgetCents`.

Score = weighted sum of

- venue category affinity (from the traveler's own interactions),
- tag affinity (dietary + interest tags),
- spend affinity (does the price sit near the traveler's usual spend),
- item co-occurrence (venues this traveler's peers interacted with),
- normalized popularity, with category diversity quotas applied at selection time.

The rail is scoped to one destination (the trip's), because "recommended for your Lisbon trip" must not
show Porto venues. Evaluated by holding out each traveler's unique liked/pinned venues and scoring
Precision@5 — result 0.55, discussed in [PERFORMANCE.md](PERFORMANCE.md).

`POST /recommendations/feedback` records save/dismiss, so the rail adapts immediately; `npm run train`
recomputes and persists `server/artifacts/recommender.json`.

---

## 8. Security and correctness measures

- JWT access (45 min) + refresh token; `User.tokenVersion` invalidates all tokens on logout/password change.
- Global role (`viewer|planner|admin`) and trip role (`viewer|planner|leader`) are checked by middleware
  **and** re-checked inside socket handlers — there is no path that trusts client-sent roles.
- Admin endpoints require `globalRole === 'admin'`; dataset uploads are validated field-by-field.
- zod validation on every body/query; HTML stripping on free text; 2 MB body cap.
- Rate limits: global, auth (login/register), write endpoints, and a tighter AI limit.
- `helmet` for headers, explicit CORS allow-list (plus loopback in development).
- No secrets in the client bundle; `.env` is git-ignored and documented via `.env.example`.
- Append-only `Event` log for audit: who pinned/moved/locked/voted/asked, with correlation id.

## 9. Failure modes considered

| Failure | Behaviour |
| --- | --- |
| Two planners move the same card | One win, one `stale_version` conflict + resync; no lost update |
| Socket drops mid-session | Client reconnects, rejoins, receives a fresh snapshot; no replay assumption |
| Leader disconnects | Deterministic promotion after grace period, broadcast to the room |
| AI provider down / invalid key | Falls back to the grounded engine, answer still cited; `engine` reflects reality |
| AI returns an invented venue | Citation validation rejects it, deterministic answer used |
| Dataset for a destination missing | Trip creation fails with `unknown_destination` and the available list |
| Vote expires while nobody is online | Lazy expiry on next read/mutation; partial unique index prevents a second open vote |
| Budget edited while items exist | Snapshot recomputed, conflicts re-evaluated, `trip.room.settings` broadcast |
| Embedded Mongo dies (dev only) | Process exits with a clear log line; supervisor restarts, data persisted on disk |
