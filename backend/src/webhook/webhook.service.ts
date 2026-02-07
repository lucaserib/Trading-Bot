import { Injectable, Logger } from '@nestjs/common';
import { TradingviewSignalDto, OrderType } from './dto/tradingview-signal.dto';
import { ExchangeService } from '../exchange/exchange.service';
import { BybitClientService } from '../exchange/bybit-client.service';
import { StrategiesService } from '../strategies/strategies.service';
import { TradesService } from '../trades/trades.service';
import { Trade } from '../strategies/trade.entity';
import { Exchange, MarginMode, Strategy, TradingMode } from '../strategies/strategy.entity';
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

// Custom error classes for trading operations
class StopLossCreationError extends Error {
  constructor(
    public symbol: string,
    public errorCode: number,
    public errorMessage: string,
    public originalError: any
  ) {
    super(`Failed to create Stop Loss for ${symbol}: [${errorCode}] ${errorMessage}`);
    this.name = 'StopLossCreationError';
  }
}

class TakeProfitCreationError extends Error {
  constructor(
    public symbol: string,
    public errorCode: number,
    public errorMessage: string,
    public originalError: any
  ) {
    super(`Failed to create Take Profit for ${symbol}: [${errorCode}] ${errorMessage}`);
    this.name = 'TakeProfitCreationError';
  }
}

class PositionNotFoundError extends Error {
  constructor(
    public symbol: string,
    public positionSide?: string
  ) {
    super(`Position not found for ${symbol}${positionSide ? ` (${positionSide})` : ''}`);
    this.name = 'PositionNotFoundError';
  }
}

class PositionProtectionError extends Error {
  constructor(
    public message: string,
    public entryOrderId: string,
    public symbol: string
  ) {
    super(message);
    this.name = 'PositionProtectionError';
  }
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

  private normalizeQuantity(value: number, step: string, minQty: string): string {
    const dValue = new Decimal(value);
    const dStep = new Decimal(step);
    const dMinQty = new Decimal(minQty);

    // 1. Check if input value is already zero or negative
    if (dValue.lessThanOrEqualTo(0)) {
      this.logger.error(
        `[QUANTITY] INVALID - Input quantity is zero or negative\n` +
        `  Input Value: ${value}\n` +
        `  Step: ${step}\n` +
        `  Min Quantity: ${minQty}\n` +
        `  This will cause order creation to fail!`
      );
      throw new Error(`Invalid quantity: ${value}. Quantity must be greater than zero.`);
    }

    // 2. Round down to nearest step
    let rounded = dValue.div(dStep).floor().mul(dStep);

    // 3. Check if rounding resulted in zero
    if (rounded.isZero()) {
      this.logger.error(
        `[QUANTITY] ZERO AFTER ROUNDING\n` +
        `  Original Value: ${value}\n` +
        `  Step Size: ${step}\n` +
        `  Min Quantity: ${minQty}\n` +
        `  Rounded Value: 0\n` +
        `  The quantity is too small for this symbol's step size!\n` +
        `  Attempting to use minimum quantity instead...`
      );
      rounded = dMinQty;
    }

    // 4. Ensure it meets minimum quantity
    if (rounded.lessThan(dMinQty)) {
      this.logger.warn(
        `[QUANTITY] Below minimum - Adjusting\n` +
        `  Calculated: ${rounded.toFixed()}\n` +
        `  Minimum: ${minQty}\n` +
        `  Using minimum quantity`
      );
      return dMinQty.toFixed();
    }

    return rounded.toFixed();
  }

  private roundTick(value: number, tick: string): string {
    const dValue = new Decimal(value);
    const dTick = new Decimal(tick);
    return dValue.div(dTick).round().mul(dTick).toFixed();
  }

  private formatQuantityWithUsdt(quantity: number, price: number): string {
    const usdt = quantity * price;
    return `${quantity.toFixed(4)} (~${usdt.toFixed(2)} USDT)`;
  }

  private async getAccountBalance(strategy: Strategy): Promise<number> {
    try {
      const decryptedKey = (await EncryptionUtil.decrypt(strategy.apiKey)).trim();
      const decryptedSecret = (await EncryptionUtil.decrypt(strategy.apiSecret)).trim();

      const exchange = strategy.exchange || Exchange.BINANCE;

      if (exchange === Exchange.BYBIT) {
        const balance = await this.bybitClient.getWalletBalance(decryptedKey, decryptedSecret, strategy.isTestnet);
        this.logger.log(`[BALANCE] Bybit ${strategy.isTestnet ? 'Testnet' : 'Mainnet'}: ${balance.toFixed(2)} USDT`);
        return balance;
      }

      if (strategy.isTestnet && exchange === Exchange.BINANCE) {
        const baseURL = `${this.BINANCE_TESTNET_URL}/fapi/v2`;
        const endpoint = '/balance';
        const timestamp = Date.now();
        const queryString = `timestamp=${timestamp}`;
        const signature = crypto.createHmac('sha256', decryptedSecret).update(queryString).digest('hex');

        this.logger.log(`[BALANCE] Fetching from: ${baseURL}${endpoint}`);
        this.logger.debug(`[BALANCE] API Key: ${decryptedKey.substring(0, 8)}...`);

        const response = await axios.get(`${baseURL}${endpoint}?${queryString}&signature=${signature}`, {
          headers: { 'X-MBX-APIKEY': decryptedKey }
        });

        this.logger.log(`[BALANCE] API Response received. Status: ${response.status}`);
        this.logger.debug(`[BALANCE] Full response: ${JSON.stringify(response.data)}`);

        if (!Array.isArray(response.data)) {
          this.logger.error(`[BALANCE] ERROR: Response is not an array! Type: ${typeof response.data}, Value: ${JSON.stringify(response.data)}`);
          throw new Error('Invalid balance response format from Binance');
        }

        this.logger.log(`[BALANCE] Found ${response.data.length} assets in balance`);

        const usdtBalance = response.data.find((b: any) => b.asset === 'USDT');

        if (!usdtBalance) {
          const availableAssets = response.data.map((b: any) => `${b.asset}(${b.balance})`).join(', ');
          this.logger.error(`[BALANCE] USDT not found! Available assets: ${availableAssets}`);
          this.logger.error(`[BALANCE] Full asset list: ${JSON.stringify(response.data)}`);
          throw new Error('USDT balance not found in account. Available assets: ' + availableAssets);
        }

        this.logger.debug(`[BALANCE] USDT object: ${JSON.stringify(usdtBalance)}`);

        const availableBalance = parseFloat(usdtBalance.availableBalance || '0');
        const walletBalance = parseFloat(usdtBalance.balance || '0');
        const crossWalletBalance = parseFloat(usdtBalance.crossWalletBalance || '0');

        this.logger.log(
          `[BALANCE] Binance Testnet USDT: ` +
          `Available=${availableBalance.toFixed(2)}, ` +
          `Wallet=${walletBalance.toFixed(2)}, ` +
          `Cross=${crossWalletBalance.toFixed(2)}`
        );

        const balance = availableBalance > 0 ? availableBalance : walletBalance;

        if (balance === 0) {
          this.logger.error(
            `[BALANCE] CRITICAL: All USDT balances are 0! ` +
            `This indicates either: ` +
            `1) Account has no funds, ` +
            `2) API key doesn't have permission to read balance, ` +
            `3) Wrong account/environment. ` +
            `Full USDT object: ${JSON.stringify(usdtBalance)}`
          );
        }

        return balance;
      } else {
        const exchangeInstance = await this.exchangeService.getExchange(
          exchange,
          decryptedKey,
          decryptedSecret,
          strategy.isTestnet
        );

        const balanceData = await exchangeInstance.fetchBalance();
        const balance = balanceData.free['USDT'] || 0;

        this.logger.log(`[BALANCE] Binance Mainnet: ${balance.toFixed(2)} USDT`);

        if (balance === 0) {
          this.logger.warn(`[BALANCE] WARNING: Account balance is 0 USDT. This will cause notional errors.`);
        }

        return balance;
      }
    } catch (error: any) {
      if (error.response) {
        const errorCode = error.response.data?.code;
        const errorMsg = error.response.data?.msg;
        const statusCode = error.response.status;

        this.logger.error(
          `[BALANCE] API ERROR! ` +
          `HTTP ${statusCode} | ` +
          `Code: ${errorCode} | ` +
          `Message: ${errorMsg} | ` +
          `Full response: ${JSON.stringify(error.response.data)}`
        );

        if (errorCode === -2014) {
          throw new Error('API key invalid or expired. Please check your API credentials.');
        } else if (errorCode === -2015) {
          throw new Error('API key has no permission to access balance. Please enable "Read" permission on your API key.');
        } else if (errorCode === -1021) {
          throw new Error('Timestamp error. Server time may be out of sync.');
        } else {
          throw new Error(`Binance API Error ${errorCode}: ${errorMsg}`);
        }
      } else {
        this.logger.error(`[BALANCE] NETWORK/OTHER ERROR: ${error.message}`);
        this.logger.error(`[BALANCE] Error stack: ${error.stack}`);
        throw new Error(`Failed to fetch account balance: ${error.message}`);
      }
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
    isTestnet: boolean,
    hedgeMode: boolean = false
  ): Promise<void> {
    const baseURL = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;

    try {
      const dualTimestamp = Date.now();
      const dualQueryString = `dualSidePositionMode=${hedgeMode}&timestamp=${dualTimestamp}`;
      const dualSignature = crypto.createHmac('sha256', apiSecret).update(dualQueryString).digest('hex');

      this.logger.log(`[POSITION MODE] BEFORE API CALL - Setting hedge mode: ${hedgeMode}, URL: ${baseURL}/fapi/v1/positionSide/dual`);
      this.logger.debug(`[POSITION MODE] Request params: ${dualQueryString}`);

      await axios.post(
        `${baseURL}/fapi/v1/positionSide/dual`,
        `${dualQueryString}&signature=${dualSignature}`,
        { headers: { 'X-MBX-APIKEY': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      this.logger.log(`[POSITION MODE] SUCCESS - Position mode set to ${hedgeMode ? 'Hedge' : 'One-Way'}`);
    } catch (error: any) {
      const errorCode = error.response?.data?.code;
      const errorMsg = error.response?.data?.msg;

      // Error -4300: "No need to change position side." - Position mode already matches the requested setting
      if (errorCode === -4300) {
        this.logger.debug(
          `[POSITION MODE] Already configured correctly\n` +
          `  Requested Mode: ${hedgeMode ? 'Hedge Mode (Dual Position)' : 'One-Way Mode'}\n` +
          `  Status: No change needed (error -4300 is normal)\n` +
          `  This is not an error - the account is already in the correct position mode`
        );
      }
      // Error -4059: Position mode cannot be changed if positions exist
      else if (errorCode === -4059) {
        this.logger.error(
          `[POSITION MODE] CANNOT CHANGE - Open positions exist!\n` +
          `  Error: [${errorCode}] ${errorMsg}\n` +
          `  Current Account Mode: ${hedgeMode ? 'One-Way Mode (trying to switch to Hedge)' : 'Hedge Mode (trying to switch to One-Way)'}\n` +
          `  Required Action: Close ALL open positions on Binance Futures before changing position mode\n` +
          `  ⚠️  Strategy configuration (hedgeMode: ${hedgeMode}) does not match account settings!\n` +
          `  This will cause SL/TP orders to fail!`
        );
        throw new Error(
          `Cannot change position mode while positions are open. ` +
          `Close all positions and try again. ` +
          `Strategy expects ${hedgeMode ? 'Hedge Mode' : 'One-Way Mode'} but account has open positions.`
        );
      }
      // Other errors
      else {
        this.logger.error(
          `[POSITION MODE] FAILED to set position mode\n` +
          `  Error Code: ${errorCode}\n` +
          `  Error Message: ${errorMsg}\n` +
          `  Requested Mode: ${hedgeMode ? 'Hedge Mode (Dual Position)' : 'One-Way Mode'}\n` +
          `  This may cause subsequent SL/TP orders to fail!`
        );
        this.logger.warn(
          `[POSITION MODE] Continuing despite error, but SL/TP may fail if mode mismatch exists`
        );
      }
    }

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

    // Verify that hedge mode was actually set correctly
    await this.verifyHedgeModeSet(apiKey, apiSecret, isTestnet, hedgeMode);
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
    isTestnet: boolean,
    hedgeMode: boolean = false
  ): Promise<string> {
    try {
      const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
      const rules = await this.getSymbolRules(symbol, isTestnet);

      const params = new URLSearchParams();
      params.append('symbol', symbol);
      params.append('side', closeSide);
      params.append('type', 'STOP_MARKET');

      if (hedgeMode) {
        const positionSide = side === 'BUY' ? 'LONG' : 'SHORT';
        params.append('positionSide', positionSide);
        params.append('closePosition', 'true');
        params.append('quantity', '0');

        this.logger.log(
          `[SL CREATE] BEFORE API CALL - Hedge Mode with Auto-Adjust\n` +
          `  Symbol: ${symbol}\n` +
          `  Entry Side: ${side} → Close Side: ${closeSide}\n` +
          `  Position Side: ${positionSide}\n` +
          `  Stop Price: ${this.roundTick(stopPrice, rules.priceTick)}\n` +
          `  Using closePosition=true (will auto-adjust after partial TPs)\n` +
          `  Rules: step=${rules.qtyStep}, min=${rules.minQty}, tick=${rules.priceTick}`
        );
      } else {
        params.append('quantity', '0');
        params.append('closePosition', 'true');

        this.logger.log(
          `[SL CREATE] BEFORE API CALL - One-Way Mode\n` +
          `  Symbol: ${symbol}\n` +
          `  Entry Side: ${side} → Close Side: ${closeSide}\n` +
          `  Stop Price: ${this.roundTick(stopPrice, rules.priceTick)}\n` +
          `  Using closePosition=true (auto-adjusts quantity)`
        );
      }

      params.append('stopPrice', this.roundTick(stopPrice, rules.priceTick));
      params.append('workingType', 'MARK_PRICE');

      this.logger.debug(`[SL CREATE] Full request params: ${params.toString()}`);

      const response = await this.createBinanceOrder(params, apiKey, apiSecret, isTestnet);

      this.logger.log(`[SL CREATE] SUCCESS - Order ID: ${response.orderId}, Status: ${response.status}`);
      return response.orderId.toString();
    } catch (error: any) {
      const errorCode = error.response?.data?.code;
      const errorMsg = error.response?.data?.msg;
      const errorData = error.response?.data;

      this.logger.error(
        `[SL CREATE] FAILED\n` +
        `  Error Code: ${errorCode}\n` +
        `  Error Message: ${errorMsg}\n` +
        `  Symbol: ${symbol}\n` +
        `  Stop Price: ${stopPrice}\n` +
        `  Quantity: ${quantity}\n` +
        `  Hedge Mode: ${hedgeMode}\n` +
        `  Full Error: ${JSON.stringify(errorData)}`
      );

      throw new StopLossCreationError(symbol, errorCode, errorMsg, errorData);
    }
  }

  private async createBinanceTakeProfitOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    tpQuantity: number,
    tpPrice: number,
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean,
    hedgeMode: boolean = false
  ): Promise<string> {
    try {
      const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
      const rules = await this.getSymbolRules(symbol, isTestnet);
      const normalizedQty = this.normalizeQuantity(tpQuantity, rules.qtyStep, rules.minQty);
      const normalizedPrice = this.roundTick(tpPrice, rules.priceTick);

      const params = new URLSearchParams();
      params.append('symbol', symbol);
      params.append('side', closeSide);
      params.append('type', 'TAKE_PROFIT_MARKET');
      params.append('quantity', normalizedQty);
      params.append('stopPrice', normalizedPrice);
      params.append('workingType', 'MARK_PRICE');

      if (hedgeMode) {
        const positionSide = side === 'BUY' ? 'LONG' : 'SHORT';
        params.append('positionSide', positionSide);

        this.logger.log(
          `[TP CREATE] BEFORE API CALL - Hedge Mode\n` +
          `  Symbol: ${symbol}\n` +
          `  Entry Side: ${side} → Close Side: ${closeSide}\n` +
          `  Position Side: ${positionSide}\n` +
          `  TP Price: ${normalizedPrice}\n` +
          `  Quantity: ${normalizedQty} (raw: ${tpQuantity})\n` +
          `  Rules: step=${rules.qtyStep}, min=${rules.minQty}, tick=${rules.priceTick}`
        );
      } else {
        params.append('reduceOnly', 'true');

        this.logger.log(
          `[TP CREATE] BEFORE API CALL - One-Way Mode\n` +
          `  Symbol: ${symbol}\n` +
          `  Entry Side: ${side} → Close Side: ${closeSide}\n` +
          `  TP Price: ${normalizedPrice}\n` +
          `  Quantity: ${normalizedQty} (raw: ${tpQuantity})\n` +
          `  Using reduceOnly=true`
        );
      }

      this.logger.debug(`[TP CREATE] Full request params: ${params.toString()}`);

      const response = await this.createBinanceOrder(params, apiKey, apiSecret, isTestnet);

      this.logger.log(`[TP CREATE] SUCCESS - Order ID: ${response.orderId}, Status: ${response.status}`);
      return response.orderId.toString();
    } catch (error: any) {
      const errorCode = error.response?.data?.code;
      const errorMsg = error.response?.data?.msg;
      const errorData = error.response?.data;

      this.logger.error(
        `[TP CREATE] FAILED\n` +
        `  Error Code: ${errorCode}\n` +
        `  Error Message: ${errorMsg}\n` +
        `  Symbol: ${symbol}\n` +
        `  TP Price: ${tpPrice}\n` +
        `  Quantity: ${tpQuantity}\n` +
        `  Hedge Mode: ${hedgeMode}\n` +
        `  Full Error: ${JSON.stringify(errorData)}`
      );

      throw new TakeProfitCreationError(symbol, errorCode, errorMsg, errorData);
    }
  }

  /**
   * Verifies that a position exists on Binance before creating SL/TP orders.
   * Retries up to 5 times with exponential backoff to handle race conditions.
   */
  private async verifyPositionExists(
    symbol: string,
    side: 'BUY' | 'SELL',
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean,
    hedgeMode: boolean = false
  ): Promise<void> {
    const baseURL = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;
    const endpoint = '/fapi/v2/positionRisk';
    const positionSide = hedgeMode ? (side === 'BUY' ? 'LONG' : 'SHORT') : 'BOTH';

    const maxRetries = 5;
    const initialDelay = 500; // ms

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const params = new URLSearchParams();
        params.append('symbol', symbol);
        params.append('timestamp', Date.now().toString());

        const queryString = params.toString();
        const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

        this.logger.debug(
          `[POSITION VERIFY] Attempt ${attempt}/${maxRetries} - Checking ${symbol} ${positionSide}`
        );

        const response = await axios.get(
          `${baseURL}${endpoint}?${queryString}&signature=${signature}`,
          { headers: { 'X-MBX-APIKEY': apiKey } }
        );

        const positions = response.data;
        const targetPosition = positions.find((pos: any) =>
          pos.symbol === symbol && pos.positionSide === positionSide
        );

        if (!targetPosition) {
          this.logger.warn(
            `[POSITION VERIFY] Position not found - Symbol: ${symbol}, Side: ${positionSide}`
          );

          if (attempt < maxRetries) {
            const delay = initialDelay * Math.pow(2, attempt - 1);
            this.logger.debug(`[POSITION VERIFY] Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }

          throw new PositionNotFoundError(symbol, positionSide);
        }

        const positionAmt = Math.abs(parseFloat(targetPosition.positionAmt));

        if (positionAmt === 0) {
          this.logger.warn(
            `[POSITION VERIFY] Position exists but quantity is 0 - Symbol: ${symbol}, Side: ${positionSide}`
          );

          if (attempt < maxRetries) {
            const delay = initialDelay * Math.pow(2, attempt - 1);
            this.logger.debug(`[POSITION VERIFY] Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }

          throw new PositionNotFoundError(symbol, positionSide);
        }

        this.logger.log(
          `[POSITION VERIFY] SUCCESS - Position found\n` +
          `  Symbol: ${symbol}\n` +
          `  Position Side: ${positionSide}\n` +
          `  Quantity: ${positionAmt}\n` +
          `  Entry Price: ${targetPosition.entryPrice}\n` +
          `  Attempt: ${attempt}/${maxRetries}`
        );

        return;
      } catch (error: any) {
        if (error instanceof PositionNotFoundError) {
          throw error;
        }

        this.logger.error(
          `[POSITION VERIFY] API Error on attempt ${attempt}/${maxRetries}\n` +
          `  Symbol: ${symbol}\n` +
          `  Error: ${error.response?.data?.msg || error.message}`
        );

        if (attempt === maxRetries) {
          throw new PositionNotFoundError(symbol, positionSide);
        }

        const delay = initialDelay * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Verifies that hedge mode was successfully set on Binance.
   * Checks the account position mode setting to confirm dual position mode.
   */
  private async verifyHedgeModeSet(
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean,
    expectedHedgeMode: boolean
  ): Promise<void> {
    const baseURL = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;
    const endpoint = '/fapi/v1/positionSide/dual';

    try {
      const params = new URLSearchParams();
      params.append('timestamp', Date.now().toString());

      const queryString = params.toString();
      const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

      this.logger.debug(`[HEDGE MODE VERIFY] Checking position mode setting...`);

      const response = await axios.get(
        `${baseURL}${endpoint}?${queryString}&signature=${signature}`,
        { headers: { 'X-MBX-APIKEY': apiKey } }
      );

      const actualDualMode = response.data.dualSidePosition;

      if (actualDualMode !== expectedHedgeMode) {
        this.logger.error(
          `[HEDGE MODE VERIFY] MISMATCH\n` +
          `  Expected: ${expectedHedgeMode ? 'Hedge Mode' : 'One-Way Mode'}\n` +
          `  Actual: ${actualDualMode ? 'Hedge Mode' : 'One-Way Mode'}\n` +
          `  This will cause SL/TP orders to fail!`
        );

        throw new Error(
          `Position mode mismatch: Expected ${expectedHedgeMode ? 'Hedge' : 'One-Way'} mode, ` +
          `but account is in ${actualDualMode ? 'Hedge' : 'One-Way'} mode. ` +
          `SL/TP orders will fail with this mismatch.`
        );
      }

      this.logger.log(
        `[HEDGE MODE VERIFY] SUCCESS - Position mode confirmed: ${actualDualMode ? 'Hedge Mode' : 'One-Way Mode'}`
      );
    } catch (error: any) {
      if (error.message?.includes('Position mode mismatch')) {
        throw error;
      }

      const errorCode = error.response?.data?.code;
      const errorMsg = error.response?.data?.msg;

      this.logger.error(
        `[HEDGE MODE VERIFY] API Error\n` +
        `  Error Code: ${errorCode}\n` +
        `  Error Message: ${errorMsg}`
      );

      throw new Error(
        `Failed to verify hedge mode setting: [${errorCode}] ${errorMsg}`
      );
    }
  }

  /**
   * Rolls back (closes) a position if SL/TP orders cannot be created.
   * Uses MARKET order with closePosition=true to close the entire position immediately.
   * This prevents leaving a position unprotected.
   */
  private async rollbackPosition(
    symbol: string,
    side: 'BUY' | 'SELL',
    entryOrderId: string,
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean,
    hedgeMode: boolean = false
  ): Promise<void> {
    try {
      const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
      const positionSide = hedgeMode ? (side === 'BUY' ? 'LONG' : 'SHORT') : 'BOTH';

      this.logger.warn(
        `[ROLLBACK] INITIATING POSITION CLOSURE\n` +
        `  Symbol: ${symbol}\n` +
        `  Entry Order ID: ${entryOrderId}\n` +
        `  Entry Side: ${side} → Close Side: ${closeSide}\n` +
        `  Position Side: ${positionSide}\n` +
        `  Reason: Failed to create SL/TP protection orders\n` +
        `  Action: Closing position with MARKET order`
      );

      const params = new URLSearchParams();
      params.append('symbol', symbol);
      params.append('side', closeSide);
      params.append('type', 'MARKET');
      params.append('quantity', '0');
      params.append('closePosition', 'true');

      if (hedgeMode) {
        params.append('positionSide', positionSide);
      }

      const response = await this.createBinanceOrder(params, apiKey, apiSecret, isTestnet);

      this.logger.warn(
        `[ROLLBACK] SUCCESS - Position closed\n` +
        `  Close Order ID: ${response.orderId}\n` +
        `  Status: ${response.status}\n` +
        `  Executed Quantity: ${response.executedQty}\n` +
        `  Avg Price: ${response.avgPrice}\n` +
        `  Entry Order ID: ${entryOrderId} was closed due to protection failure`
      );
    } catch (error: any) {
      const errorCode = error.response?.data?.code;
      const errorMsg = error.response?.data?.msg;
      const errorData = error.response?.data;

      this.logger.error(
        `[ROLLBACK] CRITICAL FAILURE - Could not close unprotected position!\n` +
        `  Symbol: ${symbol}\n` +
        `  Entry Order ID: ${entryOrderId}\n` +
        `  Error Code: ${errorCode}\n` +
        `  Error Message: ${errorMsg}\n` +
        `  Full Error: ${JSON.stringify(errorData)}\n` +
        `  ⚠️  MANUAL INTERVENTION REQUIRED - Position is open without SL/TP protection!`
      );

      throw new Error(
        `CRITICAL: Failed to rollback position ${symbol}. ` +
        `Position may be unprotected. Manual intervention required. ` +
        `Entry Order ID: ${entryOrderId}, Error: [${errorCode}] ${errorMsg}`
      );
    }
  }

  /**
   * Executes an async function with automatic retry on rate limit or transient errors.
   * Useful for API calls that may fail due to temporary issues.
   */
  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    maxRetries: number = 3,
    initialDelay: number = 1000
  ): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        const errorCode = error.response?.data?.code;
        const errorMsg = error.response?.data?.msg || error.message;

        // Retry on rate limit (-1003) or server errors (-1001, -1021)
        const isRetryable = errorCode === -1003 || errorCode === -1001 || errorCode === -1021;

        if (isRetryable && attempt < maxRetries) {
          const delay = initialDelay * Math.pow(2, attempt - 1);
          this.logger.warn(
            `[RETRY] ${operationName} failed (attempt ${attempt}/${maxRetries})\n` +
            `  Error: [${errorCode}] ${errorMsg}\n` +
            `  Retrying in ${delay}ms...`
          );
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        // Not retryable or max retries reached
        if (attempt === maxRetries) {
          this.logger.error(
            `[RETRY] ${operationName} failed after ${maxRetries} attempts\n` +
            `  Final Error: [${errorCode}] ${errorMsg}`
          );
        }

        throw error;
      }
    }

    // This should never be reached, but TypeScript needs it
    throw new Error(`executeWithRetry failed for ${operationName} without throwing`);
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

  private async getCurrentPrice(symbol: string, exchange: Exchange, isTestnet: boolean): Promise<number> {
    if (exchange === Exchange.BYBIT) {
      return await this.bybitClient.getCurrentPrice(isTestnet, symbol);
    }

    const baseURL = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;
    try {
      const response = await axios.get(`${baseURL}/fapi/v1/ticker/price?symbol=${symbol}`);
      return parseFloat(response.data.price);
    } catch (error) {
      this.logger.error(`Failed to get current price for ${symbol}: ${error.message}`);
      return 0;
    }
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

    this.logger.log(
      `[STRATEGY CONFIG] ${strategy.name} | ` +
      `Exchange: ${strategy.exchange || 'BINANCE'} | ` +
      `Testnet: ${strategy.isTestnet} | ` +
      `RealAccount: ${strategy.isRealAccount} | ` +
      `UseAccountPercentage: ${strategy.useAccountPercentage} | ` +
      `AccountPercentage: ${strategy.accountPercentage}% | ` +
      `DefaultQuantity: ${strategy.defaultQuantity} | ` +
      `Leverage: ${strategy.leverage}x | ` +
      `EnableCompound: ${strategy.enableCompound} | ` +
      `TradingMode: ${strategy.tradingMode}`
    );

    if (!strategy.isActive) {
      this.logger.warn(`Strategy ${strategy.name} is paused. Ignoring signal.`);
      return { status: 'skipped', message: 'Strategy is paused' };
    }

    if (strategy.pauseNewOrders) {
      this.logger.warn(`Strategy ${strategy.name} has new orders paused. Ignoring signal.`);
      return { status: 'skipped', message: 'New orders paused for this strategy' };
    }

    if (strategy.tradingMode === TradingMode.SINGLE) {
      const closedTradesCount = await this.tradesService.countClosedTrades(strategy.id);
      if (closedTradesCount > 0) {
        this.logger.warn(`[SINGLE MODE] Strategy ${strategy.name} already completed a trade cycle. Ignoring new signals.`);
        return { status: 'skipped', message: 'Single mode: Trade cycle completed. Reset to continue trading.' };
      }
    }

    const exchange = strategy.exchange || Exchange.BINANCE;
    const normalizedSymbol = this.normalizeSymbol(signal.symbol, exchange);
    const side = signal.action.toUpperCase() as 'BUY' | 'SELL';

    // --- POSITION MANAGEMENT ---
    const openTrades = await this.tradesService.findOpenTrades();
    const activeTradesForSymbol = openTrades.filter(t => t.symbol === normalizedSymbol && t.strategyId === strategy.id);
    const activeTrade = activeTradesForSymbol.find(t => t.side === side);
    const oppositeActiveTrade = activeTradesForSymbol.find(t => t.side !== side);

    if (activeTrade) {
        if (strategy.allowAveraging) {
            this.logger.log(`[AVERAGING] Adding to existing ${side} position for ${normalizedSymbol}.`);
        } else {
            this.logger.warn(`[POSITION] Ignoring duplicate ${side} signal for ${normalizedSymbol}. Position already open and averaging disabled.`);
            return { status: 'skipped', message: 'Position already open (averaging disabled)' };
        }
    }

    if (oppositeActiveTrade && !strategy.hedgeMode) {
            this.logger.log(`[ONE-WAY] Flipping position! Closing ${oppositeActiveTrade.side} to open ${side}.`);
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
                     closeQty = await this.getPositionSize(oppositeActiveTrade.symbol, exchange, decryptedKey, decryptedSecret, strategy.isTestnet);
                } catch (e) {
                     this.logger.warn(`[ONE-WAY] Failed to fetch live position size, falling back to DB: ${e.message}`);
                     closeQty = parseFloat(oppositeActiveTrade.quantity as any);
                }

                if (closeQty <= 0) {
                     this.logger.warn(`[ONE-WAY] Position size is 0, assuming already closed.`);
                     await this.tradesService.updateTrade(oppositeActiveTrade.id, { status: 'CLOSED' });
                } else {
                    const closeSide = oppositeActiveTrade.side === 'BUY' ? 'SELL' : 'BUY';
                    this.logger.log(`[ONE-WAY] Closing ${oppositeActiveTrade.symbol} (${closeQty}) before reversal.`);
                    
                    // Fetch rules for proper formatting
                    const rules = await this.getSymbolRules(normalizedSymbol, strategy.isTestnet);

                    if (exchange === Exchange.BYBIT) {
                        await this.bybitClient.createOrder(decryptedKey, decryptedSecret, strategy.isTestnet, {
                            symbol: normalizedSymbol,
                            side: closeSide === 'BUY' ? 'Buy' : 'Sell',
                            orderType: 'Market',
                            qty: this.normalizeQuantity(closeQty, rules.qtyStep, rules.minQty),
                            reduceOnly: true
                        });
                    } else {
                        const params = new URLSearchParams();
                        params.append('symbol', normalizedSymbol);
                        params.append('side', closeSide);
                        params.append('type', 'MARKET');
                        params.append('quantity', this.normalizeQuantity(closeQty, rules.qtyStep, rules.minQty));
                        params.append('reduceOnly', 'true');
                        await this.createBinanceOrder(params, decryptedKey, decryptedSecret, strategy.isTestnet);
                    }
                    this.logger.log(`[ONE-WAY] Position closed successfully.`);
                }

                 const exitPrice = await this.getCurrentPrice(normalizedSymbol, exchange, strategy.isTestnet);
                 const entryPrice = parseFloat(oppositeActiveTrade.entryPrice as any);
                 const quantity = parseFloat(oppositeActiveTrade.quantity as any);
                 let pnl: number;
                 if (oppositeActiveTrade.side === 'BUY') {
                   pnl = (exitPrice - entryPrice) * quantity;
                 } else {
                   pnl = (entryPrice - exitPrice) * quantity;
                 }

                 await this.tradesService.updateTrade(oppositeActiveTrade.id, {
                   status: 'CLOSED',
                   pnl,
                   exitPrice,
                   closeReason: 'SIGNAL',
                   closedAt: new Date()
                 });
                 this.logger.log(`[ONE-WAY] Position closed | Qty: ${this.formatQuantityWithUsdt(quantity, exitPrice)} | P&L: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)} USDT`);
                 this.logger.log(`[ONE-WAY] Waiting 2s before new entry...`);
                 await new Promise(r => setTimeout(r, 2000)); 

            } catch (err) {
                 this.logger.error(`[ONE-WAY] CRITICAL: Failed to close opposite position: ${err.message}`);
                 return { status: 'error', message: `One-Way Mode: Failed to close opposite position. ${err.message}` };
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

    this.logger.log(`[QUANTITY CALC] Starting calculation - signal.quantity: ${signal.quantity}, signal.accountPercentage: ${signal.accountPercentage}, strategy.useAccountPercentage: ${strategy.useAccountPercentage}, strategy.accountPercentage: ${strategy.accountPercentage}, effectivePrice: ${effectivePrice}`);

    if (signal.quantity) {
      quantity = signal.quantity;
      notional = quantity * effectivePrice!;
      this.logger.log(`[QUANTITY CALC] Using explicit quantity from signal: ${this.formatQuantityWithUsdt(quantity, effectivePrice!)}`);
    } else if (signal.accountPercentage && effectivePrice) {
      const accountBalance = await this.getAccountBalance(strategy);
      this.logger.log(`[QUANTITY CALC] Signal percentage mode - Balance: ${accountBalance.toFixed(2)} USDT, Percentage: ${signal.accountPercentage}%`);

      const targetNotional = accountBalance * (signal.accountPercentage / 100);
      quantity = targetNotional / effectivePrice;
      notional = targetNotional;

      this.logger.log(`[QUANTITY CALC] Result - Notional: ${notional.toFixed(2)} USDT, Quantity: ${this.formatQuantityWithUsdt(quantity, effectivePrice)}`);
    } else if (strategy.useAccountPercentage && strategy.accountPercentage && effectivePrice) {
      this.logger.log(`[QUANTITY CALC] Strategy percentage mode - enableCompound: ${strategy.enableCompound}`);

      if (!strategy.enableCompound) {
        const lastTradeWithQty = await this.tradesService.findLastTradeWithInitialQuantity(strategy.id);
        if (lastTradeWithQty && lastTradeWithQty.initialQuantity) {
          quantity = parseFloat(lastTradeWithQty.initialQuantity as any);
          notional = quantity * effectivePrice;
          this.logger.log(`[COMPOUND OFF] Using fixed quantity from first trade: ${this.formatQuantityWithUsdt(quantity, effectivePrice)}, Notional: ${notional.toFixed(2)} USDT`);
        } else {
          const accountBalance = await this.getAccountBalance(strategy);
          this.logger.log(`[COMPOUND OFF] First trade - Balance: ${accountBalance.toFixed(2)} USDT, Percentage: ${strategy.accountPercentage}%`);

          const targetNotional = accountBalance * (strategy.accountPercentage / 100);
          quantity = targetNotional / effectivePrice;
          notional = targetNotional;

          this.logger.log(`[COMPOUND OFF] First trade result - Notional: ${notional.toFixed(2)} USDT, Quantity: ${this.formatQuantityWithUsdt(quantity, effectivePrice)}`);
        }
      } else {
        const accountBalance = await this.getAccountBalance(strategy);
        this.logger.log(`[COMPOUND ON] Balance: ${accountBalance.toFixed(2)} USDT, Percentage: ${strategy.accountPercentage}%`);

        const targetNotional = accountBalance * (strategy.accountPercentage / 100);
        quantity = targetNotional / effectivePrice;
        notional = targetNotional;

        this.logger.log(`[COMPOUND ON] Result - Notional: ${notional.toFixed(2)} USDT, Quantity: ${this.formatQuantityWithUsdt(quantity, effectivePrice)}`);
      }
    } else {
      quantity = strategy.defaultQuantity || 0.002;
      notional = quantity * (effectivePrice || 0);
      this.logger.log(`[QUANTITY CALC] Using default quantity from strategy: ${this.formatQuantityWithUsdt(quantity, effectivePrice || 0)}, Notional: ${notional.toFixed(2)} USDT`);
    }

    this.logger.log(`[QUANTITY CALC] FINAL VALUES - Quantity: ${quantity.toFixed(6)}, Notional: ${notional.toFixed(2)} USDT, Leverage: ${strategy.leverage}x`);

    if (notional < 5) {
       this.logger.warn(
         `[WARNING] Calculated notional (${notional.toFixed(2)} USDT) is extremely low. ` +
         `Binance Minimum is usually 5-10 USDT (100 on some pairs/testnet). ` +
         `DEBUG: quantity=${quantity.toFixed(6)}, price=${effectivePrice}, ` +
         `useAccountPercentage=${strategy.useAccountPercentage}, accountPercentage=${strategy.accountPercentage}%`
       );
    }

    if (notional < 10) {
       this.logger.error(
         `[NOTIONAL ERROR] Trade REJECTED - Notional too low! ` +
         `Calculated: ${notional.toFixed(2)} USDT | Minimum Required: 10 USDT | ` +
         `Symbol: ${normalizedSymbol} | Side: ${side} | ` +
         `Quantity: ${quantity.toFixed(6)} | Price: ${effectivePrice} | Leverage: ${strategy.leverage}x | ` +
         `Strategy Config: useAccountPercentage=${strategy.useAccountPercentage}, accountPercentage=${strategy.accountPercentage}%, ` +
         `enableCompound=${strategy.enableCompound}, isTestnet=${strategy.isTestnet}`
       );

       const tradeData: Partial<Trade> = {
          strategyId: strategy.id,
          symbol: normalizedSymbol,
          side,
          type: isLimitOrder ? 'LIMIT' : 'MARKET',
          entryPrice: effectivePrice,
          quantity,
          status: 'ERROR',
          error: `Notional too low: ${notional.toFixed(2)} USDT (min 10 USDT). Check account balance and strategy settings.`,
       };
       await this.tradesService.create(tradeData);

       return {
         status: 'error',
         message: `Notional too low: ${notional.toFixed(2)} USDT. Minimum required: 10 USDT. Check account balance and percentage settings.`
       };
    }

    const isAveragingTrade = activeTrade && strategy.allowAveraging;
    const shouldSaveInitialQuantity = !strategy.enableCompound && strategy.useAccountPercentage &&
      !(await this.tradesService.findLastTradeWithInitialQuantity(strategy.id));

    const tradeData: Partial<Trade> = {
      strategyId: strategy.id,
      symbol: normalizedSymbol,
      side,
      type: isLimitOrder ? 'LIMIT' : 'MARKET',
      entryPrice: effectivePrice,
      quantity,
      status: 'OPEN',
      isFromAveraging: isAveragingTrade,
      initialQuantity: shouldSaveInitialQuantity ? quantity : undefined,
    };

    if (!strategy.isTestnet && !strategy.isRealAccount) {
      this.logger.warn(
        `[BLOCKED] Strategy "${strategy.name}" has neither testnet nor real account enabled. ` +
        `Please enable either testnet mode or real account mode to execute orders.`
      );
      tradeData.status = 'ERROR';
      tradeData.error = 'Strategy must have either testnet or real account enabled';
      await this.tradesService.create(tradeData);
      return {
        status: 'error',
        message: 'Strategy must have either testnet or real account enabled. Please update strategy settings.',
        trade: tradeData
      };
    }

    const accountMode = strategy.isTestnet ? 'TESTNET' : 'MAINNET';
    const executionMode = (!strategy.isTestnet && strategy.isRealAccount) ? '[REAL ACCOUNT]' : `[${accountMode}]`;

    if (!strategy.isTestnet && strategy.isRealAccount) {
      this.logger.warn(`🚨 ${executionMode} EXECUTING REAL ORDER: ${side} ${this.formatQuantityWithUsdt(quantity, effectivePrice || 0)} on ${normalizedSymbol}`);
    } else {
      this.logger.log(`${executionMode} Executing: ${side} ${this.formatQuantityWithUsdt(quantity, effectivePrice || 0)} on ${normalizedSymbol}`);
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
          strategy.isTestnet,
          strategy.hedgeMode
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

      // For Binance: Verify position exists before creating SL/TP (prevents race condition)
      if (exchange === Exchange.BINANCE) {
        this.logger.log(`[POSITION VERIFY] Waiting for position to appear in system...`);
        try {
          await this.verifyPositionExists(
            normalizedSymbol,
            side,
            decryptedKey,
            decryptedSecret,
            strategy.isTestnet,
            strategy.hedgeMode
          );
        } catch (error: any) {
          this.logger.error(
            `[POSITION VERIFY] Failed - Position not found after entry order.\n` +
            `  This may indicate the entry order was not filled or a system delay.\n` +
            `  Proceeding with caution...`
          );
          // Don't throw here - let SL/TP creation attempt and handle errors there
        }
      }

      // --- STOP LOSS & TAKE PROFIT CREATION WITH ROLLBACK ---
      // CRITICAL: If SL/TP creation fails, we MUST close the position to avoid unprotected trades
      try {
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
          const rules = await this.getSymbolRules(normalizedSymbol, strategy.isTestnet);

          if (exchange === Exchange.BYBIT) {
            const bybitSide = side === 'BUY' ? 'Buy' : 'Sell';
            await this.bybitClient.setTradingStop(
              decryptedKey, decryptedSecret, strategy.isTestnet,
              normalizedSymbol, bybitSide, this.roundTick(stopLossPrice, rules.priceTick), undefined
            );
          } else {
            // This now throws on error instead of returning null
            stopLossOrderId = await this.createBinanceStopLossOrder(
              normalizedSymbol, side, quantity, stopLossPrice, decryptedKey, decryptedSecret, strategy.isTestnet, strategy.hedgeMode
            );
            this.logger.log(`[SL] Successfully created Stop Loss order: ${stopLossOrderId}`);
          }
        }

        // --- MULTI-PARTIAL TAKE PROFITS ---
        const tpConfigs = [
          { percent: strategy.takeProfitPercentage1, qtyPercent: strategy.takeProfitQuantity1 || 33, id: 1 },
          { percent: strategy.takeProfitPercentage2, qtyPercent: strategy.takeProfitQuantity2 || 33, id: 2 },
          { percent: strategy.takeProfitPercentage3, qtyPercent: strategy.takeProfitQuantity3 || 34, id: 3 },
        ];

        const tpOrderIds: string[] = [];

        for (const tp of tpConfigs) {
          if (tp.percent && tp.percent > 0) {
            const tpPrice = this.calculateTakeProfitPrice(side, entryPrice, tp.percent);
            const tpQty = (quantity * tp.qtyPercent) / 100;

            if (tpQty <= 0) continue;

            this.logger.log(`[TP${tp.id}] Placing partial TP at ${tpPrice.toFixed(2)} for ${this.formatQuantityWithUsdt(tpQty, tpPrice)} (${tp.qtyPercent}%)`);

            const rules = await this.getSymbolRules(normalizedSymbol, strategy.isTestnet);

            if (exchange === Exchange.BYBIT) {
              await this.bybitClient.createOrder(
                decryptedKey, decryptedSecret, strategy.isTestnet,
                {
                  symbol: normalizedSymbol,
                  side: side === 'BUY' ? 'Sell' : 'Buy',
                  orderType: 'Limit',
                  qty: this.normalizeQuantity(tpQty, rules.qtyStep, rules.minQty),
                  price: this.roundTick(tpPrice, rules.priceTick),
                  reduceOnly: true
                }
              );
            } else {
              // This now throws on error instead of returning null
              const tpOrderId = await this.createBinanceTakeProfitOrder(
                normalizedSymbol, side, tpQty, tpPrice, decryptedKey, decryptedSecret, strategy.isTestnet, strategy.hedgeMode
              );
              tpOrderIds.push(`${tp.id}:${tpOrderId}`);
              this.logger.log(`[TP${tp.id}] Successfully created Take Profit order: ${tpOrderId}`);
            }
          }
        }

        if (tpOrderIds.length > 0) {
          takeProfitOrderId = tpOrderIds.join('|');
        }

        this.logger.log(
          `[PROTECTION] All protection orders created successfully\n` +
          `  Stop Loss: ${stopLossOrderId || 'N/A'}\n` +
          `  Take Profits: ${takeProfitOrderId || 'N/A'}`
        );

      } catch (protectionError: any) {
        // CRITICAL: SL/TP creation failed - position is unprotected
        this.logger.error(
          `[PROTECTION] FAILED - Cannot create protection orders!\n` +
          `  Error: ${protectionError.message}\n` +
          `  Entry Order ID: ${tradeDetails.id}\n` +
          `  Symbol: ${normalizedSymbol}\n` +
          `  Action: Rolling back position to prevent unprotected trade`
        );

        // Rollback: Close the position immediately for Binance
        if (exchange === Exchange.BINANCE) {
          try {
            await this.rollbackPosition(
              normalizedSymbol,
              side,
              tradeDetails.id,
              decryptedKey,
              decryptedSecret,
              strategy.isTestnet,
              strategy.hedgeMode
            );

            // Update trade record to show it was rolled back
            await this.tradesService.updateTrade(savedTrade.id, {
              entryPrice: tradeData.entryPrice,
              exchangeOrderId: tradeData.exchangeOrderId,
              stopLossOrderId: 'ROLLBACK',
              takeProfitOrderId: 'ROLLBACK_DUE_TO_PROTECTION_FAILURE',
            });

            throw new PositionProtectionError(
              `Position opened but protection orders failed. Position has been closed automatically. ` +
              `Original error: ${protectionError.message}`,
              tradeDetails.id,
              normalizedSymbol
            );
          } catch (rollbackError: any) {
            // Even rollback failed - CRITICAL situation
            this.logger.error(
              `[ROLLBACK] CRITICAL FAILURE\n` +
              `  Could not close unprotected position!\n` +
              `  Symbol: ${normalizedSymbol}\n` +
              `  Entry Order: ${tradeDetails.id}\n` +
              `  ⚠️  MANUAL INTERVENTION REQUIRED`
            );

            await this.tradesService.updateTrade(savedTrade.id, {
              entryPrice: tradeData.entryPrice,
              exchangeOrderId: tradeData.exchangeOrderId,
              stopLossOrderId: 'ROLLBACK_FAILED',
              takeProfitOrderId: 'CRITICAL_UNPROTECTED_POSITION',
            });

            throw rollbackError;
          }
        } else {
          // Bybit - just throw the error (Bybit has different order management)
          throw new PositionProtectionError(
            `Failed to create protection orders: ${protectionError.message}`,
            tradeDetails.id,
            normalizedSymbol
          );
        }
      }

      await this.tradesService.updateTrade(savedTrade.id, {
        entryPrice: tradeData.entryPrice,
        exchangeOrderId: tradeData.exchangeOrderId,
        stopLossOrderId: stopLossOrderId || undefined,
        takeProfitOrderId: takeProfitOrderId || undefined,
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
    const formattedQty = this.normalizeQuantity(quantity, rules.qtyStep, rules.minQty); 
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
        qty: this.normalizeQuantity(quantity, '0.001', '0.001'), // Should use Bybit rules separately, defaulting for safety or need Bybit specific fetch
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

      params.append('quantity', this.normalizeQuantity(quantity, (await this.getSymbolRules(symbol, strategy.isTestnet)).qtyStep, (await this.getSymbolRules(symbol, strategy.isTestnet)).minQty));

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
        const order = await exchangeInstance.createLimitOrder(symbol, signal.action, this.normalizeQuantity(quantity, rules.qtyStep, rules.minQty), this.roundTick(signal.price || 0, rules.priceTick));
        this.logger.log(`[BINANCE] Limit Order Placed via CCXT: ${order.id}`);
        return order;
      } else {
        const rules = await this.getSymbolRules(symbol, strategy.isTestnet);
        const order = await exchangeInstance.createMarketOrder(symbol, signal.action, this.normalizeQuantity(quantity, rules.qtyStep, rules.minQty));
        this.logger.log(`[BINANCE] Market Order Placed via CCXT: ${order.id}`);
        return order;
      }
    }
  }
}
