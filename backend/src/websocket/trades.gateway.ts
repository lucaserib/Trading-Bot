import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TradesService } from '../trades/trades.service';

@WebSocketGateway({
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  namespace: '/trades',
})
export class TradesGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(TradesGateway.name);
  private connectedClients = 0;

  constructor(private readonly tradesService: TradesService) {}

  afterInit() {
    this.logger.log('WebSocket Gateway initialized');
  }

  handleConnection(client: Socket) {
    this.connectedClients++;
    this.logger.log(`Client connected: ${client.id} (Total: ${this.connectedClients})`);

    this.sendStatsToClient(client);
  }

  handleDisconnect(client: Socket) {
    this.connectedClients--;
    this.logger.log(`Client disconnected: ${client.id} (Total: ${this.connectedClients})`);
  }

  private async sendStatsToClient(client: Socket) {
    try {
      const stats = await this.tradesService.getStats();
      client.emit('stats', stats);
    } catch (error) {
      this.logger.error(`Failed to send stats to client: ${error.message}`);
    }
  }

  @Cron(CronExpression.EVERY_5_SECONDS)
  async broadcastStats() {
    if (this.connectedClients === 0) return;

    try {
      const stats = await this.tradesService.getStats();
      this.server.emit('stats', stats);
      this.logger.debug(`Broadcasted stats to ${this.connectedClients} clients`);
    } catch (error) {
      this.logger.error(`Failed to broadcast stats: ${error.message}`);
    }
  }

  emitTradeCreated(trade: any) {
    this.server.emit('trade:created', trade);
    this.logger.debug(`Emitted trade:created for ${trade.symbol}`);
  }

  emitTradeUpdated(trade: any) {
    this.server.emit('trade:updated', trade);
    this.logger.debug(`Emitted trade:updated for ${trade.symbol}`);
  }

  emitTradeClosed(trade: any) {
    this.server.emit('trade:closed', trade);
    this.logger.debug(`Emitted trade:closed for ${trade.symbol}`);
  }

  emitSyncCompleted(result: { synced: number; closed: number; imported: number }) {
    this.server.emit('sync:completed', result);
    this.logger.debug(`Emitted sync:completed`);
  }

  getConnectedClientsCount(): number {
    return this.connectedClients;
  }
}
