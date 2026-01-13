import { IsString, IsOptional, IsEnum } from 'class-validator';
import { Transform } from 'class-transformer';

export enum SignalAction {
  BUY = 'buy',
  SELL = 'sell',
}

export enum OrderType {
  MARKET = 'market',
  LIMIT = 'limit',
}

export class TradingviewSignalDto {
  @IsString()
  secret: string;

  @IsString()
  symbol: string;

  @IsEnum(SignalAction)
  action: SignalAction;

  @IsEnum(OrderType)
  @IsOptional()
  orderType?: OrderType;

  @Transform(({ value }) => typeof value === 'string' ? parseFloat(value) : value)
  @IsOptional()
  price?: number;

  @IsString()
  @IsOptional()
  strategyId?: string;

  @Transform(({ value }) => typeof value === 'string' ? parseFloat(value) : value)
  @IsOptional()
  stopLoss?: number;

  @Transform(({ value }) => typeof value === 'string' ? parseFloat(value) : value)
  @IsOptional()
  takeProfit?: number;

  @Transform(({ value }) => typeof value === 'string' ? parseFloat(value) : value)
  @IsOptional()
  quantity?: number;

  @Transform(({ value }) => typeof value === 'string' ? parseFloat(value) : value)
  @IsOptional()
  accountPercentage?: number;
}
