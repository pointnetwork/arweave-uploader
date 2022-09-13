// to run this script you should set a file with s3 and queue credentials
// NODE_ENV='local_test' npx ts-node src/scripts/verifyAllFilesFromS3.ts
// It will retrieve all objects from s3 and push them to queue to be verified
import { ObjectList } from 'aws-sdk/clients/s3';
import { listObjects } from '../utils/s3Downloader';
import { queueBroker } from '../utils/queueBroker';

function createMessage(chunkId: string) {
  return {
    chunkId,
    fields: {
      __pn_integration_version_major: '1',
      __pn_integration_version_minor: '8',
      __pn_chunk_id: chunkId,
      '__pn_chunk_1.8_id': chunkId,
    },
  };
}

async function pushToVerifierQueue(s3Objects: ObjectList) {
  for (const { Key } of s3Objects) {
    const isValidChunkId = Key?.length === 64;
    if (isValidChunkId) {
      await queueBroker.sendDelayedMessage(
        'verifyChunkId',
        createMessage(Key),
        { ttl: 0 }
      );
      console.log(`Chunkid: ${Key} was enqueue to be verified`);
    } else {
      console.log(`Object with: ${Key} is not valid chunkId, skipping it`);
    }
  }
}

async function getAndPushObject(nextMarker?: string) {
  const { IsTruncated, NextMarker, Contents } = await listObjects({
    marker: nextMarker,
  });
  await pushToVerifierQueue(Contents!);
  if (IsTruncated) {
    return getAndPushObject(NextMarker);
  }
}

getAndPushObject();
