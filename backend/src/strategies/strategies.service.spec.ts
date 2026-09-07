jest.mock('../utils/binance-request.util', () => ({
  BinanceRequestUtil: { get: jest.fn(), post: jest.fn(), delete: jest.fn() },
}));

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StrategiesService } from './strategies.service';
import { Strategy } from './strategy.entity';
import { Trade } from './trade.entity';
import { BybitClientService } from '../exchange/bybit-client.service';
import { CredentialsResolverService } from '../common/credentials-resolver.service';
import { PortfoliosService } from '../portfolios/portfolios.service';

describe('StrategiesService', () => {
  let service: StrategiesService;
  let strategiesRepository: { findOne: jest.Mock; update: jest.Mock; findOneBy: jest.Mock };

  beforeEach(async () => {
    strategiesRepository = {
      findOne: jest.fn(),
      update: jest.fn(),
      findOneBy: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StrategiesService,
        { provide: getRepositoryToken(Strategy), useValue: strategiesRepository },
        { provide: getRepositoryToken(Trade), useValue: {} },
        { provide: BybitClientService, useValue: {} },
        {
          provide: CredentialsResolverService,
          useValue: {
            resolveCredentials: jest.fn((s: any) =>
              Promise.resolve({
                apiKey: s.apiKey,
                apiSecret: s.apiSecret,
                exchange: s.exchange,
                isTestnet: s.isTestnet,
                isRealAccount: s.isRealAccount,
                portfolioId: null,
                source: 'strategy',
              }),
            ),
          },
        },
        { provide: PortfoliosService, useValue: { findSummariesByIds: jest.fn().mockResolvedValue(new Map()) } },
      ],
    }).compile();

    service = module.get<StrategiesService>(StrategiesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('findOnePublic requests enableTakeProfit1/2/3 in the select list', async () => {
    strategiesRepository.findOne.mockResolvedValue(null);

    await service.findOnePublic('strategy-1');

    const options = strategiesRepository.findOne.mock.calls[0][0];
    expect(options.select).toEqual(
      expect.arrayContaining(['enableTakeProfit1', 'enableTakeProfit2', 'enableTakeProfit3']),
    );
  });

  it('update persists a disabled TP2 and the read-back reflects it (round-trip)', async () => {
    strategiesRepository.update.mockResolvedValue(undefined);
    strategiesRepository.findOneBy.mockResolvedValue({
      id: 'strategy-1',
      enableTakeProfit1: true,
      enableTakeProfit2: false,
      enableTakeProfit3: true,
      takeProfitPercentage2: null,
    } as unknown as Strategy);

    const result = await service.update('strategy-1', {
      enableTakeProfit2: false,
      takeProfitPercentage2: null as unknown as number,
    });

    expect(strategiesRepository.update).toHaveBeenCalledWith(
      'strategy-1',
      expect.objectContaining({ enableTakeProfit2: false, takeProfitPercentage2: null }),
    );
    expect(result?.enableTakeProfit2).toBe(false);

    strategiesRepository.findOne.mockResolvedValue(result);
    const reloaded = await service.findOnePublic('strategy-1');
    expect(reloaded?.enableTakeProfit2).toBe(false);
  });
});

describe('StrategiesService (FASE 2 -- CredentialsResolver)', () => {
  let service: StrategiesService;
  let strategiesRepository: { findOne: jest.Mock };
  let credentialsResolver: { resolveCredentials: jest.Mock };
  let bybitClient: { getOpenOrders: jest.Mock; getPositions: jest.Mock };
  let portfoliosService: { findSummariesByIds: jest.Mock };

  beforeEach(async () => {
    strategiesRepository = { findOne: jest.fn() };
    credentialsResolver = { resolveCredentials: jest.fn() };
    bybitClient = { getOpenOrders: jest.fn().mockResolvedValue([]), getPositions: jest.fn().mockResolvedValue([]) };
    portfoliosService = { findSummariesByIds: jest.fn().mockResolvedValue(new Map()) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StrategiesService,
        { provide: getRepositoryToken(Strategy), useValue: strategiesRepository },
        { provide: getRepositoryToken(Trade), useValue: {} },
        { provide: BybitClientService, useValue: bybitClient },
        { provide: CredentialsResolverService, useValue: credentialsResolver },
        { provide: PortfoliosService, useValue: portfoliosService },
      ],
    }).compile();

    service = module.get<StrategiesService>(StrategiesService);
  });

  it('getOpenOrders com portfolio: consulta a corretora com as credenciais/exchange do portfolio', async () => {
    const strategy = {
      id: 's1',
      name: 'Estrategia X',
      exchange: 'binance',
      isTestnet: true,
      apiKey: 'legacy-key',
      apiSecret: 'legacy-secret',
      portfolioId: 'portfolio-1',
    } as unknown as Strategy;
    strategiesRepository.findOne.mockResolvedValue(strategy);
    credentialsResolver.resolveCredentials.mockResolvedValue({
      apiKey: 'portfolio-key',
      apiSecret: 'portfolio-secret',
      exchange: 'bybit',
      isTestnet: false,
      isRealAccount: true,
      portfolioId: 'portfolio-1',
      source: 'portfolio',
    });

    const result = await service.getOpenOrders('s1');

    expect(bybitClient.getOpenOrders).toHaveBeenCalledWith('portfolio-key', 'portfolio-secret', false);
    expect(result.strategy.exchange).toBe('bybit');
    expect(result.strategy.isTestnet).toBe(false);
  });

  it('findAll anexa o resumo do portfolio quando a estrategia tem portfolioId', async () => {
    const strategies = [
      { id: 's1', name: 'A', portfolioId: 'p1' },
      { id: 's2', name: 'B', portfolioId: null },
    ] as unknown as Strategy[];
    (strategiesRepository as any).find = jest.fn().mockResolvedValue(strategies);
    portfoliosService.findSummariesByIds.mockResolvedValue(
      new Map([['p1', { id: 'p1', name: 'Bybit Demo', exchange: 'bybit', mode: 'DEMO' }]]),
    );

    const result = await service.findAll();

    expect(portfoliosService.findSummariesByIds).toHaveBeenCalledWith(['p1']);
    expect(result[0].portfolio).toEqual({ id: 'p1', name: 'Bybit Demo', exchange: 'bybit', mode: 'DEMO' });
    expect(result[1].portfolio).toBeNull();
  });

  it('GET /strategies devolve portfolioId e um objeto portfolio com exatamente as chaves esperadas pela UI', async () => {
    const strategies = [
      { id: 's1', name: 'A', portfolioId: 'p1' },
    ] as unknown as Strategy[];
    (strategiesRepository as any).find = jest.fn().mockResolvedValue(strategies);
    portfoliosService.findSummariesByIds.mockResolvedValue(
      new Map([['p1', { id: 'p1', name: 'teste', exchange: 'bybit', mode: 'DEMO' }]]),
    );

    const result = await service.findAll();

    expect(result[0]).toHaveProperty('portfolioId', 'p1');
    expect(Object.keys(result[0].portfolio!).sort()).toEqual(['exchange', 'id', 'mode', 'name'].sort());
    expect(result[0]).not.toHaveProperty('apiKey');
    expect(result[0]).not.toHaveProperty('apiSecret');
  });
});
