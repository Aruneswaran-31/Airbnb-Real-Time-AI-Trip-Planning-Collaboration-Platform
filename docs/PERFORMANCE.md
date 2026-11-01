# Measured performance

Everything below was measured on the reference machine (Windows 11, Node 20, single API process,
embedded MongoDB, no tuning) with the harness in `server/scripts/loadtest.js`:

```bash
npm run dev:server        # API up
node server/scripts/loadtest.js http://localhost:4000
```

The harness logs in six real demo accounts, connects six real Socket.io clients to the same Lisbon room
and then:

1. has one client pin items while the other five timestamp receipt (**board fan-out drift**),
2. measures a socket mutation from `emit` to ack (**socket RTT**),
3. fetches the board over REST 20 times (**API latency**),
4. asks the concierge six constraint-bound questions (**AI latency**),
5. fires four simultaneous moves on the same item with the same `expectedVersion`
   (**concurrent-move resolution**).

## Results (6 concurrent travelers, this run)

| Metric | p50 | p95 | max | PRD target |
| --- | --- | --- | --- | --- |
| Board fan-out drift (emit on server → peer receipt) | 2 ms | **5 ms** | 6 ms | p95 < 100 ms |
| Socket mutation RTT (client emit → ack) | 39 ms | 49 ms | 49 ms | – |
| REST board latency | 28 ms | **46 ms** | 46 ms | p95 < 200 ms |
| AI Concierge latency | 7 ms | **9 ms** | 9 ms | p95 < 3000 ms |
| Concurrent moves on one item | – | – | – | exactly 1 accepted |

Samples: 42 drift, 20 REST, 6 AI. `Concurrent moves: 1 accepted, 3 rejected`.

### How to read these numbers

- **Fan-out drift is the number the PRD constrains**, and it is measured from the server's emit to the
  receiving client, not from the mutating client's click. Click-to-peer includes the database write and
  the ack round-trip, which is why the RTT row (39–49 ms) is an order of magnitude larger. Earlier I
  reported click-to-peer as "drift" (≈80 ms) and it was misleading; the harness now separates them.
- **REST board latency** includes Mongo aggregation for the board snapshot plus budget and conflict
  evaluation. 46 ms p95 leaves room for the 200 ms budget.
- **AI latency of 9 ms is the deterministic grounded engine**, not an LLM. It reflects parsing, hard
  filtering, BM25 retrieval, ranking and answer assembly over 28 venues. With `AI_API_KEY` configured,
  add the provider round-trip — realistically 0.8–2.5 s — which is why the target is 3 s and why the
  engine is selected per request rather than globally.
- **Concurrent moves** is the correctness result that matters more than any latency: four clients
  sending `expectedVersion: N` simultaneously produce exactly one accepted write and three
  `stale_version` conflicts with the authoritative item attached.

## Before/after: the concurrency bug the harness caught

| Implementation | 4 simultaneous moves | Consequence |
| --- | --- | --- |
| Read → compare version in JS → save | **4 accepted** | last write wins, two planners silently lose their edit |
| `findOneAndUpdate({ _id, positionVersion: expected })` | **1 accepted, 3 rejected** | compare-and-set in the database; losers resync |

The first version passed the "happy path" move test and failed only under real concurrency. This is the
single most valuable thing the socket suite found.

## Recommendation quality

`npm run train` (offline, evaluated on held-out positive interactions):

| Metric | Value |
| --- | --- |
| Interactions used | 79 |
| Users evaluated | 8 (3 cold-start users skipped: < 3 interactions) |
| Held-out positives per user | 4 |
| K | 5 |
| **Precision@5** | **0.55** (22 hits) |
| PRD target | 0.60 |

Per traveler:

| Traveler | Hits / 5 | Precision@5 |
| --- | --- | --- |
| Foodie Fernanda | 4 | 0.80 |
| Vegan Vikram | 4 | 0.80 |
| Museum Mira | 4 | 0.80 |
| Active Aria | 4 | 0.80 |
| Luxury Lucas | 3 | 0.60 |
| Budget Bella | 2 | 0.40 |
| Arun (trip leader) | 1 | 0.20 |
| Maya | 0 | 0.00 |

Weight profile used: content 0.22, category affinity 0.34, tags 0.16, collaborative 0.12, price 0.06,
popularity 0.10, with proportional category-diversity quotas at selection time.

### Why 0.55 rather than 0.60, honestly

Improvements that were measured and kept:

- scoping the rail to the trip's destination (it previously surfaced unseen Porto venues to a Lisbon
  traveler — a product bug the evaluation exposed),
- modelling declared preferences (`favoriteCategories`, diet tags) as affinity rather than a weak
  content term,
- evaluating only *positive* signal (counts of "skipped views" were inflating the denominator),
- splitting train/held-out on **unique venues** so a venue the user both pinned and liked could not be
  counted in both halves (a leak that was guaranteeing misses),
- category diversity quotas, which lifted mixed-taste travelers (Fernanda, Mira, Aria) without hurting
  specialists.

The remaining gap is structural, not a tuning knob:

- Each traveler has only **4 held-out positives**, so Precision@5 moves in steps of 0.2 per user; one
  hit across the cohort is 0.025.
- 28 Lisbon venues across 4 categories means each category has ~10 candidates, and a traveler who
  interacted with most of a category leaves little unseen signal to rank.
- The two weakest travelers (Arun, Maya) are also the demo accounts with the fewest and most generic
  interactions; with 3 more interactions each, the cohort average crosses 0.6.

I chose to report the honest number rather than tune on the test set or swap in a metric that flatters
the model (e.g. recall@20, or MAP over all interactions). The next real improvement is more interaction
data, not a different score: the trainer is a 40-line offline job and re-runs in under a second.

## What was not measured

- **50 concurrent planners.** The PRD's design target; the harness runs 6. Nothing in the architecture is
  per-room-capacity bound (fan-out is one `io.to(room).emit`, presence is a map), but that is an argument,
  not a measurement.
- **LLM-mode AI latency and cost.** No provider key in this environment.
- **Sustained soak.** The load test runs seconds, not hours; memory growth under long sessions is
  unmeasured. Room presence and conflict state are in-memory maps that would need bounding for a
  multi-day room.
