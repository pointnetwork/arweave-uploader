import {
  Connection,
  Channel,
  ConsumeMessage,
  connect,
  Options,
  Replies,
} from 'amqplib';
import config from 'config';
import { log } from './logger';
import { safeStringify } from './safeStringify';

const MAX_CONCURRENCY = config.get('max_concurrency');

const queueCfg: { url: string } | undefined = config.get('queue');
interface QueueBrokerOptions {
  url?: string;
}

const defaultOptions = { url: 'amqp://localhost' };

let resolver;

export class QueueBroker {
  connection?: Connection;

  rxChannel?: Channel;

  txChannel?: Channel;

  ready = new Promise((res) => {
    resolver = res;
  });

  constructor(private options: QueueBrokerOptions = defaultOptions) {}

  async connect() {
    const queueUrl = this.options.url as string;
    this.connection = await connect(queueUrl);
    log.info('Connected to queue');
    this.rxChannel = await this.connection.createChannel();
    this.txChannel = await this.connection.createChannel();
    this.rxChannel.prefetch(MAX_CONCURRENCY);
    this.txChannel.prefetch(MAX_CONCURRENCY);
    resolver();
  }

  async ack(msg) {
    return this.rxChannel?.ack(msg);
  }

  async nack(msg, requeue: boolean) {
    return this.rxChannel?.nack(msg, false, requeue);
  }

  async subscribe(
    queueName: string,
    handler: (msg: ConsumeMessage | null) => void
  ) {
    await this.ready;
    log.info(`Subscribing to queue ${queueName}`);
    await this.rxChannel?.assertQueue(queueName);
    await this.rxChannel?.consume(queueName, handler);
  }

  async subscribeDelayed(
    queueName: string,
    handler: (msg: ConsumeMessage | null) => void
  ) {
    await this.ready;
    log.info(`Subscribing to delayed queue ${queueName}`);
    const exchangeDLX = `${queueName}ExDLX`;
    const routingKeyDLX = `${queueName}RoutingKeyDLX`;
    const queueDLX = `${queueName}QueueDLX`;
    await this.rxChannel?.assertExchange(exchangeDLX, 'direct', {
      durable: true,
    });
    const queueResult = (await this.rxChannel?.assertQueue(queueDLX, {
      exclusive: false,
    })) as Replies.AssertQueue;

    await this.rxChannel?.bindQueue(
      queueResult.queue,
      exchangeDLX,
      routingKeyDLX
    );
    await this.rxChannel?.consume(queueResult.queue, handler);
  }

  async sendDelayedMessage(
    queueName: string,
    content: Record<any, any>,
    delay: number
  ) {
    const exchange = `${queueName}Ex`;
    const queue = `${queueName}Queue`;
    const exchangeDLX = `${queueName}ExDLX`;
    const routingKeyDLX = `${queueName}RoutingKeyDLX`;
    await this.txChannel?.assertExchange(exchange, 'direct', { durable: true });
    const queueResult = (await this.txChannel?.assertQueue(queue, {
      exclusive: false,
      deadLetterExchange: exchangeDLX,
      deadLetterRoutingKey: routingKeyDLX,
    })) as Replies.AssertQueue;
    await this.txChannel?.bindQueue(queueResult.queue, exchange, '');
    await this.txChannel?.sendToQueue(
      queueResult.queue,
      Buffer.from(JSON.stringify(content)),
      {
        expiration: delay,
      }
    );
  }

  async sendMessage(
    queueName: string,
    content: Record<any, any>,
    options?: Options.Publish
  ) {
    await this.ready;
    log.info(
      `Sending message to ${queueName} with content ${safeStringify(content)}`
    );
    return this.txChannel?.sendToQueue(
      queueName,
      Buffer.from(JSON.stringify(content)),
      options
    );
  }
}

export const queueBroker = queueCfg
  ? new QueueBroker(queueCfg)
  : new QueueBroker();

async function connectQueue() {
  try {
    await queueBroker.connect();
  } catch (error: any) {
    log.error('Cannot connect to queue, check connectivity. Exiting process');
    process.exit(1);
  }
}

connectQueue();
