import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Trade, CloseReason } from '../strategies/trade.entity';
import { StrategiesService } from '../strategies/strategies.service';
import { ExchangeService } from '../exchange/exchange.service';
import { BybitClientService } from '../exchange/bybit-client.service';
import { Exchange } from '../strategies/strategy.entity';
import { EncryptionUtil } from '../utils/encryption.util';
import axios from 'axios';
import * as crypto from 'crypto';

@Injectable()
export class StopLossService {
  private readonly logger = new Logger(StopLossService.name);
  private readonly BINANCE_TESTNET_URL = 'https://testnet.binancefuture.com';
  private readonly BINANCE_MAINNET_URL = 'https://fapi.binance.com';

  constructor(
    @InjectRepository(Trade)
    private tradesRepository: Repository<Trade>,
    private strategiesService: StrategiesService,
    private exchangeService: ExchangeService,
    private bybitClient: BybitClientService,
  ) {}

  private formatQuantityWithUsdt(quantity: number, price: number): string {
    const usdt = quantity * price;
    return `${quantity.toFixed(4)} (~${usdt.toFixed(2)} USDT)`;
  }

  @Cron(CronExpression.EVERY_5_SECONDS)
  async monitorStopLoss() {
    const openTrades = await this.tradesRepository.find({ where: { status: 'OPEN' } });

    if (openTrades.length === 0) return;

    for (const trade of openTrades) {
      try {
        await this.checkStopLoss(trade);
      } catch (error) {
        this.logger.error(`Error checking stop-loss for trade ${trade.id}: ${error.message}`);
      }
    }
  }

  private async checkStopLoss(trade: Trade) {
    const strategy = await this.strategiesService.findOne(trade.strategyId);
    if (!strategy) return;

    const exchange = strategy.exchange || Exchange.BINANCE;
    const apiKey = (await EncryptionUtil.decrypt(strategy.apiKey)).trim();
    const apiSecret = (await EncryptionUtil.decrypt(strategy.apiSecret)).trim();

    if (trade.stopLossOrderId && trade.stopLossOrderId.trim() !== '') {
      if (trade.stopLossOrderId.startsWith('BYBIT_TRADING_STOP')) {
        const positions = await this.bybitClient.getPositions(apiKey, apiSecret, strategy.isTestnet, trade.symbol);
        const position = positions.find(p =>
          p.symbol === trade.symbol &&
          ((trade.side === 'BUY' && p.side === 'Buy') || (trade.side === 'SELL' && p.side === 'Sell'))
        );

        if (!position || parseFloat(position.size) === 0) {
          this.logger.log(`[STOP LOSS EXECUTED] ${trade.symbol} - Position closed on Bybit`);
          await this.markTradeAsClosed(trade, 'STOP_LOSS', exchange, apiKey, apiSecret, strategy.isTestnet);
          return;
        }
        return;
      }

      const orderStatus = await this.checkOrderStatus(
        trade.stopLossOrderId,
        trade.symbol,
        exchange,
        apiKey,
        apiSecret,
        strategy.isTestnet
      );

      if (orderStatus === 'FILLED' || orderStatus === 'Filled') {
        this.logger.log(`[STOP LOSS EXECUTED] ${trade.symbol} - Order was filled`);
        await this.markTradeAsClosed(trade, 'STOP_LOSS', exchange, apiKey, apiSecret, strategy.isTestnet);
        return;
      } else if (orderStatus === 'CANCELED' || orderStatus === 'EXPIRED' || orderStatus === 'Cancelled' || orderStatus === 'Deactivated') {
        this.logger.warn(`[STOP LOSS] Order ${trade.stopLossOrderId} was ${orderStatus}, falling back to manual monitoring`);
        trade.stopLossOrderId = null;
        await this.tradesRepository.save(trade);
      } else if (orderStatus === 'NEW' || orderStatus === 'New') {
        return;
      }
    }

    if (!strategy.stopLossPercentage) return;

    const currentPrice = await this.getCurrentPrice(trade, strategy);
    if (!currentPrice) return;

    const stopLossPrice = this.calculateStopLoss(trade, strategy);

    const shouldTrigger =
      (trade.side === 'BUY' && currentPrice <= stopLossPrice) ||
      (trade.side === 'SELL' && currentPrice >= stopLossPrice);

    if (shouldTrigger) {
      const entryPrice = parseFloat(trade.entryPrice as any);
      const lossPercent = trade.side === 'BUY'
        ? ((currentPrice - entryPrice) / entryPrice) * 100
        : ((entryPrice - currentPrice) / entryPrice) * 100;

      this.logger.warn(`[STOP-LOSS TRIGGERED] ${trade.symbol}`);
      this.logger.warn(`├─ Entry: ${entryPrice.toFixed(2)} → Exit: ${currentPrice.toFixed(2)} (${lossPercent.toFixed(2)}%)`);
      this.logger.warn(`└─ SL Price: ${stopLossPrice.toFixed(2)}`);
      await this.closePosition(trade, strategy, currentPrice, 'STOP_LOSS');
    }
  }

  private async checkOrderStatus(
    orderId: string,
    symbol: string,
    exchange: Exchange,
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<string | null> {
    try {
      if (exchange === Exchange.BYBIT) {
        let orderInfo = await this.bybitClient.getOrderInfo(apiKey, apiSecret, isTestnet, symbol, orderId);

        if (!orderInfo) {
          orderInfo = await this.bybitClient.getOrderHistory(apiKey, apiSecret, isTestnet, symbol, orderId);
        }

        return orderInfo?.orderStatus || null;
      }

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
    exchange: Exchange,
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<void> {
    const exitPrice = await this.getLastTradePrice(trade.symbol, exchange, apiKey, apiSecret, isTestnet);
    const currentPrice = exitPrice || await this.getCurrentPrice(trade, { exchange, isTestnet } as any);

    // Cancel any remaining exchange orders
    try {
      if (exchange === Exchange.BYBIT) {
        await this.bybitClient.cancelAllOrders(apiKey, apiSecret, isTestnet, trade.symbol);
      } else {
        await this.cancelAllBinanceOrders(apiKey, apiSecret, isTestnet, trade.symbol);
      }
    } catch (e) {
      this.logger.warn(`[SL] Failed to cancel open orders on ${trade.symbol}: ${e.message}`);
    }

    const pnl = this.calculatePnL(trade, currentPrice);
    const totalPnl = (parseFloat(trade.pnl as any) || 0) + pnl;

    trade.status = 'CLOSED';
    trade.exitPrice = currentPrice as any;
    trade.pnl = totalPnl;
    trade.closeReason = reason;
    trade.closedAt = new Date();
    trade.binancePositionAmt = 0 as any;

    await this.tradesRepository.save(trade);

    this.logger.log(`[CLOSED] ${trade.symbol} via ${reason} | P&L: ${totalPnl > 0 ? '+' : ''}${totalPnl.toFixed(2)} USDT`);
  }

  private async getLastTradePrice(
    symbol: string,
    exchange: Exchange,
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<number | null> {
    try {
      if (exchange === Exchange.BYBIT) {
        return await this.bybitClient.getLastTradePrice(apiKey, apiSecret, isTestnet, symbol);
      }

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

  private calculateStopLoss(trade: Trade, strategy: any): number {
    const slPercent = strategy.stopLossPercentage / 100;
    const entryPrice = parseFloat(trade.entryPrice as any);

    if (trade.side === 'BUY') {
      return entryPrice * (1 - slPercent);
    } else {
      return entryPrice * (1 + slPercent);
    }
  }

  private async getCurrentPrice(trade: Trade, strategy: any): Promise<number> {
    try {
      const exchange = strategy.exchange || Exchange.BINANCE;

      if (exchange === Exchange.BYBIT) {
        return await this.bybitClient.getCurrentPrice(strategy.isTestnet, trade.symbol);
      }

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

  private async closePosition(trade: Trade, strategy: any, exitPrice: number, reason: CloseReason) {
    try {
      const apiKey = (await EncryptionUtil.decrypt(strategy.apiKey)).trim();
      const apiSecret = (await EncryptionUtil.decrypt(strategy.apiSecret)).trim();

      const exchange = strategy.exchange || Exchange.BINANCE;
      const closeSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
      const quantity = parseFloat(trade.quantity as any);

      if (exchange === Exchange.BYBIT) {
        const bybitSide = closeSide === 'BUY' ? 'Buy' : 'Sell';
        await this.bybitClient.createOrder(
          apiKey,
          apiSecret,
          strategy.isTestnet,
          {
            symbol: trade.symbol,
            side: bybitSide,
            orderType: 'Market',
            qty: quantity.toFixed(3),
          }
        );
        this.logger.warn(`[BYBIT] Closed ${trade.symbol} via ${reason}`);
      } else if (strategy.isTestnet && exchange === Exchange.BINANCE) {
        const baseURL = this.BINANCE_TESTNET_URL;
        const endpoint = '/fapi/v1/order';

        const params = new URLSearchParams();
        params.append('symbol', trade.symbol);
        params.append('side', closeSide);
        params.append('type', 'MARKET');
        params.append('quantity', quantity.toFixed(3));
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

        this.logger.warn(`[BINANCE] Closed ${trade.symbol} via ${reason}`);
      } else {
        const exchangeInstance = await this.exchangeService.getExchange(
          exchange,
          apiKey,
          apiSecret,
          strategy.isTestnet
        );

        await exchangeInstance.createMarketOrder(trade.symbol, closeSide.toLowerCase(), quantity);
        this.logger.warn(`[CLOSED] ${trade.symbol} via ${reason}`);
      }

      // Cancel any remaining exchange TP orders
      try {
        if (exchange === Exchange.BYBIT) {
          await this.bybitClient.cancelAllOrders(apiKey, apiSecret, strategy.isTestnet, trade.symbol);
        } else {
          await this.cancelAllBinanceOrders(apiKey, apiSecret, strategy.isTestnet, trade.symbol);
        }
      } catch (e) {
        this.logger.warn(`[SL] Failed to cancel open orders on ${trade.symbol}: ${e.message}`);
      }

      const pnl = this.calculatePnL(trade, exitPrice);
      const totalPnl = (parseFloat(trade.pnl as any) || 0) + pnl;

      trade.status = 'CLOSED';
      trade.exitPrice = exitPrice as any;
      trade.pnl = totalPnl;
      trade.closeReason = reason;
      trade.closedAt = new Date();
      trade.binancePositionAmt = 0 as any;

      await this.tradesRepository.save(trade);

      this.logger.warn(`└─ Closed: ${this.formatQuantityWithUsdt(quantity, exitPrice)} | P&L: ${totalPnl > 0 ? '+' : ''}${totalPnl.toFixed(2)} USDT`);

    } catch (error) {
      this.logger.error(`Failed to close position: ${error.message}`);
    }
  }

  private async cancelAllBinanceOrders(apiKey: string, apiSecret: string, isTestnet: boolean, symbol: string): Promise<void> {
    const baseURL = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;
    const params = new URLSearchParams();
    params.append('symbol', symbol);
    params.append('timestamp', Date.now().toString());
    const queryString = params.toString();
    const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
    await axios.delete(`${baseURL}/fapi/v1/allOpenOrders?${queryString}&signature=${signature}`, {
      headers: { 'X-MBX-APIKEY': apiKey }
    });
  }

  private calculatePnL(trade: Trade, exitPrice: number): number {
    const entryPrice = parseFloat(trade.entryPrice as any);
    const quantity = parseFloat(trade.quantity as any);

    if (trade.side === 'BUY') {
      return (exitPrice - entryPrice) * quantity;
    } else {
      return (entryPrice - exitPrice) * quantity;
    }
  }
}
