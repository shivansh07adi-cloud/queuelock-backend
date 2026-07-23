const crypto = require("crypto");
const redis = require("../config/redis");

// Tries once to acquire the lock. Returns a random token (proof of ownership)
// if it succeeds, or null if someone else already holds it.
// SET key value NX PX ttl is atomic in Redis - no race between "check" and "set".
async function acquireLock(key, ttlMs) {
  const token = crypto.randomUUID();
  const result = await redis.set(key, token, "PX", ttlMs, "NX");
  return result === "OK" ? token : null;
}

// Only deletes the key if it still holds OUR token. Without this check, a lock
// could expire, get acquired by someone else, and then get wrongly released by
// the original holder finishing late - this Lua script makes check+delete atomic.
const RELEASE_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  else
    return 0
  end
`;

async function releaseLock(key, token) {
  return redis.eval(RELEASE_SCRIPT, 1, key, token);
}

// Acquires the lock, runs fn(), and always releases afterward - even on error.
// Retries a few times with a short delay if the lock is currently held, which
// is what happens under real contention (many users hitting the same drop).
async function withLock(key, { ttlMs = 3000, retries = 8, retryDelayMs = 150 } = {}, fn) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const token = await acquireLock(key, ttlMs);
    if (token) {
      try {
        return await fn();
      } finally {
        await releaseLock(key, token);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  const err = new Error("Could not acquire lock in time");
  err.code = "LOCK_TIMEOUT";
  throw err;
}

module.exports = { acquireLock, releaseLock, withLock };
