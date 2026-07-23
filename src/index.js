require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth.routes");
const dropsRoutes = require("./routes/drops.routes");
const bookingsRoutes = require("./routes/bookings.routes");
const bookingDetailRoutes = require("./routes/booking-detail.routes");
const queueRoutes = require("./routes/queue.routes");
const paymentsRoutes = require("./routes/payments.routes");
const { startQueueAdmission } = require("./workers/admitFromQueue");
const { startAllWorkers } = require("./queues/workers");
const { cleanupQueue } = require("./queues");

const app = express();

// Phase 7 hardening: wide-open CORS (any origin) is fine for local dev but
// shouldn't ship to production - it lets any website's JS make authenticated
// requests to your API using a visitor's stolen/leaked token. CORS_ORIGIN
// defaults to "*" so nothing breaks if it's unset (e.g. still developing
// locally), but set it to your real deployed frontend URL in production.
const corsOrigin = process.env.CORS_ORIGIN || "*";
app.use(cors({ origin: corsOrigin }));
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", phase: 7 });
});

app.use("/api/auth", authRoutes);
app.use("/api/drops", dropsRoutes);
app.use("/api/drops/:id/book", bookingsRoutes);
app.use("/api/drops/:id/queue", queueRoutes);
app.use("/api/bookings/:id/pay", paymentsRoutes);
app.use("/api/bookings", bookingDetailRoutes);

// Fallback error handler - keeps stack traces out of API responses.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
  console.log(`FlashBook API (Phase 7) running on port ${PORT}`);
  startQueueAdmission();
  startAllWorkers();

  // Phase 2/3 used a raw setInterval for hold expiry (see src/workers/expireHolds.js -
  // kept in the repo for reference but no longer used). This BullMQ repeatable
  // job replaces it: same logic, now running through the same job
  // infrastructure as confirmation/analytics, with retries and visibility
  // for free.
  await cleanupQueue.add(
    "sweep-expired-holds",
    {},
    { repeat: { every: 15000 }, removeOnComplete: true, removeOnFail: 50 }
  );
});
