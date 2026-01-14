import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';

export interface BybitOrderResponse {
  orderId: string;
  orderLinkId: string;
}

export interface BybitPosition {
  symbol: string;
  side: 'Buy' | 'Sell' | 'None';
  size: string;
  avgPrice: string;
  unrealisedPnl: string;
  cumRealisedPnl: string;
  leverage: string;
  markPrice: string;
  liqPrice: string;
  positionValue: string;
}

export interface BybitOrderInfo {
  orderId: string;
  symbol: string;
  side: string;
  orderType: string;
  price: string;
  qty: string;
  orderStatus: string;
  avgPrice: string;
  cumExecQty: string;
}

export interface BybitTradeHistory {
  symbol: string;
  side: string;
  execPrice: string;
  execQty: string;
  execTime: string;
}

@Injectable()
export class BybitClientService {
  private readonly logger = new Logger(BybitClientService.name);

  private readonly MAINNET_URL = 'https://api.bybit.com';
  private readonly TESTNET_URL = 'https://api-testnet.bybit.com';
  private readonly RECV_WINDOW = '5000';

  private getBaseUrl(isTestnet: boolean): string {
    return isTestnet ? this.TESTNET_URL : this.MAINNET_URL;
  }

  private generateSignature(
    timestamp: string,
    apiKey: string,
    apiSecret: string,
    params: string
  ): string {
    const preSign = timestamp + apiKey + this.RECV_WINDOW + params;
    return crypto.createHmac('sha256', apiSecret).update(preSign).digest('hex');
  }

  private getHeaders(apiKey: string, apiSecret: string, params: string): Record<string, string> {
    const timestamp = Date.now().toString();
    const signature = this.generateSignature(timestamp, apiKey, apiSecret, params);

    return {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-SIGN': signature,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': this.RECV_WINDOW,
      'Content-Type': 'application/json',
    };
  }

  async createOrder(
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean,
    params: {
      symbol: string;
      side: 'Buy' | 'Sell';
      orderType: 'Market' | 'Limit';
      qty: string;
      price?: string;
      stopLoss?: string;
      takeProfit?: string;
      positionIdx?: number;
    }
  ): Promise<BybitOrderResponse> {
    const baseUrl = this.getBaseUrl(isTestnet);
    const endpoint = '/v5/order/create';

    const body: Record<string, any> = {
      category: 'linear',
      symbol: params.symbol,
      side: params.side,
      orderType: params.orderType,
      qty: params.qty,
      positionIdx: params.positionIdx ?? 0,
    };

    if (params.orderType === 'Limit' && params.price) {
      body.price = params.price;
      body.timeInForce = 'GTC';
    }

    if (params.stopLoss) {
      body.stopLoss = params.stopLoss;
      body.slOrderType = 'Market';
    }

    if (params.takeProfit) {
      body.takeProfit = params.takeProfit;
      body.tpOrderType = 'Market';
    }

    const bodyString = JSON.stringify(body);
    const headers = this.getHeaders(apiKey, apiSecret, bodyString);

    try {
      const response = await axios.post(`${baseUrl}${endpoint}`, body, { headers });

      if (response.data.retCode !== 0) {
        throw new Error(`Bybit API Error: ${response.data.retMsg}`);
      }

      this.logger.log(`[BYBIT] Order created: ${response.data.result.orderId}`);
      return response.data.result;
    } catch (error: any) {
      this.logger.error(`[BYBIT] Failed to create order: ${error.response?.data?.retMsg || error.message}`);
      throw error;
    }
  }

  async setLeverage(
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean,
    symbol: string,
    leverage: number
  ): Promise<void> {
    const baseUrl = this.getBaseUrl(isTestnet);
    const endpoint = '/v5/position/set-leverage';

    const body = {
      category: 'linear',
      symbol,
      buyLeverage: leverage.toString(),
      sellLeverage: leverage.toString(),
    };

    const bodyString = JSON.stringify(body);
    const headers = this.getHeaders(apiKey, apiSecret, bodyString);

    try {
      const response = await axios.post(`${baseUrl}${endpoint}`, body, { headers });

      if (response.data.retCode === 0) {
        this.logger.log(`[BYBIT] Leverage set to ${leverage}x for ${symbol}`);
      } else if (response.data.retCode === 110043) {
        this.logger.debug(`[BYBIT] Leverage already set to ${leverage}x for ${symbol}`);
      } else {
        this.logger.warn(`[BYBIT] Set leverage response: ${response.data.retMsg}`);
      }
    } catch (error: any) {
      if (error.response?.data?.retCode === 110043) {
        this.logger.debug(`[BYBIT] Leverage already set for ${symbol}`);
      } else {
        this.logger.warn(`[BYBIT] Failed to set leverage: ${error.response?.data?.retMsg || error.message}`);
      }
    }
  }

  async setMarginMode(
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean,
    symbol: string,
    marginMode: 'ISOLATED' | 'CROSS',
    leverage: number
  ): Promise<void> {
    const baseUrl = this.getBaseUrl(isTestnet);
    const endpoint = '/v5/position/switch-isolated';

    const tradeMode = marginMode === 'ISOLATED' ? 1 : 0;

    const body = {
      category: 'linear',
      symbol,
      tradeMode,
      buyLeverage: leverage.toString(),
      sellLeverage: leverage.toString(),
    };

    const bodyString = JSON.stringify(body);
    const headers = this.getHeaders(apiKey, apiSecret, bodyString);

    try {
      const response = await axios.post(`${baseUrl}${endpoint}`, body, { headers });

      if (response.data.retCode === 0) {
        this.logger.log(`[BYBIT] Margin mode set to ${marginMode} for ${symbol}`);
      } else if (response.data.retCode === 110026) {
        this.logger.debug(`[BYBIT] Margin mode already set to ${marginMode} for ${symbol}`);
      } else {
        this.logger.warn(`[BYBIT] Set margin mode response: ${response.data.retMsg}`);
      }
    } catch (error: any) {
      if (error.response?.data?.retCode === 110026) {
        this.logger.debug(`[BYBIT] Margin mode already set for ${symbol}`);
      } else {
        this.logger.warn(`[BYBIT] Failed to set margin mode: ${error.response?.data?.retMsg || error.message}`);
      }
    }
  }

  async getPositions(
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean,
    symbol?: string
  ): Promise<BybitPosition[]> {
    const baseUrl = this.getBaseUrl(isTestnet);
    const endpoint = '/v5/position/list';

    const params: Record<string, string> = {
      category: 'linear',
      settleCoin: 'USDT',
    };

    if (symbol) {
      params.symbol = symbol;
    }

    const queryString = new URLSearchParams(params).toString();
    const headers = this.getHeaders(apiKey, apiSecret, queryString);

    try {
      const response = await axios.get(`${baseUrl}${endpoint}?${queryString}`, { headers });

      if (response.data.retCode !== 0) {
        throw new Error(`Bybit API Error: ${response.data.retMsg}`);
      }

      return response.data.result.list || [];
    } catch (error: any) {
      this.logger.error(`[BYBIT] Failed to get positions: ${error.response?.data?.retMsg || error.message}`);
      throw error;
    }
  }

  async getOrderInfo(
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean,
    symbol: string,
    orderId: string
  ): Promise<BybitOrderInfo | null> {
    const baseUrl = this.getBaseUrl(isTestnet);
    const endpoint = '/v5/order/realtime';

    const params = {
      category: 'linear',
      symbol,
      orderId,
    };

    const queryString = new URLSearchParams(params).toString();
    const headers = this.getHeaders(apiKey, apiSecret, queryString);

    try {
      const response = await axios.get(`${baseUrl}${endpoint}?${queryString}`, { headers });

      if (response.data.retCode !== 0) {
        return null;
      }

      const orders = response.data.result.list || [];
      return orders.length > 0 ? orders[0] : null;
    } catch (error: any) {
      this.logger.error(`[BYBIT] Failed to get order info: ${error.response?.data?.retMsg || error.message}`);
      return null;
    }
  }

  async getOrderHistory(
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean,
    symbol: string,
    orderId: string
  ): Promise<BybitOrderInfo | null> {
    const baseUrl = this.getBaseUrl(isTestnet);
    const endpoint = '/v5/order/history';

    const params = {
      category: 'linear',
      symbol,
      orderId,
    };

    const queryString = new URLSearchParams(params).toString();
    const headers = this.getHeaders(apiKey, apiSecret, queryString);

    try {
      const response = await axios.get(`${baseUrl}${endpoint}?${queryString}`, { headers });

      if (response.data.retCode !== 0) {
        return null;
      }

      const orders = response.data.result.list || [];
      return orders.length > 0 ? orders[0] : null;
    } catch (error: any) {
      this.logger.error(`[BYBIT] Failed to get order history: ${error.response?.data?.retMsg || error.message}`);
      return null;
    }
  }

  async cancelOrder(
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean,
    symbol: string,
    orderId: string
  ): Promise<boolean> {
    const baseUrl = this.getBaseUrl(isTestnet);
    const endpoint = '/v5/order/cancel';

    const body = {
      category: 'linear',
      symbol,
      orderId,
    };

    const bodyString = JSON.stringify(body);
    const headers = this.getHeaders(apiKey, apiSecret, bodyString);

    try {
      const response = await axios.post(`${baseUrl}${endpoint}`, body, { headers });

      if (response.data.retCode === 0) {
        this.logger.log(`[BYBIT] Order ${orderId} cancelled`);
        return true;
      }

      return false;
    } catch (error: any) {
      this.logger.debug(`[BYBIT] Failed to cancel order: ${error.response?.data?.retMsg || error.message}`);
      return false;
    }
  }

  async getWalletBalance(
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean
  ): Promise<number> {
    const baseUrl = this.getBaseUrl(isTestnet);
    const endpoint = '/v5/account/wallet-balance';

    const params = {
      accountType: 'UNIFIED',
    };

    const queryString = new URLSearchParams(params).toString();
    const headers = this.getHeaders(apiKey, apiSecret, queryString);

    try {
      const response = await axios.get(`${baseUrl}${endpoint}?${queryString}`, { headers });

      if (response.data.retCode !== 0) {
        throw new Error(`Bybit API Error: ${response.data.retMsg}`);
      }

      const accounts = response.data.result.list || [];
      if (accounts.length > 0) {
        const coins = accounts[0].coin || [];
        const usdt = coins.find((c: any) => c.coin === 'USDT');
        return parseFloat(usdt?.availableToWithdraw || '0');
      }

      return 0;
    } catch (error: any) {
      this.logger.error(`[BYBIT] Failed to get wallet balance: ${error.response?.data?.retMsg || error.message}`);
      return 0;
    }
  }

  async getCurrentPrice(
    isTestnet: boolean,
    symbol: string
  ): Promise<number> {
    const baseUrl = this.getBaseUrl(isTestnet);
    const endpoint = '/v5/market/tickers';

    try {
      const response = await axios.get(`${baseUrl}${endpoint}?category=linear&symbol=${symbol}`);

      if (response.data.retCode !== 0) {
        throw new Error(`Bybit API Error: ${response.data.retMsg}`);
      }

      const tickers = response.data.result.list || [];
      if (tickers.length > 0) {
        return parseFloat(tickers[0].lastPrice);
      }

      return 0;
    } catch (error: any) {
      this.logger.error(`[BYBIT] Failed to get current price: ${error.message}`);
      return 0;
    }
  }

  async getLastTradePrice(
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean,
    symbol: string
  ): Promise<number | null> {
    const baseUrl = this.getBaseUrl(isTestnet);
    const endpoint = '/v5/execution/list';

    const params = {
      category: 'linear',
      symbol,
      limit: '1',
    };

    const queryString = new URLSearchParams(params).toString();
    const headers = this.getHeaders(apiKey, apiSecret, queryString);

    try {
      const response = await axios.get(`${baseUrl}${endpoint}?${queryString}`, { headers });

      if (response.data.retCode !== 0) {
        return null;
      }

      const executions = response.data.result.list || [];
      if (executions.length > 0) {
        return parseFloat(executions[0].execPrice);
      }

      return null;
    } catch (error: any) {
      this.logger.error(`[BYBIT] Failed to get last trade price: ${error.message}`);
      return null;
    }
  }

  async setTradingStop(
    apiKey: string,
    apiSecret: string,
    isTestnet: boolean,
    symbol: string,
    side: 'Buy' | 'Sell',
    stopLoss?: string,
    takeProfit?: string
  ): Promise<boolean> {
    const baseUrl = this.getBaseUrl(isTestnet);
    const endpoint = '/v5/position/trading-stop';

    const body: Record<string, any> = {
      category: 'linear',
      symbol,
      positionIdx: 0,
    };

    if (stopLoss) {
      body.stopLoss = stopLoss;
      body.slTriggerBy = 'MarkPrice';
    }

    if (takeProfit) {
      body.takeProfit = takeProfit;
      body.tpTriggerBy = 'MarkPrice';
    }

    const bodyString = JSON.stringify(body);
    const headers = this.getHeaders(apiKey, apiSecret, bodyString);

    try {
      const response = await axios.post(`${baseUrl}${endpoint}`, body, { headers });

      if (response.data.retCode === 0) {
        this.logger.log(`[BYBIT] Trading stop set for ${symbol}`);
        return true;
      }

      this.logger.warn(`[BYBIT] Set trading stop response: ${response.data.retMsg}`);
      return false;
    } catch (error: any) {
      this.logger.error(`[BYBIT] Failed to set trading stop: ${error.response?.data?.retMsg || error.message}`);
      return false;
    }
  }
}
