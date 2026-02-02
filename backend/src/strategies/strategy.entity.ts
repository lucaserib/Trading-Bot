import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export enum StrategyDirection {
  LONG = 'LONG',
  SHORT = 'SHORT',
  BOTH = 'BOTH',
}

export enum TradingMode {
  CYCLE = 'CYCLE',
  SINGLE = 'SINGLE',
}

export enum MarginMode {
  ISOLATED = 'ISOLATED',
  CROSS = 'CROSS',
}

export enum Exchange {
  BINANCE = 'binance',
  BYBIT = 'bybit',
}

@Entity()
export class Strategy {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column()
  asset: string;

  @Column({ type: 'enum', enum: Exchange, default: Exchange.BINANCE })
  exchange: Exchange;

  @Column({ type: 'enum', enum: StrategyDirection, default: StrategyDirection.LONG })
  direction: StrategyDirection;

  @Column({ default: true })
  isActive: boolean;

  @Column({ default: false })
  isTestnet: boolean;

  @Column({ default: false })
  isRealAccount: boolean;

  @Column({ type: 'text', nullable: true, select: false }) 
  apiKey: string;

  @Column({ type: 'text', nullable: true, select: false })
  apiSecret: string;

  @Column({ type: 'int', default: 1 })
  leverage: number;

  @Column({ type: 'enum', enum: MarginMode, default: MarginMode.ISOLATED })
  marginMode: MarginMode;

  @Column({ type: 'float', default: 0.002 })
  defaultQuantity: number;

  @Column({ type: 'float', nullable: true })
  stopLossPercentage: number;

  @Column({ type: 'float', nullable: true })
  takeProfitPercentage1: number;

  @Column({ type: 'float', nullable: true })
  takeProfitPercentage2: number;

  @Column({ type: 'float', nullable: true })
  takeProfitPercentage3: number;

  @Column({ type: 'float', default: 33 })
  takeProfitQuantity1: number;

  @Column({ type: 'float', default: 33 })
  takeProfitQuantity2: number;

  @Column({ type: 'float', default: 34 })
  takeProfitQuantity3: number;

  @Column({ default: false })
  breakAgain: boolean;

  @Column({ default: false })
  moveSLToBreakeven: boolean;

  @Column({ default: false })
  nextCandleEntry: boolean;

  @Column({ type: 'float', nullable: true })
  nextCandlePercentage: number;

  @Column({ default: false })
  useAccountPercentage: boolean;

  @Column({ type: 'float', nullable: true })
  accountPercentage: number;

  @Column({ default: true })
  enableCompound: boolean;

  @Column({ type: 'enum', enum: TradingMode, default: TradingMode.CYCLE })
  tradingMode: TradingMode;

  @Column({ default: false })
  allowAveraging: boolean;

  @Column({ default: false })
  hedgeMode: boolean;

  @Column({ default: false })
  pauseNewOrders: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
