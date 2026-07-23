const pool = require("../config/db");
const { withLock } = require("../utils/lock");
const { confirmationQueue, analyticsQueue } = require("../queues");

// Mock payment processor - stands in for a real gateway (Stripe, Razorpay,
// etc). `simulate` lets the caller force an outcome for testing; defaults to
// success so a normal happy-path call just works.
function mockChargeCard(simulate) {
  if (simulate === "failure") {
    return { success: false, reason: "Card declined (simulated)" };
  }
  if (simulate === "timeout") {
    return { success: false, reason: "Payment gateway timed out (simulated)" };
  }
  return { success: true };
}

// The core of Phase 4: process a payment for a held booking, guarded by an
// idempotency key, such that calling this twice with the SAME key - whether
// because the client retried after a network blip, or the user double-clicked
// "pay" - only ever has the effect ONCE. The second call just returns the
// first call's result.
//
// The whole thing runs inside a lock keyed on the idempotency key itself:
// that's what closes the race where two concurrent requests with the same
// key both check "does a payment exist yet?", both see "no", and both
// proceed to charge the card. With the lock, the second request waits until
// the first is completely finished (row inserted, terminal status reached)
// before it even looks.
async function createPayment(req, res) {
  const { id: bookingId } = req.params;
  const userId = req.user.id;
  const { idempotency_key: idempotencyKey, simulate } = req.body;

  if (!idempotencyKey || typeof idempotencyKey !== "string") {
    return res.status(400).json({ error: "idempotency_key is required" });
  }

  try {
    const outcome = await withLock(
      `lock:payment:${idempotencyKey}`,
      { ttlMs: 5000, retries: 10, retryDelayMs: 150 },
      () => attemptPayment(bookingId, userId, idempotencyKey, simulate)
    ).catch((err) => {
      if (err.code === "LOCK_TIMEOUT") {
        return { status: 429, body: { error: "Another request with this idempotency key is already in flight" } };
      }
      throw err;
    });

    return res.status(outcome.status).json(outcome.body);
  } catch (err) {
    console.error("createPayment error:", err);
    return res.status(500).json({ error: "Something went wrong processing the payment" });
  }
}

async function attemptPayment(bookingId, userId, idempotencyKey, simulate) {
  // Replay check FIRST, before touching the booking at all. If this exact
  // idempotency key was already used - successfully or not - we return that
  // stored outcome instead of re-running any of the logic below. This is the
  // actual idempotency guarantee; everything else in this function only runs
  // the FIRST time a given key is seen.
  const existingPayment = await pool.query(
    "SELECT * FROM payments WHERE idempotency_key = $1",
    [idempotencyKey]
  );
  if (existingPayment.rows.length > 0) {
    return toResponse(existingPayment.rows[0], true);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const bookingResult = await client.query(
      "SELECT * FROM bookings WHERE id = $1 FOR UPDATE",
      [bookingId]
    );
    if (bookingResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return { status: 404, body: { error: "Booking not found" } };
    }

    const booking = bookingResult.rows[0];
    if (booking.user_id !== userId) {
      await client.query("ROLLBACK");
      return { status: 403, body: { error: "Not your booking" } };
    }
    if (booking.status === "confirmed") {
      await client.query("ROLLBACK");
      return { status: 409, body: { error: "This booking is already confirmed" } };
    }
    if (booking.status !== "held") {
      await client.query("ROLLBACK");
      return { status: 409, body: { error: `This booking can't be paid for (status: ${booking.status})` } };
    }
    if (new Date(booking.expires_at) < new Date()) {
      await client.query("ROLLBACK");
      return { status: 409, body: { error: "Your hold on this slot has expired" } };
    }

    // pending -> processing
    const paymentInsert = await client.query(
      `INSERT INTO payments (booking_id, idempotency_key, status)
       VALUES ($1, $2, 'processing')
       RETURNING *`,
      [bookingId, idempotencyKey]
    );
    let payment = paymentInsert.rows[0];

    const result = mockChargeCard(simulate);

    if (result.success) {
      // processing -> success, and the booking becomes confirmed in the same
      // transaction - either both happen or neither does.
      const updatedPayment = await client.query(
        "UPDATE payments SET status = 'success', updated_at = now() WHERE id = $1 RETURNING *",
        [payment.id]
      );
      payment = updatedPayment.rows[0];

      await client.query(
        "UPDATE bookings SET status = 'confirmed', payment_id = $1 WHERE id = $2",
        [payment.id, bookingId]
      );
    } else {
      // processing -> failed. The booking stays 'held' - the user can retry
      // with a NEW idempotency key before the hold expires, or the expiry
      // sweep worker will eventually release the slot if they don't.
      const updatedPayment = await client.query(
        "UPDATE payments SET status = 'failed', updated_at = now() WHERE id = $1 RETURNING *",
        [payment.id]
      );
      payment = updatedPayment.rows[0];
    }

    await client.query("COMMIT");

    if (result.success) {
      // Fire-and-forget - these run in the background via BullMQ workers and
      // never delay the HTTP response back to the user. If enqueueing itself
      // fails (e.g. Redis hiccup), we log it but don't fail the payment that
      // already committed - the user's money/slot is safe either way.
      try {
        const userResult = await pool.query("SELECT email FROM users WHERE id = $1", [userId]);
        const dropResult = await pool.query(
          "SELECT name, id FROM drops WHERE id = (SELECT drop_id FROM bookings WHERE id = $1)",
          [bookingId]
        );
        await confirmationQueue.add("send-confirmation", {
          bookingId,
          userEmail: userResult.rows[0]?.email,
          dropName: dropResult.rows[0]?.name,
        });
        await analyticsQueue.add("booking-confirmed", {
          event: "booking_confirmed",
          dropId: dropResult.rows[0]?.id,
          userId,
        });
      } catch (enqueueErr) {
        console.error("Failed to enqueue post-payment jobs:", enqueueErr.message);
      }
    }

    return toResponse(payment, false, result.reason);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function toResponse(payment, replayed, failureReason) {
  if (payment.status === "success") {
    return {
      status: 200,
      body: { status: "success", payment, replayed },
    };
  }
  if (payment.status === "failed") {
    return {
      status: 402,
      body: { status: "failed", error: failureReason || "Payment failed", payment, replayed },
    };
  }
  // pending/processing found on replay means a previous attempt with this key
  // is still mid-flight (shouldn't normally be observed since we hold a lock
  // for the whole attempt, but could happen if a process crashed mid-payment).
  return {
    status: 202,
    body: { status: payment.status, message: "Payment is still processing", payment, replayed },
  };
}

module.exports = { createPayment };
