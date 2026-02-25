'use strict';

const Fastify = require('fastify');
const { Pool } = require('pg');

const PORT = parseInt(process.env.PORT || '3002', 10);
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://benchmark:benchmark@localhost:5432/benchmark';

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Fastify instance with logger disabled for benchmark performance
const fastify = Fastify({ logger: false });

// --- JSON Schemas for fast serialization ---

const userSchema = {
  type: 'object',
  properties: {
    id:         { type: 'integer' },
    name:       { type: 'string' },
    email:      { type: 'string' },
    age:        { type: ['integer', 'null'] },
    created_at: { type: 'string' },
  },
};

const userArraySchema = {
  type: 'array',
  items: userSchema,
};

const errorSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
  },
};

// --- Routes ---

// GET /
fastify.get('/', {
  schema: {
    response: {
      200: {
        type: 'object',
        properties: {
          message:   { type: 'string' },
          framework: { type: 'string' },
          runtime:   { type: 'string' },
        },
      },
    },
  },
}, async (_req, reply) => {
  return { message: 'Fastify API', framework: 'fastify', runtime: 'node' };
});

// GET /json
fastify.get('/json', {
  schema: {
    response: {
      200: {
        type: 'object',
        properties: {
          message:   { type: 'string' },
          framework: { type: 'string' },
        },
      },
    },
  },
}, async (_req, reply) => {
  return { message: 'Hello, World!', framework: 'fastify' };
});

// GET /db — single random user
fastify.get('/db', {
  schema: {
    response: {
      200: userSchema,
      404: errorSchema,
    },
  },
}, async (_req, reply) => {
  const { rows } = await pool.query(
    'SELECT id, name, email, age, created_at FROM users ORDER BY RANDOM() LIMIT 1'
  );
  if (rows.length === 0) {
    reply.code(404);
    return { error: 'User not found' };
  }
  return rows[0];
});

// GET /queries?count=N — N random users
fastify.get('/queries', {
  schema: {
    querystring: {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 500, default: 1 },
      },
    },
    response: {
      200: userArraySchema,
    },
  },
}, async (req, _reply) => {
  let count = parseInt(req.query.count, 10);
  if (isNaN(count) || count < 1)   count = 1;
  if (count > 500)                  count = 500;

  const { rows } = await pool.query(
    'SELECT id, name, email, age, created_at FROM users ORDER BY RANDOM() LIMIT $1',
    [count]
  );
  return rows;
});

// GET /users — all users
fastify.get('/users', {
  schema: {
    response: {
      200: userArraySchema,
    },
  },
}, async (_req, _reply) => {
  const { rows } = await pool.query(
    'SELECT id, name, email, age, created_at FROM users ORDER BY id'
  );
  return rows;
});

// GET /users/:id — user by id
fastify.get('/users/:id', {
  schema: {
    params: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
      },
      required: ['id'],
    },
    response: {
      200: userSchema,
      404: errorSchema,
    },
  },
}, async (req, reply) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await pool.query(
    'SELECT id, name, email, age, created_at FROM users WHERE id = $1',
    [id]
  );
  if (rows.length === 0) {
    reply.code(404);
    return { error: 'User not found' };
  }
  return rows[0];
});

// POST /users — create user
fastify.post('/users', {
  schema: {
    body: {
      type: 'object',
      required: ['name', 'email'],
      properties: {
        name:  { type: 'string' },
        email: { type: 'string' },
        age:   { type: ['integer', 'null'] },
      },
    },
    response: {
      201: userSchema,
    },
  },
}, async (req, reply) => {
  const { name, email, age = null } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO users (name, email, age) VALUES ($1, $2, $3) RETURNING id, name, email, age, created_at',
    [name, email, age]
  );
  reply.code(201);
  return rows[0];
});

// PUT /users/:id — update user
fastify.put('/users/:id', {
  schema: {
    params: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
      },
      required: ['id'],
    },
    body: {
      type: 'object',
      properties: {
        name:  { type: 'string' },
        email: { type: 'string' },
        age:   { type: ['integer', 'null'] },
      },
    },
    response: {
      200: userSchema,
      404: errorSchema,
    },
  },
}, async (req, reply) => {
  const id = parseInt(req.params.id, 10);

  // Fetch existing record first
  const existing = await pool.query(
    'SELECT id, name, email, age, created_at FROM users WHERE id = $1',
    [id]
  );
  if (existing.rows.length === 0) {
    reply.code(404);
    return { error: 'User not found' };
  }

  const current = existing.rows[0];
  const name  = req.body.name  !== undefined ? req.body.name  : current.name;
  const email = req.body.email !== undefined ? req.body.email : current.email;
  const age   = req.body.age   !== undefined ? req.body.age   : current.age;

  const { rows } = await pool.query(
    'UPDATE users SET name = $1, email = $2, age = $3 WHERE id = $4 RETURNING id, name, email, age, created_at',
    [name, email, age, id]
  );
  return rows[0];
});

// DELETE /users/:id — delete user
fastify.delete('/users/:id', {
  schema: {
    params: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
      },
      required: ['id'],
    },
    response: {
      404: errorSchema,
    },
  },
}, async (req, reply) => {
  const id = parseInt(req.params.id, 10);
  const { rowCount } = await pool.query(
    'DELETE FROM users WHERE id = $1',
    [id]
  );
  if (rowCount === 0) {
    reply.code(404);
    return { error: 'User not found' };
  }
  reply.code(204).send();
});

// --- Error handler ---
fastify.setErrorHandler((err, req, reply) => {
  const statusCode = err.statusCode || 500;
  reply.code(statusCode).send({ error: err.message || 'Internal Server Error' });
});

// --- Start server ---
const start = async () => {
  try {
    // Verify DB connection before accepting traffic
    await pool.query('SELECT 1');

    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`Fastify API running on port ${PORT}`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGTERM', async () => {
  await fastify.close();
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await fastify.close();
  await pool.end();
  process.exit(0);
});

start();
