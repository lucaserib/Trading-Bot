import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WebhookModule } from './webhook/webhook.module';
import { ExchangeModule } from './exchange/exchange.module';
import { StrategiesModule } from './strategies/strategies.module';
import { TradesModule } from './trades/trades.module';
import { PositionSyncModule } from './position-sync/position-sync.module';
import { StopLossModule } from './stop-loss/stop-loss.module';
import { TakeProfitModule } from './take-profit/take-profit.module';
import { WebSocketModule } from './websocket/websocket.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{
      ttl: 60000,
      limit: 20,
    }]),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST', 'localhost'),
        port: configService.get<number>('DB_PORT', 5432),
        username: configService.get<string>('DB_USER', 'admin'),
        password: configService.get<string>('DB_PASSWORD', 'admin123'),
        database: configService.get<string>('DB_NAME', 'trading_bot'),
        autoLoadEntities: true,
        synchronize: true,
      }),
      inject: [ConfigService],
    }),
    WebhookModule,
    ExchangeModule,
    StrategiesModule,
    TradesModule,
    PositionSyncModule,
    StopLossModule,
    TakeProfitModule,
    WebSocketModule
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
