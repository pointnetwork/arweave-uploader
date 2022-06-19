import { arweaveUploader } from './arweaveUploader';
import { queueBroker } from './utils/queueBroker';
import './healthServer';
import { log } from './utils/logger';

export async function main() {
  log.info('Subscribing to upload queue');
  await queueBroker.subscribe('upload', arweaveUploader);
}
