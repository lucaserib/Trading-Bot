'use client';

import { useState, useEffect, useCallback } from 'react';

interface LogEntry {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  pnl: number | null;
  status: 'OPEN' | 'CLOSED' | 'ERROR';
  closeReason?: string;
  error?: string;
  strategyId: string;
  timestamp: string;
}

type LogLevel = 'ALL' | 'INFO' | 'SUCCESS' | 'ERROR';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export default function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<LogLevel>('ALL');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const fetchLogs = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`${API_URL}/api/trades?limit=100`);
      if (response.ok) {
        const data = await response.json();
        setLogs(data);
        setLastRefresh(new Date());
      }
    } catch (error) {
      console.error('Failed to fetch logs:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchLogs]);

  const getLogLevel = (log: LogEntry): 'INFO' | 'SUCCESS' | 'ERROR' => {
    if (log.status === 'ERROR' || log.error) return 'ERROR';
    if (log.status === 'CLOSED' && log.pnl !== null && log.pnl > 0) return 'SUCCESS';
    return 'INFO';
  };

  const filteredLogs = logs.filter(log => {
    if (filter === 'ALL') return true;
    return getLogLevel(log) === filter;
  });

  const getLevelBadge = (level: 'INFO' | 'SUCCESS' | 'ERROR') => {
    switch (level) {
      case 'ERROR':
        return 'bg-rose-500/20 text-rose-400 border-rose-500/30';
      case 'SUCCESS':
        return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30';
      default:
        return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
    }
  };

  const formatLogMessage = (log: LogEntry) => {
    const parts = [];

    parts.push(
      <span key="action" className={log.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}>
        {log.side}
      </span>
    );

    parts.push(
      <span key="symbol" className="text-white font-semibold ml-1">
        {log.symbol}
      </span>
    );

    parts.push(
      <span key="price" className="text-slate-400 ml-2">
        @ ${log.entryPrice?.toFixed(2)}
      </span>
    );

    if (log.exitPrice) {
      parts.push(
        <span key="exit" className="text-slate-400 ml-1">
          -&gt; ${log.exitPrice.toFixed(2)}
        </span>
      );
    }

    parts.push(
      <span key="status" className={`ml-2 px-2 py-0.5 rounded text-xs ${
        log.status === 'OPEN' ? 'bg-blue-500/20 text-blue-400' :
        log.status === 'CLOSED' ? 'bg-slate-500/20 text-slate-300' :
        'bg-rose-500/20 text-rose-400'
      }`}>
        {log.status}
      </span>
    );

    if (log.closeReason) {
      parts.push(
        <span key="reason" className="text-slate-500 ml-2 text-xs">
          ({log.closeReason})
        </span>
      );
    }

    if (log.pnl !== null && log.status === 'CLOSED') {
      parts.push(
        <span key="pnl" className={`ml-2 font-semibold ${log.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
          {log.pnl > 0 ? '+' : ''}${log.pnl.toFixed(2)}
        </span>
      );
    }

    if (log.error) {
      parts.push(
        <span key="error" className="text-rose-400 ml-2 text-sm">
          Error: {log.error}
        </span>
      );
    }

    return parts;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <h2 className="text-3xl font-bold text-white">System Logs</h2>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all flex items-center gap-2 ${
                autoRefresh
                  ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30'
                  : 'bg-slate-700 text-slate-400'
              }`}
            >
              <div className={`w-2 h-2 rounded-full ${autoRefresh ? 'bg-emerald-500 animate-pulse' : 'bg-slate-500'}`} />
              Auto-refresh {autoRefresh ? 'ON' : 'OFF'}
            </button>
            {lastRefresh && (
              <span className="text-xs text-slate-500">
                Last: {lastRefresh.toLocaleTimeString()}
              </span>
            )}
          </div>
          <button
            onClick={fetchLogs}
            disabled={isLoading}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              isLoading
                ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
          >
            {isLoading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2">
        {(['ALL', 'INFO', 'SUCCESS', 'ERROR'] as const).map((level) => (
          <button
            key={level}
            onClick={() => setFilter(level)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              filter === level
                ? level === 'ERROR' ? 'bg-rose-600 text-white' :
                  level === 'SUCCESS' ? 'bg-emerald-600 text-white' :
                  'bg-blue-600 text-white'
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
          >
            {level}
            {level !== 'ALL' && (
              <span className="ml-2 text-xs opacity-70">
                ({logs.filter(l => (level as string) === 'ALL' ? true : getLogLevel(l) === level).length})
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Logs List */}
      <div className="bg-slate-800/50 rounded-xl border border-slate-700 overflow-hidden">
        <div className="divide-y divide-slate-700/50">
          {filteredLogs.length === 0 ? (
            <div className="p-8 text-center text-slate-500">
              No logs to display
            </div>
          ) : (
            filteredLogs.map((log) => {
              const level = getLogLevel(log);
              const date = new Date(log.timestamp);

              return (
                <div
                  key={log.id}
                  className="p-4 hover:bg-slate-700/30 transition-colors flex items-start gap-4"
                >
                  {/* Time */}
                  <div className="text-xs text-slate-500 font-mono w-20 flex-shrink-0">
                    <div>{date.toLocaleDateString()}</div>
                    <div>{date.toLocaleTimeString()}</div>
                  </div>

                  {/* Level Badge */}
                  <div className="flex-shrink-0">
                    <span className={`px-2 py-1 rounded text-xs font-bold border ${getLevelBadge(level)}`}>
                      {level}
                    </span>
                  </div>

                  {/* Strategy ID */}
                  <div className="text-xs text-slate-600 font-mono w-24 flex-shrink-0 truncate" title={log.strategyId}>
                    {log.strategyId?.substring(0, 8)}...
                  </div>

                  {/* Message */}
                  <div className="flex-1 text-sm">
                    {formatLogMessage(log)}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="flex justify-between items-center text-sm text-slate-500">
        <span>Showing {filteredLogs.length} of {logs.length} logs</span>
        <span>
          {logs.filter(l => getLogLevel(l) === 'ERROR').length} errors |{' '}
          {logs.filter(l => getLogLevel(l) === 'SUCCESS').length} successful |{' '}
          {logs.filter(l => l.status === 'OPEN').length} open
        </span>
      </div>
    </div>
  );
}
