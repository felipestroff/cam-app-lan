#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DISCOVERY_FILE = path.join(ROOT, "web", "ip-cameras.json");
const RTSP_FILE = path.join(__dirname, "ip-cameras-rtsp.json");
const OUTPUT_FILE = path.join(ROOT, "mediamtx", "mediamtx.yml");

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  const data = JSON.parse(raw);
  return Array.isArray(data) ? data : [data];
}

function escapeYamlString(value) {
  const text = String(value);
  const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function sanitizePath(value) {
  if (!value) return "camera";
  const cleaned = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "camera";
}

function buildConfig(cameras) {
  const lines = [];
  lines.push("paths:");
  lines.push("  all:");
  lines.push("    source: publisher");

  cameras.forEach((camera) => {
    if (!camera.rtspUrl) return;
    const key = sanitizePath(camera.path || camera.id || camera.name);
    lines.push(`  ${key}:`);
    lines.push(`    source: ${escapeYamlString(camera.rtspUrl)}`);
    lines.push("    sourceOnDemand: yes");
  });

  return lines.join("\n") + "\n";
}

function main() {
  const discovered = readJson(DISCOVERY_FILE);
  const overrides = readJson(RTSP_FILE);
  const overrideMap = new Map();

  overrides.forEach((item) => {
    if (item && item.id && item.rtspUrl) {
      overrideMap.set(String(item.id), item);
    }
  });

  const merged = discovered.map((cam) => {
    const override = overrideMap.get(String(cam.id)) || {};
    return {
      ...cam,
      rtspUrl: override.rtspUrl || cam.rtspUrl || "",
    };
  });

  const knownIds = new Set(merged.map((cam) => String(cam.id || "")));
  overrides.forEach((item) => {
    if (!item || !item.id || !item.rtspUrl) return;
    const key = String(item.id);
    if (knownIds.has(key)) return;
    merged.push({
      id: item.id,
      path: item.id,
      name: item.name || item.id,
      rtspUrl: item.rtspUrl,
    });
  });

  const withRtsp = merged.filter((cam) => cam.rtspUrl);
  if (!withRtsp.length) {
    console.log("No RTSP URLs found. Fill scripts/ip-cameras-rtsp.json first.");
  }

  const output = buildConfig(withRtsp);
  fs.writeFileSync(OUTPUT_FILE, output, "utf8");
  console.log(`Generated ${OUTPUT_FILE} with ${withRtsp.length} RTSP path(s).`);
}

main();
