import config from 'config';
import { getContent } from './utils/getContent';
import { queueBroker } from './utils/queueBroker';
import { log } from './utils/logger';
import { safeStringify } from './utils/safeStringify';
import { getObject } from './utils/s3Downloader';
import { sendChunk } from './arweaveTransport';
import { hashFn } from './utils/hashFn';
import { getRandomTimeInMinutes } from './utils/getRandomTimeInMinutes';
import { VERIFY_CHUNK_ID } from './utils/queueNames';

const SEND_IMMEDIATELY = 0;
const ARWEAVE_UPLOAD_MIN_RETRY_TIME = config.get(
  'arweave_upload_min_retry_time'
);
const ARWEAVE_UPLOAD_MAX_RETRY_TIME = config.get(
  'arweave_upload_max_retry_time'
);

export async function arweaveUploader(msg) {
  const content = getContent(msg.content);
  const { chunkId, fields } = content;
  try {
    const file = await getObject(chunkId);
    const calculatedChunkId = hashFn(file.Body as Buffer).toString('hex');
    if (calculatedChunkId !== chunkId) {
      log.fatal(
        `Integrity fail for ${chunkId}, actual chunkId is ${calculatedChunkId}. It could happen because of legacy files using a different kind of id`
      );
      return queueBroker.ack(msg);
    }
    const { txid } = await sendChunk({
      chunkId,
      fileContent: file.Body,
      tags: fields,
    });
    log.info(`Arweave txid: ${txid} created for chunkId: ${chunkId}`);
    await queueBroker.sendDelayedMessage(
      VERIFY_CHUNK_ID,
      content,
      SEND_IMMEDIATELY
    );
    await queueBroker.ack(msg);
  } catch (error: any) {
    if (error?.code === 'NoSuchKey') {
      log.fatal(`ChunkId not found in S3 ${chunkId} message will be ack`);
      return queueBroker.ack(msg);
    }
    log.error(
      `Failed to upload to arweave due to error: ${safeStringify(
        error
      )} for chunkId: ${chunkId}`
    );
    await queueBroker.sendDelayedMessage(
      VERIFY_CHUNK_ID,
      content,
      getRandomTimeInMinutes(
        ARWEAVE_UPLOAD_MIN_RETRY_TIME,
        ARWEAVE_UPLOAD_MAX_RETRY_TIME
      )
    );
    return queueBroker.ack(msg);
  }
}
