#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const dgram = require("dgram");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { URL } = require("url");

const MULTICAST_ADDR = "239.255.255.250";
const WS_DISCOVERY_PORT = 3702;
const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_INTERVAL_SEC = 20;
const DEFAULT_RTSP_PORT = 554;
const DEFAULT_OUT = path.join(__dirname, "..", "web", "ip-cameras.json");

function printHelp() {
  console.log(`Usage: node scripts/onvif-discover.js [options]

Options:
  --out <path>       Output file (default: web/ip-cameras.json)
  --timeout <ms>     Discovery wait time in ms (default: 4000)
  --interval <sec>   Run in loop every N seconds
  --watch            Run in loop (default interval: 20s)
  --once             Run once (default)
  --help             Show help
`);
}

function parseArgs(argv) {
  const options = {
    outPath: DEFAULT_OUT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    intervalSec: 0,
    rtspPort: DEFAULT_RTSP_PORT,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out" && argv[i + 1]) {
      options.outPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--timeout" && argv[i + 1]) {
      options.timeoutMs = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--interval" && argv[i + 1]) {
      options.intervalSec = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--watch") {
      options.intervalSec = options.intervalSec || DEFAULT_INTERVAL_SEC;
      continue;
    }
    if (arg === "--once") {
      options.intervalSec = 0;
      continue;
    }
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 500) {
    options.timeoutMs = DEFAULT_TIMEOUT_MS;
  }
  if (!Number.isFinite(options.intervalSec) || options.intervalSec < 0) {
    options.intervalSec = 0;
  }
  return options;
}

function buildProbeMessage() {
  const id = crypto.randomUUID ? crypto.randomUUID() : `uuid-${Date.now()}-${Math.random()}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
            xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
            xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
            xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <e:Header>
    <w:MessageID>uuid:${id}</w:MessageID>
    <w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
    <w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
  </e:Header>
  <e:Body>
    <d:Probe>
      <d:Types>dn:NetworkVideoTransmitter</d:Types>
    </d:Probe>
  </e:Body>
</e:Envelope>`;
}

function parseXmlTag(xml, tagName) {
  const regex = new RegExp(`<[^:>]*:?${tagName}[^>]*>([^<]+)</[^:>]*:?${tagName}>`, "i");
  const match = xml.match(regex);
  return match ? match[1].trim() : "";
}

function parseScopes(scopes) {
  if (!scopes) return {};
  const scope = String(scopes);
  const getValue = (key) => {
    const regex = new RegExp(`onvif://www.onvif.org/${key}/([^\\s]+)`, "i");
    const match = scope.match(regex);
    return match ? decodeURIComponent(match[1]) : "";
  };
  return {
    name: getValue("name"),
    hardware: getValue("hardware"),
    location: getValue("location"),
    serial: getValue("serial"),
  };
}

function sanitizeId(raw) {
  if (!raw) return "unknown";
  const cleaned = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "unknown";
}

function parseResponse(xml, rinfo, nowIso) {
  const xaddrsValue = parseXmlTag(xml, "XAddrs");
  const xaddrs = xaddrsValue ? xaddrsValue.split(/\s+/) : [];
  const scopesValue = parseXmlTag(xml, "Scopes");
  const endpoint = parseXmlTag(xml, "Address");

  let host = "";
  if (xaddrs.length) {
    try {
      host = new URL(xaddrs[0]).hostname;
    } catch {
      host = "";
    }
  }
  if (!host && rinfo && rinfo.address) {
    host = rinfo.address;
  }

  const scopeInfo = parseScopes(scopesValue);
  const baseName = scopeInfo.name || scopeInfo.hardware || (host ? `Camera ${host}` : "ONVIF Camera");

  const endpointClean = endpoint
    ? endpoint.replace(/^urn:uuid:/i, "").replace(/^uuid:/i, "")
    : "";
  const rawId = endpointClean || host || baseName;
  const id = `onvif-${sanitizeId(rawId)}`;

  return {
    id,
    name: baseName,
    path: id,
    source: "onvif",
    host,
    xaddrs,
    scopes: scopeInfo,
    lastSeen: nowIso,
    updated: nowIso,
    active: true,
  };
}

function checkPort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

function addMemberships(socket) {
  const interfaces = os.networkInterfaces();
  Object.values(interfaces).forEach((list) => {
    if (!Array.isArray(list)) return;
    list.forEach((iface) => {
      if (iface.family !== "IPv4" || iface.internal) return;
      try {
        socket.addMembership(MULTICAST_ADDR, iface.address);
      } catch {
        // Ignore failures per interface
      }
    });
  });
}

async function discoverOnce(timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const results = new Map();
    const nowIso = new Date().toISOString();
    const probe = Buffer.from(buildProbeMessage());

    socket.on("message", (msg, rinfo) => {
      const xml = msg.toString();
      const entry = parseResponse(xml, rinfo, nowIso);
      if (!entry) return;
      const key = entry.id || entry.host || `${rinfo.address}:${rinfo.port}`;
      if (!results.has(key)) {
        results.set(key, entry);
      }
    });

    socket.on("error", (error) => {
      socket.close();
      reject(error);
    });

    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
      } catch {
        // ignore
      }
      try {
        socket.setMulticastTTL(2);
      } catch {
        // ignore
      }
      addMemberships(socket);
      socket.send(probe, 0, probe.length, WS_DISCOVERY_PORT, MULTICAST_ADDR);
    });

    setTimeout(() => {
      socket.close();
      resolve(Array.from(results.values()));
    }, timeoutMs);
  });
}

async function enrichEntries(entries, rtspPort) {
  const checks = entries.map(async (entry) => {
    if (!entry.host) {
      return entry;
    }
    const reachable = await checkPort(entry.host, rtspPort, 700);
    return {
      ...entry,
      rtspPort,
      rtspReachable: reachable,
    };
  });
  return Promise.all(checks);
}

function writeOutput(entries, outPath) {
  const targetDir = path.dirname(outPath);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(entries, null, 2));
}

async function runOnce(options) {
  const entries = await discoverOnce(options.timeoutMs);
  const enriched = await enrichEntries(entries, options.rtspPort);
  writeOutput(enriched, options.outPath);
  const timestamp = new Date().toISOString().slice(11, 19);
  console.log(`[${timestamp}] Found ${enriched.length} camera(s).`);
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.intervalSec > 0) {
    await runOnce(options);
    setInterval(() => {
      runOnce(options).catch((error) => {
        console.error("Discovery error:", error.message || error);
      });
    }, options.intervalSec * 1000);
    return;
  }
  await runOnce(options);
}

main().catch((error) => {
  console.error("Fatal error:", error.message || error);
  process.exit(1);
});
