# FlashBook

High-concurrency slot/seat booking system — a learning project. See the SRS document
for full requirements, architecture, and the 8-week phase plan.

## Phase 1: Foundations

- Express API skeleton
- JWT-based auth (register/login)
- Postgres schema migration (`users`, `drops`, `bookings`, `payments`)
- Basic drop CRUD (admin creates/opens/closes a drop, anyone can list/view)

## Phase 2 (this drop): The concurrency engine

- Redis distributed lock (`src/utils/lock.js`) serializing booking attempts per drop
- Booking endpoint (`POST /api/drops/:id/book`) that creates a `held` booking with a TTL
- Defense-in-depth: even without the Redis lock, `UPDATE ... WHERE slots_remaining > 0`
  inside a `SELECT ... FOR UPDATE` transaction prevents overselling on its own -
  Postgres's own row lock is the real correctness guarantee here. The Redis lock's
  job is throughput/fairness (stopping a stampede from all hitting the DB row lock
  at once), not correctness by itself.
- Hold expiry sweep worker (`src/workers/expireHolds.js`) - releases stale holds
  back to the pool every 15s. Naive `setInterval` for now; becomes a proper BullMQ
  job in Phase 5.
- `scripts/concurrency-test.js` - fires many concurrent booking requests at a
  small-capacity drop and verifies exactly the right number succeed, with no
  double-booking and no negative inventory.

## Phase 3 (this drop): The waiting room

- Redis sorted-set queue (`queue:waitingroom:{dropId}`) - `POST /api/drops/:id/queue/join`
  gives you a position; a background worker (`src/workers/admitFromQueue.js`) admits
  the next batch every 3 seconds using `ZPOPMIN`, which is what makes it strict FIFO -
  earliest joiner is always admitted first, regardless of how many people joined in
  the same millisecond.
- Booking now **requires** an active admission window (`admitted:{dropId}:{userId}`
  in Redis, set with a TTL when you're admitted) - you can't skip the line and book
  directly anymore. `GET /api/drops/:id/queue/status` tells you your position or
  whether you've been admitted.
- Per-user rate limiting (`src/middleware/rateLimit.js`) on queue-join and booking,
  so one user spamming a route can't hurt anyone else.
- A circuit breaker (`src/utils/circuitBreaker.js`) wrapping the booking DB path -
  if it starts failing repeatedly, it fails fast for a few seconds instead of piling
  up requests on a struggling database.
- `scripts/queue-fairness-test.js` - proves admission order matches join order.
- `scripts/concurrency-test.js` - updated to go through the waiting room before
  booking, still proving no double-booking under a 40-user stampede for 5 slots.

## Phase 4 (this drop): The idempotent payment state machine

- `POST /api/bookings/:id/pay` - takes a client-generated `idempotency_key` and
  a mock `simulate` outcome (`"success"` / `"failure"` / `"timeout"`, defaults
  to success). This stands in for a real gateway (Stripe, Razorpay) call.
- **The core guarantee**: calling this endpoint many times with the *same*
  `idempotency_key` - whether from a client retry after a network blip, or a
  user mashing the pay button - only ever charges/confirms once. Every repeat
  call just replays the first call's stored result.
- How it works: the whole attempt runs inside a lock keyed on the idempotency
  key itself (`src/utils/lock.js`, same mechanism as the booking lock). Before
  doing anything, it checks `payments` for a row with that key - if one
  exists, it returns that stored outcome immediately and does nothing else.
  Only the very first call for a given key reaches the actual charge-and-update
  logic. The `idempotency_key` column is also `UNIQUE` in Postgres as a second
  line of defense.
- State machine: `pending -> processing -> success` or `pending -> processing
  -> failed`. On success, the booking flips to `confirmed` in the *same*
  transaction as the payment row update - they can't get out of sync. On
  failure, the booking stays `held` so the user can retry with a **new**
  idempotency key before their hold expires.
- `scripts/idempotency-test.js` - fires 8 concurrent payment requests with the
  same idempotency key and proves exactly one payment record gets created,
  and that a second, different key against an already-confirmed booking is
  correctly rejected.

## Phase 5 (this drop): Background jobs and the frontend

**Backend - BullMQ job queue** (`src/queues/`):
- Three queues: `confirmation`, `analytics`, `cleanup` - each with its own
  worker (`src/queues/workers.js`)
- On a successful payment, `confirmation` and `analytics` jobs get enqueued
  and processed asynchronously, never delaying the HTTP response
- The old `setInterval`-based hold-expiry sweep (Phase 2) is replaced by a
  BullMQ **repeatable job** on the `cleanup` queue, scheduled every 15s -
  same logic, now running through real job infrastructure with retries
- BullMQ requires a real Redis server (not a mock) since it uses Lua scripts
  internally - if you're testing locally without your own Redis yet, note
  that `ioredis-mock` will NOT work for this phase

**Frontend** - a separate Next.js app, see `flashbook-phase5-frontend.zip`
and its own README for the UI, the custom animated components (flap
counter, splash cursor, flowing menu, curved loop, dome gallery, pixel
transition), and setup instructions.

## Phase 6 (this drop): Load testing and hardening

- `load-tests/k6-flash-sale.js` - a k6 script simulating a real flash-sale
  stampede (200 virtual users, 500 booking attempts) against a small-slot
  drop. This is different from the Phase 2-4 correctness tests: those run
  fine against a mocked database because they're testing *logic*; this one
  needs to run against your *real* local Postgres and Redis, because it's
  measuring actual latency and throughput, which a mock can't represent
  meaningfully.
- `load-tests/setup-drop.js` - creates the drop to test against and prints
  the exact `k6 run` command to use.
- **A real hardening fix, not just a warning**: the Postgres pool
  (`src/config/db.js`) now explicitly sets `max: 20` (was defaulting to
  node-postgres's built-in 10) - 200 concurrent virtual users would have
  mostly queued waiting for a free connection otherwise. Configurable via
  `PG_POOL_MAX`.
- Full instructions, and what the results should look like, in
  `load-tests/README.md`.

What's **not** here yet: deployment (Phase 7). See the SRS for the full plan.

### Running the tests yourself

Once your server is running (`npm run dev`) in another terminal:
```
npm run test:concurrency
```
Registers 40 users, creates a drop with only 5 slots, has everyone join the
waiting room, waits for admission, then books - checking that exactly 5
succeeded and 35 got a clean "sold out" response, with `slots_remaining`
ending at exactly 0. This takes about 25-40 seconds since it's waiting on
real admission cycles (5 people admitted every 3 seconds).

```
npm run test:fairness
```
Registers 12 users, joins them to the queue strictly in order, and verifies
nobody who joined later gets admitted before someone who joined earlier.

```
npm run test:idempotency
```
Creates one held booking, then fires 8 concurrent payment requests with the
*same* idempotency key - checks that exactly one payment record was created
and the booking was confirmed exactly once. Also checks that a second,
different idempotency key against the same (now-confirmed) booking is
correctly rejected rather than double-charging.

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your own values:
   ```
   cp .env.example .env
   ```
   - `DATABASE_URL` — your Postgres connection string (Supabase free tier works)
   - `JWT_SECRET` — any long random string

3. Run the migration to create tables:
   ```
   npm run migrate
   ```

4. Start the dev server:
   ```
   npm run dev
   ```

5. Check it's alive:
   ```
   curl localhost:4000/health
   ```

## API so far

| Method | Route | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/register` | none | Create an account |
| POST | `/api/auth/login` | none | Get a JWT |
| GET | `/api/drops` | none | List all drops |
| GET | `/api/drops/:id` | none | Get one drop |
| POST | `/api/drops` | admin | Create a drop |
| PATCH | `/api/drops/:id/status` | admin | draft → live → closed |
| POST | `/api/drops/:id/queue/join` | user | Join the waiting room for a live drop |
| GET | `/api/drops/:id/queue/status` | user | Check your position or admission status |
| POST | `/api/drops/:id/book` | user (must be admitted) | Attempt to book one slot |
| POST | `/api/bookings/:id/pay` | booking owner | Pay for a held booking (idempotent) |
| GET | `/api/bookings/:id` | owner or admin | Get one booking's status |

Note: the first user you register is a normal `user`, not `admin`. For now,
promote yourself manually in the DB while testing:
```sql
UPDATE users SET role = 'admin' WHERE email = 'you@example.com';
```
(We'll build a proper admin-invite flow later if it's ever needed — out of scope for a
solo learning project.)
