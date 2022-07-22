// npx ts-node ./src/demo/enqueueFileToUpload.ts
import { queueBroker } from '../utils/queueBroker';

const chunkId = process.argv[2];

const message = {
  chunkId,
  fields: {
    __pn_integration_version_major: '1',
    __pn_integration_version_minor: '8',
    __pn_chunk_id: chunkId,
    '__pn_chunk_1.8_id': chunkId,
  },
};

(async function () {
  await queueBroker.sendMessage('upload', message);
})();
