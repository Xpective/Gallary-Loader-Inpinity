import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { pipeline } from 'node:stream';
import { promisify } from 'node:util';

const { R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
if (!R2_ENDPOINT || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  console.error("Bitte R2_ENDPOINT / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY exportieren.");
  process.exit(1);
}

const key = process.argv[2];
if (!key) { console.error("Usage: node get.mjs <key>"); process.exit(1); }

const s3 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  forcePathStyle: true
});

const res = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
await promisify(pipeline)(res.Body, process.stdout);