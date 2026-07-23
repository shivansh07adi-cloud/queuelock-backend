// Same proof as Phase 2 (exactly N bookings succeed out of a stampede of
// requests, no overselling) but updated for Phase 3: booking now requires
// having been admitted from the waiting room first, so this script joins
// the queue and waits for admission before attempting to book.

const BASE_URL = process.env.BASE_URL || "http://localhost:4000";
const TOTAL_SLOTS = 5;
const CONCURRENT_USERS = 40;

async function req(path, opts = {}) {
  const res = await fetch(BASE_URL + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function registerAndLogin(email) {
  await req("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password: "password123" }),
  });
  const { data } = await req("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password: "password123" }),
  });
  return data.token;
}

async function waitForAdmission(dropId, token, timeoutMs = 40000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { data } = await req(`/api/drops/${dropId}/queue/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (data.admitted) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function main() {
  console.log(`Setting up: 1 admin, ${CONCURRENT_USERS} users, a drop with ${TOTAL_SLOTS} slots\n`);

  const adminEmail = "concurrency-admin@example.com";
  await registerAndLogin(adminEmail);
  await req("/debug/promote", { method: "POST", body: JSON.stringify({ email: adminEmail }) });
  const adminLogin = await req("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: adminEmail, password: "password123" }),
  });
  const adminToken = adminLogin.data.token;

  const dropRes = await req("/api/drops", {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: "Concurrency test drop",
      total_slots: TOTAL_SLOTS,
      start_time: new Date().toISOString(),
    }),
  });
  const dropId = dropRes.data.id;

  await req(`/api/drops/${dropId}/status`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ status: "live" }),
  });

  const userTokens = [];
  for (let i = 0; i < CONCURRENT_USERS; i++) {
    userTokens.push(await registerAndLogin(`user${i}@example.com`));
  }

  console.log(`${CONCURRENT_USERS} users joining the waiting room at the same instant...\n`);

  await Promise.all(
    userTokens.map((token) =>
      req(`/api/drops/${dropId}/queue/join`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      })
    )
  );

  console.log("Waiting for admission, then firing booking requests as each user gets admitted...\n");

  const results = await Promise.all(
    userTokens.map(async (token) => {
      const admitted = await waitForAdmission(dropId, token);
      if (!admitted) return { status: 408, data: { error: "Never got admitted in time" } };
      return req(`/api/drops/${dropId}/book`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
    })
  );

  const succeeded = results.filter((r) => r.status === 201);
  const soldOut = results.filter((r) => r.status === 409);
  const other = results.filter((r) => r.status !== 201 && r.status !== 409);

  const finalDrop = await req(`/api/drops/${dropId}`);

  console.log("=== RESULTS ===");
  console.log(`Requests sent:        ${CONCURRENT_USERS}`);
  console.log(`Bookings succeeded:   ${succeeded.length}  (expected: ${TOTAL_SLOTS})`);
  console.log(`Rejected as sold out: ${soldOut.length}  (expected: ${CONCURRENT_USERS - TOTAL_SLOTS})`);
  console.log(`Other/unexpected:     ${other.length}  (expected: 0)`);
  console.log(`Final slots_remaining: ${finalDrop.data.slots_remaining}  (expected: 0)`);

  const bookingIds = new Set(succeeded.map((r) => r.data.id));
  const noDuplicates = bookingIds.size === succeeded.length;
  console.log(`All succeeded bookings have unique IDs: ${noDuplicates}`);

  const pass =
    succeeded.length === TOTAL_SLOTS &&
    soldOut.length === CONCURRENT_USERS - TOTAL_SLOTS &&
    other.length === 0 &&
    finalDrop.data.slots_remaining === 0 &&
    noDuplicates;

  console.log(`\n${pass ? "PASS" : "FAIL"} - ${pass ? "no double-booking, no overselling, waiting room worked" : "something is wrong, see above"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("Test script error:", err);
  process.exit(1);
});
