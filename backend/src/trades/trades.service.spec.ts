import { TradesService } from './trades.service';

function makeRepo(findResult: any[] = []) {
  return {
    find: jest.fn().mockResolvedValue(findResult),
  } as any;
}

function makeTrade(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trade-1',
    status: 'CLOSED',
    pnl: 0,
    excludeFromStats: false,
    timestamp: new Date('2026-08-19T04:00:00Z'),
    closedAt: new Date('2026-08-19T05:00:00Z'),
    ...overrides,
  };
}

describe('TradesService.getStats (exclusao de duplicatas do acumulado)', () => {
  it('caso real: mesma posicao em dois trades (A com TP3 +5.4555, B duplicata MANUAL +2.506) - acumulado conta so o A', async () => {
    const tradeA = makeTrade({ id: 'trade-a', pnl: 5.4555, excludeFromStats: false });
    const tradeB = makeTrade({ id: 'trade-b', pnl: 2.506, excludeFromStats: true });

    const tradesRepository = makeRepo([]);
    tradesRepository.find = jest.fn()
      .mockImplementation(({ where }: any) => {
        if (where.status === 'OPEN') return Promise.resolve([]);
        if (where.status === 'CLOSED') return Promise.resolve([tradeA, tradeB]);
        return Promise.resolve([]);
      });

    const service = new TradesService(tradesRepository, makeRepo([]), { emit: jest.fn() } as any);
    const stats = await service.getStats();

    expect(stats.realizedPnL).toBeCloseTo(5.4555, 4);
    expect(stats.totalPnL).toBeCloseTo(5.4555, 4);
    expect(stats.totalTrades).toBe(1);
  });

  it('sem trades marcados, soma normalmente (comportamento atual preservado)', async () => {
    const tradeA = makeTrade({ id: 'trade-1', pnl: 10 });
    const tradeB = makeTrade({ id: 'trade-2', pnl: -3 });

    const tradesRepository = makeRepo([]);
    tradesRepository.find = jest.fn()
      .mockImplementation(({ where }: any) => {
        if (where.status === 'OPEN') return Promise.resolve([]);
        if (where.status === 'CLOSED') return Promise.resolve([tradeA, tradeB]);
        return Promise.resolve([]);
      });

    const service = new TradesService(tradesRepository, makeRepo([]), { emit: jest.fn() } as any);
    const stats = await service.getStats();

    expect(stats.realizedPnL).toBeCloseTo(7, 4);
    expect(stats.totalTrades).toBe(2);
    expect(stats.wins).toBe(1);
    expect(stats.losses).toBe(1);
  });

  it('trades excluidos continuam aparecendo em recentSignals/openPositions (visiveis na UI, so nao contam no acumulado)', async () => {
    const excluded = makeTrade({ id: 'trade-dust', pnl: null, status: 'CLOSED', excludeFromStats: true });

    const tradesRepository = makeRepo([]);
    tradesRepository.find = jest.fn()
      .mockImplementation(({ where }: any) => {
        if (where.status === 'OPEN') return Promise.resolve([]);
        if (where.status === 'CLOSED') return Promise.resolve([excluded]);
        return Promise.resolve([]);
      });

    const service = new TradesService(tradesRepository, makeRepo([]), { emit: jest.fn() } as any);
    const stats = await service.getStats();

    expect(stats.totalTrades).toBe(0);
    expect(stats.recentSignals.some((t: any) => t.id === 'trade-dust')).toBe(true);
  });

  it('activePositions conta todas as posicoes abertas, mesmo marcadas (contagem de inventario, nao de performance)', async () => {
    const openExcluded = makeTrade({ id: 'trade-open', status: 'OPEN', pnl: null, excludeFromStats: true });

    const tradesRepository = makeRepo([]);
    tradesRepository.find = jest.fn()
      .mockImplementation(({ where }: any) => {
        if (where.status === 'OPEN') return Promise.resolve([openExcluded]);
        if (where.status === 'CLOSED') return Promise.resolve([]);
        return Promise.resolve([]);
      });

    const service = new TradesService(tradesRepository, makeRepo([]), { emit: jest.fn() } as any);
    const stats = await service.getStats();

    expect(stats.activePositions).toBe(1);
    expect(stats.unrealizedPnL).toBe(0);
  });
});

describe('TradesService (FASE 7 -- filtro por portfolioId)', () => {
  it('getStats com portfolioId inclui o filtro no where das 3 buscas (OPEN/CLOSED/ERROR)', async () => {
    const tradesRepository = makeRepo([]);
    tradesRepository.find = jest.fn().mockResolvedValue([]);

    const service = new TradesService(tradesRepository, makeRepo([]), { emit: jest.fn() } as any);
    await service.getStats('portfolio-1');

    const wheres = tradesRepository.find.mock.calls.map((call: any) => call[0].where);
    expect(wheres).toEqual([
      { status: 'OPEN', portfolioId: 'portfolio-1' },
      { status: 'CLOSED', portfolioId: 'portfolio-1' },
      { status: 'ERROR', portfolioId: 'portfolio-1' },
    ]);
  });

  it('getStats sem portfolioId nao filtra (comportamento atual preservado)', async () => {
    const tradesRepository = makeRepo([]);
    tradesRepository.find = jest.fn().mockResolvedValue([]);

    const service = new TradesService(tradesRepository, makeRepo([]), { emit: jest.fn() } as any);
    await service.getStats();

    const wheres = tradesRepository.find.mock.calls.map((call: any) => call[0].where);
    expect(wheres).toEqual([{ status: 'OPEN' }, { status: 'CLOSED' }, { status: 'ERROR' }]);
  });

  it('findAll com portfolioId filtra por status e portfolioId juntos', async () => {
    const tradesRepository = makeRepo([]);
    tradesRepository.find = jest.fn().mockResolvedValue([]);

    const service = new TradesService(tradesRepository, makeRepo([]), { emit: jest.fn() } as any);
    await service.findAll('OPEN', 50, 'portfolio-1');

    expect(tradesRepository.find.mock.calls[0][0].where).toEqual({ status: 'OPEN', portfolioId: 'portfolio-1' });
  });

  it('findOpenTrades com portfolioId filtra somente as posicoes daquele portfolio', async () => {
    const tradesRepository = makeRepo([]);
    tradesRepository.find = jest.fn().mockResolvedValue([]);

    const service = new TradesService(tradesRepository, makeRepo([]), { emit: jest.fn() } as any);
    await service.findOpenTrades('portfolio-1');

    expect(tradesRepository.find.mock.calls[0][0].where).toEqual({ status: 'OPEN', portfolioId: 'portfolio-1' });
  });
});
