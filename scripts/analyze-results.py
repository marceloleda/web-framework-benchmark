#!/usr/bin/env python3
"""
analyze-results.py — computa métricas de eficiência energética e financeira.

Lê o summary.csv gerado por run-experiment.sh e produz:
  - final_table.txt   : tabela formatada com todos os índices
  - final_table.csv   : versão CSV da tabela final (para LaTeX/Excel)
  - stats_tests.txt   : resultados dos testes Mann-Whitney U
  - charts/*.png      : gráficos (se matplotlib disponível)

Métricas calculadas:
  RPS/Watt    = RPS_mediana / (Power_API_W - Power_baseline_W)
                  onde Power_API_W = energia_uj / elapsed_ms / 1000
  RPS/USD     = RPS_extrapolada / custo_horario_USD
                  onde RPS_extrapolada = RPS_mediana * (100 / CPU_pct_mediana)
                  e custo_horario_USD = AWS t3.medium on-demand = $0.0416/h

Hipótese testada:
  O ranking de frameworks por RPS/Watt e RPS/USD difere do ranking
  baseado exclusivamente em throughput (RPS), evidenciando que métricas
  compostas revelam diferenças de eficiência operacional não capturadas
  por rankings unidimensionais.
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Optional

import csv
from collections import defaultdict
import statistics

# ---------------------------------------------------------------------------
# Dependências opcionais
# ---------------------------------------------------------------------------

try:
    from scipy import stats as scipy_stats
    HAS_SCIPY = True
except ImportError:
    HAS_SCIPY = False
    print("[warn] scipy não encontrado — testes estatísticos serão pulados. pip3 install scipy")

try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import numpy as np
    HAS_MATPLOTLIB = True
except ImportError:
    HAS_MATPLOTLIB = False
    print("[warn] matplotlib/numpy não encontrado — gráficos serão pulados. pip3 install matplotlib numpy")

# ---------------------------------------------------------------------------
# Constantes
# ---------------------------------------------------------------------------

# AWS t3.medium on-demand (us-east-1, 2 vCPU, 4 GB RAM) — Jan 2025
AWS_T3_MEDIUM_USD_PER_HOUR = 0.0416

FRAMEWORKS = ['express', 'fastify', 'elysia', 'actix', 'gin']

FRAMEWORK_LABELS = {
    'express': 'Express\n(Node.js)',
    'fastify': 'Fastify\n(Node.js)',
    'elysia':  'Elysia\n(Bun)',
    'actix':   'Actix-web\n(Rust)',
    'gin':     'Gin\n(Go)',
}

# ---------------------------------------------------------------------------
# Parsing de argumentos
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="Analisa resultados do benchmark")
    p.add_argument('--results-dir',    required=True,  help="Diretório com summary.csv e baseline.json")
    p.add_argument('--baseline-power', type=float, default=None, help="Potência baseline em Watts")
    p.add_argument('--output-dir',     required=True,  help="Diretório para salvar resultados")
    return p.parse_args()

# ---------------------------------------------------------------------------
# Leitura dos dados
# ---------------------------------------------------------------------------

def load_summary(results_dir: Path) -> dict:
    """Lê summary.csv e retorna dicionário framework → lista de runs."""
    csv_path = results_dir / 'summary.csv'
    if not csv_path.exists():
        print(f"[erro] {csv_path} não encontrado")
        sys.exit(1)

    data = defaultdict(list)
    with open(csv_path, newline='') as f:
        reader = csv.DictReader(f)
        for row in reader:
            fw = row['framework']
            data[fw].append({
                'run':        int(row['run']),
                'rps':        float(row['rps']),
                'p50_ms':     float(row['p50_ms']),
                'p95_ms':     float(row['p95_ms']),
                'p99_ms':     float(row['p99_ms']),
                'error_rate': float(row['error_rate']),
                'energy_uj':  float(row['energy_uj']),
                'elapsed_ms': float(row['elapsed_ms']),
                'power_watts':float(row['power_watts']),
                'cpu_pct':    float(row['cpu_pct']),
                'mem_mb':     float(row['mem_mb']),
            })
    return dict(data)

def load_baseline(results_dir: Path, cli_baseline: Optional[float]) -> float:
    """Retorna potência baseline em Watts."""
    if cli_baseline is not None and cli_baseline > 0:
        return cli_baseline
    baseline_path = results_dir / 'baseline.json'
    if baseline_path.exists():
        with open(baseline_path) as f:
            b = json.load(f)
        return float(b.get('power_watts', 0))
    return 0.0

# ---------------------------------------------------------------------------
# Cálculo de métricas
# ---------------------------------------------------------------------------

def compute_metrics(data: dict, baseline_power_w: float) -> dict:
    """Calcula métricas agregadas por framework."""
    metrics = {}

    for fw, runs in data.items():
        rps_list    = [r['rps']         for r in runs]
        p50_list    = [r['p50_ms']      for r in runs]
        p95_list    = [r['p95_ms']      for r in runs]
        p99_list    = [r['p99_ms']      for r in runs]
        power_list  = [r['power_watts'] for r in runs]
        cpu_list    = [r['cpu_pct']     for r in runs]
        mem_list    = [r['mem_mb']      for r in runs]
        err_list    = [r['error_rate']  for r in runs]

        rps_med    = statistics.median(rps_list)
        p50_med    = statistics.median(p50_list)
        p95_med    = statistics.median(p95_list)
        p99_med    = statistics.median(p99_list)
        power_med  = statistics.median(power_list)
        cpu_med    = statistics.median(cpu_list)
        mem_med    = statistics.median(mem_list)
        err_med    = statistics.median(err_list)

        rps_std    = statistics.stdev(rps_list)   if len(rps_list) > 1 else 0.0
        power_std  = statistics.stdev(power_list) if len(power_list) > 1 else 0.0

        # RPS/Watt: subtrai baseline para isolar consumo da API
        net_power_w = max(power_med - baseline_power_w, 0.001)  # evita divisão por zero
        if power_med == 0:
            # Sem RAPL: usa CPU% como proxy (1% ≈ 1W — estimativa conservadora)
            net_power_w = max(cpu_med * 0.01 * 1.0, 0.001)  # placeholder
            rapl_available = False
        else:
            rapl_available = True

        rps_per_watt = rps_med / net_power_w

        # RPS/USD: extrapola throughput máximo via CPU%
        if cpu_med > 0:
            rps_extrap = rps_med * (100.0 / cpu_med)
        else:
            rps_extrap = rps_med  # fallback
        rps_per_usd = rps_extrap / AWS_T3_MEDIUM_USD_PER_HOUR

        metrics[fw] = {
            'rps_median':     rps_med,
            'rps_std':        rps_std,
            'p50_ms':         p50_med,
            'p95_ms':         p95_med,
            'p99_ms':         p99_med,
            'power_watts':    power_med,
            'power_std':      power_std,
            'net_power_w':    net_power_w,
            'cpu_pct':        cpu_med,
            'mem_mb':         mem_med,
            'error_rate_pct': err_med,
            'rps_extrap':     rps_extrap,
            'rps_per_watt':   rps_per_watt,
            'rps_per_usd':    rps_per_usd,
            'rapl_available': rapl_available,
            'n_runs':         len(runs),
            'raw_rps':        rps_list,
            'raw_power':      power_list,
            'raw_cpu':        cpu_list,
        }

    return metrics

# ---------------------------------------------------------------------------
# Rankings
# ---------------------------------------------------------------------------

def rank(metrics: dict, key: str, reverse: bool = True) -> list:
    """Retorna lista de frameworks ordenada pelo key."""
    return sorted(metrics.keys(), key=lambda fw: metrics[fw][key], reverse=reverse)

# ---------------------------------------------------------------------------
# Tabela final
# ---------------------------------------------------------------------------

def format_table(metrics: dict, baseline_power: float) -> str:
    fws = FRAMEWORKS
    lines = []

    lines.append("=" * 120)
    lines.append("RESULTADOS DO EXPERIMENTO — Eficiência Energética e Financeira de Frameworks Web")
    lines.append("=" * 120)
    lines.append(f"Baseline (idle+postgres): {baseline_power:.3f} W")
    lines.append(f"Custo AWS t3.medium: US$ {AWS_T3_MEDIUM_USD_PER_HOUR:.4f}/h")
    lines.append("")

    # Cabeçalho
    hdr = (
        f"{'Framework':<14} "
        f"{'RPS':>8} "
        f"{'±':>6} "
        f"{'P50(ms)':>8} "
        f"{'P95(ms)':>8} "
        f"{'P99(ms)':>8} "
        f"{'Power(W)':>9} "
        f"{'Net(W)':>7} "
        f"{'CPU%':>6} "
        f"{'Mem(MB)':>8} "
        f"{'RPS/W':>10} "
        f"{'RPS/USD':>12} "
        f"{'Err%':>6}"
    )
    lines.append(hdr)
    lines.append("-" * 120)

    for fw in fws:
        if fw not in metrics:
            lines.append(f"{'  '+fw:<14}  (sem dados)")
            continue
        m = metrics[fw]
        lines.append(
            f"{fw:<14} "
            f"{m['rps_median']:>8.1f} "
            f"{m['rps_std']:>6.1f} "
            f"{m['p50_ms']:>8.2f} "
            f"{m['p95_ms']:>8.2f} "
            f"{m['p99_ms']:>8.2f} "
            f"{m['power_watts']:>9.3f} "
            f"{m['net_power_w']:>7.3f} "
            f"{m['cpu_pct']:>6.1f} "
            f"{m['mem_mb']:>8.1f} "
            f"{m['rps_per_watt']:>10.1f} "
            f"{m['rps_per_usd']:>12.0f} "
            f"{m['error_rate_pct']:>6.4f}"
        )

    lines.append("=" * 120)
    lines.append("")

    # Rankings
    rank_rps     = rank(metrics, 'rps_median')
    rank_rpsw    = rank(metrics, 'rps_per_watt')
    rank_rpsusd  = rank(metrics, 'rps_per_usd')

    lines.append("RANKINGS:")
    lines.append(f"  Por RPS (throughput):  {' > '.join(rank_rps)}")
    lines.append(f"  Por RPS/Watt (energia):{' > '.join(rank_rpsw)}")
    lines.append(f"  Por RPS/USD (custo):   {' > '.join(rank_rpsusd)}")
    lines.append("")

    # Verifica hipótese: rankings diferem?
    hypothesis_confirmed = (rank_rps != rank_rpsw) or (rank_rps != rank_rpsusd)
    lines.append("HIPÓTESE:")
    lines.append("  'O ranking por RPS/Watt e RPS/USD difere do ranking por RPS'")
    if hypothesis_confirmed:
        lines.append("  → CONFIRMADA: os rankings diferem, evidenciando que métricas compostas")
        lines.append("    revelam diferenças de eficiência não capturadas pelo throughput puro.")
    else:
        lines.append("  → NÃO CONFIRMADA: os rankings são idênticos neste experimento.")
    lines.append("")

    if not metrics[list(metrics.keys())[0]]['rapl_available']:
        lines.append("[!] RAPL não disponível — RPS/Watt calculado via CPU% (estimativa).")
        lines.append("    Para medição precisa, execute em hardware físico com suporte a Intel RAPL.")
        lines.append("")

    return "\n".join(lines)

# ---------------------------------------------------------------------------
# CSV final
# ---------------------------------------------------------------------------

def write_final_csv(metrics: dict, output_dir: Path):
    out = output_dir / 'final_table.csv'
    fieldnames = [
        'framework', 'n_runs', 'rps_median', 'rps_std',
        'p50_ms', 'p95_ms', 'p99_ms',
        'power_watts', 'net_power_w', 'cpu_pct', 'mem_mb',
        'rps_extrap', 'rps_per_watt', 'rps_per_usd',
        'error_rate_pct', 'rank_rps', 'rank_rps_per_watt', 'rank_rps_per_usd',
    ]

    rank_rps    = rank(metrics, 'rps_median')
    rank_rpsw   = rank(metrics, 'rps_per_watt')
    rank_rpsusd = rank(metrics, 'rps_per_usd')

    with open(out, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for fw in FRAMEWORKS:
            if fw not in metrics:
                continue
            m = metrics[fw]
            writer.writerow({
                'framework':        fw,
                'n_runs':           m['n_runs'],
                'rps_median':       round(m['rps_median'],    2),
                'rps_std':          round(m['rps_std'],       2),
                'p50_ms':           round(m['p50_ms'],        2),
                'p95_ms':           round(m['p95_ms'],        2),
                'p99_ms':           round(m['p99_ms'],        2),
                'power_watts':      round(m['power_watts'],   3),
                'net_power_w':      round(m['net_power_w'],   3),
                'cpu_pct':          round(m['cpu_pct'],       2),
                'mem_mb':           round(m['mem_mb'],        1),
                'rps_extrap':       round(m['rps_extrap'],    1),
                'rps_per_watt':     round(m['rps_per_watt'],  2),
                'rps_per_usd':      round(m['rps_per_usd'],   0),
                'error_rate_pct':   round(m['error_rate_pct'],4),
                'rank_rps':         rank_rps.index(fw)    + 1,
                'rank_rps_per_watt':rank_rpsw.index(fw)  + 1,
                'rank_rps_per_usd': rank_rpsusd.index(fw) + 1,
            })

    print(f"[ok] Tabela CSV salva em {out}")

# ---------------------------------------------------------------------------
# Testes estatísticos
# ---------------------------------------------------------------------------

def write_stats_tests(metrics: dict, output_dir: Path):
    if not HAS_SCIPY:
        return

    out = output_dir / 'stats_tests.txt'
    lines = []
    lines.append("TESTES DE SIGNIFICÂNCIA ESTATÍSTICA (Mann-Whitney U, α=0.05)")
    lines.append("=" * 70)
    lines.append("Compara RPS entre pares de frameworks (hipótese nula: distribuições iguais)")
    lines.append("")

    fws = [fw for fw in FRAMEWORKS if fw in metrics]
    for i, fw1 in enumerate(fws):
        for fw2 in fws[i+1:]:
            rps1 = metrics[fw1]['raw_rps']
            rps2 = metrics[fw2]['raw_rps']
            if len(rps1) < 3 or len(rps2) < 3:
                lines.append(f"  {fw1} vs {fw2}: amostras insuficientes (n<3)")
                continue
            stat, p = scipy_stats.mannwhitneyu(rps1, rps2, alternative='two-sided')
            sig = "***" if p < 0.001 else "**" if p < 0.01 else "*" if p < 0.05 else "ns"
            lines.append(f"  {fw1:10s} vs {fw2:10s}: U={stat:.0f}, p={p:.4f} {sig}")

    lines.append("")
    lines.append("*** p<0.001  ** p<0.01  * p<0.05  ns=não significativo")

    with open(out, 'w') as f:
        f.write("\n".join(lines))
    print(f"[ok] Testes estatísticos salvos em {out}")
    print("\n".join(lines))

# ---------------------------------------------------------------------------
# Gráficos
# ---------------------------------------------------------------------------

def generate_charts(metrics: dict, output_dir: Path):
    if not HAS_MATPLOTLIB:
        return

    charts_dir = output_dir / 'charts'
    charts_dir.mkdir(exist_ok=True)

    fws    = [fw for fw in FRAMEWORKS if fw in metrics]
    labels = [fw.capitalize() for fw in fws]

    colors = {
        'express': '#68A063',  # verde Node.js
        'fastify': '#000000',  # preto Fastify
        'elysia':  '#C490D1',  # lilás Bun
        'actix':   '#CE422B',  # vermelho Rust
        'gin':     '#00ACD7',  # azul Go
    }
    bar_colors = [colors.get(fw, '#888888') for fw in fws]

    def make_bar(ax, values, title, ylabel, color_list=None):
        x = np.arange(len(fws))
        bars = ax.bar(x, values, color=color_list or bar_colors, edgecolor='white', linewidth=0.8)
        ax.set_title(title, fontsize=11, fontweight='bold', pad=8)
        ax.set_ylabel(ylabel, fontsize=9)
        ax.set_xticks(x)
        ax.set_xticklabels(labels, fontsize=9)
        ax.bar_label(bars, fmt='%.0f', fontsize=8, padding=2)
        ax.spines['top'].set_visible(False)
        ax.spines['right'].set_visible(False)
        ax.grid(axis='y', alpha=0.3)

    # --- Figura 1: RPS, RPS/W, RPS/USD (comparativo principal) ---
    fig, axes = plt.subplots(1, 3, figsize=(15, 5))
    fig.suptitle('Web Framework Benchmark — Eficiência Energética e Financeira', fontsize=13, fontweight='bold')

    make_bar(axes[0], [metrics[fw]['rps_median']   for fw in fws], 'Throughput (RPS)',            'req/s')
    make_bar(axes[1], [metrics[fw]['rps_per_watt'] for fw in fws], 'Eficiência Energética (RPS/W)', 'req/s/W')
    make_bar(axes[2], [metrics[fw]['rps_per_usd']  for fw in fws], 'Eficiência Financeira (RPS/USD/h)', 'req/s/(USD/h)')

    plt.tight_layout()
    fig.savefig(charts_dir / 'comparison_main.png', dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(f"[ok] Gráfico salvo: {charts_dir / 'comparison_main.png'}")

    # --- Figura 2: Latências P50/P95/P99 ---
    fig, ax = plt.subplots(figsize=(10, 5))
    x = np.arange(len(fws))
    width = 0.25
    ax.bar(x - width, [metrics[fw]['p50_ms'] for fw in fws], width, label='P50', color='#4CAF50', edgecolor='white')
    ax.bar(x,         [metrics[fw]['p95_ms'] for fw in fws], width, label='P95', color='#FF9800', edgecolor='white')
    ax.bar(x + width, [metrics[fw]['p99_ms'] for fw in fws], width, label='P99', color='#F44336', edgecolor='white')
    ax.set_title('Latência por Percentil', fontsize=11, fontweight='bold')
    ax.set_ylabel('Latência (ms)', fontsize=9)
    ax.set_xticks(x)
    ax.set_xticklabels(labels, fontsize=9)
    ax.legend(fontsize=9)
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    ax.grid(axis='y', alpha=0.3)
    plt.tight_layout()
    fig.savefig(charts_dir / 'latency_percentiles.png', dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(f"[ok] Gráfico salvo: {charts_dir / 'latency_percentiles.png'}")

    # --- Figura 3: Rankings side-by-side ---
    rank_rps    = rank(metrics, 'rps_median')
    rank_rpsw   = rank(metrics, 'rps_per_watt')
    rank_rpsusd = rank(metrics, 'rps_per_usd')

    fig, ax = plt.subplots(figsize=(10, 5))
    x = np.arange(len(fws))
    width = 0.25
    rps_ranks    = [rank_rps.index(fw)    + 1 for fw in fws]
    rpsw_ranks   = [rank_rpsw.index(fw)   + 1 for fw in fws]
    rpsusd_ranks = [rank_rpsusd.index(fw) + 1 for fw in fws]

    ax.bar(x - width, rps_ranks,    width, label='Rank por RPS',      color='#2196F3', edgecolor='white')
    ax.bar(x,         rpsw_ranks,   width, label='Rank por RPS/Watt', color='#FF5722', edgecolor='white')
    ax.bar(x + width, rpsusd_ranks, width, label='Rank por RPS/USD',  color='#9C27B0', edgecolor='white')

    ax.set_title('Comparação de Rankings (1=melhor)', fontsize=11, fontweight='bold')
    ax.set_ylabel('Posição no ranking', fontsize=9)
    ax.set_xticks(x)
    ax.set_xticklabels(labels, fontsize=9)
    ax.set_yticks(range(1, len(fws)+1))
    ax.invert_yaxis()
    ax.legend(fontsize=9)
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    ax.grid(axis='y', alpha=0.3)
    plt.tight_layout()
    fig.savefig(charts_dir / 'ranking_comparison.png', dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(f"[ok] Gráfico salvo: {charts_dir / 'ranking_comparison.png'}")

# ---------------------------------------------------------------------------
# Ponto de entrada
# ---------------------------------------------------------------------------

def main():
    args = parse_args()
    results_dir = Path(args.results_dir)
    output_dir  = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print("[info] Carregando dados...")
    data = load_summary(results_dir)
    if not data:
        print("[erro] Nenhum dado encontrado em summary.csv")
        sys.exit(1)

    baseline_power = load_baseline(results_dir, args.baseline_power)
    print(f"[info] Potência baseline: {baseline_power:.3f} W")

    print("[info] Calculando métricas...")
    metrics = compute_metrics(data, baseline_power)

    # Tabela textual
    table = format_table(metrics, baseline_power)
    print("\n" + table)

    table_path = output_dir / 'final_table.txt'
    with open(table_path, 'w') as f:
        f.write(table)
    print(f"[ok] Tabela final salva em {table_path}")

    write_final_csv(metrics, output_dir)
    write_stats_tests(metrics, output_dir)
    generate_charts(metrics, output_dir)

if __name__ == '__main__':
    main()
