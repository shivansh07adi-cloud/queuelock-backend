const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");

const SALT_ROUNDS = 10;

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "1h" }
  );
}

async function register(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }

  try {
    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "An account with that email already exists" });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2)
       RETURNING id, email, role, created_at`,
      [email, passwordHash]
    );

    const user = result.rows[0];
    const token = signToken(user);

    return res.status(201).json({ user, token });
  } catch (err) {
    console.error("register error:", err);
    return res.status(500).json({ error: "Something went wrong registering the user" });
  }
}

async function login(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  try {
    const result = await pool.query(
      "SELECT id, email, password_hash, role FROM users WHERE email = $1",
      [email]
    );
    const user = result.rows[0];

    // Same error for "no user" and "wrong password" - don't leak which one it was.
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = signToken(user);
    return res.json({
      user: { id: user.id, email: user.email, role: user.role },
      token,
    });
  } catch (err) {
    console.error("login error:", err);
    return res.status(500).json({ error: "Something went wrong logging in" });
  }
}

module.exports = { register, login };
