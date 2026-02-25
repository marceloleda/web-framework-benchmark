# Web Framework Benchmark — Eficiência Energética e Financeira

> Avaliação experimental da eficiência energética e financeira de frameworks web REST baseada nos índices RPS/Watt e RPS/USD.

**Autores:** Paulo Victor Ribeiro da Silva · Marcelo Ferreira Leda Filho

---

## Contexto

Este repositório contém as 5 implementações de uma API REST padronizada usadas no experimento descrito no artigo:

> **"Avaliação Experimental da Eficiência Energética e Financeira de Frameworks Web Baseada em Requisições por Watt e por Dólar"**

O objetivo é medir empiricamente throughput, consumo de CPU, memória e energia de cinco frameworks web de diferentes runtimes, e calcular dois índices propostos:

- **RPS/Watt** — eficiência energética (requisições processadas por watt consumido)
- **RPS/USD** — eficiência financeira (requisições processadas por dólar gasto em cloud)

---

## Frameworks Avaliados

| # | Framework | Runtime | Linguagem | Porta |
|---|-----------|---------|-----------|-------|
| 1 | Express   | Node.js | JavaScript | 3001 |
| 2 | Fastify   | Node.js | JavaScript | 3002 |
| 3 | Elysia    | Bun     | TypeScript | 3003 |
| 4 | Actix-web | —       | Rust       | 3004 |
| 5 | Gin       | —       | Go         | 3005 |

---

## Endpoints (idênticos em todas as APIs)

| Método | Rota               | Descrição                        |
|--------|--------------------|----------------------------------|
| GET    | `/`                | Texto plano (health check)       |
| GET    | `/json`            | Serialização JSON                |
| GET    | `/db`              | Consulta simples ao PostgreSQL   |
| GET    | `/queries?count=N` | N consultas ao PostgreSQL        |
| GET    | `/users`           | Listagem de usuários             |
| GET    | `/users/:id`       | Busca usuário por ID             |
| POST   | `/users`           | Criação de usuário               |
| PUT    | `/users/:id`       | Atualização de usuário           |
| DELETE | `/users/:id`       | Remoção de usuário               |

---

## Como executar

### Pré-requisitos

- Docker e Docker Compose
- [k6](https://k6.io/docs/get-started/installation/) para testes de carga

### Subir todos os serviços

```bash
docker compose up --build
```

### Executar benchmark completo

```bash
bash scripts/run-benchmark.sh
```

### Testar API individual

```bash
# Exemplo: Express
k6 run --env BASE_URL=http://localhost:3001 scripts/load-test.js
```

---

## Estrutura do Repositório

```
.
├── docker-compose.yml
├── scripts/
│   ├── init.sql          # Schema e seed do PostgreSQL
│   ├── load-test.js      # Script k6 de teste de carga
│   └── run-benchmark.sh  # Orquestrador do benchmark
├── api-express/          # Express (Node.js)
├── api-fastify/          # Fastify (Node.js)
├── api-elysia/           # Elysia (Bun)
├── api-actix/            # Actix-web (Rust)
└── api-gin/              # Gin (Go)
```

---

## Métricas Coletadas

- **Throughput** — requisições por segundo (RPS)
- **Latência** — p50, p95, p99 (ms)
- **CPU** — percentual médio durante o teste
- **Memória** — uso médio (MB)
- **Energia** — Joules consumidos (via Intel RAPL / EnergiBridge)
- **RPS/Watt** — throughput por watt consumido
- **RPS/USD** — throughput por dólar/hora em instância AWS t3.medium

---

## Hipótese

> Frameworks baseados em linguagens compiladas (Rust/Actix, Go/Gin) apresentam maior eficiência energética e financeira do que frameworks baseados em linguagens interpretadas (Node.js/Express, Bun/Elysia) ao processar a mesma API REST.

---

## Referências

- Pereira et al. (2017, 2021) — Energy Efficiency across Programming Languages
- Kałaska e Czarnul (2025) — Performance and Energy Comparison of Web Request Processing Models
- TechEmpower Framework Benchmarks — https://www.techempower.com/benchmarks/
- Sallou et al. (2024) — EnergiBridge
