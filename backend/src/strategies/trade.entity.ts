import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

export type CloseReason = 'STOP_LOSS' | 'TAKE_PROFIT' | 'TAKE_PROFIT_1' | 'TAKE_PROFIT_2' | 'TAKE_PROFIT_3' | 'MANUAL' | 'LIQUIDATION' | 'SIGNAL';

@Entity()
export class Trade {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column()
  strategyId: string;

  @Column()
  symbol: string;

  @Column()
  side: 'BUY' | 'SELL';

  @Column()
  type: 'MARKET' | 'LIMIT';

  @Column("decimal", { precision: 18, scale: 8 })
  entryPrice: number;

  @Column("decimal", { precision: 18, scale: 8, nullable: true })
  exitPrice: number | null;

  @Column("decimal", { precision: 18, scale: 8 })
  quantity: number;

  @Column("decimal", { precision: 18, scale: 8, nullable: true })
  pnl: number | null;

  @Column({ default: 'OPEN' })
  status: 'OPEN' | 'CLOSED' | 'SIMULATED' | 'ERROR';

  @Column({ type: 'text', nullable: true })
  exchangeOrderId: string | null;

  @Column({ type: 'text', nullable: true })
  stopLossOrderId: string | null;

  @Column({ type: 'text', nullable: true })
  takeProfitOrderId: string | null;

  @Column({ type: 'text', nullable: true })
  closeReason: CloseReason | null;

  @Column({ type: 'timestamp', nullable: true })
  closedAt: Date | null;

  @Column("decimal", { precision: 18, scale: 8, nullable: true })
  binancePositionAmt: number | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn()
  timestamp: Date;
}
