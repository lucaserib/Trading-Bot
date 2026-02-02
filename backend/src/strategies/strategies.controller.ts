import { Controller, Get, Post, Body, Put, Param, Delete, Query } from '@nestjs/common';
import { StrategiesService } from './strategies.service';
import { Strategy, StrategyDirection } from './strategy.entity';

@Controller('strategies')
export class StrategiesController {
  constructor(private readonly strategiesService: StrategiesService) {}

  @Get()
  findAll() {
    return this.strategiesService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.strategiesService.findOnePublic(id);
  }

  @Get(':id/webhook-json')
  async getWebhookJson(
    @Param('id') id: string,
    @Query('orderType') orderType?: string
  ) {
    const strategy = await this.strategiesService.findOnePublic(id);
    if (!strategy) {
      return { error: 'Strategy not found' };
    }

    const useLimit = orderType === 'limit';
    const symbol = `${strategy.asset}USDT`;
    const webhookSecret = process.env.WEBHOOK_SECRET || 'default_secret_123';
    const direction = strategy.direction || StrategyDirection.BOTH;

    const buildJson = (action: string) => ({
      secret: webhookSecret,
      strategyId: strategy.id,
      symbol,
      action,
      ...(useLimit && { orderType: 'limit' }),
      price: '{{close}}',
    });

    let jsonTemplates: any = {};
    let alertMessage: string;

    if (direction === StrategyDirection.BOTH) {
      jsonTemplates = {
        unified: {
          secret: webhookSecret,
          strategyId: strategy.id,
          symbol,
          action: '{{strategy.order.action}}',
          ...(useLimit && { orderType: 'limit' }),
          price: '{{close}}',
        },
        buy: buildJson('buy'),
        sell: buildJson('sell'),
      };
      alertMessage = JSON.stringify(jsonTemplates.unified).replace('"{{strategy.order.action}}"', '{{strategy.order.action}}').replace('"{{close}}"', '{{close}}');
    } else if (direction === StrategyDirection.LONG) {
      jsonTemplates = {
        buy: buildJson('buy'),
      };
      alertMessage = JSON.stringify(jsonTemplates.buy).replace('"{{close}}"', '{{close}}');
    } else {
      jsonTemplates = {
        sell: buildJson('sell'),
      };
      alertMessage = JSON.stringify(jsonTemplates.sell).replace('"{{close}}"', '{{close}}');
    }

    const pineScriptTemplate = this.generatePineScriptTemplate(strategy, useLimit);

    return {
      strategy: {
        id: strategy.id,
        name: strategy.name,
        asset: strategy.asset,
        direction,
      },
      webhookUrl: '/webhooks/tradingview',
      alertMessage,
      jsonTemplates,
      pineScriptTemplate,
      instructions: this.getInstructions(direction),
    };
  }

  private getInstructions(direction: StrategyDirection) {
    const base = {
      step1: 'Copy the PineScript template and paste it in TradingView Pine Editor',
      step2: 'Add the strategy to your chart',
      step3: 'Create an alert with the webhook URL pointing to your backend',
      step4: 'Copy the alertMessage above and paste in the alert message field',
    };

    if (direction === StrategyDirection.BOTH) {
      return {
        ...base,
        note: 'Strategy is set to BOTH - use unified template for automatic buy/sell detection',
      };
    } else if (direction === StrategyDirection.LONG) {
      return {
        ...base,
        note: 'Strategy is set to LONG only - only buy signals will be generated',
      };
    } else {
      return {
        ...base,
        note: 'Strategy is set to SHORT only - only sell signals will be generated',
      };
    }
  }

  private generatePineScriptTemplate(strategy: Strategy, useLimit: boolean): string {
    const symbol = `${strategy.asset}USDT`;
    const webhookSecret = process.env.WEBHOOK_SECRET || 'default_secret_123';
    const direction = strategy.direction || StrategyDirection.BOTH;

    const buyJson = useLimit
      ? `{"secret":"${webhookSecret}","strategyId":"${strategy.id}","symbol":"${symbol}","action":"buy","orderType":"limit","price":` + '{{close}}}'
      : `{"secret":"${webhookSecret}","strategyId":"${strategy.id}","symbol":"${symbol}","action":"buy","price":` + '{{close}}}';

    const sellJson = useLimit
      ? `{"secret":"${webhookSecret}","strategyId":"${strategy.id}","symbol":"${symbol}","action":"sell","orderType":"limit","price":` + '{{close}}}'
      : `{"secret":"${webhookSecret}","strategyId":"${strategy.id}","symbol":"${symbol}","action":"sell","price":` + '{{close}}}';

    const enableLongDefault = direction === StrategyDirection.BOTH || direction === StrategyDirection.LONG;
    const enableShortDefault = direction === StrategyDirection.BOTH || direction === StrategyDirection.SHORT;

    let strategyExecution = '';
    let visualization = '';

    if (enableLongDefault) {
      strategyExecution += `
if longCondition
    strategy.entry("Long", strategy.long, alert_message='${buyJson}')
`;
      visualization += `plotshape(longCondition, title="Buy Signal", location=location.belowbar, color=color.green, style=shape.triangleup, size=size.small)\n`;
    }

    if (enableShortDefault) {
      strategyExecution += `
if shortCondition
    strategy.entry("Short", strategy.short, alert_message='${sellJson}')
`;
      visualization += `plotshape(shortCondition, title="Sell Signal", location=location.abovebar, color=color.red, style=shape.triangledown, size=size.small)\n`;
    }

    return `//@version=5
strategy("${strategy.name}", overlay=true, default_qty_type=strategy.percent_of_equity, default_qty_value=100, process_orders_on_close=true)

// ============================================================================
// STRATEGY CONFIGURATION
// ID: ${strategy.id}
// Direction: ${direction}
// Order Type: ${useLimit ? 'LIMIT' : 'MARKET'}
// ============================================================================

enableLong = input.bool(${enableLongDefault}, "Enable Long Signals", group="Signals")
enableShort = input.bool(${enableShortDefault}, "Enable Short Signals", group="Signals")
onlyRealtime = input.bool(true, "Only execute in realtime", group="Execution")

// ============================================================================
// YOUR STRATEGY CONDITIONS HERE
// Replace with your own logic
// ============================================================================

canExecute = onlyRealtime ? (barstate.isconfirmed and barstate.isrealtime) : barstate.isconfirmed

longCondition = enableLong and canExecute and ta.crossover(ta.sma(close, 14), ta.sma(close, 28))
shortCondition = enableShort and canExecute and ta.crossunder(ta.sma(close, 14), ta.sma(close, 28))

// ============================================================================
// STRATEGY EXECUTION
// ============================================================================
${strategyExecution}
// ============================================================================
// VISUALIZATION
// ============================================================================

${visualization}
// ============================================================================
// ALERT CONFIGURATION
// 1. Add this strategy to your chart
// 2. Create alert: Condition = "${strategy.name}"
// 3. Webhook URL: YOUR_BACKEND_URL/api/webhooks/tradingview
// 4. Message: Leave EMPTY (uses alert_message from strategy)
// ============================================================================
`;
  }

  @Post()
  create(@Body() strategy: Partial<Strategy>) {
    return this.strategiesService.create(strategy);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() strategy: Partial<Strategy>) {
    return this.strategiesService.update(id, strategy);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.strategiesService.remove(id);
  }

  @Post(':id/pause')
  async pauseTrading(@Param('id') id: string) {
    const strategy = await this.strategiesService.update(id, { pauseNewOrders: true });
    return { success: true, message: 'Trading paused', strategy };
  }

  @Post(':id/resume')
  async resumeTrading(@Param('id') id: string) {
    const strategy = await this.strategiesService.update(id, { pauseNewOrders: false });
    return { success: true, message: 'Trading resumed', strategy };
  }

  @Post(':id/reset-single')
  async resetSingleMode(@Param('id') id: string) {
    const strategy = await this.strategiesService.update(id, { pauseNewOrders: false });
    return { success: true, message: 'Single mode reset - ready for new trade cycle', strategy };
  }

  @Post('pause-all')
  async pauseAllTrading() {
    const strategies = await this.strategiesService.findAll();
    let paused = 0;
    for (const strategy of strategies) {
      if (strategy.isActive && !strategy.pauseNewOrders) {
        await this.strategiesService.update(strategy.id, { pauseNewOrders: true });
        paused++;
      }
    }
    return { success: true, message: `Paused ${paused} strategies` };
  }

  @Post('resume-all')
  async resumeAllTrading() {
    const strategies = await this.strategiesService.findAll();
    let resumed = 0;
    for (const strategy of strategies) {
      if (strategy.isActive && strategy.pauseNewOrders) {
        await this.strategiesService.update(strategy.id, { pauseNewOrders: false });
        resumed++;
      }
    }
    return { success: true, message: `Resumed ${resumed} strategies` };
  }

  @Get(':id/open-orders')
  async getOpenOrders(@Param('id') id: string) {
    return this.strategiesService.getOpenOrders(id);
  }
}
