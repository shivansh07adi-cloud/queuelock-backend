const pool = require("../config/db");
const redis = require("../config/redis");
const {
  ADMIT_BATCH_SIZE,
  ADMISSION_WINDOW_MS,
  queueKey,
  admittedKey,
} = require("../controllers/queue.controller");

// Every tick: find drops that are live, and for each one, admit the next
// batch of people waiting in line. ZPOPMIN pulls the lowest-score (earliest
// joined) members first, which is what makes this FIFO - first in, first
// admitted, regardless of how many people joined in the same millisecond.
async function admitNextBatch() {
  const liveDrops = await pool.query("SELECT id FROM drops WHERE status = 'live'");

  for (const drop of liveDrops.rows) {
    const key = queueKey(drop.id);
    const queueLength = await redis.zcard(key);
    if (queueLength === 0) continue;

    // ZPOPMIN with a count returns [member, score, member, score, ...]
    const popped = await redis.zpopmin(key, ADMIT_BATCH_SIZE);
    const admittedUserIds = [];
    for (let i = 0; i < popped.length; i += 2) {
      admittedUserIds.push(popped[i]);
    }

    for (const userId of admittedUserIds) {
      await redis.set(admittedKey(drop.id, userId), "1", "PX", ADMISSION_WINDOW_MS);
    }

    if (admittedUserIds.length > 0) {
      console.log(`Admitted ${admittedUserIds.length} user(s) for drop ${drop.id}`);
    }
  }
}

function startQueueAdmission(intervalMs = 3000) {
  const handle = setInterval(() => {
    admitNextBatch().catch((err) => console.error("Queue admission failed:", err.message));
  }, intervalMs);
  handle.unref();
  return handle;
}

module.exports = { admitNextBatch, startQueueAdmission };
