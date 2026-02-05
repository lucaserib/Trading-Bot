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
export class TakeProfitService {
  private readonly logger = new Logger(TakeProfitService.name);
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
    if (!strategy) return;

    const exchange = strategy.exchange || Exchange.BINANCE;
    const apiKey = (await EncryptionUtil.decrypt(strategy.apiKey)).trim();
    const apiSecret = (await EncryptionUtil.decrypt(strategy.apiSecret)).trim();

    // --- Bybit trading stop (position-level, no manual monitoring needed) ---
    if (trade.takeProfitOrderId && trade.takeProfitOrderId.startsWith('BYBIT_TRADING_STOP')) {
      const positions = await this.bybitClient.getPositions(apiKey, apiSecret, strategy.isTestnet, trade.symbol);
      const position = positions.find(p =>
        p.symbol === trade.symbol &&
        ((trade.side === 'BUY' && p.side === 'Buy') || (trade.side === 'SELL' && p.side === 'Sell'))
      );
      if (!position || parseFloat(position.size) === 0) {
        this.logger.log(`[TAKE PROFIT EXECUTED] ${trade.symbol} - Position closed on Bybit`);
        await this.markTradeAsClosed(trade, 'TAKE_PROFIT', exchange, apiKey, apiSecret, strategy.isTestnet);
      }
      return;
    }

    // --- Exchange TP orders tracking (pipe-delimited: "1:orderId|2:orderId|3:orderId") ---
    if (trade.takeProfitOrderId && trade.takeProfitOrderId.includes(':')) {
      await this.checkExchangeTakeProfit(trade, strategy, exchange, apiKey, apiSecret);
      return;
    }

    // --- Manual price-based TP monitoring (fallback when exchange orders not placed) ---
    const currentPrice = await this.getCurrentPrice(trade, strategy);
    if (!currentPrice) return;

    const tp1 = this.calculateTakeProfit(trade, strategy, 1);
    const tp2 = this.calculateTakeProfit(trade, strategy, 2);
    const tp3 = this.calculateTakeProfit(trade, strategy, 3);

    if (!tp1 && !tp2 && !tp3) return;

    const tp1Qty = strategy.takeProfitQuantity1 || 33;
    const tp2Qty = strategy.takeProfitQuantity2 || 33;
    const lastTpLevel = trade.lastTpLevel || 0;

    const profitPercent = this.calculateProfitPercent(trade, currentPrice);
    const entryPrice = parseFloat(trade.entryPrice as any);

    if (lastTpLevel < 1 && tp1 && this.shouldTrigger(trade, currentPrice, tp1)) {
      this.logger.log(`[TAKE-PROFIT 1 HIT] ${trade.symbol}`);
      this.logger.log(`├─ Entry: ${entryPrice.toFixed(2)} → Exit: ${currentPrice.toFixed(2)} (${profitPercent > 0 ? '+' : ''}${profitPercent.toFixed(2)}%)`);
      trade.lastTpLevel = 1;
      await this.closePosition(trade, strategy, currentPrice, 'TAKE_PROFIT_1', tp1Qty / 100);
    } else if (lastTpLevel < 2 && tp2 && this.shouldTrigger(trade, currentPrice, tp2)) {
      const closePercent = tp2Qty / (100 - tp1Qty);
      this.logger.log(`[TAKE-PROFIT 2 HIT] ${trade.symbol}`);
      this.logger.log(`├─ Entry: ${entryPrice.toFixed(2)} → Exit: ${currentPrice.toFixed(2)} (${profitPercent > 0 ? '+' : ''}${profitPercent.toFixed(2)}%)`);
      trade.lastTpLevel = 2;
      await this.closePosition(trade, strategy, currentPrice, 'TAKE_PROFIT_2', closePercent);
    } else if (lastTpLevel < 3 && tp3 && this.shouldTrigger(trade, currentPrice, tp3)) {
      this.logger.log(`[TAKE-PROFIT 3 HIT] ${trade.symbol}`);
      this.logger.log(`├─ Entry: ${entryPrice.toFixed(2)} → Exit: ${currentPrice.toFixed(2)} (${profitPercent > 0 ? '+' : ''}${profitPercent.toFixed(2)}%)`);
      trade.lastTpLevel = 3;
      await this.closePosition(trade, strategy, currentPrice, 'TAKE_PROFIT_3', 1.0);
    }
  }

  private async checkExchangeTakeProfit(trade: Trade, strategy: any, exchange: Exchange, apiKey: string, apiSecret: string) {
    const entries = trade.takeProfitOrderId!.split('|');
    const tp1Qty = strategy.takeProfitQuantity1 || 33;
    const tp2Qty = strategy.takeProfitQuantity2 || 33;

    const filledLevels = new Set<number>();
    let anyActive = false;
    let allDone = true;

    for (const entry of entries) {
      const [levelStr, orderId] = entry.split(':');
      const level = parseInt(levelStr);

      if ((trade.lastTpLevel || 0) >= level) {
        filledLevels.add(level);
        continue;
      }

      const status = await this.checkOrderStatus(orderId, trade.symbol, exchange, apiKey, apiSecret, strategy.isTestnet);

      if (status === 'FILLED' || status === 'Filled') {
        filledLevels.add(level);
        this.logger.log(`[TP${level}] Exchange order filled for ${trade.symbol} (orderId: ${orderId})`);
      } else if (status === 'NEW' || status === 'New') {
        anyActive = true;
        allDone = false;
      } else if (status === 'CANCELED' || status === 'EXPIRED' || status === 'Cancelled' || status === 'Deactivated') {
        this.logger.warn(`[TP${level}] Exchange order ${orderId} was ${status}`);
      } else {
        allDone = false;
      }
    }

    // Determine newly filled levels (not yet processed)
    const newlyFilled: number[] = [];
    for (const level of [1, 2, 3]) {
      if (filledLevels.has(level) && (trade.lastTpLevel || 0) < level) {
        newlyFilled.push(level);
      }
    }

    if (newlyFilled.length > 0) {
      const currentPrice = await this.getCurrentPrice(trade, strategy);
      let newQty = parseFloat(trade.quantity as any);
      let accumulatedPnl = parseFloat(trade.pnl as any) || 0;
      const entryPrice = parseFloat(trade.entryPrice as any);
      let highestProcessed = trade.lastTpLevel || 0;

      for (const l of newlyFilled) {
        const pct = l === 1 ? tp1Qty : l === 2 ? tp2Qty : (strategy.takeProfitQuantity3 || 34);
        const tpPrice = this.calculateTakeProfit(trade, strategy, l);

        // closePercent is relative to current remaining quantity
        // Each TP was placed with a fixed quantity = initial * pct / 100
        // But since we track via remaining qty, use: closedQty = newQty * (pct / sumOfUnprocessedPcts)
        const sumRemaining = [1, 2, 3]
          .filter(lvl => !filledLevels.has(lvl) || lvl > highestProcessed)
          .filter(lvl => lvl >= l)
          .reduce((sum, lvl) => sum + (lvl === 1 ? tp1Qty : lvl === 2 ? tp2Qty : (strategy.takeProfitQuantity3 || 34)), 0);
        const closePercent = sumRemaining > 0 ? pct / sumRemaining : pct / 100;
        const closedQty = newQty * closePercent;
        const fillPrice = tpPrice || currentPrice;
        const pnl = trade.side === 'BUY' ? (fillPrice - entryPrice) * closedQty : (entryPrice - fillPrice) * closedQty;
        accumulatedPnl += pnl;
        newQty -= closedQty;
        highestProcessed = l;

        this.logger.log(`├─ TP${l} closed: ${this.formatQuantityWithUsdt(closedQty, fillPrice)} | P&L: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)} USDT`);
      }

      const allConfiguredFilled = entries.every(e => filledLevels.has(parseInt(e.split(':')[0])));

      if (allConfiguredFilled || newQty <= 0.0001) {
        trade.status = 'CLOSED';
        trade.exitPrice = currentPrice as any;
        trade.pnl = accumulatedPnl as any;
        trade.closeReason = `TAKE_PROFIT_${highestProcessed}` as any;
        trade.closedAt = new Date();
        trade.binancePositionAmt = 0 as any;
        trade.lastTpLevel = highestProcessed;
        await this.tradesRepository.save(trade);
        this.logger.log(`└─ Trade fully closed via TP${highestProcessed} | Total P&L: ${accumulatedPnl > 0 ? '+' : ''}${accumulatedPnl.toFixed(2)} USDT`);
      } else {
        trade.quantity = newQty as any;
        trade.lastTpLevel = highestProcessed;
        trade.pnl = accumulatedPnl as any;
        trade.binancePositionAmt = newQty as any;
        await this.tradesRepository.save(trade);
        this.logger.log(`├─ Remaining: ${this.formatQuantityWithUsdt(newQty, currentPrice)}`);
      }
      return;
    }

    // All remaining orders cancelled/expired and no new fills — fall back to manual monitoring
    if (allDone && !anyActive) {
      this.logger.warn(`[TP] All exchange TP orders inactive for ${trade.symbol}, switching to manual monitoring`);
      trade.takeProfitOrderId = null;
      await this.tradesRepository.save(trade);
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

    const pnl = this.calculatePnL(trade, currentPrice, 1.0);
    const totalPnl = (parseFloat(trade.pnl as any) || 0) + pnl;

    trade.status = 'CLOSED';
    trade.exitPrice = currentPrice as any;
    trade.pnl = totalPnl as any;
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
            qty: closeQuantity.toFixed(3),
          }
        );
        this.logger.log(`[BYBIT] Closed ${(closePercent * 100).toFixed(0)}% of ${trade.symbol} via ${reason}`);
      } else if (strategy.isTestnet && exchange === Exchange.BINANCE) {
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

        this.logger.log(`[BINANCE] Closed ${(closePercent * 100).toFixed(0)}% of ${trade.symbol} via ${reason}`);
      } else {
        const exchangeInstance = await this.exchangeService.getExchange(
          exchange,
          apiKey,
          apiSecret,
          strategy.isTestnet
        );

        await exchangeInstance.createMarketOrder(trade.symbol, closeSide.toLowerCase(), closeQuantity);
        this.logger.log(`[CLOSED ${(closePercent * 100).toFixed(0)}%] ${trade.symbol} via ${reason}`);
      }

      const pnl = this.calculatePnL(trade, exitPrice, closePercent);

      if (closePercent >= 1.0) {
        trade.status = 'CLOSED';
        trade.exitPrice = exitPrice as any;
        trade.pnl = pnl as any;
        trade.closeReason = reason;
        trade.closedAt = new Date();
        trade.binancePositionAmt = 0 as any;

        await this.tradesRepository.save(trade);

        this.logger.log(`├─ Closed: ${this.formatQuantityWithUsdt(closeQuantity, exitPrice)} (100%)`);
        this.logger.log(`└─ P&L: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)} USDT`);
      } else {
        const remainingQuantity = quantity * (1 - closePercent);
        trade.quantity = remainingQuantity as any;
        const currentPnl = parseFloat(trade.pnl as any) || 0;
        trade.pnl = (currentPnl + pnl) as any;
        trade.binancePositionAmt = remainingQuantity as any;

        await this.tradesRepository.save(trade);

        this.logger.log(`├─ Closed: ${this.formatQuantityWithUsdt(closeQuantity, exitPrice)} (${(closePercent * 100).toFixed(0)}%)`);
        this.logger.log(`├─ Remaining: ${this.formatQuantityWithUsdt(remainingQuantity, exitPrice)}`);
        this.logger.log(`└─ P&L: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)} USDT`);
      }

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
