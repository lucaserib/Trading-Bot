'use client';

import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { fetchPortfolios, fetchAlerts, Portfolio } from '@/lib/api';
import { formatDateTimeUTC } from '@/lib/formatters';

interface AlertsData {
  auditIssues: Array<{ id: string; category: string; severity: string; message: string; createdAt: string }>;
  errorTrades: Array<{ id: string; symbol: string; error?: string; timestamp: string }>;
  tpWarningTrades: Array<{ id: string; symbol: string; tpWarnings: string }>;
  unprotectedTrades: Array<{ id: string; symbol: string; stopLossOrderId: string | null; takeProfitOrderId: string | null }>;
  pausedStrategies: Array<{ id: string; name: string }>;
}

const EMPTY_ALERTS: AlertsData = {
  auditIssues: [],
  errorTrades: [],
  tpWarningTrades: [],
  unprotectedTrades: [],
  pausedStrategies: [],
};

export default function AlertsPage() {
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [selectedPortfolioId, setSelectedPortfolioId] = useState('');
  const [data, setData] = useState<AlertsData>(EMPTY_ALERTS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchPortfolios().then(setPortfolios).catch(console.error);
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchAlerts(selectedPortfolioId || undefined)
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedPortfolioId]);

  const totalAlerts = data.auditIssues.length + data.errorTrades.length + data.tpWarningTrades.length + data.unprotectedTrades.length + data.pausedStrategies.length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Avisos"
        subtitle={loading ? 'Carregando...' : `${totalAlerts} aviso(s) encontrado(s)`}
        rightSlot={
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
        }
      />

      {!loading && totalAlerts === 0 && (
        <div className="glass-card rounded-lg p-8 text-center text-sm text-muted-foreground">
          Nenhum aviso no momento.
        </div>
      )}

      <AlertSection title="Posições sem proteção" count={data.unprotectedTrades.length} dotClass="bg-red-500">
        {data.unprotectedTrades.map((t) => (
          <AlertRow key={t.id}>
            <span className="font-mono text-foreground">{t.symbol}</span>
            <span className="text-muted-foreground">
              {!t.stopLossOrderId && !t.takeProfitOrderId ? 'sem SL e sem TP' : !t.stopLossOrderId ? 'sem SL' : 'sem TP'}
            </span>
          </AlertRow>
        ))}
      </AlertSection>

      <AlertSection title="Issues do Auditor" count={data.auditIssues.length} dotClass="bg-yellow-500">
        {data.auditIssues.map((issue) => (
          <AlertRow key={issue.id}>
            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${
              issue.severity === 'ERROR' || issue.severity === 'CRITICAL'
                ? 'bg-red-500/15 text-red-400 border-red-500/30'
                : 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30'
            }`}>
              {issue.severity}
            </span>
            <span className="text-foreground">{issue.message}</span>
            <span className="text-muted-foreground/60 text-[10px] ml-auto">{formatDateTimeUTC(issue.createdAt)}</span>
          </AlertRow>
        ))}
      </AlertSection>

      <AlertSection title="Trades em Erro" count={data.errorTrades.length} dotClass="bg-red-500">
        {data.errorTrades.map((t) => (
          <AlertRow key={t.id}>
            <span className="font-mono text-foreground">{t.symbol}</span>
            <span className="text-muted-foreground">{t.error || 'Sem detalhes'}</span>
          </AlertRow>
        ))}
      </AlertSection>

      <AlertSection title="Trades com avisos de TP" count={data.tpWarningTrades.length} dotClass="bg-blue-500">
        {data.tpWarningTrades.map((t) => (
          <AlertRow key={t.id}>
            <span className="font-mono text-foreground">{t.symbol}</span>
            <span className="text-muted-foreground">{t.tpWarnings}</span>
          </AlertRow>
        ))}
      </AlertSection>

      <AlertSection title="Estratégias Pausadas" count={data.pausedStrategies.length} dotClass="bg-orange-500">
        {data.pausedStrategies.map((s) => (
          <AlertRow key={s.id}>
            <span className="text-foreground">{s.name}</span>
          </AlertRow>
        ))}
      </AlertSection>
    </div>
  );
}

function AlertSection({ title, count, dotClass, children }: { title: string; count: number; dotClass: string; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <div className="glass-card rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-border/40 flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${dotClass}`} />
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <span className="text-[10px] text-muted-foreground">({count})</span>
      </div>
      <div className="divide-y divide-border/20">{children}</div>
    </div>
  );
}

function AlertRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 py-2.5 flex items-center gap-3 text-xs">
      {children}
    </div>
  );
}
