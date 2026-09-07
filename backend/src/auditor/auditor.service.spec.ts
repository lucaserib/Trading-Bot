jest.mock('../utils/binance-request.util', () => ({
  BinanceRequestUtil: { get: jest.fn(), post: jest.fn(), delete: jest.fn() },
}));

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditorService } from './auditor.service';
import { AuditLog, AuditCategory, AuditSeverity } from './audit-log.entity';
import { Trade } from '../strategies/trade.entity';
import { TradeExecution } from '../trades/trade-execution.entity';
import { Strategy } from '../strategies/strategy.entity';
import { ExchangeService } from '../exchange/exchange.service';
import { CredentialsResolverService } from '../common/credentials-resolver.service';

function makeQueryBuilder(strategy: any) {
  return {
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(strategy),
  };
}

describe('AuditorService (FASE 5 -- TP_EXECUTED_AT_MARKET)', () => {
  let service: AuditorService;
  let auditRepo: { save: jest.Mock };
  let tradeRepo: { findOne: jest.Mock };
  let execRepo: { find: jest.Mock };
  let strategyRepo: { createQueryBuilder: jest.Mock };

  beforeEach(async () => {
    auditRepo = { save: jest.fn() };
    tradeRepo = { findOne: jest.fn() };
    execRepo = { find: jest.fn().mockResolvedValue([]) };
    strategyRepo = { createQueryBuilder: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditorService,
        { provide: getRepositoryToken(AuditLog), useValue: auditRepo },
        { provide: getRepositoryToken(Trade), useValue: tradeRepo },
        { provide: getRepositoryToken(TradeExecution), useValue: execRepo },
        { provide: getRepositoryToken(Strategy), useValue: strategyRepo },
        { provide: ExchangeService, useValue: {} },
        {
          provide: CredentialsResolverService,
          useValue: {
            resolveCredentials: jest.fn((strategy: any) =>
              Promise.resolve({
                apiKey: strategy.apiKey,
                apiSecret: strategy.apiSecret,
                exchange: strategy.exchange,
                isTestnet: strategy.isTestnet,
                isRealAccount: strategy.isRealAccount,
                portfolioId: null,
                source: 'strategy',
              }),
            ),
          },
        },
      ],
    }).compile();

    service = module.get<AuditorService>(AuditorService);
  });

  it('emite TP_EXECUTED_AT_MARKET (WARNING) para um trade fechado via fallback, com alvo x executado x diff', async () => {
    const trade = {
      id: 'trade-1',
      strategyId: 'strategy-1',
      symbol: 'SUIUSDT',
      side: 'SELL',
      status: 'CLOSED',
      entryPrice: 0.7546,
      exitPrice: 0.7535,
      closeReason: 'TAKE_PROFIT_FALLBACK_MARKET',
      closeDetail: 'TARGET:0.75234',
      quantity: 60,
      pnl: 6.6,
      exchangeOrderId: null,
      stopLossOrderId: null,
      takeProfitOrderId: null,
      timestamp: new Date(),
    } as unknown as Trade;

    tradeRepo.findOne.mockResolvedValue(trade);
    strategyRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder({ id: 'strategy-1', apiKey: null, apiSecret: null }));

    const result = await service.reconcileTrade('trade-1');

    const issue = result.issues.find(i => i.category === AuditCategory.TP_EXECUTED_AT_MARKET);
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe(AuditSeverity.WARNING);
    expect(issue!.expectedValue).toBeCloseTo(0.75234, 8);
    expect(issue!.actualValue).toBeCloseTo(0.7535, 8);
    expect(issue!.message).toContain('mercado');
  });

  it('nao emite TP_EXECUTED_AT_MARKET para um TP fechado normalmente no alvo LIMIT', async () => {
    const trade = {
      id: 'trade-2',
      strategyId: 'strategy-1',
      symbol: 'SUIUSDT',
      side: 'SELL',
      status: 'CLOSED',
      entryPrice: 0.7546,
      exitPrice: 0.75234,
      closeReason: 'TAKE_PROFIT_3',
      closeDetail: null,
      quantity: 60,
      pnl: 6.6,
      exchangeOrderId: null,
      stopLossOrderId: null,
      takeProfitOrderId: null,
      timestamp: new Date(),
    } as unknown as Trade;

    tradeRepo.findOne.mockResolvedValue(trade);
    strategyRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder({
      id: 'strategy-1', apiKey: null, apiSecret: null, takeProfitPercentage3: 0.3,
    }));

    const result = await service.reconcileTrade('trade-2');

    expect(result.issues.find(i => i.category === AuditCategory.TP_EXECUTED_AT_MARKET)).toBeUndefined();
  });
});

describe('AuditorService (FASE 2 -- CredentialsResolver)', () => {
  let service: AuditorService;
  let strategyRepo: { createQueryBuilder: jest.Mock };
  let tradeRepo: { findOne: jest.Mock };
  let execRepo: { find: jest.Mock };
  let exchangeService: { getExchange: jest.Mock };
  let credentialsResolver: { resolveCredentials: jest.Mock };

  beforeEach(async () => {
    strategyRepo = { createQueryBuilder: jest.fn() };
    tradeRepo = { findOne: jest.fn() };
    execRepo = { find: jest.fn().mockResolvedValue([]) };
    exchangeService = { getExchange: jest.fn() };
    credentialsResolver = { resolveCredentials: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditorService,
        { provide: getRepositoryToken(AuditLog), useValue: { save: jest.fn() } },
        { provide: getRepositoryToken(Trade), useValue: tradeRepo },
        { provide: getRepositoryToken(TradeExecution), useValue: execRepo },
        { provide: getRepositoryToken(Strategy), useValue: strategyRepo },
        { provide: ExchangeService, useValue: exchangeService },
        { provide: CredentialsResolverService, useValue: credentialsResolver },
      ],
    }).compile();

    service = module.get<AuditorService>(AuditorService);
  });

  it('reconcileTrade com portfolio: busca a ordem na corretora usando as credenciais/exchange do portfolio', async () => {
    const trade = {
      id: 'trade-1',
      strategyId: 'strategy-1',
      symbol: 'BTCUSDT',
      side: 'BUY',
      status: 'OPEN',
      entryPrice: 60000,
      exitPrice: null,
      closeReason: null,
      closeDetail: null,
      quantity: 1,
      pnl: null,
      exchangeOrderId: 'order-1',
      stopLossOrderId: null,
      takeProfitOrderId: null,
      timestamp: new Date(),
    } as unknown as Trade;

    tradeRepo.findOne.mockResolvedValue(trade);
    strategyRepo.createQueryBuilder.mockReturnValue(
      makeQueryBuilder({ id: 'strategy-1', exchange: 'binance', isTestnet: true, apiKey: 'legacy', apiSecret: 'legacy', portfolioId: 'p1' }),
    );
    credentialsResolver.resolveCredentials.mockResolvedValue({
      apiKey: 'portfolio-key',
      apiSecret: 'portfolio-secret',
      exchange: 'bybit',
      isTestnet: false,
      isRealAccount: true,
      portfolioId: 'p1',
      source: 'portfolio',
    });
    const fetchOrder = jest.fn().mockResolvedValue({ id: 'order-1', price: 60000, average: 60000, filled: 1, fee: { cost: 0.1, currency: 'USDT' }, status: 'closed', timestamp: Date.now() });
    exchangeService.getExchange.mockResolvedValue({ fetchOrder, fetchMyTrades: jest.fn().mockResolvedValue([]) });

    await service.reconcileTrade('trade-1');

    expect(exchangeService.getExchange).toHaveBeenCalledWith('bybit', 'portfolio-key', 'portfolio-secret', false);
  });
});

describe('AuditorService.getAlerts (FASE 9 -- pagina Avisos)', () => {
  let service: AuditorService;
  let auditRepo: { find: jest.Mock };
  let tradeRepo: { find: jest.Mock };
  let strategyRepo: { find: jest.Mock };

  beforeEach(async () => {
    auditRepo = { find: jest.fn().mockResolvedValue([]) };
    tradeRepo = { find: jest.fn().mockResolvedValue([]) };
    strategyRepo = { find: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditorService,
        { provide: getRepositoryToken(AuditLog), useValue: auditRepo },
        { provide: getRepositoryToken(Trade), useValue: tradeRepo },
        { provide: getRepositoryToken(TradeExecution), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(Strategy), useValue: strategyRepo },
        { provide: ExchangeService, useValue: {} },
        { provide: CredentialsResolverService, useValue: { resolveCredentials: jest.fn() } },
      ],
    }).compile();

    service = module.get<AuditorService>(AuditorService);
  });

  it('sem portfolioId: agrega issues ERROR/WARNING, trades ERROR, tpWarnings, sem protecao e estrategias pausadas globalmente', async () => {
    auditRepo.find.mockResolvedValue([{ id: 'log-1', severity: AuditSeverity.WARNING }]);
    tradeRepo.find
      .mockResolvedValueOnce([{ id: 'trade-error', status: 'ERROR' }])
      .mockResolvedValueOnce([
        { id: 'trade-open-1', status: 'OPEN', tpWarnings: 'TP_MISSING_RETRY:1', stopLossOrderId: 'sl-1', takeProfitOrderId: 'tp-1' },
        { id: 'trade-open-2', status: 'OPEN', tpWarnings: null, stopLossOrderId: null, takeProfitOrderId: 'tp-1' },
      ]);
    strategyRepo.find.mockResolvedValue([{ id: 's1', name: 'Pausada', portfolioId: null }]);

    const result = await service.getAlerts();

    expect(result.auditIssues).toHaveLength(1);
    expect(result.errorTrades).toEqual([{ id: 'trade-error', status: 'ERROR' }]);
    expect(result.tpWarningTrades.map((t) => t.id)).toEqual(['trade-open-1']);
    expect(result.unprotectedTrades.map((t) => t.id)).toEqual(['trade-open-2']);
    expect(result.pausedStrategies).toEqual([{ id: 's1', name: 'Pausada', portfolioId: null }]);
  });

  it('com portfolioId: filtra trades/estrategias pelo portfolio e os audit logs pelas estrategias daquele portfolio', async () => {
    strategyRepo.find.mockResolvedValueOnce([{ id: 's1' }]);

    await service.getAlerts('portfolio-1');

    expect(strategyRepo.find).toHaveBeenNthCalledWith(1, { where: { portfolioId: 'portfolio-1' }, select: ['id'] });
    const auditWhere = auditRepo.find.mock.calls[0][0].where;
    expect(auditWhere[0]).toMatchObject({ severity: AuditSeverity.ERROR });
    expect(auditWhere[1]).toMatchObject({ severity: AuditSeverity.WARNING });
    expect(tradeRepo.find).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: { status: 'ERROR', portfolioId: 'portfolio-1' } }));
    expect(tradeRepo.find).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: { status: 'OPEN', portfolioId: 'portfolio-1' } }));
    expect(strategyRepo.find).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: { pauseNewOrders: true, portfolioId: 'portfolio-1' } }));
  });
});
