const express = require("express");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const {
  createDrop,
  listDrops,
  getDrop,
  updateDropStatus,
} = require("../controllers/drops.controller");

const router = express.Router();

router.get("/", listDrops);
router.get("/:id", getDrop);
router.post("/", requireAuth, requireAdmin, createDrop);
router.patch("/:id/status", requireAuth, requireAdmin, updateDropStatus);

module.exports = router;
