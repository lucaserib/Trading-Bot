import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { PortfoliosService } from './portfolios.service';
import { PortfolioMigrationService } from './portfolio-migration.service';
import { Portfolio } from './portfolio.entity';

@Controller('portfolios')
export class PortfoliosController {
  constructor(
    private readonly portfoliosService: PortfoliosService,
    private readonly portfolioMigrationService: PortfolioMigrationService,
  ) {}

  @Get()
  findAll() {
    return this.portfoliosService.findAllPublic();
  }

  @Post('migrate-legacy')
  migrateLegacy() {
    return this.portfolioMigrationService.migrateLegacyStrategies();
  }

  @Post('backfill-trade-portfolio-ids')
  backfillTradePortfolioIds() {
    return this.portfolioMigrationService.backfillTradePortfolioIds();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.portfoliosService.findOnePublic(id);
  }

  @Post()
  create(@Body() body: Partial<Portfolio>) {
    return this.portfoliosService.create(body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Partial<Portfolio>) {
    return this.portfoliosService.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.portfoliosService.remove(id);
  }

  @Post(':id/test-connection')
  testConnection(@Param('id') id: string) {
    return this.portfoliosService.testConnection(id);
  }
}
