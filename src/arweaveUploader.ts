import config from 'config';
import { ConsumeMessage } from 'amqplib';
import { getContent } from './utils/getContent';
import { queueBroker, QueueInfo } from './utils/queueBroker';
import { log } from './utils/logger';
import { safeStringify } from './utils/safeStringify';
import { getObject } from './utils/s3Downloader';
import { sendChunk } from './arweaveTransport';
import { hashFn } from './utils/hashFn';
import { VERIFY_ARWEAVE_TX, VERIFY_CHUNK_ID } from './utils/queueNames';
import { fromMinutesToMilliseconds } from './utils/fromMinutesToMilliseconds';

export function arweaveUploaderFactory({ channel }: QueueInfo) {
  return async function arweaveUploader(msg: ConsumeMessage | null) {
    const content = getContent(msg!.content);
    const { chunkId, fields } = content;
    try {
      const file = await getObject(chunkId);
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
      log.error(
        `Failed to upload to arweave due to error: ${safeStringify(
          error
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
