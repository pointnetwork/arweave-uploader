import { Endpoint, S3 } from 'aws-sdk';
import config from 'config';

const s3 = new S3({
  endpoint: new Endpoint(
    `${config.get('s3.protocol')}://${config.get('s3.host')}:${config.get(
      's3.port'
    )}`
  ),
  accessKeyId: config.get('s3.key'),
  secretAccessKey: config.get('s3.secret'),
  computeChecksums: true,
});

export async function getObject(key: string, bucket?: string) {
  return s3
    .getObject({
      Bucket: bucket || config.get('s3.bucket'),
      Key: key,
    })
    .promise();
}
