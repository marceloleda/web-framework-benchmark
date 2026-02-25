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
 * Variáveis de ambiente:
 *   API_URL        — URL base da API          (default: http://localhost:3001)
 *   START_RPS      — RPS inicial              (default: 200)
 *   STEP_RPS       — incremento por degrau    (default: 200)
 *   MAX_RPS        — teto máximo de RPS       (default: 5000)
 *   STEP_DURATION  — tempo em cada degrau     (default: 30s)
 *   ERR_THRESHOLD  — % de erro para abortar   (default: 1)
 *   P99_THRESHOLD  — p99 máximo em ms         (default: 1000)
 *
 * Degraus gerados (exemplo com defaults):
 *   200 → 400 → 600 → ... → 5000 req/s
 *   Total: 25 degraus × 30s = ~12,5 min por framework
 *
 * Saída:
 *   - Terminal: progresso em tempo real via k6 (RPS real, latência, erros)
 *   - CSV (--out csv): série temporal com granularidade de 1s para pós-análise
 *   - handleSummary: tabela final + estimativa do ponto de saturação
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
//
// Padrão: para cada nível de carga → sobe rapidamente (2s) → mantém (STEP_DURATION)
//
// Ex: START=200, STEP=200, MAX=600, DURATION=30s
//   stages: [ {dur:5s, target:200}, {dur:30s, target:200},
//             {dur:2s, target:400}, {dur:30s, target:400},
//             {dur:2s, target:600}, {dur:30s, target:600} ]
// ---------------------------------------------------------------------------

function parseDuration(s) {
  if (s.endsWith('s')) return parseInt(s, 10);
  if (s.endsWith('m')) return parseInt(s, 10) * 60;
  return parseInt(s, 10);
}

const stepDurationSec = parseDuration(STEP_DURATION);

const stages = [];

// Primeiro degrau: sobe suavemente de 0 até START_RPS
stages.push({ duration: '10s',         target: START_RPS });
stages.push({ duration: STEP_DURATION, target: START_RPS });

for (let rate = START_RPS + STEP_RPS; rate <= MAX_RPS; rate += STEP_RPS) {
  stages.push({ duration: '2s',          target: rate }); // degrau rápido
  stages.push({ duration: STEP_DURATION, target: rate }); // estabilização
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
      maxVUs:          MAX_RPS * 2,  // pior caso: p99=500ms → 2 VUs por req/s
    },
  },

  // Aborta apenas em falhas catastróficas (>5× o threshold normal)
  // Para detecção fina do ponto de saturação, use o CSV + find-saturation.py
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
const errorCounter   = new Counter('sat_errors');
const successRate    = new Rate('sat_success_rate');

// ---------------------------------------------------------------------------
// Seleção de endpoint por peso (mesma distribuição do load-test-energy.js)
// 40% /db · 25% /queries?count=5 · 20% /json · 15% /users?limit=20
// ---------------------------------------------------------------------------

const ENDPOINTS = [
  { weight: 40, name: 'db',      url: `${API_URL}/db` },
  { weight: 25, name: 'queries', url: `${API_URL}/queries?count=5` },
  { weight: 20, name: 'json',    url: `${API_URL}/json` },
  { weight: 15, name: 'users',   url: `${API_URL}/users?limit=20&offset=0` },
];

const cumulative = [];
let acc = 0;
for (const ep of ENDPOINTS) {
  acc += ep.weight;
  cumulative.push({ threshold: acc, ...ep });
}

function pickEndpoint() {
  const r = Math.random() * 100;
  for (const ep of cumulative) {
    if (r < ep.threshold) return ep;
  }
  return cumulative[cumulative.length - 1];
}

// ---------------------------------------------------------------------------
// Função principal
// ---------------------------------------------------------------------------

const HEADERS = { 'Content-Type': 'application/json' };

export default function () {
  const ep  = pickEndpoint();
  const res = http.get(ep.url, { headers: HEADERS, tags: { endpoint: ep.name } });
  const ok  = res.status >= 200 && res.status < 300;

  successRate.add(ok);
  if (!ok) errorCounter.add(1);

  switch (ep.name) {
    case 'db':      dbLatency.add(res.timings.duration);      break;
    case 'queries': queriesLatency.add(res.timings.duration); break;
    case 'json':    jsonLatency.add(res.timings.duration);    break;
    case 'users':   usersLatency.add(res.timings.duration);   break;
  }

  check(res, { 'status 2xx': (r) => r.status >= 200 && r.status < 300 });
}

// ---------------------------------------------------------------------------
// Setup: verifica saúde da API antes de começar
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
    console.log(`[setup] Abort em: erro>${ERR_THRESHOLD * 5}%  ou  p99>${P99_THRESHOLD * 3}ms`);
  }
  return { apiUrl: API_URL, startRps: START_RPS, stepRps: STEP_RPS, maxRps: MAX_RPS };
}

// ---------------------------------------------------------------------------
// handleSummary: tabela resumo + nota sobre ponto de saturação
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
    '║  Para encontrar o ponto exato de saturação, execute:        ║',
    '║    python3 scripts/find-saturation.py \\                     ║',
    '║      --csv results/saturation_<fw>.csv \\                    ║',
    '║      --step-rps 200 --step-duration 30                      ║',
    '╚══════════════════════════════════════════════════════════════╝',
    '',
  ];

  console.log(lines.join('\n'));

  return {
    stdout: lines.join('\n'),
  };
}
