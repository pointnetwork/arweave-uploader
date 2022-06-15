import Arweave from 'arweave';
import config from 'config';
import TestWeave from 'testweave-sdk';
import { log } from '../utils/logger';
import { safeStringify } from '../utils/safeStringify';

const key = JSON.parse(config.get('arweave.key'));

const arweaveClient = Arweave.init({
  ...config.get('arweave'),
  timeout: 20000,
  logging: true,
});

// eslint-disable-next-line import/no-mutable-exports
let arweave;

if (parseInt(config.get('testmode'), 10)) {
  let testWeave;
  arweave = new Proxy(
    {},
    {
      get: (_, prop) =>
        prop !== 'transactions'
          ? arweaveClient[prop]
          : new Proxy(
              {},
              {
                get: (__, txProp) =>
                  txProp !== 'getUploader'
                    ? arweaveClient[prop][txProp]
                    : async (upload, data) => {
                        const uploader = await arweaveClient[prop][txProp](
                          upload,
                          data
                        );
                        return new Proxy(
                          {},
                          {
                            get: (___, uploaderProp) =>
                              uploaderProp !== 'uploadChunk'
                                ? uploader[uploaderProp]
                                : async (...args) => {
                                    try {
                                      log.info('Uploading chunk in test mode');
                                      if (!testWeave) {
                                        log.info('Initializing Testweave');
                                        testWeave = await TestWeave.init(
                                          arweave
                                        );
                                        // eslint-disable-next-line no-underscore-dangle
                                        testWeave._rootJWK = key;
                                      }
                                      const result = await uploader[
                                        uploaderProp
                                      ](...args);
                                      await testWeave.mine();
                                      return result;
                                    } catch (e: any) {
                                      log.fatal(
                                        `Message: ${
                                          e.message
                                        }, stack: ${safeStringify(e.stack)}`
                                      );
                                      throw e;
                                    }
                                  },
                          }
                        );
                      },
              }
            ),
    }
  );
} else {
  arweave = arweaveClient;
}

arweave.network
  .getInfo()
  .then((info) => log.info(`Arweave network info: ${safeStringify(info)}`));

export { arweave };
