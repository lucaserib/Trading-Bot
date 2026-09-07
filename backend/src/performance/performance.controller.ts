import { Controller, Get, Query } from '@nestjs/common';
import { PerformanceService } from './performance.service';
import type { PerformancePeriod } from './performance.service';

@Controller('performance')
export class PerformanceController {
  constructor(private readonly performanceService: PerformanceService) {}

  @Get()
  getPerformance(@Query('portfolioId') portfolioId?: string, @Query('period') period?: PerformancePeriod) {
    return this.performanceService.getPerformance({ portfolioId, period });
  }
}
