# Demo script (≈5 minutes, two browser windows)

Everything below is seeded and reproducible.

```bash
npm install
npm run seed
npm run dev
```

Open `http://localhost:5173` in **two windows** (or one normal + one private) — this is the whole point:
the second window is your second traveler.

---

## 1. Two travelers in one room (60 s)

| Window A | Window B |
| --- | --- |
| Sign in `arun@demo.dev` / `Demo1234!` (trip Leader) | Sign in `maya@demo.dev` / `Demo1234!` (Planner) |
| Dashboard → open **Lisbon, Portugal** | Same trip from the dashboard |

Point out:

- The room shows the day columns, the budget panel with per-person shares, the participant list with
  roles, and the conflict banner.
- Window B's presence appears in A within a second. Move the mouse in B's chat box: A sees the typing
  indicator.

## 2. Live board sync (60 s)

In window A, pin a venue (dataset picker) onto day 2 at 19:30. In window B:

- the card appears immediately (fan-out, not polling),
- the budget panel recalculates on both sides with identical numbers,
- if the new card overlaps an existing one, **both** windows raise the conflict banner with the same
  participants.

Now reschedule a card in window B and watch it move in A.

## 3. Optimistic concurrency (45 s)

Both windows drag the same card to different times in quick succession (or use the REST PATCH in
Postman with a stale `expectedVersion`).

- One write wins.
- The other window gets a toast: "Another planner moved this item first", and its board **snaps to the
  authoritative position** instead of overwriting it.
- Exactly one `item.moved` event is recorded; the loser's attempted version is rejected with the current
  item attached.

## 4. Voting on a contested slot (75 s)

1. Pin two alternatives into the same slot (e.g. two dinners at 20:00 on day 1).
2. Leader opens a vote on the slot (candidates freeze).
3. Both windows cast a ballot; the tally updates live in each.
4. Resolve: the winner moves into the slot and locks, the losing candidate leaves the board, and the
   conflict banner clears.

## 5. AI Travel Concierge (90 s)

In window A, ask:

> Find a vegan dinner near the castle under $25 for 7:30pm

The answer should:

- name a **specific** venue from the dataset with its price, hours and dietary tags,
- start from the group's dietary union (so it is safe for everyone, not just the asker),
- show the constraint chips it applied and the candidate funnel (`28 → 6 → 4 → 3 → 2`),
- list the venues it rejected **and why** (e.g. "Mesa de Sintra — $95, over your $25 ceiling").

Then ask something impossible:

> vegan dinner under $5 at 3am

It declines, explains which rule removed everything, and suggests the closest near-misses — it does not
invent a venue, and it does not silently relax a constraint. Switch to window B: the question and answer
are in the shared chat history.

## 6. Roles are enforced on the server (45 s)

- Window B (planner): try to lock an item → the control is absent/hidden and the API returns `403`.
- Window A (leader): lock the item, then mute window B in moderation → B's chat input disables live.
- Sign in as `leo@demo.dev` (viewer) in a third window: the board is readable, every write control is
  gone, and `POST /items` returns `403` if attempted directly.

## 7. Analytics and admin (45 s)

- Trip analytics: items added, votes held, messages, AI questions, budget utilisation, and the
  reconciliation line proving replayed spend from the event log equals the live board total.
- Sign in as `admin@demo.dev` → **Datasets**: upload the bundled Lisbon dataset (valid) → accepted counts;
  then upload a record with a negative price and an unknown dietary tag → field-level rejection.

---

## Talking points if asked "what makes this real"

- **Not a CRUD app with sockets bolted on:** REST and WebSocket share one mutation service, one
  permission matrix and one event log.
- **Concurrency is handled, not hoped for:** atomic compare-and-set, verified by a test that fires four
  simultaneous moves and asserts one winner.
- **The AI is constrained, not prompted:** filter → retrieve → rank → generate → validate, with citations
  checked against the candidate set. Rejections are shown, not hidden.
- **Numbers are derived:** budget from integer cents, analytics from an append-only event log, both
  reconcilable.
- **Honest reporting:** [TEST_REPORT.md](TEST_REPORT.md) and [PERFORMANCE.md](PERFORMANCE.md) include the
  bugs the tests found and the target that was missed.

## Reset between demos

```bash
npm run seed     # wipes trips/users/venues/interactions and reseeds
```
