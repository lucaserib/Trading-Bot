import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

export enum AuditSeverity {
  INFO = 'INFO',
  WARNING = 'WARNING',
  ERROR = 'ERROR',
  CRITICAL = 'CRITICAL',
}

export enum AuditCategory {
  FEE_MISMATCH = 'FEE_MISMATCH',
  PRICE_DEVIATION = 'PRICE_DEVIATION',
  SIGNAL_LATENCY = 'SIGNAL_LATENCY',
  PNL_MISMATCH = 'PNL_MISMATCH',
  SLIPPAGE = 'SLIPPAGE',
  MISSED_FILL = 'MISSED_FILL',
  LIQUIDATION_RISK = 'LIQUIDATION_RISK',
  BACKTEST_DIVERGENCE = 'BACKTEST_DIVERGENCE',
  ORDER_REJECTED = 'ORDER_REJECTED',
  TP_PERCENT_MISMATCH = 'TP_PERCENT_MISMATCH',
  SL_PERCENT_MISMATCH = 'SL_PERCENT_MISMATCH',
  DUPLICATE_POSITION = 'DUPLICATE_POSITION',
  MISSING_TP_ORDERS = 'MISSING_TP_ORDERS',
  TP_EXECUTED_AT_MARKET = 'TP_EXECUTED_AT_MARKET',
  ADMIN_RESET = 'ADMIN_RESET',
}

@Entity('audit_log')
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ nullable: true })
  tradeId: string;

  @Index()
  @Column({ nullable: true })
  strategyId: string;

  @Column({ type: 'enum', enum: AuditCategory })
  category: AuditCategory;

  @Column({ type: 'enum', enum: AuditSeverity })
  severity: AuditSeverity;

  @Column('text')
  message: string;

  @Column({ type: 'jsonb', nullable: true })
  details: Record<string, unknown>;

  @Column({ type: 'decimal', precision: 18, scale: 8, nullable: true })
  expectedValue: number | null;

  @Column({ type: 'decimal', precision: 18, scale: 8, nullable: true })
  actualValue: number | null;

  @Column({ type: 'decimal', precision: 18, scale: 8, nullable: true })
  deviation: number | null;

  @CreateDateColumn()
  createdAt: Date;
}
