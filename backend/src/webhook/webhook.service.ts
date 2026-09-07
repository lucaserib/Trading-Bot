import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { TradingviewSignalDto, OrderType } from './dto/tradingview-signal.dto';
import { ExchangeService } from '../exchange/exchange.service';
import { BybitClientService } from '../exchange/bybit-client.service';
import { StrategiesService } from '../strategies/strategies.service';
import { TradesService } from '../trades/trades.service';
import { Trade } from '../strategies/trade.entity';
import { Exchange, MarginMode, Strategy, TradingMode } from '../strategies/strategy.entity';
import { ExecutionType } from '../trades/trade-execution.entity';
import { EncryptionUtil } from '../utils/encryption.util';
import { RateLimiterUtil } from '../utils/rate-limiter.util';
import { ExchangeCacheUtil } from '../utils/exchange-cache.util';
import { BinanceWebSocketService } from '../binance-ws/binance-ws.service';
import { SignalLogService } from './signal-log.service';
import { SignalDecision } from './signal-log.entity';
import { BinanceRequestUtil } from '../utils/binance-request.util';
import { resolveBybitActualFillPrice } from './bybit-fill-price.util';
import { resolveProtectionPrice, resolveFinalEntryPrice } from './protection-price.util';
import { planTakeProfits, buildEnabledTpConfigs, buildTpWarnings } from './tp-planner.util';
import { withOneRetry } from './retry.util';
import { parseTrackedTpOrders, countLiveTrackedOrders } from '../auditor/missing-tp-orders.util';
import axios from 'axios';
import * as crypto from 'crypto';
import Decimal from 'decimal.js';
import { normalizeQuantity, roundPriceToTick } from '../common/exchange-precision.util';
import { SymbolRulesService } from '../common/symbol-rules.service';
import { CredentialsResolverService } from '../common/credentials-resolver.service';

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

  private readonly activeSignals = new Set<string>();
  private readonly activeSignalsTimestamps = new Map<string, number>();
  private readonly resumingProtection = new Set<string>();
  private readonly SIGNAL_TIMEOUT_MS = 5 * 60 * 1000;
  private readonly rateLimiter = RateLimiterUtil.getInstance(); // 5 minutes

  constructor(
    private readonly exchangeService: ExchangeService,
    private readonly bybitClient: BybitClientService,
    private readonly strategiesService: StrategiesService,
    private readonly tradesService: TradesService,
    private readonly binanceWs: BinanceWebSocketService,
    private readonly signalLog: SignalLogService,
    private readonly symbolRulesService: SymbolRulesService,
    private readonly credentialsResolver: CredentialsResolverService
  ) {}

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private normalizeSymbol(symbol: string, exchange: Exchange): string {
    if (exchange === Exchange.BINANCE) {
      return symbol.replace('/', '').replace('-', '');
    } else if (exchange === Exchange.BYBIT) {
      return symbol.replace('/', '').replace('-', '');
    }
    return symbol;
  }

  private async getSymbolRules(
    symbol: string,
    isTestnet: boolean,
    exchange: Exchange = Exchange.BINANCE
  ): Promise<{ qtyStep: string; priceTick: string; minQty: string; minNotional: string }> {
    return this.symbolRulesService.getSymbolRules(symbol, isTestnet, exchange);
  }


  private formatQuantityWithUsdt(quantity: number, price: number): string {
    const usdt = quantity * price;
    return `${quantity.toFixed(4)} (~${usdt.toFixed(2)} USDT)`;
  }

  private async getAccountBalance(strategy: Strategy): Promise<number> {
    try {
      const credentials = await this.credentialsResolver.resolveCredentials(strategy);
      const resolvedStrategy = { ...strategy, ...credentials };
      const decryptedKey = (await EncryptionUtil.decrypt(resolvedStrategy.apiKey)).trim();
      const decryptedSecret = (await EncryptionUtil.decrypt(resolvedStrategy.apiSecret)).trim();

      const exchange = resolvedStrategy.exchange || Exchange.BINANCE;
      const cacheKey = `balance:${exchange}:${resolvedStrategy.id}:${resolvedStrategy.isTestnet}`;

      const cached = this.rateLimiter.getCached<number>(cacheKey);
      if (cached !== null) {
        this.logger.debug(`[BALANCE] Using cached value: ${cached.toFixed(2)} USDT`);
        return cached;
      }

      if (exchange === Exchange.BYBIT) {
        const balance = await this.bybitClient.getWalletBalance(decryptedKey, decryptedSecret, resolvedStrategy.isTestnet);
        this.rateLimiter.setCached(cacheKey, balance, 10000);
        this.logger.log(`[BALANCE] Bybit ${resolvedStrategy.isTestnet ? 'Testnet' : 'Mainnet'}: ${balance.toFixed(2)} USDT`);
        return balance;
      }

      if (exchange === Exchange.BINANCE) {
        await this.sleep(2000);

        const baseURL = resolvedStrategy.isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;
        const timestamp = Date.now();
        const queryString = `timestamp=${timestamp}`;
        const signature = crypto.createHmac('sha256', decryptedSecret).update(queryString).digest('hex');

        this.logger.log(`[BALANCE] Fetching from: ${baseURL}/fapi/v2/balance`);
        this.logger.debug(`[BALANCE] API Key: ${decryptedKey.substring(0, 8)}...`);

        const response = await BinanceRequestUtil.get(`${baseURL}/fapi/v2/balance?${queryString}&signature=${signature}`, {
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
          `[BALANCE] Binance ${resolvedStrategy.isTestnet ? 'Testnet' : 'Mainnet'} Futures USDT: ` +
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

        this.rateLimiter.setCached(cacheKey, balance, 10000);
        return balance;
      } else {
        const balance = await this.bybitClient.getWalletBalance(decryptedKey, decryptedSecret, resolvedStrategy.isTestnet);
        this.rateLimiter.setCached(cacheKey, balance, 10000);
        this.logger.log(`[BALANCE] Bybit ${resolvedStrategy.isTestnet ? 'Testnet' : 'Mainnet'}: ${balance.toFixed(2)} USDT`);

        if (balance === 0) {
          this.logger.warn(`[BALANCE] WARNING: Account balance is 0 USDT. This will cause notional errors.`);
        }

        return balance;
      }
    } catch (error: any) {
      if (error.message && error.message.includes('Bybit API Key lacks permissions')) {
        this.logger.error(
          `[BALANCE] BYBIT PERMISSION ERROR:\n` +
          `  - Go to Bybit > API Management\n` +
          `  - Enable "Read" permission for Account\n` +
          `  - Enable "Contract Trading" permission\n` +
          `  - Add Railway IP to whitelist if IP restriction is ON\n` +
          `  - Ensure Unified Trading Account is enabled`
        );
        throw error;
      }

      if (error.response) {
        const errorCode = error.response.data?.code;
        const errorMsg = error.response.data?.msg;
        const retMsg = error.response.data?.retMsg;
        const statusCode = error.response.status;

        this.logger.error(
          `[BALANCE] API ERROR! ` +
          `HTTP ${statusCode} | ` +
          `Code: ${errorCode} | ` +
          `Message: ${errorMsg || retMsg} | ` +
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

            const response = await BinanceRequestUtil.get(`${baseURL}${endpoint}?${queryString}&signature=${signature}`, {
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

  /**
   * Get current position mode from Binance account
   */
  private async getBinancePositionMode(
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<boolean> {
    const cacheKey = `posmode:${apiKey.substring(0, 8)}:${isTestnet}`;

    const cached = this.rateLimiter.getCached<boolean>(cacheKey);
    if (cached !== null) {
      this.logger.log(`[POSITION MODE DETECT] Using cached: ${cached ? 'HEDGE' : 'ONE-WAY'}`);
      return cached;
    }

    const baseURL = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;
    this.logger.log(`[POSITION MODE DETECT] Querying ${baseURL}/fapi/v1/positionSide/dual...`);
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

    try {
      const response = await BinanceRequestUtil.get(
        `${baseURL}/fapi/v1/positionSide/dual?${queryString}&signature=${signature}`,
        { headers: { 'X-MBX-APIKEY': apiKey } }
      );
      const mode = response.data.dualSidePosition === true;
      this.logger.log(`[POSITION MODE DETECT] API Response: dualSidePosition=${response.data.dualSidePosition}, mode=${mode ? 'HEDGE' : 'ONE-WAY'}`);
      this.rateLimiter.setCached(cacheKey, mode, 1800000);
      return mode;
    } catch (error: any) {
      const errorMsg = error.response?.data?.msg || error.message;
      const errorCode = error.response?.data?.code;
      this.logger.error(`[POSITION MODE DETECT] FAILED - Code: ${errorCode}, Message: ${errorMsg}`);
      this.logger.warn(`[POSITION MODE DETECT] Defaulting to ONE-WAY mode (false) due to error`);
      return false;
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
    if (process.env.BINANCE_SKIP_POSITION_CONFIG === 'true') {
      this.logger.debug(`[CONFIG] Skipping position settings - assuming already configured`);
      return;
    }

    const baseURL = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;

    // First, check current position mode to avoid unnecessary API calls
    const currentMode = await this.getBinancePositionMode(apiKey, apiSecret, isTestnet);
    if (currentMode === hedgeMode) {
      this.logger.debug(
        `[POSITION MODE] Already in ${hedgeMode ? 'Hedge Mode' : 'One-Way Mode'} - no change needed`
      );
    } else {
      // Only try to change if mode is different
      try {
        const dualTimestamp = Date.now();
        const dualQueryString = `dualSidePosition=${hedgeMode}&timestamp=${dualTimestamp}`;
        const dualSignature = crypto.createHmac('sha256', apiSecret).update(dualQueryString).digest('hex');

        this.logger.log(`[POSITION MODE] Changing from ${currentMode ? 'Hedge' : 'One-Way'} to ${hedgeMode ? 'Hedge' : 'One-Way'}`);
        this.logger.debug(`[POSITION MODE] Request params: ${dualQueryString}`);

      await BinanceRequestUtil.post(
        `${baseURL}/fapi/v1/positionSide/dual`,
        `${dualQueryString}&signature=${dualSignature}`,
        { headers: { 'X-MBX-APIKEY': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      this.logger.log(`[POSITION MODE] SUCCESS - Position mode set to ${hedgeMode ? 'Hedge' : 'One-Way'}`);
    } catch (error: any) {
      const errorCode = error.response?.data?.code;
      const errorMsg = error.response?.data?.msg;

      // Error -4300 or "No need to change position side" message: Position mode already matches the requested setting
      // Note: Binance Testnet sometimes returns -4059 with "No need to change" message instead of -4300
      const isAlreadyConfigured = errorCode === -4300 ||
        (errorMsg && errorMsg.toLowerCase().includes('no need to change'));

      if (isAlreadyConfigured) {
        this.logger.debug(
          `[POSITION MODE] Already configured correctly\n` +
          `  Requested Mode: ${hedgeMode ? 'Hedge Mode (Dual Position)' : 'One-Way Mode'}\n` +
          `  Status: No change needed (code ${errorCode} is normal)\n` +
          `  This is not an error - the account is already in the correct position mode`
        );
      }
      // Error -4059: Position mode cannot be changed if positions exist (only if NOT "no need to change")
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
    } // Close else block

    const marginCacheKey = `margin:${apiKey.substring(0, 8)}:${symbol}:${marginMode}:${isTestnet}`;
    const marginCached = this.rateLimiter.getCached<boolean>(marginCacheKey);

    if (!marginCached) {
      try {
        const marginTimestamp = Date.now();
        const marginQueryString = `symbol=${symbol}&marginType=${marginMode}&timestamp=${marginTimestamp}`;
        const marginSignature = crypto.createHmac('sha256', apiSecret).update(marginQueryString).digest('hex');

        await BinanceRequestUtil.post(
          `${baseURL}/fapi/v1/marginType`,
          `${marginQueryString}&signature=${marginSignature}`,
          {
            headers: {
              'X-MBX-APIKEY': apiKey,
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          }
        );
        this.rateLimiter.setCached(marginCacheKey, true, 1800000);
        this.logger.log(`[BINANCE] Margin mode set to ${marginMode} for ${symbol}`);
      } catch (error: any) {
        if (error.response?.data?.code === -4046) {
          this.rateLimiter.setCached(marginCacheKey, true, 1800000);
          this.logger.debug(`[BINANCE] Margin mode already set to ${marginMode} for ${symbol}`);
        } else {
          this.logger.warn(`[BINANCE] Failed to set margin mode: ${error.response?.data?.msg || error.message}`);
        }
      }
    } else {
      this.logger.debug(`[BINANCE] Margin mode cached: ${marginMode} for ${symbol}`);
    }

    const leverageCacheKey = `leverage:${apiKey.substring(0, 8)}:${symbol}:${leverage}:${isTestnet}`;
    const leverageCached = this.rateLimiter.getCached<boolean>(leverageCacheKey);

    if (!leverageCached) {
      try {
        const leverageTimestamp = Date.now();
        const leverageQueryString = `symbol=${symbol}&leverage=${leverage}&timestamp=${leverageTimestamp}`;
        const leverageSignature = crypto.createHmac('sha256', apiSecret).update(leverageQueryString).digest('hex');

        await BinanceRequestUtil.post(
          `${baseURL}/fapi/v1/leverage`,
          `${leverageQueryString}&signature=${leverageSignature}`,
          {
            headers: {
              'X-MBX-APIKEY': apiKey,
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          }
        );
        this.rateLimiter.setCached(leverageCacheKey, true, 1800000);
        this.logger.log(`[BINANCE] Leverage set to ${leverage}x for ${symbol}`);
      } catch (error: any) {
        this.logger.warn(`[BINANCE] Failed to set leverage: ${error.response?.data?.msg || error.message}`);
      }
    } else {
      this.logger.debug(`[BINANCE] Leverage cached: ${leverage}x for ${symbol}`);
    }

    // Verify that hedge mode was actually set correctly
    await this.verifyHedgeModeSet(apiKey, apiSecret, isTestnet, hedgeMode);
  }

  private async cancelBinanceSingleOrder(
    symbol: string,
    orderId: string,
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<void> {
    const baseURL = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;
    const params = new URLSearchParams();
    params.append('symbol', symbol);
    params.append('orderId', orderId);
    params.append('timestamp', Date.now().toString());

    const queryString = params.toString();
    const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

    await BinanceRequestUtil.delete(`${baseURL}/fapi/v1/order?${queryString}&signature=${signature}`, {
      headers: { 'X-MBX-APIKEY': apiKey }
    });
  }

  private async cancelBinanceAlgoOrder(
    algoId: string,
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<void> {
    // NEW ALGO ORDER API - Cancel conditional orders (STOP_MARKET, etc)
    const baseURL = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;
    const params = new URLSearchParams();
    params.append('algoId', algoId);
    params.append('timestamp', Date.now().toString());

    const queryString = params.toString();
    const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

    await BinanceRequestUtil.delete(`${baseURL}/fapi/v1/algoOrder?${queryString}&signature=${signature}`, {
      headers: { 'X-MBX-APIKEY': apiKey }
    });
  }

  private async cancelBinanceOrderOrAlgo(
    symbol: string,
    orderId: string,
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<void> {
    // Smart cancellation: Try Algo Order first (new orders), fallback to regular order (old orders)
    try {
      // Try as Algo Order first (STOP_MARKET conditional orders created after Dec 2025)
      await this.cancelBinanceAlgoOrder(orderId, apiKey, apiSecret, isTestnet);
      this.logger.debug(`[CANCEL] Successfully cancelled Algo Order ${orderId}`);
    } catch (algoError: any) {
      const algoErrorCode = algoError.response?.data?.code;

      // If not found as Algo Order, try as regular order (backwards compatibility)
      if (algoErrorCode === -4143 || algoErrorCode === -1102) {
        try {
          await this.cancelBinanceSingleOrder(symbol, orderId, apiKey, apiSecret, isTestnet);
          this.logger.debug(`[CANCEL] Successfully cancelled regular order ${orderId}`);
        } catch (regularError: any) {
          // If both fail, throw the original error
          throw regularError;
        }
      } else {
        // Other algo order errors, rethrow
        throw algoError;
      }
    }
  }

  private async cancelAllBinanceOrders(
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean,
    symbol: string
  ): Promise<void> {
    const baseURL = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;

    // Cancel regular orders (LIMIT, etc)
    const params = new URLSearchParams();
    params.append('symbol', symbol);
    params.append('timestamp', Date.now().toString());

    const queryString = params.toString();
    const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

    try {
      await BinanceRequestUtil.delete(`${baseURL}/fapi/v1/allOpenOrders?${queryString}&signature=${signature}`, {
        headers: { 'X-MBX-APIKEY': apiKey }
      });
      this.logger.log(`[BINANCE] Cancelled all open orders for ${symbol}`);
    } catch (error: any) {
       this.logger.warn(`[BINANCE] Failed to cancel open orders: ${error.response?.data?.msg || error.message}`);
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
          this.logger.log(`[BINANCE] Cancelled algo order ${algoOrder.algoId} for ${symbol}`);
        } catch (e: any) {
          this.logger.warn(`[BINANCE] Failed to cancel algo order ${algoOrder.algoId}: ${e.message}`);
        }
      }
    } catch (e: any) {
      this.logger.warn(`[BINANCE] Failed to fetch/cancel algo orders: ${e.message}`);
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

  private async getBybitActualFillPrice(
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean,
    symbol: string,
    orderId: string,
    side: 'Buy' | 'Sell'
  ): Promise<number | undefined> {
    return resolveBybitActualFillPrice({
      getOrderInfo: () => this.bybitClient.getOrderInfo(apiKey, apiSecret, isTestnet, symbol, orderId),
      getOrderHistory: () => this.bybitClient.getOrderHistory(apiKey, apiSecret, isTestnet, symbol, orderId),
      getPositions: () => this.bybitClient.getPositions(apiKey, apiSecret, isTestnet, symbol),
      side,
    });
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

    const response = await BinanceRequestUtil.post(`${baseURL}${endpoint}`, body, {
      headers: {
        'X-MBX-APIKEY': apiKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    return response.data;
  }

  private async createBinanceAlgoOrder(
    params: URLSearchParams,
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<{ algoId: number }> {
    // NEW ALGO ORDER API (mandatory since 2025-12-09)
    // For conditional orders: STOP_MARKET, TAKE_PROFIT_MARKET, STOP, TAKE_PROFIT, TRAILING_STOP_MARKET
    const baseURL = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;
    const endpoint = '/fapi/v1/algoOrder';

    params.append('timestamp', Date.now().toString());
    const queryString = params.toString();
    const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
    const body = `${queryString}&signature=${signature}`;

    const response = await BinanceRequestUtil.post(`${baseURL}${endpoint}`, body, {
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
    hedgeMode: boolean = false,
    actualPositionSide?: string // Override detected position mode (BOTH, LONG, SHORT)
  ): Promise<string> {
    try {
      const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
      const rules = await this.getSymbolRules(symbol, isTestnet);
      const normalizedQty = normalizeQuantity(quantity, rules.qtyStep, rules.minQty);

      const normalizedStopPrice = roundPriceToTick(stopPrice, rules.priceTick);

      // NEW ALGO ORDER API (since 2025-12-09)
      // Conditional orders must use /fapi/v1/algoOrder endpoint
      const params = new URLSearchParams();
      params.append('symbol', symbol);
      params.append('side', closeSide);
      params.append('algoType', 'CONDITIONAL');
      params.append('type', 'STOP_MARKET');
      params.append('quantity', normalizedQty);
      params.append('triggerPrice', normalizedStopPrice);  // ALGO API uses triggerPrice, not stopPrice
      params.append('workingType', 'MARK_PRICE');

      // Use detected position mode if provided, otherwise calculate from hedgeMode
      const usePositionSide = actualPositionSide || (hedgeMode ? (side === 'BUY' ? 'LONG' : 'SHORT') : null);
      const isOneWayMode = actualPositionSide === 'BOTH';

      // CRITICAL: In One-Way Mode (BOTH), use reduceOnly instead of positionSide
      // Algo API does not accept positionSide=BOTH, only LONG/SHORT or reduceOnly
      if (usePositionSide && !isOneWayMode) {
        const positionSide = usePositionSide;
        params.append('positionSide', positionSide);

        this.logger.log(
          `[SL CREATE] Hedge Mode STOP_MARKET (Algo API)\n` +
          `  Symbol: ${symbol}\n` +
          `  Entry Side: ${side} → Close Side: ${closeSide}\n` +
          `  Position Side: ${positionSide}\n` +
          `  Stop Price (trigger): ${normalizedStopPrice}\n` +
          `  Quantity: ${normalizedQty} (raw: ${quantity})\n` +
          `  Rules: step=${rules.qtyStep}, min=${rules.minQty}, tick=${rules.priceTick}`
        );
      } else {
        params.append('reduceOnly', 'true');

        this.logger.log(
          `[SL CREATE] One-Way Mode STOP_MARKET (Algo API)\n` +
          `  Symbol: ${symbol}\n` +
          `  Entry Side: ${side} → Close Side: ${closeSide}\n` +
          `  Stop Price (trigger): ${normalizedStopPrice}\n` +
          `  Quantity: ${normalizedQty} (raw: ${quantity})\n` +
          `  Using reduceOnly=true`
        );
      }

      this.logger.debug(`[SL CREATE] Full request params: ${params.toString()}`);

      try {
        const response = await this.createBinanceAlgoOrder(params, apiKey, apiSecret, isTestnet);
        this.logger.log(`[SL CREATE] SUCCESS - Algo Order ID: ${response.algoId}`);
        return response.algoId.toString();
      } catch (firstError: any) {
        const errorCode = firstError.response?.data?.code;

        // If error -4061 (position side mismatch) and we used positionSide, retry with reduceOnly
        if (errorCode === -4061 && usePositionSide && usePositionSide !== 'BOTH') {
          this.logger.warn(
            `[SL CREATE] Error -4061 detected - Retrying with One-Way Mode (reduceOnly) instead of positionSide=${usePositionSide}`
          );

          // Remove positionSide and add reduceOnly
          params.delete('positionSide');
          params.set('reduceOnly', 'true');

          const retryResponse = await this.createBinanceAlgoOrder(params, apiKey, apiSecret, isTestnet);
          this.logger.log(`[SL CREATE] SUCCESS (One-Way Mode fallback) - Algo Order ID: ${retryResponse.algoId}`);
          return retryResponse.algoId.toString();
        }

        throw firstError;
      }
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
    hedgeMode: boolean = false,
    actualPositionSide?: string // Override detected position mode (BOTH, LONG, SHORT)
  ): Promise<string> {
    try {
      const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
      const rules = await this.getSymbolRules(symbol, isTestnet);
      const normalizedQty = normalizeQuantity(tpQuantity, rules.qtyStep, rules.minQty);
      const normalizedStopPrice = roundPriceToTick(tpPrice, rules.priceTick);

      const params = new URLSearchParams();
      params.append('symbol', symbol);
      params.append('side', closeSide);
      params.append('type', 'LIMIT');
      params.append('quantity', normalizedQty);
      params.append('price', normalizedStopPrice);
      params.append('timeInForce', 'GTC');

      // Use detected position mode if provided
      const isOneWayMode = actualPositionSide === 'BOTH';
      const useHedgeMode = actualPositionSide ? !isOneWayMode : hedgeMode;

      if (useHedgeMode && actualPositionSide !== 'BOTH') {
        const positionSide = actualPositionSide || (side === 'BUY' ? 'LONG' : 'SHORT');
        params.append('positionSide', positionSide);

        this.logger.log(
          `[TP CREATE] Hedge Mode LIMIT Order\n` +
          `  Symbol: ${symbol}\n` +
          `  Entry Side: ${side} → Close Side: ${closeSide}\n` +
          `  Position Side: ${positionSide}\n` +
          `  Price: ${normalizedStopPrice}\n` +
          `  Quantity: ${normalizedQty} (raw: ${tpQuantity})\n` +
          `  Rules: step=${rules.qtyStep}, min=${rules.minQty}, tick=${rules.priceTick}`
        );
      } else {
        params.append('reduceOnly', 'true');

        this.logger.log(
          `[TP CREATE] One-Way Mode LIMIT Order\n` +
          `  Symbol: ${symbol}\n` +
          `  Entry Side: ${side} → Close Side: ${closeSide}\n` +
          `  Price: ${normalizedStopPrice}\n` +
          `  Quantity: ${normalizedQty} (raw: ${tpQuantity})\n` +
          `  Using reduceOnly=true`
        );
      }

      this.logger.debug(`[TP CREATE] Full request params: ${params.toString()}`);

      try {
        const response = await this.createBinanceOrder(params, apiKey, apiSecret, isTestnet);
        this.logger.log(`[TP CREATE] SUCCESS - Order ID: ${response.orderId}, Status: ${response.status}`);
        return response.orderId.toString();
      } catch (firstError: any) {
        const errorCode = firstError.response?.data?.code;

        // If error -4061 (position side mismatch) and we used positionSide, retry with reduceOnly
        if (errorCode === -4061 && useHedgeMode && actualPositionSide !== 'BOTH') {
          const attemptedPositionSide = params.get('positionSide');
          this.logger.warn(
            `[TP CREATE] Error -4061 detected - Retrying with One-Way Mode (reduceOnly) instead of positionSide=${attemptedPositionSide}`
          );

          // Remove positionSide and add reduceOnly
          params.delete('positionSide');
          params.set('reduceOnly', 'true');

          const retryResponse = await this.createBinanceOrder(params, apiKey, apiSecret, isTestnet);
          this.logger.log(`[TP CREATE] SUCCESS (One-Way Mode fallback) - Order ID: ${retryResponse.orderId}`);
          return retryResponse.orderId.toString();
        }

        throw firstError;
      }
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
    hedgeMode: boolean = false,
    expectedMinQty?: number
  ): Promise<{ entryPrice: number; actualPositionSide: string; quantity: number }> {
    const baseURL = isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;
    const endpoint = '/fapi/v2/positionRisk';
    const positionSide = hedgeMode ? (side === 'BUY' ? 'LONG' : 'SHORT') : 'BOTH';

    const maxRetries = 5;
    const initialDelay = 500;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const params = new URLSearchParams();
        params.append('symbol', symbol);
        params.append('timestamp', Date.now().toString());

        const queryString = params.toString();
        const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

        this.logger.debug(
          `[POSITION VERIFY] Attempt ${attempt}/${maxRetries} - Checking ${symbol} ${positionSide}` +
          (expectedMinQty ? ` (expecting >= ${expectedMinQty})` : '')
        );

        const response = await BinanceRequestUtil.get(
          `${baseURL}${endpoint}?${queryString}&signature=${signature}`,
          { headers: { 'X-MBX-APIKEY': apiKey } }
        );

        const positions = response.data;

        // Log all positions for debugging
        this.logger.debug(
          `[POSITION VERIFY] Received ${positions.length} positions from Binance`
        );
        positions.forEach((pos: any) => {
          if (parseFloat(pos.positionAmt) !== 0) {
            this.logger.debug(
              `[POSITION VERIFY] Position: ${pos.symbol} ${pos.positionSide} Qty=${pos.positionAmt} Entry=${pos.entryPrice}`
            );
          }
        });

        // Try to find position with expected positionSide first
        let targetPosition = positions.find((pos: any) =>
          pos.symbol === symbol && pos.positionSide === positionSide
        );

        // If not found and in Hedge Mode, try BOTH (One-Way Mode fallback)
        if (!targetPosition && positionSide !== 'BOTH') {
          this.logger.debug(
            `[POSITION VERIFY] Position not found with ${positionSide}, trying BOTH (One-Way Mode)`
          );
          targetPosition = positions.find((pos: any) =>
            pos.symbol === symbol && pos.positionSide === 'BOTH'
          );
        }

        if (!targetPosition) {
          this.logger.warn(
            `[POSITION VERIFY] Position not found - Looking for: symbol="${symbol}" positionSide="${positionSide}" or "BOTH"`
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
        const rawPositionAmt = parseFloat(targetPosition.positionAmt);

        // For One-Way Mode (BOTH), validate position direction
        if (targetPosition.positionSide === 'BOTH') {
          const expectedDirection = side === 'BUY' ? 'positive' : 'negative';
          const actualDirection = rawPositionAmt > 0 ? 'positive' : 'negative';

          if (expectedDirection !== actualDirection) {
            this.logger.warn(
              `[POSITION VERIFY] One-Way Mode position direction mismatch - ` +
              `Expected ${side} (${expectedDirection}), got ${actualDirection} (${rawPositionAmt})`
            );
          } else {
            this.logger.log(
              `[POSITION VERIFY] One-Way Mode detected - Position: ${symbol} BOTH, Qty=${rawPositionAmt} (${side})`
            );
          }
        }

        const isInsufficient = positionAmt === 0 || (expectedMinQty !== undefined && positionAmt < expectedMinQty * 0.9);

        if (isInsufficient) {
          this.logger.warn(
            `[POSITION VERIFY] Position quantity insufficient - Symbol: ${symbol}, ` +
            `Current: ${positionAmt}` + (expectedMinQty ? `, Expected: >= ${expectedMinQty}` : '')
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
          `  Position Side: ${targetPosition.positionSide} (searched for: ${positionSide})\n` +
          `  Quantity: ${positionAmt}\n` +
          `  Entry Price: ${targetPosition.entryPrice}\n` +
          `  Attempt: ${attempt}/${maxRetries}`
        );

        return {
          entryPrice: parseFloat(targetPosition.entryPrice),
          actualPositionSide: targetPosition.positionSide, // Return actual positionSide (BOTH, LONG, or SHORT)
          quantity: positionAmt
        };
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

    throw new PositionNotFoundError(symbol, positionSide);
  }

  private scheduleProtectionOrders(
    tradeId: string,
    symbol: string,
    side: 'BUY' | 'SELL',
    strategy: any,
    decryptedKey: string,
    decryptedSecret: string,
  ): void {
    const run = async () => {
      const delayMs = 10000;
      const protectionBudgetMs = 300000;
      const baseURL = strategy.isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;

      const maxAttempts = 360;
      let sawFill = false;
      let protectionDeadline = 0;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (sawFill && Date.now() > protectionDeadline) break;
        await new Promise(r => setTimeout(r, delayMs));

        try {
          const trade = await this.tradesService.findById(tradeId);
          if (!trade || trade.status !== 'OPEN') return;

          // Check if protection orders already exist (both SL and TP)
          const hasStopLoss = !!trade.stopLossOrderId;
          const hasTakeProfit = !!trade.takeProfitOrderId;

          // If both are already set, no need to continue
          if (hasStopLoss && hasTakeProfit) {
            this.logger.debug(`[LIMIT SL/TP] Protection orders already exist for trade ${tradeId}`);
            return;
          }

          if (!trade.exchangeOrderId) {
            this.logger.debug(`[LIMIT SL/TP] Attempt ${attempt + 1}/${maxAttempts}: no entry order ID yet`);
            continue;
          }

          const orderParams = new URLSearchParams();
          orderParams.append('symbol', symbol);
          orderParams.append('orderId', trade.exchangeOrderId);
          orderParams.append('timestamp', Date.now().toString());
          const orderSig = crypto.createHmac('sha256', decryptedSecret).update(orderParams.toString()).digest('hex');

          const orderResp = await BinanceRequestUtil.get(
            `${baseURL}/fapi/v1/order?${orderParams.toString()}&signature=${orderSig}`,
            { headers: { 'X-MBX-APIKEY': decryptedKey } }
          );

          const orderData = orderResp.data;

          if (orderData.status !== 'FILLED') {
            this.logger.debug(`[LIMIT SL/TP] Attempt ${attempt + 1}/${maxAttempts}: order ${trade.exchangeOrderId} status=${orderData.status}`);

            if (orderData.status === 'CANCELED' || orderData.status === 'EXPIRED') {
              this.logger.warn(`[LIMIT SL/TP] Entry order ${trade.exchangeOrderId} was ${orderData.status}. Stopping protection scheduling.`);
              await this.tradesService.updateTrade(tradeId, { status: 'ERROR', error: `Entry order was ${orderData.status} before filling.` });
              return;
            }
            continue;
          }

          const actualEntryPrice = parseFloat(orderData.avgPrice);
          const actualQty = parseFloat(orderData.executedQty);

          if (!actualEntryPrice || !actualQty || actualQty <= 0) {
            this.logger.warn(`[LIMIT SL/TP] Invalid fill data: avgPrice=${actualEntryPrice}, executedQty=${actualQty}`);
            continue;
          }

          this.logger.log(`[LIMIT SL/TP] Order filled: ${symbol} qty=${actualQty} avgPrice=${actualEntryPrice}`);

          if (!sawFill) {
            sawFill = true;
            protectionDeadline = Date.now() + protectionBudgetMs;
          }

          let slOrderId: string | null = trade.stopLossOrderId || null;

          // Only create SL if it doesn't already exist
          if (!hasStopLoss && strategy.stopLossPercentage && strategy.stopLossPercentage > 0) {
            const slPrice = this.calculateStopLossPrice(side, actualEntryPrice, strategy.stopLossPercentage);
            try {
              slOrderId = await this.createBinanceStopLossOrder(
                symbol, side, actualQty, slPrice, decryptedKey, decryptedSecret, strategy.isTestnet, strategy.hedgeMode
              );
              this.logger.log(`[LIMIT SL/TP] SL created: ${slOrderId}`);
            } catch (e: any) {
              this.logger.warn(`[LIMIT SL/TP] SL creation failed: ${e.message}`);
            }
          } else if (hasStopLoss) {
            this.logger.debug(`[LIMIT SL/TP] SL already exists, skipping creation`);
          }

          const rules = await this.getSymbolRules(symbol, strategy.isTestnet);
          const enabledTps = buildEnabledTpConfigs(strategy);
          const tpPlan = planTakeProfits({
            quantity: actualQty,
            tps: enabledTps.map(tp => ({
              id: tp.id,
              percent: tp.percent,
              qtyPercent: tp.qtyPercent,
              price: this.calculateTakeProfitPrice(side, actualEntryPrice, tp.percent),
            })),
            qtyStep: rules.qtyStep,
            minQty: rules.minQty,
            minNotional: Number(rules.minNotional),
          });

          if (tpPlan.discarded.length > 0) {
            this.logger.warn(
              `[LIMIT TP] ${tpPlan.discarded.length} TP(s) discarded during planning: ` +
              tpPlan.discarded.map(d => `TP${d.id}(${d.reason})`).join(', ')
            );
          }

          const tpConfigs = tpPlan.planned;

          // Start with existing TP IDs if they exist
          const tpOrderIds: string[] = hasTakeProfit && trade.takeProfitOrderId
            ? trade.takeProfitOrderId.split('|')
            : [];
          const failedTps: Array<{ id: number; reason: string }> = [];

          // Only create TPs if they don't already exist
          if (!hasTakeProfit && tpConfigs.length > 0) {
            for (const tp of tpConfigs) {
              const tpPrice = this.calculateTakeProfitPrice(side, actualEntryPrice, tp.percent);
              const tpQty = Number(tp.quantity);
              if (tpQty <= 0) continue;
              try {
                const tpId = await withOneRetry(() => this.createBinanceTakeProfitOrder(
                  symbol, side, tpQty, tpPrice, decryptedKey, decryptedSecret, strategy.isTestnet, strategy.hedgeMode
                ), (ms) => this.sleep(ms));
                tpOrderIds.push(`${tp.id}:${tpId}`);
                this.logger.log(`[LIMIT TP${tp.id}] Created: ${tpId}`);
              } catch (e: any) {
                this.logger.error(`[LIMIT TP${tp.id}] Failed after retry: ${e.message}`);
                failedTps.push({ id: tp.id, reason: e.message });
              }
            }
          } else if (hasTakeProfit) {
            this.logger.debug(`[LIMIT SL/TP] TPs already exist, skipping creation`);
          }

          const tpWarnings = buildTpWarnings(tpPlan.discarded, failedTps);

          await this.tradesService.updateTrade(tradeId, {
            entryPrice: actualEntryPrice as any,
            quantity: actualQty as any,
            stopLossOrderId: slOrderId || undefined,
            takeProfitOrderId: tpOrderIds.length > 0 ? tpOrderIds.join('|') : undefined,
            tpWarnings,
          });

          this.logger.log(`[LIMIT SL/TP] All protection orders created for trade ${tradeId}`);
          return;
        } catch (err: any) {
          this.logger.warn(`[LIMIT SL/TP] Attempt ${attempt + 1} error: ${err.message}`);
        }
      }

      this.logger.error(
        `[BINANCE LIMIT SL/TP] TIMEOUT: Could not create protection for trade ${tradeId} after ${maxAttempts * delayMs / 1000}s\n` +
        `Checking if position is open and needs emergency closure...`
      );

      try {
        const trade = await this.tradesService.findById(tradeId);
        if (!trade || trade.status !== 'OPEN') {
          this.logger.log(`[BINANCE LIMIT SL/TP] Trade ${tradeId} is no longer open, no action needed`);
          return;
        }

        if (trade.stopLossOrderId || trade.takeProfitOrderId) {
          this.logger.log(`[BINANCE LIMIT SL/TP] Trade ${tradeId} has some protection, keeping position open`);
          return;
        }

        const timestamp = Date.now();
        const positionParams = new URLSearchParams();
        positionParams.append('symbol', symbol);
        positionParams.append('timestamp', timestamp.toString());
        const positionSig = crypto.createHmac('sha256', decryptedSecret).update(positionParams.toString()).digest('hex');

        const positionResp = await BinanceRequestUtil.get(
          `${baseURL}/fapi/v2/positionRisk?${positionParams.toString()}&signature=${positionSig}`,
          { headers: { 'X-MBX-APIKEY': decryptedKey } }
        );

        const positionSide = strategy.hedgeMode ? (side === 'BUY' ? 'LONG' : 'SHORT') : 'BOTH';
        const position = positionResp.data.find((p: any) =>
          p.symbol === symbol &&
          p.positionSide === positionSide &&
          Math.abs(parseFloat(p.positionAmt)) > 0
        );

        if (position && Math.abs(parseFloat(position.positionAmt)) > 0) {
          this.logger.error(
            `[BINANCE LIMIT EMERGENCY] Position is OPEN without protection!\n` +
            `  Trade ID: ${tradeId}\n` +
            `  Symbol: ${symbol}\n` +
            `  Size: ${position.positionAmt}\n` +
            `  Action: Closing position immediately to prevent unprotected exposure`
          );

          const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
          const closeQty = Math.abs(parseFloat(position.positionAmt));
          const closeParams = new URLSearchParams();
          closeParams.append('symbol', symbol);
          closeParams.append('side', closeSide);
          closeParams.append('type', 'MARKET');
          closeParams.append('quantity', closeQty.toString());

          if (strategy.hedgeMode) {
            closeParams.append('positionSide', positionSide);
          }

          closeParams.append('timestamp', Date.now().toString());
          const closeSig = crypto.createHmac('sha256', decryptedSecret).update(closeParams.toString()).digest('hex');

          await BinanceRequestUtil.post(
            `${baseURL}/fapi/v1/order`,
            `${closeParams.toString()}&signature=${closeSig}`,
            {
              headers: {
                'X-MBX-APIKEY': decryptedKey,
                'Content-Type': 'application/x-www-form-urlencoded'
              }
            }
          );

          await this.tradesService.updateTrade(tradeId, {
            status: 'ERROR',
            error: 'LIMIT order filled but protection orders failed to create within timeout. Position closed automatically for safety.',
            stopLossOrderId: 'EMERGENCY_CLOSE',
            takeProfitOrderId: 'EMERGENCY_CLOSE'
          });

          this.logger.log(`[BINANCE LIMIT EMERGENCY] Position closed successfully`);
        } else {
          this.logger.log(`[BUFFER] Ordem ainda pendente após 60min — acompanhamento transferido para o position-sync`);
        }
      } catch (emergencyError: any) {
        this.logger.error(`[BINANCE LIMIT EMERGENCY] Failed to handle unprotected position: ${emergencyError.message}`);
      }
    };

    run().catch(err => this.logger.error(`[LIMIT SL/TP] Critical background error: ${err.message}`));
  }

  private scheduleBybitProtectionOrders(
    tradeId: string,
    symbol: string,
    side: 'BUY' | 'SELL',
    strategy: any,
    decryptedKey: string,
    decryptedSecret: string,
    orderQuantity: number,
  ): void {
    const run = async () => {
      const delayMs = 10000;
      const protectionBudgetMs = 300000;

      const maxAttempts = 360;
      let sawFill = false;
      let protectionDeadline = 0;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (sawFill && Date.now() > protectionDeadline) break;
        await new Promise(r => setTimeout(r, delayMs));

        try {
          const trade = await this.tradesService.findById(tradeId);
          if (!trade || trade.status !== 'OPEN') return;

          // Check if protection orders already exist (both SL and TP)
          const hasStopLoss = !!trade.stopLossOrderId;
          const hasTakeProfit = !!trade.takeProfitOrderId;

          // If both are already set, no need to continue
          if (hasStopLoss && hasTakeProfit) {
            this.logger.debug(`[BYBIT LIMIT SL/TP] Protection orders already exist for trade ${tradeId}`);
            return;
          }

          if (!trade.exchangeOrderId) {
            this.logger.debug(`[BYBIT LIMIT SL/TP] Attempt ${attempt + 1}/${maxAttempts}: no entry order ID yet`);
            continue;
          }

          let orderData = await this.bybitClient.getOrderInfo(
            decryptedKey, decryptedSecret, strategy.isTestnet, symbol, trade.exchangeOrderId
          );

          if (!orderData) {
            orderData = await this.bybitClient.getOrderHistory(
              decryptedKey, decryptedSecret, strategy.isTestnet, symbol, trade.exchangeOrderId
            );
          }

          if (!orderData) {
            this.logger.debug(`[BYBIT LIMIT SL/TP] Attempt ${attempt + 1}/${maxAttempts}: order ${trade.exchangeOrderId} not found`);
            continue;
          }

          if (orderData.orderStatus !== 'Filled') {
            this.logger.debug(`[BYBIT LIMIT SL/TP] Attempt ${attempt + 1}/${maxAttempts}: order ${trade.exchangeOrderId} status=${orderData.orderStatus}`);

            if (orderData.orderStatus === 'Cancelled' || orderData.orderStatus === 'Rejected') {
              this.logger.warn(`[BYBIT LIMIT SL/TP] Entry order ${trade.exchangeOrderId} was ${orderData.orderStatus}. Stopping protection scheduling.`);
              await this.tradesService.updateTrade(tradeId, { status: 'ERROR', error: `Entry order was ${orderData.orderStatus} before filling.` });
              return;
            }
            continue;
          }

          const actualEntryPrice = parseFloat(orderData.avgPrice);
          const actualQty = parseFloat(orderData.cumExecQty);

          if (!actualEntryPrice || !actualQty || actualQty <= 0) {
            this.logger.warn(`[BYBIT LIMIT SL/TP] Invalid fill data: avgPrice=${actualEntryPrice}, executedQty=${actualQty}`);
            continue;
          }

          this.logger.log(`[BYBIT LIMIT SL/TP] Order filled: ${symbol} qty=${actualQty} avgPrice=${actualEntryPrice}`);

          if (!sawFill) {
            sawFill = true;
            protectionDeadline = Date.now() + protectionBudgetMs;
          }

          const bybitSide = side === 'BUY' ? 'Buy' : 'Sell';
          const positionConfirmed = await this.bybitClient.waitForPosition(
            decryptedKey, decryptedSecret, strategy.isTestnet, symbol, bybitSide, 10, 500, strategy.hedgeMode
          );

          if (!positionConfirmed) {
            this.logger.warn(`[BYBIT LIMIT SL/TP] Position not confirmed after order fill. Retrying...`);
            continue;
          }

          let slOrderId: string | null = trade.stopLossOrderId || null;

          // Only create SL if it doesn't already exist
          if (!hasStopLoss && strategy.stopLossPercentage && strategy.stopLossPercentage > 0) {
            const slPrice = this.calculateStopLossPrice(side, actualEntryPrice, strategy.stopLossPercentage);
            const rules = await this.getSymbolRules(symbol, strategy.isTestnet, Exchange.BYBIT);
            const slPriceRounded = roundPriceToTick(slPrice, rules.priceTick);

            try {
              const slOrder = await this.bybitClient.createStopLossOrder(
                decryptedKey, decryptedSecret, strategy.isTestnet,
                symbol, bybitSide, normalizeQuantity(actualQty, rules.qtyStep, rules.minQty),
                slPriceRounded, strategy.hedgeMode
              );
              slOrderId = slOrder.orderId;
              this.logger.log(`[BYBIT LIMIT SL/TP] SL order created: ${slOrderId} at ${slPriceRounded}`);
            } catch (e: any) {
              this.logger.warn(`[BYBIT LIMIT SL/TP] SL creation failed: ${e.message}`);
            }
          } else if (hasStopLoss) {
            this.logger.debug(`[BYBIT LIMIT SL/TP] SL already exists, skipping creation`);
          }

          const rules = await this.getSymbolRules(symbol, strategy.isTestnet, Exchange.BYBIT);

          const enabledTps = buildEnabledTpConfigs(strategy);
          const tpPlan = planTakeProfits({
            quantity: actualQty,
            tps: enabledTps.map(tp => ({
              id: tp.id,
              percent: tp.percent,
              qtyPercent: tp.qtyPercent,
              price: this.calculateTakeProfitPrice(side, actualEntryPrice, tp.percent),
            })),
            qtyStep: rules.qtyStep,
            minQty: rules.minQty,
            minNotional: Number(rules.minNotional),
          });

          if (tpPlan.discarded.length > 0) {
            this.logger.warn(
              `[BYBIT LIMIT TP] ${tpPlan.discarded.length} TP(s) discarded during planning: ` +
              tpPlan.discarded.map(d => `TP${d.id}(${d.reason})`).join(', ')
            );
          }

          const tpConfigs = tpPlan.planned;
          // Start with existing TP IDs if they exist
          const tpOrderIds: string[] = hasTakeProfit && trade.takeProfitOrderId
            ? trade.takeProfitOrderId.split('|')
            : [];

          const failedTps: Array<{ id: number; reason: string }> = [];

          // Only create TPs if they don't already exist
          if (!hasTakeProfit && tpConfigs.length > 0) {
            const bybitPositionIdx = await this.bybitClient.getPositionIdx(
              decryptedKey, decryptedSecret, strategy.isTestnet, symbol, bybitSide, strategy.hedgeMode
            );

            for (const tp of tpConfigs) {
            const tpPrice = this.calculateTakeProfitPrice(side, actualEntryPrice, tp.percent);
            const tpQty = Number(tp.quantity);

            if (tpQty <= 0) continue;

            try {
              const tpOrder = await withOneRetry(() => this.bybitClient.createOrder(
                decryptedKey, decryptedSecret, strategy.isTestnet,
                {
                  symbol,
                  side: side === 'BUY' ? 'Sell' : 'Buy',
                  orderType: 'Limit',
                  qty: tp.quantity,
                  price: roundPriceToTick(tpPrice, rules.priceTick),
                  positionIdx: bybitPositionIdx,
                  reduceOnly: true,
                  hedgeMode: strategy.hedgeMode
                }
              ), (ms) => this.sleep(ms));
              tpOrderIds.push(`${tp.id}:${tpOrder.orderId}`);
              this.logger.log(`[BYBIT LIMIT TP${tp.id}] Created: ${tpOrder.orderId}`);
            } catch (e: any) {
              this.logger.error(`[BYBIT LIMIT TP${tp.id}] Failed after retry: ${e.message}`);
              failedTps.push({ id: tp.id, reason: e.message });
            }
          }
          } else if (hasTakeProfit) {
            this.logger.debug(`[BYBIT LIMIT SL/TP] TPs already exist, skipping creation`);
          }

          const actualSlPrice = slOrderId && strategy.stopLossPercentage
            ? parseFloat(roundPriceToTick(
                this.calculateStopLossPrice(side, actualEntryPrice, strategy.stopLossPercentage),
                rules.priceTick
              ))
            : undefined;

          await this.tradesService.updateTrade(tradeId, {
            entryPrice: actualEntryPrice as any,
            quantity: actualQty as any,
            stopLossOrderId: slOrderId || undefined,
            takeProfitOrderId: tpOrderIds.length > 0 ? tpOrderIds.join('|') : undefined,
            currentStopLoss: actualSlPrice as any,
            tpWarnings: buildTpWarnings(tpPlan.discarded, failedTps),
          });

          this.logger.log(`[BYBIT LIMIT SL/TP] All protection orders created for trade ${tradeId}`);
          return;
        } catch (err: any) {
          this.logger.warn(`[BYBIT LIMIT SL/TP] Attempt ${attempt + 1} error: ${err.message}`);
        }
      }

      this.logger.error(
        `[BYBIT LIMIT SL/TP] TIMEOUT: Could not create protection for trade ${tradeId} after ${maxAttempts * delayMs / 1000}s\n` +
        `Checking if position is open and needs emergency closure...`
      );

      try {
        const trade = await this.tradesService.findById(tradeId);
        if (!trade || trade.status !== 'OPEN') {
          this.logger.log(`[BYBIT LIMIT SL/TP] Trade ${tradeId} is no longer open, no action needed`);
          return;
        }

        if (trade.stopLossOrderId || trade.takeProfitOrderId) {
          this.logger.log(`[BYBIT LIMIT SL/TP] Trade ${tradeId} has some protection, keeping position open`);
          return;
        }

        const positions = await this.bybitClient.getPositions(decryptedKey, decryptedSecret, strategy.isTestnet, symbol);
        const bybitSide = side === 'BUY' ? 'Buy' : 'Sell';
        const position = positions.find(p => p.symbol === symbol && p.side === bybitSide);

        if (position && parseFloat(position.size) > 0) {
          this.logger.error(
            `[BYBIT LIMIT EMERGENCY] Position is OPEN without protection!\n` +
            `  Trade ID: ${tradeId}\n` +
            `  Symbol: ${symbol}\n` +
            `  Size: ${position.size}\n` +
            `  Action: Closing position immediately to prevent unprotected exposure`
          );

          const closeSide = side === 'BUY' ? 'Sell' : 'Buy';
          await this.bybitClient.createOrder(
            decryptedKey,
            decryptedSecret,
            strategy.isTestnet,
            {
              symbol,
              side: closeSide,
              orderType: 'Market',
              qty: position.size,
              positionIdx: await this.bybitClient.getPositionIdx(decryptedKey, decryptedSecret, strategy.isTestnet, symbol, bybitSide, strategy.hedgeMode),
              reduceOnly: true,
              hedgeMode: strategy.hedgeMode
            }
          );

          await this.tradesService.updateTrade(tradeId, {
            status: 'ERROR',
            error: 'LIMIT order filled but protection orders failed to create within timeout. Position closed automatically for safety.',
            stopLossOrderId: 'EMERGENCY_CLOSE',
            takeProfitOrderId: 'EMERGENCY_CLOSE'
          });

          this.logger.log(`[BYBIT LIMIT EMERGENCY] Position closed successfully`);
        } else {
          this.logger.log(`[BUFFER] Ordem ainda pendente após 60min — acompanhamento transferido para o position-sync`);
        }
      } catch (emergencyError: any) {
        this.logger.error(`[BYBIT LIMIT EMERGENCY] Failed to handle unprotected position: ${emergencyError.message}`);
      }
    };

    run().catch(err => this.logger.error(`[BYBIT LIMIT SL/TP] Critical background error: ${err.message}`));
  }

  @OnEvent('limit.protection.resume')
  async handleResumeProtection(payload: { tradeId: string }): Promise<void> {
    await this.resumeLimitProtection(payload?.tradeId);
  }

  @OnEvent('signal.mark')
  handleSignalMark(payload: { tradeId: string; decision: SignalDecision; reason?: string | null }): void {
    if (!payload?.tradeId) return;
    this.signalLog.markByTrade(payload.tradeId, payload.decision, payload.reason ?? null);
  }

  async resumeLimitProtection(tradeId: string): Promise<void> {
    if (!tradeId || this.resumingProtection.has(tradeId)) return;

    const trade = await this.tradesService.findById(tradeId);
    if (!trade || trade.status !== 'OPEN' || trade.type !== 'LIMIT' || !trade.exchangeOrderId) return;

    const strategy = await this.strategiesService.findOne(trade.strategyId);
    if (!strategy) return;
    const credentials = await this.credentialsResolver.resolveCredentials(strategy);
    const resolvedStrategy = { ...strategy, ...credentials };
    if (!resolvedStrategy.apiKey || !resolvedStrategy.apiSecret) return;

    const decryptedKey = (await EncryptionUtil.decrypt(resolvedStrategy.apiKey)).trim();
    const decryptedSecret = (await EncryptionUtil.decrypt(resolvedStrategy.apiSecret)).trim();

    let needsStopLoss = !trade.stopLossOrderId;
    let needsTakeProfit = !trade.takeProfitOrderId;

    if (!needsTakeProfit && resolvedStrategy.exchange === Exchange.BYBIT) {
      const tracked = parseTrackedTpOrders(trade.takeProfitOrderId);
      if (tracked.length > 0) {
        try {
          const openOrders = await this.bybitClient.getOpenOrders(decryptedKey, decryptedSecret, resolvedStrategy.isTestnet, trade.symbol);
          const liveOrderIds = new Set(openOrders.map(o => o.orderId));
          if (countLiveTrackedOrders(tracked, liveOrderIds) === 0) {
            this.logger.warn(
              `[RESUME PROTECTION] Trade ${tradeId} tem takeProfitOrderId registrado mas nenhuma ordem viva na Bybit — tratando como TP ausente`
            );
            needsTakeProfit = true;
          }
        } catch (err: any) {
          this.logger.warn(`[RESUME PROTECTION] Falha ao validar TPs na corretora para trade ${tradeId}: ${err.message}`);
        }
      }
    }

    if (!needsStopLoss && !needsTakeProfit) return;

    this.logger.log(
      `[RESUME PROTECTION] Trade ${tradeId} precisa de ${needsStopLoss && needsTakeProfit ? 'SL e TP' : needsStopLoss ? 'SL' : 'TP'}`
    );

    this.resumingProtection.add(tradeId);
    try {
      if (needsTakeProfit && trade.takeProfitOrderId) {
        await this.tradesService.updateTrade(tradeId, { takeProfitOrderId: null as any });
      }

      if (resolvedStrategy.exchange === Exchange.BINANCE) {
        this.scheduleProtectionOrders(trade.id, trade.symbol, trade.side, resolvedStrategy, decryptedKey, decryptedSecret);
      } else if (resolvedStrategy.exchange === Exchange.BYBIT) {
        this.scheduleBybitProtectionOrders(trade.id, trade.symbol, trade.side, resolvedStrategy, decryptedKey, decryptedSecret, Number(trade.quantity));
      }
      this.logger.log(`[RESUME PROTECTION] Re-scheduled protection for trade ${tradeId}`);
    } catch (err: any) {
      this.logger.warn(`[RESUME PROTECTION] Failed for trade ${tradeId}: ${err.message}`);
    } finally {
      setTimeout(() => this.resumingProtection.delete(tradeId), 5 * 60 * 1000).unref();
    }
  }

  @Cron('*/30 * * * * *')
  private async scanUnprotectedLimitTrades(): Promise<void> {
    const openTrades = await this.tradesService.findOpenTrades();
    const now = Date.now();

    for (const trade of openTrades) {
      if (trade.type !== 'LIMIT' || !trade.exchangeOrderId) continue;

      const missingStopLoss = !trade.stopLossOrderId;
      const missingTakeProfit = !trade.takeProfitOrderId;
      if (!missingStopLoss && !missingTakeProfit) continue;

      const ageMs = now - new Date(trade.timestamp).getTime();
      if (ageMs < 30000) continue;

      if (ageMs > 2 * 60 * 1000) {
        this.logger.error(
          `[PROTECTION ALERT] Trade ${trade.id} (${trade.symbol}) OPEN ha ${(ageMs / 1000).toFixed(0)}s sem ` +
          `${missingStopLoss && missingTakeProfit ? 'SL e TP' : missingStopLoss ? 'SL' : 'TP'}`
        );
      }

      await this.resumeLimitProtection(trade.id);
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

      const response = await BinanceRequestUtil.get(
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
    hedgeMode: boolean = false,
    entryQuantity?: number
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
        `  Entry Quantity: ${entryQuantity ?? 'entire position'}\n` +
        `  Reason: Failed to create SL/TP protection orders\n` +
        `  Action: Closing position with MARKET order`
      );

      const params = new URLSearchParams();
      params.append('symbol', symbol);
      params.append('side', closeSide);
      params.append('type', 'MARKET');

      if (entryQuantity && entryQuantity > 0) {
        const rules = await this.getSymbolRules(symbol, isTestnet);
        params.append('quantity', normalizeQuantity(entryQuantity, rules.qtyStep, rules.minQty));
        if (hedgeMode) {
          params.append('positionSide', positionSide);
        } else {
          params.append('reduceOnly', 'true');
        }
      } else {
        params.append('quantity', '0');
        params.append('closePosition', 'true');
        if (hedgeMode) {
          params.append('positionSide', positionSide);
        }
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
      const response = await BinanceRequestUtil.get(`${baseURL}/fapi/v1/ticker/price?symbol=${symbol}`);
      return parseFloat(response.data.price);
    } catch (error) {
      this.logger.error(`Failed to get current price for ${symbol}: ${error.message}`);
      return 0;
    }
  }

  @Cron('*/60 * * * * *')
  private cleanupStaleSignals() {
    const now = Date.now();
    const staleSignals: string[] = [];

    for (const [signalKey, timestamp] of this.activeSignalsTimestamps.entries()) {
      const age = now - timestamp;
      if (age > this.SIGNAL_TIMEOUT_MS) {
        staleSignals.push(signalKey);
      }
    }

    if (staleSignals.length > 0) {
      this.logger.warn(
        `[MUTEX CLEANUP] Found ${staleSignals.length} stale signals (>${this.SIGNAL_TIMEOUT_MS/1000}s), cleaning up...`
      );

      for (const signalKey of staleSignals) {
        this.activeSignals.delete(signalKey);
        this.activeSignalsTimestamps.delete(signalKey);
        this.logger.warn(`[MUTEX CLEANUP] Removed stale signal: ${signalKey}`);
      }
    }
  }

  async processSignal(signal: TradingviewSignalDto) {
    this.logger.log(`Processing signal: ${signal.action} ${signal.symbol} for Strategy ${signal.strategyId}`);

    if (!signal.strategyId) {
      throw new Error('Strategy ID is missing in signal');
    }

    const signalKey = `${signal.strategyId}:${signal.symbol}:${signal.action}`;
    const requestId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;

    this.logger.log(`[WEBHOOK] Request ID: ${requestId} | Signal Key: ${signalKey}`);

    if (this.activeSignals.has(signalKey)) {
      this.logger.warn(`[MUTEX] Request ${requestId} | Signal ${signalKey} already in progress, ignoring duplicate (TradingView retry or concurrent request)`);
      return { status: 'skipped', message: 'Signal already being processed' };
    }
    this.activeSignals.add(signalKey);
    this.activeSignalsTimestamps.set(signalKey, Date.now());
    this.logger.log(`[MUTEX] Request ${requestId} | Acquired lock for ${signalKey}`);

    const signalLogId = this.signalLog.record(signal as unknown as Record<string, unknown>);

    try {
      const result = await this._processSignalInternal(signal);
      this.signalLog.decideFromResult(signalLogId, result as unknown as { status?: string; message?: string; trade?: { id?: string } });
      this.logger.log(`[MUTEX] Request ${requestId} | Releasing lock for ${signalKey}`);
      return result;
    } catch (error) {
      this.signalLog.decide(signalLogId, 'error', (error as Error)?.message ?? null);
      throw error;
    } finally {
      this.activeSignals.delete(signalKey);
      this.activeSignalsTimestamps.delete(signalKey);
      this.logger.log(`[MUTEX] Request ${requestId} | Lock released for ${signalKey}`);
    }
  }

  private async _processSignalInternal(signal: TradingviewSignalDto) {
    const strategy = await this.strategiesService.findOne(signal.strategyId!);
    if (!strategy) {
      throw new Error(`Strategy not found: ${signal.strategyId}`);
    }
    const credentials = await this.credentialsResolver.resolveCredentials(strategy);
    const resolvedStrategy = { ...strategy, ...credentials };

    this.logger.log(
      `[STRATEGY CONFIG] ${resolvedStrategy.name} | ` +
      `Exchange: ${resolvedStrategy.exchange || 'BINANCE'} | ` +
      `Testnet: ${resolvedStrategy.isTestnet} | ` +
      `RealAccount: ${resolvedStrategy.isRealAccount} | ` +
      `UseAccountPercentage: ${resolvedStrategy.useAccountPercentage} | ` +
      `AccountPercentage: ${resolvedStrategy.accountPercentage}% | ` +
      `DefaultQuantity: ${resolvedStrategy.defaultQuantity} | ` +
      `Leverage: ${resolvedStrategy.leverage}x | ` +
      `EnableCompound: ${resolvedStrategy.enableCompound} | ` +
      `TradingMode: ${resolvedStrategy.tradingMode}`
    );

    if (!resolvedStrategy.isActive) {
      this.logger.warn(`Strategy ${resolvedStrategy.name} is paused. Ignoring signal.`);
      return { status: 'skipped', message: 'Strategy is paused' };
    }

    if (resolvedStrategy.pauseNewOrders) {
      this.logger.warn(`Strategy ${resolvedStrategy.name} has new orders paused. Ignoring signal.`);
      return { status: 'skipped', message: 'New orders paused for this strategy' };
    }

    if (resolvedStrategy.tradingMode === TradingMode.SINGLE) {
      const closedTradesCount = await this.tradesService.countClosedTrades(resolvedStrategy.id);
      if (closedTradesCount > 0) {
        this.logger.warn(`[SINGLE MODE] Strategy ${resolvedStrategy.name} already completed a trade cycle. Ignoring new signals.`);
        return { status: 'skipped', message: 'Single mode: Trade cycle completed. Reset to continue trading.' };
      }
    }

    const exchange = resolvedStrategy.exchange || Exchange.BINANCE;
    const normalizedSymbol = this.normalizeSymbol(signal.symbol, exchange);
    const side = signal.action.toUpperCase() as 'BUY' | 'SELL';

    // --- POSITION MANAGEMENT ---
    const openTrades = await this.tradesService.findOpenTrades();
    const activeTradesForSymbol = openTrades.filter(t => t.symbol === normalizedSymbol && t.strategyId === resolvedStrategy.id);
    const activeTrade = activeTradesForSymbol.find(t => t.side === side);
    const oppositeActiveTrade = activeTradesForSymbol.find(t => t.side !== side);

    // Check for pending LIMIT orders in opposite direction that haven't been filled yet
    const oppositePendingOrder = openTrades.find(t =>
      t.symbol === normalizedSymbol &&
      t.strategyId === resolvedStrategy.id &&
      t.side !== side &&
      t.type === 'LIMIT' &&
      t.status === 'OPEN' &&
      !t.binancePositionAmt  // Order not yet filled
    );

    if (activeTrade) {
        if (resolvedStrategy.allowAveraging) {
            this.logger.log(`[AVERAGING] Adding to existing ${side} position for ${normalizedSymbol}.`);
        } else {
            this.logger.warn(`[POSITION] Ignoring duplicate ${side} signal for ${normalizedSymbol}. Position already open and averaging disabled.`);
            return { status: 'skipped', message: 'Position already open (averaging disabled)' };
        }
    }

    // Cancel pending BUFFER LIMIT order only (not all orders)
    if (oppositePendingOrder && !oppositeActiveTrade) {
        this.logger.log(`[BUFFER CANCEL] Detected pending ${oppositePendingOrder.side} LIMIT order. Cancelling it due to opposite signal.`);
        try {
            const decryptedKey = (await EncryptionUtil.decrypt(resolvedStrategy.apiKey)).trim();
            const decryptedSecret = (await EncryptionUtil.decrypt(resolvedStrategy.apiSecret)).trim();

            // Cancel only this specific LIMIT order from the buffer
            if (oppositePendingOrder.exchangeOrderId) {
                if (exchange === Exchange.BYBIT) {
                    await this.bybitClient.cancelOrder(decryptedKey, decryptedSecret, resolvedStrategy.isTestnet, normalizedSymbol, oppositePendingOrder.exchangeOrderId);
                } else {
                    await this.cancelBinanceOrderOrAlgo(normalizedSymbol, oppositePendingOrder.exchangeOrderId, decryptedKey, decryptedSecret, resolvedStrategy.isTestnet);
                }
                this.logger.log(`[BUFFER CANCEL] Cancelled buffer order ${oppositePendingOrder.exchangeOrderId}`);
            }

            // Mark as cancelled in database
            await this.tradesService.updateTrade(oppositePendingOrder.id, {
                status: 'ERROR',
                error: 'Cancelled by opposite signal',
                closeReason: 'SIGNAL'
            });
            this.logger.log(`[BUFFER CANCEL] Pending LIMIT order marked as cancelled. Proceeding with new ${side} signal.`);
        } catch (cancelError) {
            this.logger.warn(`[BUFFER CANCEL] Failed to cancel order: ${cancelError.message}. Continuing anyway.`);
        }
    }

    if (oppositeActiveTrade && !resolvedStrategy.hedgeMode) {
            this.logger.log(`[ONE-WAY] Detected opposite ${oppositeActiveTrade.side} position. Closing it before opening new ${side} position.`);

            // Close existing position logic (Generic close via Market)
            try {
                const decryptedKey = (await EncryptionUtil.decrypt(resolvedStrategy.apiKey)).trim();
                const decryptedSecret = (await EncryptionUtil.decrypt(resolvedStrategy.apiSecret)).trim();

                // Cancel all protection orders (TP/SL) for this position
                this.logger.log(`[ONE-WAY] Cancelling all protection orders for ${normalizedSymbol}...`);
                if (exchange === Exchange.BYBIT) {
                    await this.bybitClient.cancelAllOrders(decryptedKey, decryptedSecret, resolvedStrategy.isTestnet, normalizedSymbol);
                } else {
                    await this.cancelAllBinanceOrders(decryptedKey, decryptedSecret, resolvedStrategy.isTestnet, normalizedSymbol);
                }

                // Only close active position if it exists
                if (oppositeActiveTrade) {
                    let closeQty = 0;
                    try {
                         closeQty = await this.getPositionSize(oppositeActiveTrade.symbol, exchange, decryptedKey, decryptedSecret, resolvedStrategy.isTestnet);
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

                        const rules = await this.getSymbolRules(normalizedSymbol, resolvedStrategy.isTestnet);

                        if (exchange === Exchange.BYBIT) {
                            const originalSide = oppositeActiveTrade.side === 'BUY' ? 'Buy' : 'Sell';
                            const positionIdx = await this.bybitClient.getPositionIdx(
                                decryptedKey, decryptedSecret, resolvedStrategy.isTestnet, normalizedSymbol, originalSide, resolvedStrategy.hedgeMode
                            );

                            await this.bybitClient.createOrder(decryptedKey, decryptedSecret, resolvedStrategy.isTestnet, {
                                symbol: normalizedSymbol,
                                side: closeSide === 'BUY' ? 'Buy' : 'Sell',
                                orderType: 'Market',
                                qty: normalizeQuantity(closeQty, rules.qtyStep, rules.minQty),
                                positionIdx,
                                reduceOnly: true
                            });
                        } else {
                            const params = new URLSearchParams();
                            params.append('symbol', normalizedSymbol);
                            params.append('side', closeSide);
                            params.append('type', 'MARKET');
                            params.append('quantity', normalizeQuantity(closeQty, rules.qtyStep, rules.minQty));
                            params.append('reduceOnly', 'true');
                            await this.createBinanceOrder(params, decryptedKey, decryptedSecret, resolvedStrategy.isTestnet);
                        }
                        this.logger.log(`[ONE-WAY] Position closed successfully.`);
                    }

                     const exitPrice = await this.getCurrentPrice(normalizedSymbol, exchange, resolvedStrategy.isTestnet);
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

                     await this.tradesService.createExecution({
                       tradeId: oppositeActiveTrade.id,
                       type: ExecutionType.SIGNAL_CLOSE,
                       price: exitPrice,
                       quantity: quantity,
                       pnl: pnl,
                       percentOfPosition: 100,
                       exchangeOrderId: null
                     });

                     this.logger.log(`[ONE-WAY] Position closed | Qty: ${this.formatQuantityWithUsdt(quantity, exitPrice)} | P&L: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)} USDT`);
                     this.logger.log(`[ONE-WAY] Waiting 2s before new entry...`);
                     await new Promise(r => setTimeout(r, 2000));
                } 

            } catch (err) {
                 this.logger.error(`[ONE-WAY] CRITICAL: Failed to close opposite position: ${err.message}`);
                 return { status: 'error', message: `One-Way Mode: Failed to close opposite position. ${err.message}` };
            }
    }

    let isLimitOrder = signal.orderType === OrderType.LIMIT && !!signal.price;
    let effectivePrice = signal.price;

    // Buffer / Percent Offset Logic (Conservative Entry)
    if (resolvedStrategy.bufferEntry && typeof resolvedStrategy.bufferPercentage === 'number' && signal.price && signal.orderType !== OrderType.MARKET) {
      if (resolvedStrategy.bufferPercentage === 0) {
        // Buffer 0%: Entry at exact signal price using LIMIT order
        effectivePrice = signal.price;
        isLimitOrder = true;
        signal.price = effectivePrice;
        signal.orderType = OrderType.LIMIT;
        this.logger.log(`[BUFFER] Entry at exact signal price ${effectivePrice} (0% buffer - LIMIT order)`);
      } else {
        // Buffer > 0%: Apply offset
        const offset = signal.price * (resolvedStrategy.bufferPercentage / 100);
        if (side === 'BUY') {
          effectivePrice = signal.price - offset;  // BUY: entry BELOW signal price (waits for price to drop)
        } else {
          effectivePrice = signal.price + offset;  // SELL: entry ABOVE signal price (waits for price to rise)
        }
        isLimitOrder = true;
        // Update signal to reflect the forced limit order so downstream methods use the correct price
        signal.price = effectivePrice;
        signal.orderType = OrderType.LIMIT;

        this.logger.log(`[BUFFER] Entry adjusted to ${effectivePrice} (${resolvedStrategy.bufferPercentage}% buffer ${side === 'BUY' ? 'below' : 'above'} signal)`);
      }
    }

    this.logger.log(
      `[ORDER CONFIG] Exchange: ${exchange} | orderType: ${isLimitOrder ? 'LIMIT' : 'MARKET'} | ` +
      `price: ${effectivePrice || 'undefined'} | isLimitOrder: ${isLimitOrder}`
    );

    let quantity: number;
    let notional = 0;

    this.logger.log(`[QUANTITY CALC] Starting calculation - signal.quantity: ${signal.quantity}, signal.accountPercentage: ${signal.accountPercentage}, resolvedStrategy.useAccountPercentage: ${resolvedStrategy.useAccountPercentage}, resolvedStrategy.accountPercentage: ${resolvedStrategy.accountPercentage}, effectivePrice: ${effectivePrice}`);

    // Validate that price is provided when needed for percentage-based calculations
    const needsPriceForCalculation = !signal.quantity && (signal.accountPercentage || (resolvedStrategy.useAccountPercentage && resolvedStrategy.accountPercentage));
    if (needsPriceForCalculation && !effectivePrice) {
      const errorMsg = `Price is required for percentage-based quantity calculation. ` +
        `Please include "price" field in your webhook payload. ` +
        `Strategy: ${resolvedStrategy.name} | Symbol: ${normalizedSymbol} | Side: ${side}`;

      this.logger.error(`[PRICE ERROR] ${errorMsg}`);

      const tradeData: Partial<Trade> = {
        strategyId: resolvedStrategy.id,
        portfolioId: resolvedStrategy.portfolioId,
        symbol: normalizedSymbol,
        side,
        type: 'MARKET',
        status: 'ERROR',
        error: `Missing price in webhook. Add "price" field to your TradingView alert payload.`,
      };
      await this.tradesService.create(tradeData);

      return {
        status: 'error',
        message: errorMsg
      };
    }

    if (signal.quantity) {
      quantity = signal.quantity;
      notional = quantity * effectivePrice!;
      this.logger.log(`[QUANTITY CALC] Using explicit quantity from signal: ${this.formatQuantityWithUsdt(quantity, effectivePrice!)}`);
    } else if (signal.accountPercentage && effectivePrice) {
      const accountBalance = await this.getAccountBalance(resolvedStrategy);
      this.logger.log(`[QUANTITY CALC] Signal percentage mode - Balance: ${accountBalance.toFixed(2)} USDT, Percentage: ${signal.accountPercentage}%, Leverage: ${resolvedStrategy.leverage}x`);

      const targetNotional = accountBalance * (signal.accountPercentage / 100) * resolvedStrategy.leverage;
      quantity = targetNotional / effectivePrice;
      notional = targetNotional;

      this.logger.log(`[QUANTITY CALC] Result - Notional: ${notional.toFixed(2)} USDT, Quantity: ${this.formatQuantityWithUsdt(quantity, effectivePrice)}`);
    } else if (resolvedStrategy.useAccountPercentage && resolvedStrategy.accountPercentage && effectivePrice) {
      this.logger.log(`[QUANTITY CALC] Strategy percentage mode - enableCompound: ${resolvedStrategy.enableCompound}`);

      if (!resolvedStrategy.enableCompound) {
        const lastTradeWithQty = await this.tradesService.findLastTradeWithInitialQuantity(resolvedStrategy.id);
        if (lastTradeWithQty && lastTradeWithQty.initialQuantity) {
          quantity = parseFloat(lastTradeWithQty.initialQuantity as any);
          notional = quantity * effectivePrice;
          this.logger.log(`[COMPOUND OFF] Using fixed quantity from first trade: ${this.formatQuantityWithUsdt(quantity, effectivePrice)}, Notional: ${notional.toFixed(2)} USDT`);
        } else {
          const accountBalance = await this.getAccountBalance(resolvedStrategy);
          this.logger.log(`[COMPOUND OFF] First trade - Balance: ${accountBalance.toFixed(2)} USDT, Percentage: ${resolvedStrategy.accountPercentage}%, Leverage: ${resolvedStrategy.leverage}x`);

          const targetNotional = accountBalance * (resolvedStrategy.accountPercentage / 100) * resolvedStrategy.leverage;
          quantity = targetNotional / effectivePrice;
          notional = targetNotional;

          this.logger.log(`[COMPOUND OFF] First trade result - Notional: ${notional.toFixed(2)} USDT, Quantity: ${this.formatQuantityWithUsdt(quantity, effectivePrice)}`);
        }
      } else {
        const accountBalance = await this.getAccountBalance(resolvedStrategy);
        this.logger.log(`[COMPOUND ON] Balance: ${accountBalance.toFixed(2)} USDT, Percentage: ${resolvedStrategy.accountPercentage}%, Leverage: ${resolvedStrategy.leverage}x`);

        const targetNotional = accountBalance * (resolvedStrategy.accountPercentage / 100) * resolvedStrategy.leverage;
        quantity = targetNotional / effectivePrice;
        notional = targetNotional;

        this.logger.log(`[COMPOUND ON] Result - Notional: ${notional.toFixed(2)} USDT, Quantity: ${this.formatQuantityWithUsdt(quantity, effectivePrice)}`);
      }
    } else {
      quantity = resolvedStrategy.defaultQuantity || 0.002;
      notional = quantity * (effectivePrice || 0);
      this.logger.log(`[QUANTITY CALC] Using default quantity from strategy: ${this.formatQuantityWithUsdt(quantity, effectivePrice || 0)}, Notional: ${notional.toFixed(2)} USDT`);
    }

    this.logger.log(`[QUANTITY CALC] FINAL VALUES - Quantity: ${quantity.toFixed(6)}, Notional: ${notional.toFixed(2)} USDT, Leverage: ${resolvedStrategy.leverage}x`);

    if (notional < 5) {
       this.logger.warn(
         `[WARNING] Calculated notional (${notional.toFixed(2)} USDT) is extremely low. ` +
         `Binance Minimum is usually 5-10 USDT (100 on some pairs/testnet). ` +
         `DEBUG: quantity=${quantity.toFixed(6)}, price=${effectivePrice}, ` +
         `useAccountPercentage=${resolvedStrategy.useAccountPercentage}, accountPercentage=${resolvedStrategy.accountPercentage}%`
       );
    }

    if (notional < 10) {
       this.logger.error(
         `[NOTIONAL ERROR] Trade REJECTED - Notional too low! ` +
         `Calculated: ${notional.toFixed(2)} USDT | Minimum Required: 10 USDT | ` +
         `Symbol: ${normalizedSymbol} | Side: ${side} | ` +
         `Quantity: ${quantity.toFixed(6)} | Price: ${effectivePrice} | Leverage: ${resolvedStrategy.leverage}x | ` +
         `Strategy Config: useAccountPercentage=${resolvedStrategy.useAccountPercentage}, accountPercentage=${resolvedStrategy.accountPercentage}%, ` +
         `enableCompound=${resolvedStrategy.enableCompound}, isTestnet=${resolvedStrategy.isTestnet}`
       );

       const tradeData: Partial<Trade> = {
          strategyId: resolvedStrategy.id,
          portfolioId: resolvedStrategy.portfolioId,
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

    const isAveragingTrade = activeTrade && resolvedStrategy.allowAveraging;
    const shouldSaveInitialQuantity = !resolvedStrategy.enableCompound && resolvedStrategy.useAccountPercentage &&
      !(await this.tradesService.findLastTradeWithInitialQuantity(resolvedStrategy.id));

    if (isAveragingTrade && activeTrade) {
      this.logger.log(
        `[AVERAGING] Adding new independent entry for ${normalizedSymbol} ${side}\n` +
        `  New entry quantity: ${quantity}\n` +
        `  Original trade ${activeTrade.id} keeps its own SL/TP orders`
      );
    }

    const tradeData: Partial<Trade> = {
      strategyId: resolvedStrategy.id,
      portfolioId: resolvedStrategy.portfolioId,
      symbol: normalizedSymbol,
      side,
      type: isLimitOrder ? 'LIMIT' : 'MARKET',
      entryPrice: effectivePrice,
      quantity,
      status: 'OPEN',
      isFromAveraging: isAveragingTrade,
      initialQuantity: shouldSaveInitialQuantity ? quantity : undefined,
    };

    if (!resolvedStrategy.isTestnet && !resolvedStrategy.isRealAccount) {
      this.logger.warn(
        `[BLOCKED] Strategy "${resolvedStrategy.name}" has neither testnet nor real account enabled. ` +
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

    const accountMode = resolvedStrategy.isTestnet ? 'TESTNET' : 'MAINNET';
    const executionMode = (!resolvedStrategy.isTestnet && resolvedStrategy.isRealAccount) ? '[REAL ACCOUNT]' : `[${accountMode}]`;

    if (!resolvedStrategy.isTestnet && resolvedStrategy.isRealAccount) {
      this.logger.warn(`🚨 ${executionMode} EXECUTING REAL ORDER: ${side} ${this.formatQuantityWithUsdt(quantity, effectivePrice || 0)} on ${normalizedSymbol}`);
    } else {
      this.logger.log(`${executionMode} Executing: ${side} ${this.formatQuantityWithUsdt(quantity, effectivePrice || 0)} on ${normalizedSymbol}`);
    }

    let savedTrade: Trade | null = null;

    try {
      const decryptedKey = (await EncryptionUtil.decrypt(resolvedStrategy.apiKey)).trim();
      const decryptedSecret = (await EncryptionUtil.decrypt(resolvedStrategy.apiSecret)).trim();

      this.logger.log(`[DEBUG] Targeting Exchange: ${exchange} (Testnet: ${resolvedStrategy.isTestnet})`);

      // Check for existing open trade
      if (resolvedStrategy.id) {
        const existingTrade = await this.tradesService.findOpenTradeBySymbolAndSide(
          resolvedStrategy.id,
          normalizedSymbol,
          side
        );

        if (existingTrade) {
          this.logger.warn(
            `[DB] WARNING: Open trade already exists! ` +
            `Existing Trade ID=${existingTrade.id}, ` +
            `Symbol=${existingTrade.symbol}, ` +
            `Side=${existingTrade.side}, ` +
            `Created at=${existingTrade.timestamp}. ` +
            `This may indicate a duplicate webhook!`
          );
        }
      }

      this.logger.log(`[DB] Creating trade in database: Strategy=${resolvedStrategy.id}, Symbol=${tradeData.symbol}, Side=${tradeData.side}, Qty=${tradeData.quantity}`);
      savedTrade = await this.tradesService.create(tradeData);

      if (!savedTrade) {
        throw new Error('Failed to create trade in database');
      }

      this.logger.log(`[DB] Trade created successfully: ID=${savedTrade.id}, Status=${savedTrade.status}`);

      if (exchange === Exchange.BINANCE && this.binanceWs.isEnabled()) {
        await this.binanceWs.subscribeMarketData(normalizedSymbol, resolvedStrategy.isTestnet).catch(err => {
          this.logger.warn(`[WS] Failed to subscribe to market data: ${err.message}`);
        });
      }

      let tradeDetails: any;
      let stopLossOrderId: string | null = null;
      let takeProfitOrderId: string | null = null;
      let actualStopLossPrice: number | null = null;
      let tpWarnings: string | null = null;

      if (exchange === Exchange.BYBIT) {
        tradeDetails = await this.executeBybitOrder(
          resolvedStrategy,
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
          resolvedStrategy.leverage || 1,
          resolvedStrategy.marginMode || MarginMode.ISOLATED,
          decryptedKey,
          decryptedSecret,
          resolvedStrategy.isTestnet,
          resolvedStrategy.hedgeMode
        );

        tradeDetails = await this.executeBinanceOrder(
          resolvedStrategy,
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

      // For LIMIT orders: position won't exist until the order fills.
      // Schedule SL/TP creation in background and return immediately.
      if (isLimitOrder) {
        await this.tradesService.updateTrade(savedTrade.id, {
          entryPrice: tradeData.entryPrice,
          exchangeOrderId: tradeData.exchangeOrderId,
          pendingExpiresAt: null,
        });

        if (exchange === Exchange.BINANCE) {
          this.scheduleProtectionOrders(savedTrade.id, normalizedSymbol, side, resolvedStrategy, decryptedKey, decryptedSecret);
        } else if (exchange === Exchange.BYBIT) {
          this.scheduleBybitProtectionOrders(savedTrade.id, normalizedSymbol, side, resolvedStrategy, decryptedKey, decryptedSecret, quantity);
        }

        this.logger.log(`[LIMIT] Entry order placed (${tradeData.exchangeOrderId}). SL/TP will be created when position is confirmed.`);
        return {
          status: 'success',
          message: 'LIMIT order placed. SL/TP will be created automatically when the order fills.',
          trade: { ...tradeData, id: savedTrade.id },
        };
      }

      // For Binance MARKET: Verify position exists before creating SL/TP (prevents race condition)
      let actualEntryPrice: number | undefined;
      let actualEntryQty: number | undefined;
      let detectedPositionSide: string | undefined; // Track actual position mode (BOTH, LONG, SHORT)

      if (exchange === Exchange.BINANCE) {
        this.logger.log(`[POSITION VERIFY] Waiting for position to appear in system...`);

        const existingQtyForVerify = isAveragingTrade
          ? openTrades
              .filter(t => t.symbol === normalizedSymbol && t.strategyId === resolvedStrategy.id && t.side === side)
              .reduce((sum, t) => sum + parseFloat(t.quantity as any), 0)
          : 0;
        const expectedCombinedQty = existingQtyForVerify > 0 ? existingQtyForVerify + quantity : undefined;

        try {
          const positionInfo = await this.verifyPositionExists(
            normalizedSymbol,
            side,
            decryptedKey,
            decryptedSecret,
            resolvedStrategy.isTestnet,
            resolvedStrategy.hedgeMode,
            expectedCombinedQty
          );
          actualEntryPrice = positionInfo.entryPrice;
          detectedPositionSide = positionInfo.actualPositionSide; // Capture actual position mode
          if (!isAveragingTrade) {
            actualEntryQty = positionInfo.quantity;
          }

          if (detectedPositionSide === 'BOTH') {
            this.logger.log(`[POSITION MODE] One-Way Mode detected - SL/TP will use positionSide=BOTH`);
          } else {
            this.logger.log(`[POSITION MODE] Hedge Mode detected - SL/TP will use positionSide=${detectedPositionSide}`);
          }

          this.logger.log(`[ENTRY PRICE] Using actual entry price from position: ${actualEntryPrice} (signal was ${signal.price})`);
        } catch (error: any) {
          this.logger.error(
            `[POSITION VERIFY] CRITICAL - Position not found after entry order.\n` +
            `  This may indicate the entry order was not filled.\n` +
            `  Cannot create SL/TP without a confirmed position.`
          );

          // Update trade status to reflect the issue
          await this.tradesService.updateTrade(savedTrade.id, {
            status: 'ERROR',
            error: 'Position not confirmed on exchange after entry order. Order may not have filled.',
          });

          return {
            status: 'error',
            message: `Entry order sent but position not confirmed on Binance. The order may not have filled. Please check your Binance Futures account.`,
            trade: savedTrade,
          };
        }
      } else if (exchange === Exchange.BYBIT && !isLimitOrder) {
        const bybitSideForFill = side === 'BUY' ? 'Buy' : 'Sell';
        try {
          actualEntryPrice = await this.getBybitActualFillPrice(
            decryptedKey,
            decryptedSecret,
            resolvedStrategy.isTestnet,
            normalizedSymbol,
            tradeDetails.id,
            bybitSideForFill
          );

          if (actualEntryPrice) {
            this.logger.log(`[ENTRY PRICE] Using actual entry price from Bybit order: ${actualEntryPrice} (signal was ${signal.price})`);
          } else {
            this.logger.warn(
              `[PROTECTION ORDERS] Preço real de execução indisponível — TP/SL calculados sobre o preço do sinal`
            );
          }
        } catch (fillError: any) {
          this.logger.warn(
            `[PROTECTION ORDERS] Preço real de execução indisponível — TP/SL calculados sobre o preço do sinal (erro: ${fillError.message})`
          );
        }
      }

      // --- STOP LOSS & TAKE PROFIT CREATION WITH ROLLBACK ---
      // CRITICAL: If SL/TP creation fails, we MUST close the position to avoid unprotected trades
      try {
        // IMPORTANT LOGIC:
        // - First entry (not averaging): Use actual filled price from position (accounts for slippage)
        // - Averaging entry: ALWAYS use signal price (NOT the average position price)
        //   Example: First entry $100, second entry $110 → position avg is $105
        //   But we want TPs for second entry based on $110, not $105!
        const { price: priceForProtectionOrders } = resolveProtectionPrice({
          isLimitOrder,
          isAveragingTrade,
          actualEntryPrice,
          signalPrice: entryPrice,
        });

        if (priceForProtectionOrders !== entryPrice) {
          this.logger.log(
            `[PROTECTION ORDERS] Using actual filled price: ${priceForProtectionOrders} instead of signal price: ${entryPrice}\n` +
            `  Slippage: ${((priceForProtectionOrders - entryPrice) / entryPrice * 100).toFixed(4)}%`
          );
        } else if (isAveragingTrade && actualEntryPrice) {
          this.logger.warn(
            `[PROTECTION ORDERS] Averaging mode: Using signal price ${entryPrice} (NOT position average ${actualEntryPrice}) — ` +
            `preço médio pós-merge não é usado propositalmente (cada entrada mantém SL/TP independentes com base no seu próprio preço)`
          );
        }

        // --- STOP LOSS ---
        this.logger.log(
          `[PROTECTION ORDERS] Strategy values from DB:\n` +
          `  SL%: ${resolvedStrategy.stopLossPercentage} (type: ${typeof resolvedStrategy.stopLossPercentage})\n` +
          `  TP1%: ${resolvedStrategy.takeProfitPercentage1} (type: ${typeof resolvedStrategy.takeProfitPercentage1})\n` +
          `  TP2%: ${resolvedStrategy.takeProfitPercentage2} (type: ${typeof resolvedStrategy.takeProfitPercentage2})\n` +
          `  TP3%: ${resolvedStrategy.takeProfitPercentage3} (type: ${typeof resolvedStrategy.takeProfitPercentage3})`
        );
        let stopLossPrice: number | null = null;
        if (signal.stopLoss) {
          stopLossPrice = signal.stopLoss;
          this.logger.log(`[SL] Using absolute stop loss from signal: ${stopLossPrice}`);
        } else if (resolvedStrategy.stopLossPercentage && resolvedStrategy.stopLossPercentage > 0) {
          stopLossPrice = this.calculateStopLossPrice(side, priceForProtectionOrders, resolvedStrategy.stopLossPercentage);
        }

        if (stopLossPrice) {
          actualStopLossPrice = stopLossPrice;
          const rules = await this.getSymbolRules(normalizedSymbol, resolvedStrategy.isTestnet, exchange);
          const slPriceRounded = parseFloat(roundPriceToTick(stopLossPrice, rules.priceTick));
          const effectiveSlPercent = side === 'BUY'
            ? ((priceForProtectionOrders - slPriceRounded) / priceForProtectionOrders) * 100
            : ((slPriceRounded - priceForProtectionOrders) / priceForProtectionOrders) * 100;

          this.logger.log(
            `[SL] Precision analysis:\n` +
            `  Entry Price: ${priceForProtectionOrders}\n` +
            `  Target %: ${resolvedStrategy.stopLossPercentage || 'N/A'}%\n` +
            `  Calculated Price: ${stopLossPrice.toFixed(8)}\n` +
            `  Exchange Tick: ${rules.priceTick}\n` +
            `  Rounded Price: ${slPriceRounded.toFixed(8)}\n` +
            `  Effective %: ${effectiveSlPercent.toFixed(4)}%`
          );

          if (exchange === Exchange.BYBIT && !isAveragingTrade) {
            const bybitSide = side === 'BUY' ? 'Buy' : 'Sell';
            try {
              const slOrder = await this.bybitClient.createStopLossOrder(
                decryptedKey, decryptedSecret, resolvedStrategy.isTestnet,
                normalizedSymbol, bybitSide, normalizeQuantity(quantity, rules.qtyStep, rules.minQty),
                roundPriceToTick(stopLossPrice, rules.priceTick), resolvedStrategy.hedgeMode
              );
              stopLossOrderId = slOrder.orderId;
              this.logger.log(`[SL] Bybit Stop Loss order created: ${stopLossOrderId} at ${roundPriceToTick(stopLossPrice, rules.priceTick)}`);
            } catch (slError: any) {
              this.logger.error(`[SL] Failed to create Bybit SL order: ${slError.message}. Continuing with TP creation...`);
            }
          } else if (exchange === Exchange.BYBIT && isAveragingTrade) {
            this.logger.log(
              `[SL] Bybit averaging entry: Each entry has independent SL based on its own entry price. ` +
              `This entry (SL=${stopLossPrice}) will be monitored by software. ` +
              `Note: Bybit only allows 1 position-level SL, so averaging trades cannot use setTradingStop.`
            );
          } else if (isAveragingTrade && activeTrade && !resolvedStrategy.hedgeMode) {
            this.logger.log(
              `[SL] One-way mode averaging: Each entry has independent SL based on its own entry price. ` +
              `This entry (SL=${stopLossPrice}) will be monitored by software. ` +
              `Each trade manages its own Stop Loss independently.`
            );
          } else if (isAveragingTrade && resolvedStrategy.hedgeMode) {
            this.logger.log(
              `[SL] Hedge mode averaging: Binance allows only 1 STOP per positionSide. ` +
              `This entry (SL=${stopLossPrice} based on entry ${priceForProtectionOrders}) will be monitored by software. ` +
              `Each trade has independent SL based on its own entry price.`
            );
          } else {
            try {
              stopLossOrderId = await this.createBinanceStopLossOrder(
                normalizedSymbol, side, quantity, stopLossPrice, decryptedKey, decryptedSecret, resolvedStrategy.isTestnet, resolvedStrategy.hedgeMode, detectedPositionSide
              );
              this.logger.log(`[SL] Successfully created Stop Loss order: ${stopLossOrderId}`);
            } catch (slError: any) {
              this.logger.error(`[SL] Failed to create Binance SL order: ${slError.message}. Continuing with TP creation...`);
            }
          }
        }

        // --- MULTI-PARTIAL TAKE PROFITS ---
        // Each entry (including averaging) creates its own independent TPs for its own quantity
        const rules = await this.getSymbolRules(normalizedSymbol, resolvedStrategy.isTestnet, exchange);
        const normalizedEntryQty = Number(normalizeQuantity(quantity, rules.qtyStep, rules.minQty));
        const quantityForTPs = actualEntryQty && actualEntryQty > 0 ? actualEntryQty : normalizedEntryQty;
        if (quantityForTPs !== quantity) {
          this.logger.warn(
            `[TP] Quantidade bruta calculada (${quantity}) difere da quantidade usada para planejar TPs (${quantityForTPs}, ` +
            `${actualEntryQty && actualEntryQty > 0 ? 'posicao real na corretora' : 'normalizada ao qtyStep da entrada'})`
          );
        }

        const enabledTps = buildEnabledTpConfigs(resolvedStrategy);
        const tpPlan = planTakeProfits({
          quantity: quantityForTPs,
          tps: enabledTps.map(tp => ({
            id: tp.id,
            percent: tp.percent,
            qtyPercent: tp.qtyPercent,
            price: this.calculateTakeProfitPrice(side, priceForProtectionOrders, tp.percent),
          })),
          qtyStep: rules.qtyStep,
          minQty: rules.minQty,
          minNotional: Number(rules.minNotional),
        });

        if (tpPlan.discarded.length > 0) {
          this.logger.warn(
            `[TP] ${tpPlan.discarded.length} TP(s) discarded during planning: ` +
            tpPlan.discarded.map(d => `TP${d.id}(${d.reason})`).join(', ')
          );
        }

        const tpConfigs = tpPlan.planned;

        const tpOrderIds: string[] = [];

        if (isAveragingTrade) {
          this.logger.log(`[TP] Creating independent TPs for new entry: ${quantityForTPs} (existing entry keeps its own TPs)`);
        }

        let bybitPositionIdx: number | undefined;
        if (exchange === Exchange.BYBIT) {
          this.logger.log(`[BYBIT] Waiting for position to be confirmed before creating TP orders...`);
          const bybitSide = side === 'BUY' ? 'Buy' : 'Sell';
          const positionConfirmed = await this.bybitClient.waitForPosition(
            decryptedKey, decryptedSecret, resolvedStrategy.isTestnet, normalizedSymbol, bybitSide, 10, 500, resolvedStrategy.hedgeMode
          );

          if (!positionConfirmed) {
            this.logger.warn(`[BYBIT] Position not confirmed within timeout. TP orders may fail.`);
          }

          bybitPositionIdx = await this.bybitClient.getPositionIdx(
            decryptedKey, decryptedSecret, resolvedStrategy.isTestnet, normalizedSymbol, bybitSide, resolvedStrategy.hedgeMode
          );
          this.logger.log(`[BYBIT] Using positionIdx ${bybitPositionIdx} for TP orders (original position side: ${bybitSide})`);
        }

        const failedTps: Array<{ id: number; reason: string }> = [];

        for (const tp of tpConfigs) {
          const tpPriceRaw = this.calculateTakeProfitPrice(side, priceForProtectionOrders, tp.percent);
          const tpQty = Number(tp.quantity);

          if (tpQty <= 0) continue;

          const rules = await this.getSymbolRules(normalizedSymbol, resolvedStrategy.isTestnet, exchange);
          const tpPriceRounded = parseFloat(roundPriceToTick(tpPriceRaw, rules.priceTick));
          const effectivePercent = side === 'BUY'
            ? ((tpPriceRounded - priceForProtectionOrders) / priceForProtectionOrders) * 100
            : ((priceForProtectionOrders - tpPriceRounded) / priceForProtectionOrders) * 100;

          this.logger.log(
            `[TP${tp.id}] Precision analysis:\n` +
            `  Entry Price: ${priceForProtectionOrders}\n` +
            `  Target %: ${tp.percent}%\n` +
            `  Calculated Price: ${tpPriceRaw.toFixed(8)}\n` +
            `  Exchange Tick: ${rules.priceTick}\n` +
            `  Rounded Price: ${tpPriceRounded.toFixed(8)}\n` +
            `  Effective %: ${effectivePercent.toFixed(4)}%\n` +
            `  Quantity: ${this.formatQuantityWithUsdt(tpQty, tpPriceRounded)}`
          );

          try {
            if (exchange === Exchange.BYBIT) {
              const bybitOrder = await withOneRetry(() => this.bybitClient.createOrder(
                decryptedKey, decryptedSecret, resolvedStrategy.isTestnet,
                {
                  symbol: normalizedSymbol,
                  side: side === 'BUY' ? 'Sell' : 'Buy',
                  orderType: 'Limit',
                  qty: tp.quantity,
                  price: roundPriceToTick(tpPriceRaw, rules.priceTick),
                  positionIdx: bybitPositionIdx,
                  reduceOnly: true,
                  hedgeMode: resolvedStrategy.hedgeMode
                }
              ), (ms) => this.sleep(ms));
              if (bybitOrder?.orderId) {
                tpOrderIds.push(`${tp.id}:${bybitOrder.orderId}`);
              }
            } else {
              const tpOrderId = await withOneRetry(() => this.createBinanceTakeProfitOrder(
                normalizedSymbol, side, tpQty, tpPriceRaw, decryptedKey, decryptedSecret, resolvedStrategy.isTestnet, resolvedStrategy.hedgeMode, detectedPositionSide
              ), (ms) => this.sleep(ms));
              tpOrderIds.push(`${tp.id}:${tpOrderId}`);
              this.logger.log(`[TP${tp.id}] Successfully created Take Profit order: ${tpOrderId}`);
            }
          } catch (tpError: any) {
            this.logger.error(`[TP${tp.id}] Failed to create after retry: ${tpError.message}`);
            failedTps.push({ id: tp.id, reason: tpError.message });
          }
        }

        if (tpOrderIds.length > 0) {
          takeProfitOrderId = tpOrderIds.join('|');
        }
        tpWarnings = buildTpWarnings(tpPlan.discarded, failedTps);

        const hasStopLoss = !!stopLossOrderId || (isAveragingTrade && stopLossPrice);
        const hasTakeProfit = tpOrderIds.length > 0;
        const requiredMinimumProtection = tpConfigs.length > 0;

        if (requiredMinimumProtection && !hasTakeProfit && !hasStopLoss) {
          throw new Error(
            `CRITICAL: No protection orders were created. ` +
            `Expected ${tpConfigs.length} TPs and 1 SL, but all failed. ` +
            `Position would be completely unprotected.`
          );
        }

        if (requiredMinimumProtection && !hasTakeProfit && tpConfigs.length > 0) {
          this.logger.error(
            `[PROTECTION WARNING] All ${tpConfigs.length} TP orders failed to create. ` +
            `Position only has SL protection (${stopLossOrderId || 'software-monitored'}). ` +
            `Consider this a partial failure.`
          );
        } else if (failedTps.length > 0) {
          this.logger.error(
            `[PROTECTION WARNING] ${failedTps.length} of ${tpConfigs.length} TP orders failed to create. ` +
            `Position has partial TP coverage: ${tpOrderIds.length}/${tpConfigs.length}.`
          );
        }

        this.logger.log(
          `[PROTECTION] Protection orders created\n` +
          `  Stop Loss: ${stopLossOrderId || (isAveragingTrade && stopLossPrice ? 'Software-monitored' : 'N/A')}\n` +
          `  Take Profits: ${takeProfitOrderId || 'N/A'}\n` +
          `  Status: ${hasTakeProfit ? tpOrderIds.length + '/' + tpConfigs.length + ' TPs created' : 'No TPs'}`
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
              resolvedStrategy.isTestnet,
              resolvedStrategy.hedgeMode,
              isAveragingTrade ? quantity : undefined
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

      // Update trade with actual entry price (not signal price) for MARKET orders
      const finalEntryPrice = resolveFinalEntryPrice({
        isLimitOrder,
        actualEntryPrice,
        fallbackPrice: tradeData.entryPrice,
      });

      await this.tradesService.updateTrade(savedTrade.id, {
        entryPrice: finalEntryPrice,
        exchangeOrderId: tradeData.exchangeOrderId,
        stopLossOrderId: stopLossOrderId || undefined,
        takeProfitOrderId: takeProfitOrderId || undefined,
        currentStopLoss: actualStopLossPrice ? parseFloat(roundPriceToTick(actualStopLossPrice, (await this.getSymbolRules(normalizedSymbol, resolvedStrategy.isTestnet, exchange)).priceTick)) as any : undefined,
        tpWarnings,
      });

      this.logger.log(`[TRADE] Updated trade ${savedTrade.id} with order details`);

      await this.tradesService.createExecution({
        tradeId: savedTrade.id,
        type: ExecutionType.ENTRY,
        price: finalEntryPrice,
        quantity: quantity,
        pnl: null,
        percentOfPosition: null,
        exchangeOrderId: tradeData.exchangeOrderId
      });

      this.logger.log(`[EXECUTION] Registered ENTRY execution for trade ${savedTrade.id}`);

      if (isAveragingTrade) {
        this.logger.log(
          `[AVERAGING] New independent SL/TP created for new entry on trade ${savedTrade.id}\n` +
          `  New entry quantity: ${quantity}\n` +
          `  Original trade ${activeTrade?.id} retains its own SL/TP orders`
        );
      }

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

    // Fetch Bybit-specific symbol rules
    const rules = await this.getSymbolRules(symbol, strategy.isTestnet, Exchange.BYBIT);
    const formattedQty = normalizeQuantity(quantity, rules.qtyStep, rules.minQty);
    const formattedPrice = signal.price ? roundPriceToTick(signal.price, rules.priceTick) : undefined;

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
        hedgeMode: strategy.hedgeMode
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
    this.logger.log(`[executeBinanceOrder] Using Direct API for all Binance accounts (CCXT has issues with positionSide)`);

    const actualHedgeMode = await this.getBinancePositionMode(apiKey, apiSecret, strategy.isTestnet);
    this.logger.log(`[ENTRY ORDER] Detected mode: ${actualHedgeMode ? 'HEDGE' : 'ONE-WAY'}`);

    const params = new URLSearchParams();
    params.append('symbol', symbol);
    params.append('side', side);

    if (actualHedgeMode) {
      const positionSide = side === 'BUY' ? 'LONG' : 'SHORT';
      params.append('positionSide', positionSide);
      this.logger.log(`[ENTRY ORDER] Adding positionSide=${positionSide} for Hedge Mode`);
    } else {
      this.logger.log(`[ENTRY ORDER] No positionSide for One-Way Mode`);
    }

    const rules = await this.getSymbolRules(symbol, strategy.isTestnet);

    if (isLimitOrder) {
      params.append('type', 'LIMIT');
      params.append('price', roundPriceToTick(signal.price!, rules.priceTick));
      params.append('timeInForce', 'GTC');
      this.logger.log(`[BINANCE] Creating LIMIT order at price ${signal.price}`);
    } else {
      params.append('type', 'MARKET');
      this.logger.log(`[BINANCE] Creating MARKET order`);
    }

    params.append('quantity', normalizeQuantity(quantity, rules.qtyStep, rules.minQty));

    try {
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
    } catch (firstError: any) {
      const errorCode = firstError.response?.data?.code;
      const errorMsg = firstError.response?.data?.msg;

      if (errorCode === -4061) {
        this.logger.warn(`[ENTRY ORDER] Error -4061 detected. Toggling positionSide and retrying...`);

        if (params.has('positionSide')) {
          this.logger.log(`[ENTRY ORDER] Removing positionSide and retrying (One-Way Mode)`);
          params.delete('positionSide');
        } else {
          const positionSide = side === 'BUY' ? 'LONG' : 'SHORT';
          this.logger.log(`[ENTRY ORDER] Adding positionSide=${positionSide} and retrying (Hedge Mode)`);
          params.set('positionSide', positionSide);
        }

        const retryResponse = await this.createBinanceOrder(params, apiKey, apiSecret, strategy.isTestnet);
        this.logger.log(`[BINANCE] Order Placed after retry! Order ID: ${retryResponse.orderId}`);

        const retryFilledPrice = parseFloat(retryResponse.avgPrice || retryResponse.price || '0');
        const retryFinalPrice = retryFilledPrice > 0 ? retryFilledPrice : signal.price;

        return {
          id: retryResponse.orderId.toString(),
          price: retryFinalPrice,
          average: retryFinalPrice,
          status: retryResponse.status
        };
      }

      throw firstError;
    }
  }

}
