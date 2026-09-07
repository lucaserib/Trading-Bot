'use client';

import { useState, useEffect } from 'react';
import { fetchPortfolios, Portfolio, resetTrades, migrateLegacyPortfolios, backfillTradePortfolioIds } from '@/lib/api';

interface DryRunResult {
  dryRun: true;
  countsByStatus: Record<string, number>;
  periodCovered: { from: string | null; to: string | null };
  accumulatedPnl: number;
  tradesCount: number;
  executionsCount: number;
  signalLogsCount: number;
  openTradesBlocking: number;
}

export default function SettingsPage() {
  const [useTestnet, setUseTestnet] = useState(true);
  const [notifications, setNotifications] = useState(true);
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [resetPortfolioId, setResetPortfolioId] = useState('');
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null);
  const [isRunningDryRun, setIsRunningDryRun] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [migrationBusy, setMigrationBusy] = useState(false);

  useEffect(() => {
    fetchPortfolios().then(setPortfolios).catch(console.error);
  }, []);

  const handleDryRun = async () => {
    setIsRunningDryRun(true);
    setDryRunResult(null);
    try {
      const result = await resetTrades({ dryRun: true, portfolioId: resetPortfolioId || undefined });
      setDryRunResult(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Erro desconhecido';
      alert(`Falha ao rodar dry run: ${msg}`);
    } finally {
      setIsRunningDryRun(false);
    }
  };

  const handleRealReset = async () => {
    if (!dryRunResult || dryRunResult.openTradesBlocking > 0) return;
    if (!confirm(`Isso vai apagar ${dryRunResult.tradesCount} trade(s), ${dryRunResult.executionsCount} execução(ões) e ${dryRunResult.signalLogsCount} signal log(s) PERMANENTEMENTE. Estratégias, portfólios e credenciais são preservados. Continuar?`)) return;
    const typed = window.prompt('Digite RESET (maiúsculo) para confirmar a execução real:');
    if (typed !== 'RESET') {
      alert('Confirmação incorreta. Reset cancelado.');
      return;
    }
    setIsResetting(true);
    try {
      const result = await resetTrades({ dryRun: false, confirm: 'RESET', portfolioId: resetPortfolioId || undefined });
      alert(`Reset concluído: ${result.deletedTrades} trade(s), ${result.deletedExecutions} execução(ões), ${result.deletedSignalLogs} signal log(s) removidos. Backup: ${result.backupFile}`);
      setDryRunResult(null);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Erro desconhecido';
      alert(`Falha ao resetar: ${msg}`);
    } finally {
      setIsResetting(false);
    }
  };

  const handleMigrateLegacy = async () => {
    setMigrationBusy(true);
    try {
      const result = await migrateLegacyPortfolios();
      alert(`${result.portfoliosCreated} portfólio(s) criado(s), ${result.strategiesLinked} estratégia(s) vinculada(s).`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Erro desconhecido';
      alert(`Falha na migração: ${msg}`);
    } finally {
      setMigrationBusy(false);
    }
  };

  const handleBackfillTradePortfolioIds = async () => {
    setMigrationBusy(true);
    try {
      const result = await backfillTradePortfolioIds();
      alert(`${result.tradesUpdated} trade(s) atualizado(s) com o portfolioId da estratégia.`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Erro desconhecido';
      alert(`Falha no backfill: ${msg}`);
    } finally {
      setMigrationBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-foreground">Configurações</h1>
        <p className="text-xs text-muted-foreground mt-0.5">Configurações gerais do sistema</p>
      </div>

      <div className="space-y-4 max-w-2xl">
        <div className="glass-card rounded-lg">
          <div className="px-4 py-3 border-b border-border/40">
            <h3 className="text-sm font-semibold text-foreground">Configuração da Exchange</h3>
          </div>
          <div className="p-4">
            <div className="flex items-center justify-between py-3">
              <div>
                <p className="text-sm text-foreground font-medium">Usar URLs Testnet da Binance</p>
                <p className="text-xs text-muted-foreground mt-0.5">Forçar todas as conexões Binance para testnet.binancefuture.com</p>
              </div>
              <Toggle checked={useTestnet} onChange={() => setUseTestnet(!useTestnet)} />
            </div>

            <div className="mt-3 p-3 bg-yellow-500/10 border border-yellow-500/15 rounded-md">
              <p className="text-yellow-300 text-[11px]">
                Para usar Testnet, certifique-se de fornecer <strong>API Keys de Testnet</strong> na configuração da estratégia.
              </p>
            </div>
          </div>
        </div>

        <div className="glass-card rounded-lg">
          <div className="px-4 py-3 border-b border-border/40">
            <h3 className="text-sm font-semibold text-foreground">Notificações</h3>
          </div>
          <div className="p-4">
            <div className="flex items-center justify-between py-3">
              <div>
                <p className="text-sm text-foreground font-medium">Notificações Telegram</p>
                <p className="text-xs text-muted-foreground mt-0.5">Receber alertas de trades via bot do Telegram</p>
              </div>
              <Toggle checked={notifications} onChange={() => setNotifications(!notifications)} />
            </div>
          </div>
        </div>

        <div className="glass-card rounded-lg">
          <div className="px-4 py-3 border-b border-border/40">
            <h3 className="text-sm font-semibold text-foreground">Sistema</h3>
          </div>
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Versão</span>
              <span className="font-mono text-foreground">1.0.0</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Ambiente</span>
              <span className="font-mono text-foreground">{process.env.NODE_ENV}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">API URL</span>
              <span className="font-mono text-foreground text-[10px] truncate max-w-[200px]">{process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}</span>
            </div>
          </div>
        </div>

        <div className="glass-card rounded-lg">
          <div className="px-4 py-3 border-b border-border/40">
            <h3 className="text-sm font-semibold text-foreground">Migração de Portfólios</h3>
          </div>
          <div className="p-4 space-y-2">
            <p className="text-xs text-muted-foreground">
              Operações idempotentes — rodar mais de uma vez não duplica nem sobrescreve dados já migrados.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleMigrateLegacy}
                disabled={migrationBusy}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-secondary hover:bg-primary/20 text-foreground hover:text-primary border border-border/40 transition-all disabled:opacity-50"
              >
                Migrar estratégias legadas para portfólio
              </button>
              <button
                onClick={handleBackfillTradePortfolioIds}
                disabled={migrationBusy}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-secondary hover:bg-primary/20 text-foreground hover:text-primary border border-border/40 transition-all disabled:opacity-50"
              >
                Preencher portfolioId dos trades existentes
              </button>
            </div>
          </div>
        </div>

        <div className="glass-card rounded-lg border border-red-500/20">
          <div className="px-4 py-3 border-b border-red-500/20">
            <h3 className="text-sm font-semibold text-red-400">Zona de Perigo — Reset de Dados de Teste</h3>
          </div>
          <div className="p-4 space-y-3">
            <p className="text-xs text-muted-foreground">
              Apaga trades, execuções e signal logs permanentemente. Estratégias, portfólios e credenciais são preservados.
              Sempre rode o dry run primeiro. Recusa automaticamente se houver trade OPEN.
            </p>

            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Portfólio (opcional — vazio = todos)</label>
              <select
                value={resetPortfolioId}
                onChange={(e) => { setResetPortfolioId(e.target.value); setDryRunResult(null); }}
                className="w-full bg-secondary/80 border border-border/60 rounded-md px-3 py-2 text-sm text-foreground outline-none"
              >
                <option value="">Todos os portfólios</option>
                {portfolios.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} · {p.exchange.toUpperCase()} · {p.mode}</option>
                ))}
              </select>
            </div>

            <button
              onClick={handleDryRun}
              disabled={isRunningDryRun}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-yellow-500/15 text-yellow-400 border border-yellow-500/30 hover:bg-yellow-500/25 transition-all disabled:opacity-50"
            >
              {isRunningDryRun ? 'Rodando...' : 'Rodar Dry Run'}
            </button>

            {dryRunResult && (
              <div className="p-3 bg-secondary/50 rounded-md border border-border/40 space-y-2 text-xs">
                <div className="grid grid-cols-2 gap-2">
                  <div>Trades: <span className="font-mono text-foreground">{dryRunResult.tradesCount}</span></div>
                  <div>Execuções: <span className="font-mono text-foreground">{dryRunResult.executionsCount}</span></div>
                  <div>Signal Logs: <span className="font-mono text-foreground">{dryRunResult.signalLogsCount}</span></div>
                  <div>PnL acumulado: <span className="font-mono text-foreground">{dryRunResult.accumulatedPnl.toFixed(2)}</span></div>
                </div>
                <div className="text-muted-foreground">
                  Contagem por status: {Object.entries(dryRunResult.countsByStatus).map(([s, c]) => `${s}: ${c}`).join(', ') || '—'}
                </div>
                <div className="text-muted-foreground">
                  Período: {dryRunResult.periodCovered.from ? new Date(dryRunResult.periodCovered.from).toLocaleDateString() : '—'} até {dryRunResult.periodCovered.to ? new Date(dryRunResult.periodCovered.to).toLocaleDateString() : '—'}
                </div>
                {dryRunResult.openTradesBlocking > 0 ? (
                  <p className="text-red-400 font-semibold">
                    RECUSADO: {dryRunResult.openTradesBlocking} trade(s) OPEN. Feche as posições antes de resetar.
                  </p>
                ) : (
                  <button
                    onClick={handleRealReset}
                    disabled={isResetting}
                    className="px-3 py-1.5 rounded-md text-xs font-bold bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25 transition-all disabled:opacity-50"
                  >
                    {isResetting ? 'Resetando...' : 'Resetar Definitivamente'}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      className={`w-11 h-6 rounded-full relative transition-colors flex-shrink-0 ${
        checked ? 'bg-primary/60' : 'bg-secondary border border-border/40'
      }`}
    >
      <div className={`absolute top-1 w-4 h-4 bg-foreground rounded-full transition-all ${
        checked ? 'left-6' : 'left-1'
      }`} />
    </button>
  );
}
