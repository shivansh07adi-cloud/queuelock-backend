const pool = require("../config/db");
const redis = require("../config/redis");

// How many people get admitted every admission cycle, and how long an
// admission lasts before it expires if the user doesn't act on it. In a real
// system ADMIT_BATCH_SIZE would track actual remaining slots; here it's a
// fixed constant to keep the learning project's core logic easy to follow.
const ADMIT_BATCH_SIZE = 5;
const ADMIT_INTERVAL_MS = 3000;
const ADMISSION_WINDOW_MS = 2 * 60 * 1000; // 2 minutes to act once admitted

function queueKey(dropId) {
  return `queue:waitingroom:${dropId}`;
}
function seqKey(dropId) {
  return `queue:seq:${dropId}`;
}
function admittedKey(dropId, userId) {
  return `admitted:${dropId}:${userId}`;
}

async function joinQueue(req, res) {
  const { id: dropId } = req.params;
  const userId = req.user.id;

  try {
    const dropResult = await pool.query("SELECT status FROM drops WHERE id = $1", [dropId]);
    if (dropResult.rows.length === 0) {
      return res.status(404).json({ error: "Drop not found" });
    }
    if (dropResult.rows[0].status !== "live") {
      return res.status(409).json({ error: "This drop is not currently open" });
    }

    // Already admitted from an earlier join? Tell them to go book instead of
    // re-queueing them behind everyone else.
    const alreadyAdmitted = await redis.get(admittedKey(dropId, userId));
    if (alreadyAdmitted) {
      return res.json({ admitted: true, message: "You're already admitted - go ahead and book" });
    }

    // Already in the queue? Return their current position instead of adding
    // a second entry (ZADD with the same member just updates the score, but
    // we don't want to push them to the back of the line on a duplicate call).
    const existingScore = await redis.zscore(queueKey(dropId), userId);
    if (existingScore === null) {
      const seq = await redis.incr(seqKey(dropId));
      await redis.zadd(queueKey(dropId), seq, userId);
    }

    const position = await redis.zrank(queueKey(dropId), userId); // 0-based
    const estimatedWaitMs = Math.ceil((position + 1) / ADMIT_BATCH_SIZE) * ADMIT_INTERVAL_MS;

    return res.status(202).json({
      admitted: false,
      position: position + 1,
      estimatedWaitMs,
    });
  } catch (err) {
    console.error("joinQueue error:", err);
    return res.status(500).json({ error: "Something went wrong joining the queue" });
  }
}

async function queueStatus(req, res) {
  const { id: dropId } = req.params;
  const userId = req.user.id;

  try {
    const admitted = await redis.get(admittedKey(dropId, userId));
    if (admitted) {
      return res.json({ admitted: true });
    }

    const position = await redis.zrank(queueKey(dropId), userId);
    if (position === null) {
      return res.status(404).json({ error: "You're not in the queue for this drop - join first" });
    }

    const estimatedWaitMs = Math.ceil((position + 1) / ADMIT_BATCH_SIZE) * ADMIT_INTERVAL_MS;
    return res.json({ admitted: false, position: position + 1, estimatedWaitMs });
  } catch (err) {
    console.error("queueStatus error:", err);
    return res.status(500).json({ error: "Something went wrong checking your queue status" });
  }
}

module.exports = {
  joinQueue,
  queueStatus,
  ADMIT_BATCH_SIZE,
  ADMIT_INTERVAL_MS,
  ADMISSION_WINDOW_MS,
  queueKey,
  admittedKey,
};
