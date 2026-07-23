const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { rateLimit } = require("../middleware/rateLimit");
const { createPayment } = require("../controllers/payments.controller");

const router = express.Router({ mergeParams: true });

// Nested under /api/bookings/:id/pay in index.js
router.post("/", requireAuth, rateLimit("pay", { windowMs: 10000, max: 10 }), createPayment);

module.exports = router;
