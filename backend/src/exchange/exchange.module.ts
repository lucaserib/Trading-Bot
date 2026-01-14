import { Module } from '@nestjs/common';
import { ExchangeService } from './exchange.service';
import { BybitClientService } from './bybit-client.service';

@Module({
  providers: [ExchangeService, BybitClientService],
  exports: [ExchangeService, BybitClientService]
})
export class ExchangeModule {}
