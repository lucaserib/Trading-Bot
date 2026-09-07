import { Body, Controller, Post } from '@nestjs/common';
import { AdminService } from './admin.service';

interface ResetTradesDto {
  dryRun?: boolean;
  confirm?: string;
  portfolioId?: string;
  executedBy?: string;
}

@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Post('reset-trades')
  resetTrades(@Body() body: ResetTradesDto) {
    return this.adminService.resetTrades(body ?? {});
  }
}
