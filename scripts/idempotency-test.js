// Proves the core Phase 4 guarantee: firing the SAME payment request many
// times concurrently (simulating retries from a flaky network, or a user
// mashing the "pay" button) results in exactly ONE payment being processed -
// not duplicated, not double-confirmed - and every response describes the
// same outcome.

const BASE_URL = process.env.BASE_URL || "http://localhost:4000";
const DUPLICATE_ATTEMPTS = 8; // stay under the pay route's rate limit (max 10/10s) - this test is about idempotency, not the rate limiter

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

async function waitForAdmission(dropId, token, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { data } = await req(`/api/drops/${dropId}/queue/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (data.admitted) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  console.log("Setting up: admin, a live drop, one user with a held booking\n");

  const adminEmail = "idempotency-admin@example.com";
  const userEmail = "idempotency-user@example.com";

  await registerAndLogin(adminEmail);
  await req("/debug/promote", { method: "POST", body: JSON.stringify({ email: adminEmail }) });
  const adminLogin = await req("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: adminEmail, password: "password123" }),
  });
  const adminToken = adminLogin.data.token;

  const userToken = await registerAndLogin(userEmail);

  const dropRes = await req("/api/drops", {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ name: "Idempotency test drop", total_slots: 10, start_time: new Date().toISOString() }),
  });
  const dropId = dropRes.data.id;

  await req(`/api/drops/${dropId}/status`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ status: "live" }),
  });

  await req(`/api/drops/${dropId}/queue/join`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}` },
  });
  const admitted = await waitForAdmission(dropId, userToken);
  if (!admitted) throw new Error("Setup failed: never got admitted");

  const bookingRes = await req(`/api/drops/${dropId}/book`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({}),
  });
  const bookingId = bookingRes.data.id;
  console.log(`Booking ${bookingId} is held. Now firing ${DUPLICATE_ATTEMPTS} concurrent payment attempts with the SAME idempotency key...\n`);

  const idempotencyKey = "test-idem-key-" + Date.now();

  const results = await Promise.all(
    Array.from({ length: DUPLICATE_ATTEMPTS }).map(() =>
      req(`/api/bookings/${bookingId}/pay`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
        body: JSON.stringify({ idempotency_key: idempotencyKey, simulate: "success" }),
      })
    )
  );

  const paymentIds = new Set(results.map((r) => r.data.payment?.id).filter(Boolean));
  const allSameOutcome = results.every((r) => r.status === 200 && r.data.status === "success");
  const finalBooking = await req(`/api/bookings/${bookingId}`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });

  console.log("=== RESULTS ===");
  console.log(`Requests sent with the same idempotency key: ${DUPLICATE_ATTEMPTS}`);
  console.log(`Unique payment records created:               ${paymentIds.size}  (expected: 1)`);
  console.log(`All responses report success:                 ${allSameOutcome}`);
  console.log(`Final booking status:                         ${finalBooking.data.status}  (expected: confirmed)`);

  console.log("\nNow trying a SECOND, different idempotency key against the same (already-confirmed) booking...");
  const doublePayAttempt = await req(`/api/bookings/${bookingId}/pay`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ idempotency_key: "a-totally-different-key-" + Date.now(), simulate: "success" }),
  });
  const secondKeyBlocked = doublePayAttempt.status === 409;
  console.log(`Second key correctly rejected (already confirmed): ${secondKeyBlocked} (status ${doublePayAttempt.status})`);

  const pass = paymentIds.size === 1 && allSameOutcome && finalBooking.data.status === "confirmed" && secondKeyBlocked;

  console.log(`\n${pass ? "PASS" : "FAIL"} - ${pass ? "exactly one payment was processed, no double-confirm, no double-charge" : "something is wrong, see above"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("Test script error:", err);
  process.exit(1);
});
