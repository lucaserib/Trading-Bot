'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';

interface Trade {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  pnl: number | null;
  status: 'OPEN' | 'CLOSED' | 'SIMULATED' | 'ERROR';
  closeReason?: string;
  closedAt?: string;
  timestamp: string;
}

interface DashboardStats {
  totalPnL: number;
  realizedPnL: number;
  unrealizedPnL: number;
  activePositions: number;
  winRate: number;
  totalTrades: number;
  wins: number;
  losses: number;
  recentSignals: Trade[];
  openPositions: Trade[];
}

interface UseTradesSocketReturn {
  stats: DashboardStats | null;
  isConnected: boolean;
  lastUpdate: Date | null;
  forceSync: () => Promise<void>;
  isSyncing: boolean;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export function useTradesSocket(): UseTradesSocketReturn {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io(`${API_URL}/trades`, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      console.log('[WebSocket] Connected to trades namespace');
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
      console.log('[WebSocket] Disconnected from trades namespace');
    });

    socket.on('stats', (data: DashboardStats) => {
      setStats(data);
      setLastUpdate(new Date());
    });

    socket.on('trade:created', (trade: Trade) => {
      console.log('[WebSocket] Trade created:', trade);
      setStats(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          recentSignals: [trade, ...prev.recentSignals.slice(0, 49)],
          activePositions: prev.activePositions + 1,
        };
      });
      setLastUpdate(new Date());
    });

    socket.on('trade:updated', (trade: Trade) => {
      console.log('[WebSocket] Trade updated:', trade);
      setStats(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          recentSignals: prev.recentSignals.map(t =>
            t.id === trade.id ? trade : t
          ),
        };
      });
      setLastUpdate(new Date());
    });

    socket.on('trade:closed', (trade: Trade) => {
      console.log('[WebSocket] Trade closed:', trade);
      setStats(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          recentSignals: prev.recentSignals.map(t =>
            t.id === trade.id ? trade : t
          ),
          activePositions: Math.max(0, prev.activePositions - 1),
        };
      });
      setLastUpdate(new Date());
    });

    socket.on('sync:completed', (result: { synced: number; closed: number; imported: number }) => {
      console.log('[WebSocket] Sync completed:', result);
      setIsSyncing(false);
    });

    socket.on('connect_error', (error) => {
      console.error('[WebSocket] Connection error:', error);
      setIsConnected(false);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  const forceSync = useCallback(async () => {
    setIsSyncing(true);
    try {
      const response = await fetch(`${API_URL}/api/trades/sync`, {
        method: 'POST',
      });
      const data = await response.json();
      console.log('[Sync] Result:', data);

      const statsResponse = await fetch(`${API_URL}/api/trades/stats`);
      if (statsResponse.ok) {
        const statsData = await statsResponse.json();
        setStats(statsData);
        setLastUpdate(new Date());
      }
    } catch (error) {
      console.error('[Sync] Error:', error);
    } finally {
      setIsSyncing(false);
    }
  }, []);

  return {
    stats,
    isConnected,
    lastUpdate,
    forceSync,
    isSyncing,
  };
}
