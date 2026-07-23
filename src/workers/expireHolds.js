// NOTE: as of Phase 5, this naive setInterval sweep has been replaced by a
// BullMQ repeatable job (see src/queues/workers.js - the "cleanup" worker,
// scheduled in src/index.js). Kept here for reference since it's a
// perfectly valid approach for a smaller project and useful to compare
// against the BullMQ version.
const pool = require("../config/db");

// Safety net: any 'held' booking whose expires_at has passed gets released back
// to the pool. This matters because a user can close their tab mid-payment, or
// a payment can hang - without this sweep those slots would be locked forever.
//
// NOTE: this is a naive setInterval sweep, on purpose, for Phase 2. It gets
// replaced with a proper scheduled BullMQ job in Phase 5. Don't over-build this
// yet - the point right now is proving the expiry logic is correct, not that
// the scheduling mechanism is production-grade.
async function sweepExpiredHolds() {
  const client = await pool.connect();
  try {
    const expired = await client.query(
      `SELECT id, drop_id FROM bookings WHERE status = 'held' AND expires_at < now()`
    );

    for (const booking of expired.rows) {
      await client.query("BEGIN");
      try {
        // The "AND status = 'held'" guard matters: it stops this sweep from
        // undoing a booking that got confirmed in the split second between
        // the SELECT above and this UPDATE.
        const updated = await client.query(
          `UPDATE bookings SET status = 'expired' WHERE id = $1 AND status = 'held' RETURNING id`,
          [booking.id]
        );
        if (updated.rows.length > 0) {
          await client.query(
            `UPDATE drops SET slots_remaining = slots_remaining + 1 WHERE id = $1`,
            [booking.drop_id]
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        console.error("Error expiring booking", booking.id, err.message);
      }
    }

    if (expired.rows.length > 0) {
      console.log(`Hold sweep: expired ${expired.rows.length} stale booking(s)`);
    }
  } finally {
    client.release();
  }
}

function startHoldExpirySweep(intervalMs = 15000) {
  const handle = setInterval(() => {
    sweepExpiredHolds().catch((err) => console.error("Hold sweep failed:", err.message));
  }, intervalMs);
  handle.unref(); // don't let this timer keep the process alive on its own
  return handle;
}

module.exports = { sweepExpiredHolds, startHoldExpirySweep };
