const redis = require("../config/redis");

// Fixed-window rate limit per (user, route). Simple on purpose - a sliding
// window or token bucket would be smoother, but fixed-window is easy to reason
// about and good enough to stop one user from hammering an endpoint.
//
// Key looks like: ratelimit:{routeTag}:{userId} -> counts requests in the
// current windowMs. When the count exceeds `max`, the request gets a 429
// instead of ever reaching the controller (and the DB behind it).
function rateLimit(routeTag, { windowMs = 10000, max = 10 } = {}) {
  return async (req, res, next) => {
    const key = `ratelimit:${routeTag}:${req.user.id}`;
    try {
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.pexpire(key, windowMs);
      }
      if (count > max) {
        const ttl = await redis.pttl(key);
        res.set("Retry-After", Math.ceil(ttl / 1000));
        return res.status(429).json({
          error: "Too many requests - slow down and try again shortly",
        });
      }
      next();
    } catch (err) {
      // If Redis itself is having trouble, fail open rather than blocking
      // every request in the app - rate limiting is a protection, not the
      // core feature. Log it so it's visible, but let the request through.
      console.error("Rate limiter error (failing open):", err.message);
      next();
    }
  };
}

module.exports = { rateLimit };
