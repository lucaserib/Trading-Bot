import { Injectable, Logger } from '@nestjs/common';
import { TradingviewSignalDto, OrderType } from './dto/tradingview-signal.dto';
import { ExchangeService } from '../exchange/exchange.service';
import { BybitClientService } from '../exchange/bybit-client.service';
import { StrategiesService } from '../strategies/strategies.service';
import { TradesService } from '../trades/trades.service';
import { Trade } from '../strategies/trade.entity';
import { Exchange, MarginMode, Strategy } from '../strategies/strategy.entity';
import { EncryptionUtil } from '../utils/encryption.util';
import axios from 'axios';
import * as crypto from 'crypto';
import Decimal from 'decimal.js';

interface BinanceOrderResponse {
  orderId: number;
  symbol: string;
  status: string;
  avgPrice: string;
  price: string;
  executedQty: string;
  type: string;
  side: string;
}

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private readonly BINANCE_TESTNET_URL = 'https://testnet.binancefuture.com';
  private readonly BINANCE_MAINNET_URL = 'https://fapi.binance.com';

  constructor(
    private readonly exchangeService: ExchangeService,
    private readonly bybitClient: BybitClientService,
    private readonly strategiesService: StrategiesService,
    private readonly tradesService: TradesService
  ) {}

  private normalizeSymbol(symbol: string, exchange: Exchange): string {
    if (exchange === Exchange.BINANCE) {
      return symbol.replace('/', '').replace('-', '');
    } else if (exchange === Exchange.BYBIT) {
      return symbol.replace('/', '').replace('-', '');
    }
    return symbol;
  }

  // Cache for symbol precision rules: symbol -> { qtyStep: number, priceTick: number, minQty: number }
  private symbolRules: Map<string, { qtyStep: string; priceTick: string; minQty: string }> = new Map();

  private async getSymbolRules(symbol: string, isTestnet: boolean): Promise<{ qtyStep: string; priceTick: string; minQty: string }> {
    const cached = this.symbolRules.get(symbol);
    if (cached) {
        return cached;
    }

    try {
        const baseURL = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;
        const response = await axios.get(`${baseURL}/fapi/v1/exchangeInfo`);
        const symbolInfo = response.data.symbols.find((s: any) => s.symbol === symbol);

        if (!symbolInfo) {
            this.logger.warn(`[BINANCE] Symbol ${symbol} not found in exchangeInfo. Using defaults.`);
            return { qtyStep: '0.001', priceTick: '0.01', minQty: '0.001' }; 
        }

        const lotSizeFilter = symbolInfo.filters.find((f: any) => f.filterType === 'LOT_SIZE');
        const priceFilter = symbolInfo.filters.find((f: any) => f.filterType === 'PRICE_FILTER');

        const rules = {
            qtyStep: lotSizeFilter ? lotSizeFilter.stepSize : '0.001',
            minQty: lotSizeFilter ? lotSizeFilter.minQty : '0.001',
            priceTick: priceFilter ? priceFilter.tickSize : '0.01'
        };

        this.symbolRules.set(symbol, rules);
        this.logger.log(`[BINANCE] Fetched rules for ${symbol}: Step=${rules.qtyStep}, Tick=${rules.priceTick}`);
        return rules;
    } catch (error) {
        this.logger.error(`[BINANCE] Failed to fetch symbol rules: ${error.message}`);
        return { qtyStep: '0.001', priceTick: '0.01', minQty: '0.001' };
    }
  }

  private roundStep(value: number, step: string): string {
    const dValue = new Decimal(value);
    const dStep = new Decimal(step);
    
    // Round down to nearest step (floor) for Quantity to avoid exceeding balance/risk
    // For Price, usually rounding to nearest is fine, but lets stick to standard rounding.
    return dValue.div(dStep).floor().mul(dStep).toFixed(); 
  }

  private roundTick(value: number, tick: string): string {
    const dValue = new Decimal(value);
    const dTick = new Decimal(tick);
    return dValue.div(dTick).round().mul(dTick).toFixed(); 
  }

  private async getAccountBalance(strategy: Strategy): Promise<number> {
    try {
      const decryptedKey = (await EncryptionUtil.decrypt(strategy.apiKey)).trim();
      const decryptedSecret = (await EncryptionUtil.decrypt(strategy.apiSecret)).trim();

      const exchange = strategy.exchange || Exchange.BINANCE;

      if (exchange === Exchange.BYBIT) {
        return await this.bybitClient.getWalletBalance(decryptedKey, decryptedSecret, strategy.isTestnet);
      }

      if (strategy.isTestnet && exchange === Exchange.BINANCE) {
        const baseURL = `${this.BINANCE_TESTNET_URL}/fapi/v2`;
        const endpoint = '/balance';
        const timestamp = Date.now();
        const queryString = `timestamp=${timestamp}`;
        const signature = crypto.createHmac('sha256', decryptedSecret).update(queryString).digest('hex');

        const response = await axios.get(`${baseURL}${endpoint}?${queryString}&signature=${signature}`, {
          headers: { 'X-MBX-APIKEY': decryptedKey }
        });

        const usdtBalance = response.data.find((b: any) => b.asset === 'USDT');
        return parseFloat(usdtBalance?.availableBalance || '0');
      } else {
        const exchangeInstance = await this.exchangeService.getExchange(
          exchange,
          decryptedKey,
          decryptedSecret,
          strategy.isTestnet
        );

        const balance = await exchangeInstance.fetchBalance();
        return balance.free['USDT'] || 0;
      }
    } catch (error) {
      this.logger.error(`Failed to fetch account balance: ${error.message}`);
      return 0;
    }
  }

  private async getPositionSize(
    symbol: string,
    exchange: Exchange,
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<number> {
    try {
        if (exchange === Exchange.BYBIT) {
             const positions = await this.bybitClient.getPositions(apiKey, apiSecret, isTestnet, symbol);
             const pos = positions.find(p => p.symbol === symbol && parseFloat(p.size) > 0);
             return pos ? parseFloat(pos.size) : 0;
        } else {
            // Binance
            const baseURL = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;
            const endpoint = '/fapi/v2/positionRisk'; // Use v2 for better info
            const timestamp = Date.now();
            const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
            const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

            const response = await axios.get(`${baseURL}${endpoint}?${queryString}&signature=${signature}`, {
                 headers: { 'X-MBX-APIKEY': apiKey }
            });
            
            // Binance returns array (sometimes 1 item per side in hedge mode, or just 1 in one-way)
            // We sum up absolute amounts if multiple, but usually one-way has one.
            const data = response.data;
            let size = 0;
            if (Array.isArray(data)) {
                 const pos = data.find((p: any) => parseFloat(p.positionAmt) !== 0);
                 if (pos) size = Math.abs(parseFloat(pos.positionAmt));
            } else {
                 if (parseFloat(data.positionAmt) !== 0) size = Math.abs(parseFloat(data.positionAmt));
            }
            return size;
        }
    } catch (err) {
        this.logger.error(`Failed to get position size: ${err.message}`);
        throw err;
    }
  }

  private async configureBinancePositionSettings(
    symbol: string,
    leverage: number,
    marginMode: MarginMode,
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<void> {
    const baseURL = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;

    try {
      const marginTimestamp = Date.now();
      const marginQueryString = `symbol=${symbol}&marginType=${marginMode}&timestamp=${marginTimestamp}`;
      const marginSignature = crypto.createHmac('sha256', apiSecret).update(marginQueryString).digest('hex');

      await axios.post(
        `${baseURL}/fapi/v1/marginType`,
        `${marginQueryString}&signature=${marginSignature}`,
        {
          headers: {
            'X-MBX-APIKEY': apiKey,
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );
      this.logger.log(`[BINANCE] Margin mode set to ${marginMode} for ${symbol}`);
    } catch (error: any) {
      if (error.response?.data?.code === -4046) {
        this.logger.debug(`[BINANCE] Margin mode already set to ${marginMode} for ${symbol}`);
      } else {
        this.logger.warn(`[BINANCE] Failed to set margin mode: ${error.response?.data?.msg || error.message}`);
      }
    }

    try {
      const leverageTimestamp = Date.now();
      const leverageQueryString = `symbol=${symbol}&leverage=${leverage}&timestamp=${leverageTimestamp}`;
      const leverageSignature = crypto.createHmac('sha256', apiSecret).update(leverageQueryString).digest('hex');

      await axios.post(
        `${baseURL}/fapi/v1/leverage`,
        `${leverageQueryString}&signature=${leverageSignature}`,
        {
          headers: {
            'X-MBX-APIKEY': apiKey,
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );
      this.logger.log(`[BINANCE] Leverage set to ${leverage}x for ${symbol}`);
    } catch (error: any) {
      this.logger.warn(`[BINANCE] Failed to set leverage: ${error.response?.data?.msg || error.message}`);
    }
  }

  private async cancelAllBinanceOrders(
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean,
    symbol: string
  ): Promise<void> {
    const baseURL = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;
    const endpoint = '/fapi/v1/allOpenOrders';

    const params = new URLSearchParams();
    params.append('symbol', symbol);
    params.append('timestamp', Date.now().toString());

    const queryString = params.toString();
    const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

    try {
      await axios.delete(`${baseURL}${endpoint}?${queryString}&signature=${signature}`, {
        headers: { 'X-MBX-APIKEY': apiKey }
      });
      this.logger.log(`[BINANCE] Cancelled all open orders for ${symbol}`);
    } catch (error: any) {
       this.logger.warn(`[BINANCE] Failed to cancel open orders: ${error.response?.data?.msg || error.message}`);
    }
  }

  private async configureBybitPositionSettings(
    symbol: string,
    leverage: number,
    marginMode: MarginMode,
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<void> {
    await this.bybitClient.setMarginMode(apiKey, apiSecret, isTestnet, symbol, marginMode, leverage);
    await this.bybitClient.setLeverage(apiKey, apiSecret, isTestnet, symbol, leverage);
  }

  private async createBinanceOrder(
    params: URLSearchParams,
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<BinanceOrderResponse> {
    const baseURL = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;
    const endpoint = '/fapi/v1/order';

    params.append('timestamp', Date.now().toString());
    const queryString = params.toString();
    const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
    const body = `${queryString}&signature=${signature}`;

    const response = await axios.post(`${baseURL}${endpoint}`, body, {
      headers: {
        'X-MBX-APIKEY': apiKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    return response.data;
  }

  private async createBinanceStopLossOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    stopPrice: number,
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<string | null> {
    try {
      const closeSide = side === 'BUY' ? 'SELL' : 'BUY';

      const params = new URLSearchParams();
      params.append('symbol', symbol);
      params.append('side', closeSide);
      params.append('type', 'STOP_MARKET');
      const rules = await this.getSymbolRules(symbol, isTestnet);
      params.append('quantity', this.roundStep(quantity, rules.qtyStep));
      params.append('stopPrice', this.roundTick(stopPrice, rules.priceTick));
      params.append('closePosition', 'false');
      params.append('workingType', 'MARK_PRICE');

      const response = await this.createBinanceOrder(params, apiKey, apiSecret, isTestnet);

      this.logger.log(`[BINANCE SL] Created for ${symbol} at ${stopPrice} - Order ID: ${response.orderId}`);
      return response.orderId.toString();
    } catch (error: any) {
      this.logger.error(`[BINANCE] Failed to create stop loss order: ${error.response?.data?.msg || error.message}`);
      return null;
    }
  }

  private async createBinanceTakeProfitOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    takeProfitPrice: number,
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<string | null> {
    try {
      const closeSide = side === 'BUY' ? 'SELL' : 'BUY';

      const params = new URLSearchParams();
      params.append('symbol', symbol);
      params.append('side', closeSide);
      params.append('type', 'TAKE_PROFIT_MARKET');
      const rules = await this.getSymbolRules(symbol, isTestnet);
      params.append('quantity', this.roundStep(quantity, rules.qtyStep));
      params.append('stopPrice', this.roundTick(takeProfitPrice, rules.priceTick));
      params.append('reduceOnly', 'true');
      params.append('workingType', 'MARK_PRICE');

      const response = await this.createBinanceOrder(params, apiKey, apiSecret, isTestnet);

      this.logger.log(`[BINANCE TP] Created for ${symbol} at ${takeProfitPrice} - Order ID: ${response.orderId}`);
      return response.orderId.toString();
    } catch (error: any) {
      this.logger.error(`[BINANCE] Failed to create take profit order: ${error.response?.data?.msg || error.message}`);
      return null;
    }
  }

  private calculateStopLossPrice(side: 'BUY' | 'SELL', entryPrice: number, stopLossPercentage: number): number {
    const slPercent = stopLossPercentage / 100;
    if (side === 'BUY') {
      return entryPrice * (1 - slPercent);
    }
    return entryPrice * (1 + slPercent);
  }

  private calculateTakeProfitPrice(side: 'BUY' | 'SELL', entryPrice: number, takeProfitPercentage: number): number {
    const tpPercent = takeProfitPercentage / 100;
    if (side === 'BUY') {
      return entryPrice * (1 + tpPercent);
    }
    return entryPrice * (1 - tpPercent);
  }

  async processSignal(signal: TradingviewSignalDto) {
    this.logger.log(`Processing signal: ${signal.action} ${signal.symbol} for Strategy ${signal.strategyId}`);

    if (!signal.strategyId) {
      throw new Error('Strategy ID is missing in signal');
    }

    const strategy = await this.strategiesService.findOne(signal.strategyId);
    if (!strategy) {
      throw new Error(`Strategy not found: ${signal.strategyId}`);
    }

    if (!strategy.isActive) {
      this.logger.warn(`Strategy ${strategy.name} is paused. Ignoring signal.`);
      return { status: 'skipped', message: 'Strategy is paused' };
    }

    const exchange = strategy.exchange || Exchange.BINANCE;
    const normalizedSymbol = this.normalizeSymbol(signal.symbol, exchange);
    const side = signal.action.toUpperCase() as 'BUY' | 'SELL';

    // --- ONE-WAY POSITION MANAGEMENT ---
    // Check for existing open trades for this strategy/symbol
    const openTrades = await this.tradesService.findOpenTrades();
    const activeTrade = openTrades.find(t => t.symbol === normalizedSymbol && t.strategyId === strategy.id);

    if (activeTrade) {
        if (activeTrade.side === side) {
            this.logger.warn(`[ONE-WAY] Ignoring duplicate ${side} signal for ${normalizedSymbol}. Position already open.`);
            return { status: 'skipped', message: 'Position already open (One-Way Mode)' };
        } else {
            this.logger.log(`[ONE-WAY] Flipping position! Closing ${activeTrade.side} to open ${side}.`);
            // Close existing position logic (Generic close via Market)
            try {
                const decryptedKey = (await EncryptionUtil.decrypt(strategy.apiKey)).trim();
                const decryptedSecret = (await EncryptionUtil.decrypt(strategy.apiSecret)).trim();

                this.logger.log(`[ONE-WAY] Cancelling all open orders for ${normalizedSymbol}...`);
                if (exchange === Exchange.BYBIT) {
                    await this.bybitClient.cancelAllOrders(decryptedKey, decryptedSecret, strategy.isTestnet, normalizedSymbol);
                } else {
                    await this.cancelAllBinanceOrders(decryptedKey, decryptedSecret, strategy.isTestnet, normalizedSymbol);
                }

                let closeQty = 0;
                try {
                     closeQty = await this.getPositionSize(activeTrade.symbol, exchange, decryptedKey, decryptedSecret, strategy.isTestnet);
                } catch (e) {
                     this.logger.warn(`[ONE-WAY] Failed to fetch live position size, falling back to DB: ${e.message}`);
                     closeQty = parseFloat(activeTrade.quantity as any);
                }

                if (closeQty <= 0) {
                     this.logger.warn(`[ONE-WAY] Position size is 0, assuming already closed.`);
                     await this.tradesService.updateTrade(activeTrade.id, { status: 'CLOSED' });
                } else {
                    const closeSide = activeTrade.side === 'BUY' ? 'SELL' : 'BUY';
                    this.logger.log(`[ONE-WAY] Closing ${activeTrade.symbol} (${closeQty}) before reversal.`);
                    
                    // Fetch rules for proper formatting
                    const rules = await this.getSymbolRules(normalizedSymbol, strategy.isTestnet);

                    if (exchange === Exchange.BYBIT) {
                        await this.bybitClient.createOrder(decryptedKey, decryptedSecret, strategy.isTestnet, {
                            symbol: normalizedSymbol,
                            side: closeSide === 'BUY' ? 'Buy' : 'Sell',
                            orderType: 'Market',
                            qty: this.roundStep(closeQty, rules.qtyStep),
                            reduceOnly: true
                        });
                    } else {
                        const params = new URLSearchParams();
                        params.append('symbol', normalizedSymbol);
                        params.append('side', closeSide);
                        params.append('type', 'MARKET');
                        params.append('quantity', this.roundStep(closeQty, rules.qtyStep));
                        params.append('reduceOnly', 'true');
                        await this.createBinanceOrder(params, decryptedKey, decryptedSecret, strategy.isTestnet);
                    }
                    this.logger.log(`[ONE-WAY] Position closed successfully.`);
                }

                 // Update DB
                 await this.tradesService.updateTrade(activeTrade.id, { status: 'CLOSED', pnl: 0 }); 
                 this.logger.log(`[ONE-WAY] Waiting 2s before new entry...`);
                 await new Promise(r => setTimeout(r, 2000)); 

            } catch (err) {
                 this.logger.error(`[ONE-WAY] CRITICAL: Failed to close opposite position: ${err.message}`);
                 return { status: 'error', message: `One-Way Mode: Failed to close opposite position. ${err.message}` };
            }
        }
    }

    let isLimitOrder = signal.orderType === OrderType.LIMIT && !!signal.price;
    let effectivePrice = signal.price;

    // Next Candle / Percent Offset Logic
    if (strategy.nextCandleEntry && strategy.nextCandlePercentage && signal.price) {
      const offset = signal.price * (strategy.nextCandlePercentage / 100);
      if (side === 'BUY') {
        effectivePrice = signal.price - offset;
      } else {
        effectivePrice = signal.price + offset;
      }
      isLimitOrder = true;
      // Update signal to reflect the forced limit order so downstream methods use the correct price
      signal.price = effectivePrice;
      signal.orderType = OrderType.LIMIT;
      
      this.logger.log(`[NEXT CANDLE] Adjusted entry price to ${effectivePrice} (${strategy.nextCandlePercentage}% offset)`);
    }

    this.logger.log(
      `[ORDER CONFIG] Exchange: ${exchange} | orderType: ${isLimitOrder ? 'LIMIT' : 'MARKET'} | ` +
      `price: ${effectivePrice || 'undefined'} | isLimitOrder: ${isLimitOrder}`
    );

    let quantity: number;
    let notional = 0;

    if (signal.quantity) {
      quantity = signal.quantity;
      notional = quantity * effectivePrice!;
      this.logger.log(`Using explicit quantity from signal: ${quantity} (Notional: ~${notional.toFixed(2)} USDT)`);
    } else if (signal.accountPercentage && effectivePrice) {
      const accountBalance = await this.getAccountBalance(strategy);
      this.logger.log(`[DEBUG] Fetched Account Balance: ${accountBalance} USDT`);
      
      const targetNotional = accountBalance * (signal.accountPercentage / 100);
      quantity = targetNotional / effectivePrice;
      notional = targetNotional;
      
      this.logger.log(`Calculated quantity from ${signal.accountPercentage}% of balance: ${quantity.toFixed(5)} (Target Notional: ${targetNotional.toFixed(2)} USDT)`);
    } else if (strategy.useAccountPercentage && strategy.accountPercentage && effectivePrice) {
      const accountBalance = await this.getAccountBalance(strategy);
      this.logger.log(`[DEBUG] Fetched Account Balance: ${accountBalance} USDT`);
      
      const targetNotional = accountBalance * (strategy.accountPercentage / 100);
      quantity = targetNotional / effectivePrice;
      notional = targetNotional;
      
      this.logger.log(`Calculated quantity from strategy ${strategy.accountPercentage}% of balance: ${quantity.toFixed(5)} (Target Notional: ${targetNotional.toFixed(2)} USDT)`);
    } else {
      quantity = strategy.defaultQuantity || 0.002;
      notional = quantity * (effectivePrice || 0); // fallback if effectivePrice undefined
      this.logger.log(`Using default quantity from strategy: ${quantity} (Notional: ~${notional.toFixed(2)} USDT)`);
    }

    if (notional < 5) {
       this.logger.warn(`[WARNING] Calculated notional (${notional}) is extremely low. Binance Minimum is usually 5-10 USDT (100 on some pairs/testnet).`);
    }

    if (notional < 10) { // Binance Min is typically 5-10, Testnet can be higher (100+)
       const msg = `[WARNING] Calculated notional (${notional.toFixed(2)} USDT) is too low. Trade aborted to avoid rejection.`;
       this.logger.warn(msg);
       
       const tradeData: Partial<Trade> = {
          strategyId: strategy.id,
          symbol: normalizedSymbol,
          side,
          type: isLimitOrder ? 'LIMIT' : 'MARKET',
          entryPrice: effectivePrice,
          quantity,
          status: 'ERROR',
          error: 'Notional too low (< 10 USDT)',
       };
       await this.tradesService.create(tradeData);
       return { status: 'error', message: msg };
    }

    const tradeData: Partial<Trade> = {
      strategyId: strategy.id,
      symbol: normalizedSymbol,
      side,
      type: isLimitOrder ? 'LIMIT' : 'MARKET',
      entryPrice: effectivePrice,
      quantity,
      status: 'OPEN',
    };

    if (strategy.isDryRun) {
      this.logger.log(`[DRY RUN] Simulating ${signal.action} on ${signal.symbol}`);
      tradeData.status = 'SIMULATED';
      tradeData.pnl = 0;
      await this.tradesService.create(tradeData);
      return { status: 'success', message: 'Dry Run Order Logged', trade: tradeData };
    }

    let savedTrade: Trade | null = null;

    try {
      const decryptedKey = (await EncryptionUtil.decrypt(strategy.apiKey)).trim();
      const decryptedSecret = (await EncryptionUtil.decrypt(strategy.apiSecret)).trim();

      this.logger.log(`[DEBUG] Targeting Exchange: ${exchange} (Testnet: ${strategy.isTestnet})`);

      savedTrade = await this.tradesService.create(tradeData);
      this.logger.log(`[TRADE] Pre-saved trade ${savedTrade.id} before order`);

      let tradeDetails: any;
      let stopLossOrderId: string | null = null;
      let takeProfitOrderId: string | null = null;

      if (exchange === Exchange.BYBIT) {
        tradeDetails = await this.executeBybitOrder(
          strategy,
          normalizedSymbol,
          side,
          quantity,
          isLimitOrder,
          signal,
          decryptedKey,
          decryptedSecret
        );
      } else {
        await this.configureBinancePositionSettings(
          normalizedSymbol,
          strategy.leverage || 1,
          strategy.marginMode || MarginMode.ISOLATED,
          decryptedKey,
          decryptedSecret,
          strategy.isTestnet
        );

        tradeDetails = await this.executeBinanceOrder(
          strategy,
          normalizedSymbol,
          side,
          quantity,
          isLimitOrder,
          signal,
          decryptedKey,
          decryptedSecret
        );
      }

      const entryPrice = tradeDetails.average || tradeDetails.price || signal.price;
      tradeData.entryPrice = entryPrice;
      tradeData.exchangeOrderId = tradeDetails.id;

      // --- STOP LOSS ---
      let stopLossPrice: number | null = null;
      if (signal.stopLoss) {
        stopLossPrice = signal.stopLoss;
        this.logger.log(`[SL] Using absolute stop loss from signal: ${stopLossPrice}`);
      } else if (strategy.stopLossPercentage && strategy.stopLossPercentage > 0) {
        stopLossPrice = this.calculateStopLossPrice(side, entryPrice, strategy.stopLossPercentage);
        this.logger.log(`[SL] Calculated stop loss from strategy (${strategy.stopLossPercentage}%): ${stopLossPrice}`);
      }

      if (stopLossPrice) {
          // Fetch rules early for Stop Loss
          const rules = await this.getSymbolRules(normalizedSymbol, strategy.isTestnet);

          if (exchange === Exchange.BYBIT) {
             const bybitSide = side === 'BUY' ? 'Buy' : 'Sell';
             await this.bybitClient.setTradingStop(
                decryptedKey, decryptedSecret, strategy.isTestnet,
                normalizedSymbol, bybitSide, this.roundTick(stopLossPrice, rules.priceTick), undefined
             );
          } else {
             stopLossOrderId = await this.createBinanceStopLossOrder(
                normalizedSymbol, side, quantity, stopLossPrice, decryptedKey, decryptedSecret, strategy.isTestnet
             );
          }
      }

      // --- MULTI-PARTIAL TAKE PROFITS ---
      const tpConfigs = [
          { percent: strategy.takeProfitPercentage1, qtyPercent: strategy.takeProfitQuantity1 || 33, id: 1 },
          { percent: strategy.takeProfitPercentage2, qtyPercent: strategy.takeProfitQuantity2 || 33, id: 2 },
          { percent: strategy.takeProfitPercentage3, qtyPercent: strategy.takeProfitQuantity3 || 34, id: 3 },
      ];

      for (const tp of tpConfigs) {
          if (tp.percent && tp.percent > 0) {
              const tpPrice = this.calculateTakeProfitPrice(side, entryPrice, tp.percent);
              const tpQty = (quantity * tp.qtyPercent) / 100;
              
              if (tpQty <= 0) continue;

              this.logger.log(`[TP${tp.id}] Placing partial TP at ${tpPrice} for ${tpQty.toFixed(4)} coins (${tp.qtyPercent}%)`);
              
              const rules = await this.getSymbolRules(normalizedSymbol, strategy.isTestnet);

              if (exchange === Exchange.BYBIT) {
                 // Bybit partial TP usually requires Limit Reduce-Only orders rather than a single TP attached to position
                   await this.bybitClient.createOrder(
                      decryptedKey, decryptedSecret, strategy.isTestnet,
                      {
                          symbol: normalizedSymbol,
                          side: side === 'BUY' ? 'Sell' : 'Buy', // Close side
                          orderType: 'Limit',
                          qty: this.roundStep(tpQty, rules.qtyStep),
                          price: this.roundTick(tpPrice, rules.priceTick),
                          reduceOnly: true
                      }
                  );
              } else {
                  // Binance Partial TP
                  await this.createBinanceTakeProfitOrder(
                      normalizedSymbol, side, tpQty, tpPrice, decryptedKey, decryptedSecret, strategy.isTestnet
                  );
              }
          }
      }

      await this.tradesService.updateTrade(savedTrade.id, {
        entryPrice: tradeData.entryPrice,
        exchangeOrderId: tradeData.exchangeOrderId,
        stopLossOrderId: stopLossOrderId || undefined,
        // takeProfitOrderId field might need deprecating or storing array. For now we leave last or empty.
      });

      this.logger.log(`[TRADE] Updated trade ${savedTrade.id} with order details`);

      return {
        status: 'success',
        message: 'Order Executed',
        trade: { ...tradeData, id: savedTrade.id },
        stopLossOrderId,
        takeProfitOrderId
      };

    } catch (error: any) {
      // Clean error logging
      const errorMsg = error.response?.data?.msg || error.response?.data?.retMsg || error.message;
      const errorCode = error.response?.data?.code || error.response?.data?.retCode;
      
      this.logger.error(`Error executing real trade: [${errorCode}] ${errorMsg}`);
      
      if (savedTrade && savedTrade.id) {
        await this.tradesService.updateTrade(savedTrade.id, {
          status: 'ERROR',
          error: `${errorCode ? `[${errorCode}] ` : ''}${errorMsg}`,
        });
      } else {
        tradeData.status = 'ERROR';
        tradeData.error = error.response?.data?.msg || error.response?.data?.retMsg || error.message;
        await this.tradesService.create(tradeData);
      }

      return { status: 'error', message: error.message };
    }
  }

  private async executeBybitOrder(
    strategy: Strategy,
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    isLimitOrder: boolean,
    signal: TradingviewSignalDto,
    apiKey: string,
    apiSecret: string
  ): Promise<any> {
    await this.configureBybitPositionSettings(
      symbol,
      strategy.leverage || 1,
      strategy.marginMode || MarginMode.ISOLATED,
      apiKey,
      apiSecret,
      strategy.isTestnet
    );

    const bybitSide = side === 'BUY' ? 'Buy' : 'Sell';
    const orderType = isLimitOrder ? 'Limit' : 'Market';
    // For Bybit, let's keep simple formatting or we need Bybit specific dynamic rules too. 
    // Assuming 3 decimal is safe for Bybit generic or we should add Bybit Exchange Info fetch too.
    // For now, let's use the same rounding if possible, or fallback.
    const rules = await this.getSymbolRules(symbol, strategy.isTestnet); 
    const formattedQty = this.roundStep(quantity, rules.qtyStep); 
    const formattedPrice = signal.price ? this.roundTick(signal.price, rules.priceTick) : undefined;

    this.logger.log(`[BYBIT] Creating ${orderType} order: ${bybitSide} ${formattedQty} ${symbol}`);

    const result = await this.bybitClient.createOrder(
      apiKey,
      apiSecret,
      strategy.isTestnet,
      {
        symbol,
        side: bybitSide,
        orderType,
        qty: this.roundStep(quantity, '0.001'), // Should use Bybit rules separately, defaulting for safety or need Bybit specific fetch
        price: isLimitOrder ? formattedPrice : undefined,
      }
    );

    this.logger.log(`[BYBIT] Order placed! Order ID: ${result.orderId}`);

    return {
      id: result.orderId,
      price: signal.price,
      average: signal.price,
      status: 'NEW'
    };
  }

  private async executeBinanceOrder(
    strategy: Strategy,
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    isLimitOrder: boolean,
    signal: TradingviewSignalDto,
    apiKey: string,
    apiSecret: string
  ): Promise<any> {
    if (strategy.isTestnet) {
      this.logger.log('[BINANCE TESTNET] Using Direct Axios Execution');

      const params = new URLSearchParams();
      params.append('symbol', symbol);
      params.append('side', side);

      if (isLimitOrder) {
        params.append('type', 'LIMIT');
        const rules = await this.getSymbolRules(symbol, strategy.isTestnet);
        params.append('price', this.roundTick(signal.price!, rules.priceTick));
        params.append('timeInForce', 'GTC');
        this.logger.log(`[BINANCE] Creating LIMIT order at price ${signal.price}`);
      } else {
        const rules = await this.getSymbolRules(symbol, strategy.isTestnet); // Need rules for quantity anyway
        params.append('type', 'MARKET');
        this.logger.log(`[BINANCE] Creating MARKET order`);
      }

      params.append('quantity', this.roundStep(quantity, (await this.getSymbolRules(symbol, strategy.isTestnet)).qtyStep));

      const response = await this.createBinanceOrder(params, apiKey, apiSecret, strategy.isTestnet);

      this.logger.log(`[BINANCE] Order Placed! Order ID: ${response.orderId}`);

      const filledPrice = parseFloat(response.avgPrice || response.price || '0');
      const finalPrice = filledPrice > 0 ? filledPrice : signal.price;

      return {
        id: response.orderId.toString(),
        price: finalPrice,
        average: finalPrice,
        status: response.status
      };
    } else {
      const exchangeInstance = await this.exchangeService.getExchange(
        Exchange.BINANCE,
        apiKey,
        apiSecret,
        strategy.isTestnet
      );

      if (isLimitOrder) {
        const rules = await this.getSymbolRules(symbol, strategy.isTestnet);
        const order = await exchangeInstance.createLimitOrder(symbol, signal.action, this.roundStep(quantity, rules.qtyStep), this.roundTick(signal.price || 0, rules.priceTick));
        this.logger.log(`[BINANCE] Limit Order Placed via CCXT: ${order.id}`);
        return order;
      } else {
        const rules = await this.getSymbolRules(symbol, strategy.isTestnet);
        const order = await exchangeInstance.createMarketOrder(symbol, signal.action, this.roundStep(quantity, rules.qtyStep));
        this.logger.log(`[BINANCE] Market Order Placed via CCXT: ${order.id}`);
        return order;
      }
    }
  }
}
