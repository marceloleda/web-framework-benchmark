#!/usr/bin/env bash
# check-prerequisites.sh — verifica todos os pré-requisitos antes de rodar o experimento
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ERRORS=0
WARNINGS=0

ok()   { echo -e "${GREEN}[OK]${NC}    $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $1"; WARNINGS=$((WARNINGS+1)); }
fail() { echo -e "${RED}[FAIL]${NC}  $1"; ERRORS=$((ERRORS+1)); }

echo "========================================================"
echo "  Verificação de pré-requisitos — Web Framework Benchmark"
echo "========================================================"
echo ""

# --- Docker ---
echo "--- Docker ---"
if command -v docker &>/dev/null; then
  ok "docker encontrado: $(docker --version)"
else
  fail "docker não encontrado. Instale: https://docs.docker.com/engine/install/"
fi

if command -v docker &>/dev/null && docker compose version &>/dev/null 2>&1; then
  ok "docker compose encontrado: $(docker compose version)"
elif command -v docker-compose &>/dev/null; then
  warn "docker compose (plugin) não encontrado, mas docker-compose (legacy) está disponível"
else
  fail "docker compose não encontrado"
fi

if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
  ok "Docker daemon está em execução"
else
  fail "Docker daemon não está em execução. Execute: sudo systemctl start docker"
fi
echo ""

# --- k6 ---
echo "--- k6 ---"
if command -v k6 &>/dev/null; then
  ok "k6 encontrado: $(k6 version 2>&1 | head -1)"
else
  fail "k6 não encontrado. Instale: https://k6.io/docs/getting-started/installation/"
fi
echo ""

# --- Python ---
echo "--- Python ---"
if command -v python3 &>/dev/null; then
  PYVER=$(python3 --version)
  ok "python3 encontrado: $PYVER"
else
  fail "python3 não encontrado"
fi

for pkg in numpy scipy pandas; do
  if python3 -c "import $pkg" &>/dev/null 2>&1; then
    ok "  pacote Python '$pkg' disponível"
  else
    warn "  pacote Python '$pkg' não encontrado — execute: pip3 install $pkg"
  fi
done

if python3 -c "import matplotlib" &>/dev/null 2>&1; then
  ok "  pacote Python 'matplotlib' disponível (gráficos)"
else
  warn "  pacote Python 'matplotlib' não encontrado (gráficos opcionais) — pip3 install matplotlib"
fi
echo ""

# --- Intel RAPL ---
echo "--- Intel RAPL (medição de energia) ---"
RAPL_PATH="/sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj"
if [ -f "$RAPL_PATH" ]; then
  if [ -r "$RAPL_PATH" ]; then
    VAL=$(cat "$RAPL_PATH")
    ok "RAPL acessível: $RAPL_PATH (valor atual: ${VAL} µJ)"
  else
    fail "RAPL existe mas sem permissão de leitura. Execute: sudo chmod a+r /sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj"
    warn "Alternativa: sudo setcap cap_sys_rawio=ep \$(which cat)"
  fi
else
  warn "RAPL não encontrado em $RAPL_PATH"
  # Tenta caminhos alternativos
  if ls /sys/class/powercap/ &>/dev/null 2>&1; then
    AVAILABLE=$(ls /sys/class/powercap/ 2>/dev/null | head -5)
    warn "  Caminhos powercap disponíveis: $AVAILABLE"
  fi
  warn "  RAPL pode não estar disponível em CPUs AMD, máquinas virtuais ou WSL"
  warn "  O experimento continuará sem medição RAPL (usando apenas CPU% via docker stats)"
fi

# Verifica package RAPL para memória RAM (opcional)
RAPL_DRAM="/sys/class/powercap/intel-rapl/intel-rapl:0/intel-rapl:0:2/energy_uj"
if [ -f "$RAPL_DRAM" ] && [ -r "$RAPL_DRAM" ]; then
  ok "RAPL DRAM acessível (opcional)"
else
  warn "RAPL DRAM não disponível (apenas CPU será medido)"
fi
echo ""

# --- CPU Governor ---
echo "--- CPU Governor ---"
if [ -f /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor ]; then
  GOV=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor)
  if [ "$GOV" = "performance" ]; then
    ok "CPU governor: performance (ideal para benchmarks)"
  else
    warn "CPU governor: $GOV (recomendado: performance para maior reprodutibilidade)"
    warn "  Para mudar: sudo cpupower frequency-set -g performance"
    warn "  Ou: echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor"
  fi
else
  warn "Não foi possível verificar CPU governor (pode estar em VM/container)"
fi
echo ""

# --- Portas ---
echo "--- Portas de rede (3001-3005, 5432) ---"
PORTS=(3001 3002 3003 3004 3005 5432)
for PORT in "${PORTS[@]}"; do
  if ss -tlnp 2>/dev/null | grep -q ":$PORT " || netstat -tlnp 2>/dev/null | grep -q ":$PORT "; then
    warn "Porta $PORT já está em uso — pode conflitar com os containers"
  else
    ok "Porta $PORT disponível"
  fi
done
echo ""

# --- Espaço em disco ---
echo "--- Espaço em disco ---"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
AVAILABLE_KB=$(df -k "$PROJECT_DIR" | awk 'NR==2 {print $4}')
AVAILABLE_GB=$(echo "scale=1; $AVAILABLE_KB/1024/1024" | bc 2>/dev/null || echo "?")
if [ "$AVAILABLE_KB" -gt $((2*1024*1024)) ]; then
  ok "Espaço em disco: ${AVAILABLE_GB}GB disponível (mínimo recomendado: 2GB)"
else
  warn "Espaço em disco baixo: ${AVAILABLE_GB}GB disponível (recomendado: ≥2GB para logs e resultados)"
fi
echo ""

# --- Recursos de sistema ---
echo "--- Recursos de sistema ---"
CPU_COUNT=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo "?")
ok "CPUs disponíveis: $CPU_COUNT"

TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}' || echo "0")
TOTAL_RAM_GB=$(echo "scale=1; $TOTAL_RAM_KB/1024/1024" | bc 2>/dev/null || echo "?")
if [ "$TOTAL_RAM_KB" -gt $((3*1024*1024)) ]; then
  ok "RAM total: ${TOTAL_RAM_GB}GB (suficiente)"
else
  warn "RAM total: ${TOTAL_RAM_GB}GB (recomendado: ≥4GB para rodar todos os containers)"
fi
echo ""

# --- Resumo ---
echo "========================================================"
if [ "$ERRORS" -eq 0 ] && [ "$WARNINGS" -eq 0 ]; then
  echo -e "${GREEN}Tudo pronto! Nenhum problema encontrado.${NC}"
elif [ "$ERRORS" -eq 0 ]; then
  echo -e "${YELLOW}Pronto com $WARNINGS aviso(s). O experimento pode prosseguir.${NC}"
else
  echo -e "${RED}$ERRORS erro(s) crítico(s) e $WARNINGS aviso(s) encontrados.${NC}"
  echo -e "${RED}Corrija os erros antes de rodar o experimento.${NC}"
  exit 1
fi
echo "Para iniciar o experimento: ./scripts/run-experiment.sh"
echo "========================================================"
