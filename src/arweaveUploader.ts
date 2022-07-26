import config from 'config';
import { ConsumeMessage } from 'amqplib';
import { getContent } from './utils/getContent';
import { queueBroker, QueueInfo } from './utils/queueBroker';
import { log } from './utils/logger';
import { safeStringify } from './utils/safeStringify';
import { getObject } from './utils/s3Downloader';
import { getBalance, getPrice, sendChunk } from './arweaveTransport';
import { hashFn } from './utils/hashFn';
import { VERIFY_ARWEAVE_TX, VERIFY_CHUNK_ID } from './utils/queueNames';
import { fromMinutesToMilliseconds } from './utils/fromMinutesToMilliseconds';

export function arweaveUploaderFactory(queueInfo: QueueInfo) {
  const { channel } = queueInfo;
  return async function arweaveUploader(msg: ConsumeMessage | null) {
    const content = getContent(msg!.content);
    const { chunkId, fields } = content;
    let contentLength;
    try {
      const file = await getObject(chunkId);
      contentLength = file.ContentLength;
      const calculatedChunkId = hashFn(file.Body as Buffer).toString('hex');
      if (calculatedChunkId !== chunkId) {
        log.fatal(
          `Integrity fail for ${chunkId}, actual chunkId is ${calculatedChunkId}. It could happen because of legacy files using a different kind of id`
        );
        return channel.ack(msg!);
      }
      const { txid } = await sendChunk({
        chunkId,
        fileContent: file.Body,
        tags: fields,
      });
      log.info(`Arweave txid: ${txid} created for chunkId: ${chunkId}`);
      await queueBroker.sendDelayedMessage(
        VERIFY_ARWEAVE_TX,
        { ...content, createdAt: Date.now(), txid },
        {
          ttl: fromMinutesToMilliseconds(
            config.get('arweave_uploader.check_tx_delay')
          ),
        }
      );
      channel.ack(msg!);
    } catch (error: any) {
      if (error?.code === 'NoSuchKey') {
        log.fatal(`ChunkId not found in S3 ${chunkId} message will be ack`);
        return channel.ack(msg!);
      }
      if (
        error?.message.includes('Nodes rejected the TX headers') &&
        contentLength
      ) {
        const balance = await getBalance();
        const price = await getPrice(contentLength);
        if (balance.winston - price < 0) {
          log.fatal(
            `Not enough funds to upload chunkId: ${chunkId}. Will pause worker until new funds are loaded`
          );
          queueBroker.pause(queueInfo, {
            healthCheckFunc: async () => {
              try {
                const currentBalance = await getBalance();
                const currentPrice = await getPrice(contentLength);
                if (currentBalance.winston - currentPrice > 0) {
                  log.info(
                    `Healthcheck has succeed for queue ${queueInfo.subscription?.name}. New funds has been loaded. Will resume worker.`
                  );
                  queueBroker.resume(queueInfo);
                  return true;
                }
                log.fatal(
                  `Healthcheck to check balance has failed because funds are not enough yet. Current balance is ${currentBalance.ar}ar`
                );
                return false;
              } catch (healthCheckError: any) {
                log.error(
                  `Healthcheck to check balance has failed due to error: ${safeStringify(
                    healthCheckError
                  )}`
                );
                return false;
              }
            },
            healthCheckInterval: config.get(
              'arweave_uploader.health_check_interval'
            ),
          });
        }
        return channel.nack(msg!, true);
      }
      log.error(
        `Failed to upload to arweave due to error: ${safeStringify(
          error?.message || error
        )} for chunkId: ${chunkId}`
      );
      await queueBroker.sendDelayedMessage(VERIFY_CHUNK_ID, content, {
        ttl: fromMinutesToMilliseconds(
          config.get('arweave_uploader.requeue_after_error_time')
        ),
      });
      return channel.ack(msg!);
    }
  };
}
