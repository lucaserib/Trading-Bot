import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PerformanceService } from './performance.service';
import { Trade } from '../strategies/trade.entity';

function makeTrade(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trade-1',
    status: 'CLOSED',
    pnl: 0,
    excludeFromStats: false,
    portfolioId: null,
    closedAt: new Date('2026-08-19T05:00:00Z'),
    ...overrides,
  };
}

describe('PerformanceService', () => {
  let service: PerformanceService;
  let tradeRepository: { find: jest.Mock };

  beforeEach(async () => {
    tradeRepository = { find: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [PerformanceService, { provide: getRepositoryToken(Trade), useValue: tradeRepository }],
    }).compile();

    service = module.get<PerformanceService>(PerformanceService);
  });

  it('agrupa por dia e calcula acumulado corretamente', async () => {
    tradeRepository.find.mockResolvedValue([
      makeTrade({ id: 't1', pnl: 10, closedAt: new Date('2026-08-19T05:00:00Z') }),
      makeTrade({ id: 't2', pnl: -3, closedAt: new Date('2026-08-19T20:00:00Z') }),
      makeTrade({ id: 't3', pnl: 5, closedAt: new Date('2026-08-20T05:00:00Z') }),
    ]);

    const result = await service.getPerformance({ period: 'all' });

    expect(result.daily).toEqual([
      { date: '2026-08-19', spot: 0, futures: 7, total: 7, cumulative: 7 },
      { date: '2026-08-20', spot: 0, futures: 5, total: 5, cumulative: 12 },
    ]);
    expect(result.totalPnl).toBe(12);
  });

  it('exclui trades com excludeFromStats = true do calculo (senao o desempenho nasce inflado)', async () => {
    tradeRepository.find.mockResolvedValue([]);
    await service.getPerformance({ period: 'all' });

    expect(tradeRepository.find.mock.calls[0][0].where).toMatchObject({ status: 'CLOSED', excludeFromStats: false });
  });

  it('filtra por portfolioId quando informado', async () => {
    await service.getPerformance({ portfolioId: 'p1', period: 'all' });

    expect(tradeRepository.find.mock.calls[0][0].where).toMatchObject({ portfolioId: 'p1' });
  });

  it('sem portfolioId nao filtra (todos os portfolios)', async () => {
    await service.getPerformance({ period: 'all' });

    expect(tradeRepository.find.mock.calls[0][0].where).not.toHaveProperty('portfolioId');
  });

  it('periodo diferente de "all" aplica filtro de data closedAt', async () => {
    await service.getPerformance({ period: '7d' });

    expect(tradeRepository.find.mock.calls[0][0].where).toHaveProperty('closedAt');
  });

  it('periodo "all" nao aplica filtro de data', async () => {
    await service.getPerformance({ period: 'all' });

    expect(tradeRepository.find.mock.calls[0][0].where).not.toHaveProperty('closedAt');
  });

  it('sem trades, retorna serie vazia e totalPnl zero', async () => {
    const result = await service.getPerformance({ period: '30d' });

    expect(result.daily).toEqual([]);
    expect(result.totalPnl).toBe(0);
  });
});
