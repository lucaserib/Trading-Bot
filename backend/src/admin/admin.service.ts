import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { Trade } from '../strategies/trade.entity';
import { TradeExecution } from '../trades/trade-execution.entity';
import { SignalLog } from '../webhook/signal-log.entity';
import { Strategy } from '../strategies/strategy.entity';
import { AuditLog, AuditCategory, AuditSeverity } from '../auditor/audit-log.entity';

export interface ResetTradesParams {
  dryRun?: boolean;
  confirm?: string;
  portfolioId?: string;
  executedBy?: string;
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectRepository(Trade)
    private readonly tradeRepository: Repository<Trade>,
    @InjectRepository(TradeExecution)
    private readonly executionRepository: Repository<TradeExecution>,
    @InjectRepository(SignalLog)
    private readonly signalLogRepository: Repository<SignalLog>,
    @InjectRepository(Strategy)
    private readonly strategyRepository: Repository<Strategy>,
    @InjectRepository(AuditLog)
    private readonly auditRepository: Repository<AuditLog>,
  ) {}

  async resetTrades(params: ResetTradesParams) {
    const dryRun = params.dryRun !== false;
    const tradeWhere: any = {};
    if (params.portfolioId) tradeWhere.portfolioId = params.portfolioId;

    const trades = await this.tradeRepository.find({ where: tradeWhere });
    const openTrades = trades.filter((t) => t.status === 'OPEN');

    const countsByStatus: Record<string, number> = {};
    for (const trade of trades) {
      countsByStatus[trade.status] = (countsByStatus[trade.status] || 0) + 1;
    }

    const timestamps = trades.map((t) => new Date(t.timestamp).getTime()).filter((t) => !isNaN(t));
    const periodCovered = {
      from: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
      to: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null,
    };
    const accumulatedPnl = trades.reduce((sum, t) => sum + (parseFloat(t.pnl as any) || 0), 0);

    const tradeIds = trades.map((t) => t.id);
    const executionsCount = tradeIds.length
      ? await this.executionRepository.count({ where: { tradeId: In(tradeIds) } })
      : 0;

    let strategyIds: string[] = [];
    if (params.portfolioId) {
      const strategies = await this.strategyRepository.find({ where: { portfolioId: params.portfolioId } as any, select: ['id'] });
      strategyIds = strategies.map((s) => s.id);
    }
    const signalLogsCount = params.portfolioId
      ? strategyIds.length
        ? await this.signalLogRepository.count({ where: { strategyId: In(strategyIds) } })
        : 0
      : await this.signalLogRepository.count();

    if (dryRun) {
      return {
        dryRun: true,
        countsByStatus,
        periodCovered,
        accumulatedPnl,
        tradesCount: trades.length,
        executionsCount,
        signalLogsCount,
        openTradesBlocking: openTrades.length,
      };
    }

    if (params.confirm !== 'RESET') {
      throw new BadRequestException('Envie confirm: "RESET" no corpo para executar o reset real.');
    }

    if (openTrades.length > 0) {
      throw new ConflictException(
        `Recusado: existe(m) ${openTrades.length} trade(s) OPEN. Feche as posições na corretora ou aguarde antes de resetar.`,
      );
    }

    const backupDir = path.join(process.cwd(), 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const executions = tradeIds.length
      ? await this.executionRepository.find({ where: { tradeId: In(tradeIds) } })
      : [];
    const signalLogs = params.portfolioId
      ? strategyIds.length
        ? await this.signalLogRepository.find({ where: { strategyId: In(strategyIds) } })
        : []
      : await this.signalLogRepository.find();

    const backupFileName = `reset-${Date.now()}.json`;
    const backupFilePath = path.join(backupDir, backupFileName);
    fs.writeFileSync(
      backupFilePath,
      JSON.stringify({ exportedAt: new Date().toISOString(), portfolioId: params.portfolioId ?? null, trades, executions, signalLogs }, null, 2),
    );

    if (tradeIds.length) {
      await this.executionRepository.delete({ tradeId: In(tradeIds) });
    }
    if (params.portfolioId) {
      if (strategyIds.length) {
        await this.signalLogRepository.delete({ strategyId: In(strategyIds) });
      }
    } else {
      await this.signalLogRepository.clear();
    }
    if (tradeIds.length) {
      await this.tradeRepository.delete({ id: In(tradeIds) });
    }

    await this.auditRepository.save(
      this.auditRepository.create({
        category: AuditCategory.ADMIN_RESET,
        severity: AuditSeverity.INFO,
        message: `Reset manual de dados de teste executado por ${params.executedBy || 'desconhecido'}: ${tradeIds.length} trade(s), ${executions.length} execucao(oes), ${signalLogs.length} signal log(s) removidos.`,
        details: {
          portfolioId: params.portfolioId ?? null,
          executedBy: params.executedBy ?? null,
          deletedTrades: tradeIds.length,
          deletedExecutions: executions.length,
          deletedSignalLogs: signalLogs.length,
          backupFile: backupFilePath,
        },
      }),
    );

    this.logger.warn(
      `[RESET] ${tradeIds.length} trade(s), ${executions.length} execucao(oes), ${signalLogs.length} signal log(s) removidos por ${params.executedBy || 'desconhecido'}. Backup: ${backupFilePath}`,
    );

    return {
      dryRun: false,
      success: true,
      deletedTrades: tradeIds.length,
      deletedExecutions: executions.length,
      deletedSignalLogs: signalLogs.length,
      backupFile: backupFilePath,
    };
  }
}
