import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { Strategy } from './strategies/strategy.entity';
import { WebhookModule } from './webhook/webhook.module';
import { ExchangeModule } from './exchange/exchange.module';
import { StrategiesModule } from './strategies/strategies.module';
import { TradesModule } from './trades/trades.module';
import { PositionSyncModule } from './position-sync/position-sync.module';
import { StopLossModule } from './stop-loss/stop-loss.module';
import { TakeProfitModule } from './take-profit/take-profit.module';
import { WebSocketModule } from './websocket/websocket.module';
import { BinanceWebSocketModule } from './binance-ws/binance-ws.module';
import { AuditorModule } from './auditor/auditor.module';
import { AiChatModule } from './ai-chat/ai-chat.module';
import { ValidationReportsModule } from './validation-reports/validation-reports.module';
import { PortfoliosModule } from './portfolios/portfolios.module';
import { CommonModule } from './common/common.module';
import { PerformanceModule } from './performance/performance.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot(),
    ThrottlerModule.forRoot([{
      ttl: 60000,
      limit: 100,
    }]),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const dbUrl = configService.get<string>('DATABASE_URL');
        // Configuration for Cloud Deployment (Railway) using DATABASE_URL
        if (dbUrl) {
          return {
            type: 'postgres',
            url: dbUrl,
            autoLoadEntities: true,
            synchronize: true, // Note: Set to false in production if using migrations
            ssl: {
              rejectUnauthorized: false,
            },
          };
        }
        // Configuration for Local Development
        return {
          type: 'postgres',
          host: configService.get<string>('DB_HOST', 'localhost'),
          port: configService.get<number>('DB_PORT', 5432),
          username: configService.get<string>('DB_USER', 'admin'),
          password: configService.get<string>('DB_PASSWORD', 'admin123'),
          database: configService.get<string>('DB_NAME', 'trading_bot'),
          autoLoadEntities: true,
          synchronize: true,
        };
      },
      inject: [ConfigService],
    }),
    TypeOrmModule.forFeature([Strategy]),
    BinanceWebSocketModule,
    WebhookModule,
    ExchangeModule,
    StrategiesModule,
    TradesModule,
    PositionSyncModule,
    StopLossModule,
    TakeProfitModule,
    WebSocketModule,
    AuditorModule,
    AiChatModule,
    ValidationReportsModule,
    PortfoliosModule,
    CommonModule,
    PerformanceModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
