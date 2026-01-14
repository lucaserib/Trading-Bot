import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Trade } from '../strategies/trade.entity';
import { Strategy, Exchange } from '../strategies/strategy.entity';
import { StrategiesService } from '../strategies/strategies.service';
import { ExchangeService } from '../exchange/exchange.service';
import { BybitClientService, BybitPosition } from '../exchange/bybit-client.service';
import { TradesService } from '../trades/trades.service';
import { EncryptionUtil } from '../utils/encryption.util';
import axios from 'axios';
import * as crypto from 'crypto';

interface BinancePosition {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  positionSide: 'LONG' | 'SHORT' | 'BOTH';
}

interface NormalizedPosition {
  symbol: string;
  side: 'BUY' | 'SELL';
  size: number;
  entryPrice: number;
  unrealizedPnl: number;
  leverage: number;
}

@Injectable()
export class PositionSyncService {
  private readonly logger = new Logger(PositionSyncService.name);
  private readonly BINANCE_TESTNET_URL = 'https://testnet.binancefuture.com';
  private readonly BINANCE_MAINNET_URL = 'https://fapi.binance.com';
  private lastSyncTime: Date | null = null;
  private syncInProgress = false;

  constructor(
    @InjectRepository(Trade)
    private readonly tradesRepository: Repository<Trade>,
    @InjectRepository(Strategy)
    private readonly strategiesRepository: Repository<Strategy>,
    private readonly strategiesService: StrategiesService,
    private readonly exchangeService: ExchangeService,
    private readonly bybitClient: BybitClientService,
    private readonly tradesService: TradesService,
  ) {}

  getLastSyncTime(): Date | null {
    return this.lastSyncTime;
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
  async syncPositions(): Promise<void> {
    if (this.syncInProgress) {
      this.logger.debug('Sync already in progress, skipping...');
      return;
    }

    this.syncInProgress = true;

    try {
      const activeStrategies = await this.strategiesRepository.find({
        where: { isActive: true, isDryRun: false },
        select: ['id', 'name', 'asset', 'exchange', 'isTestnet', 'apiKey', 'apiSecret']
      });

      for (const strategy of activeStrategies) {
        try {
          await this.syncStrategyPositions(strategy);
        } catch (error) {
          this.logger.error(`Failed to sync strategy ${strategy.name}: ${error.message}`);
        }
      }

      this.lastSyncTime = new Date();
    } finally {
      this.syncInProgress = false;
    }
  }

  async forceSync(): Promise<{ synced: number; closed: number; imported: number; consolidated: number }> {
    let synced = 0;
    let closed = 0;
    let imported = 0;
    let consolidated = 0;

    const activeStrategies = await this.strategiesRepository.find({
      where: { isActive: true, isDryRun: false },
      select: ['id', 'name', 'asset', 'exchange', 'isTestnet', 'apiKey', 'apiSecret']
    });

    for (const strategy of activeStrategies) {
      try {
        const result = await this.syncStrategyPositions(strategy);
        synced += result.synced;
        closed += result.closed;
        imported += result.imported;
        consolidated += result.consolidated;
      } catch (error) {
        this.logger.error(`Failed to sync strategy ${strategy.name}: ${error.message}`);
      }
    }

    this.lastSyncTime = new Date();
    return { synced, closed, imported, consolidated };
  }

  private async syncStrategyPositions(strategy: Strategy): Promise<{ synced: number; closed: number; imported: number; consolidated: number }> {
    const exchange = strategy.exchange || Exchange.BINANCE;
    const { apiKey, apiSecret } = await this.decryptCredentials(strategy);

    let positions: NormalizedPosition[];

    if (exchange === Exchange.BYBIT) {
      positions = await this.fetchBybitPositions(apiKey, apiSecret, strategy.isTestnet);
    } else {
      positions = await this.fetchBinancePositions(apiKey, apiSecret, strategy.isTestnet);
    }

    const openPositions = positions.filter(p => p.size !== 0);

    let synced = 0;
    let closed = 0;
    let imported = 0;
    let consolidated = 0;

    for (const position of openPositions) {
      const existingTrades = await this.tradesRepository.find({
        where: {
          strategyId: strategy.id,
          symbol: position.symbol,
          side: position.side,
          status: 'OPEN'
        },
        order: { timestamp: 'ASC' }
      });

      this.logger.debug(`[SYNC DEBUG] ${position.symbol} (${position.side}) - strategyId: ${strategy.id} - Found ${existingTrades.length} existing trades`);

      if (existingTrades.length === 0) {
        this.logger.debug(`[SYNC] No local trade for ${position.symbol} (${position.side}) - skipping (not auto-importing)`);
      } else if (existingTrades.length === 1) {
        await this.updateTradeFromPosition(existingTrades[0], position);
        synced++;
      } else {
        await this.consolidateTrades(existingTrades, position, exchange, apiKey, apiSecret, strategy.isTestnet);
        consolidated += existingTrades.length - 1;
        synced++;
        this.logger.log(`[SYNC] Consolidated ${existingTrades.length} trades into 1 for ${position.symbol}`);
      }
    }

    for (const position of openPositions) {
      const duplicateCheck = await this.tradesRepository.find({
        where: {
          strategyId: strategy.id,
          symbol: position.symbol,
          side: position.side,
          status: 'OPEN'
        },
        order: { timestamp: 'ASC' }
      });

      if (duplicateCheck.length > 1) {
        this.logger.warn(`[SYNC] Found ${duplicateCheck.length} duplicate trades for ${position.symbol} (${position.side}), consolidating...`);
        await this.consolidateTrades(duplicateCheck, position, exchange, apiKey, apiSecret, strategy.isTestnet);
        consolidated += duplicateCheck.length - 1;
        this.logger.log(`[SYNC] Consolidated ${duplicateCheck.length} trades into 1 for ${position.symbol}`);
      }
    }

    const allLocalOpenTrades = await this.tradesRepository.find({
      where: { strategyId: strategy.id, status: 'OPEN' }
    });

    this.logger.debug(`[SYNC] Found ${allLocalOpenTrades.length} local open trades to check against ${openPositions.length} positions`);

    for (const trade of allLocalOpenTrades) {
      const matchingPosition = openPositions.find(p =>
        p.symbol === trade.symbol && p.side === trade.side
      );

      if (!matchingPosition) {
        if (trade.type === 'LIMIT' && trade.exchangeOrderId) {
          const orderStatus = await this.checkOrderStatus(
            trade.exchangeOrderId,
            trade.symbol,
            exchange,
            apiKey,
            apiSecret,
            strategy.isTestnet
          );

          if (orderStatus === 'NEW' || orderStatus === 'PARTIALLY_FILLED') {
            this.logger.debug(`[SYNC] Trade ${trade.id} has pending LIMIT order (${orderStatus}), skipping close`);
            continue;
          }

          if (orderStatus === 'FILLED' || orderStatus === 'Filled') {
            this.logger.log(`[SYNC] Trade ${trade.id} order FILLED but no position - position was closed externally`);
          }
        }

        await this.closeTradeAsManual(trade, exchange, apiKey, apiSecret, strategy.isTestnet);
        closed++;
        this.logger.log(`[SYNC] Closed trade ${trade.id} for ${trade.symbol} - no longer exists on exchange`);
      }
    }

    return { synced, closed, imported, consolidated };
  }

  private async fetchBinancePositions(
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<NormalizedPosition[]> {
    const baseUrl = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

    try {
      const response = await axios.get(
        `${baseUrl}/fapi/v2/positionRisk?${queryString}&signature=${signature}`,
        {
          headers: { 'X-MBX-APIKEY': apiKey }
        }
      );

      return (response.data as BinancePosition[]).map(pos => {
        const posAmt = parseFloat(pos.positionAmt);
        return {
          symbol: pos.symbol,
          side: posAmt > 0 ? 'BUY' : 'SELL' as 'BUY' | 'SELL',
          size: Math.abs(posAmt),
          entryPrice: parseFloat(pos.entryPrice),
          unrealizedPnl: parseFloat(pos.unRealizedProfit),
          leverage: parseFloat(pos.leverage),
        };
      });
    } catch (error) {
      this.logger.error(`Failed to fetch Binance positions: ${error.message}`);
      throw error;
    }
  }

  private async fetchBybitPositions(
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<NormalizedPosition[]> {
    try {
      const positions = await this.bybitClient.getPositions(apiKey, apiSecret, isTestnet);

      return positions
        .filter(pos => pos.side !== 'None' && parseFloat(pos.size) !== 0)
        .map(pos => ({
          symbol: pos.symbol,
          side: pos.side === 'Buy' ? 'BUY' : 'SELL' as 'BUY' | 'SELL',
          size: parseFloat(pos.size),
          entryPrice: parseFloat(pos.avgPrice),
          unrealizedPnl: parseFloat(pos.unrealisedPnl),
          leverage: parseFloat(pos.leverage),
        }));
    } catch (error) {
      this.logger.error(`Failed to fetch Bybit positions: ${error.message}`);
      throw error;
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
      this.logger.error(`Failed to check order status for ${orderId}: ${error.message}`);
      return null;
    }
  }

  private async consolidateTrades(
    trades: Trade[],
    position: NormalizedPosition,
    exchange: Exchange,
    apiKey?: string,
    apiSecret?: string,
    isTestnet?: boolean
  ): Promise<Trade> {
    trades.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const primaryTrade = trades[0];
    const duplicateTrades = trades.slice(1);

    primaryTrade.quantity = position.size as any;
    primaryTrade.entryPrice = position.entryPrice as any;
    primaryTrade.pnl = position.unrealizedPnl as any;
    primaryTrade.binancePositionAmt = position.size as any;

    await this.tradesRepository.save(primaryTrade);

    for (const trade of duplicateTrades) {
      if (apiKey && apiSecret && isTestnet !== undefined) {
        await this.cancelOpenOrders(trade, exchange, apiKey, apiSecret, isTestnet);
      }

      trade.status = 'CLOSED';
      trade.closeReason = 'MANUAL';
      trade.closedAt = new Date();
      trade.pnl = 0 as any;
      trade.binancePositionAmt = 0 as any;
      trade.exitPrice = trade.entryPrice;
      trade.stopLossOrderId = null;
      trade.takeProfitOrderId = null;
      await this.tradesRepository.save(trade);

      this.logger.debug(`[CONSOLIDATE] Closed duplicate trade ${trade.id} for ${trade.symbol}`);
    }

    this.logger.log(
      `[CONSOLIDATE] ${primaryTrade.symbol} | Qty: ${position.size} | Entry: ${position.entryPrice} | P&L: ${position.unrealizedPnl.toFixed(4)}`
    );

    return primaryTrade;
  }

  private async getLastTradePrice(
    symbol: string,
    exchange: Exchange,
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<number | null> {
    if (exchange === Exchange.BYBIT) {
      return await this.bybitClient.getLastTradePrice(apiKey, apiSecret, isTestnet, symbol);
    }

    const baseUrl = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;
    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&limit=1&timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

    try {
      const response = await axios.get(
        `${baseUrl}/fapi/v1/userTrades?${queryString}&signature=${signature}`,
        {
          headers: { 'X-MBX-APIKEY': apiKey }
        }
      );

      if (response.data && response.data.length > 0) {
        return parseFloat(response.data[0].price);
      }
      return null;
    } catch (error) {
      this.logger.error(`Failed to get last trade price: ${error.message}`);
      return null;
    }
  }

  private async closeTradeAsManual(
    trade: Trade,
    exchange: Exchange,
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<void> {
    await this.cancelOpenOrders(trade, exchange, apiKey, apiSecret, isTestnet);

    const exitPrice = await this.getLastTradePrice(trade.symbol, exchange, apiKey, apiSecret, isTestnet);
    const currentPrice = exitPrice || await this.getCurrentPrice(trade.symbol, exchange, isTestnet);

    const entryPrice = parseFloat(trade.entryPrice as any);
    const quantity = parseFloat(trade.quantity as any);

    let pnl: number;
    if (trade.side === 'BUY') {
      pnl = (currentPrice - entryPrice) * quantity;
    } else {
      pnl = (entryPrice - currentPrice) * quantity;
    }

    trade.status = 'CLOSED';
    trade.exitPrice = currentPrice as any;
    trade.pnl = pnl as any;
    trade.closeReason = 'MANUAL';
    trade.closedAt = new Date();
    trade.binancePositionAmt = 0 as any;
    trade.stopLossOrderId = null;
    trade.takeProfitOrderId = null;

    await this.tradesRepository.save(trade);
  }

  private async cancelOpenOrders(
    trade: Trade,
    exchange: Exchange,
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<void> {
    if (exchange === Exchange.BYBIT) {
      if (trade.stopLossOrderId && !trade.stopLossOrderId.startsWith('BYBIT_')) {
        await this.bybitClient.cancelOrder(apiKey, apiSecret, isTestnet, trade.symbol, trade.stopLossOrderId);
      }
      if (trade.takeProfitOrderId && !trade.takeProfitOrderId.startsWith('BYBIT_')) {
        await this.bybitClient.cancelOrder(apiKey, apiSecret, isTestnet, trade.symbol, trade.takeProfitOrderId);
      }
      return;
    }

    const baseUrl = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;

    if (trade.stopLossOrderId) {
      try {
        const timestamp = Date.now();
        const queryString = `symbol=${trade.symbol}&orderId=${trade.stopLossOrderId}&timestamp=${timestamp}`;
        const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

        await axios.delete(
          `${baseUrl}/fapi/v1/order?${queryString}&signature=${signature}`,
          { headers: { 'X-MBX-APIKEY': apiKey } }
        );
        this.logger.log(`[CANCEL] Cancelled SL order ${trade.stopLossOrderId} for ${trade.symbol}`);
      } catch (error: any) {
        if (error.response?.data?.code !== -2011) {
          this.logger.debug(`[CANCEL] Could not cancel SL order: ${error.response?.data?.msg || error.message}`);
        }
      }
    }

    if (trade.takeProfitOrderId) {
      try {
        const timestamp = Date.now();
        const queryString = `symbol=${trade.symbol}&orderId=${trade.takeProfitOrderId}&timestamp=${timestamp}`;
        const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

        await axios.delete(
          `${baseUrl}/fapi/v1/order?${queryString}&signature=${signature}`,
          { headers: { 'X-MBX-APIKEY': apiKey } }
        );
        this.logger.log(`[CANCEL] Cancelled TP order ${trade.takeProfitOrderId} for ${trade.symbol}`);
      } catch (error: any) {
        if (error.response?.data?.code !== -2011) {
          this.logger.debug(`[CANCEL] Could not cancel TP order: ${error.response?.data?.msg || error.message}`);
        }
      }
    }
  }

  private async updateTradeFromPosition(trade: Trade, position: NormalizedPosition): Promise<void> {
    trade.pnl = position.unrealizedPnl as any;
    trade.binancePositionAmt = position.size as any;
    trade.quantity = position.size as any;
    trade.entryPrice = position.entryPrice as any;

    await this.tradesRepository.save(trade);

    this.logger.debug(
      `[SYNC] ${trade.symbol} | P&L: ${position.unrealizedPnl.toFixed(4)} | Qty: ${position.size} | Entry: ${position.entryPrice}`
    );
  }

  private async getCurrentPrice(symbol: string, exchange: Exchange, isTestnet: boolean): Promise<number> {
    if (exchange === Exchange.BYBIT) {
      return await this.bybitClient.getCurrentPrice(isTestnet, symbol);
    }

    const baseUrl = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;

    try {
      const response = await axios.get(`${baseUrl}/fapi/v1/ticker/price?symbol=${symbol}`);
      return parseFloat(response.data.price);
    } catch (error) {
      this.logger.error(`Failed to get current price for ${symbol}: ${error.message}`);
      return 0;
    }
  }

  private async decryptCredentials(strategy: Strategy) {
    const [apiKey, apiSecret] = await Promise.all([
      EncryptionUtil.decrypt(strategy.apiKey),
      EncryptionUtil.decrypt(strategy.apiSecret)
    ]);

    return {
      apiKey: apiKey.trim(),
      apiSecret: apiSecret.trim()
    };
  }
}
