import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { AuditorService, ReconciliationResult } from './auditor.service';
import { AuditCategory, AuditSeverity } from './audit-log.entity';

interface BacktestTradeDto {
  side: string;
  entry_price: number;
  exit_price: number;
  entry_time: string;
  exit_time: string;
  exit_reason: string;
  size_usd: number;
  leverage: number;
  fee_usd: number;
  entry_fee_usd?: number;
  exit_fee_usd?: number;
  pnl_usd: number;
  pnl_pct: number;
  balance_after: number;
}

interface CompareBacktestDto {
  strategyId: string;
  backtestTrades: BacktestTradeDto[];
  from?: string;
  to?: string;
}

interface AuditBacktestDto {
  trades: BacktestTradeDto[];
  stats?: {
    total_pnl_usd?: number;
    win_rate?: number;
    max_drawdown_pct?: number;
    total_trades?: number;
    total_fees?: number;
  };
  strategy?: Record<string, unknown>;
  intrabar?: {
    lower_tf?: string;
    requested?: number;
    resolved?: number;
  };
}

@Controller('auditor')
export class AuditorController {
  constructor(private readonly auditorService: AuditorService) {}

  @Post('reconcile/trade/:tradeId')
  async reconcileTrade(@Param('tradeId') tradeId: string): Promise<ReconciliationResult> {
    return this.auditorService.reconcileTrade(tradeId);
  }

  @Post('reconcile/strategy/:strategyId')
  async reconcileStrategy(
    @Param('strategyId') strategyId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<Record<string, unknown>> {
    return this.auditorService.reconcileStrategy(
      strategyId,
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
    );
  }

  @Post('backfill/trade/:tradeId')
  async backfillTrade(@Param('tradeId') tradeId: string) {
    return this.auditorService.backfillTrade(tradeId);
  }

  @Post('dedupe/strategy/:strategyId')
  async dedupeStrategy(
    @Param('strategyId') strategyId: string,
    @Query('dryRun') dryRun?: string,
  ) {
    const isDryRun = dryRun !== 'false' && dryRun !== '0';
    return this.auditorService.dedupeStrategy(strategyId, isDryRun);
  }

  @Post('compare-backtest')
  async compareBacktest(@Body() body: CompareBacktestDto) {
    return this.auditorService.compareBacktestVsBot(
      body.strategyId,
      body.backtestTrades,
      body.from ? new Date(body.from) : undefined,
      body.to ? new Date(body.to) : undefined,
    );
  }

  @Post('audit-backtest')
  auditBacktest(@Body() body: AuditBacktestDto) {
    return this.auditorService.auditBacktestData(body.trades, body.stats, body.strategy, body.intrabar);
  }

  @Get('health')
  async getHealth() {
    return this.auditorService.getHealth();
  }

  @Get('logs')
  async getLogs(
    @Query('tradeId') tradeId?: string,
    @Query('strategyId') strategyId?: string,
    @Query('category') category?: AuditCategory,
    @Query('severity') severity?: AuditSeverity,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.auditorService.getAuditLogs({
      tradeId,
      strategyId,
      category,
      severity,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit: limit ? parseInt(limit) : undefined,
    });
  }

  @Get('summary')
  async getSummary(@Query('strategyId') strategyId?: string) {
    return this.auditorService.getAuditSummary(strategyId);
  }

  @Get('alerts')
  async getAlerts(@Query('portfolioId') portfolioId?: string) {
    return this.auditorService.getAlerts(portfolioId);
  }
}
