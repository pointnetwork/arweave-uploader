import config from 'config';
import axios from 'axios';
import {
  arweaveReUploaderFactory,
  arweaveUploaderFactory,
} from './arweaveUploader';
import { queueBroker } from './utils/queueBroker';
import './healthServer';
import { log } from './utils/logger';
import { UPLOAD_TO_ARWEAVE, REUPLOAD_TO_ARWEAVE } from './utils/queueNames';
import { safeStringify } from './utils/safeStringify';
import { fromMinutesToMilliseconds } from './utils/fromMinutesToMilliseconds';

export async function main() {
  log.info('Subscribing to upload queue');
  await queueBroker.subscribe(UPLOAD_TO_ARWEAVE, {
    handlerFactory: arweaveUploaderFactory,
    maxConcurrency: config.get('arweave_uploader.max_concurrency'),
  });
  await queueBroker.subscribeDelayed(REUPLOAD_TO_ARWEAVE, {
    handlerFactory: arweaveReUploaderFactory,
    maxConcurrency: 1,
  });
}

process.on('uncaughtException', function (error: any) {
  if (error?.code !== 'ENETDOWN') {
    log.error('Logger error connection has failed. It will exit the process');
    process.exit(1);
  } else {
    log.error(`Uncaught error: ${safeStringify(error)}`);
    process.exit(1);
  }
});

function keepAppAlive() {
  const appName = process.env.HEROKU_APP_NAME;
  if (appName) {
    const interval = fromMinutesToMilliseconds(
      config.get('keep_alive_interval')
    );
    const url = `https://${appName}.herokuapp.com/health`;
    setTimeout(async () => {
      try {
        await axios.get(url);
      } catch {
        // do nothing, it will try again
      }
    }, interval);
    keepAppAlive();
  }
}

keepAppAlive();
