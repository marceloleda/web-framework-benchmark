'use strict';

const express = require('express');
const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// Database pool
// ---------------------------------------------------------------------------

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://benchmark:benchmark@localhost:5432/benchmark',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// ---------------------------------------------------------------------------
// App setup — minimal middleware for maximum throughput
// ---------------------------------------------------------------------------

const app = express();

app.use(express.json());

// Disable the X-Powered-By header (minor overhead reduction)
app.disable('x-powered-by');

// ---------------------------------------------------------------------------
// Helper: clamp the ?count query param to [1, 500]
// ---------------------------------------------------------------------------

function parseCount(value) {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 1) return 1;
  if (n > 500) return 500;
  return n;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /
app.get('/', (_req, res) => {
  res.json({ message: 'Express API', framework: 'express', runtime: 'node' });
});

// GET /json
app.get('/json', (_req, res) => {
  res.json({ message: 'Hello, World!', framework: 'express' });
});

// GET /db — single random user from the database
app.get('/db', async (_req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, age, created_at FROM users ORDER BY RANDOM() LIMIT 1'
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No users found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// GET /queries?count=N — N random users (1-500, default 1)
app.get('/queries', async (req, res) => {
  const count = parseCount(req.query.count);
  try {
    const result = await pool.query(
      'SELECT id, name, email, age, created_at FROM users ORDER BY RANDOM() LIMIT $1',
      [count]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// GET /users — lista todos os usuários (com paginação opcional)
// ?limit=N  (1-100, default todos)
// ?offset=N (>= 0, default 0)
app.get('/users', async (req, res) => {
  try {
    if (req.query.limit !== undefined) {
      const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit,  10) || 20));
      const offset = Math.max(0,            parseInt(req.query.offset, 10) || 0);
      const [data, count] = await Promise.all([
        pool.query(
          'SELECT id, name, email, age, created_at FROM users ORDER BY id LIMIT $1 OFFSET $2',
          [limit, offset]
        ),
        pool.query('SELECT COUNT(*)::int AS total FROM users'),
      ]);
      return res.json({ data: data.rows, total: count.rows[0].total, limit, offset });
    }
    const result = await pool.query(
      'SELECT id, name, email, age, created_at FROM users ORDER BY id'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// GET /users/:id — single user by ID
app.get('/users/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }
  try {
    const result = await pool.query(
      'SELECT id, name, email, age, created_at FROM users WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// POST /users — create a user
app.post('/users', async (req, res) => {
  const { name, email, age } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: 'Fields "name" and "email" are required' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO users (name, email, age) VALUES ($1, $2, $3) RETURNING id, name, email, age, created_at',
      [name, email, age ?? null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      // unique_violation — duplicate email
      return res.status(409).json({ error: 'Email already in use' });
    }
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// PUT /users/:id — update a user
app.put('/users/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }

  const { name, email, age } = req.body;

  if (!name && !email && age === undefined) {
    return res.status(400).json({ error: 'At least one field (name, email, age) is required' });
  }

  try {
    const result = await pool.query(
      `UPDATE users
       SET name  = COALESCE($1, name),
           email = COALESCE($2, email),
           age   = COALESCE($3, age)
       WHERE id = $4
       RETURNING id, name, email, age, created_at`,
      [name ?? null, email ?? null, age ?? null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already in use' });
    }
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// DELETE /users/:id — remove a user
app.delete('/users/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }
  try {
    const result = await pool.query(
      'DELETE FROM users WHERE id = $1 RETURNING id',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT, 10) || 3001;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`Express API listening on http://${HOST}:${PORT}`);
});
