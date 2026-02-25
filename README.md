# Web Framework Benchmark — Eficiência Energética e Financeira

> Avaliação experimental da eficiência energética e financeira de frameworks web REST baseada nos índices RPS/Watt e RPS/USD.

**Autores:** Paulo Victor Ribeiro da Silva · Marcelo Ferreira Leda Filho

---

## Contexto

Este repositório contém as 5 implementações de uma API REST padronizada usadas no experimento descrito no artigo:

> **"Avaliação Experimental da Eficiência Energética e Financeira de Frameworks Web Baseada em Requisições por Watt e por Dólar"**

O objetivo é medir empiricamente throughput, consumo de CPU, memória e energia de cinco frameworks web de diferentes runtimes, e calcular dois índices compostos propostos:

- **RPS/Watt** — eficiência energética (requisições processadas por watt consumido)
- **RPS/USD** — eficiência financeira (requisições processadas por dólar/hora em cloud)

---

## Hipótese

> **H1:** O ranking de frameworks web por RPS/Watt e RPS/USD difere do ranking baseado exclusivamente em throughput (RPS), evidenciando que métricas compostas revelam diferenças de eficiência operacional não capturadas por rankings unidimensionais.

A hipótese é motivada pela observação de que throughput alto não implica necessariamente eficiência energética ou financeira proporcional: um framework pode alcançar alto RPS com uso intenso de CPU (consumindo mais energia e mais vCPUs pagas), enquanto outro pode obter RPS similar com menor consumo de recursos — resultando em posições distintas nos rankings compostos.

---

## Frameworks Avaliados

| # | Framework | Runtime | Linguagem | Porta |
|---|-----------|---------|-----------|-------|
| 1 | Express   | Node.js 20 | JavaScript | 3001 |
| 2 | Fastify   | Node.js 20 | JavaScript | 3002 |
| 3 | Elysia    | Bun        | TypeScript | 3003 |
| 4 | Actix-web | Rust       | Rust       | 3004 |
| 5 | Gin       | Go 1.22    | Go         | 3005 |

---

## Endpoints (idênticos em todas as APIs)

| Método | Rota                       | Descrição                                          |
|--------|----------------------------|----------------------------------------------------|
| GET    | `/`                        | Health check (resposta JSON sem DB)                |
| GET    | `/json`                    | Serialização JSON (sem DB)                         |
| GET    | `/db`                      | Consulta simples ao PostgreSQL (1 usuário aleatório)|
| GET    | `/queries?count=N`         | N consultas ao PostgreSQL (1–500, default 1)       |
| GET    | `/users`                   | Listagem de todos os usuários                      |
| GET    | `/users?limit=N&offset=N`  | Listagem paginada (limit 1–100, offset ≥0)         |
| GET    | `/users/:id`               | Busca usuário por ID                               |
| POST   | `/users`                   | Criação de usuário                                 |
| PUT    | `/users/:id`               | Atualização parcial de usuário                     |
| DELETE | `/users/:id`               | Remoção de usuário (204 No Content)                |

---

## Estrutura do Repositório

```
.
├── docker-compose.yml
├── scripts/
│   ├── init.sql                 # Schema PostgreSQL + 1000 registros seed
│   ├── load-test.js             # k6: teste de carga funcional (todos os endpoints)
│   ├── load-test-energy.js      # k6: teste de carga para medição de energia
│   ├── check-prerequisites.sh   # Verifica Docker, k6, RAPL, Python, portas
│   ├── run-experiment.sh        # Orquestrador completo do experimento
│   └── analyze-results.py       # Análise: métricas, rankings, testes estatísticos, gráficos
├── api-express/                 # Express (Node.js)
├── api-fastify/                 # Fastify (Node.js)
├── api-elysia/                  # Elysia (Bun)
├── api-actix/                   # Actix-web (Rust)
└── api-gin/                     # Gin (Go)
```

---

## Como Executar o Experimento

### 1. Verificar pré-requisitos

```bash
bash scripts/check-prerequisites.sh
```

Verifica: Docker, docker compose, k6, Python 3, Intel RAPL, CPU governor, portas livres, espaço em disco.

### 2. Rodar o experimento completo

```bash
bash scripts/run-experiment.sh
```

Parâmetros opcionais:

```bash
bash scripts/run-experiment.sh \
  --runs 5          # rodadas por framework (default: 5)
  --rps 200         # req/s alvo durante o teste (default: 200)
  --duration 120s   # duração de cada rodada (default: 120s)
  --no-rapl         # desabilita leitura RAPL (p.ex. em VMs sem suporte)
  --skip-build      # pula o docker build (usa imagens já construídas)
```

O script executa automaticamente:
1. Build das imagens Docker
2. Inicialização do PostgreSQL com seed de 1000 usuários
3. Medição de baseline de energia (60s idle)
4. Para cada framework: warm-up (30s) + N rodadas de 120s
5. Coleta de RAPL (energia), docker stats (CPU%, memória) e saída k6 (RPS, latências)
6. Análise estatística e geração de tabela final

### 3. Analisar resultados isoladamente

```bash
python3 scripts/analyze-results.py \
  --results-dir results/<timestamp> \
  --output-dir  results/<timestamp>
```

### 4. Subir os serviços manualmente (desenvolvimento)

```bash
docker compose up --build
```

### 5. Testar API individual

```bash
# Exemplo: Fastify
k6 run -e API_URL=http://localhost:3002 scripts/load-test-energy.js
```

---

## Métricas Coletadas

| Métrica | Descrição | Ferramenta |
|---------|-----------|------------|
| RPS | Requisições por segundo (throughput) | k6 |
| P50/P95/P99 | Latência por percentil (ms) | k6 |
| CPU% | Percentual médio de CPU durante o teste | docker stats |
| Mem (MB) | Uso médio de memória | docker stats |
| Energia (µJ) | Energia consumida pelo pacote CPU | Intel RAPL |
| Potência (W) | Potência média = energia / tempo | Derivado de RAPL |
| **RPS/Watt** | Throughput por watt (líquido de baseline) | Calculado |
| **RPS/USD** | Throughput extrapolado por dólar/hora | Calculado |

### Fórmulas

```
RPS/Watt = RPS_mediana / (Power_API - Power_baseline)

RPS_extrapolado = RPS_mediana × (100 / CPU%_mediana)
RPS/USD = RPS_extrapolado / custo_horário_instância
```

Instância de referência: **AWS t3.medium** (2 vCPU, 4 GB RAM, us-east-1) a **US$ 0.0416/h**.

---

## Infraestrutura

- **Banco de dados:** PostgreSQL 16, tabela `users` com 1.000 registros seed
- **Pool de conexões:** 10 conexões por API
- **Teste de carga:** k6 com `constant-arrival-rate` executor
- **Distribuição de endpoints:** 40% `/db`, 25% `/queries?count=5`, 20% `/json`, 15% `/users?limit=20`
- **Medição de energia:** Intel RAPL via `/sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj`
- **Isolamento:** cada API é testada individualmente (apenas ela + postgres rodando)

---

## Referências

- Pereira et al. (2017, 2021) — Energy Efficiency across Programming Languages
- Kałaska e Czarnul (2025) — Performance and Energy Comparison of Web Request Processing Models
- TechEmpower Framework Benchmarks — https://www.techempower.com/benchmarks/
- Sallou et al. (2024) — EnergiBridge: Measuring Software Energy Consumption
