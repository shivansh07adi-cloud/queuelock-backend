const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { rateLimit } = require("../middleware/rateLimit");
const { joinQueue, queueStatus } = require("../controllers/queue.controller");

const router = express.Router({ mergeParams: true });

router.post("/join", requireAuth, rateLimit("queue-join", { windowMs: 10000, max: 5 }), joinQueue);
router.get("/status", requireAuth, queueStatus);

module.exports = router;
