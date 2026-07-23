-- 001_init.sql
-- Phase 1: users, drops, bookings, payments.
-- No locking/concurrency logic lives here yet - that's Phase 2.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  total_slots INT NOT NULL CHECK (total_slots > 0),
  slots_remaining INT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  per_user_limit INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'closed')),
  version INT NOT NULL DEFAULT 0,       -- optimistic lock counter, used from Phase 2 onward
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_id UUID NOT NULL REFERENCES drops(id),
  user_id UUID NOT NULL REFERENCES users(id),
  slot_ref TEXT,
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'confirmed', 'expired', 'cancelled')),
  held_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  payment_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id),
  idempotency_key TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'success', 'failed', 'refunded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bookings_drop_id ON bookings(drop_id);
CREATE INDEX IF NOT EXISTS idx_bookings_user_id ON bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
