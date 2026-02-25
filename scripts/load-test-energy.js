/**
 * load-test-energy.js — k6 load test para medição de eficiência energética
 *
 * Uso:
 *   k6 run -e API_URL=http://localhost:3001 \
 *           -e TARGET_RPS=200 \
 *           -e DURATION=120s \
 *           scripts/load-test-energy.js
 *
 * Variáveis de ambiente:
 *   API_URL    — URL base da API (default: http://localhost:3001)
 *   TARGET_RPS — requisições/segundo desejadas (default: 200)
 *   DURATION   — duração da fase de carga (default: 120s)
 *
 * Distribuição de endpoints (reflete carga real de leitura + escrita):
 *   40% GET /db              — single random user (DB query)
 *   25% GET /queries?count=5 — multiple random users (DB queries)
 *   20% GET /json            — JSON puro, sem DB (baseline de overhead)
 *   15% GET /users?limit=20  — listagem paginada (DB + COUNT)
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

const API_URL    = __ENV.API_URL    || 'http://localhost:3001';
const TARGET_RPS = parseInt(__ENV.TARGET_RPS || '200', 10);
const DURATION   = __ENV.DURATION   || '120s';

export const options = {
  scenarios: {
    constant_load: {
      executor:        'constant-arrival-rate',
      rate:            TARGET_RPS,
      timeUnit:        '1s',
      duration:        DURATION,
      preAllocatedVUs: Math.ceil(TARGET_RPS * 0.5),   // pré-aloca metade do RPS
      maxVUs:          TARGET_RPS * 3,                 // cap superior
    },
  },
  // Não usa thresholds rígidos — coleta tudo para análise posterior
  thresholds: {
    http_req_failed:   ['rate<0.01'],   // < 1% de falhas (aviso, não aborta)
    http_req_duration: ['p(99)<2000'],  // p99 < 2s  (aviso, não aborta)
  },
};

// ---------------------------------------------------------------------------
// Métricas customizadas por endpoint
// ---------------------------------------------------------------------------

const dbLatency      = new Trend('db_latency',      true);
const queriesLatency = new Trend('queries_latency',  true);
const jsonLatency    = new Trend('json_latency',     true);
const usersLatency   = new Trend('users_latency',    true);

const dbErrors       = new Counter('db_errors');
const queriesErrors  = new Counter('queries_errors');
const jsonErrors     = new Counter('json_errors');
const usersErrors    = new Counter('users_errors');

const successRate    = new Rate('success_rate');

// ---------------------------------------------------------------------------
// Cabeçalhos comuns
// ---------------------------------------------------------------------------

const HEADERS = { 'Content-Type': 'application/json' };

// ---------------------------------------------------------------------------
// Pesos dos endpoints (soma = 100)
// ---------------------------------------------------------------------------

const ENDPOINTS = [
  { weight: 40, name: 'db',      url: `${API_URL}/db` },
  { weight: 25, name: 'queries', url: `${API_URL}/queries?count=5` },
  { weight: 20, name: 'json',    url: `${API_URL}/json` },
  { weight: 15, name: 'users',   url: `${API_URL}/users?limit=20&offset=0` },
];

// Pré-calcula thresholds acumulados para seleção por peso
const cumulative = [];
let sum = 0;
for (const ep of ENDPOINTS) {
  sum += ep.weight;
  cumulative.push({ threshold: sum, ...ep });
}

function pickEndpoint() {
  const r = Math.random() * 100;
  for (const ep of cumulative) {
    if (r < ep.threshold) return ep;
  }
  return cumulative[cumulative.length - 1];
}

// ---------------------------------------------------------------------------
// Função principal (executada por cada VU em cada iteração)
// ---------------------------------------------------------------------------

export default function () {
  const ep  = pickEndpoint();
  const res = http.get(ep.url, { headers: HEADERS });
  const ok  = res.status >= 200 && res.status < 300;

  successRate.add(ok);

  switch (ep.name) {
    case 'db':
      dbLatency.add(res.timings.duration);
      if (!ok) dbErrors.add(1);
      check(res, { 'db: status 200': (r) => r.status === 200 });
      break;
    case 'queries':
      queriesLatency.add(res.timings.duration);
      if (!ok) queriesErrors.add(1);
      check(res, { 'queries: status 200': (r) => r.status === 200 });
      break;
    case 'json':
      jsonLatency.add(res.timings.duration);
      if (!ok) jsonErrors.add(1);
      check(res, { 'json: status 200': (r) => r.status === 200 });
      break;
    case 'users':
      usersLatency.add(res.timings.duration);
      if (!ok) usersErrors.add(1);
      check(res, { 'users: status 200': (r) => r.status === 200 });
      break;
  }
}

// ---------------------------------------------------------------------------
// Hooks de ciclo de vida
// ---------------------------------------------------------------------------

export function setup() {
  // Verifica se a API está respondendo antes de iniciar
  const res = http.get(`${API_URL}/`);
  if (res.status !== 200) {
    console.error(`[setup] API não respondeu em ${API_URL}/ — status: ${res.status}`);
  } else {
    const body = JSON.parse(res.body);
    console.log(`[setup] API OK: framework=${body.framework}, runtime=${body.runtime}`);
  }
  return { apiUrl: API_URL };
}

export function teardown(data) {
  console.log(`[teardown] Teste concluído para ${data.apiUrl}`);
}
