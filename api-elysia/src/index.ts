import { Elysia, t } from "elysia";
import postgres from "postgres";

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL!;
const PORT = Number(process.env.PORT ?? 3003);

const sql = postgres(DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface User {
  id: number;
  name: string;
  email: string;
  age: number | null;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Elysia()

  // -------------------------------------------------------------------------
  // GET /
  // -------------------------------------------------------------------------
  .get("/", () => ({
    message: "Elysia API",
    framework: "elysia",
    runtime: "bun",
  }))

  // -------------------------------------------------------------------------
  // GET /json
  // -------------------------------------------------------------------------
  .get("/json", () => ({
    message: "Hello, World!",
    framework: "elysia",
  }))

  // -------------------------------------------------------------------------
  // GET /db  — one random user from the database
  // -------------------------------------------------------------------------
  .get("/db", async ({ error }) => {
    const rows = await sql<User[]>`
      SELECT id, name, email, age, created_at
      FROM users
      ORDER BY RANDOM()
      LIMIT 1
    `;

    if (rows.length === 0) {
      return error(404, { error: "No users found" });
    }

    return rows[0];
  })

  // -------------------------------------------------------------------------
  // GET /queries?count=N  — N random users (1-500, default 1)
  // -------------------------------------------------------------------------
  .get(
    "/queries",
    async ({ query, error }) => {
      const rawCount = Number(query.count ?? 1);
      const count = Number.isNaN(rawCount)
        ? 1
        : Math.min(500, Math.max(1, rawCount));

      const rows = await sql<User[]>`
        SELECT id, name, email, age, created_at
        FROM users
        ORDER BY RANDOM()
        LIMIT ${count}
      `;

      return rows;
    },
    {
      query: t.Object({
        count: t.Optional(t.String()),
      }),
    }
  )

  // -------------------------------------------------------------------------
  // GET /users  — lista todos os usuários (com paginação opcional)
  // ?limit=N  (1-100, default todos)
  // ?offset=N (>= 0, default 0)
  // -------------------------------------------------------------------------
  .get(
    "/users",
    async ({ query }) => {
      if (query.limit !== undefined) {
        const limit  = Math.min(100, Math.max(1, Number(query.limit)  || 20));
        const offset = Math.max(0,             Number(query.offset) || 0);

        const [data, countRows] = await Promise.all([
          sql<User[]>`
            SELECT id, name, email, age, created_at
            FROM users
            ORDER BY id
            LIMIT ${limit} OFFSET ${offset}
          `,
          sql<[{ total: number }]>`SELECT COUNT(*)::int AS total FROM users`,
        ]);

        return { data, total: countRows[0].total, limit, offset };
      }

      const rows = await sql<User[]>`
        SELECT id, name, email, age, created_at
        FROM users
        ORDER BY id
      `;
      return rows;
    },
    {
      query: t.Object({
        limit:  t.Optional(t.String()),
        offset: t.Optional(t.String()),
      }),
    }
  )

  // -------------------------------------------------------------------------
  // GET /users/:id  — single user by id
  // -------------------------------------------------------------------------
  .get(
    "/users/:id",
    async ({ params, error }) => {
      const id = Number(params.id);

      if (Number.isNaN(id)) {
        return error(400, { error: "Invalid user id" });
      }

      const rows = await sql<User[]>`
        SELECT id, name, email, age, created_at
        FROM users
        WHERE id = ${id}
      `;

      if (rows.length === 0) {
        return error(404, { error: "User not found" });
      }

      return rows[0];
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    }
  )

  // -------------------------------------------------------------------------
  // POST /users  — create a new user
  // -------------------------------------------------------------------------
  .post(
    "/users",
    async ({ body, set, error }) => {
      const { name, email, age } = body;

      try {
        const rows = await sql<User[]>`
          INSERT INTO users (name, email, age)
          VALUES (${name}, ${email}, ${age ?? null})
          RETURNING id, name, email, age, created_at
        `;

        set.status = 201;
        return rows[0];
      } catch (err: any) {
        // Unique constraint violation (duplicate email)
        if (err?.code === "23505") {
          return error(409, { error: "Email already in use" });
        }
        throw err;
      }
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1 }),
        email: t.String({ format: "email" }),
        age: t.Optional(t.Nullable(t.Number({ minimum: 0 }))),
      }),
    }
  )

  // -------------------------------------------------------------------------
  // PUT /users/:id  — update an existing user
  // -------------------------------------------------------------------------
  .put(
    "/users/:id",
    async ({ params, body, error }) => {
      const id = Number(params.id);

      if (Number.isNaN(id)) {
        return error(400, { error: "Invalid user id" });
      }

      const { name, email, age } = body;

      try {
        const rows = await sql<User[]>`
          UPDATE users
          SET
            name  = COALESCE(${name ?? null}, name),
            email = COALESCE(${email ?? null}, email),
            age   = COALESCE(${age ?? null}, age)
          WHERE id = ${id}
          RETURNING id, name, email, age, created_at
        `;

        if (rows.length === 0) {
          return error(404, { error: "User not found" });
        }

        return rows[0];
      } catch (err: any) {
        if (err?.code === "23505") {
          return error(409, { error: "Email already in use" });
        }
        throw err;
      }
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1 })),
        email: t.Optional(t.String({ format: "email" })),
        age: t.Optional(t.Nullable(t.Number({ minimum: 0 }))),
      }),
    }
  )

  // -------------------------------------------------------------------------
  // DELETE /users/:id  — remove a user
  // -------------------------------------------------------------------------
  .delete(
    "/users/:id",
    async ({ params, set, error }) => {
      const id = Number(params.id);

      if (Number.isNaN(id)) {
        return error(400, { error: "Invalid user id" });
      }

      const rows = await sql<{ id: number }[]>`
        DELETE FROM users
        WHERE id = ${id}
        RETURNING id
      `;

      if (rows.length === 0) {
        return error(404, { error: "User not found" });
      }

      set.status = 204;
      return;
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    }
  )

  // -------------------------------------------------------------------------
  // Global error handler
  // -------------------------------------------------------------------------
  .onError(({ code, error, set }) => {
    if (code === "VALIDATION") {
      set.status = 400;
      return { error: "Validation error", details: error.message };
    }

    if (code === "NOT_FOUND") {
      set.status = 404;
      return { error: "Route not found" };
    }

    console.error("[error]", error);
    set.status = 500;
    return { error: "Internal server error" };
  })

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------
  .listen({ port: PORT, hostname: "0.0.0.0" });

console.log(
  `Elysia (Bun) listening on http://0.0.0.0:${app.server?.port}`
);
