# Justificativa de Escolha das Ferramentas do Experimento

**Artigo:** Avaliação Experimental da Eficiência Energética e Financeira de Frameworks Web Baseada em Requisições por Watt e por Dólar
**Autores:** Paulo Victor Ribeiro da Silva · Marcelo Ferreira Leda Filho

---

## 1. Frameworks Web Avaliados

A seleção dos cinco frameworks seguiu três critérios combinados: (a) representatividade de ecossistemas distintos de runtime e linguagem, (b) presença recorrente em estudos de benchmark acadêmicos e industriais e (c) viabilidade de implementação de API REST equivalente com a mesma estrutura de endpoints.

### 1.1 Express (Node.js / JavaScript)

Express é o framework web mais utilizado no ecossistema Node.js. Sua adoção massiva o torna uma referência obrigatória em comparações de desempenho: qualquer resultado experimental que exclua o Express perde capacidade de generalização para o cenário de mercado predominante. Seu modelo de execução baseado em event loop single-threaded com I/O assíncrono não bloqueante representa o paradigma clássico de servidores JavaScript, servindo como baseline para os demais frameworks da mesma plataforma. O ecossistema npm e sua maturidade de mais de uma década garantem estabilidade nos resultados e ausência de variáveis espúrias oriundas de bugs de framework.

### 1.2 Fastify (Node.js / JavaScript)

Fastify foi incluído como contraste direto ao Express dentro do mesmo runtime (Node.js), permitindo isolar o efeito do framework sobre o consumo de recursos mantendo constante a plataforma de execução. Fastify se diferencia do Express pela validação e serialização JSON baseada em schema (usando `fast-json-stringify` e `ajv`), o que reduz o tempo de serialização de respostas. Esta característica é relevante para o estudo porque o custo de serialização impacta diretamente o uso de CPU por requisição — variável que entra na fórmula de RPS/Watt. Fastify é consistentemente posicionado como o framework Node.js de maior desempenho nos benchmarks TechEmpower, conferindo validade externa aos resultados.

### 1.3 Elysia (Bun / TypeScript)

A inclusão do Elysia justifica-se pela necessidade de avaliar o runtime Bun, que reescreve em Zig os componentes críticos de V8 (engine JavaScript do Node.js) com foco declarado em throughput e eficiência de memória. Elysia é o framework TypeScript nativo do ecossistema Bun, análogo ao Fastify no Node.js: orientado a performance com validação por schema em tempo de compilação via TypeBox. Comparar Elysia (Bun) com Express e Fastify (Node.js) permite investigar se a troca de runtime, dentro do mesmo paradigma de linguagem dinâmica, altera o ranking de eficiência energética — pergunta não respondida pela literatura existente que compara apenas linguagens compiladas versus interpretadas como categorias monolíticas.

### 1.4 Actix-web (Rust)

Rust foi escolhido como representante de linguagens compiladas com gerenciamento manual de memória. Actix-web é consistentemente o framework de maior throughput nos benchmarks TechEmpower em múltiplas rodadas consecutivas. Sua arquitetura baseada no modelo de atores (Tokio async runtime) explora paralelismo sem overhead de garbage collector — propriedade que, segundo a literatura (Pereira et al., 2017), correlaciona com menor consumo energético. A presença do Actix-web permite testar se um framework que domina rankings de RPS mantém a mesma supremacia nos rankings de RPS/Watt e RPS/USD, que é precisamente a hipótese central deste estudo.

### 1.5 Gin (Go)

Go foi incluído como segundo representante de linguagens compiladas, com características distintas do Rust: garbage collector gerenciado (porém de baixa latência), modelo de concorrência via goroutines e compilação para binário nativo. Gin é o framework HTTP mais usado no ecossistema Go, com ampla adoção em produção. A comparação Actix (Rust) vs Gin (Go) permite verificar se diferenças de modelo de concorrência e de gerenciamento de memória entre linguagens compiladas se traduzem em diferenças nos índices compostos — algo não coberto por estudos que tratam "linguagens compiladas" como grupo homogêneo.

---

## 2. Banco de Dados — PostgreSQL 16

O PostgreSQL foi escolhido como sistema de gerenciamento de banco de dados pelos seguintes motivos:

**Representatividade:** PostgreSQL é o banco de dados relacional open-source mais utilizado em aplicações web em produção, segundo as pesquisas Stack Overflow Developer Survey 2023 e DB-Engines Ranking. Utilizar um banco amplamente adotado garante validade externa dos resultados.

**Controlabilidade experimental:** Como o experimento avalia frameworks e não bancos de dados, é essencial que o banco seja uma variável controlada — igual para todos os frameworks. PostgreSQL oferece pool de conexões previsível, plano de execução estável para as queries utilizadas (ORDER BY RANDOM() LIMIT N e SELECT COUNT(*)::int) e comportamento de caching consistente entre rodadas após o período de warm-up.

**Alinhamento com benchmarks de referência:** O TechEmpower Framework Benchmarks, principal benchmark de desempenho de frameworks web citado na literatura, utiliza PostgreSQL como banco de dados nas categorias de Single Query, Multiple Queries e Data Updates. Adotar o mesmo banco facilita comparações entre os resultados deste estudo e os dados publicados pelo TechEmpower.

**Pool de conexões padronizado:** Todos os cinco frameworks foram configurados com pool máximo de 10 conexões, eliminando vantagens oriundas de estratégias de conexão distintas.

---

## 3. Containerização — Docker e Docker Compose

A decisão de containerizar todos os serviços com Docker e orquestrá-los via Docker Compose atende a dois requisitos centrais de metodologia experimental: isolamento e reprodutibilidade.

**Isolamento:** Cada API é executada em seu próprio container com recursos de rede, sistema de arquivos e variáveis de ambiente isolados. Isso impede que bibliotecas do sistema operacional do host, configurações de runtime globais ou versões de dependências instaladas localmente introduzam variáveis de confusão nos resultados.

**Reprodutibilidade:** O arquivo `docker-compose.yml` e os `Dockerfile`s de cada API definem completamente o ambiente de execução, incluindo versão exata da imagem base, dependências e variáveis de configuração. Qualquer pesquisador pode reproduzir o experimento em hardware diferente com garantia de ambiente idêntico ao original, requisito fundamental para replicabilidade científica.

**Estratégia de isolamento no experimento:** No script de experimento, cada framework é iniciado individualmente (apenas a API em avaliação + PostgreSQL) antes de cada bateria de testes. Isso evita que frameworks concorrentes disputem CPU e memória durante a medição, o que contaminaria as leituras de energia.

**Versionamento:** O Docker Hub garante imagens base imutáveis por digest, evitando que atualizações silenciosas de dependências alterem resultados entre execuções do experimento.

---

## 4. Gerador de Carga — k6

O k6 (Grafana Labs) foi escolhido como ferramenta de teste de carga em detrimento de alternativas como Apache JMeter, wrk, wrk2, Locust e Gatling pelos seguintes motivos:

**Executor `constant-arrival-rate`:** A hipótese do estudo requer comparar frameworks sob a mesma carga de entrada, não sob o mesmo número de usuários virtuais. O executor `constant-arrival-rate` do k6 mantém uma taxa de chegada de requisições constante (ex: 200 req/s) independentemente da latência das respostas, garantindo que todos os frameworks recebam a mesma pressão de entrada. Ferramentas como `wrk` e Apache JMeter usam modelos de carga orientados a usuários virtuais, que geram RPS variável conforme a latência muda — tornando inadequados para comparação de eficiência por watt sob carga equivalente.

**Executor `ramping-arrival-rate`:** Para o teste de saturação progressiva, o k6 oferece o `ramping-arrival-rate`, que permite criar escadas de carga (200 → 400 → ... → 5000 req/s) com controle preciso de taxa por degrau e duração de estabilização. Isso possibilita identificar o ponto de saturação (RPS máximo sustentável) de cada framework com granularidade de 200 req/s.

**Saída estruturada:** O k6 exporta resultados em JSON (`--summary-export`) e CSV (`--out csv`) com série temporal de granularidade de 1 segundo, viabilizando análise post-hoc por degrau de carga sem necessidade de parsear logs de texto.

**Scripts em JavaScript/TypeScript:** Os scripts de teste são escritos em JavaScript, permitindo lógica de distribuição de endpoints por peso (40% `/db`, 25% `/queries`, 20% `/json`, 15% `/users`) sem dependências externas. O código de teste é versionável e auditável junto ao restante do repositório.

**Baixo overhead do gerador:** k6 é implementado em Go e compilado para binário nativo, com consumo de CPU e memória notavelmente inferior ao JMeter (JVM) e ao Locust (Python com GIL). Menor overhead do gerador reduz o risco de o próprio teste de carga consumir energia e CPU que seria erroneamente atribuída ao framework avaliado — especialmente relevante para medições RAPL.

---

## 5. Medição de Energia — Intel RAPL

A medição de consumo energético utiliza a interface Intel RAPL (Running Average Power Limit), acessível via sistema de arquivos virtual em `/sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj`.

**Precisão de hardware:** RAPL fornece leituras diretamente dos registradores de hardware do processador Intel, com resolução temporal inferior a 1ms e precisão reportada de 3–5% em estudos de validação (Fahad et al., 2019). Isso é superior a estimativas baseadas em amperímetros externos (que incluem consumo de outros componentes) ou em métricas de software como CPU% (que são proxies indiretos).

**Ausência de intrusividade:** Ler o arquivo `/sys/class/powercap/.../energy_uj` consome tempo de CPU desprezível (< 1µs por leitura) e não interfere no comportamento do processo monitorado. Ferramentas como `perf stat -e power/energy-pkg/` introduzem overhead de coleta mais significativo.

**Adoção em pesquisa:** O uso de RAPL para medição de eficiência energética de software é o método dominante na literatura recente de Green Computing (Pereira et al., 2017, 2021; Sallou et al., 2024). Adotar o mesmo método permite comparação direta dos resultados com estudos anteriores.

**Estratégia de subtração de baseline:** O experimento mede a potência do sistema em repouso (apenas PostgreSQL ativo) por 60 segundos antes de cada bateria de testes. A potência líquida da API é calculada subtraindo esse baseline: `P_api = P_total - P_baseline`. Isso isola o consumo energético atribuível exclusivamente ao framework em avaliação.

**Fallback via CPU%:** Em ambientes sem suporte a RAPL (máquinas virtuais, hardware AMD, WSL), o script de experimento utiliza `docker stats` para capturar CPU% como proxy de consumo energético. Embora menos preciso, permite executar o experimento em ambientes de desenvolvimento sem hardware Intel físico.

---

## 6. Análise de Dados — Python 3 com scipy, numpy e matplotlib

**Python 3** foi escolhido para o script de análise (`analyze-results.py` e `find-saturation.py`) pelas seguintes razões:

**scipy.stats:** O teste Mann-Whitney U (não-paramétrico) é aplicado a pares de frameworks para verificar significância estatística das diferenças de RPS. Com n=5 rodadas por framework, não há garantia de normalidade (n < 30), tornando testes paramétricos (t-test) inadequados. `scipy.stats.mannwhitneyu` implementa o teste correto para amostras pequenas e não-normais.

**statistics (built-in):** A mediana é usada como estatística central para RPS e potência (em vez da média), pois é robusta a outliers causados por GC pauses (especialmente no Elysia/Bun), partidas a frio e variações de carga do SO nas primeiras iterações.

**numpy:** Utilizado para cálculo eficiente de percentis (P50, P95, P99) nas análises de saturação com grandes volumes de dados de série temporal do k6.

**matplotlib:** Geração de gráficos PNG programáticos e reproduzíveis — os mesmos gráficos são gerados automaticamente ao final de cada execução do experimento, garantindo que as visualizações reflitam exatamente os dados coletados sem manipulação manual.

**csv (built-in):** Leitura e escrita de arquivos CSV sem dependências externas, garantindo que o script de análise funcione em qualquer ambiente Python 3 padrão mesmo sem pip.

---

## 7. Scripts de Orquestração — Bash

Os scripts de orquestração (`run-experiment.sh`, `check-prerequisites.sh`) foram escritos em Bash por três razões:

**Disponibilidade universal:** Bash está disponível em qualquer distribuição Linux sem instalação adicional, eliminando um pré-requisito de ambiente que poderia complicar a reprodução do experimento.

**Integração nativa com o SO:** Leitura do RAPL (`cat /sys/class/powercap/...`), leitura do CPU governor (`cat /sys/devices/system/cpu/.../scaling_governor`), captura de `docker stats` em background com `&` e `kill`, e verificação de portas com `ss` são operações naturalmente expressas em Bash. Reimplementar esses utilitários em Python adicionaria complexidade sem benefício.

**Legibilidade do fluxo de experimento:** O script de experimento é essencialmente um procedimento sequencial com ramificações condicionais — estrutura para a qual Bash é idiomático e legível por pesquisadores sem background em programação.

---

## 8. Distribuição de Endpoints no Teste de Carga

A distribuição de endpoints adotada no teste de carga foi definida para refletir um perfil de uso realista de APIs REST com acesso a banco de dados, evitando que o resultado favoreça artificialmente frameworks com melhor desempenho em serialização JSON pura (sem DB):

| Endpoint | Peso | Justificativa |
|----------|------|---------------|
| `GET /db` | 40% | Operação mais comum: leitura de registro único |
| `GET /queries?count=5` | 25% | Leituras múltiplas, exercita o pool de conexões |
| `GET /json` | 20% | Serialização pura, mede overhead de framework sem I/O |
| `GET /users?limit=20` | 15% | Leitura com paginação (COUNT + SELECT), operação custosa |

Endpoints de escrita (POST, PUT, DELETE) foram excluídos da fase de medição de energia porque introduzem variabilidade de estado no banco de dados entre rodadas — o número de registros cresce entre execuções, alterando o tempo de execução das queries e potencialmente os planos de execução do PostgreSQL.

---

## 9. Métrica de Referência de Custo — AWS t3.medium

A fórmula de RPS/USD utiliza o custo de uma instância **AWS t3.medium** (2 vCPU, 4 GB RAM, região us-east-1) como denominador.

**Justificativa da escolha da instância:** A t3.medium representa o tier de instância de propósito geral mais comum para deploys de APIs em produção — com recursos suficientes para rodar um framework web com banco de dados local, mas sem superdimensionamento que mascararia diferenças de eficiência. Instâncias menores (t3.micro, t3.small) introduziriam restrição de memória que afetaria framwroks com maior footprint (especialmente JVM-based, ausentes neste estudo). Instâncias maiores reduziriam a variação relativa entre frameworks.

**Método de extrapolação:** O RPS máximo teórico é extrapolado via `RPS_extrap = RPS_medido × (100 / CPU%)`, assumindo que o framework escala linearmente com CPU disponível. A instância t3.medium oferece 2 vCPUs; se um framework usa 40% da CPU para entregar 800 req/s, a extrapolação estima que ocuparia toda a instância a ~2.000 req/s. Esse valor é dividido pelo custo horário da instância ($0,0416/h), resultando no índice RPS/USD.

**Limitação reconhecida:** A extrapolação linear subestima ganhos de paralelismo para frameworks baseados em múltiplas threads (Actix-web, Gin) e superestima para frameworks single-threaded (Express). Essa limitação é discutida na seção de ameaças à validade do artigo.

---

## 10. Versionamento — Git e GitHub

O repositório público em `github.com/marceloleda/web-framework-benchmark` serve a três funções:

**Reprodutibilidade:** Qualquer pesquisador pode clonar o repositório e reproduzir o experimento exatamente como executado pelos autores, incluindo as versões de dependências fixadas nos `package.json`, `Cargo.toml` e `go.mod`.

**Transparência:** Todos os scripts de coleta, análise e os cinco códigos-fonte das APIs são auditáveis publicamente, permitindo que revisores do artigo verifiquem a ausência de otimizações específicas que favorecessem determinado framework.

**Rastreabilidade:** O histórico de commits documenta cada mudança no código experimental, permitindo identificar se alguma alteração impactou os resultados — requisito de boas práticas em pesquisa experimental de software.

---

## Referências das Ferramentas

- **k6:** Grafana Labs. *k6 Open Source Load Testing Tool*. https://k6.io
- **Intel RAPL:** Intel Corp. *Intel® 64 and IA-32 Architectures Software Developer's Manual*, Vol. 3B, Cap. 14.
- **RAPL em pesquisa:** Fahad, M. et al. *A Comparative Analysis of Methods for Evaluating the Energy Consumption of Open-Source Applications*. Sustainable Computing, 2019.
- **Eficiência energética de linguagens:** Pereira, R. et al. *Energy Efficiency across Programming Languages*. SLE 2017; *Ranking Programming Languages by Energy Efficiency*. SCP 2021.
- **EnergiBridge:** Sallou, J. et al. *EnergiBridge: Leveraging Hardware Counters to Estimate Process Energy Consumption from Any Platform*. MSR 2024.
- **TechEmpower Benchmarks:** TechEmpower Inc. *Framework Benchmarks*. https://www.techempower.com/benchmarks/
- **Preço AWS t3.medium:** Amazon Web Services. *Amazon EC2 On-Demand Pricing*. https://aws.amazon.com/ec2/pricing/on-demand/ (consultado em fevereiro de 2026).
