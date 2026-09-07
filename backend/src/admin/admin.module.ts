import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { Trade } from '../strategies/trade.entity';
import { TradeExecution } from '../trades/trade-execution.entity';
import { SignalLog } from '../webhook/signal-log.entity';
import { Strategy } from '../strategies/strategy.entity';
import { AuditLog } from '../auditor/audit-log.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Trade, TradeExecution, SignalLog, Strategy, AuditLog])],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
