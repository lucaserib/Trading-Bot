const getApiUrl = () => {
  const url = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
  if (url.startsWith('http')) return url;
  return `https://${url}`;
};

const API_URL = getApiUrl();

export type PortfolioExchange = 'binance' | 'bybit' | 'okx' | 'bingx';
export type PortfolioMode = 'DEMO' | 'REAL';

export interface Portfolio {
  id: string;
  name: string;
  exchange: PortfolioExchange;
  mode: PortfolioMode;
  isActive: boolean;
  apiKeyMasked: string;
  createdAt: string;
  updatedAt: string;
}

export interface PortfolioPayload {
  name?: string;
  exchange?: PortfolioExchange;
  mode?: PortfolioMode;
  apiKey?: string;
  apiSecret?: string;
  isActive?: boolean;
}

async function parseErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    return body?.message || fallback;
  } catch {
    return fallback;
  }
}

export async function fetchStrategies() {
  const res = await fetch(`${API_URL}/api/strategies`, {
    cache: 'no-store'
  });
  if (!res.ok) throw new Error('Failed to fetch strategies');
  return res.json();
}

export async function fetchPortfolios(): Promise<Portfolio[]> {
  const res = await fetch(`${API_URL}/api/portfolios`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch portfolios');
  return res.json();
}

export async function fetchPortfolio(id: string): Promise<Portfolio> {
  const res = await fetch(`${API_URL}/api/portfolios/${id}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch portfolio');
  return res.json();
}

export async function createPortfolio(payload: PortfolioPayload): Promise<Portfolio> {
  const res = await fetch(`${API_URL}/api/portfolios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to create portfolio'));
  return res.json();
}

export async function updatePortfolio(id: string, payload: PortfolioPayload): Promise<Portfolio> {
  const res = await fetch(`${API_URL}/api/portfolios/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to update portfolio'));
  return res.json();
}

export async function deletePortfolio(id: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API_URL}/api/portfolios/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to delete portfolio'));
  return res.json();
}

export async function testPortfolioConnection(id: string): Promise<{ success: boolean; balance?: number; message?: string }> {
  const res = await fetch(`${API_URL}/api/portfolios/${id}/test-connection`, { method: 'POST' });
  if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to test portfolio connection'));
  return res.json();
}

export async function migrateLegacyPortfolios() {
  const res = await fetch(`${API_URL}/api/portfolios/migrate-legacy`, { method: 'POST' });
  if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to migrate legacy strategies'));
  return res.json();
}

export async function fetchTrades(params: { status?: string; limit?: number; portfolioId?: string } = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.portfolioId) qs.set('portfolioId', params.portfolioId);
  const query = qs.toString();
  const res = await fetch(`${API_URL}/api/trades${query ? `?${query}` : ''}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch trades');
  return res.json();
}

export async function fetchStats(portfolioId?: string) {
  const qs = portfolioId ? `?portfolioId=${portfolioId}` : '';
  const res = await fetch(`${API_URL}/api/trades/stats${qs}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch stats');
  return res.json();
}

export async function fetchPerformance(params: { portfolioId?: string; period?: '7d' | '15d' | '30d' | '90d' | 'all' } = {}) {
  const qs = new URLSearchParams();
  if (params.portfolioId) qs.set('portfolioId', params.portfolioId);
  if (params.period) qs.set('period', params.period);
  const query = qs.toString();
  const res = await fetch(`${API_URL}/api/performance${query ? `?${query}` : ''}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch performance');
  return res.json();
}

export async function fetchAlerts(portfolioId?: string) {
  const qs = portfolioId ? `?portfolioId=${portfolioId}` : '';
  const res = await fetch(`${API_URL}/api/auditor/alerts${qs}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch alerts');
  return res.json();
}

export async function resetTrades(payload: { dryRun?: boolean; confirm?: string; portfolioId?: string } = {}) {
  const res = await fetch(`${API_URL}/api/admin/reset-trades`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun: true, ...payload }),
  });
  if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to reset trades'));
  return res.json();
}

export async function createStrategy(data: any) {
  const res = await fetch(`${API_URL}/api/strategies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to create strategy');
  return res.json();
}

export async function updateStrategy(id: string, data: any) {
  const res = await fetch(`${API_URL}/api/strategies/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to update strategy');
  return res.json();
}

export async function deleteStrategy(id: string) {
  const res = await fetch(`${API_URL}/api/strategies/${id}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to delete strategy');
}

export async function pauseStrategy(id: string) {
  const res = await fetch(`${API_URL}/api/strategies/${id}/pause`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to pause strategy');
  return res.json();
}

export async function resumeStrategy(id: string) {
  const res = await fetch(`${API_URL}/api/strategies/${id}/resume`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to resume strategy');
  return res.json();
}

export async function resetSingleMode(id: string) {
  const res = await fetch(`${API_URL}/api/strategies/${id}/reset-single`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to reset single mode');
  return res.json();
}

export async function pauseAllStrategies(portfolioId?: string) {
  const qs = portfolioId ? `?portfolioId=${portfolioId}` : '';
  const res = await fetch(`${API_URL}/api/strategies/pause-all${qs}`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to pause all strategies');
  return res.json();
}

export async function resumeAllStrategies(portfolioId?: string) {
  const qs = portfolioId ? `?portfolioId=${portfolioId}` : '';
  const res = await fetch(`${API_URL}/api/strategies/resume-all${qs}`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to resume all strategies');
  return res.json();
}

export async function closeAllPositions(portfolioId?: string) {
  const qs = portfolioId ? `?portfolioId=${portfolioId}` : '';
  const res = await fetch(`${API_URL}/api/trades/close-all${qs}`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to close all positions');
  return res.json();
}

export async function closePosition(tradeId: string) {
  const res = await fetch(`${API_URL}/api/trades/close/${tradeId}`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to close position');
  return res.json();
}

export async function getAuditSummary(strategyId?: string) {
  const params = strategyId ? `?strategyId=${strategyId}` : '';
  const res = await fetch(`${API_URL}/api/auditor/summary${params}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch audit summary');
  return res.json();
}

export async function getAuditLogs(filters: {
  strategyId?: string;
  category?: string;
  severity?: string;
  limit?: number;
}) {
  const params = new URLSearchParams();
  if (filters.strategyId) params.set('strategyId', filters.strategyId);
  if (filters.category) params.set('category', filters.category);
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.limit) params.set('limit', String(filters.limit));
  const res = await fetch(`${API_URL}/api/auditor/logs?${params}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch audit logs');
  return res.json();
}

export async function reconcileStrategy(strategyId: string) {
  const res = await fetch(`${API_URL}/api/auditor/reconcile/strategy/${strategyId}`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to reconcile strategy');
  return res.json();
}

export async function sendChatMessage(message: string, history: Array<{ role: string; content: string }>, strategyId?: string) {
  const res = await fetch(`${API_URL}/api/ai-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history, strategyId }),
  });
  if (!res.ok) throw new Error('Failed to send chat message');
  return res.json();
}

export async function getChatStatus() {
  const res = await fetch(`${API_URL}/api/ai-chat/status`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to get chat status');
  return res.json();
}
