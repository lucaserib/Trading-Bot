import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPortfolioIdToTrade1788763706885 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "trade"
      ADD COLUMN "portfolioId" uuid
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_trade_portfolioId" ON "trade" ("portfolioId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_trade_portfolioId"`);
    await queryRunner.query(`ALTER TABLE "trade" DROP COLUMN "portfolioId"`);
  }
}
