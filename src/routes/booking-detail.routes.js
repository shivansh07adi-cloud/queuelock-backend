const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { getBooking } = require("../controllers/bookings.controller");

const router = express.Router();

router.get("/:id", requireAuth, getBooking);

module.exports = router;
