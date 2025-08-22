import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { setGlobalDispatcher, Agent, request } from "undici";
import pLimit from "p-limit";

setGlobalDispatcher(new Agent({ connections: 64 }));

// ENV erwartet:
// R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
// CID_JSON, CID_PNG, CID_MP4_LOW, CID_MP4_MED, CID_MP4_HIGH
// GW_LIST (comma) z.B. "https://ipfs.inpinity.online,https://cloudflare-ipfs.com,https://ipfs.io"
// CONCURRENCY (default 12)

const {
  R2_ENDPOINT,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  CID_JSON,
  CID_PNG,
  CID_MP4_LOW,
  CID_MP4_MED,
  CID_MP4_HIGH,
  GW_LIST = "https://ipfs.inpinity.online,https://cloudflare-ipfs.com,https://ipfs.io",
} = process.env;

if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
  console.error("Bitte R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET setzen.");
  process.exit(1);
}

const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

const gateways = GW_LIST.split(",").map(s => s.trim()).filter(Boolean);
const limit = pLimit(Number(process.env.CONCURRENCY || 12));

async function headR2(key) {
  try { await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key })); return true; }
  catch { return false; }
}

async function fetchFromGateways(path, accept) {
  let lastErr;
  for (const gw of gateways) {
    const url = `${gw.replace(/\/+$/, "")}/ipfs/${path}`;
    try {
      const { statusCode, body } = await request(url, { method: "GET", headers: accept ? { accept } : {} });
      if (statusCode >= 200 && statusCode < 300) return { body, url };
      lastErr = new Error(`HTTP ${statusCode} @ ${url}`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("Alle Gateways fehlgeschlagen");
}

async function putR2Stream(key, stream, contentType) {
  const uploader = new Upload({
    client: s3,
    params: { Bucket: R2_BUCKET, Key: key, Body: stream, ContentType: contentType },
    queueSize: 4,
    partSize: 8 * 1024 * 1024,
  });
  await uploader.done();
}

async function ingestRange({ from = 0, to = 9999, type = "json", tier = "med", skipExisting = true }) {
  const jobs = [];
  for (let i = from; i <= to; i++) {
    jobs.push(limit(async () => {
      const idx = i;
      let cid, key, path, ctype, accept;

      if (type === "json") {
        if (!CID_JSON) throw new Error("CID_JSON nicht gesetzt");
        cid = CID_JSON; key = `meta/${idx}.json`; path = `${cid}/${idx}.json`;
        ctype = "application/json"; accept = "application/json";
      } else if (type === "png") {
        if (!CID_PNG) throw new Error("CID_PNG nicht gesetzt");
        cid = CID_PNG; key = `image/${idx}.png`; path = `${cid}/${idx}.png`;
        ctype = "image/png"; accept = "image/*";
      } else if (type === "mp4") {
        const map = { low: CID_MP4_LOW, med: CID_MP4_MED, high: CID_MP4_HIGH };
        cid = map[tier];
        if (!cid) throw new Error(`CID_MP4_${tier.toUpperCase()} nicht gesetzt`);
        key = `video/${tier}/${idx}.mp4`; path = `${cid}/${idx}.mp4`;
        ctype = "video/mp4"; accept = "video/*";
      } else {
        throw new Error(`Unbekannter type: ${type}`);
      }

      if (skipExisting && await headR2(key)) { process.stdout.write(`↷ skip ${key}\n`); return; }

      try {
        const { body } = await fetchFromGateways(path, accept);
        await putR2Stream(key, body, ctype);
        process.stdout.write(`✓ put ${key}\n`);
      } catch (e) {
        process.stdout.write(`✗ fail ${key} – ${e.message}\n`);
      }
    }));
  }
  await Promise.all(jobs);
}

function parseArgs() {
  const a = Object.fromEntries(process.argv.slice(2).map(s=>{
    const [k,v] = s.split("="); return [k.replace(/^--/,""), v ?? "true"];
  }));
  return {
    from: Number(a.from ?? 0),
    to: Number(a.to ?? 9999),
    type: String(a.type ?? "json"),     // "json" | "png" | "mp4"
    tier: String(a.tier ?? "med"),      // "low" | "med" | "high"
    skipExisting: a.skipExisting !== "false",
  };
}

(async ()=>{
  try {
    const opts = parseArgs();
    console.log("Ingest startet mit Optionen:", opts);
    await ingestRange(opts);
    console.log("Fertig.");
  } catch (e) { console.error("Fehler:", e); process.exit(1); }
})();