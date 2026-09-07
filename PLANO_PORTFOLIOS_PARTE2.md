# PLANO_PORTFOLIOS_PARTE2 — Concluir o que ficou pela metade (Fases 4 a 10)

## POR QUE NADA APARECEU NA TELA

**A culpa é do prompt anterior, não do CLI.** Eu escrevi nele:

> `PARE após a FASE 3 e me apresente o resultado antes de seguir para o frontend.`

O CLI obedeceu. Executou as Fases 0-3 corretamente e parou. As Fases 4-10 — que são **exatamente** as que você queria ver — nunca rodaram.

### O que REALMENTE existe hoje (auditado agora)

| Item | Estado |
|---|---|
| `Portfolio` entity + migração | ✅ pronto |
| CRUD completo (`GET`, `POST`, `PATCH`, `DELETE`, `POST /:id/test-connection`, `POST /migrate-legacy`) | ✅ pronto |
| `CredentialsResolver` com fallback portfólio → estratégia | ✅ pronto |
| `strategy.portfolioId` no banco | ✅ existe |
| `portfolio-migration.service` idempotente | ✅ pronto |
| Build + testes | ✅ **42 suites, 275 testes verdes** |
| **`frontend/app/portfolios/page.tsx`** | ❌ **placeholder de 9 linhas** |
| **`frontend/app/performance/page.tsx`** | ❌ **placeholder de 9 linhas** |
| **`frontend/app/alerts/page.tsx`** | ❌ **placeholder de 9 linhas** |
| **`api.ts` — funções de portfólio** | ❌ **nenhuma** |
| **Select de portfólio no form de estratégia** | ❌ **zero ocorrências de "portfolio"** |
| **Filtro de portfólio no dashboard** | ❌ **zero ocorrências de "portfolio"** |
| **Endpoint de reset de trades** | ❌ **não existe** |

Ou seja: **o motor inteiro está construído e testado — falta a carroceria.** Isso é uma boa notícia: a parte difícil e arriscada (as 38 substituições de credenciais nos 10 serviços) já passou e está verde.

---

## REGRAS

1. **Executar TODAS as fases até o fim. Não parar no meio.**
2. Só adicionar. `npm run build` limpo e **≥ 275 testes verdes** ao final de cada fase.
3. Sem comentários em código.
4. Estratégia sem `portfolioId` **continua funcionando** — o fallback do resolver não pode ser removido.
5. Nunca devolver `apiSecret` pela API; `apiKey` só mascarada.
6. Reset de dados: manual, `dryRun` por padrão, nunca em cron.

---

## FASE 4 — CAMADA DE API NO FRONTEND

`frontend/lib/api.ts` — hoje não tem nenhuma função de portfólio:

1. `fetchPortfolios()`, `fetchPortfolio(id)`, `createPortfolio(payload)`, `updatePortfolio(id, payload)`, `deletePortfolio(id)`, `testPortfolioConnection(id)`.
2. Tipo `Portfolio` compartilhado: `{ id, name, exchange, mode, apiKeyMasked, isActive, createdAt }`.
3. Adicionar parâmetro opcional `portfolioId` em `fetchTrades()` e nas funções de posição/saldo.

**Sem isso nenhuma tela funciona** — é a fase habilitadora.

## FASE 5 — PÁGINA PORTFÓLIOS (substituir o placeholder)

Reproduzir a tela do protótipo:

1. Contagem `N portfólio(s) cadastrado(s)` + botão `+ Novo Portfólio` à direita.
2. Grade de cards: nome, corretora, badge de modo (**DEMO** violeta / **REAL** vermelho), `API Key: xxxxx••••••`, `Status: ativo`, botões `Editar` e `Excluir`.
3. Modal `Novo Portfólio` com os 5 campos: **Nome**, **Corretora** (Bybit, Binance, OKX El Salvador, BingX), **Modo** (Demo/Real), **API Key**, **Secret Key**.
   - OKX e BingX aparecem **desabilitadas** com sufixo "(em breve)" — o backend não tem client para elas.
4. Na edição, campos de credencial **vazios**: preencher substitui, deixar em branco preserva.
5. Botão `Testar conexão` chamando `POST /portfolios/:id/test-connection` e exibindo o saldo retornado.
6. `Excluir` exibe o motivo quando o backend recusa (estratégia vinculada / trade aberto).

## FASE 6 — SELECIONAR O PORTFÓLIO AO CRIAR A ESTRATÉGIA

Este é o pedido explícito. `frontend/app/strategies/page.tsx`:

1. Select **Portfólio** como **segundo campo** do formulário (logo após o nome), com opções no formato `nome · EXCHANGE · MODO` — ex.: `teste · BYBIT · DEMO`.
2. Incluir `portfolioId` no `payload` do `handleSubmit` **e** no `handleEdit` (carregar o valor salvo).
   > Atenção ao erro que já tivemos: o payload do `handleSubmit` esqueceu `enableTakeProfit1/2/3` e o checkbox virou decorativo. Conferir campo a campo.
3. Com portfólio selecionado, **ocultar** os campos API Key / Secret / Corretora / Testnet — eles continuam no payload apenas para estratégias legadas sem portfólio.
4. Badge do portfólio no card da estratégia, ao lado do nome.
5. Bloquear criação sem portfólio **quando já existir ao menos um** cadastrado.
6. Garantir que `GET /strategies` devolve `portfolioId` e o objeto `portfolio { id, name, exchange, mode }`. Se o `select` explícito do `strategies.service` não os incluir, **adicionar** — com teste comparando as chaves retornadas às esperadas.
7. Remover da UI o campo órfão **`bufferExpiryCandles`** (não faz nada desde a remoção da expiração do buffer).

## FASE 7 — DASHBOARD COM FILTRO DE PORTFÓLIO

`frontend/app/page.tsx` (hoje: zero ocorrências de "portfolio"):

1. Seletor **"Portfólio: Todos os portfólios"** no topo, valor persistido em `localStorage`, filtrando a página inteira.
2. `GET /trades` e os endpoints de posição/saldo passam a aceitar `?portfolioId=` (ausente = todos).
3. Cards `SALDO DA CARTEIRA`, `SALDO DE MARGEM`, `TOTAL EQUITY`, `FLOATING NÃO REALIZADO`.
   - **Nunca somar conta DEMO com REAL.** Com "todos", separar os blocos ou somar só as REAL, com legenda explícita.
4. Coluna **PORTFÓLIO** na tabela de Posições Abertas + ação `Fechar`.
5. Linha `Portfólio: <nome>` em cada card de trade.
6. Painel **Controles de Emergência** (`Pausar Todas` / `Fechar Todas`) respeitando o filtro, com confirmação nomeando o portfólio e a quantidade de posições afetadas.
7. Filtros `Todos / OPEN / CLOSED / ERROR` e alternância **Cards / Tabela**.

## FASE 8 — PÁGINA DESEMPENHO

1. `GET /performance?portfolioId=&period=7d|15d|30d|90d|all`.
2. PnL agregado do período + série acumulada de crescimento de capital.
3. Tabela diária `DATA | SPOT ($) | FUTURES ($) | TOTAL ($)` com acumulado (SPOT zerado — o bot só opera futuros).
4. Gráfico com alternância **Gráfico / Candles** e botões de período.
5. **Excluir do cálculo os trades com `excludeFromStats = true`** — sem isso o desempenho nasce inflado pelas duplicatas.

## FASE 9 — PÁGINA AVISOS

Superfície de leitura sobre dados que já existem, com filtro por portfólio: issues do auditor, `tpWarnings`, trades em `ERROR`, estratégias pausadas e posições sem proteção. Nenhuma lógica nova.

## FASE 10 — DADOS: INSPECIONAR, CORRIGIR E RESETAR

### 10.1 Inspecionar o estado real (Railway CLI)

Antes de qualquer escrita, entender o que está no banco de produção. **Somente leitura nesta etapa.**

```
railway status
railway variables
railway connect Postgres
```

Consultas de diagnóstico a rodar e reportar:
- total de trades por `status` e por `closeReason`
- trades com `excludeFromStats = true`
- trades com `tpWarnings` preenchido
- trades `OPEN` (bloqueiam o reset)
- trades órfãos: `strategyId` sem estratégia correspondente
- estratégias com `portfolioId IS NULL`
- trades com entrada duplicada (mesmo símbolo/lado/entryPrice em 24h)

Se o `railway` não estiver autenticado, rodar `railway login` e informar. Se não houver acesso, seguir pelos endpoints da API com o mesmo objetivo.

### 10.2 Backfill de `portfolioId` nos trades

Os trades **não** têm `portfolioId` — hoje o vínculo só existe via estratégia. Para o filtro do dashboard ser confiável e histórico:

1. Coluna aditiva nullable `trade.portfolioId`.
2. Preencher em novos trades no momento da criação, a partir do resolver.
3. Backfill dos existentes via `strategy.portfolioId`.
4. Trade cuja estratégia não tem portfólio fica `null` e aparece como "Sem portfólio" na UI.

### 10.3 Reset dos dados de teste

1. `POST /admin/reset-trades` com `dryRun=true` **por padrão** e `portfolioId` opcional.
   - `dryRun` apenas **lista**: contagem por status, período coberto, PnL acumulado.
   - Execução real exige `confirm: "RESET"` no corpo.
2. Apaga `trades`, `trade_executions` e `signal_logs`. **Preserva** estratégias, portfólios, credenciais e configurações.
3. **RECUSA executar se houver trade `OPEN`** — apagar o registro de uma posição viva deixaria a posição órfã na corretora, sem SL nem TP. Instruir a fechar ou aguardar.
4. Exporta backup `.json` antes de apagar.
5. Registra em `AuditLog`: quem, quando, quantos registros.
6. Zera contadores derivados (`lastTpLevel`, caches de estatística).
7. Botão em **Configurações**, com dupla confirmação e o resultado do `dryRun` exibido antes de liberar a execução.

## FASE 11 — TESTES E ACEITE

1. Testes:
   - `api.ts`: funções de portfólio chamam as rotas certas
   - payload de estratégia inclui `portfolioId` (criação **e** edição)
   - `GET /strategies` devolve `portfolioId` e `portfolio{}` — teste comparando chaves retornadas × esperadas
   - filtro `portfolioId` em trades, posições e desempenho
   - desempenho ignora `excludeFromStats = true`
   - backfill de `trade.portfolioId` idempotente
   - reset com trade `OPEN` → recusado; `dryRun` não apaga nada
2. `npm run build` + **≥ 275 testes verdes**.
3. Aceite prático:
   - [ ] Criar portfólio Bybit DEMO pela tela, testar conexão, ver saldo
   - [ ] Criar estratégia **selecionando o portfólio**, sem informar API Key
   - [ ] Reabrir a estratégia para edição → o portfólio vem selecionado
   - [ ] Webhook executa usando as credenciais do portfólio (log com `source: portfolio`)
   - [ ] Estratégia antiga sem portfólio continua operando
   - [ ] Dashboard filtra por portfólio; cards e posições mostram o nome
   - [ ] Desempenho por portfólio bate com a corretora
   - [ ] `dryRun` do reset lista corretamente; com trade aberto, recusa
   - [ ] Após reset, dashboard zerado e estratégias/portfólios intactos

---

## PROMPT PARA O CLAUDE CODE CLI

```
Leia PLANO_PORTFOLIOS_PARTE2.md na raiz e execute as FASES 4 a 11, uma por commit.
EXECUTE TODAS ATÉ O FIM — não pare no meio para pedir confirmação.

CONTEXTO: as FASES 0-3 do PLANO_PORTFOLIOS_E_LAYOUT.md já foram aplicadas e estão
verdes (42 suites, 275 testes, build limpo). O BACKEND está pronto: existe a entidade
Portfolio, o CRUD completo em @Controller('portfolios') com GET/POST/PATCH/DELETE,
POST /:id/test-connection e POST /migrate-legacy, o CredentialsResolver com fallback
portfólio -> estratégia, o portfolio-migration.service idempotente, e a coluna
strategy.portfolioId.

FALTA TODA A CARROCERIA — é isso que você vai construir:
- frontend/app/portfolios/page.tsx, performance/page.tsx e alerts/page.tsx são
  PLACEHOLDERS de 9 linhas (só o PageHeader)
- frontend/lib/api.ts não tem NENHUMA função de portfólio
- frontend/app/strategies/page.tsx tem ZERO ocorrências de "portfolio" — não há
  select para escolher o portfólio ao criar a estratégia
- frontend/app/page.tsx (dashboard) tem ZERO ocorrências de "portfolio" — não há
  filtro por portfólio
- não existe endpoint de reset de trades
- trades não têm coluna portfolioId

REGRAS CRÍTICAS:
- Só adicionar. Estratégia sem portfolioId DEVE continuar operando pelo fallback do
  CredentialsResolver — não remover esse caminho.
- Ao montar o payload do formulário de estratégia, conferir CAMPO A CAMPO. Já tivemos
  o bug de o payload esquecer enableTakeProfit1/2/3 e o checkbox virar decorativo.
  O mesmo vale para os selects explícitos do backend: se findAllPublic não listar o
  campo, a UI mente. Cobrir com teste que compara as chaves retornadas às esperadas.
- Nunca devolver apiSecret pela API; apiKey só mascarada (xxxxx••••••).
- OKX El Salvador e BingX aparecem DESABILITADAS na UI ("em breve") — sem client.
- NUNCA somar saldo de conta DEMO com conta REAL no dashboard.
- Desempenho deve EXCLUIR trades com excludeFromStats = true, senão nasce inflado.
- Reset (FASE 10.3): dryRun=true por padrão, exige confirm:"RESET", RECUSA se houver
  trade OPEN (apagar o registro de posição viva a deixaria órfã na corretora sem
  SL/TP), exporta backup .json antes, preserva estratégias/portfólios/configurações.
  Nunca em cron.
- Remover da UI o campo bufferExpiryCandles (órfão desde a remoção da expiração).

FASE 10.1 — DADOS EM PRODUÇÃO: use o Railway CLI em modo SOMENTE LEITURA primeiro
(railway status, railway variables, railway connect Postgres). Rode as consultas de
diagnóstico listadas no plano e me REPORTE os números antes de qualquer escrita ou
reset. Se o railway não estiver autenticado, rode railway login e me avise. Se não
houver acesso, use os endpoints da API para o mesmo diagnóstico.

npm run build limpo e >= 275 testes verdes ao final de cada fase.
Sem comentários em código. Liste mudanças por arquivo e o que cada teste cobre.
```
