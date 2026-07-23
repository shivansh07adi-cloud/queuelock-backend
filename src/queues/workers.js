const { Worker } = require("bullmq");
const pool = require("../config/db");
const { connection } = require("../queues");

// Confirmation job: stands in for sending a real email. Just logs, on
// purpose - swapping in a real email provider later only touches this file.
function startConfirmationWorker() {
  return new Worker(
    "confirmation",
    async (job) => {
      const { bookingId, userEmail, dropName } = job.data;
      console.log(`[confirmation] Booking ${bookingId} confirmed for ${userEmail} - "${dropName}"`);
      // A real implementation would call an email provider here.
    },
    connection
  );
}

// Analytics job: records a lightweight event. In a bigger system this would
// write to a dedicated analytics store; here it just logs, since the point
// of this phase is proving the async job pipeline works, not building a
// full analytics pipeline.
function startAnalyticsWorker() {
  return new Worker(
    "analytics",
    async (job) => {
      const { event, dropId, userId } = job.data;
      console.log(`[analytics] event=${event} drop=${dropId} user=${userId}`);
    },
    connection
  );
}

// Cleanup job: an on-demand version of the same expiry sweep from Phase 2,
// now triggered by BullMQ's repeatable jobs instead of a raw setInterval.
// This replaces the naive timer from src/workers/expireHolds.js.
function startCleanupWorker() {
  return new Worker(
    "cleanup",
    async () => {
      const client = await pool.connect();
      try {
        const expired = await client.query(
          `SELECT id, drop_id FROM bookings WHERE status = 'held' AND expires_at < now()`
        );
        let releasedCount = 0;
        for (const booking of expired.rows) {
          await client.query("BEGIN");
          try {
            const updated = await client.query(
              `UPDATE bookings SET status = 'expired' WHERE id = $1 AND status = 'held' RETURNING id`,
              [booking.id]
            );
            if (updated.rows.length > 0) {
              await client.query(
                `UPDATE drops SET slots_remaining = slots_remaining + 1 WHERE id = $1`,
                [booking.drop_id]
              );
              releasedCount++;
            }
            await client.query("COMMIT");
          } catch (err) {
            await client.query("ROLLBACK");
            console.error("Error expiring booking", booking.id, err.message);
          }
        }
        if (releasedCount > 0) {
          console.log(`[cleanup] Released ${releasedCount} expired hold(s)`);
        }
      } finally {
        client.release();
      }
    },
    connection
  );
}

function startAllWorkers() {
  const workers = [startConfirmationWorker(), startAnalyticsWorker(), startCleanupWorker()];
  workers.forEach((w) => {
    w.on("failed", (job, err) => {
      console.error(`Job ${job?.name} (${job?.id}) failed:`, err.message);
    });
  });
  return workers;
}

module.exports = { startAllWorkers };
