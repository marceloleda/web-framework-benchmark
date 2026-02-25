/**
 * load-test-saturation.js — Rampa progressiva para descobrir o RPS máximo sustentável
 *
 * Executa uma escada de carga: sobe o RPS em degraus fixos, mantém cada degrau
 * por um período de estabilização e detecta o ponto de saturação.
 *
 * Uso:
 *   k6 run \
 *     -e API_URL=http://localhost:3001 \
 *     -e START_RPS=200  \
 *     -e STEP_RPS=200   \
 *     -e MAX_RPS=5000   \
 *     -e STEP_DURATION=30s \
 *     --out csv=results/saturation_express.csv \
 *     scripts/load-test-saturation.js
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
// Parâmetros
// ---------------------------------------------------------------------------

const API_URL       = __ENV.API_URL       || 'http://localhost:3001';
const START_RPS     = parseInt(__ENV.START_RPS     || '200',  10);
const STEP_RPS      = parseInt(__ENV.STEP_RPS      || '200',  10);
const MAX_RPS       = parseInt(__ENV.MAX_RPS       || '5000', 10);
const STEP_DURATION = __ENV.STEP_DURATION || '30s';
const ERR_THRESHOLD = parseFloat(__ENV.ERR_THRESHOLD || '1');   // %
const P99_THRESHOLD = parseFloat(__ENV.P99_THRESHOLD || '1000'); // ms

// ---------------------------------------------------------------------------
// Geração dos degraus (escada)
// ---------------------------------------------------------------------------

function parseDuration(s) {
  if (s.endsWith('s')) return parseInt(s, 10);
  if (s.endsWith('m')) return parseInt(s, 10) * 60;
  return parseInt(s, 10);
}

const stepDurationSec = parseDuration(STEP_DURATION);

const stages = [];

stages.push({ duration: '10s',         target: START_RPS });
stages.push({ duration: STEP_DURATION, target: START_RPS });

for (let rate = START_RPS + STEP_RPS; rate <= MAX_RPS; rate += STEP_RPS) {
  stages.push({ duration: '2s',          target: rate });
  stages.push({ duration: STEP_DURATION, target: rate });
}

const totalSteps = Math.ceil((MAX_RPS - START_RPS) / STEP_RPS) + 1;
const totalSec   = 10 + totalSteps * (stepDurationSec + 2) - 2;
const totalMin   = Math.ceil(totalSec / 60);

// ---------------------------------------------------------------------------
// Opções k6
// ---------------------------------------------------------------------------

export const options = {
  scenarios: {
    saturation_ramp: {
      executor:        'ramping-arrival-rate',
      startRate:       0,
      timeUnit:        '1s',
      stages:          stages,
      preAllocatedVUs: Math.ceil(START_RPS * 0.3),
      maxVUs:          MAX_RPS * 2,
    },
  },

  thresholds: {
    http_req_failed:   [{ threshold: `rate<${ERR_THRESHOLD * 5 / 100}`, abortOnFail: true }],
    http_req_duration: [{ threshold: `p(99)<${P99_THRESHOLD * 3}`,      abortOnFail: true }],
  },
};

// ---------------------------------------------------------------------------
// Métricas customizadas
// ---------------------------------------------------------------------------

const dbLatency      = new Trend('sat_db_latency',      true);
const queriesLatency = new Trend('sat_queries_latency',  true);
const jsonLatency    = new Trend('sat_json_latency',     true);
const usersLatency   = new Trend('sat_users_latency',    true);
const createLatency  = new Trend('sat_create_latency',   true);
const updateLatency  = new Trend('sat_update_latency',   true);
const errorCounter   = new Counter('sat_errors');
const successRate    = new Rate('sat_success_rate');

// ---------------------------------------------------------------------------
// Helpers para gerar dados de escrita
// ---------------------------------------------------------------------------

let writeCounter = 0;
function uniqueEmail() {
  writeCounter++;
  return `sat_${__VU}_${writeCounter}_${Date.now()}@test.dev`;
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
// Seleção de endpoint por peso (mesma distribuição do load-test-energy.js)
// 35% /db · 20% /queries · 15% /json · 15% /users · 10% POST · 5% PUT
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
let acc = 0;
for (const ep of ENDPOINT_WEIGHTS) {
  acc += ep.weight;
  cumulative.push({ threshold: acc, ...ep });
}

function pickEndpoint() {
  const r = Math.random() * 100;
  for (const ep of cumulative) {
    if (r < ep.threshold) return ep.name;
  }
  return cumulative[cumulative.length - 1].name;
}

// ---------------------------------------------------------------------------
// Função principal
// ---------------------------------------------------------------------------

const HEADERS = { 'Content-Type': 'application/json' };

export default function () {
  const epName = pickEndpoint();
  let res;
  let ok;

  switch (epName) {
    case 'db': {
      res = http.get(`${API_URL}/db`, { headers: HEADERS, tags: { endpoint: 'db' } });
      ok = res.status >= 200 && res.status < 300;
      dbLatency.add(res.timings.duration);
      break;
    }
    case 'queries': {
      res = http.get(`${API_URL}/queries?count=5`, { headers: HEADERS, tags: { endpoint: 'queries' } });
      ok = res.status >= 200 && res.status < 300;
      queriesLatency.add(res.timings.duration);
      break;
    }
    case 'json': {
      res = http.get(`${API_URL}/json`, { headers: HEADERS, tags: { endpoint: 'json' } });
      ok = res.status >= 200 && res.status < 300;
      jsonLatency.add(res.timings.duration);
      break;
    }
    case 'users': {
      res = http.get(`${API_URL}/users?limit=20&offset=0`, { headers: HEADERS, tags: { endpoint: 'users' } });
      ok = res.status >= 200 && res.status < 300;
      usersLatency.add(res.timings.duration);
      break;
    }
    case 'create': {
      const payload = JSON.stringify({
        name:  randomName(),
        email: uniqueEmail(),
        age:   randomInt(18, 65),
      });
      res = http.post(`${API_URL}/users`, payload, { headers: HEADERS, tags: { endpoint: 'create' } });
      ok = res.status === 201 || res.status === 409;
      createLatency.add(res.timings.duration);
      break;
    }
    case 'update': {
      const id = randomInt(1, 10000);
      const payload = JSON.stringify({
        name: randomName(),
        age:  randomInt(18, 65),
      });
      res = http.put(`${API_URL}/users/${id}`, payload, { headers: HEADERS, tags: { endpoint: 'update' } });
      ok = res.status >= 200 && res.status < 300;
      updateLatency.add(res.timings.duration);
      break;
    }
  }

  successRate.add(ok);
  if (!ok) errorCounter.add(1);

  check(res, { 'status ok': (r) => r.status >= 200 && r.status < 300 || r.status === 409 });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function setup() {
  const res = http.get(`${API_URL}/`);
  if (res.status !== 200) {
    console.error(`[setup] ERRO: API não respondeu em ${API_URL}/ — status ${res.status}`);
  } else {
    let fw = '?', rt = '?';
    try { const b = JSON.parse(res.body); fw = b.framework; rt = b.runtime; } catch (_) {}
    console.log(`[setup] API OK — framework: ${fw}, runtime: ${rt}`);
    console.log(`[setup] Degraus: ${START_RPS}→${MAX_RPS} req/s  (+${STEP_RPS}/degrau, ${STEP_DURATION}/degrau)`);
    console.log(`[setup] Total estimado: ~${totalMin} min  |  Degraus: ${totalSteps}`);
    console.log(`[setup] Mix: 35% db, 20% queries, 15% json, 15% users, 10% create, 5% update`);
    console.log(`[setup] Abort em: erro>${ERR_THRESHOLD * 5}%  ou  p99>${P99_THRESHOLD * 3}ms`);
  }
  return { apiUrl: API_URL, startRps: START_RPS, stepRps: STEP_RPS, maxRps: MAX_RPS };
}

// ---------------------------------------------------------------------------
// handleSummary
// ---------------------------------------------------------------------------

export function handleSummary(data) {
  const m  = data.metrics;
  const rr = m.http_reqs?.values?.rate ?? 0;
  const p50 = m.http_req_duration?.values?.['p(50)'] ?? 0;
  const p95 = m.http_req_duration?.values?.['p(95)'] ?? 0;
  const p99 = m.http_req_duration?.values?.['p(99)'] ?? 0;
  const errRate = (m.http_req_failed?.values?.rate ?? 0) * 100;
  const total   = m.http_reqs?.values?.count ?? 0;

  const lines = [
    '',
    '╔══════════════════════════════════════════════════════════════╗',
    '║         RESULTADO — TESTE DE SATURAÇÃO PROGRESSIVA          ║',
    '╠══════════════════════════════════════════════════════════════╣',
    `║  API:              ${API_URL.padEnd(40)} ║`,
    `║  Rampa:            ${String(START_RPS).padEnd(6)} → ${String(MAX_RPS).padEnd(6)} req/s  (+${STEP_RPS}/degrau)  ║`,
    '╠══════════════════════════════════════════════════════════════╣',
    `║  RPS médio global: ${rr.toFixed(1).padStart(8)} req/s                           ║`,
    `║  Requisições:      ${String(total).padStart(8)}                                 ║`,
    `║  Erro:             ${errRate.toFixed(4).padStart(8)} %                               ║`,
    `║  Latência P50:     ${p50.toFixed(2).padStart(8)} ms                              ║`,
    `║  Latência P95:     ${p95.toFixed(2).padStart(8)} ms                              ║`,
    `║  Latência P99:     ${p99.toFixed(2).padStart(8)} ms                              ║`,
    '╠══════════════════════════════════════════════════════════════╣',
    '║  Mix: 35%db 20%queries 15%json 15%users 10%create 5%update  ║',
    '╚══════════════════════════════════════════════════════════════╝',
    '',
  ];

  console.log(lines.join('\n'));

  return {
    stdout: lines.join('\n'),
  };
}
