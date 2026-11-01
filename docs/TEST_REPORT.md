# Test report

```
$ npm test
Test Suites: 7 passed, 7 total
Tests:       66 passed, 66 total
Snapshots:   0 total
Time:        35.7 s
```

Runner: Jest 29 (`server/jest.config.js`), `--runInBand`, against a real embedded MongoDB per suite and
a real Express app via Supertest. Socket tests open real `socket.io-client` connections to an
ephemeral server port. No mocking of the database, the auth middleware or the realtime layer — the
tests exercise the same code paths the running app uses.

Run it with:

```bash
npm test
```

---

## Coverage by suite

### `budget.test.js` — exact money arithmetic (11 tests)

| Test | Proves |
| --- | --- |
| even split of an indivisible total still sums to the total | largest-remainder distribution leaves no lost cent |
| remainder distribution is deterministic across many totals | same input ⇒ same shares, across hundreds of totals |
| weighted split respects weights and stays exact | per-member weights change shares without breaking the sum |
| zero weights degrade to an even split instead of dividing by zero | no NaN, no crash |
| computes per-person subtotal, group total and remaining budget | the three numbers the UI shows agree |
| per-person shares always reconcile to the group total | invariant across randomized rosters |
| weighted mode allocates by member weight exactly | weighted mode invariant |
| flags a budget breach and per-traveler ceiling breaches | conflict inputs are correct |
| empty board produces a zero-spend picture | no divide-by-zero on an empty trip |
| replayed spend from the event log matches the live board subtotal | append-only log is a faithful audit trail |

No floating-point money anywhere: every assertion compares integer cents.

### `boardState.test.js` — lifecycle and permissions (15 tests)

- `drafting → voting | locked`; `locked → drafting` only with leader authority; illegal transitions throw.
- A stage change bumps `positionVersion`.
- Viewers are read-only; a locked room blocks planners but not the leader; locked items accept leader
  overrides but reject planners; items frozen in a live vote cannot be moved by planners.
- Slot validation: day outside the trip, end before start, malformed `HH:MM`.
- Optimistic concurrency: current version accepted and bumped, stale version refused **with the current
  state attached**, `expectedVersion` mandatory, and a viewer refused even with the right version.

### `constraints.test.js` — the concierge's hard rules (9 tests)

- Budget ceiling, dietary compatibility requiring **every** group tag, hours containing the slot **plus
  the 30-minute travel buffer**, closed weekdays, proximity radius on real haversine distance, and
  exclusion of already-pinned venues.
- Weighted ranking: the score breakdown equals the configured 0.4 / 0.3 / 0.3 weights, and a closer,
  cheaper, better-rated venue outranks a weaker one.
- **Constraint compliance across 20 simulated requests**: every returned candidate satisfies every active
  constraint, and each answer is produced in under 3 seconds.

### `ai.test.js` — grounded generation (8 tests)

- Question parsing: budget (`$25`), dietary tags, category, clock time, radii in km/miles, durations.
- Suggests a venue satisfying budget + dietary + hours + proximity simultaneously.
- **Group dietary tags are enforced for every member**, even when the question does not mention food.
- **Never fabricates a venue, price or opening hour** — every citation exists in the dataset and every
  quoted number matches the record.
- Declines gracefully with reasons when nothing qualifies, and explains a budget ceiling that excludes
  everything.
- 20 requests: 100% constraint-valid, latency bound held.

### `rbac.test.js` — server-side authorisation (13 tests)

- Unauthenticated access rejected; invalid token rejected; refresh tokens rotate a working session.
- Viewer cannot pin (403), cannot ask the AI (403), but **can** read the board.
- Planner cannot lock an item (leader only); leader can lock and the state machine applies; planner can
  unpin only after the leader unlocks.
- Non-member cannot read a trip.
- Planner cannot manage the venue dataset; admin upload rejects invalid records with **field-level
  errors**; admin upload accepts a valid venue.

Every one of these is enforced in middleware, not in the client.

### `sockets.test.js` — realtime behaviour (7 tests)

| Test | Proves |
| --- | --- |
| two planners join the same room and receive the full board snapshot | join semantics, roster, snapshot shape |
| a pin fans out to the other client within the 100 ms drift target | per-event fan-out, not polling |
| concurrent moves on the same item resolve deterministically and notify the loser | exactly one accepted; loser gets `trip.board.conflict` + resync |
| chat messages and typing indicators fan out | chat path |
| sync ping returns a pong with server timing | clock sync for latency display |
| leader disconnect promotes the longest-standing online planner | room never left un-moderatable |
| a reconnecting client receives a fresh snapshot with the current board | reconnect recovery, no stale state |

### `analytics.test.js` — derivation and voting (5 tests)

- Session analytics are derived from the event log and reconcile with the live board (drift = 0).
- A vote opens, tallies and applies the winner, removing losing candidates from the board.
- A vote with fewer than two candidates is rejected.
- A slot can only have one open vote (enforced by a partial unique index).

---

## Failures found and fixed during development

These are the reasons the suite exists — each was a real bug caught before shipping.

| Failure | Root cause | Fix |
| --- | --- | --- |
| 4 concurrent moves were **all accepted** | read → compare in JS → write (check-then-act race) | compare-and-set inside `findOneAndUpdate`'s filter |
| Fan-out latency ~2× target in the socket test | awaiting analytics/interaction writes before emitting | broadcast first, let append-only analytics trail |
| `409` response lacked current state, client UI drifted | conflict returned only a code | return `currentItem` + push `trip.sync.resync` to the losing socket |
| Vote could be opened twice for one slot under load | application-level check only | partial unique index on `(tripId, slot, status:'open')` |
| Budget totals off by cents on some rosters | float arithmetic and naive rounding | integer cents + largest-remainder allocation |
| Recommender Precision@5 read 0.225 then 0.575 | evaluation counted skipped views as relevant; then a pinned+liked venue could split across train/held-out | score positive interactions only; split on unique venues; scope the rail to the destination |

## Known gaps

- No browser end-to-end automation (Playwright/Cypress). The UI was verified manually in a browser:
  login → dashboard → trip room → live board sync with a second client → budget panel → chat → AI
  Concierge answer with citations. Voting, moderation and admin dataset upload were verified through
  the API and its tests, not clicked through in the UI.
- No test runs against a real external MongoDB or a real LLM provider; both are optional integrations.
- Load-tested at 6 concurrent travelers (see [PERFORMANCE.md](PERFORMANCE.md)), not 50.
- No visual regression or accessibility audit; contrast and focus states were reviewed manually.
