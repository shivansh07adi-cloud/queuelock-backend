# Load testing (Phase 6)

The tests from Phases 2-4 (`npm run test:concurrency`, etc.) prove the
booking logic is *correct* under concurrency - they run fine against a
mocked database because correctness doesn't depend on real infrastructure
speed. This phase is different: it proves the system holds up under real
*load* - real network round-trips, real Postgres connection pooling, real
Redis latency - which only means something against your actual local setup.

## What you need

- Your backend running for real (`npm run dev`) against a real Postgres and
  real Redis (not the in-memory substitutes used for the earlier phase's
  automated tests)
- [k6](https://k6.io/docs/get-started/installation/) installed
  (`brew install k6` on macOS, see the docs link for other platforms)

## Running it

**1. Set up a drop to hammer:**
```
node load-tests/setup-drop.js
```
This creates an admin account and prints a `UPDATE users SET role =
'admin'...` SQL statement. Run that against your database, then re-run:
```
PROMOTED=1 node load-tests/setup-drop.js
```
It'll create a live drop with 20 slots and print the exact `k6 run` command
to use, including the drop's ID.

**2. Run the load test** (copy the command the setup script printed, or
build it yourself):
```
k6 run -e DROP_ID=<your-drop-id> -e TOTAL_SLOTS=20 load-tests/k6-flash-sale.js
```

This spins up 200 virtual users making 500 total booking attempts against
your 20-slot drop - each one registering, logging in, joining the waiting
room, waiting for admission, and attempting to book.

## Reading the results

k6 prints a summary at the end. The custom summary block (near the bottom)
is the one that matters most:

```
=== FLASHBOOK LOAD TEST SUMMARY ===
Configured total slots: 20
Successful bookings:    20   (should equal 20)
Correctly sold-out:     480
Unexpected errors:      0    (should be 0)
Result: PASS - no overselling under real load
```

Also worth looking at in the full k6 output:
- **`http_req_duration` p(95)** - your actual 95th-percentile latency under
  load. This is the number for a resume bullet like "p95 booking latency
  under Xms with 200 concurrent users."
- **`http_req_failed`** - should be low. Note that 409 (sold out) and 429
  (rate limited) responses are *correct* behavior, not failures - the script
  only counts genuine 500s/timeouts as `unexpected_errors`.

## If something looks wrong

- **`unexpected_errors` > 0**: check your server logs for the actual error.
  The default Postgres pool is already sized to 20 connections
  (`PG_POOL_MAX` env var, see `src/config/db.js`) to handle this test's 200
  virtual users reasonably - if you push well past that (toward the SRS's
  1,000-10,000 target), you may need to raise it further, and check whether
  your Postgres provider's free tier has its own hard connection cap.
- **Successful bookings ≠ TOTAL_SLOTS**: this would mean a real correctness
  bug under real load that the mocked tests didn't catch - worth reporting
  back so it can be fixed directly, since that's exactly what this phase
  exists to catch.
- **p95 latency much higher than expected**: could be normal for a free-tier
  Redis/Postgres (there's real network latency to Upstash/Supabase vs.
  local), or could point at something worth profiling. Try running against
  fully local Postgres + Redis (Docker) first to get a baseline without
  network latency in the mix, then compare against your deployed free-tier
  services.

## Tuning the test

Edit the constants near the top of `k6-flash-sale.js`:
- `vus` / `iterations` in the `options.scenarios.stampede` block - scale up
  toward the SRS's target of 1,000-10,000 concurrent attempts once you've
  confirmed the smaller run passes cleanly
- `TOTAL_SLOTS` via the `-e` flag - test different scarcity ratios
