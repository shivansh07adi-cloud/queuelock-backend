// Simple migration runner - reads and executes every .sql file in this folder, in order.
// Good enough for a solo learning project. A real system would track applied migrations
// in a table; add that later if you want to practice it.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const dir = __dirname;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    console.log(`Applying ${file} ...`);
    await pool.query(sql);
  }

  console.log("All migrations applied.");
  await pool.end();
}

run().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
