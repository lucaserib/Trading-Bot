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

  private formatQuantity(quantity: number, symbol: string): string {
    const quantityPrecision: { [key: string]: number } = {
      'BTCUSDT': 3,
      'ETHUSDT': 2,
      'BNBUSDT': 1,
      'ADAUSDT': 0,
      'SOLUSDT': 0,
    };

    const precision = quantityPrecision[symbol] || 3;
    return quantity.toFixed(precision);
  }

  private formatPrice(price: number, symbol: string): string {
    const pricePrecision: { [key: string]: number } = {
      'BTCUSDT': 1,
      'ETHUSDT': 2,
      'BNBUSDT': 1,
      'ADAUSDT': 4,
      'SOLUSDT': 2,
    };

    const precision = pricePrecision[symbol] || 2;
    return price.toFixed(precision);
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
      params.append('quantity', this.formatQuantity(quantity, symbol));
      params.append('stopPrice', this.formatPrice(stopPrice, symbol));
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
      params.append('quantity', this.formatQuantity(quantity, symbol));
      params.append('stopPrice', this.formatPrice(takeProfitPrice, symbol));
      params.append('closePosition', 'false');
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

    const isLimitOrder = signal.orderType === OrderType.LIMIT && !!signal.price;

    this.logger.log(
      `[ORDER CONFIG] Exchange: ${exchange} | orderType: ${signal.orderType || 'undefined'} | ` +
      `price: ${signal.price || 'undefined'} | isLimitOrder: ${isLimitOrder}`
    );

    let quantity: number;
    if (signal.quantity) {
      quantity = signal.quantity;
      this.logger.log(`Using explicit quantity from signal: ${quantity}`);
    } else if (signal.accountPercentage && signal.price) {
      const accountBalance = await this.getAccountBalance(strategy);
      quantity = (accountBalance * signal.accountPercentage / 100) / signal.price;
      this.logger.log(`Calculated quantity from ${signal.accountPercentage}% of balance: ${quantity}`);
    } else {
      quantity = strategy.defaultQuantity || 0.002;
      this.logger.log(`Using default quantity from strategy: ${quantity}`);
    }

    const tradeData: Partial<Trade> = {
      strategyId: strategy.id,
      symbol: normalizedSymbol,
      side,
      type: isLimitOrder ? 'LIMIT' : 'MARKET',
      entryPrice: signal.price,
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

      let stopLossPrice: number | null = null;
      if (signal.stopLoss) {
        stopLossPrice = signal.stopLoss;
        this.logger.log(`[SL] Using absolute stop loss from signal: ${stopLossPrice}`);
      } else if (strategy.stopLossPercentage && strategy.stopLossPercentage > 0) {
        stopLossPrice = this.calculateStopLossPrice(side, entryPrice, strategy.stopLossPercentage);
        this.logger.log(`[SL] Calculated stop loss from strategy (${strategy.stopLossPercentage}%): ${stopLossPrice}`);
      }

      let takeProfitPrice: number | null = null;
      if (signal.takeProfit) {
        takeProfitPrice = signal.takeProfit;
        this.logger.log(`[TP] Using absolute take profit from signal: ${takeProfitPrice}`);
      } else {
        const takeProfitPercentage = strategy.takeProfitPercentage3 ||
                                      strategy.takeProfitPercentage2 ||
                                      strategy.takeProfitPercentage1;

        if (takeProfitPercentage && takeProfitPercentage > 0) {
          takeProfitPrice = this.calculateTakeProfitPrice(side, entryPrice, takeProfitPercentage);
          this.logger.log(`[TP] Calculated take profit from strategy (${takeProfitPercentage}%): ${takeProfitPrice}`);
        }
      }

      if (exchange === Exchange.BYBIT) {
        if (stopLossPrice || takeProfitPrice) {
          const bybitSide = side === 'BUY' ? 'Buy' : 'Sell';
          const slPrice = stopLossPrice ? this.formatPrice(stopLossPrice, normalizedSymbol) : undefined;
          const tpPrice = takeProfitPrice ? this.formatPrice(takeProfitPrice, normalizedSymbol) : undefined;

          const success = await this.bybitClient.setTradingStop(
            decryptedKey,
            decryptedSecret,
            strategy.isTestnet,
            normalizedSymbol,
            bybitSide,
            slPrice,
            tpPrice
          );

          if (success) {
            if (stopLossPrice) {
              stopLossOrderId = 'BYBIT_TRADING_STOP_SL';
              tradeData.stopLossOrderId = stopLossOrderId;
            }
            if (takeProfitPrice) {
              takeProfitOrderId = 'BYBIT_TRADING_STOP_TP';
              tradeData.takeProfitOrderId = takeProfitOrderId;
            }
          }
        }
      } else {
        if (stopLossPrice) {
          stopLossOrderId = await this.createBinanceStopLossOrder(
            normalizedSymbol,
            side,
            quantity,
            stopLossPrice,
            decryptedKey,
            decryptedSecret,
            strategy.isTestnet
          );

          if (stopLossOrderId) {
            tradeData.stopLossOrderId = stopLossOrderId;
          }
        }

        if (takeProfitPrice) {
          takeProfitOrderId = await this.createBinanceTakeProfitOrder(
            normalizedSymbol,
            side,
            quantity,
            takeProfitPrice,
            decryptedKey,
            decryptedSecret,
            strategy.isTestnet
          );

          if (takeProfitOrderId) {
            tradeData.takeProfitOrderId = takeProfitOrderId;
          }
        }
      }

      await this.tradesService.updateTrade(savedTrade.id, {
        entryPrice: tradeData.entryPrice,
        exchangeOrderId: tradeData.exchangeOrderId,
        stopLossOrderId: tradeData.stopLossOrderId,
        takeProfitOrderId: tradeData.takeProfitOrderId,
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
      this.logger.error('Error executing real trade', error);

      if (savedTrade && savedTrade.id) {
        await this.tradesService.updateTrade(savedTrade.id, {
          status: 'ERROR',
          error: error.response?.data?.msg || error.response?.data?.retMsg || error.message,
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
    const formattedQty = this.formatQuantity(quantity, symbol);
    const formattedPrice = signal.price ? this.formatPrice(signal.price, symbol) : undefined;

    this.logger.log(`[BYBIT] Creating ${orderType} order: ${bybitSide} ${formattedQty} ${symbol}`);

    const result = await this.bybitClient.createOrder(
      apiKey,
      apiSecret,
      strategy.isTestnet,
      {
        symbol,
        side: bybitSide,
        orderType,
        qty: formattedQty,
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
        params.append('price', this.formatPrice(signal.price!, symbol));
        params.append('timeInForce', 'GTC');
        this.logger.log(`[BINANCE] Creating LIMIT order at price ${signal.price}`);
      } else {
        params.append('type', 'MARKET');
        this.logger.log(`[BINANCE] Creating MARKET order`);
      }

      params.append('quantity', this.formatQuantity(quantity, symbol));

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
        const order = await exchangeInstance.createLimitOrder(signal.symbol, signal.action, quantity, signal.price);
        this.logger.log(`[BINANCE] Limit Order Placed via CCXT: ${order.id}`);
        return order;
      } else {
        const order = await exchangeInstance.createMarketOrder(signal.symbol, signal.action, quantity);
        this.logger.log(`[BINANCE] Market Order Placed via CCXT: ${order.id}`);
        return order;
      }
    }
  }
}
