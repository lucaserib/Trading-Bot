import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PortfolioMigrationService } from './portfolio-migration.service';
import { Portfolio, PortfolioMode } from './portfolio.entity';
import { Strategy, Exchange } from '../strategies/strategy.entity';
import { Trade } from '../strategies/trade.entity';

function makeQueryBuilder(strategies: any[]) {
  return {
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(strategies),
  };
}

describe('PortfolioMigrationService', () => {
  let service: PortfolioMigrationService;
  let strategyRepo: { createQueryBuilder: jest.Mock; update: jest.Mock };
  let portfolioRepo: { find: jest.Mock; create: jest.Mock; save: jest.Mock };
  let portfoliosRepository: { manager: { transaction: jest.Mock } };
  let idCounter: number;

  function setCandidates(strategies: any[], existingPortfolioNames: string[] = []) {
    idCounter = 0;
    strategyRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(makeQueryBuilder(strategies)),
      update: jest.fn().mockResolvedValue(undefined),
    };
    portfolioRepo = {
      find: jest.fn().mockResolvedValue(existingPortfolioNames.map((name) => ({ name }))),
      create: jest.fn((data: any) => ({ ...data })),
      save: jest.fn(async (entity: any) => ({ id: `portfolio-${++idCounter}`, ...entity })),
    };
    const manager = {
      getRepository: jest.fn((entity: any) => (entity === Strategy ? strategyRepo : portfolioRepo)),
    };
    portfoliosRepository.manager.transaction = jest.fn((cb: any) => cb(manager));
  }

  beforeEach(async () => {
    portfoliosRepository = { manager: { transaction: jest.fn() } };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortfolioMigrationService,
        { provide: getRepositoryToken(Portfolio), useValue: portfoliosRepository },
      ],
    }).compile();

    service = module.get<PortfolioMigrationService>(PortfolioMigrationService);
    setCandidates([]);
  });

  it('agrupa estrategias com exchange+isTestnet+isRealAccount+apiKey identicos em um unico portfolio', async () => {
    const strategies = [
      { id: 's1', exchange: Exchange.BYBIT, isTestnet: true, isRealAccount: false, apiKey: 'enc-key-1', apiSecret: 'enc-secret-1', portfolioId: null },
      { id: 's2', exchange: Exchange.BYBIT, isTestnet: true, isRealAccount: false, apiKey: 'enc-key-1', apiSecret: 'enc-secret-1', portfolioId: null },
    ];
    setCandidates(strategies);

    const result = await service.migrateLegacyStrategies();

    expect(result).toEqual({ portfoliosCreated: 1, strategiesLinked: 2 });
    expect(portfolioRepo.save).toHaveBeenCalledTimes(1);
    const savedPortfolio = portfolioRepo.create.mock.calls[0][0];
    expect(savedPortfolio.name).toBe('Bybit Demo');
    expect(savedPortfolio.exchange).toBe(Exchange.BYBIT);
    expect(savedPortfolio.mode).toBe(PortfolioMode.DEMO);
    expect(savedPortfolio.apiKey).toBe('enc-key-1');
    expect(strategyRepo.update).toHaveBeenCalledWith('s1', { portfolioId: 'portfolio-1' });
    expect(strategyRepo.update).toHaveBeenCalledWith('s2', { portfolioId: 'portfolio-1' });
  });

  it('estrategias com ciphertext diferente (mesmo que a chave em texto puro seja igual) viram portfolios separados -- nunca descriptografa', async () => {
    const strategies = [
      { id: 's1', exchange: Exchange.BYBIT, isTestnet: false, isRealAccount: true, apiKey: 'enc-key-A', apiSecret: 'enc-secret-A', portfolioId: null },
      { id: 's2', exchange: Exchange.BYBIT, isTestnet: false, isRealAccount: true, apiKey: 'enc-key-B', apiSecret: 'enc-secret-B', portfolioId: null },
    ];
    setCandidates(strategies);

    const result = await service.migrateLegacyStrategies();

    expect(result).toEqual({ portfoliosCreated: 2, strategiesLinked: 2 });
  });

  it('mapeia isTestnet=false para modo REAL e nomeia "<Exchange> Real"', async () => {
    setCandidates([
      { id: 's1', exchange: Exchange.BINANCE, isTestnet: false, isRealAccount: true, apiKey: 'k', apiSecret: 's', portfolioId: null },
    ]);

    await service.migrateLegacyStrategies();

    const savedPortfolio = portfolioRepo.create.mock.calls[0][0];
    expect(savedPortfolio.name).toBe('Binance Real');
    expect(savedPortfolio.mode).toBe(PortfolioMode.REAL);
  });

  it('nomes colidentes recebem sufixo numerico para permanecerem unicos', async () => {
    setCandidates(
      [
        { id: 's1', exchange: Exchange.BYBIT, isTestnet: true, isRealAccount: false, apiKey: 'k1', apiSecret: 's1', portfolioId: null },
        { id: 's2', exchange: Exchange.BYBIT, isTestnet: true, isRealAccount: false, apiKey: 'k2', apiSecret: 's2', portfolioId: null },
      ],
      ['Bybit Demo'],
    );

    await service.migrateLegacyStrategies();

    const names = portfolioRepo.create.mock.calls.map((call: any) => call[0].name);
    expect(names.sort()).toEqual(['Bybit Demo (2)', 'Bybit Demo (3)']);
  });

  it('estrategia sem credenciais nao entra em nenhum grupo (fica com portfolioId nulo, continua no fallback)', async () => {
    setCandidates([]);
    const qb = makeQueryBuilder([]);
    strategyRepo.createQueryBuilder.mockReturnValue(qb);

    const result = await service.migrateLegacyStrategies();

    expect(qb.andWhere).toHaveBeenCalledWith('strategy.apiKey IS NOT NULL');
    expect(qb.andWhere).toHaveBeenCalledWith('strategy.apiSecret IS NOT NULL');
    expect(result).toEqual({ portfoliosCreated: 0, strategiesLinked: 0 });
  });

  it('estrategia ja migrada (portfolioId preenchido) e excluida da query -- migracao idempotente', async () => {
    setCandidates([]);
    const qb = makeQueryBuilder([]);
    strategyRepo.createQueryBuilder.mockReturnValue(qb);

    await service.migrateLegacyStrategies();

    expect(qb.where).toHaveBeenCalledWith('strategy.portfolioId IS NULL');
  });

  it('rodar a migracao duas vezes seguidas nao cria portfolios/duplicatas na segunda vez', async () => {
    const strategies = [
      { id: 's1', exchange: Exchange.BYBIT, isTestnet: true, isRealAccount: false, apiKey: 'k1', apiSecret: 's1', portfolioId: null },
    ];
    setCandidates(strategies);

    const first = await service.migrateLegacyStrategies();
    expect(first).toEqual({ portfoliosCreated: 1, strategiesLinked: 1 });

    setCandidates([]);
    const second = await service.migrateLegacyStrategies();

    expect(second).toEqual({ portfoliosCreated: 0, strategiesLinked: 0 });
  });
});

describe('PortfolioMigrationService.backfillTradePortfolioIds', () => {
  let service: PortfolioMigrationService;
  let strategyFindRepo: { find: jest.Mock };
  let tradeUpdateBuilder: { set: jest.Mock; where: jest.Mock; andWhere: jest.Mock; execute: jest.Mock };
  let tradeRepo: { createQueryBuilder: jest.Mock };
  let portfoliosRepository: { manager: { transaction: jest.Mock } };

  function setup(strategiesWithPortfolio: any[], affectedPerStrategy: number[] = []) {
    strategyFindRepo = { find: jest.fn().mockResolvedValue(strategiesWithPortfolio) };
    tradeUpdateBuilder = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn(),
    };
    let call = 0;
    tradeUpdateBuilder.execute.mockImplementation(() => Promise.resolve({ affected: affectedPerStrategy[call++] ?? 0 }));
    tradeRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({ update: jest.fn().mockReturnValue(tradeUpdateBuilder) }),
    };
    const manager = {
      getRepository: jest.fn((entity: any) => (entity === Strategy ? strategyFindRepo : tradeRepo)),
    };
    portfoliosRepository.manager.transaction = jest.fn((cb: any) => cb(manager));
  }

  beforeEach(async () => {
    portfoliosRepository = { manager: { transaction: jest.fn() } };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortfolioMigrationService,
        { provide: getRepositoryToken(Portfolio), useValue: portfoliosRepository },
      ],
    }).compile();

    service = module.get<PortfolioMigrationService>(PortfolioMigrationService);
    setup([]);
  });

  it('busca so estrategias com portfolioId preenchido e atualiza os trades daquela estrategia sem portfolioId', async () => {
    setup(
      [{ id: 's1', portfolioId: 'p1' }, { id: 's2', portfolioId: 'p2' }],
      [3, 5],
    );

    const result = await service.backfillTradePortfolioIds();

    expect(strategyFindRepo.find).toHaveBeenCalledWith({ where: { portfolioId: expect.anything() }, select: ['id', 'portfolioId'] });
    expect(tradeUpdateBuilder.set).toHaveBeenNthCalledWith(1, { portfolioId: 'p1' });
    expect(tradeUpdateBuilder.set).toHaveBeenNthCalledWith(2, { portfolioId: 'p2' });
    expect(tradeUpdateBuilder.andWhere).toHaveBeenCalledWith('"portfolioId" IS NULL');
    expect(result).toEqual({ tradesUpdated: 8 });
  });

  it('sem estrategias com portfolio, nao atualiza nenhum trade', async () => {
    setup([]);

    const result = await service.backfillTradePortfolioIds();

    expect(result).toEqual({ tradesUpdated: 0 });
  });

  it('rodar duas vezes seguidas e um no-op na segunda vez (idempotente, filtro portfolioId IS NULL)', async () => {
    setup([{ id: 's1', portfolioId: 'p1' }], [4]);
    const first = await service.backfillTradePortfolioIds();
    expect(first).toEqual({ tradesUpdated: 4 });

    setup([{ id: 's1', portfolioId: 'p1' }], [0]);
    const second = await service.backfillTradePortfolioIds();
    expect(second).toEqual({ tradesUpdated: 0 });
  });
});
