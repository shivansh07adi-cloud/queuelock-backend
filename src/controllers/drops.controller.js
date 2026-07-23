const pool = require("../config/db");

// Admin-only: create a new drop.
async function createDrop(req, res) {
  const { name, total_slots, start_time, per_user_limit } = req.body;

  if (!name || !total_slots || !start_time) {
    return res.status(400).json({ error: "name, total_slots, and start_time are required" });
  }
  if (total_slots <= 0) {
    return res.status(400).json({ error: "total_slots must be greater than 0" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO drops (name, total_slots, slots_remaining, start_time, per_user_limit, status, created_by)
       VALUES ($1, $2, $2, $3, $4, 'draft', $5)
       RETURNING *`,
      [name, total_slots, start_time, per_user_limit || 1, req.user.id]
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("createDrop error:", err);
    return res.status(500).json({ error: "Something went wrong creating the drop" });
  }
}

// Public: list all drops (most recent first).
async function listDrops(req, res) {
  try {
    const result = await pool.query(
      `SELECT id, name, total_slots, slots_remaining, start_time, status
       FROM drops ORDER BY start_time DESC`
    );
    return res.json(result.rows);
  } catch (err) {
    console.error("listDrops error:", err);
    return res.status(500).json({ error: "Something went wrong fetching drops" });
  }
}

// Public: get one drop's detail.
async function getDrop(req, res) {
  const { id } = req.params;

  try {
    const result = await pool.query("SELECT * FROM drops WHERE id = $1", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Drop not found" });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error("getDrop error:", err);
    return res.status(500).json({ error: "Something went wrong fetching the drop" });
  }
}

// Admin-only: flip a drop from draft -> live (or live -> closed).
async function updateDropStatus(req, res) {
  const { id } = req.params;
  const { status } = req.body;
  const allowed = ["draft", "live", "closed"];

  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${allowed.join(", ")}` });
  }

  try {
    const result = await pool.query(
      "UPDATE drops SET status = $1 WHERE id = $2 RETURNING *",
      [status, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Drop not found" });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error("updateDropStatus error:", err);
    return res.status(500).json({ error: "Something went wrong updating the drop" });
  }
}

module.exports = { createDrop, listDrops, getDrop, updateDropStatus };
