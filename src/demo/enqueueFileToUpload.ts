// npx ts-node ./src/demo/enqueueFileToUpload.ts
import { queueBroker } from '../utils/queueBroker';

const message = {
  chunkId: '9ab8ac8830aaa361a9e3efe6b42ea52a1009080056849ef278f70d040ed8a10d',
  fields: {
    __pn_integration_version_major: '1',
    __pn_integration_version_minor: '8',
    __pn_chunk_id:
      '9ab8ac8830aaa361a9e3efe6b42ea52a1009080056849ef278f70d040ed8a10d',
    '__pn_chunk_1.8_id':
      '9ab8ac8830aaa361a9e3efe6b42ea52a1009080056849ef278f70d040ed8a10d',
  },
};

(async function () {
  await queueBroker.sendMessage('upload', message);
})();
