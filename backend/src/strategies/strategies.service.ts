import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Strategy, Exchange } from './strategy.entity';
import { EncryptionUtil } from '../utils/encryption.util';
import { BybitClientService } from '../exchange/bybit-client.service';
import axios from 'axios';
import * as crypto from 'crypto';

@Injectable()
export class StrategiesService {
  private readonly logger = new Logger(StrategiesService.name);
  private readonly BINANCE_TESTNET_URL = 'https://testnet.binancefuture.com';
  private readonly BINANCE_MAINNET_URL = 'https://fapi.binance.com';

  constructor(
    @InjectRepository(Strategy)
    private strategiesRepository: Repository<Strategy>,
    private readonly bybitClient: BybitClientService,
  ) {}

  findAll(): Promise<Strategy[]> {
    return this.strategiesRepository.find();
  }

  findOne(id: string): Promise<Strategy | null> {
    return this.strategiesRepository.findOne({
      where: { id },
      select: [
        'id',
        'name',
        'asset',
        'exchange',
        'direction',
        'isActive',
        'isTestnet',
        'isRealAccount',
        'leverage',
        'marginMode',
        'defaultQuantity',
        'stopLossPercentage',
        'takeProfitPercentage1',
        'takeProfitPercentage2',
        'takeProfitPercentage3',
        'takeProfitQuantity1',
        'takeProfitQuantity2',
        'takeProfitQuantity3',
        'breakAgain',
        'moveSLToBreakeven',
        'nextCandleEntry',
        'nextCandlePercentage',
        'useAccountPercentage',
        'accountPercentage',
        'enableCompound',
        'tradingMode',
        'allowAveraging',
        'hedgeMode',
        'pauseNewOrders',
        'apiKey',
        'apiSecret'
      ]
    });
  }

  findOnePublic(id: string): Promise<Strategy | null> {
    return this.strategiesRepository.findOne({
      where: { id },
      select: [
        'id',
        'name',
        'asset',
        'exchange',
        'direction',
        'isActive',
        'isTestnet',
        'isRealAccount',
        'leverage',
        'marginMode',
        'defaultQuantity',
        'stopLossPercentage',
        'takeProfitPercentage1',
        'takeProfitPercentage2',
        'takeProfitPercentage3',
        'takeProfitQuantity1',
        'takeProfitQuantity2',
        'takeProfitQuantity3',
        'breakAgain',
        'moveSLToBreakeven',
        'nextCandleEntry',
        'nextCandlePercentage',
        'useAccountPercentage',
        'accountPercentage',
        'enableCompound',
        'tradingMode',
        'allowAveraging',
        'hedgeMode',
        'pauseNewOrders'
      ]
    });
  }

  async create(strategy: Partial<Strategy>): Promise<Strategy> {
    if (strategy.apiKey) {
        strategy.apiKey = await EncryptionUtil.encrypt(strategy.apiKey);
    }
    if (strategy.apiSecret) {
        strategy.apiSecret = await EncryptionUtil.encrypt(strategy.apiSecret);
    }
    const newStrategy = this.strategiesRepository.create(strategy);
    return this.strategiesRepository.save(newStrategy);
  }

  async update(id: string, strategy: Partial<Strategy>): Promise<Strategy | null> {
    if (strategy.apiKey) {
        strategy.apiKey = await EncryptionUtil.encrypt(strategy.apiKey);
    }
    if (strategy.apiSecret) {
        strategy.apiSecret = await EncryptionUtil.encrypt(strategy.apiSecret);
    }
    await this.strategiesRepository.update(id, strategy);
    return this.strategiesRepository.findOneBy({ id });
  }

  async remove(id: string): Promise<void> {
    await this.strategiesRepository.delete(id);
  }

  async getOpenOrders(id: string): Promise<any> {
    const strategy = await this.findOne(id);
    if (!strategy) {
      throw new Error('Strategy not found');
    }

    const apiKey = (await EncryptionUtil.decrypt(strategy.apiKey)).trim();
    const apiSecret = (await EncryptionUtil.decrypt(strategy.apiSecret)).trim();
    const exchange = strategy.exchange || Exchange.BINANCE;

    const result: any = {
      strategy: {
        id: strategy.id,
        name: strategy.name,
        exchange,
        isTestnet: strategy.isTestnet,
        isRealAccount: strategy.isRealAccount,
      },
      openOrders: [],
      openPositions: [],
    };

    if (!strategy.isTestnet && strategy.isRealAccount) {
      result.accountMode = 'REAL ACCOUNT';
      this.logger.warn(`🚨 [REAL ACCOUNT] Checking open orders for strategy: ${strategy.name}`);
    } else {
      result.accountMode = strategy.isTestnet ? 'TESTNET' : 'MAINNET';
    }

    try {
      if (exchange === Exchange.BYBIT) {
        const orders = await this.bybitClient.getOpenOrders(apiKey, apiSecret, strategy.isTestnet);
        result.openOrders = orders.map((order: any) => ({
          orderId: order.orderId,
          symbol: order.symbol,
          side: order.side,
          type: order.orderType,
          price: parseFloat(order.price),
          quantity: parseFloat(order.qty),
          status: order.orderStatus,
        }));

        const positions = await this.bybitClient.getPositions(apiKey, apiSecret, strategy.isTestnet);
        result.openPositions = positions
          .filter((pos: any) => parseFloat(pos.size) > 0)
          .map((pos: any) => ({
            symbol: pos.symbol,
            side: pos.side,
            size: parseFloat(pos.size),
            entryPrice: parseFloat(pos.avgPrice),
            unrealizedPnl: parseFloat(pos.unrealisedPnl),
            leverage: parseFloat(pos.leverage),
          }));
      } else {
        const baseUrl = strategy.isTestnet ? this.BINANCE_TESTNET_URL : this.BINANCE_MAINNET_URL;

        const ordersTimestamp = Date.now();
        const ordersQuery = `timestamp=${ordersTimestamp}`;
        const ordersSignature = crypto.createHmac('sha256', apiSecret).update(ordersQuery).digest('hex');

        const ordersResponse = await axios.get(
          `${baseUrl}/fapi/v1/openOrders?${ordersQuery}&signature=${ordersSignature}`,
          { headers: { 'X-MBX-APIKEY': apiKey } }
        );

        result.openOrders = ordersResponse.data.map((order: any) => ({
          orderId: order.orderId,
          symbol: order.symbol,
          side: order.side,
          type: order.type,
          price: parseFloat(order.price),
          quantity: parseFloat(order.origQty),
          status: order.status,
        }));

        const positionsTimestamp = Date.now();
        const positionsQuery = `timestamp=${positionsTimestamp}`;
        const positionsSignature = crypto.createHmac('sha256', apiSecret).update(positionsQuery).digest('hex');

        const positionsResponse = await axios.get(
          `${baseUrl}/fapi/v2/positionRisk?${positionsQuery}&signature=${positionsSignature}`,
          { headers: { 'X-MBX-APIKEY': apiKey } }
        );

        result.openPositions = positionsResponse.data
          .filter((pos: any) => parseFloat(pos.positionAmt) !== 0)
          .map((pos: any) => ({
            symbol: pos.symbol,
            side: parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT',
            size: Math.abs(parseFloat(pos.positionAmt)),
            entryPrice: parseFloat(pos.entryPrice),
            unrealizedPnl: parseFloat(pos.unRealizedProfit),
            leverage: parseFloat(pos.leverage),
          }));
      }

      this.logger.log(
        `[ORDERS CHECK] ${strategy.name}: ${result.openOrders.length} open orders, ${result.openPositions.length} open positions`
      );

      return result;
    } catch (error) {
      this.logger.error(`Failed to fetch open orders: ${error.message}`);
      throw error;
    }
  }
}
