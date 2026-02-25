#!/usr/bin/env python3
"""
find-saturation.py — detecta o ponto de saturação a partir do CSV gerado pelo k6.

O k6 com `--out csv` grava uma linha por evento de métrica. Este script:
  1. Agrupa eventos por janela de tempo (1s)
  2. Mapeia cada janela ao degrau de carga correspondente
  3. Calcula por degrau: RPS real, p50/p95/p99, taxa de erro
  4. Encontra o último degrau com erro < ERR_THRESHOLD % e p99 < P99_THRESHOLD ms
     → esse é o RPS máximo sustentável do framework

Uso:
  python3 scripts/find-saturation.py \\
    --csv results/saturation_express.csv \\
    --start-rps 200 \\
    --step-rps 200 \\
    --step-duration 30 \\
    --err-threshold 1.0 \\
    --p99-threshold 1000 \\
    [--framework express] \\
    [--plot]

Saída:
  Terminal: tabela por degrau + RPS máximo sustentável
  results/saturation_<framework>_analysis.csv  (se --framework for passado)
  results/saturation_<framework>_plot.png      (se --plot for passado)
"""

import argparse
import csv
import sys
from collections import defaultdict
from pathlib import Path

try:
    import statistics
except ImportError:
    pass  # built-in em Python 3.4+

# ---------------------------------------------------------------------------
# Argumentos
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="Detecta ponto de saturação do k6 CSV")
    p.add_argument('--csv',            required=True,             help="CSV exportado pelo k6 (--out csv=...)")
    p.add_argument('--start-rps',      type=int,   default=200,   help="RPS inicial (default: 200)")
    p.add_argument('--step-rps',       type=int,   default=200,   help="Incremento por degrau (default: 200)")
    p.add_argument('--step-duration',  type=int,   default=30,    help="Duração de cada degrau em segundos (default: 30)")
    p.add_argument('--ramp-duration',  type=int,   default=2,     help="Duração da rampa entre degraus em segundos (default: 2)")
    p.add_argument('--warmup',         type=int,   default=10,    help="Duração do warm-up inicial em segundos (default: 10)")
    p.add_argument('--err-threshold',  type=float, default=1.0,   help="% de erro para considerar saturado (default: 1.0)")
    p.add_argument('--p99-threshold',  type=float, default=1000,  help="P99 máximo em ms (default: 1000)")
    p.add_argument('--framework',      default=None,              help="Nome do framework (para salvar arquivos)")
    p.add_argument('--plot',           action='store_true',       help="Gera gráfico PNG")
    p.add_argument('--output-dir',     default='.',               help="Diretório de saída (default: .)")
    return p.parse_args()

# ---------------------------------------------------------------------------
# Leitura do CSV do k6
#
# Formato: metric_name,timestamp,metric_value,check,error,error_code,
#          expected_response,group,method,name,proto,scenario,service,
#          status,subproto,tls_version,url,extra_tags
# Timestamps em milissegundos Unix.
# ---------------------------------------------------------------------------

def load_k6_csv(path: str) -> dict:
    """
    Retorna dicionário: timestamp_sec → lista de dicts com campos relevantes.
    Filtra apenas as métricas usadas na análise.
    """
    WANTED = {'http_req_duration', 'http_req_failed', 'http_reqs'}

    by_second = defaultdict(lambda: {
        'durations': [],
        'failed':    [],
        'reqs':      0,
    })

    with open(path, newline='') as f:
        reader = csv.DictReader(f)
        for row in reader:
            metric = row.get('metric_name', '').strip()
            if metric not in WANTED:
                continue

            try:
                ts_raw = float(row.get('timestamp', 0))
                val    = float(row.get('metric_value', 0))
            except (ValueError, TypeError):
                continue

            # k6 CSV timestamps: seconds since epoch (not milliseconds)
            ts_sec = int(ts_raw)

            if metric == 'http_req_duration':
                by_second[ts_sec]['durations'].append(val)
            elif metric == 'http_req_failed':
                by_second[ts_sec]['failed'].append(val)
            elif metric == 'http_reqs':
                by_second[ts_sec]['reqs'] += 1

    return dict(by_second)

# ---------------------------------------------------------------------------
# Agregação por degrau
# ---------------------------------------------------------------------------

def aggregate_by_step(by_second: dict, args) -> list:
    """
    Mapeia cada segundo ao degrau correspondente e agrega métricas.
    Retorna lista de dicts, um por degrau, ordenada por RPS alvo.
    """
    if not by_second:
        return []

    t_min = min(by_second.keys())
    t_max = max(by_second.keys())

    # Calcula offset de cada degrau em relação ao t_min
    # Layout temporal:
    #   [0, warmup)           → degrau 0 (ramp to START_RPS)
    #   [warmup, warmup+step) → degrau 0 (hold START_RPS)
    #   [warmup+step, warmup+step+ramp+step) → degrau 1
    #   ...

    warmup   = args.warmup
    step_dur = args.step_duration
    ramp_dur = args.ramp_duration

    steps = []
    target_rps = args.start_rps
    t_offset   = warmup  # o warm-up de 10s não conta como degrau mensurável

    # Degrau 0: START_RPS (apenas a fase de hold, ignora ramp inicial)
    steps.append({
        'target_rps': target_rps,
        't_start':    t_min + t_offset,
        't_end':      t_min + t_offset + step_dur,
    })
    t_offset += step_dur

    target_rps += args.step_rps
    while target_rps <= args.start_rps + 100 * args.step_rps:  # safety limit
        t_offset += ramp_dur  # skip ramp period
        steps.append({
            'target_rps': target_rps,
            't_start':    t_min + t_offset,
            't_end':      t_min + t_offset + step_dur,
        })
        t_offset += step_dur
        if target_rps >= (t_max - t_min) // (step_dur + ramp_dur) * args.step_rps + args.start_rps:
            break
        target_rps += args.step_rps
        if target_rps > 100000:
            break

    # Agrega métricas dentro de cada janela de degrau
    results = []
    for step in steps:
        durations = []
        failed    = []
        req_count = 0

        for t in range(step['t_start'], step['t_end'] + 1):
            if t in by_second:
                s = by_second[t]
                durations.extend(s['durations'])
                failed.extend(s['failed'])
                req_count += s['reqs']

        if not durations:
            continue

        durations_sorted = sorted(durations)
        n = len(durations_sorted)

        def pct(p):
            idx = int(p / 100 * n)
            return durations_sorted[min(idx, n - 1)]

        err_rate = (sum(failed) / len(failed) * 100) if failed else 0
        rps_real = req_count / step_dur if step_dur > 0 else 0

        results.append({
            'target_rps': step['target_rps'],
            'rps_real':   rps_real,
            'p50_ms':     pct(50),
            'p95_ms':     pct(95),
            'p99_ms':     pct(99),
            'err_pct':    err_rate,
            'req_count':  req_count,
            'n_samples':  n,
        })

    return results

# ---------------------------------------------------------------------------
# Detecção do ponto de saturação
# ---------------------------------------------------------------------------

def find_saturation_point(steps: list, err_thr: float, p99_thr: float):
    """
    Retorna o último degrau que ainda está dentro dos thresholds.
    Considera saturado quando err_pct >= err_thr OU p99_ms >= p99_thr.
    """
    last_ok = None
    first_saturated = None

    for s in steps:
        if s['err_pct'] >= err_thr or s['p99_ms'] >= p99_thr:
            if first_saturated is None:
                first_saturated = s
        else:
            last_ok = s

    return last_ok, first_saturated

# ---------------------------------------------------------------------------
# Impressão da tabela
# ---------------------------------------------------------------------------

RESET  = '\033[0m'
GREEN  = '\033[32m'
YELLOW = '\033[33m'
RED    = '\033[31m'
BOLD   = '\033[1m'

def color_row(s, err_thr, p99_thr):
    if s['err_pct'] >= err_thr or s['p99_ms'] >= p99_thr:
        return RED
    if s['err_pct'] >= err_thr * 0.5 or s['p99_ms'] >= p99_thr * 0.7:
        return YELLOW
    return GREEN

def print_table(steps, last_ok, first_sat, args):
    print()
    print(f"{BOLD}{'Alvo(RPS)':>10}  {'Real(RPS)':>10}  {'P50(ms)':>8}  {'P95(ms)':>8}  {'P99(ms)':>8}  {'Erro%':>7}  {'Reqs':>7}  Status{RESET}")
    print("-" * 80)

    for s in steps:
        col = color_row(s, args.err_threshold, args.p99_threshold)
        status = "OK" if col == GREEN else ("WARN" if col == YELLOW else "SATURADO")
        marker = " ◄ SATURAÇÃO" if s == first_sat else ""
        print(
            f"{col}"
            f"{s['target_rps']:>10,}  "
            f"{s['rps_real']:>10.0f}  "
            f"{s['p50_ms']:>8.1f}  "
            f"{s['p95_ms']:>8.1f}  "
            f"{s['p99_ms']:>8.1f}  "
            f"{s['err_pct']:>7.3f}  "
            f"{s['req_count']:>7,}  "
            f"{status}{marker}"
            f"{RESET}"
        )

    print("-" * 80)
    print()

    if last_ok:
        print(f"{BOLD}{GREEN}✓ RPS máximo sustentável: {last_ok['target_rps']:,} req/s{RESET}")
        print(f"  P99 no limite: {last_ok['p99_ms']:.1f} ms  |  Erro: {last_ok['err_pct']:.3f}%")
    else:
        print(f"{RED}✗ Nenhum degrau ficou dentro dos thresholds — a API já estava saturada em {args.start_rps} req/s{RESET}")

    if first_sat:
        print(f"{BOLD}{RED}✗ Saturação iniciou em:   {first_sat['target_rps']:,} req/s{RESET}")
        print(f"  P99 no ponto de saturação: {first_sat['p99_ms']:.1f} ms  |  Erro: {first_sat['err_pct']:.3f}%")
    else:
        print(f"{GREEN}✓ API não saturou até {steps[-1]['target_rps']:,} req/s — considere aumentar MAX_RPS{RESET}")

    print()

# ---------------------------------------------------------------------------
# Saída CSV por degrau
# ---------------------------------------------------------------------------

def write_step_csv(steps, last_ok, framework, output_dir: Path, err_threshold: float, p99_threshold: float):
    out = output_dir / f'saturation_{framework}_analysis.csv'
    with open(out, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=[
            'framework', 'target_rps', 'rps_real',
            'p50_ms', 'p95_ms', 'p99_ms', 'err_pct',
            'req_count', 'saturated', 'max_sustainable',
        ])
        writer.writeheader()
        for s in steps:
            sat = s['err_pct'] >= err_threshold or s['p99_ms'] >= p99_threshold
            max_sus = 1 if last_ok and s['target_rps'] == last_ok['target_rps'] else 0
            writer.writerow({
                'framework':      framework or 'unknown',
                'target_rps':     s['target_rps'],
                'rps_real':       round(s['rps_real'],  1),
                'p50_ms':         round(s['p50_ms'],    2),
                'p95_ms':         round(s['p95_ms'],    2),
                'p99_ms':         round(s['p99_ms'],    2),
                'err_pct':        round(s['err_pct'],   4),
                'req_count':      s['req_count'],
                'saturated':      int(sat),
                'max_sustainable':max_sus,
            })
    print(f"[ok] Análise por degrau salva em {out}")

# ---------------------------------------------------------------------------
# Gráfico
# ---------------------------------------------------------------------------

def plot_saturation(steps, last_ok, first_sat, framework, output_dir: Path):
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        import numpy as np
    except ImportError:
        print("[warn] matplotlib não disponível — gráfico não gerado")
        return

    x       = [s['target_rps'] for s in steps]
    rps     = [s['rps_real']   for s in steps]
    p50     = [s['p50_ms']     for s in steps]
    p99     = [s['p99_ms']     for s in steps]
    err_pct = [s['err_pct']    for s in steps]

    fig, axes = plt.subplots(3, 1, figsize=(12, 10), sharex=True)
    fig.suptitle(f'Teste de Saturação — {framework or "API"}', fontsize=13, fontweight='bold')

    # RPS real vs alvo
    axes[0].plot(x, x,   '--', color='gray',   label='RPS alvo', linewidth=1)
    axes[0].plot(x, rps, 'o-', color='#2196F3',label='RPS real',  linewidth=2)
    axes[0].set_ylabel('req/s')
    axes[0].legend(fontsize=9)
    axes[0].grid(alpha=0.3)
    axes[0].set_title('Throughput real vs alvo', fontsize=10)

    # Latência P50 e P99
    axes[1].plot(x, p50, 's-', color='#4CAF50', label='P50', linewidth=2)
    axes[1].plot(x, p99, 'D-', color='#F44336', label='P99', linewidth=2)
    axes[1].axhline(y=1000, color='red', linestyle=':', linewidth=1, label='Threshold P99 (1000ms)')
    axes[1].set_ylabel('Latência (ms)')
    axes[1].legend(fontsize=9)
    axes[1].grid(alpha=0.3)
    axes[1].set_title('Latência por Percentil', fontsize=10)

    # Taxa de erro
    axes[2].fill_between(x, err_pct, alpha=0.3, color='#FF5722')
    axes[2].plot(x, err_pct, 'o-', color='#FF5722', linewidth=2)
    axes[2].axhline(y=1.0, color='red', linestyle=':', linewidth=1, label='Threshold erro (1%)')
    axes[2].set_ylabel('Taxa de erro (%)')
    axes[2].set_xlabel('RPS alvo')
    axes[2].legend(fontsize=9)
    axes[2].grid(alpha=0.3)
    axes[2].set_title('Taxa de Erro', fontsize=10)

    # Marca ponto de saturação
    if first_sat:
        for ax in axes:
            ax.axvline(x=first_sat['target_rps'], color='red', linestyle='--', alpha=0.6,
                       label=f'Saturação ({first_sat["target_rps"]:,} req/s)')
    if last_ok:
        for ax in axes:
            ax.axvline(x=last_ok['target_rps'], color='green', linestyle='--', alpha=0.6,
                       label=f'Máx sustentável ({last_ok["target_rps"]:,} req/s)')

    plt.tight_layout()
    out = output_dir / f'saturation_{framework or "api"}_plot.png'
    fig.savefig(out, dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(f"[ok] Gráfico salvo em {out}")

# ---------------------------------------------------------------------------
# Ponto de entrada
# ---------------------------------------------------------------------------

def main():
    args = parse_args()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"[info] Lendo {args.csv} ...")
    by_second = load_k6_csv(args.csv)

    if not by_second:
        print("[erro] Nenhum dado encontrado no CSV. Verifique se o arquivo não está vazio.")
        sys.exit(1)

    t_range = max(by_second.keys()) - min(by_second.keys())
    print(f"[info] Duração capturada: {t_range}s  |  Janelas de 1s com dados: {len(by_second)}")

    steps = aggregate_by_step(by_second, args)

    if not steps:
        print("[erro] Não foi possível mapear janelas de tempo para degraus.")
        print("       Verifique --warmup, --step-duration e --ramp-duration.")
        sys.exit(1)

    last_ok, first_sat = find_saturation_point(steps, args.err_threshold, args.p99_threshold)

    print_table(steps, last_ok, first_sat, args)

    if args.framework:
        write_step_csv(steps, last_ok, args.framework, output_dir, args.err_threshold, args.p99_threshold)

    if args.plot:
        plot_saturation(steps, last_ok, first_sat, args.framework, output_dir)

    # Retorna código de saída baseado no resultado
    if last_ok:
        print(f"RPS_MAX_SUSTAINABLE={last_ok['target_rps']}")
        sys.exit(0)
    else:
        sys.exit(2)

if __name__ == '__main__':
    main()
