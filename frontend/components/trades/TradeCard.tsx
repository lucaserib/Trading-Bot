'use client';

import { useState } from 'react';
import { TradeTimeline } from './TradeTimeline';
import { formatPrice, formatQuantity, formatPnL, formatDateUTC, formatTimeUTC, formatCloseReason, parseTpWarnings, parseFallbackTarget, computeTargetDiffPct } from '@/lib/formatters';

interface Trade {
  id: string;
  symbol: string;
  side: string;
  status: string;
  type?: string;
  entryPrice: number | string;
  exitPrice?: number | string | null;
  quantity: number | string;
  pnl?: number | string | null;
  closeReason?: string;
  closeDetail?: string | null;
  timestamp: string;
  closedAt?: string;
  error?: string;
  excludeFromStats?: boolean;
  origin?: string | null;
  tpWarnings?: string | null;
}

interface TradeCardProps {
  trade: Trade;
  fragments?: Trade[];
  portfolioName?: string | null;
}

function hasPnlValue(pnl: Trade['pnl']): boolean {
  return pnl !== null && pnl !== undefined && pnl !== '';
}

function TradeBadges({ trade }: { trade: Trade }) {
  return (
    <>
      {trade.excludeFromStats && (
        <span className="px-2 py-0.5 rounded text-[10px] font-bold border bg-amber-500/15 text-amber-400 border-amber-500/30">
          {trade.closeReason === 'DUST_AMOUNT' ? 'Poeira' : 'Duplicata — não conta no resultado'}
        </span>
      )}
      {trade.origin === 'IMPORTED' && (
        <span className="px-2 py-0.5 rounded text-[10px] font-bold border bg-sky-500/15 text-sky-400 border-sky-500/30">
          Importado da corretora
        </span>
      )}
      {trade.tpWarnings && (
        <span
          title={parseTpWarnings(trade.tpWarnings).map(w => `TP${w.tpId}: ${w.reason}`).join(' | ')}
          className="px-2 py-0.5 rounded text-[10px] font-bold border bg-amber-500/15 text-amber-400 border-amber-500/30"
        >
          TP incompleto
        </span>
      )}
      {trade.closeReason === 'TAKE_PROFIT_FALLBACK_MARKET' && (
        <span
          title="O TP nao foi executado como ordem LIMIT na corretora -- fechou a mercado como ultimo recurso apos falhas repetidas ao criar o TP"
          className="px-2 py-0.5 rounded text-[10px] font-bold border bg-orange-500/15 text-orange-400 border-orange-500/30"
        >
          TP a mercado (fallback)
        </span>
      )}
      {(trade.closeReason === 'TAKE_PROFIT_1' || trade.closeReason === 'TAKE_PROFIT_2' || trade.closeReason === 'TAKE_PROFIT_3') && (
        <span
          title="TP executado como ordem LIMIT na corretora, exatamente no preco-alvo"
          className="px-2 py-0.5 rounded text-[10px] font-bold border bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
        >
          TP no alvo (limit)
        </span>
      )}
    </>
  );
}

function TradeFragmentRow({ trade }: { trade: Trade }) {
  const pnlOk = hasPnlValue(trade.pnl);
  const pnlValue = pnlOk ? (typeof trade.pnl === 'string' ? parseFloat(trade.pnl) : (trade.pnl as number)) : 0;

  return (
    <div className="flex items-center justify-between gap-2 text-[11px] py-1.5 border-t border-border/20 first:border-t-0">
      <div className="flex items-center gap-1.5 flex-wrap min-w-0">
        <span className="text-muted-foreground font-mono">{formatQuantity(trade.quantity)}</span>
        <span className="text-muted-foreground/60">@</span>
        <span className="text-foreground font-mono">{formatPrice(trade.entryPrice)}</span>
        <span className="uppercase text-muted-foreground/70">{trade.type || 'MARKET'}</span>
        <TradeBadges trade={trade} />
      </div>
      <div className={`font-mono font-semibold shrink-0 ${pnlOk ? (pnlValue >= 0 ? 'text-emerald-400' : 'text-red-400') : 'text-muted-foreground'}`}>
        {pnlOk ? `${formatPnL(trade.pnl)} USDT` : formatCloseReason(trade.closeReason)}
      </div>
    </div>
  );
}

export function TradeCard({ trade, fragments = [], portfolioName }: TradeCardProps) {
  const [showTimeline, setShowTimeline] = useState(false);
  const [showFragments, setShowFragments] = useState(false);

  const getPnLValue = (): number => {
    if (!trade.pnl) return 0;
    return typeof trade.pnl === 'string' ? parseFloat(trade.pnl) : trade.pnl;
  };

  const totalPnl = getPnLValue();
  const pnlOk = hasPnlValue(trade.pnl);
  const isClosed = trade.status === 'CLOSED';

  const statusStyles = () => {
    if (trade.status === 'OPEN') return 'bg-blue-500/15 text-blue-400 border-blue-500/30';
    if (trade.status === 'ERROR') return 'bg-red-500/15 text-red-400 border-red-500/30';
    if (trade.status === 'CLOSED' && totalPnl >= 0) return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
    if (trade.status === 'CLOSED' && totalPnl < 0) return 'bg-red-500/15 text-red-400 border-red-500/30';
    return 'bg-secondary text-muted-foreground border-border/40';
  };

  const getDisplayTimestamp = () => {
    if (trade.status === 'ERROR' && trade.closedAt) return trade.closedAt;
    return trade.timestamp;
  };

  const borderAccent = trade.status === 'OPEN'
    ? 'border-l-blue-500/50'
    : trade.status === 'ERROR'
    ? 'border-l-red-500/50'
    : totalPnl >= 0
    ? 'border-l-emerald-500/40'
    : 'border-l-red-500/40';

  return (
    <div className={`group glass-card rounded-lg border border-border/60 border-l-2 ${borderAccent} hover:border-border transition-all duration-200 hover:translate-y-[-1px] glow-subtle`}>
      <div className="p-4 space-y-3">
        <div className="flex justify-between items-start gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-base text-foreground">{trade.symbol}</span>
            <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
              trade.side === 'BUY' ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-red-500/15 text-red-400 border-red-500/30'
            }`}>
              {trade.side === 'BUY' ? 'LONG' : 'SHORT'}
            </span>
            <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${statusStyles()}`}>
              {trade.status}
            </span>
            <TradeBadges trade={trade} />
            {portfolioName && (
              <span className="text-[10px] text-muted-foreground">Portfólio: {portfolioName}</span>
            )}
          </div>
          {pnlOk ? (
            <div className={`font-mono text-base font-bold shrink-0 ${totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {formatPnL(trade.pnl)} USDT
            </div>
          ) : (
            <div className="text-xs font-semibold text-muted-foreground text-right shrink-0 max-w-[140px]">
              {trade.closeReason ? formatCloseReason(trade.closeReason) : trade.error ? 'Sem P&L' : '-'}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <div className="text-muted-foreground text-[10px] uppercase tracking-wider mb-0.5">Entry</div>
            <div className="font-mono font-semibold text-foreground">{formatPrice(trade.entryPrice)}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-[10px] uppercase tracking-wider mb-0.5">Exit</div>
            <div className="font-mono font-semibold text-foreground">{formatPrice(trade.exitPrice)}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-[10px] uppercase tracking-wider mb-0.5">Quantidade</div>
            <div className="font-mono text-foreground">{formatQuantity(trade.quantity)}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-[10px] uppercase tracking-wider mb-0.5">Tipo</div>
            <div className="uppercase text-[11px] text-foreground">{trade.type || 'MARKET'}</div>
          </div>
        </div>

        {trade.error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2 text-xs text-red-400 break-words">
            {trade.error}
          </div>
        )}

        {trade.tpWarnings && (
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-md px-3 py-2 text-xs text-amber-400 space-y-0.5">
            {parseTpWarnings(trade.tpWarnings).map((w, i) => (
              <div key={i}>TP{w.tpId}: {w.reason}</div>
            ))}
          </div>
        )}

        {isClosed && trade.closeReason && (
          <div className="border-t border-border/30 pt-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Motivo:</span>
              <span className="font-semibold text-foreground">
                {formatCloseReason(trade.closeReason)}
                {trade.closeReason === 'TAKE_PROFIT_FALLBACK_MARKET' && parseFallbackTarget(trade.closeDetail) != null ? (
                  <span className="ml-1 text-[11px] font-normal text-orange-400">
                    (alvo {formatPrice(parseFallbackTarget(trade.closeDetail), '')}, diff {computeTargetDiffPct(parseFallbackTarget(trade.closeDetail)!, Number(trade.exitPrice)).toFixed(3)}%)
                  </span>
                ) : (
                  trade.closeDetail && trade.closeReason !== 'TAKE_PROFIT_FALLBACK_MARKET' && (
                    <span className="ml-1 text-[11px] font-normal text-muted-foreground">({trade.closeDetail})</span>
                  )
                )}
              </span>
            </div>
          </div>
        )}

        {fragments.length > 0 && (
          <div className="border-t border-border/30 pt-2">
            <button
              onClick={() => setShowFragments(!showFragments)}
              className="w-full text-left text-xs text-primary hover:text-primary/80 transition-colors flex items-center justify-between"
            >
              <span className="font-semibold flex items-center gap-1.5">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`transition-transform duration-200 ${showFragments ? 'rotate-90' : ''}`}>
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                {fragments.length} trade{fragments.length > 1 ? 's' : ''} relacionado{fragments.length > 1 ? 's' : ''} (mesma posição)
              </span>
            </button>

            {showFragments && (
              <div className="mt-1">
                {fragments.map(fragment => (
                  <TradeFragmentRow key={fragment.id} trade={fragment} />
                ))}
              </div>
            )}
          </div>
        )}

        <div className="border-t border-border/30 pt-2">
          <button
            onClick={() => setShowTimeline(!showTimeline)}
            className="w-full text-left text-xs text-primary hover:text-primary/80 transition-colors flex items-center justify-between"
          >
            <span className="font-semibold flex items-center gap-1.5">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`transition-transform duration-200 ${showTimeline ? 'rotate-90' : ''}`}>
                <polyline points="9 18 15 12 9 6" />
              </svg>
              Execution Timeline
            </span>
            <span className="text-[10px] text-muted-foreground font-mono">
              {formatDateUTC(getDisplayTimestamp())} {formatTimeUTC(getDisplayTimestamp())}
            </span>
          </button>

          {showTimeline && (
            <div className="mt-3">
              <TradeTimeline tradeId={trade.id} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
