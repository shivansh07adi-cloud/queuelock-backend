// Convenience script: creates an admin, creates a drop with a known slot
// count, flips it live, and prints the exact k6 command to run against it -
// so you don't have to do this by hand through the UI before every test run.

const BASE_URL = process.env.BASE_URL || "http://localhost:4000";
const TOTAL_SLOTS = parseInt(process.env.TOTAL_SLOTS || "20", 10);

async function req(path, opts = {}) {
  const res = await fetch(BASE_URL + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  const email = `loadtest-admin-${Date.now()}@example.com`;
  const password = "password123";

  await req("/api/auth/register", { method: "POST", body: JSON.stringify({ email, password }) });

  console.log(`Created admin account: ${email}`);
  console.log(`\nIMPORTANT: promote this account to admin manually, then re-run this script`);
  console.log(`with PROMOTED=1, or just run this SQL against your database:\n`);
  console.log(`  UPDATE users SET role = 'admin' WHERE email = '${email}';\n`);

  if (!process.env.PROMOTED) {
    console.log("Once promoted, run again with: PROMOTED=1 node load-tests/setup-drop.js");
    return;
  }

  const loginRes = await req("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  const token = loginRes.data.token;

  const dropRes = await req("/api/drops", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: `Load test drop (${TOTAL_SLOTS} slots)`,
      total_slots: TOTAL_SLOTS,
      per_user_limit: 1,
      start_time: new Date().toISOString(),
    }),
  });
  const dropId = dropRes.data.id;

  await req(`/api/drops/${dropId}/status`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ status: "live" }),
  });

  console.log(`\nDrop created and live: ${dropId}\n`);
  console.log("Run the load test with:\n");
  console.log(
    `  k6 run -e DROP_ID=${dropId} -e TOTAL_SLOTS=${TOTAL_SLOTS} load-tests/k6-flash-sale.js\n`
  );
}

main().catch((err) => {
  console.error("Setup failed:", err.message);
  process.exit(1);
});
