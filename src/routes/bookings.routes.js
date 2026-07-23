const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { createBooking, getBooking } = require("../controllers/bookings.controller");

const router = express.Router({ mergeParams: true });

const { rateLimit } = require("../middleware/rateLimit");

// Nested under /api/drops/:id/book in index.js
router.post("/", requireAuth, rateLimit("book", { windowMs: 10000, max: 5 }), createBooking);

module.exports = router;
