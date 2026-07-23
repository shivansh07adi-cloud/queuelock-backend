// k6 load test: simulates a real flash-sale stampede against a drop with a
// small, fixed number of slots. This is the Phase 6 deliverable from the
// SRS - proving the system holds up (and stays correct) under genuine load,
// not just the smaller in-process tests from earlier phases.
//
// WHY THIS NEEDS TO RUN AGAINST YOUR REAL LOCAL SETUP:
// The correctness tests from Phases 2-4 (npm run test:concurrency, etc.)
// prove the LOGIC is right. This test proves the SYSTEM holds up under real
// network load, real Postgres connection pooling, and real Redis round-trips -
// numbers that are meaningless against an in-memory database substitute.
// Run this against your actual `npm run dev` server with a real Postgres
// and Redis behind it.
//
// INSTALL k6: https://k6.io/docs/get-started/installation/
//   macOS:   brew install k6
//   Linux:   see the docs above (apt repo needs to be added first)
//   Windows: winget install k6 --source winget
//
// SETUP BEFORE RUNNING:
//   1. Start your server: npm run dev
//   2. Create a drop with a KNOWN small slot count via the admin API or the
//      frontend admin page, flip it to "live", and note its ID.
//   3. Set DROP_ID below (or pass via -e DROP_ID=... on the command line).
//   4. Set TOTAL_SLOTS to match exactly what you created.
//
// RUN:
//   k6 run -e DROP_ID=<your-drop-id> -e TOTAL_SLOTS=20 load-tests/k6-flash-sale.js
//
// WHAT TO LOOK AT WHEN IT FINISHES:
//   - booking_success counter should equal TOTAL_SLOTS, no more, no less
//   - sold_out counter should equal (total booking attempts - TOTAL_SLOTS)
//   - http_req_duration p(95) - your actual p95 latency under load, the
//     number that goes in your resume bullet
//   - http_req_failed rate should be at or near 0% (429s/409s from correct
//     rejection logic don't count as "failed" here - see thresholds below)

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:4000";
const DROP_ID = __ENV.DROP_ID;
const TOTAL_SLOTS = parseInt(__ENV.TOTAL_SLOTS || "20", 10);

const bookingSuccess = new Counter("booking_success");
const soldOut = new Counter("sold_out");
const otherErrors = new Counter("unexpected_errors");
const bookingLatency = new Trend("booking_latency_ms");

export const options = {
  scenarios: {
    stampede: {
      executor: "shared-iterations",
      vus: 200, // 200 virtual users hitting at once
      iterations: 500, // 500 total attempts spread across them
      maxDuration: "2m",
    },
  },
  thresholds: {
    // We WANT some requests to correctly fail with 409 (sold out) or 429
    // (rate limited / high contention) - that's the system working as
    // designed. This threshold is about requests failing for the WRONG
    // reasons (500s, timeouts, connection errors).
    unexpected_errors: ["count==0"],
    http_req_duration: ["p(95)<3000"], // adjust based on your machine
  },
};

function jsonHeaders(token) {
  return {
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  };
}

export default function () {
  if (!DROP_ID) {
    throw new Error("Set DROP_ID via -e DROP_ID=<id> - see file header for setup steps");
  }

  const email = `loadtest-${__VU}-${__ITER}-${Date.now()}@example.com`;
  const password = "password123";

  http.post(`${BASE_URL}/api/auth/register`, JSON.stringify({ email, password }), jsonHeaders());
  const loginRes = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email, password }),
    jsonHeaders()
  );
  const token = loginRes.json("token");
  if (!token) {
    otherErrors.add(1);
    return;
  }

  // Join the waiting room, then poll status until admitted (or give up after
  // a reasonable number of tries - a real stampede takes a few admission
  // cycles to clear everyone).
  http.post(`${BASE_URL}/api/drops/${DROP_ID}/queue/join`, null, jsonHeaders(token));

  let admitted = false;
  for (let i = 0; i < 15 && !admitted; i++) {
    sleep(1);
    const statusRes = http.get(`${BASE_URL}/api/drops/${DROP_ID}/queue/status`, jsonHeaders(token));
    admitted = statusRes.json("admitted") === true;
  }
  if (!admitted) {
    otherErrors.add(1);
    return;
  }

  const start = Date.now();
  const bookRes = http.post(`${BASE_URL}/api/drops/${DROP_ID}/book`, "{}", jsonHeaders(token));
  bookingLatency.add(Date.now() - start);

  if (bookRes.status === 201) {
    bookingSuccess.add(1);
  } else if (bookRes.status === 409) {
    soldOut.add(1);
  } else if (bookRes.status === 429) {
    // correctly rate-limited/lock-contended - not a bug, don't count as error
  } else {
    otherErrors.add(1);
    console.error(`Unexpected booking status ${bookRes.status}: ${bookRes.body}`);
  }

  check(bookRes, {
    "booking response is 201, 409, or 429": (r) => [201, 409, 429].includes(r.status),
  });
}

export function handleSummary(data) {
  const successCount = data.metrics.booking_success ? data.metrics.booking_success.values.count : 0;
  const soldOutCount = data.metrics.sold_out ? data.metrics.sold_out.values.count : 0;
  const errorCount = data.metrics.unexpected_errors ? data.metrics.unexpected_errors.values.count : 0;

  console.log("\n=== FLASHBOOK LOAD TEST SUMMARY ===");
  console.log(`Configured total slots: ${TOTAL_SLOTS}`);
  console.log(`Successful bookings:    ${successCount}  (should equal ${TOTAL_SLOTS})`);
  console.log(`Correctly sold-out:     ${soldOutCount}`);
  console.log(`Unexpected errors:      ${errorCount}  (should be 0)`);
  console.log(
    `Result: ${successCount === TOTAL_SLOTS && errorCount === 0 ? "PASS - no overselling under real load" : "CHECK OUTPUT - something doesn't match expectations"}`
  );

  return {
    stdout: "\n(see summary above)\n",
  };
}
