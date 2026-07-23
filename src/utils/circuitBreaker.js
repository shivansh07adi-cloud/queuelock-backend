// A minimal circuit breaker: tracks recent outcomes of calls to a protected
// function. If too many of the last N calls failed, the breaker "opens" and
// starts rejecting calls immediately (no DB hit at all) for a cooldown period,
// giving the database/downstream system room to recover instead of getting
// hit by an ever-growing pile of retries during an outage.
//
// This is in-memory and per-process on purpose - it's a learning project on
// a single instance. A multi-instance deployment would move this state to
// Redis so all instances share one view of "is this healthy right now".
//
// States: CLOSED (normal) -> OPEN (rejecting) -> HALF_OPEN (testing recovery)
class CircuitBreaker {
  constructor({ failureThreshold = 5, windowSize = 20, cooldownMs = 5000 } = {}) {
    this.failureThreshold = failureThreshold; // failures within windowSize that trips it
    this.windowSize = windowSize; // how many recent outcomes we track
    this.cooldownMs = cooldownMs; // how long OPEN lasts before trying again
    this.outcomes = []; // true = success, false = failure
    this.state = "CLOSED";
    this.openedAt = null;
  }

  recordOutcome(success) {
    this.outcomes.push(success);
    if (this.outcomes.length > this.windowSize) {
      this.outcomes.shift();
    }
  }

  recentFailureCount() {
    return this.outcomes.filter((o) => o === false).length;
  }

  async exec(fn) {
    if (this.state === "OPEN") {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed < this.cooldownMs) {
        const err = new Error("Circuit breaker is open - too many recent failures");
        err.code = "CIRCUIT_OPEN";
        throw err;
      }
      // Cooldown passed - allow one trial request through (half-open).
      this.state = "HALF_OPEN";
    }

    try {
      const result = await fn();
      this.recordOutcome(true);
      if (this.state === "HALF_OPEN") {
        // The trial call succeeded - close the circuit and reset.
        this.state = "CLOSED";
        this.outcomes = [];
      }
      return result;
    } catch (err) {
      this.recordOutcome(false);
      if (this.state === "HALF_OPEN" || this.recentFailureCount() >= this.failureThreshold) {
        this.state = "OPEN";
        this.openedAt = Date.now();
      }
      throw err;
    }
  }
}

module.exports = { CircuitBreaker };
