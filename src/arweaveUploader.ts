import { getContent } from './utils/getContent';
import { queueBroker } from './utils/queueBroker';
import { log } from './utils/logger';
import { safeStringify } from './utils/safeStringify';
import { getObject } from './utils/s3Downloader';
import { sendChunk } from './arweaveTransport';

export async function arweaveUploader(msg) {
  const content = getContent(msg.content);
  const { chunkId, fields } = content;
  log.info(
    `Received upload request for ChunkId ${chunkId} with fields ${safeStringify(
      fields
    )}`
  );
  try {
    const file = await getObject(chunkId);
    const { txid } = await sendChunk({
      chunkId,
      fileContent: file.Body,
      tags: fields,
    });
    log.info(
      `ChunkId ${chunkId} was signed and broadcasted with arweave tx: ${txid}`
    );
    await queueBroker.ack(msg);
    await queueBroker.sendMessage('verifyArweaveTx', { ...content, txid });
  } catch (error) {
    log.error(
      `ChunkId ${chunkId} failed to upload to arweave due to error: ${error}`
    );
    await queueBroker.nack(msg, true);
  }
}
