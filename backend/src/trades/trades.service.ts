import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Trade } from '../strategies/trade.entity';
import { TradeExecution } from './trade-execution.entity';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class TradesService {
  constructor(
    @InjectRepository(Trade)
    private readonly tradesRepository: Repository<Trade>,
    @InjectRepository(TradeExecution)
    private readonly executionsRepository: Repository<TradeExecution>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(trade: Partial<Trade>): Promise<any> {
    const savedTrade = await this.tradesRepository.save(trade);
    const normalized = this.normalizeTrade(savedTrade);

    this.eventEmitter.emit('trade.created', normalized);

    return normalized;
  }

  async findAll(status?: string, limit: number = 50, portfolioId?: string): Promise<any[]> {
    const where: any = {};

    if (status && ['OPEN', 'CLOSED', 'ERROR'].includes(status.toUpperCase())) {
      where.status = status.toUpperCase();
    }
    if (portfolioId) {
      where.portfolioId = portfolioId;
    }

    const trades = await this.tradesRepository.find({
      where,
      order: { timestamp: 'DESC' },
      take: limit
    });

    return trades.map(this.normalizeTrade);
  }

  async findOpenTrades(portfolioId?: string): Promise<any[]> {
    const where: any = { status: 'OPEN' };
    if (portfolioId) {
      where.portfolioId = portfolioId;
    }
    const trades = await this.tradesRepository.find({
      where,
      order: { timestamp: 'DESC' }
    });
    return trades.map(this.normalizeTrade);
  }

  async findOpenTradeBySymbolAndSide(
    strategyId: string,
    symbol: string,
    side: 'BUY' | 'SELL'
  ): Promise<any> {
    const trade = await this.tradesRepository.findOne({
      where: { strategyId, symbol, side, status: 'OPEN' }
    });
    return trade ? this.normalizeTrade(trade) : null;
  }

  async findRecentTradeBySymbol(
    strategyId: string,
    symbol: string,
    secondsAgo: number = 30
  ): Promise<any> {
    const cutoffTime = new Date(Date.now() - secondsAgo * 1000);

    const trade = await this.tradesRepository
      .createQueryBuilder('trade')
      .where('trade.strategyId = :strategyId', { strategyId })
      .andWhere('trade.symbol = :symbol', { symbol })
      .andWhere('trade.status = :status', { status: 'OPEN' })
      .andWhere('trade.timestamp > :cutoffTime', { cutoffTime })
      .orderBy('trade.timestamp', 'DESC')
      .getOne();

    return trade ? this.normalizeTrade(trade) : null;
  }

  async findLastTradeWithInitialQuantity(strategyId: string): Promise<any> {
    const trade = await this.tradesRepository
      .createQueryBuilder('trade')
      .where('trade.strategyId = :strategyId', { strategyId })
      .andWhere('trade.initialQuantity IS NOT NULL')
      .orderBy('trade.timestamp', 'DESC')
      .getOne();

    return trade ? this.normalizeTrade(trade) : null;
  }

  async findLastClosedTrade(strategyId: string): Promise<any> {
    const trade = await this.tradesRepository.findOne({
      where: { strategyId, status: 'CLOSED' },
      order: { timestamp: 'DESC' }
    });
    return trade ? this.normalizeTrade(trade) : null;
  }

  async countClosedTrades(strategyId: string): Promise<number> {
    return this.tradesRepository.count({
      where: { strategyId, status: 'CLOSED' }
    });
  }

  async findById(id: string): Promise<any> {
    const trade = await this.tradesRepository.findOneBy({ id });
    return trade ? this.normalizeTrade(trade) : null;
  }

  async updateTrade(id: string, updates: Partial<Trade>): Promise<any> {
    if (updates.status === 'ERROR' && !updates.closedAt) {
      updates.closedAt = new Date();
    }

    await this.tradesRepository.update(id, updates);
    const trade = await this.tradesRepository.findOneBy({ id });

    if (trade) {
      const normalized = this.normalizeTrade(trade);

      if (updates.status === 'CLOSED') {
        this.eventEmitter.emit('trade.closed', normalized);
      } else if (updates.status === 'ERROR') {
        this.eventEmitter.emit('trade.error', normalized);
      } else {
        this.eventEmitter.emit('trade.updated', normalized);
      }

      return normalized;
    }

    return null;
  }

  async getStats(portfolioId?: string) {
    try {
      const [openTrades, closedTrades, errorTrades] = await Promise.all([
        this.tradesRepository.find({
          where: portfolioId ? { status: 'OPEN', portfolioId } : { status: 'OPEN' },
          order: { timestamp: 'DESC' }
        }),
        this.tradesRepository.find({
          where: portfolioId ? { status: 'CLOSED', portfolioId } : { status: 'CLOSED' },
          order: { timestamp: 'DESC' }
        }),
        this.tradesRepository.find({
          where: portfolioId ? { status: 'ERROR', portfolioId } : { status: 'ERROR' },
          order: { timestamp: 'DESC' },
          take: 50
        })
      ]);

      const statsOpenTrades = openTrades.filter(t => !t.excludeFromStats);
      const statsClosedTrades = closedTrades.filter(t => !t.excludeFromStats);

      const realizedPnL = this.calculateTotalPnL(statsClosedTrades);
      const unrealizedPnL = this.calculateTotalPnL(statsOpenTrades);
      const totalPnL = realizedPnL + unrealizedPnL;

      const wins = this.countWins(statsClosedTrades);
      const losses = this.countLosses(statsClosedTrades);
      const winRate = this.calculateWinRate(wins, statsClosedTrades.length);

      const allTrades = [...openTrades, ...closedTrades, ...errorTrades]
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, 50);

      return {
        totalPnL,
        realizedPnL,
        unrealizedPnL,
        activePositions: openTrades.length,
        winRate,
        totalTrades: statsClosedTrades.length,
        wins,
        losses,
        recentSignals: allTrades.map(this.normalizeTrade),
        openPositions: openTrades.map(this.normalizeTrade),
        errorTrades: errorTrades.map(this.normalizeTrade)
      };
    } catch (error) {
      return {
        totalPnL: 0,
        realizedPnL: 0,
        unrealizedPnL: 0,
        activePositions: 0,
        winRate: 0,
        totalTrades: 0,
        wins: 0,
        losses: 0,
        recentSignals: [],
        openPositions: [],
        errorTrades: []
      };
    }
  }

  private calculateTotalPnL(trades: Trade[]): number {
    return trades.reduce((sum, t) => sum + this.parsePnL(t.pnl), 0);
  }

  private countWins(trades: Trade[]): number {
    return trades.filter(t => this.parsePnL(t.pnl) > 0).length;
  }

  private countLosses(trades: Trade[]): number {
    return trades.filter(t => this.parsePnL(t.pnl) < 0).length;
  }

  private calculateWinRate(wins: number, total: number): number {
    return total > 0 ? (wins / total) * 100 : 0;
  }

  private parsePnL(pnl: any): number {
    return parseFloat(pnl) || 0;
  }

  private parseValue(value: any): number | string {
    if (value === null || value === undefined || value === '') {
      return 0;
    }
    if (typeof value === 'string') {
      const parsed = parseFloat(value);
      return isNaN(parsed) ? 0 : value;
    }
    if (typeof value === 'number') {
      return isNaN(value) ? 0 : value;
    }
    return value.toString();
  }

  private normalizeTrade = (trade: Trade): any => {
    try {
      return {
        ...trade,
        pnl: trade.pnl !== null && trade.pnl !== undefined ? this.parseValue(trade.pnl) : null,
        entryPrice: this.parseValue(trade.entryPrice),
        exitPrice: trade.exitPrice !== null && trade.exitPrice !== undefined ? this.parseValue(trade.exitPrice) : null,
        quantity: this.parseValue(trade.quantity),
        binancePositionAmt: trade.binancePositionAmt !== null && trade.binancePositionAmt !== undefined ? this.parseValue(trade.binancePositionAmt) : null,
        currentStopLoss: trade.currentStopLoss !== null && trade.currentStopLoss !== undefined ? this.parseValue(trade.currentStopLoss) : null,
        initialQuantity: trade.initialQuantity !== null && trade.initialQuantity !== undefined ? this.parseValue(trade.initialQuantity) : null,
        timestamp: trade.timestamp,
        closedAt: trade.closedAt
      };
    } catch (error) {
      return {
        ...trade,
        pnl: null,
        entryPrice: 0,
        exitPrice: null,
        quantity: 0,
        binancePositionAmt: null,
        currentStopLoss: null,
        initialQuantity: null,
        timestamp: trade.timestamp || new Date(),
        closedAt: trade.closedAt || null
      };
    }
  };

  async findExecutions(tradeId: string): Promise<any[]> {
    try {
      const executions = await this.executionsRepository.find({
        where: { tradeId },
        order: { executedAt: 'ASC' }
      });

      return executions.map(this.normalizeExecution);
    } catch (error: any) {
      console.error(`[TradesService] Error finding executions for trade ${tradeId}:`, error.message);
      throw error;
    }
  }

  private normalizeExecution = (execution: TradeExecution): any => {
    try {
      return {
        ...execution,
        price: this.parseValue(execution.price),
        quantity: this.parseValue(execution.quantity),
        pnl: execution.pnl !== null && execution.pnl !== undefined ? this.parseValue(execution.pnl) : null,
        percentOfPosition: execution.percentOfPosition !== null && execution.percentOfPosition !== undefined ? this.parseValue(execution.percentOfPosition) : null,
        executedAt: execution.executedAt
      };
    } catch (error) {
      return {
        ...execution,
        price: 0,
        quantity: 0,
        pnl: null,
        percentOfPosition: null,
        executedAt: execution.executedAt || new Date()
      };
    }
  };

  async createExecution(execution: Partial<TradeExecution>): Promise<any> {
    const savedExecution = await this.executionsRepository.save(execution);
    return this.normalizeExecution(savedExecution);
  }
}
