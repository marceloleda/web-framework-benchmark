#!/usr/bin/env bash
# run-experiment.sh — orquestrador completo do experimento de eficiência energética
#
# Procedimento:
#   1. Verifica pré-requisitos
#   2. Inicia o banco de dados
#   3. Mede baseline de energia do sistema (idle)
#   4. Para cada framework (5 APIs):
#        a. Sobe apenas a API em questão
#        b. Aquece a API (warm-up de 30s)
#        c. Executa N rodadas de carga (120s cada)
#           - Lê RAPL antes e depois de cada rodada
#           - Coleta CPU% e memória via docker stats
#           - Salva resultado do k6 em CSV
#        d. Derruba a API
#   5. Chama analyze-results.py para computar métricas e gerar tabela final
#   6. Exibe tabela no terminal
#
# Uso:
#   ./scripts/run-experiment.sh [--runs N] [--rps N] [--duration Xs] [--no-rapl] [--skip-build]
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Parâmetros (com defaults)
# ---------------------------------------------------------------------------

RUNS=5            # rodadas por framework
TARGET_RPS=200    # requisições/segundo
DURATION=120s     # duração de cada rodada de carga
WARMUP_DURATION=30s
USE_RAPL=true     # desabilitar com --no-rapl
SKIP_BUILD=false  # pular docker build com --skip-build

while [[ $# -gt 0 ]]; do
  case $1 in
    --runs)     RUNS="$2";         shift 2 ;;
    --rps)      TARGET_RPS="$2";   shift 2 ;;
    --duration) DURATION="$2";     shift 2 ;;
    --no-rapl)  USE_RAPL=false;    shift   ;;
    --skip-build) SKIP_BUILD=true; shift   ;;
    *) echo "Argumento desconhecido: $1"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Caminhos
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="$PROJECT_DIR/results/$(date +%Y%m%d_%H%M%S)"
RAPL_PATH="/sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj"
LOAD_TEST_SCRIPT="$SCRIPT_DIR/load-test-energy.js"
ANALYZE_SCRIPT="$SCRIPT_DIR/analyze-results.py"

mkdir -p "$RESULTS_DIR"

# ---------------------------------------------------------------------------
# Cores e helpers de log
# ---------------------------------------------------------------------------

CYAN='\033[0;36m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
RED='\033[0;31m';  BOLD='\033[1m';      NC='\033[0m'

log()     { echo -e "${CYAN}[$(date +%H:%M:%S)]${NC} $*"; }
success() { echo -e "${GREEN}[$(date +%H:%M:%S)] ✓${NC} $*"; }
error()   { echo -e "${RED}[$(date +%H:%M:%S)] ✗${NC} $*" >&2; }
header()  { echo -e "\n${BOLD}${YELLOW}=== $* ===${NC}\n"; }

# Lê contador RAPL em µJ (retorna 0 se indisponível)
read_rapl() {
  if $USE_RAPL && [ -r "$RAPL_PATH" ]; then
    cat "$RAPL_PATH"
  else
    echo "0"
  fi
}

# Retorna timestamp Unix em milissegundos
now_ms() { date +%s%3N; }

# ---------------------------------------------------------------------------
# Frameworks definidos
# ---------------------------------------------------------------------------

declare -A FRAMEWORK_PORTS=(
  [express]=3001
  [fastify]=3002
  [elysia]=3003
  [actix]=3004
  [gin]=3005
)

declare -A FRAMEWORK_SERVICES=(
  [express]=api-express
  [fastify]=api-fastify
  [elysia]=api-elysia
  [actix]=api-actix
  [gin]=api-gin
)

FRAMEWORK_ORDER=(express fastify elysia actix gin)

# ---------------------------------------------------------------------------
# Verifica pré-requisitos básicos
# ---------------------------------------------------------------------------

header "Verificando pré-requisitos"

if ! command -v k6 &>/dev/null; then
  error "k6 não encontrado. Instale: https://k6.io/docs/getting-started/installation/"
  exit 1
fi
if ! command -v docker &>/dev/null; then
  error "docker não encontrado"
  exit 1
fi
if ! docker compose version &>/dev/null 2>&1; then
  error "docker compose não encontrado"
  exit 1
fi
if ! command -v python3 &>/dev/null; then
  error "python3 não encontrado"
  exit 1
fi

if $USE_RAPL; then
  if [ ! -r "$RAPL_PATH" ]; then
    log "RAPL não acessível em $RAPL_PATH — continuando sem medição RAPL"
    USE_RAPL=false
  else
    success "RAPL disponível"
  fi
fi

success "Todos os pré-requisitos OK"

# ---------------------------------------------------------------------------
# Salva configuração do experimento
# ---------------------------------------------------------------------------

cat > "$RESULTS_DIR/experiment_config.json" <<EOF
{
  "timestamp":   "$(date -Iseconds)",
  "runs":        $RUNS,
  "target_rps":  $TARGET_RPS,
  "duration":    "$DURATION",
  "rapl_used":   $USE_RAPL,
  "rapl_path":   "$RAPL_PATH",
  "hostname":    "$(hostname)",
  "kernel":      "$(uname -r)",
  "cpu_model":   "$(grep 'model name' /proc/cpuinfo 2>/dev/null | head -1 | cut -d: -f2 | xargs || echo unknown)",
  "cpu_cores":   $(nproc),
  "ram_gb":      $(awk '/MemTotal/{printf "%.1f", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo 0)
}
EOF
log "Configuração salva em $RESULTS_DIR/experiment_config.json"

# ---------------------------------------------------------------------------
# Build das imagens
# ---------------------------------------------------------------------------

if ! $SKIP_BUILD; then
  header "Build das imagens Docker"
  cd "$PROJECT_DIR"
  docker compose build --parallel
  success "Imagens construídas"
fi

# ---------------------------------------------------------------------------
# Inicia PostgreSQL
# ---------------------------------------------------------------------------

header "Iniciando PostgreSQL"
cd "$PROJECT_DIR"
docker compose up -d postgres

log "Aguardando PostgreSQL ficar pronto..."
for i in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U benchmark -d benchmark &>/dev/null 2>&1; then
    success "PostgreSQL pronto (tentativa $i)"
    break
  fi
  if [ "$i" -eq 30 ]; then
    error "PostgreSQL não ficou pronto em 30s"
    exit 1
  fi
  sleep 1
done

# ---------------------------------------------------------------------------
# Medição de baseline (sistema idle + só postgres)
# ---------------------------------------------------------------------------

header "Medindo baseline de energia (sistema idle)"

BASELINE_DURATION=60
log "Aguardando ${BASELINE_DURATION}s com sistema idle (apenas postgres rodando)..."

BASELINE_RAPL_START=$(read_rapl)
BASELINE_TS_START=$(now_ms)
sleep "$BASELINE_DURATION"
BASELINE_TS_END=$(now_ms)
BASELINE_RAPL_END=$(read_rapl)

BASELINE_ELAPSED_MS=$(( BASELINE_TS_END - BASELINE_TS_START ))

# Energia baseline em µJ → Watts (power)
if $USE_RAPL && [ "$BASELINE_RAPL_START" -ne 0 ]; then
  # Trata overflow do contador RAPL (wraps em ~32-bit µJ)
  if [ "$BASELINE_RAPL_END" -ge "$BASELINE_RAPL_START" ]; then
    BASELINE_ENERGY_UJ=$(( BASELINE_RAPL_END - BASELINE_RAPL_START ))
  else
    # max_energy_range_uj
    MAX_RANGE=$(cat /sys/class/powercap/intel-rapl/intel-rapl:0/max_energy_range_uj 2>/dev/null || echo "4294967296")
    BASELINE_ENERGY_UJ=$(( MAX_RANGE - BASELINE_RAPL_START + BASELINE_RAPL_END ))
  fi
  BASELINE_POWER_W=$(echo "scale=4; $BASELINE_ENERGY_UJ / $BASELINE_ELAPSED_MS / 1000" | bc)
else
  BASELINE_ENERGY_UJ=0
  BASELINE_POWER_W=0
fi

cat > "$RESULTS_DIR/baseline.json" <<EOF
{
  "rapl_start_uj":   $BASELINE_RAPL_START,
  "rapl_end_uj":     $BASELINE_RAPL_END,
  "energy_uj":       $BASELINE_ENERGY_UJ,
  "elapsed_ms":      $BASELINE_ELAPSED_MS,
  "power_watts":     $BASELINE_POWER_W,
  "duration_s":      $BASELINE_DURATION
}
EOF
success "Baseline: ${BASELINE_POWER_W}W (${BASELINE_ENERGY_UJ}µJ em ${BASELINE_ELAPSED_MS}ms)"

# ---------------------------------------------------------------------------
# Experimento por framework
# ---------------------------------------------------------------------------

SUMMARY_CSV="$RESULTS_DIR/summary.csv"
echo "framework,run,rps,p50_ms,p95_ms,p99_ms,error_rate,rapl_start_uj,rapl_end_uj,energy_uj,elapsed_ms,power_watts,cpu_pct,mem_mb" > "$SUMMARY_CSV"

for FRAMEWORK in "${FRAMEWORK_ORDER[@]}"; do
  SERVICE="${FRAMEWORK_SERVICES[$FRAMEWORK]}"
  PORT="${FRAMEWORK_PORTS[$FRAMEWORK]}"
  API_URL="http://localhost:$PORT"
  FW_DIR="$RESULTS_DIR/$FRAMEWORK"
  mkdir -p "$FW_DIR"

  header "Framework: $FRAMEWORK (porta $PORT)"

  # --- Sobe a API ---
  log "Iniciando container $SERVICE..."
  docker compose up -d "$SERVICE"

  log "Aguardando API responder em $API_URL/..."
  for i in $(seq 1 30); do
    if curl -sf "$API_URL/" &>/dev/null 2>&1; then
      success "API $FRAMEWORK respondendo (tentativa $i)"
      break
    fi
    if [ "$i" -eq 30 ]; then
      error "API $FRAMEWORK não respondeu em 30s"
      docker compose logs "$SERVICE" | tail -20 >&2
      docker compose stop "$SERVICE"
      continue 2
    fi
    sleep 1
  done

  # --- Warm-up ---
  log "Warm-up de $WARMUP_DURATION ($FRAMEWORK)..."
  k6 run \
    -e API_URL="$API_URL" \
    -e TARGET_RPS="$TARGET_RPS" \
    -e DURATION="$WARMUP_DURATION" \
    --quiet \
    "$LOAD_TEST_SCRIPT" || true
  success "Warm-up concluído"

  # --- Rodadas de medição ---
  for RUN in $(seq 1 "$RUNS"); do
    log "Rodada $RUN/$RUNS ($FRAMEWORK)..."
    RUN_DIR="$FW_DIR/run_$RUN"
    mkdir -p "$RUN_DIR"
    K6_OUTPUT="$RUN_DIR/k6_summary.json"

    # Coleta docker stats em background
    STATS_FILE="$RUN_DIR/docker_stats.csv"
    echo "timestamp,cpu_pct,mem_mb" > "$STATS_FILE"
    docker stats --no-trunc --format \
      "{{.Name}},{{.CPUPerc}},{{.MemUsage}}" \
      "$SERVICE" 2>/dev/null \
      | awk -F',' -v OFS=',' '{
          t=systime();
          cpu=$2; gsub(/%/,"",cpu);
          mem=$3; gsub(/ MiB.*/,"",mem); gsub(/.*\//,"",mem);
          print t, cpu, mem
        }' >> "$STATS_FILE" &
    STATS_PID=$!

    # Lê RAPL antes
    RAPL_START=$(read_rapl)
    TS_START=$(now_ms)

    # Executa k6
    k6 run \
      -e API_URL="$API_URL" \
      -e TARGET_RPS="$TARGET_RPS" \
      -e DURATION="$DURATION" \
      --summary-export="$K6_OUTPUT" \
      --quiet \
      "$LOAD_TEST_SCRIPT" || true

    # Lê RAPL depois
    TS_END=$(now_ms)
    RAPL_END=$(read_rapl)

    # Para coleta de stats
    kill "$STATS_PID" 2>/dev/null || true
    wait "$STATS_PID" 2>/dev/null || true

    # Calcula energia
    ELAPSED_MS=$(( TS_END - TS_START ))

    if $USE_RAPL && [ "$RAPL_START" -ne 0 ]; then
      if [ "$RAPL_END" -ge "$RAPL_START" ]; then
        ENERGY_UJ=$(( RAPL_END - RAPL_START ))
      else
        MAX_RANGE=$(cat /sys/class/powercap/intel-rapl/intel-rapl:0/max_energy_range_uj 2>/dev/null || echo "4294967296")
        ENERGY_UJ=$(( MAX_RANGE - RAPL_START + RAPL_END ))
      fi
      POWER_W=$(echo "scale=4; $ENERGY_UJ / $ELAPSED_MS / 1000" | bc)
    else
      ENERGY_UJ=0
      POWER_W=0
    fi

    # Extrai métricas do k6 summary JSON
    RPS=$(python3 -c "
import json, sys
with open('$K6_OUTPUT') as f: d = json.load(f)
rps = d.get('metrics', {}).get('http_reqs', {}).get('rate', 0)
print(f'{rps:.2f}')
" 2>/dev/null || echo "0")

    P50=$(python3 -c "
import json
with open('$K6_OUTPUT') as f: d = json.load(f)
v = d.get('metrics',{}).get('http_req_duration',{}).get('values',{})
print(f\"{v.get('p(50)',0):.2f}\")
" 2>/dev/null || echo "0")

    P95=$(python3 -c "
import json
with open('$K6_OUTPUT') as f: d = json.load(f)
v = d.get('metrics',{}).get('http_req_duration',{}).get('values',{})
print(f\"{v.get('p(95)',0):.2f}\")
" 2>/dev/null || echo "0")

    P99=$(python3 -c "
import json
with open('$K6_OUTPUT') as f: d = json.load(f)
v = d.get('metrics',{}).get('http_req_duration',{}).get('values',{})
print(f\"{v.get('p(99)',0):.2f}\")
" 2>/dev/null || echo "0")

    ERR_RATE=$(python3 -c "
import json
with open('$K6_OUTPUT') as f: d = json.load(f)
v = d.get('metrics',{}).get('http_req_failed',{}).get('values',{})
print(f\"{v.get('rate',0)*100:.4f}\")
" 2>/dev/null || echo "0")

    # CPU% médio da rodada
    CPU_PCT=$(awk -F',' 'NR>1 && $2!="" {sum+=$2; n++} END {if(n>0) printf "%.2f", sum/n; else print "0"}' "$STATS_FILE" 2>/dev/null || echo "0")
    MEM_MB=$(awk  -F',' 'NR>1 && $3!="" {sum+=$3; n++} END {if(n>0) printf "%.1f", sum/n; else print "0"}' "$STATS_FILE" 2>/dev/null || echo "0")

    # Adiciona linha no summary
    echo "$FRAMEWORK,$RUN,$RPS,$P50,$P95,$P99,$ERR_RATE,$RAPL_START,$RAPL_END,$ENERGY_UJ,$ELAPSED_MS,$POWER_W,$CPU_PCT,$MEM_MB" >> "$SUMMARY_CSV"

    success "Rodada $RUN: RPS=$RPS, P99=${P99}ms, Power=${POWER_W}W, CPU=${CPU_PCT}%"
  done

  # --- Derruba a API ---
  docker compose stop "$SERVICE"
  log "Container $SERVICE parado"
  sleep 3   # deixa o sistema estabilizar antes do próximo framework
done

# ---------------------------------------------------------------------------
# Para o PostgreSQL
# ---------------------------------------------------------------------------

header "Parando PostgreSQL"
docker compose stop postgres
success "PostgreSQL parado"

# ---------------------------------------------------------------------------
# Análise de resultados
# ---------------------------------------------------------------------------

header "Analisando resultados"

python3 "$ANALYZE_SCRIPT" \
  --results-dir "$RESULTS_DIR" \
  --baseline-power "$BASELINE_POWER_W" \
  --output-dir "$RESULTS_DIR"

success "Análise concluída. Resultados em: $RESULTS_DIR"
echo ""
echo "Arquivos gerados:"
ls -lh "$RESULTS_DIR"/*.{csv,json,txt,png} 2>/dev/null | awk '{print "  " $NF " (" $5 ")"}'
echo ""
echo "Para ver a tabela final:"
echo "  cat $RESULTS_DIR/final_table.txt"
