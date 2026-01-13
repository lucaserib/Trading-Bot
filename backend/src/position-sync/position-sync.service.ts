import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Trade } from '../strategies/trade.entity';
import { Strategy, Exchange } from '../strategies/strategy.entity';
import { StrategiesService } from '../strategies/strategies.service';
import { ExchangeService } from '../exchange/exchange.service';
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

    if (exchange !== Exchange.BINANCE) {
      return { synced: 0, closed: 0, imported: 0, consolidated: 0 };
    }

    const { apiKey, apiSecret } = await this.decryptCredentials(strategy);

    const binancePositions = await this.fetchBinancePositions(
      apiKey,
      apiSecret,
      strategy.isTestnet
    );

    const openPositions = binancePositions.filter(p => parseFloat(p.positionAmt) !== 0);

    let synced = 0;
    let closed = 0;
    let imported = 0;
    let consolidated = 0;

    // Process each Binance position with FRESH queries to prevent race conditions
    for (const binancePos of openPositions) {
      const posAmt = parseFloat(binancePos.positionAmt);
      const posSide: 'BUY' | 'SELL' = posAmt > 0 ? 'BUY' : 'SELL';

      // ALWAYS do a fresh query - never rely on cached/stale data
      const existingTrades = await this.tradesRepository.find({
        where: {
          strategyId: strategy.id,
          symbol: binancePos.symbol,
          side: posSide,
          status: 'OPEN'
        },
        order: { timestamp: 'ASC' }
      });

      this.logger.debug(`[SYNC DEBUG] ${binancePos.symbol} (${posSide}) - strategyId: ${strategy.id} - Found ${existingTrades.length} existing trades`);

      if (existingTrades.length === 0) {
        // No local trade for this position - DO NOT auto-import
        // Only trades created by webhooks should be tracked
        // This prevents duplicate imports when multiple strategies share the same Binance account
        this.logger.debug(`[SYNC] No local trade for ${binancePos.symbol} (${posSide}) - skipping (not auto-importing)`);
      } else if (existingTrades.length === 1) {
        // Single trade - update with Binance data
        await this.updateTradeFromBinance(existingTrades[0], binancePos);
        synced++;
      } else {
        // Multiple trades - consolidate into one
        await this.consolidateTrades(existingTrades, binancePos, apiKey, apiSecret, strategy.isTestnet);
        consolidated += existingTrades.length - 1;
        synced++;
        this.logger.log(`[SYNC] Consolidated ${existingTrades.length} trades into 1 for ${binancePos.symbol}`);
      }
    }

    // Additional check: consolidate any remaining duplicates
    // This handles race conditions where multiple trades were created for the same position
    for (const binancePos of openPositions) {
      const posAmt = parseFloat(binancePos.positionAmt);
      const posSide: 'BUY' | 'SELL' = posAmt > 0 ? 'BUY' : 'SELL';

      const duplicateCheck = await this.tradesRepository.find({
        where: {
          strategyId: strategy.id,
          symbol: binancePos.symbol,
          side: posSide,
          status: 'OPEN'
        },
        order: { timestamp: 'ASC' }
      });

      if (duplicateCheck.length > 1) {
        this.logger.warn(`[SYNC] Found ${duplicateCheck.length} duplicate trades for ${binancePos.symbol} (${posSide}), consolidating...`);
        await this.consolidateTrades(duplicateCheck, binancePos, apiKey, apiSecret, strategy.isTestnet);
        consolidated += duplicateCheck.length - 1;
        this.logger.log(`[SYNC] Consolidated ${duplicateCheck.length} trades into 1 for ${binancePos.symbol}`);
      }
    }

    // Close trades that no longer exist on Binance
    const allLocalOpenTrades = await this.tradesRepository.find({
      where: { strategyId: strategy.id, status: 'OPEN' }
    });

    this.logger.debug(`[SYNC] Found ${allLocalOpenTrades.length} local open trades to check against ${openPositions.length} Binance positions`);

    for (const trade of allLocalOpenTrades) {
      const binancePos = openPositions.find(p => {
        const posAmt = parseFloat(p.positionAmt);
        const posSide = posAmt > 0 ? 'BUY' : 'SELL';
        return p.symbol === trade.symbol && posSide === trade.side;
      });

      if (!binancePos) {
        // Before closing, check if this trade has a pending LIMIT order on Binance
        if (trade.type === 'LIMIT' && trade.exchangeOrderId) {
          const orderStatus = await this.checkOrderStatus(
            trade.exchangeOrderId,
            trade.symbol,
            apiKey,
            apiSecret,
            strategy.isTestnet
          );

          if (orderStatus === 'NEW' || orderStatus === 'PARTIALLY_FILLED') {
            this.logger.debug(`[SYNC] Trade ${trade.id} has pending LIMIT order (${orderStatus}), skipping close`);
            continue;
          }

          // If order was FILLED but no position exists, the position was closed externally
          // We should close the trade and retrieve the actual exit price
          if (orderStatus === 'FILLED') {
            this.logger.log(`[SYNC] Trade ${trade.id} order FILLED but no position - position was closed externally`);
            // Don't skip - fall through to close the trade
          }
        }

        await this.closeTradeAsManual(trade, apiKey, apiSecret, strategy.isTestnet);
        closed++;
        this.logger.log(`[SYNC] Closed trade ${trade.id} for ${trade.symbol} - no longer exists on Binance`);
      }
    }

    return { synced, closed, imported, consolidated };
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
      this.logger.error(`Failed to check order status for ${orderId}: ${error.message}`);
      return null;
    }
  }

  private groupTradesBySymbolAndSide(trades: Trade[]): Map<string, Trade[]> {
    const groups = new Map<string, Trade[]>();

    for (const trade of trades) {
      const key = `${trade.symbol}|${trade.side}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(trade);
    }

    return groups;
  }

  private async consolidateTrades(
    trades: Trade[],
    binancePos: BinancePosition,
    apiKey?: string,
    apiSecret?: string,
    isTestnet?: boolean
  ): Promise<Trade> {
    trades.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const primaryTrade = trades[0];
    const duplicateTrades = trades.slice(1);

    const binanceQty = Math.abs(parseFloat(binancePos.positionAmt));
    const binanceEntryPrice = parseFloat(binancePos.entryPrice);
    const unrealizedPnL = parseFloat(binancePos.unRealizedProfit);

    primaryTrade.quantity = binanceQty as any;
    primaryTrade.entryPrice = binanceEntryPrice as any;
    primaryTrade.pnl = unrealizedPnL as any;
    primaryTrade.binancePositionAmt = binanceQty as any;

    await this.tradesRepository.save(primaryTrade);

    for (const trade of duplicateTrades) {
      // Cancel SL/TP orders for duplicate trades
      if (apiKey && apiSecret && isTestnet !== undefined) {
        await this.cancelOpenOrders(trade, apiKey, apiSecret, isTestnet);
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
      `[CONSOLIDATE] ${primaryTrade.symbol} | Binance Qty: ${binanceQty} | Entry: ${binanceEntryPrice} | P&L: ${unrealizedPnL.toFixed(4)}`
    );

    return primaryTrade;
  }

  private async fetchBinancePositions(
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<BinancePosition[]> {
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
      return response.data;
    } catch (error) {
      this.logger.error(`Failed to fetch Binance positions: ${error.message}`);
      throw error;
    }
  }

  private async getLastTradePrice(
    symbol: string,
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<number | null> {
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
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<void> {
    // Cancel any open SL/TP orders on Binance before closing
    await this.cancelOpenOrders(trade, apiKey, apiSecret, isTestnet);

    const exitPrice = await this.getLastTradePrice(trade.symbol, apiKey, apiSecret, isTestnet);
    const currentPrice = exitPrice || await this.getCurrentPrice(trade.symbol, isTestnet);

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
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<void> {
    const baseUrl = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;

    // Cancel Stop Loss order if exists
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
        // Order may already be filled, cancelled, or expired - that's OK
        if (error.response?.data?.code !== -2011) {
          this.logger.debug(`[CANCEL] Could not cancel SL order: ${error.response?.data?.msg || error.message}`);
        }
      }
    }

    // Cancel Take Profit order if exists
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
        // Order may already be filled, cancelled, or expired - that's OK
        if (error.response?.data?.code !== -2011) {
          this.logger.debug(`[CANCEL] Could not cancel TP order: ${error.response?.data?.msg || error.message}`);
        }
      }
    }
  }

  private async updateTradeFromBinance(trade: Trade, binancePos: BinancePosition): Promise<void> {
    const unrealizedPnL = parseFloat(binancePos.unRealizedProfit);
    const positionAmt = Math.abs(parseFloat(binancePos.positionAmt));
    const binanceEntryPrice = parseFloat(binancePos.entryPrice);

    trade.pnl = unrealizedPnL as any;
    trade.binancePositionAmt = positionAmt as any;
    trade.quantity = positionAmt as any;
    trade.entryPrice = binanceEntryPrice as any;

    await this.tradesRepository.save(trade);

    this.logger.debug(
      `[SYNC] ${trade.symbol} | Binance P&L: ${unrealizedPnL.toFixed(4)} | Qty: ${positionAmt} | Entry: ${binanceEntryPrice}`
    );
  }

  private async importPositionFromBinance(
    strategyId: string,
    binancePos: BinancePosition
  ): Promise<void> {
    const positionAmt = parseFloat(binancePos.positionAmt);
    const side: 'BUY' | 'SELL' = positionAmt > 0 ? 'BUY' : 'SELL';

    const trade: Partial<Trade> = {
      strategyId,
      symbol: binancePos.symbol,
      side,
      type: 'MARKET',
      entryPrice: parseFloat(binancePos.entryPrice) as any,
      quantity: Math.abs(positionAmt) as any,
      pnl: parseFloat(binancePos.unRealizedProfit) as any,
      status: 'OPEN',
      binancePositionAmt: Math.abs(positionAmt) as any,
    };

    await this.tradesRepository.save(trade);
  }

  private async getCurrentPrice(symbol: string, isTestnet: boolean): Promise<number> {
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
