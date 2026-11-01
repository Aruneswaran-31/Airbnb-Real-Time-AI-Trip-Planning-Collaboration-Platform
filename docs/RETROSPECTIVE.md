# Retrospective

## What this is

A six-day-equivalent build of the "AI Trip War Room": a real-time collaborative itinerary canvas with a
budget engine, contested-slot voting, group chat, and an AI Travel Concierge that is only allowed to
suggest venues satisfying the group's actual constraints. Track A (full-stack), Option B
(MongoDB + Express + React + Node), JavaScript throughout, no TypeScript, as the spec required.

Built from the PRD, not from a template. Decisions that were mine, not the document's, are listed under
"Deviations" — several are deliberate and I would defend them.

---

## What went well

**One mutation path.** REST routes and socket handlers both call `boardService`. That single decision
removed an entire class of divergence bugs: the REST PATCH and the socket `trip.board.move` cannot
disagree about permissions, versioning, conflict re-evaluation or broadcast shape, because there is only
one implementation. When I later added voting and moderation, they slotted into the same pattern.

**Pure domain functions.** `budget.js`, `constraints.js` and `boardState.js` take plain objects and return
plain objects. That is why 25 of the 66 tests need no database and run in milliseconds, and why I could
iterate on the ranking weights without spinning up Mongo.

**Tests that found real bugs.** The socket suite caught the check-then-act race that let four concurrent
moves all succeed. The analytics test caught spend drift after a vote removed candidates. The AI test
caught a generator path that could quote a price from a venue that had been filtered out. None of these
were visible in manual clicking.

**Measured instead of asserted.** Every performance claim in the README has a harness behind it
(`scripts/loadtest.js`), and I fixed the measurement when I found I was reporting the wrong interval.

**Grounded AI by construction.** The concierge filters *before* retrieval, so retrieval cannot reintroduce
a violation, and citations are validated against the candidate set. "Never invents a venue" is a property
of the pipeline, not a prompt instruction.

## What went badly, and what I changed

**1. The concurrency bug.** My first move implementation read the item, compared `positionVersion` in
JavaScript, then saved. It passed the happy-path test. Four simultaneous moves were all accepted, and in
the UI the last writer would silently erase two other planners' edits. Fixing it meant pushing the
version predicate into the update filter so MongoDB does compare-and-set atomically.

Lesson: optimistic concurrency is only optimistic if the *storage layer* performs the comparison. A
JavaScript check is a race, not a guard.

**2. I measured the wrong thing and reported it confidently.** The first "drift" number was ~80 ms and I
started optimising database writes before realising the interval included the mutating client's click,
the write and the ack. The PRD means server emit → peer receipt. Separating the two showed fan-out was
already 5 ms p95 and the real cost was in the ack path. I rewrote the harness to timestamp the server
emit explicitly.

Lesson: define the interval before optimising it, and publish both numbers so a reader can check.

**3. Recommender evaluation was wrong three times.** First it counted explicit skips as relevant.
Then a venue pinned *and* liked by the same user could land in both train and held-out, guaranteeing a
miss. Then the rail was drawing from all destinations, so unseen Porto venues outranked Lisbon venues the
traveler actually knew. Each fix moved the number, and only after all three did the metric mean what I
thought it meant.

Lesson: an offline metric is a piece of software with its own bugs. Audit the split before tuning weights.

**4. Reviewing my own defaults.** I initially set the concierge's hours rule to "venue must be open at the
event time" — which suggests a restaurant that closes at 19:30 for a 19:15 slot 4 km away. Adding the
travel buffer (30 min) made suggestions actually feasible. The PRD did not specify a buffer; the product
did.

## Deviations from the PRD, and why

| Area | PRD | Built | Why |
| --- | --- | --- | --- |
| LLM | "Integrate an LLM for natural-language answers" | Provider-optional: OpenAI-compatible client **plus** a deterministic grounded generator used when no key is present | The environment had no API key and no budget. Making the LLM path optional means the project runs and demos with zero external services, while the integration is real and citation-validated. The limitation is stated everywhere it matters. |
| Vote losers | "Resolve the slot" | Winner is applied and locked; losing candidates are removed from the slot | Leaving rejected candidates on the board re-creates the conflict the vote just resolved. Removing them keeps the board valid. |
| Group diet | Per-user dietary tags | Union of the roster's tags, applied to every food suggestion | A group dinner must be safe for everyone. Individual preferences still exist and feed recommendations. |
| Hours validation | Not specified | Applied inside the concierge, and surfaced as a `hours_violation` conflict on the board | Planning a 19:15 dinner at a 15:00-closing bakery is a logistics bug, not a preference. |
| Leader disconnect | Not specified | Deterministic promotion of the longest-standing online planner after a grace period | The spec's permissions require a leader; a room with none is un-moderatable. |
| Vote expiry | Timer implied | Lazy expiry on read/mutation, plus the disconnect path | A background timer is lost on restart and can strand an open vote. Lazy expiry is restart-safe. |
| Precision@5 | "≥ 0.60" | **0.55**, reported | See [PERFORMANCE.md](PERFORMANCE.md). The gap is data volume, not tuning; I would rather report 0.55 than tune on the held-out set. |
| MongoDB hosting | MongoDB | Embedded `mongodb-memory-server` in development, `MONGODB_URI` in production | Zero-install runnable demo without compromising the real deployment path. |

## What I would do next, in order

1. **More interaction data, then retrain.** Precision@5 is limited by 4 held-out positives per traveler.
   The trainer is a one-second offline job; the bottleneck is signal, not model.
2. **Bound the in-memory maps.** Presence, conflict fingerprints and leader state are process-local. Fine
   for one API instance; with two instances behind a load balancer they need Redis or a sticky socket
   adapter, and the maps need TTLs for multi-day rooms.
3. **Real browser E2E.** Drag-and-drop on the canvas and multi-client synchronisation are exactly the
   behaviours unit tests cannot cover. Playwright with two contexts is the next test investment.
4. **A 50-planner soak.** The architecture makes no per-room-capacity assumption, but six clients is not
   fifty, and sustained sessions would surface memory growth.
5. **Notification fan-out for offline members.** Today a member who was offline misses chat and vote
   events; the snapshot resync covers the board but not the narrative. A per-trip event cursor would let
   reconnecting clients replay what they missed.

## Honest summary

The realtime core, the budget engine, the voting lifecycle, RBAC and the grounded concierge are solid and
covered by tests that caught genuine defects. The recommendation target is missed and documented, the LLM
path is implemented but unexercised in this environment, and the scale claims are conservative because
they are measured at six clients rather than fifty.
