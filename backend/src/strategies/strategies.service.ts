import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Strategy } from './strategy.entity';
import { EncryptionUtil } from '../utils/encryption.util';

@Injectable()
export class StrategiesService {
  constructor(
    @InjectRepository(Strategy)
    private strategiesRepository: Repository<Strategy>,
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
        'isDryRun',
        'isTestnet',
        'leverage',
        'marginMode',
        'defaultQuantity',
        'stopLossPercentage',
        'takeProfitPercentage1',
        'takeProfitPercentage2',
        'takeProfitPercentage3',
        'moveSLToBreakeven',
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
        'isDryRun',
        'isTestnet',
        'leverage',
        'marginMode',
        'defaultQuantity',
        'stopLossPercentage',
        'takeProfitPercentage1',
        'takeProfitPercentage2',
        'takeProfitPercentage3',
        'moveSLToBreakeven'
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
}
