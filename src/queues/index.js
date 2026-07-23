const { Queue } = require("bullmq");
const Redis = require("ioredis");

// BullMQ needs its own dedicated connection (not the shared app one used for
// locks/rate-limiting) because it uses blocking Redis commands internally,
// which require maxRetriesPerRequest: null. Reusing a connection tuned for
// short-lived lock/rate-limit calls would cause subtle failures here.
const bullConnection = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

const connection = { connection: bullConnection };

// Three queues matching the async jobs described in the SRS: confirmation
// (email/log), analytics (event aggregation), and cleanup (expired holds).
// Splitting them means a slow analytics job can never delay someone's
// booking confirmation email, and each can be scaled/monitored separately.
const confirmationQueue = new Queue("confirmation", connection);
const analyticsQueue = new Queue("analytics", connection);
const cleanupQueue = new Queue("cleanup", connection);

module.exports = { confirmationQueue, analyticsQueue, cleanupQueue, connection };
