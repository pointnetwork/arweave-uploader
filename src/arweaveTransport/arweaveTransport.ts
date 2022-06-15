import config from 'config';
import { arweave } from './arweave';
import { log } from '../utils/logger';

export const DEFAULT_RETRY_POLICY = {
  retries: 5,
  minTimeout: 3000,
};

const key = JSON.parse(config.get('arweave.key'));

async function signTx(data, tags) {
  const transaction = await arweave.createTransaction({ data }, key);
  for (const k in tags) {
    if (Object.prototype.hasOwnProperty.call(tags, k)) {
      const v = tags[k];
      transaction.addTag(k, v);
    }
  }
  await arweave.transactions.sign(transaction, key);
  return transaction;
}

async function broadcastTx(transaction) {
  const uploader = await arweave.transactions.getUploader(transaction);
  while (!uploader.isComplete) {
    await uploader.uploadChunk();
  }
  return transaction;
}

export async function sendChunk({ chunkId, fileContent, tags }) {
  const transaction = await signTx(fileContent, tags);
  log.info(
    `For chunkId: ${chunkId} transaction ${transaction.id} has been signed`
  );
  const { id: txid } = await broadcastTx(transaction);
  log.info(
    `For chunkId: ${chunkId} transaction ${transaction.id} has been broadcasted`
  );
  return { txid };
}
