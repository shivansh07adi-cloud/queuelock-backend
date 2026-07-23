const pool = require("../config/db");
const redis = require("../config/redis");
const { withLock } = require("../utils/lock");
const { CircuitBreaker } = require("../utils/circuitBreaker");
const { admittedKey } = require("./queue.controller");

const HOLD_TTL_MS = 5 * 60 * 1000; // 5 minutes to complete payment before the hold expires
const LOCK_TTL_MS = 3000; // how long one request can hold the drop's lock
const LOCK_RETRIES = 8; // ~1.2s of retrying before giving up under contention

// One breaker per process, shared across all booking attempts - it's tracking
// the health of "the database path for bookings" as a whole, not per-drop.
const bookingBreaker = new CircuitBreaker({ failureThreshold: 5, windowSize: 20, cooldownMs: 5000 });

// The core of Phase 2/3: attempt to book one slot on a drop without letting two
// concurrent requests both succeed for the last remaining slot, and without
// letting someone skip the waiting room's line.
//
// Layers of protection, on purpose:
//  1. Admission check (Phase 3) - you must have come through the waiting room
//     and currently hold an admission window before you're even allowed to try.
//  2. Redis lock (lock:drop:{dropId}) - serializes booking attempts for this
//     drop so only one request at a time even reaches the database step.
//  3. The UPDATE ... WHERE slots_remaining > 0 pattern - Postgres takes a row
//     lock during this UPDATE, so even if the Redis layer were ever bypassed,
//     the database itself still can't oversell. This is the optimistic-lock /
//     defense-in-depth fallback from the SRS.
//  4. Circuit breaker - if the database path starts failing repeatedly (e.g.
//     connection pool exhausted, DB unreachable), stop hammering it and fail
//     fast for a few seconds instead of piling up requests during an outage.
async function createBooking(req, res) {
  const { id: dropId } = req.params;
  const userId = req.user.id;

  try {
    const admitted = await redis.get(admittedKey(dropId, userId));
    if (!admitted) {
      return res.status(403).json({
        error: "You haven't been admitted yet - join the waiting room first",
      });
    }

    const outcome = await bookingBreaker
      .exec(() =>
        withLock(
          `lock:drop:${dropId}`,
          { ttlMs: LOCK_TTL_MS, retries: LOCK_RETRIES },
          () => attemptBooking(dropId, userId)
        )
      )
      .catch((err) => {
        if (err.code === "LOCK_TIMEOUT") {
          return { status: 429, body: { error: "High demand right now - try again in a moment" } };
        }
        if (err.code === "CIRCUIT_OPEN") {
          return { status: 503, body: { error: "Booking is temporarily unavailable - please try again shortly" } };
        }
        throw err;
      });

    // Whether it succeeded or hit sold-out, this admission window is used up -
    // there's no point in someone retrying against the same drop with a stale
    // admission, and it keeps the waiting room moving for other people.
    await redis.del(admittedKey(dropId, userId));

    return res.status(outcome.status).json(outcome.body);
  } catch (err) {
    console.error("createBooking error:", err);
    return res.status(500).json({ error: "Something went wrong creating the booking" });
  }
}

async function attemptBooking(dropId, userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const dropResult = await client.query(
      "SELECT slots_remaining, per_user_limit, status FROM drops WHERE id = $1 FOR UPDATE",
      [dropId]
    );

    if (dropResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return { status: 404, body: { error: "Drop not found" } };
    }

    const drop = dropResult.rows[0];

    if (drop.status !== "live") {
      await client.query("ROLLBACK");
      return { status: 409, body: { error: "This drop is not currently open for booking" } };
    }

    const existing = await client.query(
      `SELECT COUNT(*)::int AS count FROM bookings
       WHERE drop_id = $1 AND user_id = $2 AND status IN ('held', 'confirmed')`,
      [dropId, userId]
    );
    if (existing.rows[0].count >= drop.per_user_limit) {
      await client.query("ROLLBACK");
      return { status: 409, body: { error: "You've already reached the per-user limit for this drop" } };
    }

    // The WHERE slots_remaining > 0 guard is the defense-in-depth layer -
    // this UPDATE can never take slots_remaining below zero, regardless of
    // what happened above.
    const updateResult = await client.query(
      `UPDATE drops SET slots_remaining = slots_remaining - 1, version = version + 1
       WHERE id = $1 AND slots_remaining > 0
       RETURNING slots_remaining`,
      [dropId]
    );

    if (updateResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return { status: 409, body: { error: "Sold out" } };
    }

    const expiresAt = new Date(Date.now() + HOLD_TTL_MS);
    const bookingResult = await client.query(
      `INSERT INTO bookings (drop_id, user_id, status, expires_at)
       VALUES ($1, $2, 'held', $3)
       RETURNING *`,
      [dropId, userId, expiresAt]
    );

    await client.query("COMMIT");
    return { status: 201, body: bookingResult.rows[0] };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function getBooking(req, res) {
  const { id } = req.params;
  try {
    const result = await pool.query("SELECT * FROM bookings WHERE id = $1", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Booking not found" });
    }
    const booking = result.rows[0];
    if (booking.user_id !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Not your booking" });
    }
    return res.json(booking);
  } catch (err) {
    console.error("getBooking error:", err);
    return res.status(500).json({ error: "Something went wrong fetching the booking" });
  }
}

module.exports = { createBooking, getBooking };
