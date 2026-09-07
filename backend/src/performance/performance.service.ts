import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { Trade } from '../strategies/trade.entity';

export type PerformancePeriod = '7d' | '15d' | '30d' | '90d' | 'all';

export interface DailyPerformance {
  date: string;
  spot: number;
  futures: number;
  total: number;
  cumulative: number;
}

export interface PerformanceResponse {
  period: PerformancePeriod;
  totalPnl: number;
  daily: DailyPerformance[];
}

const PERIOD_DAYS: Record<Exclude<PerformancePeriod, 'all'>, number> = {
  '7d': 7,
  '15d': 15,
  '30d': 30,
  '90d': 90,
};

@Injectable()
export class PerformanceService {
  constructor(
    @InjectRepository(Trade)
    private readonly tradeRepository: Repository<Trade>,
  ) {}

  async getPerformance(params: { portfolioId?: string; period?: PerformancePeriod }): Promise<PerformanceResponse> {
    const period = params.period && ['7d', '15d', '30d', '90d', 'all'].includes(params.period) ? params.period : '30d';

    const where: any = { status: 'CLOSED', excludeFromStats: false };
    if (params.portfolioId) {
      where.portfolioId = params.portfolioId;
    }
    if (period !== 'all') {
      const since = new Date(Date.now() - PERIOD_DAYS[period] * 24 * 60 * 60 * 1000);
      where.closedAt = MoreThanOrEqual(since);
    }

    const trades = await this.tradeRepository.find({ where, order: { closedAt: 'ASC' } });

    const byDate = new Map<string, number>();
    for (const trade of trades) {
      if (!trade.closedAt) continue;
      const dateKey = new Date(trade.closedAt).toISOString().slice(0, 10);
      const pnl = parseFloat(trade.pnl as any) || 0;
      byDate.set(dateKey, (byDate.get(dateKey) || 0) + pnl);
    }

    const sortedDates = [...byDate.keys()].sort();
    let cumulative = 0;
    const daily: DailyPerformance[] = sortedDates.map((date) => {
      const futures = byDate.get(date)!;
      cumulative += futures;
      return { date, spot: 0, futures, total: futures, cumulative };
    });

    const totalPnl = daily.reduce((sum, d) => sum + d.futures, 0);

    return { period, totalPnl, daily };
  }
}
