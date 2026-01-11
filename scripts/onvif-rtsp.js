#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { URL } = require("url");

const ROOT = path.join(__dirname, "..");
const DISCOVERY_FILE = path.join(ROOT, "web", "ip-cameras.json");
const RTSP_FILE = path.join(__dirname, "ip-cameras-rtsp.json");
const DEVICE_PATH_DEFAULT = "/onvif/device_service";
const DEFAULT_PORT = 80;
const COMMON_PORTS = [80, 2020, 8000, 8080];
const COMMON_DEVICE_PATHS = ["/onvif/device_service", "/onvif/DeviceService"];
const COMMON_MEDIA2_PATHS = ["/onvif/media2_service", "/onvif/Media2"];

const SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/";
const NS_DEVICE = "http://www.onvif.org/ver10/device/wsdl";
const NS_MEDIA = "http://www.onvif.org/ver10/media/wsdl";
const NS_MEDIA2 = "http://www.onvif.org/ver20/media/wsdl";
const NS_SCHEMA = "http://www.onvif.org/ver10/schema";

function printHelp() {
  console.log(`Usage: node scripts/onvif-rtsp.js [options]

Options:
  --host <ip>         Camera IP/host (override discovery)
  --port <port>       Device service port (default: 80)
  --device <path|url> Device service path or full URL (default: /onvif/device_service)
  --id <cameraId>     Use a camera id from web/ip-cameras.json
  --all               Process all cameras from web/ip-cameras.json
  --user <user>       ONVIF/RTSP username
  --pass <pass>       ONVIF/RTSP password
  --profile <index>   Profile index (default: 0)
  --out <path>        Output file (default: scripts/ip-cameras-rtsp.json)
  --dry               Do not write output file
  --help              Show help

Notes:
  - Ports tried automatically: 80, 2020, 8000, 8080
  - Device paths tried automatically: /onvif/device_service, /onvif/DeviceService
  - Falls back to Media2 if Media1 fails
`);
}

function parseArgs(argv) {
  const options = {
    host: "",
    port: DEFAULT_PORT,
    device: DEVICE_PATH_DEFAULT,
    id: "",
    all: false,
    user: "",
    pass: "",
    profileIndex: 0,
    outPath: RTSP_FILE,
    dry: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--host" && argv[i + 1]) {
      options.host = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--port" && argv[i + 1]) {
      options.port = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--device" && argv[i + 1]) {
      options.device = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--id" && argv[i + 1]) {
      options.id = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--all") {
      options.all = true;
      continue;
    }
    if (arg === "--user" && argv[i + 1]) {
      options.user = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--pass" && argv[i + 1]) {
      options.pass = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--profile" && argv[i + 1]) {
      options.profileIndex = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--out" && argv[i + 1]) {
      options.outPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--dry") {
      options.dry = true;
      continue;
    }
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
  }

  if (!Number.isFinite(options.port) || options.port <= 0) {
    options.port = DEFAULT_PORT;
  }
  if (!Number.isFinite(options.profileIndex) || options.profileIndex < 0) {
    options.profileIndex = 0;
  }
  return options;
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  const data = JSON.parse(raw);
  return Array.isArray(data) ? data : [data];
}

function writeJson(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function uniqueStrings(items) {
  const seen = new Set();
  const output = [];
  items.forEach((item) => {
    if (!item) return;
    const key = String(item);
    if (seen.has(key)) return;
    seen.add(key);
    output.push(item);
  });
  return output;
}

function buildDeviceUrl({ host, port, device }) {
  if (/^https?:\/\//i.test(device)) {
    return new URL(device);
  }
  const safeDevice = device.startsWith("/") ? device : `/${device}`;
  return new URL(`http://${host}:${port}${safeDevice}`);
}

function buildDeviceCandidates(target, options) {
  const candidates = [];
  const host = target.host;
  if (!host) return candidates;

  if (/^https?:\/\//i.test(options.device)) {
    try {
      candidates.push(new URL(options.device));
      return candidates;
    } catch {
      // ignore invalid URL and continue
    }
  }

  const ports = uniqueStrings([options.port, ...COMMON_PORTS]).map((value) => Number(value));
  const paths = uniqueStrings([options.device, ...COMMON_DEVICE_PATHS]);

  ports.forEach((port) => {
    if (!Number.isFinite(port) || port <= 0) return;
    paths.forEach((device) => {
      candidates.push(buildDeviceUrl({ host, port, device }));
    });
  });

  const deduped = [];
  const seen = new Set();
  candidates.forEach((item) => {
    const key = item.href;
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(item);
  });
  return deduped;
}

function buildMedia2Candidates(mediaUrls) {
  const candidates = [];
  mediaUrls.forEach((item) => {
    try {
      const url = new URL(item);
      candidates.push(url.toString());
      const replacedPath = url.pathname.replace(/media(?!2)/i, "media2");
      if (replacedPath !== url.pathname) {
        const alt = new URL(url.toString());
        alt.pathname = replacedPath;
        candidates.push(alt.toString());
      }
      COMMON_MEDIA2_PATHS.forEach((pathValue) => {
        const alt = new URL(url.toString());
        alt.pathname = pathValue;
        candidates.push(alt.toString());
      });
    } catch {
      // ignore invalid URL
    }
  });
  return uniqueStrings(candidates);
}

function soapEnvelope(body, namespaces) {
  const nsAttrs = Object.entries(namespaces || {})
    .map(([key, value]) => `xmlns:${key}="${value}"`)
    .join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="${SOAP_NS}" ${nsAttrs}>
  <s:Body>
    ${body}
  </s:Body>
</s:Envelope>`;
}

function extractTagValues(xml, tagName) {
  const regex = new RegExp(`<[^:>]*:?${tagName}[^>]*>([^<]+)</[^:>]*:?${tagName}>`, "gi");
  const values = [];
  let match;
  while ((match = regex.exec(xml)) !== null) {
    values.push(match[1].trim());
  }
  return values;
}

function extractProfileTokens(xml) {
  const tokens = [];
  const regex = /<[^:>]*:?Profiles[^>]*token="([^"]+)"/gi;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    tokens.push(match[1]);
  }
  return tokens;
}

function md5(value) {
  return crypto.createHash("md5").update(value).digest("hex");
}

function parseAuthHeader(header) {
  if (!header) return null;
  const text = Array.isArray(header) ? header.join(",") : header;
  if (/^basic/i.test(text)) {
    return { type: "basic" };
  }
  if (!/^digest/i.test(text)) {
    return null;
  }
  const params = {};
  text
    .replace(/^Digest\s+/i, "")
    .split(/,\s*/)
    .forEach((part) => {
      const idx = part.indexOf("=");
      if (idx === -1) return;
      const key = part.slice(0, idx).trim();
      let value = part.slice(idx + 1).trim();
      if (value.startsWith("\"") && value.endsWith("\"")) {
        value = value.slice(1, -1);
      }
      params[key] = value;
    });
  return { type: "digest", params };
}

function buildDigestAuth({ params, method, uri, user, pass }) {
  const realm = params.realm || "";
  const nonce = params.nonce || "";
  const qopRaw = params.qop || "";
  const qop = qopRaw.split(",").map((item) => item.trim()).filter(Boolean);
  const qopValue = qop.includes("auth") ? "auth" : qop[0] || "";
  const algorithm = (params.algorithm || "MD5").toUpperCase();
  const nc = "00000001";
  const cnonce = crypto.randomBytes(8).toString("hex");

  let ha1 = md5(`${user}:${realm}:${pass}`);
  if (algorithm === "MD5-SESS") {
    ha1 = md5(`${ha1}:${nonce}:${cnonce}`);
  }
  const ha2 = md5(`${method}:${uri}`);
  let response;
  if (qopValue) {
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qopValue}:${ha2}`);
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }

  const parts = [
    `username="${user}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ];
  if (params.opaque) {
    parts.push(`opaque="${params.opaque}"`);
  }
  if (algorithm) {
    parts.push(`algorithm=${algorithm}`);
  }
  if (qopValue) {
    parts.push(`qop=${qopValue}`);
    parts.push(`nc=${nc}`);
    parts.push(`cnonce="${cnonce}"`);
  }
  return `Digest ${parts.join(", ")}`;
}

function doRequest(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const client = isHttps ? https : http;
    const options = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
      timeout: 8000,
    };

    const req = client.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("request timeout"));
    });
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function requestSoap(url, action, body, auth) {
  const payload = soapEnvelope(body, auth.namespaces);
  const headers = {
    "Content-Type": "text/xml; charset=utf-8",
    SOAPAction: action,
    "Content-Length": Buffer.byteLength(payload),
  };

  if (auth.mode === "basic") {
    const token = Buffer.from(`${auth.user}:${auth.pass}`).toString("base64");
    headers.Authorization = `Basic ${token}`;
  }
  if (auth.mode === "digest" && auth.digest) {
    headers.Authorization = buildDigestAuth({
      params: auth.digest,
      method: "POST",
      uri: url.pathname + url.search,
      user: auth.user,
      pass: auth.pass,
    });
  }

  return doRequest(url, "POST", headers, payload);
}

async function requestSoapWithAuth(url, action, body, user, pass, namespaces) {
  const auth = { user, pass, mode: "", digest: null, namespaces };
  let response = await requestSoap(url, action, body, auth);
  if (response.statusCode !== 401) {
    return response;
  }

  const challenge = parseAuthHeader(response.headers["www-authenticate"]);
  if (!challenge) {
    return response;
  }

  if (challenge.type === "basic") {
    auth.mode = "basic";
  }
  if (challenge.type === "digest") {
    auth.mode = "digest";
    auth.digest = challenge.params;
  }

  response = await requestSoap(url, action, body, auth);
  return response;
}

async function getCapabilities(deviceUrl, user, pass) {
  const body = `<tds:GetCapabilities>
  <tds:Category>All</tds:Category>
</tds:GetCapabilities>`;
  const response = await requestSoapWithAuth(
    deviceUrl,
    "http://www.onvif.org/ver10/device/wsdl/GetCapabilities",
    body,
    user,
    pass,
    { tds: NS_DEVICE, tt: NS_SCHEMA }
  );
  if (response.statusCode !== 200) {
    throw new Error(`GetCapabilities failed (${response.statusCode})`);
  }

  const xaddrs = extractTagValues(response.body, "XAddr");
  if (!xaddrs.length) {
    throw new Error("Media XAddr not found");
  }
  const media2 = xaddrs.filter((item) => /media2/i.test(item));
  const media1 = xaddrs.filter((item) => /media(?!2)/i.test(item));
  const mediaAll = uniqueStrings(xaddrs);
  const media1Candidates = media1.length ? media1 : mediaAll;
  return {
    media1: uniqueStrings(media1Candidates),
    media2: uniqueStrings(media2),
    all: mediaAll,
  };
}

async function getProfiles(mediaUrl, user, pass, mode) {
  const isMedia2 = mode === "media2";
  const body = isMedia2 ? `<tr2:GetProfiles/>` : `<trt:GetProfiles/>`;
  const response = await requestSoapWithAuth(
    mediaUrl,
    isMedia2
      ? "http://www.onvif.org/ver20/media/wsdl/GetProfiles"
      : "http://www.onvif.org/ver10/media/wsdl/GetProfiles",
    body,
    user,
    pass,
    isMedia2 ? { tr2: NS_MEDIA2, tt: NS_SCHEMA } : { trt: NS_MEDIA, tt: NS_SCHEMA }
  );
  if (response.statusCode !== 200) {
    throw new Error(`GetProfiles failed (${response.statusCode})`);
  }
  return extractProfileTokens(response.body);
}

async function getStreamUri(mediaUrl, user, pass, profileToken, mode) {
  const isMedia2 = mode === "media2";
  const body = isMedia2
    ? `<tr2:GetStreamUri>
  <tr2:Protocol>RTSP</tr2:Protocol>
  <tr2:ProfileToken>${profileToken}</tr2:ProfileToken>
</tr2:GetStreamUri>`
    : `<trt:GetStreamUri>
  <trt:StreamSetup>
    <tt:Stream>RTP-Unicast</tt:Stream>
    <tt:Transport>
      <tt:Protocol>RTSP</tt:Protocol>
    </tt:Transport>
  </trt:StreamSetup>
  <trt:ProfileToken>${profileToken}</trt:ProfileToken>
</trt:GetStreamUri>`;
  const response = await requestSoapWithAuth(
    mediaUrl,
    isMedia2
      ? "http://www.onvif.org/ver20/media/wsdl/GetStreamUri"
      : "http://www.onvif.org/ver10/media/wsdl/GetStreamUri",
    body,
    user,
    pass,
    isMedia2 ? { tr2: NS_MEDIA2, tt: NS_SCHEMA } : { trt: NS_MEDIA, tt: NS_SCHEMA }
  );
  if (response.statusCode !== 200) {
    throw new Error(`GetStreamUri failed (${response.statusCode})`);
  }
  const uris = extractTagValues(response.body, "Uri");
  if (!uris.length) {
    throw new Error("RTSP Uri not found");
  }
  return uris[0];
}

function updateRtspFile(outPath, entry) {
  const list = readJson(outPath);
  const next = [];
  let updated = false;
  list.forEach((item) => {
    if (item && item.id === entry.id) {
      next.push({ ...item, ...entry });
      updated = true;
    } else {
      next.push(item);
    }
  });
  if (!updated) {
    next.push(entry);
  }
  writeJson(outPath, next);
}

async function fetchRtspFromMedia(mediaUrl, options, mode) {
  const tokens = await getProfiles(mediaUrl, options.user, options.pass, mode);
  if (!tokens.length) {
    throw new Error("No profiles found");
  }
  const idx = Math.min(options.profileIndex, tokens.length - 1);
  const token = tokens[idx];
  return getStreamUri(mediaUrl, options.user, options.pass, token, mode);
}

async function tryMediaUrls(urls, options, mode) {
  let lastError;
  for (const item of urls) {
    try {
      return await fetchRtspFromMedia(new URL(item), options, mode);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error("No media URLs available");
}

async function processTargetWithDevice(deviceUrl, target, options) {
  const caps = await getCapabilities(deviceUrl, options.user, options.pass);
  try {
    return await tryMediaUrls(caps.media1, options, "media1");
  } catch (error) {
    const media2Candidates = caps.media2.length
      ? caps.media2
      : buildMedia2Candidates(caps.media1);
    if (!media2Candidates.length) {
      throw error;
    }
    try {
      return await tryMediaUrls(media2Candidates, options, "media2");
    } catch (error2) {
      throw new Error(`Media1: ${error.message} | Media2: ${error2.message}`);
    }
  }
}

async function processTarget(target, options) {
  const candidates = buildDeviceCandidates(target, options);
  if (!candidates.length) {
    throw new Error("Device URL nao encontrado");
  }

  let lastError;
  for (const deviceUrl of candidates) {
    try {
      if (candidates.length > 1) {
        console.log(`  Tentando ${deviceUrl.href}`);
      }
      const rtspUrl = await processTargetWithDevice(deviceUrl, target, options);

      const entry = {
        id: target.id,
        name: target.name || target.id,
        rtspUrl,
      };

      if (!options.dry) {
        updateRtspFile(options.outPath, entry);
      }
      return entry;
    } catch (error) {
      lastError = new Error(`${error.message} @ ${deviceUrl.href}`);
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error("Falha ao obter RTSP");
}

function buildTargets(options) {
  if (options.host) {
    return [
      {
        id: options.id || `host-${options.host}`,
        name: options.id || options.host,
        host: options.host,
        port: options.port,
        device: options.device,
      },
    ];
  }

  const discovered = readJson(DISCOVERY_FILE);
  if (!discovered.length) {
    throw new Error("Nenhuma camera encontrada em web/ip-cameras.json");
  }

  if (options.id) {
    const match = discovered.find((item) => String(item.id) === String(options.id));
    if (!match) {
      throw new Error(`Camera id nao encontrada: ${options.id}`);
    }
    return [
      {
        id: match.id,
        name: match.name || match.id,
        host: match.host,
        port: options.port,
        device: options.device,
      },
    ];
  }

  if (options.all) {
    return discovered
      .filter((item) => item && item.host)
      .map((item) => ({
        id: item.id,
        name: item.name || item.id,
        host: item.host,
        port: options.port,
        device: options.device,
      }));
  }

  throw new Error("Use --host, --id ou --all");
}

async function main() {
  const options = parseArgs(process.argv);
  if (!options.user || !options.pass) {
    printHelp();
    throw new Error("Informe --user e --pass");
  }

  const targets = buildTargets(options);
  for (const target of targets) {
    const label = target.name || target.id || target.host;
    process.stdout.write(`Buscando RTSP em ${label}... `);
    try {
      const entry = await processTarget(target, options);
      console.log("ok");
      console.log(`  RTSP: ${entry.rtspUrl}`);
    } catch (error) {
      console.log("falhou");
      console.log(`  Erro: ${error.message || error}`);
    }
  }
}

main().catch((error) => {
  console.error("Erro:", error.message || error);
  process.exit(1);
});
