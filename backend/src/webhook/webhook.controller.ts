import {
  Controller,
  Post,
  Body,
  UnauthorizedException,
  Logger,
  UseGuards,
  Get,
  BadRequestException
} from '@nestjs/common';
import { ThrottlerGuard, Throttle } from '@nestjs/throttler';
import { WebhookService } from './webhook.service';
import { ConfigService } from '@nestjs/config';

interface WebhookPayload {
  secret: string;
  strategyId: string;
  symbol: string;
  action: string;
  price?: number | string;
  quantity?: number;
  accountPercentage?: number;
  orderType?: 'market' | 'limit';
  stopLoss?: number | string;
  takeProfit?: number | string;
}

@Controller('webhooks/tradingview')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    private readonly webhookService: WebhookService,
    private readonly configService: ConfigService,
  ) {}

  @Get('health')
  health() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString()
    };
  }

  @Post()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async handleSignal(@Body() payload: WebhookPayload) {
    const orderTypeLabel = payload.orderType === 'limit' ? 'LIMIT' : 'MARKET';
    this.logger.log(
      `[WEBHOOK] ${payload.symbol} ${payload.action?.toUpperCase()} @ ${payload.price || 'MARKET'} (${orderTypeLabel})`
    );

    const normalizedPayload = this.normalizePayload(payload);
    this.validatePayload(normalizedPayload);
    this.verifySecret(normalizedPayload.secret);

    try {
      const result = await this.webhookService.processSignal(normalizedPayload);
      this.logger.log(`[SUCCESS] ${result.status}`);
      return result;
    } catch (error) {
      this.logger.error(`[ERROR] ${error.message}`);
      throw error;
    }
  }

  private normalizePayload(payload: WebhookPayload): any {
    return {
      ...payload,
      price: typeof payload.price === 'string'
        ? parseFloat(payload.price)
        : payload.price,
      stopLoss: typeof payload.stopLoss === 'string'
        ? parseFloat(payload.stopLoss)
        : payload.stopLoss,
      takeProfit: typeof payload.takeProfit === 'string'
        ? parseFloat(payload.takeProfit)
        : payload.takeProfit,
      action: payload.action?.toLowerCase(),
      orderType: payload.orderType?.toLowerCase()
    };
  }

  private validatePayload(payload: WebhookPayload): void {
    const required = ['secret', 'strategyId', 'symbol', 'action'];
    const missing = required.filter(field => !payload[field]);

    if (missing.length > 0) {
      throw new BadRequestException(`Missing required fields: ${missing.join(', ')}`);
    }
  }

  private verifySecret(secret: string): void {
    const expectedSecret = this.configService.get<string>('WEBHOOK_SECRET') || 'default_secret_123';

    if (secret !== expectedSecret) {
      this.logger.warn(`[UNAUTHORIZED] Invalid secret`);
      throw new UnauthorizedException('Invalid secret');
    }
  }
}
