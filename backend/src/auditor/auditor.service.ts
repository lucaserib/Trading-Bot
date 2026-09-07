import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, In } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuditLog, AuditCategory, AuditSeverity } from './audit-log.entity';
import { computePercentMismatch } from './percent-mismatch.util';
import { findDuplicatePositionGroups, planDedupe, DedupePlanItem, DuplicatePositionGroup } from './duplicate-position.util';
import { parseTrackedTpOrders, computeExpectedTpLevels, countLiveTrackedOrders } from './missing-tp-orders.util';
import { buildEnabledTpConfigs } from '../webhook/tp-planner.util';
import { parseFallbackCloseDetailTarget, computeTargetVsExecutedDiffPct } from '../take-profit/take-profit-fallback.util';
import { Trade } from '../strategies/trade.entity';
import { TradeExecution, ExecutionType } from '../trades/trade-execution.entity';
import { Strategy } from '../strategies/strategy.entity';
import { ExchangeService } from '../exchange/exchange.service';
import { EncryptionUtil } from '../utils/encryption.util';
import { CredentialsResolverService } from '../common/credentials-resolver.service';
import Decimal from 'decimal.js';
import type { Exchange } from 'ccxt';

interface ExchangeOrder {
  orderId: string;
  price: number;
  avgPrice: number;
  executedQty: number;
  commission: number;
  commissionAsset: string;
  status: string;
  time: number;
}

export interface ReconciliationResult {
  tradeId: string;
  issues: AuditLog[];
  exchangeData: ExchangeOrder | null;
  botData: {
    entryPrice: number;
    exitPrice: number | null;
    quantity: number;
    pnl: number | null;
  };
  calculatedPnl: number | null;
  feesFromExchange: number;
  feesFromBot: number;
  fundingFees: number;
  slippage: number | null;
  signalLatencyMs: number | null;
}

@Injectable()
export class AuditorService {
  private readonly logger = new Logger(AuditorService.name);

  constructor(
    @InjectRepository(AuditLog)
    private auditRepo: Repository<AuditLog>,
    @InjectRepository(Trade)
    private tradeRepo: Repository<Trade>,
    @InjectRepository(TradeExecution)
    private execRepo: Repository<TradeExecution>,
    @InjectRepository(Strategy)
    private strategyRepo: Repository<Strategy>,
    private exchangeService: ExchangeService,
    private credentialsResolver: CredentialsResolverService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async runPeriodicAudit() {
    this.logger.log('Running periodic audit...');
    const oneHourAgo = new Date(Date.now() - 3600000);
    const recentTrades = await this.tradeRepo.find({
      where: { status: 'CLOSED', closedAt: Between(oneHourAgo, new Date()) },
    });

    for (const trade of recentTrades) {
      await this.reconcileTrade(trade.id);
    }

    const openTrades = await this.tradeRepo.find({ where: { status: 'OPEN' } });
    const strategyIds = [...new Set(openTrades.map(t => t.strategyId))];
    for (const strategyId of strategyIds) {
      try {
        await this.detectMissingTpOrders(strategyId);
      } catch (err) {
        this.logger.warn(`[MISSING_TP_ORDERS] Failed for strategy ${strategyId}: ${err}`);
      }
    }
  }

  async reconcileTrade(tradeId: string): Promise<ReconciliationResult> {
    const trade = await this.tradeRepo.findOne({ where: { id: tradeId } });
    if (!trade) throw new Error(`Trade ${tradeId} not found`);

    const strategy = await this.strategyRepo
      .createQueryBuilder('strategy')
      .addSelect(['strategy.apiKey', 'strategy.apiSecret'])
      .where('strategy.id = :id', { id: trade.strategyId })
      .getOne();
    if (!strategy) throw new Error(`Strategy ${trade.strategyId} not found`);
    const credentials = await this.credentialsResolver.resolveCredentials(strategy);
    const resolvedStrategy = { ...strategy, ...credentials };

    const executions = await this.execRepo.find({
      where: { tradeId },
      order: { executedAt: 'ASC' },
    });
    const issues: AuditLog[] = [];
    let totalFeesFromExchange = 0;

    const entryOrder = await this.safelyFetchOrder(resolvedStrategy, trade.symbol, trade.exchangeOrderId);
    if (entryOrder) {
      totalFeesFromExchange += entryOrder.commission;

      const botEntry = new Decimal(trade.entryPrice);
      const exchEntry = new Decimal(entryOrder.avgPrice);
      const slippagePct = botEntry.minus(exchEntry).div(exchEntry).abs().times(100);
      const slippageVal = slippagePct.toNumber();

      if (slippagePct.gt(0.01)) {
        issues.push(this.createLog(trade, AuditCategory.PRICE_DEVIATION,
          slippageVal > 0.5 ? AuditSeverity.ERROR : AuditSeverity.WARNING,
          `Entrada: bot registrou $${botEntry.toFixed(8)}, exchange executou $${exchEntry.toFixed(8)} (desvio ${slippagePct.toFixed(4)}%)`,
          { botPrice: trade.entryPrice, exchangePrice: entryOrder.avgPrice, orderId: entryOrder.orderId },
          entryOrder.avgPrice, Number(trade.entryPrice), slippageVal,
        ));
      }

      if (entryOrder.status !== 'closed' && entryOrder.status !== 'FILLED') {
        issues.push(this.createLog(trade, AuditCategory.MISSED_FILL,
          AuditSeverity.ERROR,
          `Ordem de entrada nao preenchida: status=${entryOrder.status}, qty executada=${entryOrder.executedQty}`,
          { orderId: entryOrder.orderId, status: entryOrder.status, filled: entryOrder.executedQty },
        ));
      }
    } else if (trade.exchangeOrderId) {
      issues.push(this.createLog(trade, AuditCategory.ORDER_REJECTED,
        AuditSeverity.WARNING,
        `Ordem de entrada ${trade.exchangeOrderId} nao encontrada na exchange`,
        { orderId: trade.exchangeOrderId },
      ));
    }

    const slOrder = await this.safelyFetchOrder(resolvedStrategy, trade.symbol, trade.stopLossOrderId);
    if (slOrder) {
      totalFeesFromExchange += slOrder.commission;
      if (trade.closeReason === 'STOP_LOSS' && trade.exitPrice) {
        const botExit = new Decimal(trade.exitPrice);
        const exchExit = new Decimal(slOrder.avgPrice);
        const slSlippage = botExit.minus(exchExit).div(exchExit).abs().times(100);
        if (slSlippage.gt(0.05)) {
          issues.push(this.createLog(trade, AuditCategory.SLIPPAGE,
            slSlippage.gt(0.5) ? AuditSeverity.ERROR : AuditSeverity.WARNING,
            `Stop Loss slippage: bot=$${botExit.toFixed(8)}, exchange=$${exchExit.toFixed(8)} (${slSlippage.toFixed(4)}%)`,
            { botPrice: Number(trade.exitPrice), exchangePrice: slOrder.avgPrice, orderId: slOrder.orderId },
            Number(trade.exitPrice), slOrder.avgPrice, slSlippage.toNumber(),
          ));
        }
      }
    } else if (trade.stopLossOrderId) {
      issues.push(this.createLog(trade, AuditCategory.ORDER_REJECTED,
        AuditSeverity.WARNING,
        `Ordem de stop loss ${trade.stopLossOrderId} nao encontrada na exchange`,
        { orderId: trade.stopLossOrderId },
      ));
    }

    for (const exec of executions) {
      if (exec.type === 'ENTRY') continue;
      if (!exec.exchangeOrderId) continue;
      const execOrder = await this.safelyFetchOrder(resolvedStrategy, trade.symbol, exec.exchangeOrderId);
      if (execOrder) {
        totalFeesFromExchange += execOrder.commission;
        const botPrice = new Decimal(exec.price);
        const exchPrice = new Decimal(execOrder.avgPrice);
        const deviation = botPrice.minus(exchPrice).div(exchPrice).abs().times(100);
        if (deviation.gt(0.05)) {
          issues.push(this.createLog(trade, AuditCategory.SLIPPAGE,
            deviation.gt(0.5) ? AuditSeverity.ERROR : AuditSeverity.WARNING,
            `${exec.type} slippage: bot=$${botPrice.toFixed(8)}, exchange=$${exchPrice.toFixed(8)} (${deviation.toFixed(4)}%)`,
            { type: exec.type, botPrice: Number(exec.price), exchangePrice: execOrder.avgPrice, orderId: execOrder.orderId },
            Number(exec.price), execOrder.avgPrice, deviation.toNumber(),
          ));
        }
        if (exec.type.startsWith('TAKE_PROFIT') && execOrder.executedQty > 0) {
          const expectedQty = exec.quantity;
          const filledQty = execOrder.executedQty;
          const qtyDev = Math.abs(Number(expectedQty) - filledQty) / Number(expectedQty) * 100;
          if (qtyDev > 1) {
            issues.push(this.createLog(trade, AuditCategory.MISSED_FILL,
              qtyDev > 10 ? AuditSeverity.ERROR : AuditSeverity.WARNING,
              `${exec.type} fill parcial: esperado ${expectedQty}, executado ${filledQty} (${qtyDev.toFixed(1)}% diferenca)`,
              { type: exec.type, expected: Number(expectedQty), filled: filledQty },
              Number(expectedQty), filledQty, qtyDev,
            ));
          }
        }
      }
    }

    if (totalFeesFromExchange > 0) {
      issues.push(this.createLog(trade, AuditCategory.FEE_MISMATCH,
        AuditSeverity.WARNING,
        `Taxas da exchange: $${totalFeesFromExchange.toFixed(4)} (bot P&L nao desconta taxas)`,
        { totalExchangeFees: totalFeesFromExchange, botPnl: trade.pnl },
        0, totalFeesFromExchange, totalFeesFromExchange,
      ));
    }

    const fundingFees = trade.status === 'CLOSED'
      ? await this.safelyFetchFunding(resolvedStrategy, trade)
      : 0;

    let calculatedPnl: number | null = null;
    const useQty = trade.initialQuantity ?? trade.quantity;
    if (trade.status === 'CLOSED' && trade.exitPrice && trade.entryPrice) {
      const entry = new Decimal(trade.entryPrice);
      const exit = new Decimal(trade.exitPrice);
      const qty = new Decimal(useQty);
      const direction = trade.side === 'BUY' ? 1 : -1;

      calculatedPnl = exit.minus(entry).times(qty).times(direction).toNumber();

      if (executions.length > 1) {
        const execPnlSum = executions
          .filter(e => e.pnl !== null)
          .reduce((s, e) => s + Number(e.pnl), 0);
        if (execPnlSum !== 0 && trade.pnl !== null) {
          const execDiff = Math.abs(execPnlSum - Number(trade.pnl));
          if (execDiff > 0.01) {
            issues.push(this.createLog(trade, AuditCategory.PNL_MISMATCH,
              execDiff > 1 ? AuditSeverity.ERROR : AuditSeverity.WARNING,
              `Soma dos PnL das execucoes ($${execPnlSum.toFixed(4)}) difere do PnL do trade ($${Number(trade.pnl).toFixed(4)}), diff=$${execDiff.toFixed(4)}`,
              { execPnlSum, tradePnl: Number(trade.pnl), executionCount: executions.length },
              execPnlSum, Number(trade.pnl), execDiff,
            ));
          }
        }
      }

      const adjustedPnl = calculatedPnl - totalFeesFromExchange + fundingFees;
      if (trade.pnl !== null) {
        const botPnl = new Decimal(trade.pnl);
        const diff = botPnl.minus(adjustedPnl).abs();
        if (diff.gt(0.01)) {
          issues.push(this.createLog(trade, AuditCategory.PNL_MISMATCH,
            diff.gt(1) ? AuditSeverity.ERROR : AuditSeverity.WARNING,
            `PnL: bot=$${botPnl.toFixed(4)}, calculado=(${exit.toFixed(4)}-${entry.toFixed(4)})×${qty.toFixed(6)}×${direction}-taxas$${totalFeesFromExchange.toFixed(4)}+funding$${fundingFees.toFixed(4)}=$${new Decimal(adjustedPnl).toFixed(4)}, diff=$${diff.toFixed(4)}`,
            {
              botPnl: Number(trade.pnl), calculatedGross: calculatedPnl,
              calculatedNet: adjustedPnl, fees: totalFeesFromExchange,
              fundingFees,
              entry: Number(trade.entryPrice), exit: Number(trade.exitPrice),
              qty: Number(useQty), side: trade.side,
            },
            adjustedPnl, Number(trade.pnl), diff.toNumber(),
          ));
        }
      }
    }

    const entryExec = executions.find(e => e.type === 'ENTRY');
    let signalLatencyMs: number | null = null;
    if (entryExec && trade.timestamp) {
      signalLatencyMs = new Date(entryExec.executedAt).getTime() - new Date(trade.timestamp).getTime();
      if (signalLatencyMs > 5000) {
        issues.push(this.createLog(trade, AuditCategory.SIGNAL_LATENCY,
          signalLatencyMs > 30000 ? AuditSeverity.ERROR : AuditSeverity.WARNING,
          `Latencia do sinal: ${signalLatencyMs}ms (webhook→execucao)`,
          { webhookTime: trade.timestamp, executionTime: entryExec.executedAt },
          0, signalLatencyMs, signalLatencyMs,
        ));
      }
    }

    if (trade.status === 'CLOSED' && !trade.exitPrice) {
      issues.push(this.createLog(trade, AuditCategory.PNL_MISMATCH,
        AuditSeverity.ERROR,
        `Trade fechado sem preco de saida registrado`,
        { status: trade.status, closeReason: trade.closeReason },
      ));
    }

    if (trade.status === 'CLOSED' && trade.exitPrice && trade.entryPrice) {
      const percentMismatch = computePercentMismatch({
        entryPrice: Number(trade.entryPrice),
        exitPrice: Number(trade.exitPrice),
        closeReason: trade.closeReason,
        closeDetail: trade.closeDetail,
        stopLossPercentage: resolvedStrategy.stopLossPercentage ? Number(resolvedStrategy.stopLossPercentage) : null,
        takeProfitPercentage1: resolvedStrategy.takeProfitPercentage1 ? Number(resolvedStrategy.takeProfitPercentage1) : null,
        takeProfitPercentage2: resolvedStrategy.takeProfitPercentage2 ? Number(resolvedStrategy.takeProfitPercentage2) : null,
        takeProfitPercentage3: resolvedStrategy.takeProfitPercentage3 ? Number(resolvedStrategy.takeProfitPercentage3) : null,
      });

      if (percentMismatch) {
        issues.push(this.createLog(trade,
          percentMismatch.category === 'TP_PERCENT_MISMATCH' ? AuditCategory.TP_PERCENT_MISMATCH : AuditCategory.SL_PERCENT_MISMATCH,
          percentMismatch.severity === 'ERROR' ? AuditSeverity.ERROR : AuditSeverity.WARNING,
          `${trade.closeReason} efetivo ${percentMismatch.effectivePercent.toFixed(4)}% difere do configurado ${percentMismatch.configuredPercent.toFixed(4)}% (diff ${percentMismatch.deviation.toFixed(4)} p.p.)`,
          {
            configuredPercent: percentMismatch.configuredPercent,
            effectivePercent: percentMismatch.effectivePercent,
            entryPrice: Number(trade.entryPrice),
            exitPrice: Number(trade.exitPrice),
          },
          percentMismatch.configuredPercent, percentMismatch.effectivePercent, percentMismatch.deviation,
        ));
      }
    }

    if (trade.status === 'CLOSED' && trade.closeReason === 'TAKE_PROFIT_FALLBACK_MARKET' && trade.exitPrice) {
      const targetPrice = parseFallbackCloseDetailTarget(trade.closeDetail);
      const executedPrice = Number(trade.exitPrice);
      const diffPct = targetPrice != null ? computeTargetVsExecutedDiffPct(targetPrice, executedPrice) : null;

      issues.push(this.createLog(trade,
        AuditCategory.TP_EXECUTED_AT_MARKET,
        AuditSeverity.WARNING,
        targetPrice != null
          ? `TP executado a mercado (fallback), nao no alvo LIMIT: alvo ${targetPrice} x executado ${executedPrice} (diff ${diffPct!.toFixed(4)}%)`
          : `TP executado a mercado (fallback), nao no alvo LIMIT: executado ${executedPrice}`,
        { targetPrice, executedPrice, diffPct },
        targetPrice ?? undefined, executedPrice, diffPct ?? undefined,
      ));
    }

    if (trade.status === 'ERROR' && trade.error) {
      issues.push(this.createLog(trade, AuditCategory.ORDER_REJECTED,
        AuditSeverity.ERROR,
        `Trade com erro: ${trade.error}`,
        { error: trade.error, status: trade.status },
      ));
    }

    if (issues.length > 0) {
      await this.auditRepo.save(issues);
    }

    return {
      tradeId,
      issues,
      exchangeData: entryOrder,
      botData: {
        entryPrice: Number(trade.entryPrice),
        exitPrice: trade.exitPrice ? Number(trade.exitPrice) : null,
        quantity: Number(useQty),
        pnl: trade.pnl ? Number(trade.pnl) : null,
      },
      calculatedPnl,
      feesFromExchange: totalFeesFromExchange,
      feesFromBot: 0,
      fundingFees,
      slippage: entryOrder
        ? new Decimal(trade.entryPrice).minus(entryOrder.avgPrice).abs().div(entryOrder.avgPrice).times(100).toNumber()
        : null,
      signalLatencyMs,
    };
  }

  async reconcileStrategy(strategyId: string, from?: Date, to?: Date) {
    const where: Record<string, unknown> = { strategyId, status: 'CLOSED' };
    if (from && to) {
      where.closedAt = Between(from, to);
    }

    const trades = await this.tradeRepo.find({ where: where as any });
    const results: ReconciliationResult[] = [];

    for (const trade of trades) {
      try {
        const result = await this.reconcileTrade(trade.id);
        results.push(result);
      } catch (err) {
        this.logger.warn(`Reconcile failed for trade ${trade.id}: ${err}`);
      }
    }

    const duplicatePositionIssues = await this.detectDuplicatePositions(strategyId);
    const missingTpOrderIssues = await this.detectMissingTpOrders(strategyId);

    const totalIssues = results.reduce((sum, r) => sum + r.issues.length, 0) + duplicatePositionIssues.length + missingTpOrderIssues.length;
    const totalFeesExchange = results.reduce((sum, r) => sum + r.feesFromExchange, 0);
    const avgSlippage = results
      .filter(r => r.slippage !== null)
      .reduce((sum, r, _, arr) => sum + (r.slippage! / arr.length), 0);
    const avgLatency = results
      .filter(r => r.signalLatencyMs !== null)
      .reduce((sum, r, _, arr) => sum + (r.signalLatencyMs! / arr.length), 0);

    return {
      strategyId,
      tradesAudited: trades.length,
      totalIssues,
      totalFeesNotAccountedFor: totalFeesExchange,
      avgSlippagePct: avgSlippage,
      avgSignalLatencyMs: avgLatency,
      duplicatePositions: duplicatePositionIssues,
      missingTpOrders: missingTpOrderIssues,
      trades: results,
    };
  }

  private async findDuplicatePositionGroupsForStrategy(strategyId: string): Promise<{
    closedTrades: Trade[];
    groups: DuplicatePositionGroup[];
  }> {
    const closedTrades = await this.tradeRepo.find({ where: { strategyId, status: 'CLOSED' } });

    const groups = findDuplicatePositionGroups(closedTrades.map(t => ({
      id: t.id,
      symbol: t.symbol,
      side: t.side,
      entryPrice: Number(t.entryPrice),
      closedAt: t.closedAt as Date,
      pnl: t.pnl !== null ? Number(t.pnl) : null,
    })));

    return { closedTrades, groups };
  }

  async detectDuplicatePositions(strategyId: string): Promise<AuditLog[]> {
    const { closedTrades, groups } = await this.findDuplicatePositionGroupsForStrategy(strategyId);
    const plan = planDedupe(groups);

    const issues: AuditLog[] = [];

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      const anchor = closedTrades.find(t => t.id === plan[i].keepTradeId);
      if (!anchor) continue;

      const totalPnl = group.trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
      const tradesSummary = group.trades
        .map(t => `${t.id.substring(0, 8)} (pnl=${t.pnl !== null ? t.pnl.toFixed(4) : 'null'})`)
        .join(', ');

      issues.push(this.createLog(
        anchor,
        AuditCategory.DUPLICATE_POSITION,
        AuditSeverity.ERROR,
        `Possível posição duplicada em ${anchor.symbol} (${anchor.side}): ${group.trades.length} trades fechados com entrada equivalente dentro de 24h — ${tradesSummary}. PnL somado: $${totalPnl.toFixed(4)}`,
        { tradeIds: group.trades.map(t => t.id), pnls: group.trades.map(t => t.pnl), totalPnl },
      ));
    }

    if (issues.length > 0) {
      await this.auditRepo.save(issues);
    }

    return issues;
  }

  async detectMissingTpOrders(strategyId: string): Promise<AuditLog[]> {
    const strategy = await this.strategyRepo
      .createQueryBuilder('strategy')
      .addSelect(['strategy.apiKey', 'strategy.apiSecret'])
      .where('strategy.id = :id', { id: strategyId })
      .getOne();
    if (!strategy) return [];
    const credentials = await this.credentialsResolver.resolveCredentials(strategy);
    const resolvedStrategy = { ...strategy, ...credentials };
    if (!resolvedStrategy.apiKey || !resolvedStrategy.apiSecret) return [];

    const enabledTpIds = buildEnabledTpConfigs(resolvedStrategy).map(tp => tp.id);
    if (enabledTpIds.length === 0) return [];

    const openTrades = await this.tradeRepo.find({ where: { strategyId, status: 'OPEN' } });
    if (openTrades.length === 0) return [];

    const issues: AuditLog[] = [];

    for (const trade of openTrades) {
      const expectedLevels = computeExpectedTpLevels(enabledTpIds, trade.lastTpLevel || 0);
      if (expectedLevels.length === 0) continue;

      const tracked = parseTrackedTpOrders(trade.takeProfitOrderId).filter(t => expectedLevels.includes(t.level));

      if (tracked.length < expectedLevels.length) {
        issues.push(this.createLog(
          trade,
          AuditCategory.MISSING_TP_ORDERS,
          AuditSeverity.WARNING,
          `Trade ${trade.symbol} (${trade.side}) tem apenas ${tracked.length} ordem(ns) de TP registrada(s), mas a estratégia espera ${expectedLevels.length} ainda pendente(s) (níveis ${expectedLevels.join(', ')}; ${trade.lastTpLevel || 0} já realizado(s)).`,
          { trackedCount: tracked.length, expectedLevels, lastTpLevel: trade.lastTpLevel || 0 },
          expectedLevels.length,
          tracked.length,
          expectedLevels.length - tracked.length,
        ));
        continue;
      }

      try {
        const exchange = await this.getExchangeForStrategy(resolvedStrategy);
        const openOrders = await exchange.fetchOpenOrders(trade.symbol);
        const liveOrderIds = new Set<string>(openOrders.map((o: any) => String(o.id)));
        const liveCount = countLiveTrackedOrders(tracked, liveOrderIds);

        if (liveCount < expectedLevels.length) {
          issues.push(this.createLog(
            trade,
            AuditCategory.MISSING_TP_ORDERS,
            AuditSeverity.WARNING,
            `Trade ${trade.symbol} (${trade.side}) tem ${liveCount} ordem(ns) de TP viva(s) na corretora, mas a estratégia espera ${expectedLevels.length} ainda pendente(s) (níveis ${expectedLevels.join(', ')}; ${trade.lastTpLevel || 0} já realizado(s)).`,
            { liveCount, expectedLevels, lastTpLevel: trade.lastTpLevel || 0, trackedOrderIds: tracked.map(t => t.orderId) },
            expectedLevels.length,
            liveCount,
            expectedLevels.length - liveCount,
          ));
        }
      } catch (err) {
        this.logger.warn(`[MISSING_TP_ORDERS] Could not fetch open orders for trade ${trade.id}: ${err}`);
      }
    }

    if (issues.length > 0) {
      await this.auditRepo.save(issues);
    }

    return issues;
  }

  async dedupeStrategy(strategyId: string, dryRun: boolean): Promise<{
    dryRun: boolean;
    groupsFound: number;
    plan: DedupePlanItem[];
    applied: string[];
  }> {
    const { closedTrades, groups } = await this.findDuplicatePositionGroupsForStrategy(strategyId);
    const plan = planDedupe(groups);

    if (dryRun) {
      return { dryRun: true, groupsFound: groups.length, plan, applied: [] };
    }

    const applied: string[] = [];
    const logs: AuditLog[] = [];

    for (const item of plan) {
      for (const tradeId of item.markTradeIds) {
        const trade = closedTrades.find(t => t.id === tradeId);
        if (!trade || trade.excludeFromStats) continue;

        await this.tradeRepo.update(tradeId, { excludeFromStats: true });
        applied.push(tradeId);

        logs.push(this.createLog(
          trade,
          AuditCategory.DUPLICATE_POSITION,
          AuditSeverity.INFO,
          `Trade marcado excludeFromStats=true via dedupe manual (trade mantido: ${item.keepTradeId})`,
          { keepTradeId: item.keepTradeId, groupTradeIds: item.groupTradeIds },
        ));
      }
    }

    if (logs.length > 0) {
      await this.auditRepo.save(logs);
    }

    return { dryRun: false, groupsFound: groups.length, plan, applied };
  }

  async getAuditLogs(filters: {
    tradeId?: string;
    strategyId?: string;
    category?: AuditCategory;
    severity?: AuditSeverity;
    from?: Date;
    to?: Date;
    limit?: number;
  }) {
    const qb = this.auditRepo.createQueryBuilder('log');

    if (filters.tradeId) qb.andWhere('log.tradeId = :tradeId', { tradeId: filters.tradeId });
    if (filters.strategyId) qb.andWhere('log.strategyId = :strategyId', { strategyId: filters.strategyId });
    if (filters.category) qb.andWhere('log.category = :category', { category: filters.category });
    if (filters.severity) qb.andWhere('log.severity = :severity', { severity: filters.severity });
    if (filters.from) qb.andWhere('log.createdAt >= :from', { from: filters.from });
    if (filters.to) qb.andWhere('log.createdAt <= :to', { to: filters.to });

    qb.orderBy('log.createdAt', 'DESC');
    qb.take(filters.limit || 100);

    return qb.getMany();
  }

  async getAuditSummary(strategyId?: string) {
    const qb = this.auditRepo.createQueryBuilder('log');
    if (strategyId) qb.where('log.strategyId = :strategyId', { strategyId });

    const total = await qb.getCount();

    const bySeverity = await this.auditRepo
      .createQueryBuilder('log')
      .select('log.severity', 'severity')
      .addSelect('COUNT(*)', 'count')
      .where(strategyId ? 'log.strategyId = :strategyId' : '1=1', { strategyId })
      .groupBy('log.severity')
      .getRawMany();

    const byCategory = await this.auditRepo
      .createQueryBuilder('log')
      .select('log.category', 'category')
      .addSelect('COUNT(*)', 'count')
      .where(strategyId ? 'log.strategyId = :strategyId' : '1=1', { strategyId })
      .groupBy('log.category')
      .getRawMany();

    return { total, bySeverity, byCategory };
  }

  async getAlerts(portfolioId?: string) {
    let strategyIds: string[] | null = null;
    if (portfolioId) {
      const strategies = await this.strategyRepo.find({ where: { portfolioId } as any, select: ['id'] });
      strategyIds = strategies.map((s) => s.id);
    }

    const auditIssues = await this.auditRepo.find({
      where: strategyIds
        ? [
            { severity: AuditSeverity.ERROR, strategyId: In(strategyIds) },
            { severity: AuditSeverity.WARNING, strategyId: In(strategyIds) },
          ]
        : [{ severity: AuditSeverity.ERROR }, { severity: AuditSeverity.WARNING }],
      order: { createdAt: 'DESC' },
      take: 50,
    });

    const errorTradesWhere: any = { status: 'ERROR' };
    if (portfolioId) errorTradesWhere.portfolioId = portfolioId;
    const errorTrades = await this.tradeRepo.find({ where: errorTradesWhere, order: { timestamp: 'DESC' }, take: 50 });

    const openTradesWhere: any = { status: 'OPEN' };
    if (portfolioId) openTradesWhere.portfolioId = portfolioId;
    const openTrades = await this.tradeRepo.find({ where: openTradesWhere, order: { timestamp: 'DESC' } });
    const tpWarningTrades = openTrades.filter((t) => !!t.tpWarnings);
    const unprotectedTrades = openTrades.filter((t) => !t.stopLossOrderId || !t.takeProfitOrderId);

    const pausedStrategiesWhere: any = { pauseNewOrders: true };
    if (portfolioId) pausedStrategiesWhere.portfolioId = portfolioId;
    const pausedStrategies = await this.strategyRepo.find({
      where: pausedStrategiesWhere,
      select: ['id', 'name', 'portfolioId'],
    });

    return {
      auditIssues,
      errorTrades,
      tpWarningTrades,
      unprotectedTrades,
      pausedStrategies,
    };
  }

  async compareBacktestVsBot(
    strategyId: string,
    backtestTrades: Array<{
      side: string;
      entry_price: number;
      exit_price: number;
      entry_time: string;
      exit_time: string;
      exit_reason: string;
      size_usd: number;
      leverage: number;
      fee_usd: number;
      pnl_usd: number;
    }>,
    from?: Date,
    to?: Date,
  ) {
    const where: Record<string, unknown> = { strategyId, status: 'CLOSED', excludeFromStats: false };
    if (from && to) where.closedAt = Between(from, to);

    const botTrades = await this.tradeRepo.find({
      where: where as any,
      order: { timestamp: 'ASC' },
    });

    const matched: Array<{
      backtestTrade: (typeof backtestTrades)[0];
      botTrade: Trade | null;
      issues: string[];
    }> = [];

    const unmatched: Array<{ source: 'backtest' | 'bot'; trade: unknown }> = [];
    const usedBotIds = new Set<string>();

    for (const bt of backtestTrades) {
      const btEntry = new Date(bt.entry_time).getTime();
      const btSide = bt.side.toUpperCase();

      const match = botTrades.find(bot => {
        if (usedBotIds.has(bot.id)) return false;
        const botSide = bot.side === 'BUY' ? 'LONG' : 'SHORT';
        if (btSide !== botSide) return false;
        const botEntry = new Date(bot.timestamp).getTime();
        const timeDiff = Math.abs(btEntry - botEntry);
        return timeDiff < 300000;
      });

      if (match) {
        usedBotIds.add(match.id);
        const issues: string[] = [];

        const entryDev = Math.abs(bt.entry_price - Number(match.entryPrice)) / bt.entry_price * 100;
        if (entryDev > 0.05) {
          issues.push(`Entry price deviation: ${entryDev.toFixed(4)}% (backtest=${bt.entry_price} bot=${match.entryPrice})`);
        }

        if (bt.exit_price && match.exitPrice) {
          const exitDev = Math.abs(bt.exit_price - Number(match.exitPrice)) / bt.exit_price * 100;
          if (exitDev > 0.05) {
            issues.push(`Exit price deviation: ${exitDev.toFixed(4)}% (backtest=${bt.exit_price} bot=${match.exitPrice})`);
          }
        }

        if (match.pnl !== null) {
          const pnlDiff = Math.abs(bt.pnl_usd - Number(match.pnl));
          if (pnlDiff > 0.5) {
            issues.push(`P&L mismatch: backtest=${bt.pnl_usd.toFixed(4)} bot=${Number(match.pnl).toFixed(4)} diff=${pnlDiff.toFixed(4)}`);
          }
        }

        if (bt.fee_usd > 0 && match.pnl !== null) {
          issues.push(`Backtest accounted ${bt.fee_usd.toFixed(4)} in fees; bot P&L does not deduct fees`);
        }

        matched.push({ backtestTrade: bt, botTrade: match, issues });
      } else {
        unmatched.push({ source: 'backtest', trade: bt });
      }
    }

    for (const bot of botTrades) {
      if (!usedBotIds.has(bot.id)) {
        unmatched.push({ source: 'bot', trade: bot });
      }
    }

    const totalMatched = matched.length;
    const withIssues = matched.filter(m => m.issues.length > 0).length;
    const btPnl = backtestTrades.reduce((s, t) => s + t.pnl_usd, 0);
    const botPnl = botTrades.reduce((s, t) => s + (Number(t.pnl) || 0), 0);

    return {
      strategyId,
      backtestTrades: backtestTrades.length,
      botTrades: botTrades.length,
      matched: totalMatched,
      unmatched: unmatched.length,
      tradesWithIssues: withIssues,
      backtestTotalPnl: btPnl,
      botTotalPnl: botPnl,
      pnlDifference: btPnl - botPnl,
      details: matched,
      unmatchedTrades: unmatched,
    };
  }

  auditBacktestData(
    trades: Array<{
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
    }>,
    stats?: {
      total_pnl_usd?: number;
      win_rate?: number;
      max_drawdown_pct?: number;
      total_trades?: number;
      total_fees?: number;
    },
    strategyConfig?: Record<string, unknown>,
    intrabar?: { lower_tf?: string; requested?: number; resolved?: number },
  ) {
    const TOLERANCE = 0.01;
    const issues: Array<{
      type: string;
      severity: string;
      message: string;
      tradeIndex?: number;
      expected?: number;
      actual?: number;
      details?: Record<string, unknown>;
    }> = [];

    for (let i = 0; i < trades.length; i++) {
      const t = trades[i];
      const lev = t.leverage || 1;

      const priceChange = t.side === 'LONG'
        ? (t.exit_price - t.entry_price) / t.entry_price
        : (t.entry_price - t.exit_price) / t.entry_price;
      const expectedGross = t.size_usd * priceChange * lev;
      const pnlDiff = Math.abs(expectedGross - t.pnl_usd);
      if (pnlDiff > TOLERANCE) {
        const formula = `${t.side}: (${t.exit_price} - ${t.entry_price}) / ${t.entry_price} × ${t.size_usd} × ${lev}x`;
        issues.push({
          type: 'PNL_MISMATCH',
          severity: pnlDiff > 1 ? 'ERROR' : 'WARNING',
          message: `Trade #${i + 1} ${t.side} ${t.exit_reason}: P&L bruto esperado $${expectedGross.toFixed(4)}, registrado $${t.pnl_usd.toFixed(4)} (diff $${pnlDiff.toFixed(4)}). Formula: ${formula}`,
          tradeIndex: i,
          expected: expectedGross,
          actual: t.pnl_usd,
          details: { formula, entry: t.entry_price, exit: t.exit_price, size: t.size_usd, leverage: lev, priceChangePct: (priceChange * 100).toFixed(4) },
        });
      }

      const entryFee = t.entry_fee_usd || 0;
      const exitFee = t.exit_fee_usd || 0;
      const sumFees = entryFee + exitFee;
      if (entryFee > 0 && exitFee > 0 && Math.abs(sumFees - t.fee_usd) > TOLERANCE) {
        issues.push({
          type: 'FEE_SUM_MISMATCH',
          severity: 'WARNING',
          message: `Trade #${i + 1}: taxa entrada $${entryFee.toFixed(4)} + saida $${exitFee.toFixed(4)} = $${sumFees.toFixed(4)}, total registrado $${t.fee_usd.toFixed(4)} (diff $${Math.abs(sumFees - t.fee_usd).toFixed(4)})`,
          tradeIndex: i,
          expected: sumFees,
          actual: t.fee_usd,
        });
      }

      if (t.fee_usd < 0) {
        issues.push({
          type: 'NEGATIVE_FEE',
          severity: 'ERROR',
          message: `Trade #${i + 1}: taxa negativa $${t.fee_usd.toFixed(4)} (taxas devem ser >= 0)`,
          tradeIndex: i,
          expected: 0,
          actual: t.fee_usd,
        });
      }

      const entryTime = new Date(t.entry_time).getTime();
      const exitTime = new Date(t.exit_time).getTime();
      if (entryTime > exitTime) {
        issues.push({
          type: 'TIME_INCONSISTENCY',
          severity: 'ERROR',
          message: `Trade #${i + 1}: entrada (${t.entry_time}) posterior a saida (${t.exit_time})`,
          tradeIndex: i,
        });
      }

      if (t.entry_price <= 0 || t.exit_price <= 0) {
        issues.push({
          type: 'INVALID_PRICE',
          severity: 'ERROR',
          message: `Trade #${i + 1}: preco invalido — entrada=$${t.entry_price}, saida=$${t.exit_price} (precos devem ser > 0)`,
          tradeIndex: i,
        });
      }

      if (t.size_usd <= 0) {
        issues.push({
          type: 'INVALID_SIZE',
          severity: 'ERROR',
          message: `Trade #${i + 1}: tamanho da posicao invalido $${t.size_usd} (deve ser > 0)`,
          tradeIndex: i,
        });
      }

      if (t.size_usd > 0) {
        const netPnl = t.pnl_usd - (t.fee_usd || 0);
        const expectedPct = (netPnl / t.size_usd) * 100;
        const pctDiff = Math.abs(expectedPct - t.pnl_pct);
        if (pctDiff > 0.05) {
          issues.push({
            type: 'PNL_PCT_MISMATCH',
            severity: 'WARNING',
            message: `Trade #${i + 1}: pnl% esperado ${expectedPct.toFixed(2)}% [(${t.pnl_usd.toFixed(2)} - ${(t.fee_usd||0).toFixed(2)}) / ${t.size_usd.toFixed(2)} × 100], registrado ${t.pnl_pct.toFixed(2)}% (diff ${pctDiff.toFixed(2)}%)`,
            tradeIndex: i,
            expected: expectedPct,
            actual: t.pnl_pct,
          });
        }
      }

      if (i > 0) {
        const prev = trades[i - 1];
        const netPnl = t.pnl_usd - (t.fee_usd || 0);
        const expectedBalance = prev.balance_after + netPnl;
        const balDiff = Math.abs(expectedBalance - t.balance_after);
        if (balDiff > TOLERANCE) {
          issues.push({
            type: 'BALANCE_DISCONTINUITY',
            severity: balDiff > 1 ? 'ERROR' : 'WARNING',
            message: `Trade #${i + 1}: saldo esperado $${expectedBalance.toFixed(2)} [anterior $${prev.balance_after.toFixed(2)} + pnl liquido $${netPnl.toFixed(2)}], registrado $${t.balance_after.toFixed(2)} (diff $${balDiff.toFixed(2)})`,
            tradeIndex: i,
            expected: expectedBalance,
            actual: t.balance_after,
            details: { prevBalance: prev.balance_after, grossPnl: t.pnl_usd, fees: t.fee_usd, netPnl },
          });
        }
      }
    }

    if (stats) {
      const calcTotalPnl = trades.reduce((s, t) => s + (t.pnl_usd - (t.fee_usd || 0)), 0);
      const totalFees = trades.reduce((s, t) => s + (t.fee_usd || 0), 0);
      const totalGross = trades.reduce((s, t) => s + t.pnl_usd, 0);
      const reportedPnl = stats.total_pnl_usd || 0;
      if (Math.abs(calcTotalPnl - reportedPnl) > 0.1) {
        issues.push({
          type: 'STATS_PNL_MISMATCH',
          severity: 'ERROR',
          message: `P&L total: soma bruta $${totalGross.toFixed(2)} - taxas $${totalFees.toFixed(2)} = liquido $${calcTotalPnl.toFixed(2)}, stats reporta $${reportedPnl.toFixed(2)} (diff $${Math.abs(calcTotalPnl - reportedPnl).toFixed(2)})`,
          expected: calcTotalPnl,
          actual: reportedPnl,
          details: { grossTotal: totalGross, feesTotal: totalFees, netTotal: calcTotalPnl },
        });
      }

      const winTrades = trades.filter(t => (t.pnl_usd - (t.fee_usd || 0)) > 0);
      const expectedWinRate = trades.length > 0 ? (winTrades.length / trades.length) * 100 : 0;
      const reportedWinRate = stats.win_rate || 0;
      if (Math.abs(expectedWinRate - reportedWinRate) > 0.5) {
        issues.push({
          type: 'STATS_WINRATE_MISMATCH',
          severity: 'WARNING',
          message: `Win rate: ${winTrades.length}/${trades.length} = ${expectedWinRate.toFixed(1)}%, stats reporta ${reportedWinRate.toFixed(1)}%`,
          expected: expectedWinRate,
          actual: reportedWinRate,
        });
      }
    }

    const errors = issues.filter(i => i.severity === 'ERROR' || i.severity === 'CRITICAL').length;
    const warnings = issues.filter(i => i.severity === 'WARNING').length;

    const tradesSummary = trades.slice(0, 50).map((t, i) =>
      `#${i + 1} ${t.side} entry=$${t.entry_price} exit=$${t.exit_price} pnl_bruto=$${t.pnl_usd.toFixed(2)} taxa=$${(t.fee_usd || 0).toFixed(4)} pnl_liq=$${(t.pnl_usd - (t.fee_usd||0)).toFixed(2)} saldo=$${t.balance_after.toFixed(2)} motivo=${t.exit_reason}`,
    ).join('\n');

    const issuesSummary = issues.map(i =>
      `[${i.severity}] ${i.message}`,
    ).join('\n');

    const cfg = strategyConfig as {
      type?: string; leverage?: number; breakeven?: boolean; breakevenTrigger?: number;
      breakgain?: boolean; trendflip?: boolean; hedge?: boolean; inverted?: boolean;
    } | undefined;
    const configLine = cfg
      ? `\nConfig: type=${cfg.type ?? '?'} lev=${cfg.leverage ?? '?'}x BE=${cfg.breakeven ? `on@TP${cfg.breakevenTrigger ?? 1}` : 'off'} BG=${cfg.breakgain ? 'on' : 'off'} TRENDFLIP=${cfg.trendflip ? 'on' : 'off'} hedge=${cfg.hedge ? 'on' : 'off'} inverted=${cfg.inverted ? 'yes' : 'no'}`
      : '';
    const intrabarLine = intrabar?.lower_tf
      ? `\nIntrabar: ${intrabar.resolved ?? 0}/${intrabar.requested ?? 0} candle(s) ambiguo(s) validados em ${intrabar.lower_tf}`
      : '';

    const aiContext = `BACKTEST AUDIT REPORT
Trades: ${trades.length} | Errors: ${errors} | Warnings: ${warnings}
Win rate: ${stats?.win_rate?.toFixed(1) ?? 'N/A'}% | Total PnL: $${stats?.total_pnl_usd?.toFixed(2) ?? 'N/A'}
Max Drawdown: ${stats?.max_drawdown_pct?.toFixed(1) ?? 'N/A'}%${configLine}${intrabarLine}

ISSUES:
${issuesSummary || 'Nenhum problema encontrado.'}

TRADES (primeiros 50):
${tradesSummary}`;

    return {
      passed: errors === 0,
      totalIssues: issues.length,
      errors,
      warnings,
      issues,
      aiContext,
    };
  }

  async backfillTrade(tradeId: string) {
    const trade = await this.tradeRepo.findOne({ where: { id: tradeId } });
    if (!trade) throw new Error(`Trade ${tradeId} not found`);

    const strategy = await this.strategyRepo
      .createQueryBuilder('strategy')
      .addSelect(['strategy.apiKey', 'strategy.apiSecret'])
      .where('strategy.id = :id', { id: trade.strategyId })
      .getOne();
    if (!strategy) throw new Error(`Strategy ${trade.strategyId} not found`);
    const credentials = await this.credentialsResolver.resolveCredentials(strategy);
    const resolvedStrategy = { ...strategy, ...credentials };

    const closers: Array<{ level: number; order: ExchangeOrder }> = [];
    if (trade.takeProfitOrderId && trade.takeProfitOrderId.includes(':')) {
      for (const e of trade.takeProfitOrderId.split('|')) {
        const [lvlStr, oid] = e.split(':');
        if (!oid) continue;
        const order = await this.safelyFetchOrder(resolvedStrategy, trade.symbol, oid);
        if (order && order.executedQty > 0 && order.avgPrice > 0) closers.push({ level: parseInt(lvlStr) || 0, order });
      }
    }
    if (trade.closeReason === 'STOP_LOSS' && trade.stopLossOrderId) {
      const slOrder = await this.safelyFetchOrder(resolvedStrategy, trade.symbol, trade.stopLossOrderId);
      if (slOrder && slOrder.executedQty > 0 && slOrder.avgPrice > 0) closers.push({ level: 0, order: slOrder });
    }

    if (!closers.length) {
      return { updated: false, reason: 'Nenhuma ordem de fechamento com preenchimento encontrada na corretora.' };
    }

    const entryPrice = Number(trade.entryPrice);
    let qtySum = 0;
    let notional = 0;
    let feeSum = 0;
    let latestTime = 0;
    let netPnl = 0;
    for (const { order } of closers) {
      qtySum += order.executedQty;
      notional += order.avgPrice * order.executedQty;
      feeSum += order.commission || 0;
      latestTime = Math.max(latestTime, order.time || 0);
      const gross = (trade.side === 'BUY' ? order.avgPrice - entryPrice : entryPrice - order.avgPrice) * order.executedQty;
      netPnl += gross - (order.commission || 0);
    }
    const exitPrice = qtySum > 0 ? notional / qtySum : Number(trade.exitPrice);
    const closedAt = latestTime > 0 ? new Date(latestTime) : trade.closedAt;

    const existing = await this.execRepo.find({ where: { tradeId } });
    const haveType = new Set(existing.map(e => e.type));
    const executionsCreated: string[] = [];
    for (const { level, order } of closers) {
      const type = level === 1 ? ExecutionType.TAKE_PROFIT_1
        : level === 2 ? ExecutionType.TAKE_PROFIT_2
        : level === 3 ? ExecutionType.TAKE_PROFIT_3
        : ExecutionType.STOP_LOSS;
      if (haveType.has(type)) continue;
      const gross = (trade.side === 'BUY' ? order.avgPrice - entryPrice : entryPrice - order.avgPrice) * order.executedQty;
      await this.execRepo.save({
        tradeId,
        type,
        price: order.avgPrice,
        quantity: order.executedQty,
        pnl: gross - (order.commission || 0),
        percentOfPosition: null,
        exchangeOrderId: order.orderId,
      } as Partial<TradeExecution>);
      executionsCreated.push(type);
    }

    const before = { exitPrice: trade.exitPrice, pnl: trade.pnl, closedAt: trade.closedAt };
    trade.exitPrice = exitPrice as any;
    trade.pnl = netPnl as any;
    trade.closedAt = closedAt;
    if (closers.length > 1) {
      const when = (closedAt ?? new Date()).toISOString().slice(11, 19);
      trade.closeDetail = `${closers.map(c => (c.level ? `TP${c.level}` : 'SL')).join('+')} @${when}` as any;
    }
    await this.tradeRepo.save(trade);

    const log = this.createLog(
      trade,
      AuditCategory.PNL_MISMATCH,
      AuditSeverity.INFO,
      'Backfill manual: exitPrice/pnl/closedAt corrigidos a partir das ordens reais da corretora.',
      { before, after: { exitPrice, pnl: netPnl, closedAt }, executionsCreated, exchangeFees: feeSum },
      Number(before.pnl) || 0,
      netPnl,
      Math.abs((Number(before.pnl) || 0) - netPnl),
    );
    await this.auditRepo.save(log);

    return { updated: true, before, after: { exitPrice, pnl: netPnl, closedAt }, executionsCreated, exchangeFees: feeSum };
  }

  private async safelyFetchOrder(
    strategy: Strategy,
    symbol: string,
    orderId: string | null,
  ): Promise<ExchangeOrder | null> {
    if (!orderId || !strategy.apiKey || !strategy.apiSecret) return null;
    try {
      return await this.fetchExchangeOrder(strategy, symbol, orderId);
    } catch (err) {
      this.logger.warn(`Could not fetch order ${orderId}: ${err}`);
      return null;
    }
  }

  private async getExchangeForStrategy(strategy: Strategy): Promise<Exchange> {
    const apiKey = await EncryptionUtil.decrypt(strategy.apiKey);
    const apiSecret = await EncryptionUtil.decrypt(strategy.apiSecret);
    const exchangeId = strategy.exchange as 'binance' | 'bybit';
    return this.exchangeService.getExchange(exchangeId, apiKey, apiSecret, !!strategy.isTestnet);
  }

  private async fetchExchangeOrder(
    strategy: Strategy,
    symbol: string,
    orderId: string,
  ): Promise<ExchangeOrder | null> {
    const exchange = await this.getExchangeForStrategy(strategy);
    const order = await exchange.fetchOrder(orderId, symbol);
    const fills = await this.safelyFetchFills(exchange, symbol, String(order.id));
    return {
      orderId: String(order.id),
      price: order.price ?? 0,
      avgPrice: fills?.avgPrice ?? order.average ?? order.price ?? 0,
      executedQty: fills?.qty ?? order.filled ?? 0,
      commission: fills?.fee ?? order.fee?.cost ?? 0,
      commissionAsset: fills?.feeAsset ?? order.fee?.currency ?? 'USDT',
      status: order.status ?? 'unknown',
      time: order.timestamp ?? 0,
    };
  }

  private async safelyFetchFills(
    exchange: Exchange,
    symbol: string,
    orderId: string,
  ): Promise<{ qty: number; avgPrice: number; fee: number; feeAsset: string } | null> {
    try {
      const myTrades = await exchange.fetchMyTrades(symbol, undefined, undefined, { orderId });
      const fills = myTrades.filter(t => String(t.order) === orderId);
      if (!fills.length) return null;
      let qty = 0;
      let notional = 0;
      let fee = 0;
      let feeAsset = 'USDT';
      for (const f of fills) {
        const amount = f.amount ?? 0;
        qty += amount;
        notional += (f.price ?? 0) * amount;
        fee += f.fee?.cost ?? 0;
        if (f.fee?.currency) feeAsset = f.fee.currency;
      }
      return { qty, avgPrice: qty > 0 ? notional / qty : 0, fee, feeAsset };
    } catch (err) {
      this.logger.warn(`Could not fetch fills for order ${orderId}: ${err}`);
      return null;
    }
  }

  private async safelyFetchFunding(strategy: Strategy, trade: Trade): Promise<number> {
    if (!strategy.apiKey || !strategy.apiSecret) return 0;
    try {
      const exchange = await this.getExchangeForStrategy(strategy);
      if (typeof exchange.fetchFundingHistory !== 'function') return 0;
      const since = new Date(trade.timestamp).getTime();
      const end = trade.closedAt ? new Date(trade.closedAt).getTime() : Date.now();
      const entries = await exchange.fetchFundingHistory(trade.symbol, since, 100);
      return entries
        .filter(e => (e.timestamp ?? 0) >= since && (e.timestamp ?? 0) <= end)
        .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    } catch (err) {
      this.logger.warn(`Could not fetch funding for trade ${trade.id}: ${err}`);
      return 0;
    }
  }

  async getHealth() {
    const now = new Date();
    try {
      const dayAgo = new Date(Date.now() - 86400000);
      const [lastLog] = await this.auditRepo.find({ order: { createdAt: 'DESC' }, take: 1 });
      const logs24h = await this.auditRepo.count({ where: { createdAt: Between(dayAgo, now) } });
      const errors24h = await this.auditRepo.count({
        where: { createdAt: Between(dayAgo, now), severity: AuditSeverity.ERROR },
      });
      return {
        status: 'ok',
        timestamp: now.toISOString(),
        lastAuditAt: lastLog?.createdAt ?? null,
        logs24h,
        errors24h,
      };
    } catch (err) {
      return { status: 'degraded', timestamp: now.toISOString(), error: String(err) };
    }
  }

  private createLog(
    trade: Trade,
    category: AuditCategory,
    severity: AuditSeverity,
    message: string,
    details: Record<string, unknown>,
    expectedValue?: number,
    actualValue?: number,
    deviation?: number,
  ): AuditLog {
    const log = new AuditLog();
    log.tradeId = trade.id;
    log.strategyId = trade.strategyId;
    log.category = category;
    log.severity = severity;
    log.message = message;
    log.details = details;
    log.expectedValue = expectedValue ?? null;
    log.actualValue = actualValue ?? null;
    log.deviation = deviation ?? null;
    return log;
  }
}
