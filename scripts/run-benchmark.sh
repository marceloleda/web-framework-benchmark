#!/bin/bash
# Script principal de benchmark
# Executa testes de carga em todas as APIs e coleta métricas

set -e

RESULTS_DIR="./results/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$RESULTS_DIR"

APIS=(
  "express:3001"
  "fastify:3002"
  "elysia:3003"
  "actix:3004"
  "gin:3005"
)

echo "======================================"
echo " Benchmark: Eficiência Energética Web"
echo " $(date)"
echo "======================================"

for api_port in "${APIS[@]}"; do
  API_NAME="${api_port%%:*}"
  PORT="${api_port##*:}"
  BASE_URL="http://localhost:${PORT}"

  echo ""
  echo ">>> Testando: ${API_NAME} em ${BASE_URL}"

  # Aguarda API estar pronta
  for i in $(seq 1 30); do
    if curl -sf "${BASE_URL}/" > /dev/null 2>&1; then
      echo "    API pronta."
      break
    fi
    echo "    Aguardando API... (${i}/30)"
    sleep 2
  done

  # Executa k6
  k6 run \
    --env BASE_URL="${BASE_URL}" \
    --out json="${RESULTS_DIR}/${API_NAME}.json" \
    --summary-export="${RESULTS_DIR}/${API_NAME}_summary.json" \
    ./scripts/load-test.js \
    2>&1 | tee "${RESULTS_DIR}/${API_NAME}.log"

  echo "    Resultado salvo em: ${RESULTS_DIR}/${API_NAME}_summary.json"
done

echo ""
echo "======================================"
echo " Benchmark concluído!"
echo " Resultados em: ${RESULTS_DIR}"
echo "======================================"

# Gera tabela comparativa simples
echo ""
echo "API            | HTTP Req/s (med) | p95 (ms) | Error Rate"
echo "---------------|-----------------|----------|-----------"
for api_port in "${APIS[@]}"; do
  API_NAME="${api_port%%:*}"
  SUMMARY="${RESULTS_DIR}/${API_NAME}_summary.json"
  if [ -f "$SUMMARY" ]; then
    RPS=$(jq -r '.metrics.http_reqs.values.rate // "N/A"' "$SUMMARY" 2>/dev/null || echo "N/A")
    P95=$(jq -r '.metrics.http_req_duration.values["p(95)"] // "N/A"' "$SUMMARY" 2>/dev/null || echo "N/A")
    ERR=$(jq -r '.metrics.http_req_failed.values.rate // "N/A"' "$SUMMARY" 2>/dev/null || echo "N/A")
    printf "%-14s | %-15s | %-8s | %s\n" "$API_NAME" "$RPS" "$P95" "$ERR"
  fi
done
