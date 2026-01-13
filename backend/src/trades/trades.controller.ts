import { Controller, Get, Post, Query } from '@nestjs/common';
import { TradesService } from './trades.service';
import { PositionSyncService } from '../position-sync/position-sync.service';

@Controller('trades')
export class TradesController {
  constructor(
    private readonly tradesService: TradesService,
    private readonly positionSyncService: PositionSyncService,
  ) {}

  @Get()
  findAll(@Query('status') status?: string, @Query('limit') limit?: string) {
    return this.tradesService.findAll(status, limit ? parseInt(limit) : undefined);
  }

  @Get('stats')
  getStats() {
    return this.tradesService.getStats();
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
}
