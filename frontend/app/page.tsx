'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTradesSocket } from '@/hooks/useTradesSocket';
import { StatsCard } from '@/components/dashboard/StatsCard';
import { Table } from '@/components/ui/Table';
import { TradeCard } from '@/components/trades/TradeCard';
import { groupTradesByPosition } from '@/lib/trade-grouping';
import { closeAllPositions, pauseAllStrategies, resumeAllStrategies, closePosition, fetchPortfolios, fetchStats, testPortfolioConnection, Portfolio } from '@/lib/api';
import { formatPrice, formatQuantity, formatPnL, formatPnLSummary, formatPercentSummary, formatDateUTC, formatTimeUTC } from '@/lib/formatters';

const PORTFOLIO_FILTER_STORAGE_KEY = 'dashboard:selectedPortfolioId';

export default function Home() {
  const { stats: liveStats, isConnected, lastUpdate, forceSync, isSyncing } = useTradesSocket();
  const [filter, setFilter] = useState<'ALL' | 'OPEN' | 'CLOSED' | 'ERROR'>('ALL');
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('cards');
  const [isClosingAll, setIsClosingAll] = useState(false);
  const [isPausingAll, setIsPausingAll] = useState(false);
  const [allPaused, setAllPaused] = useState(false);
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [selectedPortfolioId, setSelectedPortfolioId] = useState<string>('');
  const [filteredStats, setFilteredStats] = useState<typeof liveStats>(null);
  const [balanceInfo, setBalanceInfo] = useState<{ success: boolean; balance?: number; message?: string } | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem(PORTFOLIO_FILTER_STORAGE_KEY);
    if (stored) setSelectedPortfolioId(stored);
    fetchPortfolios().then(setPortfolios).catch(console.error);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(PORTFOLIO_FILTER_STORAGE_KEY, selectedPortfolioId);
  }, [selectedPortfolioId]);

  const loadFilteredStats = useCallback(async () => {
    if (!selectedPortfolioId) {
      setFilteredStats(null);
      setBalanceInfo(null);
      return;
    }
    try {
      const data = await fetchStats(selectedPortfolioId);
      setFilteredStats(data);
    } catch (error) {
      console.error(error);
    }
    try {
      const balance = await testPortfolioConnection(selectedPortfolioId);
      setBalanceInfo(balance);
    } catch (error) {
      setBalanceInfo(null);
    }
  }, [selectedPortfolioId]);

  useEffect(() => { loadFilteredStats(); }, [loadFilteredStats, lastUpdate]);

  const stats = selectedPortfolioId ? filteredStats : liveStats;
  const selectedPortfolio = portfolios.find((p) => p.id === selectedPortfolioId) || null;
  const portfolioNameById = new Map(portfolios.map((p) => [p.id, p.name]));

  const getPnLValue = (pnl: number | string | null | undefined): number => {
    if (!pnl) return 0;
    return typeof pnl === 'string' ? parseFloat(pnl) : pnl;
  };

  const totalPnl = getPnLValue(stats?.totalPnL);
  const realizedPnl = getPnLValue(stats?.realizedPnL);
  const unrealizedPnl = getPnLValue(stats?.unrealizedPnL);
  const winRate = stats?.winRate || 0;

  const handleCloseAll = async () => {
    const portfolioLabel = selectedPortfolio ? ` do portfólio "${selectedPortfolio.name}"` : '';
    const count = stats?.activePositions || 0;
    if (!confirm(`Tem certeza que deseja fechar TODAS as ${count} posições abertas${portfolioLabel}? Esta ação não pode ser desfeita.`)) return;
    setIsClosingAll(true);
    try {
      const result = await closeAllPositions(selectedPortfolioId || undefined);
      alert(`${result.closed} posições fechadas${result.errors?.length > 0 ? `. Erros: ${result.errors.join(', ')}` : ''}`);
      forceSync();
      loadFilteredStats();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Erro desconhecido';
      alert(`Falha ao fechar posições: ${msg}`);
    } finally {
      setIsClosingAll(false);
    }
  };

  const handlePauseAll = async () => {
    const portfolioLabel = selectedPortfolio ? ` do portfólio "${selectedPortfolio.name}"` : '';
    if (!confirm(`Tem certeza que deseja ${allPaused ? 'retomar' : 'pausar'} todas as estratégias${portfolioLabel}?`)) return;
    setIsPausingAll(true);
    try {
      if (allPaused) {
        await resumeAllStrategies(selectedPortfolioId || undefined);
        setAllPaused(false);
      } else {
        await pauseAllStrategies(selectedPortfolioId || undefined);
        setAllPaused(true);
      }
      forceSync();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Erro desconhecido';
      alert(`Falha ao ${allPaused ? 'retomar' : 'pausar'} estratégias: ${msg}`);
    } finally {
      setIsPausingAll(false);
    }
  };

  const handleClosePosition = async (tradeId: string) => {
    if (!confirm('Tem certeza que deseja fechar esta posição?')) return;
    try {
      const result = await closePosition(tradeId);
      if (result.success) {
        alert(`Posição fechada. P&L: ${result.pnl?.toFixed(2) || 'N/A'} USDT`);
        forceSync();
      } else {
        alert(`Falha: ${result.message}`);
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Erro desconhecido';
      alert(`Erro: ${msg}`);
    }
  };

  const filteredTrades = stats?.recentSignals.filter(trade => {
    if (filter === 'ALL') return true;
    return trade.status === filter;
  }) || [];

  const groupedTrades = groupTradesByPosition(filteredTrades);

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Dashboard</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Visão geral do sistema de trading</p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={selectedPortfolioId}
            onChange={(e) => setSelectedPortfolioId(e.target.value)}
            className="bg-secondary/80 border border-border/60 rounded-md px-2.5 py-1.5 text-xs text-foreground focus:border-primary/50 outline-none transition"
          >
            <option value="">Portfólio: Todos os portfólios</option>
            {portfolios.map((p) => (
              <option key={p.id} value={p.id}>{p.name} · {p.exchange.toUpperCase()} · {p.mode}</option>
            ))}
          </select>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500 pulse-dot' : 'bg-red-500'}`} />
            <span className="text-xs text-muted-foreground">
              {isConnected ? 'Conectado' : 'Desconectado'}
            </span>
          </div>
          {lastUpdate && (
            <span className="text-[10px] text-muted-foreground/60 font-mono hidden sm:inline">
              {lastUpdate.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={forceSync}
            disabled={isSyncing}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
              isSyncing
                ? 'bg-secondary text-muted-foreground cursor-not-allowed'
                : 'bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25'
            }`}
          >
            {isSyncing ? 'Sincronizando...' : 'Sincronizar'}
          </button>
        </div>
      </div>

      <div className="glass-card rounded-lg border border-red-500/20 p-3">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-2 h-2 rounded-full bg-red-500 pulse-dot" />
            <h3 className="text-sm font-semibold text-foreground">Controles de Emergência</h3>
            <span className="text-[10px] text-muted-foreground">
              {stats?.activePositions || 0} posições abertas | {allPaused ? 'Estratégias pausadas' : 'Estratégias ativas'}
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handlePauseAll}
              disabled={isPausingAll}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                isPausingAll
                  ? 'bg-secondary text-muted-foreground cursor-not-allowed'
                  : allPaused
                  ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25'
                  : 'bg-yellow-500/15 text-yellow-400 border border-yellow-500/30 hover:bg-yellow-500/25'
              }`}
            >
              {isPausingAll ? 'Processando...' : allPaused ? 'Retomar Todas' : 'Pausar Todas'}
            </button>
            <button
              onClick={handleCloseAll}
              disabled={isClosingAll || !stats?.activePositions}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                isClosingAll || !stats?.activePositions
                  ? 'bg-secondary text-muted-foreground cursor-not-allowed'
                  : 'bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25'
              }`}
            >
              {isClosingAll ? 'Fechando...' : 'Fechar Todas'}
            </button>
          </div>
        </div>
      </div>

      {selectedPortfolio && (
        <div className={`glass-card rounded-lg p-3 border ${selectedPortfolio.mode === 'DEMO' ? 'border-violet-500/20' : 'border-red-500/20'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-foreground">Saldo — {selectedPortfolio.name}</span>
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                selectedPortfolio.mode === 'DEMO'
                  ? 'bg-violet-500/15 text-violet-400 border-violet-500/30'
                  : 'bg-red-500/15 text-red-400 border-red-500/30'
              }`}>
                {selectedPortfolio.mode}
              </span>
            </div>
            {balanceInfo && (
              <span className={`text-sm font-mono font-bold ${balanceInfo.success ? 'text-foreground' : 'text-red-400'}`}>
                {balanceInfo.success ? `${balanceInfo.balance?.toFixed(2) ?? '0.00'} USDT` : balanceInfo.message}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatsCard
          title="P&L Total"
          value={`${formatPnLSummary(totalPnl)} USDT`}
          subValue="Realizado + Não Realizado"
          valueColor={totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}
        />
        <StatsCard
          title="Win Rate"
          value={formatPercentSummary(winRate)}
          subValue={`${stats?.wins || 0}W / ${stats?.losses || 0}L`}
          valueColor={winRate >= 50 ? 'text-emerald-400' : 'text-yellow-400'}
        />
        <StatsCard
          title="P&L Realizado"
          value={`${formatPnLSummary(realizedPnl)} USDT`}
          subValue={`${stats?.totalTrades || 0} trades fechados`}
          valueColor={realizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}
        />
        <StatsCard
          title="P&L Não Realizado"
          value={`${formatPnLSummary(unrealizedPnl)} USDT`}
          subValue={`${stats?.activePositions || 0} posições abertas`}
          valueColor={unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}
        />
      </div>

      {stats?.openPositions && stats.openPositions.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-3 text-foreground flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-blue-500 pulse-dot" />
            Posições Abertas ({stats.openPositions.length})
          </h3>
          <div className="glass-card rounded-lg overflow-hidden">
            <Table
              data={stats.openPositions}
              columns={[
                {
                  header: 'Ativo',
                  accessor: (item) => (
                    <span className="text-foreground font-bold">{item.symbol}</span>
                  ),
                },
                {
                  header: 'Lado',
                  accessor: (item) => (
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                      item.side === 'BUY'
                        ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                        : 'bg-red-500/15 text-red-400 border-red-500/30'
                    }`}>
                      {item.side === 'BUY' ? 'LONG' : 'SHORT'}
                    </span>
                  ),
                },
                {
                  header: 'Preço Entrada',
                  accessor: (item) => (
                    <span className="text-foreground font-mono text-xs">{formatPrice(item.entryPrice)}</span>
                  ),
                },
                {
                  header: 'Quantidade',
                  accessor: (item) => (
                    <span className="text-foreground font-mono text-xs">{formatQuantity(item.quantity)}</span>
                  ),
                },
                {
                  header: 'P&L',
                  accessor: (item) => {
                    const val = getPnLValue(item.pnl);
                    if (item.pnl === null || item.pnl === undefined) {
                      return <span className="text-muted-foreground">-</span>;
                    }
                    return (
                      <span className={`font-bold font-mono text-sm ${val >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {formatPnL(item.pnl)} USDT
                      </span>
                    );
                  },
                },
                {
                  header: 'Portfólio',
                  accessor: (item: any) => (
                    <span className="text-muted-foreground text-xs">{portfolioNameById.get(item.portfolioId) || 'Sem portfólio'}</span>
                  ),
                },
                {
                  header: 'Abertura',
                  accessor: (item) => (
                    <div className="text-xs">
                      <div className="text-muted-foreground font-mono">{formatDateUTC(item.timestamp)}</div>
                      <div className="text-muted-foreground/60 text-[10px] font-mono">{formatTimeUTC(item.timestamp)} UTC</div>
                    </div>
                  ),
                },
                {
                  header: '',
                  accessor: (item) => (
                    <button
                      onClick={() => handleClosePosition(item.id)}
                      className="px-2.5 py-1 text-[10px] font-medium bg-red-500/10 hover:bg-red-500/25 text-red-400 border border-red-500/20 rounded-md transition-all"
                    >
                      Fechar
                    </button>
                  ),
                },
              ]}
            />
          </div>
        </div>
      )}

      {stats?.errorTrades && stats.errorTrades.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-3 text-foreground flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-red-500" />
            Trades com Erro ({stats.errorTrades.length})
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {stats.errorTrades.slice(0, 6).map((trade: any) => (
              <TradeCard key={trade.id} trade={trade} portfolioName={portfolioNameById.get(trade.portfolioId)} />
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-3">
          <h3 className="text-sm font-semibold text-foreground">Trades Recentes</h3>
          <div className="flex gap-3">
            <div className="flex gap-1">
              {(['ALL', 'OPEN', 'CLOSED', 'ERROR'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                    filter === f
                      ? 'bg-primary/15 text-primary border border-primary/30'
                      : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
                  }`}
                >
                  {f === 'ALL' ? 'Todos' : f}
                </button>
              ))}
            </div>
            <div className="flex gap-1 border-l border-border/40 pl-3">
              <button
                onClick={() => setViewMode('cards')}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                  viewMode === 'cards'
                    ? 'bg-primary/15 text-primary border border-primary/30'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
                }`}
              >
                Cards
              </button>
              <button
                onClick={() => setViewMode('table')}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                  viewMode === 'table'
                    ? 'bg-primary/15 text-primary border border-primary/30'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
                }`}
              >
                Tabela
              </button>
            </div>
          </div>
        </div>

        {viewMode === 'cards' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {groupedTrades.map(({ primary, fragments }) => (
              <TradeCard key={primary.id} trade={primary} fragments={fragments} portfolioName={portfolioNameById.get((primary as any).portfolioId)} />
            ))}
          </div>
        ) : (
          <div className="glass-card rounded-lg overflow-hidden">
            <Table
              data={filteredTrades}
              columns={[
                {
                  header: 'Data',
                  accessor: (item) => (
                    <div className="text-xs">
                      <div className="text-foreground font-mono">{formatDateUTC(item.timestamp)}</div>
                      <div className="text-muted-foreground/60 text-[10px] font-mono">{formatTimeUTC(item.timestamp)} UTC</div>
                    </div>
                  ),
                },
                {
                  header: 'Ativo',
                  accessor: (item) => (
                    <span className="text-foreground font-semibold text-xs">{item.symbol}</span>
                  ),
                },
                {
                  header: 'Lado',
                  accessor: (item) => (
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                      item.side === 'BUY'
                        ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                        : 'bg-red-500/15 text-red-400 border-red-500/30'
                    }`}>
                      {item.side === 'BUY' ? 'LONG' : 'SHORT'}
                    </span>
                  ),
                },
                {
                  header: 'Entry',
                  accessor: (item) => (
                    <span className="text-foreground font-mono text-xs">{formatPrice(item.entryPrice)}</span>
                  ),
                },
                {
                  header: 'Exit',
                  accessor: (item) => (
                    <span className="text-foreground font-mono text-xs">{formatPrice(item.exitPrice)}</span>
                  ),
                },
                {
                  header: 'Qty',
                  accessor: (item) => (
                    <span className="text-foreground font-mono text-xs">{formatQuantity(item.quantity)}</span>
                  ),
                },
                {
                  header: 'P&L',
                  accessor: (item) => {
                    if (item.pnl === null || item.pnl === undefined) {
                      return <span className="text-muted-foreground">-</span>;
                    }
                    const val = getPnLValue(item.pnl);
                    return (
                      <span className={`font-semibold font-mono text-xs ${val >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {formatPnL(item.pnl)} USDT
                      </span>
                    );
                  },
                },
                {
                  header: 'Status',
                  accessor: (item) => (
                    <div className="flex flex-col gap-1">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold border w-fit ${
                        item.status === 'OPEN'
                          ? 'bg-blue-500/15 text-blue-400 border-blue-500/30'
                          : item.status === 'CLOSED'
                          ? 'bg-secondary text-muted-foreground border-border/40'
                          : 'bg-red-500/15 text-red-400 border-red-500/30'
                      }`}>
                        {item.status}
                      </span>
                      {item.closeReason && (
                        <span className="text-[10px] text-muted-foreground/60">{item.closeReason}</span>
                      )}
                    </div>
                  ),
                },
              ]}
            />
          </div>
        )}
      </div>
    </div>
  );
}
