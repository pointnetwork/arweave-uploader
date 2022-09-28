import config from 'config';
import { ConsumeMessage } from 'amqplib';
import { getContent } from './utils/getContent';
import { queueBroker, QueueInfo } from './utils/queueBroker';
import { log } from './utils/logger';
import { safeStringify } from './utils/safeStringify';
import { getObject } from './utils/s3Downloader';
import {
  broadcastTx,
  bundleAndSignBundleData,
  createBundleData,
  getBalance,
  getPrice,
  reBundleData,
  signWithExistingSignature,
} from './arweaveTransport';
import { hashFn } from './utils/hashFn';
import {
  VERIFY_BUNDLED_TX,
  VERIFY_CHUNK_ID,
  VERIFY_CHUNK_ID_LONG,
} from './utils/queueNames';
import { fromMinutesToMilliseconds } from './utils/fromMinutesToMilliseconds';
import {
  addItem,
  getAllMemPoolItems,
  getItemsAge,
  itemsPoolLength,
} from './arweaveTransport/itemsMemPool';

const BUNDLE_SIZE = config.get('arweave_uploader.max_concurrency') as number;
const VERIFY_BUNDLED_TX_INTERVAL = config.get(
  'arweave_uploader.verify_bundled_tx_interval'
) as number;
const VERIFY_BUNDLED_CHUNK_IDS_INTERVAL = config.get(
  'arweave_uploader.verify_bundled_chunk_ids_interval'
) as number;

async function bundleItems(queueInfo) {
  if (itemsPoolLength() > 0) {
    let bundleTxId;
    const items = Object.entries(getAllMemPoolItems()).map(
      ([chunkId, content]: [string, any]) => ({ chunkId, ...content })
    );
    const dataItems = items.map((item: any) => {
      return item.signedDataItem;
    });
    const totalBundleSize = items.reduce((prev, { contentLength }) => {
      return prev + contentLength;
    }, 0);
    const chunkIds = items.map((item: any) => {
      return item.chunkId;
    });
    const fields = items.map((item) => item.fields);
    const signatures = items.map((item) => item.signedDataItem.signature);
    try {
      log.info(`Creating bundle for ${chunkIds.length} chunkIds`);
      const transaction = await bundleAndSignBundleData(dataItems);
      bundleTxId = transaction.id;
      await queueBroker.sendDelayedMessage(
        VERIFY_BUNDLED_TX,
        {
          txid: bundleTxId,
          createdAt: Date.now(),
          chunkIds,
          signatures,
          fields,
        },
        {
          ttl: fromMinutesToMilliseconds(VERIFY_BUNDLED_TX_INTERVAL),
        }
      );

      items.forEach(async (item: any) => {
        const { content } = item;
        await queueBroker.sendDelayedMessage(
          VERIFY_CHUNK_ID_LONG,
          { ...content, createdAt: Date.now() },
          {
            ttl: fromMinutesToMilliseconds(VERIFY_BUNDLED_CHUNK_IDS_INTERVAL),
          }
        );
      });

      await broadcastTx(transaction);

      items.forEach(async (item: any) => {
        const { channel, msg } = item;
        channel.ack(msg);
      });
    } catch (error: any) {
      if (
        error?.message.includes('Nodes rejected the TX headers') &&
        totalBundleSize
      ) {
        const balance = await getBalance();
        const price = await getPrice(totalBundleSize);
        if (balance.winston - price < 0) {
          log.fatal(
            `Not enough funds to upload bundle with id ${bundleTxId}. Will pause worker until new funds are loaded`
          );
          queueBroker.pause(queueInfo, {
            healthCheckFunc: async () => {
              try {
                const currentBalance = await getBalance();
                const currentPrice = await getPrice(totalBundleSize);
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
        items.forEach(async (item: any) => {
          const { channel, msg } = item;
          channel.nack(msg!, true);
        });
      }
      log.error(
        `Failed to upload bundle to arweave due to error: ${safeStringify(
          error?.message || error
        )} for : ${bundleTxId}`
      );
      items.forEach(async (item: any) => {
        const { channel, msg, content } = item;
        await queueBroker.sendDelayedMessage(VERIFY_CHUNK_ID, content, {
          ttl: fromMinutesToMilliseconds(
            config.get('arweave_uploader.requeue_after_error_time')
          ),
        });
        return channel.ack(msg!);
      });
    }
  }
}

let bundleTimeout;

export async function verifyBundleState(queueInfo) {
  const bundleTimeoutMs = fromMinutesToMilliseconds(
    config.get('arweave_uploader.bundle_timeout')
  );
  if (itemsPoolLength() >= BUNDLE_SIZE || getItemsAge() > bundleTimeoutMs) {
    if (bundleTimeout) {
      clearTimeout(bundleTimeout);
    }
    await bundleItems(queueInfo);
  } else if (!bundleTimeout)
    bundleTimeout = setTimeout(() => {
      bundleTimeout = null;
      verifyBundleState(queueInfo);
    }, bundleTimeoutMs - getItemsAge());
}

export function arweaveUploaderFactory(queueInfo: QueueInfo) {
  const { channel } = queueInfo;
  return async function arweaveUploader(msg: ConsumeMessage | null) {
    const content = getContent(msg!.content);
    const { chunkId, fields } = content;
    try {
      const file = await getObject(chunkId);
      const contentLength = file.ContentLength;
      const calculatedChunkId = hashFn(file.Body as Buffer).toString('hex');
      if (calculatedChunkId !== chunkId) {
        log.fatal(
          `Integrity fail for ${chunkId}, actual chunkId is ${calculatedChunkId}. It could happen because of legacy files using a different kind of id`
        );
        return channel.ack(msg!);
      }
      const signedDataItem = await createBundleData(file.Body, fields);
      const added = addItem(chunkId, {
        signedDataItem,
        channel,
        msg,
        content,
        contentLength,
        fields,
      });
      if (!added) {
        log.info(`Skipping repetead chunkId:${chunkId} already in bundle`);
        return channel.ack(msg!);
      }
      await verifyBundleState(queueInfo);
      return;
    } catch (error: any) {
      if (error?.code === 'NoSuchKey') {
        log.fatal(`ChunkId not found in S3 ${chunkId} message will be ack`);
        return channel.ack(msg!);
      }
      log.fatal(
        `Unexpected error for ${chunkId} message will be reenque for verifyChunkId`
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

export function arweaveReUploaderFactory(queueInfo: any) {
  const { channel } = queueInfo;
  return async function arweaveReUploader(msg: ConsumeMessage | null) {
    const content = getContent(msg!.content);
    const { txid, chunkIds, signatures, fields } = content;
    try {
      const dataItems = await Promise.all(
        chunkIds.map(async (chunkId, ix) => {
          const file = await getObject(chunkId);
          const dataItem = await createBundleData(file.Body, fields[ix], false);
          return signWithExistingSignature(dataItem, signatures[ix]);
        })
      );
      const bundle = await reBundleData(dataItems);
      await queueBroker.sendDelayedMessage(
        VERIFY_BUNDLED_TX,
        { ...content, createdAt: Date.now() },
        {
          ttl: fromMinutesToMilliseconds(VERIFY_BUNDLED_TX_INTERVAL),
        }
      );
      await broadcastTx(txid, bundle.getRaw());
      log.info(`Bundle was re-uploaded for txid: ${txid}`);
      channel.ack(msg);
    } catch (e) {
      log.error(
        `There was an error when trying to reupload txid ${txid}. Will verify again`
      );
      await queueBroker.sendDelayedMessage(
        VERIFY_BUNDLED_TX,
        { ...content, createdAt: Date.now() },
        {
          ttl: 0,
        }
      );
      channel.ack(msg);
    }
  };
}
