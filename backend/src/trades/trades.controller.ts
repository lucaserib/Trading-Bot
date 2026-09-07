import { Controller, Get, Post, Query, Param, Logger } from '@nestjs/common';
import { TradesService } from './trades.service';
import { PositionSyncService } from '../position-sync/position-sync.service';
import { StrategiesService } from '../strategies/strategies.service';
import { EncryptionUtil } from '../utils/encryption.util';
import { BinanceRequestUtil } from '../utils/binance-request.util';
import { Exchange } from '../strategies/strategy.entity';
import { BybitClientService } from '../exchange/bybit-client.service';
import { Trade } from '../strategies/trade.entity';
import { ExecutionType } from './trade-execution.entity';
import { CredentialsResolverService } from '../common/credentials-resolver.service';
import axios from 'axios';
import * as crypto from 'crypto';
import Decimal from 'decimal.js';

interface SymbolRules {
  qtyStep: number;
  minQty: number;
  priceTick: number;
}

@Controller('trades')
export class TradesController {
  private readonly logger = new Logger(TradesController.name);
  private readonly BINANCE_TESTNET_URL = 'https://testnet.binancefuture.com';
  private readonly BINANCE_MAINNET_URL = 'https://fapi.binance.com';

  constructor(
    private readonly tradesService: TradesService,
    private readonly positionSyncService: PositionSyncService,
    private readonly strategiesService: StrategiesService,
    private readonly bybitClient: BybitClientService,
    private readonly credentialsResolver: CredentialsResolverService,
  ) {}

  @Get()
  async findAll(@Query('status') status?: string, @Query('limit') limit?: string, @Query('portfolioId') portfolioId?: string) {
    try {
      return await this.tradesService.findAll(status, limit ? parseInt(limit) : undefined, portfolioId);
    } catch (error: any) {
      this.logger.error(`Failed to fetch trades: ${error.message}`);
      return [];
    }
  }

  @Get('stats')
  async getStats(@Query('portfolioId') portfolioId?: string) {
    try {
      return await this.tradesService.getStats(portfolioId);
    } catch (error: any) {
      this.logger.error(`Failed to fetch stats: ${error.message}`);
      return {
        totalPnL: 0,
        realizedPnL: 0,
        unrealizedPnL: 0,
        activePositions: 0,
        winRate: 0,
        totalTrades: 0,
        wins: 0,
        losses: 0,
        recentSignals: [],
        openPositions: []
      };
    }
  }

  @Get(':id/executions')
  async getTradeExecutions(@Param('id') id: string) {
    try {
      this.logger.log(`[EXECUTIONS] Fetching executions for trade ${id}`);

      const trade = await this.tradesService.findById(id);
      if (!trade) {
        this.logger.warn(`[EXECUTIONS] Trade ${id} not found`);
        return [];
      }

      let executions = await this.tradesService.findExecutions(id);

      if (executions.length === 0 && trade.status !== 'ERROR') {
        this.logger.warn(`[EXECUTIONS] No executions found for trade ${id}. Creating ENTRY execution from trade data.`);

        await this.tradesService.createExecution({
          tradeId: trade.id,
          type: ExecutionType.ENTRY,
          price: trade.entryPrice,
          quantity: trade.quantity,
          pnl: null,
          percentOfPosition: null,
          exchangeOrderId: trade.exchangeOrderId,
          executedAt: trade.timestamp
        });

        if (trade.status === 'CLOSED' && trade.exitPrice && trade.closedAt) {
          const closeType = this.getCloseExecutionType(trade.closeReason);

          await this.tradesService.createExecution({
            tradeId: trade.id,
            type: closeType,
            price: trade.exitPrice,
            quantity: trade.quantity,
            pnl: trade.pnl,
            percentOfPosition: 100,
            exchangeOrderId: null,
            executedAt: trade.closedAt
          });
        }

        executions = await this.tradesService.findExecutions(id);
        this.logger.log(`[EXECUTIONS] Created missing executions. Total: ${executions.length}`);
      }

      this.logger.log(`[EXECUTIONS] Returning ${executions.length} executions for trade ${id}`);
      return executions;
    } catch (error: any) {
      this.logger.error(`[EXECUTIONS] Failed to fetch executions for trade ${id}: ${error.message}`, error.stack);
      return [];
    }
  }

  private getCloseExecutionType(closeReason?: string): ExecutionType {
    if (!closeReason) return ExecutionType.MANUAL_CLOSE;

    switch (closeReason) {
      case 'TAKE_PROFIT_1':
        return ExecutionType.TAKE_PROFIT_1;
      case 'TAKE_PROFIT_2':
        return ExecutionType.TAKE_PROFIT_2;
      case 'TAKE_PROFIT_3':
        return ExecutionType.TAKE_PROFIT_3;
      case 'STOP_LOSS':
        return ExecutionType.STOP_LOSS;
      case 'SIGNAL':
        return ExecutionType.SIGNAL_CLOSE;
      default:
        return ExecutionType.MANUAL_CLOSE;
    }
  }

  @Post('sync')
  async forceSync() {
    const result = await this.positionSyncService.forceSync();
    return {
      success: true,
      message: 'Sync completed',
      ...result,
      lastSyncTime: this.positionSyncService.getLastSyncTime()
    };
  }

  @Get('sync/status')
  getSyncStatus() {
    return {
      lastSyncTime: this.positionSyncService.getLastSyncTime()
    };
  }

  @Post('close-all')
  async closeAllPositions(@Query('portfolioId') portfolioId?: string) {
    const openTrades = await this.tradesService.findOpenTrades(portfolioId);
    const results: { closed: number; errors: string[]; alreadyClosed: number } = {
      closed: 0,
      errors: [],
      alreadyClosed: 0
    };

    const strategiesMap = new Map();

    for (const trade of openTrades) {
      try {
        let strategy = strategiesMap.get(trade.strategyId);
        if (!strategy) {
          strategy = await this.strategiesService.findOne(trade.strategyId);
          if (strategy) {
            strategiesMap.set(trade.strategyId, strategy);
          }
        }

        if (!strategy) {
          await this.tradesService.updateTrade(trade.id, {
            status: 'CLOSED',
            closeReason: 'MANUAL',
            closedAt: new Date(),
            error: 'Strategy not found - marked as closed'
          });
          results.errors.push(`Strategy not found for trade ${trade.id} - marked as closed`);
          continue;
        }

        const credentials = await this.credentialsResolver.resolveCredentials(strategy);
        const resolvedStrategy = { ...strategy, ...credentials };
        const exchange = resolvedStrategy.exchange || Exchange.BINANCE;
        const decryptedKey = (await EncryptionUtil.decrypt(resolvedStrategy.apiKey)).trim();
        const decryptedSecret = (await EncryptionUtil.decrypt(resolvedStrategy.apiSecret)).trim();

        const closeResult = await this.closeTradeOnExchange(
          trade,
          resolvedStrategy,
          exchange,
          decryptedKey,
          decryptedSecret
        );

        if (closeResult.success) {
          results.closed++;
        } else if (closeResult.alreadyClosed) {
          results.alreadyClosed++;
        } else {
          results.errors.push(`Trade ${trade.id}: ${closeResult.error}`);
        }

      } catch (error: any) {
        this.logger.error(`Failed to close trade ${trade.id}: ${error.message}`);
        results.errors.push(`Trade ${trade.id}: ${error.message}`);
      }
    }

    return {
      success: true,
      message: `Closed ${results.closed} positions, ${results.alreadyClosed} already closed`,
      ...results
    };
  }

  @Post('close/:tradeId')
  async closePosition(@Param('tradeId') tradeId: string) {
    const trade = await this.tradesService.findOpenTrades()
      .then(trades => trades.find(t => t.id === tradeId));

    if (!trade) {
      return { success: false, message: 'Trade not found or already closed' };
    }

    const strategy = await this.strategiesService.findOne(trade.strategyId);
    if (!strategy) {
      await this.tradesService.updateTrade(trade.id, {
        status: 'CLOSED',
        closeReason: 'MANUAL',
        closedAt: new Date(),
        error: 'Strategy not found'
      });
      return { success: false, message: 'Strategy not found - trade marked as closed' };
    }

    const credentials = await this.credentialsResolver.resolveCredentials(strategy);
    const resolvedStrategy = { ...strategy, ...credentials };
    const exchange = resolvedStrategy.exchange || Exchange.BINANCE;
    const decryptedKey = (await EncryptionUtil.decrypt(resolvedStrategy.apiKey)).trim();
    const decryptedSecret = (await EncryptionUtil.decrypt(resolvedStrategy.apiSecret)).trim();

    const result = await this.closeTradeOnExchange(
      trade,
      resolvedStrategy,
      exchange,
      decryptedKey,
      decryptedSecret
    );

    if (result.success) {
      return { success: true, message: 'Position closed', pnl: result.pnl };
    } else if (result.alreadyClosed) {
      return { success: true, message: 'Position was already closed on exchange', pnl: result.pnl };
    } else {
      return { success: false, message: result.error };
    }
  }

  private async closeTradeOnExchange(
    trade: Trade,
    strategy: any,
    exchange: Exchange,
    apiKey: string,
    apiSecret: string
  ): Promise<{ success: boolean; alreadyClosed?: boolean; pnl?: number; error?: string }> {

    try {
      this.logger.log(`[CLOSE] Starting to close trade ${trade.id} for ${trade.symbol} (hedgeMode: ${strategy.hedgeMode})`);

      await this.cancelAllOrders(trade.symbol, exchange, apiKey, apiSecret, strategy.isTestnet, strategy.hedgeMode, trade.side);

      const positionSize = await this.getPositionSize(
        trade.symbol,
        exchange,
        apiKey,
        apiSecret,
        strategy.isTestnet,
        strategy.hedgeMode,
        trade.side
      );

      this.logger.log(`[CLOSE] Position size on exchange: ${positionSize}`);

      const exitPrice = await this.getCurrentPrice(trade.symbol, exchange, strategy.isTestnet);
      const entryPrice = parseFloat(trade.entryPrice as any);
      const dbQuantity = parseFloat(trade.quantity as any);

      if (positionSize === 0) {
        this.logger.warn(`[CLOSE] Position already closed on exchange for ${trade.symbol}`);

        let pnl = trade.pnl ? parseFloat(trade.pnl as any) : 0;

        await this.tradesService.updateTrade(trade.id, {
          status: 'CLOSED',
          exitPrice: exitPrice || entryPrice,
          pnl,
          closeReason: 'MANUAL',
          closedAt: new Date()
        });

        return { success: false, alreadyClosed: true, pnl };
      }

      const rules = await this.getSymbolRules(trade.symbol, strategy.isTestnet, exchange);
      const closeSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
      const formattedQty = this.normalizeQuantity(positionSize, rules.qtyStep, rules.minQty);

      this.logger.log(`[CLOSE] Closing ${trade.symbol}: side=${closeSide}, qty=${formattedQty}`);

      if (exchange === Exchange.BYBIT) {
        const originalSide = trade.side === 'BUY' ? 'Buy' : 'Sell';
        const positionIdx = await this.bybitClient.getPositionIdx(
          apiKey, apiSecret, strategy.isTestnet, trade.symbol, originalSide, strategy.hedgeMode
        );

        await this.bybitClient.createOrder(apiKey, apiSecret, strategy.isTestnet, {
          symbol: trade.symbol,
          side: closeSide === 'BUY' ? 'Buy' : 'Sell',
          orderType: 'Market',
          qty: formattedQty,
          positionIdx,
          reduceOnly: true,
          hedgeMode: strategy.hedgeMode
        });
      } else {
        await this.closeBinancePosition(
          trade.symbol,
          closeSide,
          formattedQty,
          apiKey,
          apiSecret,
          strategy.isTestnet,
          strategy.hedgeMode,
          trade.side
        );
      }

      let pnl: number;
      if (trade.side === 'BUY') {
        pnl = (exitPrice - entryPrice) * positionSize;
      } else {
        pnl = (entryPrice - exitPrice) * positionSize;
      }

      await this.tradesService.updateTrade(trade.id, {
        status: 'CLOSED',
        pnl,
        exitPrice,
        closeReason: 'MANUAL',
        closedAt: new Date()
      });

      await this.tradesService.createExecution({
        tradeId: trade.id,
        type: ExecutionType.MANUAL_CLOSE,
        price: exitPrice,
        quantity: positionSize,
        pnl: pnl,
        percentOfPosition: 100,
        exchangeOrderId: null
      });

      this.logger.log(`[CLOSE] Trade ${trade.id} closed successfully with P&L: ${pnl}`);

      return { success: true, pnl };

    } catch (error: any) {
      this.logger.error(`[CLOSE] Error closing trade ${trade.id}: ${error.message}`);

      if (error.response?.data) {
        this.logger.error(`[CLOSE] Exchange response: ${JSON.stringify(error.response.data)}`);
      }

      return { success: false, error: error.message };
    }
  }

  private async cancelAllOrders(
    symbol: string,
    exchange: Exchange,
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean,
    hedgeMode: boolean = false,
    tradeSide?: string
  ): Promise<void> {
    try {
      if (exchange === Exchange.BYBIT) {
        await this.bybitClient.cancelAllOrders(apiKey, apiSecret, isTestnet, symbol);
      } else {
        const baseURL = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;

        // First, get all open orders to filter by position side if in hedge mode
        if (hedgeMode && tradeSide) {
          const positionSide = tradeSide === 'BUY' ? 'LONG' : 'SHORT';

          // Get open orders first
          const getParams = new URLSearchParams();
          getParams.append('symbol', symbol);
          getParams.append('timestamp', Date.now().toString());
          const getQuery = getParams.toString();
          const getSig = crypto.createHmac('sha256', apiSecret).update(getQuery).digest('hex');

          const ordersResponse = await BinanceRequestUtil.get(
            `${baseURL}/fapi/v1/openOrders?${getQuery}&signature=${getSig}`,
            { headers: { 'X-MBX-APIKEY': apiKey } }
          );

          // Cancel orders for this position side, including BOTH for One-Way Mode
          const ordersToCancel = ordersResponse.data.filter(
            (order: any) => order.positionSide === positionSide || order.positionSide === 'BOTH'
          );

          this.logger.log(`[CLOSE] Found ${ordersToCancel.length} orders to cancel (${positionSide} or BOTH)`);

          // Cancel regular orders (LIMIT, etc)
          for (const order of ordersToCancel) {
            try {
              const cancelParams = new URLSearchParams();
              cancelParams.append('symbol', symbol);
              cancelParams.append('orderId', order.orderId.toString());
              cancelParams.append('timestamp', Date.now().toString());
              const cancelQuery = cancelParams.toString();
              const cancelSig = crypto.createHmac('sha256', apiSecret).update(cancelQuery).digest('hex');

              await BinanceRequestUtil.delete(`${baseURL}/fapi/v1/order?${cancelQuery}&signature=${cancelSig}`, {
                headers: { 'X-MBX-APIKEY': apiKey }
              });
              this.logger.log(`[CLOSE] Cancelled order ${order.orderId}`);
            } catch (e: any) {
              this.logger.warn(`[CLOSE] Failed to cancel order ${order.orderId}: ${e.message}`);
            }
          }

          // Also cancel Algo Orders (CONDITIONAL - STOP_MARKET, etc)
          try {
            const algoParams = new URLSearchParams();
            algoParams.append('symbol', symbol);
            algoParams.append('timestamp', Date.now().toString());
            const algoQuery = algoParams.toString();
            const algoSig = crypto.createHmac('sha256', apiSecret).update(algoQuery).digest('hex');

            const algoOrdersResponse = await BinanceRequestUtil.get(
              `${baseURL}/fapi/v1/openAlgoOrders?${algoQuery}&signature=${algoSig}`,
              { headers: { 'X-MBX-APIKEY': apiKey } }
            );

            // Filter by positionSide, including BOTH for One-Way Mode
            const algoOrdersToCancel = algoOrdersResponse.data.filter(
              (order: any) => order.positionSide === positionSide || order.positionSide === 'BOTH'
            );

            this.logger.log(`[CLOSE] Found ${algoOrdersToCancel.length} algo orders to cancel (${positionSide} or BOTH)`);

            for (const algoOrder of algoOrdersToCancel) {
              try {
                const cancelAlgoParams = new URLSearchParams();
                cancelAlgoParams.append('algoId', algoOrder.algoId.toString());
                cancelAlgoParams.append('timestamp', Date.now().toString());
                const cancelAlgoQuery = cancelAlgoParams.toString();
                const cancelAlgoSig = crypto.createHmac('sha256', apiSecret).update(cancelAlgoQuery).digest('hex');

                await BinanceRequestUtil.delete(`${baseURL}/fapi/v1/algoOrder?${cancelAlgoQuery}&signature=${cancelAlgoSig}`, {
                  headers: { 'X-MBX-APIKEY': apiKey }
                });
                this.logger.log(`[CLOSE] Cancelled algo order ${algoOrder.algoId}`);
              } catch (e: any) {
                this.logger.warn(`[CLOSE] Failed to cancel algo order ${algoOrder.algoId}: ${e.message}`);
              }
            }
          } catch (e: any) {
            this.logger.warn(`[CLOSE] Failed to fetch/cancel algo orders: ${e.message}`);
          }
        } else {
          // One-way mode: cancel all orders for symbol
          const params = new URLSearchParams();
          params.append('symbol', symbol);
          params.append('timestamp', Date.now().toString());

          const queryString = params.toString();
          const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

          // Cancel all regular orders
          await BinanceRequestUtil.delete(`${baseURL}/fapi/v1/allOpenOrders?${queryString}&signature=${signature}`, {
            headers: { 'X-MBX-APIKEY': apiKey }
          });

          // Also cancel all Algo Orders (CONDITIONAL)
          try {
            const algoParams = new URLSearchParams();
            algoParams.append('symbol', symbol);
            algoParams.append('timestamp', Date.now().toString());
            const algoQuery = algoParams.toString();
            const algoSig = crypto.createHmac('sha256', apiSecret).update(algoQuery).digest('hex');

            const algoOrdersResponse = await BinanceRequestUtil.get(
              `${baseURL}/fapi/v1/openAlgoOrders?${algoQuery}&signature=${algoSig}`,
              { headers: { 'X-MBX-APIKEY': apiKey } }
            );

            for (const algoOrder of algoOrdersResponse.data) {
              try {
                const cancelAlgoParams = new URLSearchParams();
                cancelAlgoParams.append('algoId', algoOrder.algoId.toString());
                cancelAlgoParams.append('timestamp', Date.now().toString());
                const cancelAlgoQuery = cancelAlgoParams.toString();
                const cancelAlgoSig = crypto.createHmac('sha256', apiSecret).update(cancelAlgoQuery).digest('hex');

                await BinanceRequestUtil.delete(`${baseURL}/fapi/v1/algoOrder?${cancelAlgoQuery}&signature=${cancelAlgoSig}`, {
                  headers: { 'X-MBX-APIKEY': apiKey }
                });
                this.logger.log(`[CLOSE] Cancelled algo order ${algoOrder.algoId}`);
              } catch (e: any) {
                this.logger.warn(`[CLOSE] Failed to cancel algo order ${algoOrder.algoId}: ${e.message}`);
              }
            }
          } catch (e: any) {
            this.logger.warn(`[CLOSE] Failed to fetch/cancel algo orders: ${e.message}`);
          }
        }
      }
      this.logger.log(`[CLOSE] Cancelled all orders for ${symbol}`);
    } catch (error: any) {
      this.logger.warn(`[CLOSE] Failed to cancel orders for ${symbol}: ${error.message}`);
    }
  }

  private async getPositionSize(
    symbol: string,
    exchange: Exchange,
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean,
    hedgeMode: boolean = false,
    tradeSide?: string
  ): Promise<number> {
    try {
      if (exchange === Exchange.BYBIT) {
        const positions = await this.bybitClient.getPositions(apiKey, apiSecret, isTestnet, symbol);
        const position = positions.find((p: any) => p.symbol === symbol && parseFloat(p.size) > 0);
        return position ? Math.abs(parseFloat(position.size)) : 0;
      } else {
        const baseURL = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;
        const params = new URLSearchParams();
        params.append('symbol', symbol);
        params.append('timestamp', Date.now().toString());

        const queryString = params.toString();
        const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

        const response = await BinanceRequestUtil.get(
          `${baseURL}/fapi/v2/positionRisk?${queryString}&signature=${signature}`,
          { headers: { 'X-MBX-APIKEY': apiKey } }
        );

        // Try hedge mode first if configured
        if (hedgeMode && tradeSide) {
          const positionSide = tradeSide === 'BUY' ? 'LONG' : 'SHORT';
          let position = response.data.find(
            (p: any) => p.symbol === symbol && p.positionSide === positionSide
          );

          // If not found, try One-Way Mode (BOTH) as fallback
          if (!position) {
            this.logger.log(`[CLOSE] Position not found with ${positionSide}, trying One-Way Mode (BOTH)`);
            position = response.data.find(
              (p: any) => p.symbol === symbol && p.positionSide === 'BOTH' && parseFloat(p.positionAmt) !== 0
            );
          }

          if (position) {
            this.logger.log(`[CLOSE] Position found: ${position.positionSide}, size: ${Math.abs(parseFloat(position.positionAmt))}`);
          } else {
            this.logger.log(`[CLOSE] No position found for ${symbol}`);
          }

          return position ? Math.abs(parseFloat(position.positionAmt)) : 0;
        } else {
          // One-way mode: just find any position for the symbol
          const position = response.data.find((p: any) => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
          return position ? Math.abs(parseFloat(position.positionAmt)) : 0;
        }
      }
    } catch (error: any) {
      this.logger.error(`[CLOSE] Failed to get position size: ${error.message}`);
      return 0;
    }
  }

  private async getSymbolRules(
    symbol: string,
    isTestnet: boolean,
    exchange: Exchange
  ): Promise<SymbolRules> {
    const defaultRules = { qtyStep: 0.001, minQty: 0.001, priceTick: 0.01 };

    try {
      if (exchange === Exchange.BYBIT) {
        return defaultRules;
      }

      const baseURL = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;
      const response = await BinanceRequestUtil.get(`${baseURL}/fapi/v1/exchangeInfo`);
      const symbolInfo = response.data.symbols.find((s: any) => s.symbol === symbol);

      if (!symbolInfo) return defaultRules;

      const lotSizeFilter = symbolInfo.filters.find((f: any) => f.filterType === 'LOT_SIZE');
      const priceFilter = symbolInfo.filters.find((f: any) => f.filterType === 'PRICE_FILTER');

      return {
        qtyStep: lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : defaultRules.qtyStep,
        minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : defaultRules.minQty,
        priceTick: priceFilter ? parseFloat(priceFilter.tickSize) : defaultRules.priceTick
      };
    } catch (error) {
      return defaultRules;
    }
  }

  private normalizeQuantity(quantity: number, step: number, minQty: number): string {
    const decimal = new Decimal(quantity);
    const stepDecimal = new Decimal(step);
    const normalized = decimal.div(stepDecimal).floor().mul(stepDecimal);
    const result = normalized.lessThan(minQty) ? new Decimal(minQty) : normalized;

    const stepStr = step.toString();
    const decimalPlaces = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;

    return result.toFixed(decimalPlaces);
  }

  private async closeBinancePosition(
    symbol: string,
    side: string,
    quantity: string,
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean,
    hedgeMode: boolean = false,
    tradeSide?: string
  ): Promise<void> {
    const baseURL = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;
    const params = new URLSearchParams();
    params.append('symbol', symbol);
    params.append('side', side);
    params.append('type', 'MARKET');
    params.append('quantity', quantity);

    // CRITICAL: In hedge mode, we need positionSide instead of reduceOnly
    // The positionSide should match the position we're closing (LONG for BUY trades, SHORT for SELL trades)
    if (hedgeMode && tradeSide) {
      const positionSide = tradeSide === 'BUY' ? 'LONG' : 'SHORT';
      params.append('positionSide', positionSide);
      this.logger.log(`[BINANCE] Hedge mode close: positionSide=${positionSide}`);
    } else {
      params.append('reduceOnly', 'true');
    }

    params.append('timestamp', Date.now().toString());

    const queryString = params.toString();
    const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

    this.logger.log(`[BINANCE] Closing position: ${symbol} ${side} ${quantity} (hedgeMode: ${hedgeMode})`);

    try {
      const response = await BinanceRequestUtil.post(
        `${baseURL}/fapi/v1/order`,
        `${queryString}&signature=${signature}`,
        {
          headers: {
            'X-MBX-APIKEY': apiKey,
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      this.logger.log(`[BINANCE] Close order response: ${JSON.stringify(response.data)}`);
    } catch (firstError: any) {
      const errorCode = firstError.response?.data?.code;

      // If error -4061 (position side mismatch) and we used positionSide, retry with reduceOnly
      if (errorCode === -4061 && hedgeMode && tradeSide) {
        this.logger.warn(`[BINANCE] Error -4061 detected - Retrying with One-Way Mode (reduceOnly)`);

        // Remove positionSide and add reduceOnly
        params.delete('positionSide');
        params.set('reduceOnly', 'true');
        params.set('timestamp', Date.now().toString());

        const retryQueryString = params.toString();
        const retrySignature = crypto.createHmac('sha256', apiSecret).update(retryQueryString).digest('hex');

        const retryResponse = await BinanceRequestUtil.post(
          `${baseURL}/fapi/v1/order`,
          `${retryQueryString}&signature=${retrySignature}`,
          {
            headers: {
              'X-MBX-APIKEY': apiKey,
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          }
        );

        this.logger.log(`[BINANCE] Close order response (One-Way Mode fallback): ${JSON.stringify(retryResponse.data)}`);
      } else {
        throw firstError;
      }
    }
  }

  private async getCurrentPrice(
    symbol: string,
    exchange: Exchange,
    isTestnet: boolean
  ): Promise<number> {
    try {
      if (exchange === Exchange.BYBIT) {
        return await this.bybitClient.getCurrentPrice(isTestnet, symbol);
      }

      const baseURL = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;
      const response = await BinanceRequestUtil.get(`${baseURL}/fapi/v1/ticker/price?symbol=${symbol}`);
      return parseFloat(response.data.price);
    } catch (error) {
      this.logger.error(`Failed to get price for ${symbol}`);
      return 0;
    }
  }
}
