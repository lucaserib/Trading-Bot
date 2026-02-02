'use client';

import { useEffect, useState } from 'react';
import { useTradesSocket } from '@/hooks/useTradesSocket';
import { StatsCard } from '@/components/dashboard/StatsCard';
import { Table } from '@/components/ui/Table';
import { closeAllPositions, pauseAllStrategies, resumeAllStrategies, closePosition } from '@/lib/api';

export default function Home() {
  const { stats, isConnected, lastUpdate, forceSync, isSyncing } = useTradesSocket();
  const [filter, setFilter] = useState<'ALL' | 'OPEN' | 'CLOSED'>('ALL');
  const [isClosingAll, setIsClosingAll] = useState(false);
  const [isPausingAll, setIsPausingAll] = useState(false);
  const [allPaused, setAllPaused] = useState(false);

  const totalPnl = stats?.totalPnL || 0;
  const realizedPnl = stats?.realizedPnL || 0;
  const unrealizedPnl = stats?.unrealizedPnL || 0;

  const handleCloseAll = async () => {
    if (!confirm('Are you sure you want to close ALL open positions? This action cannot be undone.')) return;
    setIsClosingAll(true);
    try {
      const result = await closeAllPositions();
      alert(`Closed ${result.closed} positions${result.errors?.length > 0 ? `. Errors: ${result.errors.join(', ')}` : ''}`);
      forceSync();
    } catch (error: any) {
      alert(`Failed to close positions: ${error.message}`);
    } finally {
      setIsClosingAll(false);
    }
  };

  const handlePauseAll = async () => {
    setIsPausingAll(true);
    try {
      if (allPaused) {
        await resumeAllStrategies();
        setAllPaused(false);
      } else {
        await pauseAllStrategies();
        setAllPaused(true);
      }
      forceSync();
    } catch (error: any) {
      alert(`Failed to ${allPaused ? 'resume' : 'pause'} strategies: ${error.message}`);
    } finally {
      setIsPausingAll(false);
    }
  };

  const handleClosePosition = async (tradeId: string) => {
    if (!confirm('Are you sure you want to close this position?')) return;
    try {
      const result = await closePosition(tradeId);
      if (result.success) {
        alert(`Position closed. P&L: ${result.pnl?.toFixed(2) || 'N/A'} USDT`);
        forceSync();
      } else {
        alert(`Failed: ${result.message}`);
      }
    } catch (error: any) {
      alert(`Error: ${error.message}`);
    }
  };

  const filteredTrades = stats?.recentSignals.filter(trade => {
    if (filter === 'ALL') return true;
    return trade.status === filter;
  }) || [];

  return (
    <div className="space-y-6">
      {/* Header with Connection Status */}
      <div className="flex justify-between items-center">
        <h2 className="text-3xl font-bold text-white">Dashboard</h2>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-rose-500'} animate-pulse`} />
            <span className="text-sm text-slate-400">
              {isConnected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
          {lastUpdate && (
            <span className="text-xs text-slate-500">
              Last update: {lastUpdate.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={forceSync}
            disabled={isSyncing}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              isSyncing
                ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
          >
            {isSyncing ? 'Syncing...' : 'Sync with Binance'}
          </button>
        </div>
      </div>

      {/* Emergency Controls */}
      <div className="bg-slate-800/50 rounded-xl border border-rose-500/30 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
            <h3 className="text-white font-semibold">Emergency Controls</h3>
            <span className="text-xs text-slate-400">
              {stats?.activePositions || 0} open positions | {allPaused ? 'All strategies paused' : 'Strategies active'}
            </span>
          </div>
          <div className="flex gap-3">
            <button
              onClick={handlePauseAll}
              disabled={isPausingAll}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                isPausingAll
                  ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                  : allPaused
                  ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                  : 'bg-amber-600 hover:bg-amber-700 text-white'
              }`}
            >
              {isPausingAll ? 'Processing...' : allPaused ? 'Resume All Strategies' : 'Pause All Strategies'}
            </button>
            <button
              onClick={handleCloseAll}
              disabled={isClosingAll || !stats?.activePositions}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                isClosingAll || !stats?.activePositions
                  ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                  : 'bg-rose-600 hover:bg-rose-700 text-white'
              }`}
            >
              {isClosingAll ? 'Closing...' : 'Close All Positions'}
            </button>
          </div>
        </div>
      </div>

      {/* Main Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatsCard
          title="Total P&L"
          value={`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`}
          subValue="Realized + Unrealized"
          subColor="text-slate-400"
          valueColor={totalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}
        />
        <StatsCard
          title="Win Rate"
          value={`${(stats?.winRate || 0).toFixed(1)}%`}
          subValue={`${stats?.wins || 0}W / ${stats?.losses || 0}L`}
          subColor="text-slate-400"
          valueColor={(stats?.winRate || 0) >= 50 ? 'text-emerald-400' : 'text-amber-400'}
        />
        <StatsCard
          title="Realized P&L"
          value={`${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)}`}
          subValue={`${stats?.totalTrades || 0} closed trades`}
          subColor="text-slate-400"
          valueColor={realizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}
        />
        <StatsCard
          title="Unrealized P&L"
          value={`${unrealizedPnl >= 0 ? '+' : ''}$${unrealizedPnl.toFixed(2)}`}
          subValue={`${stats?.activePositions || 0} open positions`}
          subColor="text-slate-400"
          valueColor={unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}
        />
      </div>

      {/* Open Positions Section */}
      {stats?.openPositions && stats.openPositions.length > 0 && (
        <div className="mt-8">
          <h3 className="text-xl font-semibold mb-4 text-white flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
            Open Positions ({stats.openPositions.length})
          </h3>
          <div className="bg-slate-800/50 rounded-xl border border-slate-700 overflow-hidden">
            <Table
              data={stats.openPositions}
              columns={[
                {
                  header: 'Symbol',
                  accessor: (item) => (
                    <span className="text-white font-bold text-lg">{item.symbol}</span>
                  ),
                },
                {
                  header: 'Side',
                  accessor: (item) => (
                    <span
                      className={`px-3 py-1 rounded text-xs font-bold ${
                        item.side === 'BUY'
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                          : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                      }`}
                    >
                      {item.side === 'BUY' ? 'LONG' : 'SHORT'}
                    </span>
                  ),
                },
                {
                  header: 'Entry Price',
                  accessor: (item) => (
                    <span className="text-slate-300 font-mono">
                      ${item.entryPrice?.toFixed(2) || '0.00'}
                    </span>
                  ),
                },
                {
                  header: 'Quantity',
                  accessor: (item) => (
                    <span className="text-slate-300 font-mono">
                      {item.quantity?.toFixed(4) || '0.0000'}
                    </span>
                  ),
                },
                {
                  header: 'Unrealized P&L',
                  accessor: (item) => {
                    const val = item.pnl;
                    if (val === null || val === undefined) {
                      return <span className="text-slate-500">-</span>;
                    }
                    return (
                      <span
                        className={`font-bold text-lg ${
                          val >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {val > 0 ? '+' : ''}${val.toFixed(2)}
                      </span>
                    );
                  },
                },
                {
                  header: 'Opened',
                  accessor: (item) => {
                    const date = new Date(item.timestamp);
                    return (
                      <div className="text-sm">
                        <div className="text-slate-400">{date.toLocaleDateString()}</div>
                        <div className="text-slate-500 text-xs">{date.toLocaleTimeString()}</div>
                      </div>
                    );
                  },
                },
                {
                  header: 'Action',
                  accessor: (item) => (
                    <button
                      onClick={() => handleClosePosition(item.id)}
                      className="px-2 py-1 text-xs bg-rose-600/20 hover:bg-rose-600 text-rose-400 hover:text-white rounded transition-all"
                    >
                      Close
                    </button>
                  ),
                },
              ]}
            />
          </div>
        </div>
      )}

      {/* Recent Trades Section */}
      <div className="mt-8">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-xl font-semibold text-white">Recent Trades</h3>
          <div className="flex gap-2">
            {(['ALL', 'OPEN', 'CLOSED'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1 rounded-lg text-sm font-medium transition-all ${
                  filter === f
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
        <div className="bg-slate-800/50 rounded-xl border border-slate-700 overflow-hidden">
          <Table
            data={filteredTrades}
            columns={[
              {
                header: 'Date',
                accessor: (item) => {
                  const date = new Date(item.timestamp);
                  return (
                    <div className="text-sm">
                      <div className="text-white">{date.toLocaleDateString()}</div>
                      <div className="text-slate-500 text-xs">{date.toLocaleTimeString()}</div>
                    </div>
                  );
                },
              },
              {
                header: 'Symbol',
                accessor: (item) => (
                  <span className="text-white font-semibold">{item.symbol}</span>
                ),
              },
              {
                header: 'Side',
                accessor: (item) => (
                  <span
                    className={`px-2 py-1 rounded text-xs font-semibold ${
                      item.side === 'BUY'
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : 'bg-rose-500/20 text-rose-400'
                    }`}
                  >
                    {item.side}
                  </span>
                ),
              },
              {
                header: 'Entry',
                accessor: (item) => (
                  <span className="text-slate-300 font-mono">
                    ${item.entryPrice?.toFixed(2) || '0.00'}
                  </span>
                ),
              },
              {
                header: 'Exit',
                accessor: (item) => (
                  <span className="text-slate-300 font-mono">
                    {item.exitPrice ? `$${item.exitPrice.toFixed(2)}` : '-'}
                  </span>
                ),
              },
              {
                header: 'Quantity',
                accessor: (item) => (
                  <span className="text-slate-300 font-mono">
                    {item.quantity?.toFixed(4) || '0.0000'}
                  </span>
                ),
              },
              {
                header: 'P&L',
                accessor: (item) => {
                  const val = item.pnl;
                  if (val === null || val === undefined) {
                    return <span className="text-slate-500">-</span>;
                  }
                  return (
                    <span
                      className={`font-semibold ${
                        val >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {val > 0 ? '+' : ''}${val.toFixed(2)}
                    </span>
                  );
                },
              },
              {
                header: 'Status',
                accessor: (item) => (
                  <div className="flex flex-col gap-1">
                    <span
                      className={`px-2 py-1 rounded text-xs font-semibold ${
                        item.status === 'OPEN'
                          ? 'bg-blue-500/20 text-blue-400'
                          : item.status === 'CLOSED'
                          ? 'bg-slate-500/20 text-slate-300'
                          : 'bg-red-500/20 text-red-400'
                      }`}
                    >
                      {item.status}
                    </span>
                    {item.closeReason && (
                      <span className="text-xs text-slate-500">{item.closeReason}</span>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
