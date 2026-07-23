const Redis = require("ioredis");

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: 3,
});

redis.on("error", (err) => {
  console.error("Redis connection error:", err.message);
});

module.exports = redis;
