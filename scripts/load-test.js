// Script de teste de carga com k6
// Uso: k6 run --env BASE_URL=http://localhost:3001 scripts/load-test.js
// Documentação: https://k6.io/docs/

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3001";

// Métricas customizadas
const errCount = new Counter("errors");
const dbLatency = new Trend("db_query_latency", true);

export const options = {
  stages: [
    { duration: "30s", target: 50 },   // ramp-up
    { duration: "60s", target: 200 },  // carga sustentada
    { duration: "30s", target: 500 },  // pico
    { duration: "30s", target: 0 },    // ramp-down
  ],
  thresholds: {
    http_req_failed: ["rate<0.01"],    // <1% de erros
    http_req_duration: ["p(95)<500"],  // 95% das requests < 500ms
  },
};

export default function () {
  // 1. Texto plano (warmup)
  const plainText = http.get(`${BASE_URL}/`);
  check(plainText, { "plain text 200": (r) => r.status === 200 });

  // 2. Serialização JSON
  const json = http.get(`${BASE_URL}/json`);
  check(json, { "json 200": (r) => r.status === 200 });

  // 3. Consulta simples ao banco
  const dbStart = new Date();
  const dbSingle = http.get(`${BASE_URL}/db`);
  dbLatency.add(new Date() - dbStart);
  check(dbSingle, { "db single 200": (r) => r.status === 200 });

  // 4. Múltiplas consultas ao banco
  const dbMulti = http.get(`${BASE_URL}/queries?count=5`);
  check(dbMulti, { "db multi 200": (r) => r.status === 200 });

  // 5. Listagem de usuários
  const list = http.get(`${BASE_URL}/users`);
  check(list, { "list 200": (r) => r.status === 200 });

  // 6. Busca de usuário por ID
  const userId = Math.floor(Math.random() * 1000) + 1;
  const byId = http.get(`${BASE_URL}/users/${userId}`);
  check(byId, {
    "get by id 200 or 404": (r) => r.status === 200 || r.status === 404,
  });

  // 7. Criação de usuário
  const timestamp = Date.now();
  const payload = JSON.stringify({
    name: `Load Test User ${timestamp}`,
    email: `loadtest_${timestamp}_${Math.random().toString(36).slice(2)}@test.dev`,
    age: 25,
  });
  const headers = { "Content-Type": "application/json" };
  const create = http.post(`${BASE_URL}/users`, payload, { headers });
  check(create, { "create 201": (r) => r.status === 201 });

  if (create.status !== 201) {
    errCount.add(1);
  }

  sleep(0.1);
}
