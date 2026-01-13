import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Trade, CloseReason } from '../strategies/trade.entity';
import { StrategiesService } from '../strategies/strategies.service';
import { ExchangeService } from '../exchange/exchange.service';
import { Exchange } from '../strategies/strategy.entity';
import { EncryptionUtil } from '../utils/encryption.util';
import axios from 'axios';
import * as crypto from 'crypto';

@Injectable()
export class TakeProfitService {
  private readonly logger = new Logger(TakeProfitService.name);
  private readonly BINANCE_TESTNET_URL = 'https://testnet.binancefuture.com';
  private readonly BINANCE_MAINNET_URL = 'https://fapi.binance.com';

  constructor(
    @InjectRepository(Trade)
    private tradesRepository: Repository<Trade>,
    private strategiesService: StrategiesService,
    private exchangeService: ExchangeService,
  ) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async monitorTakeProfit() {
    const openTrades = await this.tradesRepository.find({ where: { status: 'OPEN' } });

    if (openTrades.length === 0) return;

    for (const trade of openTrades) {
      try {
        await this.checkTakeProfit(trade);
      } catch (error) {
        this.logger.error(`Error checking take-profit for trade ${trade.id}: ${error.message}`);
      }
    }
  }

  private async checkTakeProfit(trade: Trade) {
    const strategy = await this.strategiesService.findOne(trade.strategyId);
    if (!strategy || strategy.isDryRun) return;

    const apiKey = (await EncryptionUtil.decrypt(strategy.apiKey)).trim();
    const apiSecret = (await EncryptionUtil.decrypt(strategy.apiSecret)).trim();

    // Only check order status if we have a valid takeProfitOrderId
    if (trade.takeProfitOrderId && trade.takeProfitOrderId.trim() !== '') {
      const orderStatus = await this.checkOrderStatus(
        trade.takeProfitOrderId,
        trade.symbol,
        apiKey,
        apiSecret,
        strategy.isTestnet
      );

      if (orderStatus === 'FILLED') {
        this.logger.log(`[TAKE PROFIT EXECUTED] ${trade.symbol} - Order was filled on Binance`);
        await this.markTradeAsClosed(trade, 'TAKE_PROFIT', apiKey, apiSecret, strategy.isTestnet);
        return;
      } else if (orderStatus === 'CANCELED' || orderStatus === 'EXPIRED') {
        this.logger.warn(`[TAKE PROFIT] Order ${trade.takeProfitOrderId} was ${orderStatus}, falling back to manual monitoring`);
        trade.takeProfitOrderId = null;
        await this.tradesRepository.save(trade);
      } else if (orderStatus === 'NEW') {
        // Order is still active, nothing to do
        return;
      }
      // If orderStatus is null (API error), fall through to manual monitoring
    }

    // Manual monitoring fallback
    const currentPrice = await this.getCurrentPrice(trade, strategy);
    if (!currentPrice) return;

    const tp1 = this.calculateTakeProfit(trade, strategy, 1);
    const tp2 = this.calculateTakeProfit(trade, strategy, 2);
    const tp3 = this.calculateTakeProfit(trade, strategy, 3);

    // If no take profit levels configured, skip
    if (!tp1 && !tp2 && !tp3) return;

    const profitPercent = this.calculateProfitPercent(trade, currentPrice);

    if (tp3 && this.shouldTrigger(trade, currentPrice, tp3)) {
      this.logger.log(`[TAKE-PROFIT 3 HIT] ${trade.symbol} at ${currentPrice} (TP3: ${tp3}, Profit: ${profitPercent.toFixed(2)}%)`);
      await this.closePosition(trade, strategy, currentPrice, 'TAKE_PROFIT_3', 1.0);
    } else if (tp2 && this.shouldTrigger(trade, currentPrice, tp2)) {
      this.logger.log(`[TAKE-PROFIT 2 HIT] ${trade.symbol} at ${currentPrice} (TP2: ${tp2}, Profit: ${profitPercent.toFixed(2)}%)`);
      await this.closePosition(trade, strategy, currentPrice, 'TAKE_PROFIT_2', 0.5);
    } else if (tp1 && this.shouldTrigger(trade, currentPrice, tp1)) {
      this.logger.log(`[TAKE-PROFIT 1 HIT] ${trade.symbol} at ${currentPrice} (TP1: ${tp1}, Profit: ${profitPercent.toFixed(2)}%)`);
      await this.closePosition(trade, strategy, currentPrice, 'TAKE_PROFIT_1', 0.33);
    }
  }

  private async checkOrderStatus(
    orderId: string,
    symbol: string,
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<string | null> {
    try {
      const baseUrl = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;
      const timestamp = Date.now();
      const queryString = `symbol=${symbol}&orderId=${orderId}&timestamp=${timestamp}`;
      const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

      const response = await axios.get(
        `${baseUrl}/fapi/v1/order?${queryString}&signature=${signature}`,
        { headers: { 'X-MBX-APIKEY': apiKey } }
      );

      return response.data.status;
    } catch (error) {
      this.logger.error(`Failed to check order status: ${error.message}`);
      return null;
    }
  }

  private async markTradeAsClosed(
    trade: Trade,
    reason: CloseReason,
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<void> {
    const exitPrice = await this.getLastTradePrice(trade.symbol, apiKey, apiSecret, isTestnet);
    const currentPrice = exitPrice || await this.getCurrentPrice(trade, { isTestnet } as any);

    const pnl = this.calculatePnL(trade, currentPrice, 1.0);

    trade.status = 'CLOSED';
    trade.exitPrice = currentPrice as any;
    trade.pnl = pnl as any;
    trade.closeReason = reason;
    trade.closedAt = new Date();
    trade.binancePositionAmt = 0 as any;

    await this.tradesRepository.save(trade);

    this.logger.log(`[CLOSED] ${trade.symbol} via ${reason} | P&L: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)} USDT`);
  }

  private async getLastTradePrice(
    symbol: string,
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<number | null> {
    try {
      const baseUrl = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;
      const timestamp = Date.now();
      const queryString = `symbol=${symbol}&limit=1&timestamp=${timestamp}`;
      const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

      const response = await axios.get(
        `${baseUrl}/fapi/v1/userTrades?${queryString}&signature=${signature}`,
        { headers: { 'X-MBX-APIKEY': apiKey } }
      );

      if (response.data && response.data.length > 0) {
        return parseFloat(response.data[0].price);
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  private calculateTakeProfit(trade: Trade, strategy: any, level: number): number | null {
    let tpPercent: number | null = null;

    if (level === 1) tpPercent = strategy.takeProfitPercentage1;
    else if (level === 2) tpPercent = strategy.takeProfitPercentage2;
    else if (level === 3) tpPercent = strategy.takeProfitPercentage3;

    if (!tpPercent) return null;

    const tpDecimal = tpPercent / 100;
    const entryPrice = parseFloat(trade.entryPrice as any);

    if (trade.side === 'BUY') {
      return entryPrice * (1 + tpDecimal);
    } else {
      return entryPrice * (1 - tpDecimal);
    }
  }

  private shouldTrigger(trade: Trade, currentPrice: number, tpPrice: number): boolean {
    if (trade.side === 'BUY') {
      return currentPrice >= tpPrice;
    } else {
      return currentPrice <= tpPrice;
    }
  }

  private calculateProfitPercent(trade: Trade, currentPrice: number): number {
    const entryPrice = parseFloat(trade.entryPrice as any);

    if (trade.side === 'BUY') {
      return ((currentPrice - entryPrice) / entryPrice) * 100;
    } else {
      return ((entryPrice - currentPrice) / entryPrice) * 100;
    }
  }

  private async getCurrentPrice(trade: Trade, strategy: any): Promise<number> {
    try {
      const exchange = strategy.exchange || Exchange.BINANCE;

      if (strategy.isTestnet && exchange === Exchange.BINANCE) {
        const response = await axios.get(
          `${this.BINANCE_TESTNET_URL}/fapi/v1/ticker/price?symbol=${trade.symbol}`
        );
        return parseFloat(response.data.price);
      } else {
        const apiKey = (await EncryptionUtil.decrypt(strategy.apiKey)).trim();
        const apiSecret = (await EncryptionUtil.decrypt(strategy.apiSecret)).trim();

        const exchangeInstance = await this.exchangeService.getExchange(
          exchange,
          apiKey,
          apiSecret,
          strategy.isTestnet
        );

        const ticker = await exchangeInstance.fetchTicker(trade.symbol);
        return ticker.last;
      }
    } catch (error) {
      this.logger.error(`Failed to get current price for ${trade.symbol}: ${error.message}`);
      return 0;
    }
  }

  private async closePosition(
    trade: Trade,
    strategy: any,
    exitPrice: number,
    reason: CloseReason,
    closePercent: number
  ) {
    try {
      const apiKey = (await EncryptionUtil.decrypt(strategy.apiKey)).trim();
      const apiSecret = (await EncryptionUtil.decrypt(strategy.apiSecret)).trim();

      const exchange = strategy.exchange || Exchange.BINANCE;
      const closeSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
      const quantity = parseFloat(trade.quantity as any);
      const closeQuantity = quantity * closePercent;

      if (strategy.isTestnet && exchange === Exchange.BINANCE) {
        const baseURL = this.BINANCE_TESTNET_URL;
        const endpoint = '/fapi/v1/order';

        const params = new URLSearchParams();
        params.append('symbol', trade.symbol);
        params.append('side', closeSide);
        params.append('type', 'MARKET');
        params.append('quantity', closeQuantity.toFixed(3));
        params.append('timestamp', Date.now().toString());

        const queryString = params.toString();
        const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
        const body = `${queryString}&signature=${signature}`;

        await axios.post(`${baseURL}${endpoint}`, body, {
          headers: {
            'X-MBX-APIKEY': apiKey,
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        });

        this.logger.log(`[CLOSED ${(closePercent * 100).toFixed(0)}%] ${trade.symbol} via ${reason} at ${exitPrice}`);
      } else {
        const exchangeInstance = await this.exchangeService.getExchange(
          exchange,
          apiKey,
          apiSecret,
          strategy.isTestnet
        );

        await exchangeInstance.createMarketOrder(trade.symbol, closeSide.toLowerCase(), closeQuantity);
        this.logger.log(`[CLOSED ${(closePercent * 100).toFixed(0)}%] ${trade.symbol} via ${reason} at ${exitPrice}`);
      }

      const pnl = this.calculatePnL(trade, exitPrice, closePercent);

      if (closePercent >= 1.0) {
        trade.status = 'CLOSED';
        trade.exitPrice = exitPrice as any;
        trade.pnl = pnl as any;
        trade.closeReason = reason;
        trade.closedAt = new Date();
        trade.binancePositionAmt = 0 as any;
      } else {
        const remainingQuantity = quantity * (1 - closePercent);
        trade.quantity = remainingQuantity as any;
        const currentPnl = parseFloat(trade.pnl as any) || 0;
        trade.pnl = (currentPnl + pnl) as any;
        trade.binancePositionAmt = remainingQuantity as any;
      }

      await this.tradesRepository.save(trade);

      this.logger.log(`[P&L] ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)} USDT (Remaining: ${parseFloat(trade.quantity as any)})`);

    } catch (error) {
      this.logger.error(`Failed to close position: ${error.message}`);
    }
  }

  private calculatePnL(trade: Trade, exitPrice: number, closePercent: number): number {
    const entryPrice = parseFloat(trade.entryPrice as any);
    const tradeQuantity = parseFloat(trade.quantity as any);
    const quantity = tradeQuantity * closePercent;

    if (trade.side === 'BUY') {
      return (exitPrice - entryPrice) * quantity;
    } else {
      return (entryPrice - exitPrice) * quantity;
    }
  }
}
