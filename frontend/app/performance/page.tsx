'use client';

import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { fetchPortfolios, fetchPerformance, Portfolio } from '@/lib/api';
import { formatPnLSummary, formatDateUTC } from '@/lib/formatters';

type Period = '7d' | '15d' | '30d' | '90d' | 'all';

interface DailyPerformance {
  date: string;
  spot: number;
  futures: number;
  total: number;
  cumulative: number;
}

const PERIOD_OPTIONS: Array<{ value: Period; label: string }> = [
  { value: '7d', label: '7D' },
  { value: '15d', label: '15D' },
  { value: '30d', label: '30D' },
  { value: '90d', label: '90D' },
  { value: 'all', label: 'Tudo' },
];

export default function PerformancePage() {
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [selectedPortfolioId, setSelectedPortfolioId] = useState('');
  const [period, setPeriod] = useState<Period>('30d');
  const [chartMode, setChartMode] = useState<'line' | 'candles'>('line');
  const [totalPnl, setTotalPnl] = useState(0);
  const [daily, setDaily] = useState<DailyPerformance[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchPortfolios().then(setPortfolios).catch(console.error);
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchPerformance({ portfolioId: selectedPortfolioId || undefined, period })
      .then((data) => {
        setTotalPnl(data.totalPnl);
        setDaily(data.daily);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedPortfolioId, period]);

  const cumulativeValues = daily.map((d) => d.cumulative);
  const minCumulative = Math.min(0, ...cumulativeValues);
  const maxCumulative = Math.max(0, ...cumulativeValues);
  const maxAbsDaily = Math.max(1, ...daily.map((d) => Math.abs(d.futures)));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Desempenho"
        subtitle="Evolução de capital e PnL por portfólio"
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

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setPeriod(opt.value)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                period === opt.value
                  ? 'bg-primary/15 text-primary border border-primary/30'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="flex gap-1 border-l border-border/40 pl-3">
          <button
            onClick={() => setChartMode('line')}
            className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
              chartMode === 'line'
                ? 'bg-primary/15 text-primary border border-primary/30'
                : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
            }`}
          >
            Gráfico
          </button>
          <button
            onClick={() => setChartMode('candles')}
            className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
              chartMode === 'candles'
                ? 'bg-primary/15 text-primary border border-primary/30'
                : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
            }`}
          >
            Candles
          </button>
        </div>
      </div>

      <div className="glass-card rounded-lg p-4">
        <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">PnL do período</div>
        <div className={`text-2xl font-bold font-mono ${totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          {formatPnLSummary(totalPnl)} USDT
        </div>
      </div>

      <div className="glass-card rounded-lg p-4">
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <span className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
          </div>
        ) : daily.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
            Sem trades fechados no período selecionado.
          </div>
        ) : chartMode === 'line' ? (
          <CumulativeChart daily={daily} min={minCumulative} max={maxCumulative} />
        ) : (
          <DailyBarsChart daily={daily} maxAbs={maxAbsDaily} />
        )}
      </div>

      <div className="glass-card rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border/40">
          <h3 className="text-sm font-semibold text-foreground">Desempenho Diário</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground border-b border-border/40">
                <th className="text-left px-4 py-2 font-medium">Data</th>
                <th className="text-right px-4 py-2 font-medium">Spot ($)</th>
                <th className="text-right px-4 py-2 font-medium">Futures ($)</th>
                <th className="text-right px-4 py-2 font-medium">Total ($)</th>
                <th className="text-right px-4 py-2 font-medium">Acumulado ($)</th>
              </tr>
            </thead>
            <tbody>
              {[...daily].reverse().map((d) => (
                <tr key={d.date} className="border-b border-border/20 last:border-0">
                  <td className="px-4 py-2 font-mono text-foreground">{formatDateUTC(d.date)}</td>
                  <td className="px-4 py-2 font-mono text-right text-muted-foreground">{d.spot.toFixed(2)}</td>
                  <td className={`px-4 py-2 font-mono text-right font-semibold ${d.futures >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {formatPnLSummary(d.futures)}
                  </td>
                  <td className={`px-4 py-2 font-mono text-right font-semibold ${d.total >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {formatPnLSummary(d.total)}
                  </td>
                  <td className={`px-4 py-2 font-mono text-right ${d.cumulative >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {formatPnLSummary(d.cumulative)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function CumulativeChart({ daily, min, max }: { daily: DailyPerformance[]; min: number; max: number }) {
  const width = 100;
  const height = 40;
  const range = max - min || 1;
  const points = daily.map((d, i) => {
    const x = daily.length > 1 ? (i / (daily.length - 1)) * width : width / 2;
    const y = height - ((d.cumulative - min) / range) * height;
    return `${x},${y}`;
  });
  const zeroY = height - ((0 - min) / range) * height;
  const lastPositive = daily[daily.length - 1]?.cumulative >= 0;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-48" preserveAspectRatio="none">
      <line x1="0" y1={zeroY} x2={width} y2={zeroY} stroke="currentColor" strokeWidth="0.3" className="text-border" strokeDasharray="1,1" />
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth="0.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={lastPositive ? 'text-emerald-400' : 'text-red-400'}
      />
    </svg>
  );
}

function DailyBarsChart({ daily, maxAbs }: { daily: DailyPerformance[]; maxAbs: number }) {
  return (
    <div className="flex items-end gap-0.5 h-48">
      {daily.map((d) => {
        const heightPct = (Math.abs(d.futures) / maxAbs) * 100;
        return (
          <div key={d.date} className="flex-1 flex flex-col justify-end h-full" title={`${formatDateUTC(d.date)}: ${formatPnLSummary(d.futures)} USDT`}>
            <div
              className={`w-full rounded-sm ${d.futures >= 0 ? 'bg-emerald-500/70' : 'bg-red-500/70'}`}
              style={{ height: `${Math.max(heightPct, 2)}%` }}
            />
          </div>
        );
      })}
    </div>
  );
}
