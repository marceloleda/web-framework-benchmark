-- Schema unificado para benchmark de frameworks web
-- Usado por todas as 5 APIs: Express, Fastify, Elysia, Actix-web, Gin

CREATE TABLE IF NOT EXISTS users (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(255) NOT NULL,
    email      VARCHAR(255) NOT NULL UNIQUE,
    age        INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed: 10.000 registros (alinhado com TechEmpower Framework Benchmarks)
-- Nomes e domínios variados para simular dados reais
INSERT INTO users (name, email, age)
SELECT
    (ARRAY[
        'Alice','Bob','Carlos','Diana','Eduardo','Fernanda','Gabriel','Helena',
        'Igor','Julia','Kevin','Laura','Marcos','Natalia','Otto','Paula',
        'Rafael','Sofia','Thiago','Ursula','Victor','Wendy','Xander','Yasmin','Zeca'
    ])[ 1 + (i % 25) ] || ' ' ||
    (ARRAY[
        'Silva','Santos','Oliveira','Souza','Costa','Ferreira','Alves','Pereira',
        'Lima','Carvalho','Melo','Ribeiro','Almeida','Nascimento','Gomes'
    ])[ 1 + (i % 15) ],

    'user' || i || '@' ||
    (ARRAY['gmail.com','outlook.com','yahoo.com','hotmail.com','benchmark.dev'])
    [ 1 + (i % 5) ],

    18 + (i % 62)   -- idades entre 18 e 79 anos

FROM generate_series(1, 10000) AS s(i)
ON CONFLICT DO NOTHING;

-- Índice para buscas por e-mail (POST /users, unicidade)
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Atualiza estatísticas para o query planner usar planos ótimos desde o início
ANALYZE users;
