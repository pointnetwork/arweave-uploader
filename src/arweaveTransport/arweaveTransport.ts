import config from 'config';
import { bundleAndSignData, createData, signers } from 'arbundles';
import { arweave } from './arweave';
import { log } from '../utils/logger';

export const DEFAULT_RETRY_POLICY = {
  retries: 5,
  minTimeout: 3000,
};

const key = JSON.parse(config.get('arweave.key'));

const { ArweaveSigner } = signers;

const signer = new ArweaveSigner(key);

/*
let data = fs.readFileSync('path/to/file.pdf'); // get the same data
let resumeTxId = 'mytxid' // a transaction id for a mined transaction that didn't complete the upload.

let uploader = await arweave.transactions.getUploader(resumeTxId, data);
while (!uploader.isComplete) {
  await uploader.uploadChunk();
  console.log(`${uploader.pctComplete}% complete`);
}
*/

export async function broadcastTx(transaction, data: Buffer | null = null) {
  let uploader;
  if (data) {
    uploader = await arweave.transactions.getUploader(transaction, data);
  } else {
    uploader = await arweave.transactions.getUploader(transaction);
  }
  while (!uploader.isComplete) {
    await uploader.uploadChunk();
    log.info(
      `lastResponseStatus for txid: ${transaction.id || transaction}: ${
        uploader.lastResponseStatus
      }`
    );
    log.info(
      `${uploader.pctComplete}% complete for txid: ${
        transaction.id || transaction
      }  ${uploader.uploadedChunks}/${uploader.totalChunks}`
    );
  }
  return transaction;
}

export function formatTags(tags) {
  return Object.entries(tags).map(([name, value]) => ({ name, value })) as {
    name: string;
    value: string;
  }[];
}

export async function createBundleData(data, tags, sign = true) {
  const dataItem = createData(data, signer, {
    tags: formatTags(tags),
  });
  if (sign) {
    await dataItem.sign(signer);
  }
  return dataItem;
}

export async function reBundleData(data) {
  return bundleAndSignData(data, signer);
}

export async function bundleAndSignBundleData(data) {
  const bundle = await bundleAndSignData(data, signer);
  const tx = await bundle.toTransaction({}, arweave, key);
  await arweave.transactions.sign(tx, key);
  return tx;
}

export async function signTx(data, tags) {
  const transaction = await arweave.createTransaction({ data }, key);
  for (const k in tags || {}) {
    if (Object.prototype.hasOwnProperty.call(tags, k)) {
      const v = tags[k];
      transaction.addTag(k, v);
    }
  }
  await arweave.transactions.sign(transaction, key);
  return transaction;
}

export async function getBalance() {
  const publicAddress = await arweave.wallets.jwkToAddress(key);
  const balance = await arweave.wallets.getBalance(publicAddress);
  return { winston: balance, ar: arweave.ar.winstonToAr(balance) };
}

export async function getPrice(size: number) {
  return arweave.transactions.getPrice(size);
}

export async function sendChunk({ chunkId, fileContent, tags }) {
  const transaction = await signTx(fileContent, tags);
  const { id: txid } = await broadcastTx(transaction);
  log.info(`Broadcasted txid: ${txid} for chunkId: ${chunkId}`);
  return { txid };
}
