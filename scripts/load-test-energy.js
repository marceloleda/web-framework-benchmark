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
 * Distribuição de endpoints (~70% leitura, ~30% escrita):
 *   35% GET  /db              — single random user (DB read)
 *   20% GET  /queries?count=5 — multiple random users (DB reads)
 *   15% GET  /json            — JSON puro, sem DB (overhead do framework)
 *   15% GET  /users?limit=20  — listagem paginada (DB read + COUNT)
 *   10% POST /users           — criar usuário (DB write + JSON parse)
 *    5% PUT  /users/:id       — atualizar usuário (DB read + write)
 */

import http from 'k6/http';
import { check } from 'k6';
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
      preAllocatedVUs: Math.ceil(TARGET_RPS * 0.5),
      maxVUs:          TARGET_RPS * 3,
    },
  },
  thresholds: {
    http_req_failed:   ['rate<0.01'],
    http_req_duration: ['p(99)<2000'],
  },
};

// ---------------------------------------------------------------------------
// Métricas customizadas por endpoint
// ---------------------------------------------------------------------------

const dbLatency      = new Trend('db_latency',      true);
const queriesLatency = new Trend('queries_latency',  true);
const jsonLatency    = new Trend('json_latency',     true);
const usersLatency   = new Trend('users_latency',    true);
const createLatency  = new Trend('create_latency',   true);
const updateLatency  = new Trend('update_latency',   true);

const dbErrors       = new Counter('db_errors');
const queriesErrors  = new Counter('queries_errors');
const jsonErrors     = new Counter('json_errors');
const usersErrors    = new Counter('users_errors');
const createErrors   = new Counter('create_errors');
const updateErrors   = new Counter('update_errors');

const successRate    = new Rate('success_rate');

// ---------------------------------------------------------------------------
// Cabeçalhos comuns
// ---------------------------------------------------------------------------

const HEADERS = { 'Content-Type': 'application/json' };

// ---------------------------------------------------------------------------
// Helpers para gerar dados de escrita
// ---------------------------------------------------------------------------

// Gera email único por VU + iteração para evitar conflitos
let writeCounter = 0;
function uniqueEmail() {
  writeCounter++;
  return `bench_${__VU}_${writeCounter}_${Date.now()}@test.dev`;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const FIRST_NAMES = ['Ana','Carlos','Maria','Pedro','Julia','Lucas','Fernanda','Rafael','Camila','Diego'];
const LAST_NAMES  = ['Silva','Santos','Oliveira','Costa','Lima','Pereira','Souza','Alves','Rocha','Ferreira'];

function randomName() {
  return FIRST_NAMES[randomInt(0, FIRST_NAMES.length - 1)] + ' ' +
         LAST_NAMES[randomInt(0, LAST_NAMES.length - 1)];
}

// ---------------------------------------------------------------------------
// Pesos dos endpoints (soma = 100)
// ---------------------------------------------------------------------------

const ENDPOINT_WEIGHTS = [
  { weight: 35, name: 'db'     },
  { weight: 20, name: 'queries'},
  { weight: 15, name: 'json'   },
  { weight: 15, name: 'users'  },
  { weight: 10, name: 'create' },
  { weight:  5, name: 'update' },
];

const cumulative = [];
let sum = 0;
for (const ep of ENDPOINT_WEIGHTS) {
  sum += ep.weight;
  cumulative.push({ threshold: sum, ...ep });
}

function pickEndpoint() {
  const r = Math.random() * 100;
  for (const ep of cumulative) {
    if (r < ep.threshold) return ep.name;
  }
  return cumulative[cumulative.length - 1].name;
}

// ---------------------------------------------------------------------------
// Função principal (executada por cada VU em cada iteração)
// ---------------------------------------------------------------------------

export default function () {
  const epName = pickEndpoint();
  let res;
  let ok;

  switch (epName) {
    case 'db': {
      res = http.get(`${API_URL}/db`, { headers: HEADERS });
      ok = res.status >= 200 && res.status < 300;
      dbLatency.add(res.timings.duration);
      if (!ok) dbErrors.add(1);
      check(res, { 'db: status 200': (r) => r.status === 200 });
      break;
    }
    case 'queries': {
      res = http.get(`${API_URL}/queries?count=5`, { headers: HEADERS });
      ok = res.status >= 200 && res.status < 300;
      queriesLatency.add(res.timings.duration);
      if (!ok) queriesErrors.add(1);
      check(res, { 'queries: status 200': (r) => r.status === 200 });
      break;
    }
    case 'json': {
      res = http.get(`${API_URL}/json`, { headers: HEADERS });
      ok = res.status >= 200 && res.status < 300;
      jsonLatency.add(res.timings.duration);
      if (!ok) jsonErrors.add(1);
      check(res, { 'json: status 200': (r) => r.status === 200 });
      break;
    }
    case 'users': {
      res = http.get(`${API_URL}/users?limit=20&offset=0`, { headers: HEADERS });
      ok = res.status >= 200 && res.status < 300;
      usersLatency.add(res.timings.duration);
      if (!ok) usersErrors.add(1);
      check(res, { 'users: status 200': (r) => r.status === 200 });
      break;
    }
    case 'create': {
      const payload = JSON.stringify({
        name:  randomName(),
        email: uniqueEmail(),
        age:   randomInt(18, 65),
      });
      res = http.post(`${API_URL}/users`, payload, { headers: HEADERS });
      // 201 = created, 409 = duplicate email (still counts as framework work)
      ok = res.status === 201 || res.status === 409;
      createLatency.add(res.timings.duration);
      if (!ok) createErrors.add(1);
      check(res, { 'create: status 201|409': (r) => r.status === 201 || r.status === 409 });
      break;
    }
    case 'update': {
      const id = randomInt(1, 10000);
      const payload = JSON.stringify({
        name: randomName(),
        age:  randomInt(18, 65),
      });
      res = http.put(`${API_URL}/users/${id}`, payload, { headers: HEADERS });
      ok = res.status >= 200 && res.status < 300;
      updateLatency.add(res.timings.duration);
      if (!ok) updateErrors.add(1);
      check(res, { 'update: status 200': (r) => r.status === 200 });
      break;
    }
  }

  successRate.add(ok);
}

// ---------------------------------------------------------------------------
// Hooks de ciclo de vida
// ---------------------------------------------------------------------------

export function setup() {
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
