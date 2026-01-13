import { Module } from '@nestjs/common';
import { TradesGateway } from './trades.gateway';
import { TradesModule } from '../trades/trades.module';

@Module({
  imports: [TradesModule],
  providers: [TradesGateway],
  exports: [TradesGateway],
})
export class WebSocketModule {}
