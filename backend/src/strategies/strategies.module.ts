import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StrategiesController } from './strategies.controller';
import { StrategiesService } from './strategies.service';
import { Strategy } from './strategy.entity';
import { ExchangeModule } from '../exchange/exchange.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Strategy]),
    ExchangeModule
  ],
  controllers: [StrategiesController],
  providers: [StrategiesService],
  exports: [StrategiesService]
})
export class StrategiesModule {}
