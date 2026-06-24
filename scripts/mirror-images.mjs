import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const HTML_PATH = path.join(ROOT, "index.html");
const IMAGES_DIR = path.join(ROOT, "images");
const MIRROR_BASE = "https://angusyeet.com/tsang-tsou-choi-catalog/";
const TAKEDOWN_URL =
  "https://github.com/ayip001/tsang-tsou-choi-catalog/issues/new?title=Takedown%20request";

const HOST_PREFIXES = new Map([
  ["res.cloudinary.com", "mplus"],
  ["lh3.googleusercontent.com", "google-arts"],
  ["upload.wikimedia.org", "wikimedia"],
  ["static-assets.artlogic.net", "ota"],
  ["sothebys-com.brightspotcdn.com", "sothebys"],
  ["www.christies.com", "christies"],
  ["learning.hku.hk", "hku-teaching"],
  ["static.wixstatic.com", "hku-museum"],
  ["www.hkwl.org", "hkwalker"],
]);

const MIME_EXTENSIONS = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/avif", "avif"],
]);

function splitLinks(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function parseCatalog(html) {
  const match = html.match(
    /const ROWS_TSV = String\.raw`([\s\S]*?)`;\n\nconst headers/,
  );
  if (!match) throw new Error("Could not find ROWS_TSV in index.html");

  const lines = match[1].trim().split("\n");
  const headers = lines[0].split("\t");
  const rows = lines.slice(1).map((line) => {
    const cells = line.split("\t");
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] || ""]));
  });
  return { match, headers, rows };
}

function sniffMime(buffer, responseType) {
  const type = (responseType || "").split(";")[0].trim().toLowerCase();
  if (MIME_EXTENSIONS.has(type)) return type;
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buffer.subarray(4, 12).toString("ascii").includes("ftypavif")) return "image/avif";
  throw new Error(`Response was not a recognized image (${responseType || "no content type"})`);
}

async function download(url, destinationBase) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
          "user-agent": "Tsang-Tsou-Choi-Catalog-Mirror/1.0 (+https://github.com/ayip001/tsang-tsou-choi-catalog)",
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const mimeType = sniffMime(buffer, response.headers.get("content-type"));
      const extension = MIME_EXTENSIONS.get(mimeType);
      const finalPath = `${destinationBase}.${extension}`;
      const tempPath = `${finalPath}.part`;
      await writeFile(tempPath, buffer);
      await rename(tempPath, finalPath);
      return {
        finalPath,
        mimeType,
        bytes: buffer.length,
        sha256: createHash("sha256").update(buffer).digest("hex"),
      };
    } catch (error) {
      lastError = error;
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 1_500));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`Failed to download ${url}: ${lastError?.message || lastError}`);
}

function updateHtml(html, mirroredByUrl) {
  const mirrorObject = Object.fromEntries(mirroredByUrl);
  const mirrorDeclaration = `const MIRRORED_IMAGES = ${JSON.stringify(mirrorObject, null, 2)};`;
  let updated = html;

  if (/const MIRRORED_IMAGES = \{[\s\S]*?\};\nconst headers/.test(updated)) {
    updated = updated.replace(
      /const MIRRORED_IMAGES = \{[\s\S]*?\};\nconst headers/,
      `${mirrorDeclaration}\nconst headers`,
    );
  } else {
    updated = updated.replace(
      /\nconst headers =/,
      `\n${mirrorDeclaration}\nconst headers =`,
    );
  }

  if (!updated.includes("Takedown request</a>.")) {
    updated = updated.replace(
      /(\s+with complementary angles, the image links are comma-separated in the same row\.)\s*<\/p>/,
      `$1<br>
      For copyright or takedown requests, please submit a
      <a href="${TAKEDOWN_URL}" target="_blank" rel="noreferrer">GitHub issue titled Takedown request</a>.
    </p>`,
    );
  }

  updated = updated.replace(
    /function firstImage\(images\) \{\n\s+return images\.split\(","\)\.map\(s => s\.trim\(\)\)\.filter\(Boolean\)\[0\] \|\| "";\n\}/,
    `function firstImage(images) {
  const original = images.split(",").map(s => s.trim()).filter(Boolean)[0] || "";
  return MIRRORED_IMAGES[original] || original;
}`,
  );
  return updated;
}

await mkdir(IMAGES_DIR, { recursive: true });
const html = await readFile(HTML_PATH, "utf8");
const parsed = parseCatalog(html);
const recordsByUrl = new Map();
for (const row of parsed.rows) {
  for (const url of splitLinks(row["Image link(s)"])) {
    if (!recordsByUrl.has(url)) recordsByUrl.set(url, []);
    recordsByUrl.get(url).push(row);
  }
}

const counters = new Map();
const mirroredByUrl = new Map();
const manifestRows = [];
const downloadedAt = new Date().toISOString();
let completed = 0;

for (const [url, associatedRows] of recordsByUrl) {
  const host = new URL(url).hostname;
  const prefix = HOST_PREFIXES.get(host) || host.replace(/^www\./, "").split(".")[0];
  const sequence = (counters.get(prefix) || 0) + 1;
  counters.set(prefix, sequence);
  const stem = `${prefix}-${String(sequence).padStart(3, "0")}`;
  const destinationBase = path.join(IMAGES_DIR, stem);

  for (const extension of MIME_EXTENSIONS.values()) {
    const stalePath = `${destinationBase}.${extension}`;
    try {
      await stat(stalePath);
      await unlink(stalePath);
    } catch {
      // No stale download with this extension.
    }
  }

  const result = await download(url, destinationBase);
  const localPath = path.relative(ROOT, result.finalPath).split(path.sep).join("/");
  const mirrorUrl = new URL(localPath, MIRROR_BASE).href;
  mirroredByUrl.set(url, mirrorUrl);
  manifestRows.push({
    local_path: localPath,
    mirror_url: mirrorUrl,
    original_url: url,
    source_entity: [...new Set(associatedRows.map((row) => row.Source))].join(" | "),
    catalog_rows: [...new Set(associatedRows.map((row) => `${row.Source} - ${row.Title}`))].join(" | "),
    reference_urls: [...new Set(associatedRows.map((row) => row.Reference))].join(" | "),
    mime_type: result.mimeType,
    bytes: result.bytes,
    sha256: result.sha256,
    downloaded_at: downloadedAt,
  });
  completed += 1;
  console.log(`[${completed}/${recordsByUrl.size}] ${localPath}`);
}

const manifestHeaders = [
  "local_path",
  "mirror_url",
  "original_url",
  "source_entity",
  "catalog_rows",
  "reference_urls",
  "mime_type",
  "bytes",
  "sha256",
  "downloaded_at",
];
const manifest = [
  manifestHeaders.join(","),
  ...manifestRows.map((row) => manifestHeaders.map((header) => csvEscape(row[header])).join(",")),
].join("\n");

await writeFile(path.join(IMAGES_DIR, "manifest.csv"), `${manifest}\n`);
await writeFile(HTML_PATH, updateHtml(html, mirroredByUrl));
console.log(`Mirrored ${recordsByUrl.size} unique images.`);
