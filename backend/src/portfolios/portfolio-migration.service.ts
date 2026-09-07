import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { Portfolio, PortfolioMode } from './portfolio.entity';
import { Strategy } from '../strategies/strategy.entity';
import { Trade } from '../strategies/trade.entity';

export interface LegacyMigrationResult {
  portfoliosCreated: number;
  strategiesLinked: number;
}

export interface TradeBackfillResult {
  tradesUpdated: number;
}

@Injectable()
export class PortfolioMigrationService {
  private readonly logger = new Logger(PortfolioMigrationService.name);

  constructor(
    @InjectRepository(Portfolio)
    private readonly portfoliosRepository: Repository<Portfolio>,
  ) {}

  private buildPortfolioName(baseName: string, usedNames: Set<string>): string {
    let name = baseName;
    let suffix = 2;
    while (usedNames.has(name)) {
      name = `${baseName} (${suffix})`;
      suffix++;
    }
    usedNames.add(name);
    return name;
  }

  async migrateLegacyStrategies(): Promise<LegacyMigrationResult> {
    return this.portfoliosRepository.manager.transaction(async (manager) => {
      const strategyRepo = manager.getRepository(Strategy);
      const portfolioRepo = manager.getRepository(Portfolio);

      const candidates = await strategyRepo
        .createQueryBuilder('strategy')
        .addSelect(['strategy.apiKey', 'strategy.apiSecret'])
        .where('strategy.portfolioId IS NULL')
        .andWhere('strategy.apiKey IS NOT NULL')
        .andWhere('strategy.apiSecret IS NOT NULL')
        .getMany();

      const groups = new Map<string, Strategy[]>();
      for (const strategy of candidates) {
        const key = [strategy.exchange, strategy.isTestnet, strategy.isRealAccount, strategy.apiKey].join('|');
        const group = groups.get(key) ?? [];
        group.push(strategy);
        groups.set(key, group);
      }

      const existingPortfolios = await portfolioRepo.find({ select: ['name'] });
      const usedNames = new Set(existingPortfolios.map((p) => p.name));

      let portfoliosCreated = 0;
      let strategiesLinked = 0;

      for (const group of groups.values()) {
        const sample = group[0];
        const mode = sample.isTestnet ? PortfolioMode.DEMO : PortfolioMode.REAL;
        const exchangeLabel = sample.exchange.charAt(0).toUpperCase() + sample.exchange.slice(1);
        const modeLabel = mode === PortfolioMode.DEMO ? 'Demo' : 'Real';
        const name = this.buildPortfolioName(`${exchangeLabel} ${modeLabel}`, usedNames);

        const portfolio = portfolioRepo.create({
          name,
          exchange: sample.exchange,
          mode,
          apiKey: sample.apiKey,
          apiSecret: sample.apiSecret,
          isActive: true,
        });
        const saved = await portfolioRepo.save(portfolio);
        portfoliosCreated++;

        for (const strategy of group) {
          await strategyRepo.update(strategy.id, { portfolioId: saved.id });
          strategiesLinked++;
        }
      }

      this.logger.log(
        `[MIGRATION] ${portfoliosCreated} portfolio(s) criado(s), ${strategiesLinked} estrategia(s) vinculada(s)`,
      );
      return { portfoliosCreated, strategiesLinked };
    });
  }

  async backfillTradePortfolioIds(): Promise<TradeBackfillResult> {
    return this.portfoliosRepository.manager.transaction(async (manager) => {
      const strategyRepo = manager.getRepository(Strategy);
      const tradeRepo = manager.getRepository(Trade);

      const strategiesWithPortfolio = await strategyRepo.find({
        where: { portfolioId: Not(IsNull()) },
        select: ['id', 'portfolioId'],
      });

      let tradesUpdated = 0;
      for (const strategy of strategiesWithPortfolio) {
        const result = await tradeRepo
          .createQueryBuilder()
          .update(Trade)
          .set({ portfolioId: strategy.portfolioId })
          .where('"strategyId" = :strategyId', { strategyId: strategy.id })
          .andWhere('"portfolioId" IS NULL')
          .execute();
        tradesUpdated += result.affected || 0;
      }

      this.logger.log(`[BACKFILL] ${tradesUpdated} trade(s) receberam portfolioId a partir da estrategia`);
      return { tradesUpdated };
    });
  }
}
