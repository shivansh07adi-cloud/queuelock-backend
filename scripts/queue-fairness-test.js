// Proves the waiting room admits people in the order they joined, not
// randomly - user0 joined first, so user0 must be admitted no later than
// user1, who must be admitted no later than user2, and so on.

const BASE_URL = process.env.BASE_URL || "http://localhost:4000";
const NUM_USERS = 12; // more than ADMIT_BATCH_SIZE (5), so this spans multiple admission cycles

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

async function waitForAdmission(dropId, token, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { data } = await req(`/api/drops/${dropId}/queue/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (data.admitted) return Date.now();
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function main() {
  console.log(`Setting up: 1 admin, ${NUM_USERS} users joining in a known order\n`);

  const adminEmail = "fairness-admin@example.com";
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
      name: "Fairness test drop",
      total_slots: NUM_USERS, // plenty of slots - this test is about ORDER, not scarcity
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
  for (let i = 0; i < NUM_USERS; i++) {
    userTokens.push(await registerAndLogin(`fairness-user${i}@example.com`));
  }

  console.log("Joining the queue strictly in order, one at a time (user0 first, user11 last)...\n");

  // Joining SEQUENTIALLY (not concurrently) so we know the exact join order,
  // which is what we'll check the admission order against.
  for (const token of userTokens) {
    await req(`/api/drops/${dropId}/queue/join`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  console.log("Waiting for everyone to be admitted, recording the order...\n");

  const admissionTimes = await Promise.all(
    userTokens.map((token) => waitForAdmission(dropId, token))
  );

  let fifoRespected = true;
  const JITTER_TOLERANCE_MS = 300; // polling observes same-batch admissions a few ms apart - that's not a real ordering violation
  for (let i = 1; i < admissionTimes.length; i++) {
    if (admissionTimes[i] === null || admissionTimes[i - 1] === null) {
      fifoRespected = false;
      break;
    }
    if (admissionTimes[i] < admissionTimes[i - 1] - JITTER_TOLERANCE_MS) {
      fifoRespected = false;
      break;
    }
  }

  console.log("=== RESULTS ===");
  admissionTimes.forEach((t, i) => {
    console.log(`user${i} admitted at: ${t ? new Date(t).toISOString() : "NEVER"}`);
  });
  console.log(`\nFIFO order respected: ${fifoRespected}`);
  console.log(`\n${fifoRespected ? "PASS" : "FAIL"} - ${fifoRespected ? "earlier joiners were never admitted after later joiners" : "admission order was violated, see above"}`);
  process.exit(fifoRespected ? 0 : 1);
}

main().catch((err) => {
  console.error("Test script error:", err);
  process.exit(1);
});
