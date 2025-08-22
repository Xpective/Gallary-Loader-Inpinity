import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const { R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
if (!R2_ENDPOINT || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  console.error("Bitte R2_ENDPOINT / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY exportieren.");
  process.exit(1);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  forcePathStyle: true
});

const Prefix = process.argv[2] || '';
const MaxKeys = Number(process.argv[3] || 20);
const out = await s3.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix, MaxKeys }));
for (const o of out.Contents || []) console.log(o.Key || '');