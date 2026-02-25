-- Schema unificado para benchmark de frameworks web
-- Usado por todas as 5 APIs: Express, Fastify, Elysia, Actix-web, Gin

CREATE TABLE IF NOT EXISTS users (
    id        SERIAL PRIMARY KEY,
    name      VARCHAR(255) NOT NULL,
    email     VARCHAR(255) NOT NULL UNIQUE,
    age       INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed: 1000 registros iniciais para consultas
INSERT INTO users (name, email, age)
SELECT
    'User ' || i,
    'user' || i || '@benchmark.dev',
    (18 + (i % 50))
FROM generate_series(1, 1000) AS s(i)
ON CONFLICT DO NOTHING;

-- Índice para acelerar buscas por e-mail
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
