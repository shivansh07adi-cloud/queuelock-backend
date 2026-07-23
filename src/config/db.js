const { Pool } = require("pg");

// Phase 6 hardening: node-postgres defaults to max: 10 connections, which
// bottlenecks fast under real concurrent load (200 virtual users in the k6
// test would mostly queue waiting for a free connection). Supabase's free
// tier caps total connections too, so this is set to a reasonable number
// that leaves headroom - raise PG_POOL_MAX if your load test shows the pool
// itself is the bottleneck (check for "pool exhausted" style timeouts).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.PG_POOL_MAX || "20", 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle Postgres client", err);
});

module.exports = pool;
