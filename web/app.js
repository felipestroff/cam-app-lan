const DEFAULT_SIGNAL_BASE = window.location.origin;
const DEFAULT_MEDIA_BASE = `${window.location.protocol}//${window.location.hostname}:8889`;
const baseUrlInput = document.getElementById("baseUrl");
const mediaBaseInput = document.getElementById("mediaBase");
const saveServerInput = document.getElementById("saveServer");
const reloadButton = document.getElementById("reload");
const grid = document.getElementById("grid");
const template = document.getElementById("camera-card");
const logEl = document.getElementById("log");
const clearLogBtn = document.getElementById("clearLog");
const httpsWarningEl = document.getElementById("httpsWarning");

const activePeers = new Map();
const activeRecorders = new Map();
const lastAnsweredOffer = new Map();
const cameraPaths = new Map();
const audioButtons = new Map();
const audioVideos = new Map();
const motionStates = new Map();
let activeAudioId = null;
let logVerbose = true;
let forceHttps = false;
let defaultRecordingFormat = "mp4";
let recordingNamePattern = "{camera}-{data}-{hora}";
let motionDefaults = { enabled: false, sensitivity: 60, stopAfter: 6 };
let forceHttpsBlocked = false;

function normalizeBaseUrl(url) {
  if (!url) return DEFAULT_SIGNAL_BASE;
  return url.replace(/\/+$/, "");
}

function normalizeMediaBase(url) {
  if (!url) return DEFAULT_MEDIA_BASE;
  return url.replace(/\/+$/, "");
}

function logLine(message) {
  if (!logEl || !logVerbose) return;
  const time = new Date().toISOString().slice(11, 19);
  logEl.textContent += `[${time}] ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function getSaveMode() {
  if (saveServerInput && saveServerInput.checked) {
    return "server";
  }
  return "download";
}

function updateAudioUi() {
  for (const [id, videoEl] of audioVideos.entries()) {
    const isActive = id === activeAudioId;
    videoEl.muted = !isActive;
    if (isActive) {
      const playPromise = videoEl.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {});
      }
    }
  }
  for (const [id, button] of audioButtons.entries()) {
    const isActive = id === activeAudioId;
    button.textContent = isActive ? "Audio ativo" : "Audio";
    button.classList.toggle("active", isActive);
    button.disabled = !activePeers.has(id);
  }
}

function setActiveAudio(id) {
  const path = cameraPaths.get(id) || id;
  if (activeAudioId === id) {
    activeAudioId = null;
    logLine(`[${path}] Audio desligado`);
  } else {
    activeAudioId = id;
    logLine(`[${path}] Audio selecionado`);
  }
  updateAudioUi();
}

function clearActiveAudio(id) {
  if (activeAudioId !== id) return;
  const path = cameraPaths.get(id) || id;
  activeAudioId = null;
  logLine(`[${path}] Audio desligado`);
  updateAudioUi();
}

function closeRecordOptions(exceptOptions) {
  const options = document.querySelectorAll(".record-options");
  options.forEach((item) => {
    if (exceptOptions && item === exceptOptions) {
      return;
    }
    item.classList.add("hidden");
  });
}

function getMotionDefaults() {
  return { ...motionDefaults };
}

function motionKey(id) {
  return `motion:${id}`;
}

function getMotionSettings(id) {
  const defaults = getMotionDefaults();
  const raw = localStorage.getItem(motionKey(id));
  if (!raw) {
    return { ...defaults };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : defaults.enabled,
      sensitivity: Number(parsed.sensitivity) || defaults.sensitivity,
      stopAfter: Number(parsed.stopAfter) || defaults.stopAfter,
    };
  } catch {
    return { ...defaults };
  }
}

function saveMotionSettings(id, settings) {
  localStorage.setItem(motionKey(id), JSON.stringify(settings));
}

function getMotionThreshold(sensitivity) {
  const value = Number(sensitivity) || 60;
  return Math.max(1, 21 - value * 0.2);
}

function getAutoFormat() {
  const preferred = defaultRecordingFormat === "webm" ? "webm" : "mp4";
  const preferredSupport = pickRecorderOptions(preferred);
  if (preferredSupport.supported) {
    return preferred;
  }
  return preferred === "mp4" ? "webm" : "mp4";
}

function stopMotionDetection(id) {
  const state = motionStates.get(id);
  if (!state) return;
  if (state.intervalId) {
    clearInterval(state.intervalId);
  }
  motionStates.delete(id);
}

function startMotionDetection({ id, camera, videoEl, recordUi, statusEl, settings }) {
  stopMotionDetection(id);
  if (!settings || !settings.enabled) {
    return;
  }

  const label = cameraPaths.get(id) || id;
  const width = 160;
  const height = 90;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    logLine(`[${label}] Canvas indisponivel para deteccao`);
    return;
  }

  const state = {
    intervalId: null,
    lastFrame: null,
    lastMotionAt: 0,
    settings: { ...settings },
  };

  const sample = () => {
    if (!videoEl.srcObject || videoEl.readyState < 2) {
      return;
    }
    ctx.drawImage(videoEl, 0, 0, width, height);
    const frame = ctx.getImageData(0, 0, width, height).data;
    if (state.lastFrame) {
      let changed = 0;
      const diffThreshold = 25;
      for (let i = 0; i < frame.length; i += 4) {
        const diff =
          Math.abs(frame[i] - state.lastFrame[i]) +
          Math.abs(frame[i + 1] - state.lastFrame[i + 1]) +
          Math.abs(frame[i + 2] - state.lastFrame[i + 2]);
        if (diff > diffThreshold) {
          changed += 1;
        }
      }
      const totalPixels = width * height;
      const motionPercent = (changed / totalPixels) * 100;
      const minPercent = getMotionThreshold(state.settings.sensitivity);
      const now = Date.now();
      if (motionPercent >= minPercent) {
        state.lastMotionAt = now;
        if (!activeRecorders.has(id)) {
          logLine(`[${label}] Movimento detectado (${motionPercent.toFixed(2)}%)`);
          startRecording(id, camera, videoEl.srcObject, recordUi, statusEl, {
            format: getAutoFormat(),
            mode: "auto",
            saveMode: getSaveMode(),
          });
        }
      }

      const entry = activeRecorders.get(id);
      if (entry && entry.mode === "auto" && state.lastMotionAt) {
        const elapsed = now - state.lastMotionAt;
        const stopAfter = (Number(state.settings.stopAfter) || 6) * 1000;
        if (elapsed >= stopAfter && !entry.stopping) {
          logLine(`[${label}] Sem movimento, parando gravacao automatica`);
          stopRecording(id, recordUi);
        }
      }
    }
    state.lastFrame = new Uint8ClampedArray(frame);
  };

  state.intervalId = setInterval(sample, 500);
  motionStates.set(id, state);
}

function buildSignalUrl(baseUrl, endpoint, path) {
  const base = normalizeBaseUrl(baseUrl);
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return `${base}/signal/${endpoint}${query}`;
}

function buildWhepUrls(baseUrl, path) {
  const base = normalizeMediaBase(baseUrl);
  const encoded = encodeURIComponent(path);
  return [
    `${base}/whep/${encoded}`,
    `${base}/${encoded}/whep`,
    `${base}/whep?path=${encoded}`,
  ];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postSignal(baseUrl, endpoint, payload) {
  const url = buildSignalUrl(baseUrl, endpoint);
  logLine(`Signal POST -> ${url}`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Signal error: ${response.status}`);
  }
}

async function resetSignal(baseUrl, path) {
  if (!path) return;
  try {
    await postSignal(baseUrl, "reset", { path });
    logLine(`[${path}] Signal reset enviado`);
  } catch (error) {
    console.error(error);
    logLine(`[${path}] Signal reset falhou`);
  }
}

function resetSignalBeacon(baseUrl, path) {
  if (!path || typeof navigator.sendBeacon !== "function") return;
  const url = buildSignalUrl(baseUrl, "reset");
  const payload = JSON.stringify({ path });
  const blob = new Blob([payload], { type: "application/json" });
  navigator.sendBeacon(url, blob);
}

async function getSignal(baseUrl, endpoint, path) {
  const url = buildSignalUrl(baseUrl, endpoint, path);
  if (endpoint !== "offer") {
    logLine(`Signal GET -> ${url}`);
  }
  const response = await fetch(url, { cache: "no-store" });
  if (response.status === 204) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Signal error: ${response.status}`);
  }
  return response.json();
}

async function postWhep(baseUrl, path, sdp) {
  const urls = buildWhepUrls(baseUrl, path);
  let lastError;
  for (const url of urls) {
    logLine(`WHEP POST -> ${url}`);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/sdp",
      },
      body: sdp,
    });
    if (response.ok) {
      const answerSdp = await response.text();
      const location = response.headers.get("location");
      return { answerSdp, location };
    }
    let detail = "";
    try {
      detail = (await response.text()).trim();
    } catch {
      detail = "";
    }
    const suffix = detail ? ` - ${detail}` : "";
    lastError = new Error(`WHEP ${response.status}${suffix}`);
    if (response.status === 404 || response.status === 405) {
      continue;
    }
    throw lastError;
  }
  throw lastError || new Error("WHEP falhou");
}

async function deleteWhep(baseUrl, location) {
  if (!location) return;
  const base = normalizeMediaBase(baseUrl);
  let resourceUrl = location;
  try {
    resourceUrl = new URL(location, base).toString();
  } catch {
    resourceUrl = `${base}${location.startsWith("/") ? "" : "/"}${location}`;
  }
  logLine(`WHEP DELETE -> ${resourceUrl}`);
  await fetch(resourceUrl, { method: "DELETE" });
}

function setStatus(statusEl, text, kind) {
  statusEl.textContent = text;
  statusEl.classList.remove("ok", "err");
  if (kind) statusEl.classList.add(kind);
}

function setDotActive(dotEl, isActive) {
  if (!dotEl) return;
  dotEl.classList.toggle("active", isActive);
}

function offerFingerprint(offer) {
  if (!offer) return "";
  return offer.ts || offer.sdp || "";
}

function aliasKey(id) {
  return `cameraAlias:${id}`;
}

function getStoredAlias(id) {
  return localStorage.getItem(aliasKey(id)) || "";
}

function storeAlias(id, alias) {
  if (!alias) {
    localStorage.removeItem(aliasKey(id));
    return;
  }
  localStorage.setItem(aliasKey(id), alias);
}

function getFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement;
}

function requestFullscreen(target) {
  if (!target) return Promise.resolve();
  if (target.requestFullscreen) {
    return target.requestFullscreen();
  }
  if (target.webkitRequestFullscreen) {
    return target.webkitRequestFullscreen();
  }
  return Promise.resolve();
}

function exitFullscreen() {
  if (document.exitFullscreen) {
    return document.exitFullscreen();
  }
  if (document.webkitExitFullscreen) {
    return document.webkitExitFullscreen();
  }
  return Promise.resolve();
}

async function toggleFullscreen(target) {
  if (getFullscreenElement()) {
    await exitFullscreen();
    return;
  }
  await requestFullscreen(target);
}

function waitForIceGathering(pc) {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const handler = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", handler);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", handler);
  });
}

function pickRecorderOptions(format) {
  const webmCandidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  const mp4Candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=h264,aac",
    "video/mp4",
  ];
  const candidates = format === "mp4" ? mp4Candidates : webmCandidates;
  for (const mimeType of candidates) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return { mimeType, ext: format === "mp4" ? "mp4" : "webm", supported: true };
    }
  }
  return { mimeType: "", ext: format === "mp4" ? "mp4" : "webm", supported: false };
}

function sanitizeRecordingBase(value) {
  return (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildRecordingName(camera, ext) {
  const cameraName = sanitizeRecordingBase(camera.name || camera.id || camera.path || "camera") || "camera";
  const now = new Date();
  const iso = now.toISOString();
  const date = iso.slice(0, 10).replace(/-/g, "");
  const time = iso.slice(11, 19).replace(/:/g, "");
  const datetime = `${date}-${time}`;
  let pattern = recordingNamePattern || "{camera}-{data}-{hora}";
  let base = pattern
    .replace(/\{camera\}/g, cameraName)
    .replace(/\{data\}/g, date)
    .replace(/\{hora\}/g, time)
    .replace(/\{datetime\}/g, datetime);
  base = sanitizeRecordingBase(base);
  if (!base) {
    base = `${cameraName}-${datetime}`;
  }
  const lower = base.toLowerCase();
  if (!lower.endsWith(`.${ext}`)) {
    return `${base}.${ext}`;
  }
  return base;
}

function downloadRecording(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function uploadRecording(blob, filename) {
  const baseUrl = baseUrlInput.value.trim() || DEFAULT_SIGNAL_BASE;
  const url = `${normalizeBaseUrl(baseUrl)}/recordings`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": blob.type || "application/octet-stream",
      "X-Filename": filename,
    },
    body: blob,
  });
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).trim();
    } catch {
      detail = "";
    }
    const suffix = detail ? ` - ${detail}` : "";
    throw new Error(`Upload ${response.status}${suffix}`);
  }
  return response.json().catch(() => ({}));
}

async function saveRecordingBlob(id, blob, filename, saveMode) {
  if (saveMode === "server") {
    try {
      await uploadRecording(blob, filename);
      logLine(`[${id}] Gravacao enviada: ${filename}`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha";
      logLine(`[${id}] Falha ao enviar, baixando local: ${message}`);
    }
  }
  downloadRecording(blob, filename);
  logLine(`[${id}] Gravacao salva: ${filename}`);
}

function stopRecording(id, ui) {
  const entry = activeRecorders.get(id);
  if (!entry || entry.stopping) return;
  const modeLabel = entry.mode === "auto" ? "automatica" : "manual";
  logLine(`[${id}] Parando gravacao (${modeLabel})`);
  entry.stopping = true;
  entry.recorder.stop();
  if (ui) {
    const connected = activePeers.has(id);
    ui.recIndicator.classList.add("hidden");
    ui.stopRecordBtn.classList.add("hidden");
    ui.stopRecordBtn.disabled = true;
    if (ui.recordBtn) {
      ui.recordBtn.disabled = !connected;
    }
    if (ui.recordOptions) {
      ui.recordOptions.classList.add("hidden");
    }
    if (ui.recordMenu) {
      ui.recordMenu.classList.toggle("hidden", !connected);
    }
  }
}

function startRecording(id, camera, stream, ui, statusEl, options) {
  if (activeRecorders.has(id)) return;
  if (!stream) {
    setStatus(statusEl, "Sem stream para gravar", "err");
    logLine(`[${id}] Sem stream para gravar`);
    return;
  }
  if (typeof MediaRecorder === "undefined") {
    setStatus(statusEl, "MediaRecorder indisponivel", "err");
    logLine(`[${id}] MediaRecorder indisponivel`);
    return;
  }

  const opts = typeof options === "string" ? { format: options } : options || {};
  const selectedFormat = opts.format || defaultRecordingFormat;
  const mode = opts.mode || "manual";
  const saveMode = opts.saveMode || "download";
  const selectionLabel = selectedFormat.toUpperCase();

  let recorder;
  let { mimeType, ext, supported } = pickRecorderOptions(selectedFormat);
  if (!supported && selectedFormat === "mp4") {
    const fallback = pickRecorderOptions("webm");
    if (fallback.supported) {
      ({ mimeType, ext, supported } = fallback);
      logLine(`[${id}] MP4 indisponivel, usando WebM`);
    }
  }
  if (!supported) {
    setStatus(statusEl, `${selectionLabel} nao suportado neste navegador`, "err");
    logLine(`[${id}] Formato ${selectionLabel} nao suportado`);
    return;
  }
  const recorderOptions = mimeType ? { mimeType } : {};
  try {
    recorder = new MediaRecorder(stream, recorderOptions);
  } catch (error) {
    setStatus(statusEl, "Falha ao iniciar gravacao", "err");
    console.error(error);
    return;
  }

  const chunks = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
    }
  });
  recorder.addEventListener("stop", () => {
    const blobType = recorder.mimeType || mimeType || "video/webm";
    const blob = new Blob(chunks, { type: blobType });
    const filename = buildRecordingName(camera, ext);
    saveRecordingBlob(id, blob, filename, saveMode);
    activeRecorders.delete(id);
    if (ui) {
      const connected = activePeers.has(id);
      ui.recIndicator.classList.add("hidden");
      ui.stopRecordBtn.classList.add("hidden");
      ui.stopRecordBtn.disabled = true;
      if (ui.recordBtn) {
        ui.recordBtn.disabled = !connected;
      }
      if (ui.recordOptions) {
        ui.recordOptions.classList.add("hidden");
      }
      if (ui.recordMenu) {
        ui.recordMenu.classList.toggle("hidden", !connected);
      }
    }
  });
  recorder.addEventListener("error", (event) => {
    setStatus(statusEl, "Erro na gravacao", "err");
    console.error(event);
  });

  activeRecorders.set(id, { recorder, mode, saveMode, stopping: false });
  recorder.start();
  const modeLabel = mode === "auto" ? "automatica" : "manual";
  logLine(`[${id}] Gravacao ${modeLabel} iniciada (${selectionLabel})`);
  ui.recIndicator.classList.remove("hidden");
  if (ui.recordBtn) {
    ui.recordBtn.disabled = true;
  }
  ui.stopRecordBtn.disabled = false;
  ui.stopRecordBtn.classList.remove("hidden");
  if (ui.recordOptions) {
    ui.recordOptions.classList.add("hidden");
  }
  if (ui.recordMenu) {
    ui.recordMenu.classList.add("hidden");
  }
}

async function waitForOffer(baseUrl, path, session, lastFingerprint) {
  logLine(`[${path}] Aguardando offer...`);
  while (!session.stopped) {
    const data = await getSignal(baseUrl, "offer", path);
    if (data && data.sdp) {
      const fingerprint = offerFingerprint(data);
      if (lastFingerprint && fingerprint === lastFingerprint) {
        await delay(500);
        continue;
      }
      logLine(`[${path}] Offer recebido`);
      return data;
    }
    await delay(1000);
  }
  throw new Error("Cancelado");
}

async function startDirectStream({ id, videoEl, baseUrl, path, statusEl, session, onDisconnect, dotEl }) {
  const lastFingerprint = lastAnsweredOffer.get(id) || "";
  const offer = await waitForOffer(baseUrl, path, session, lastFingerprint);
  if (session.stopped) {
    throw new Error("Cancelado");
  }
  const fingerprint = offerFingerprint(offer);

  const pc = new RTCPeerConnection();
  session.pc = pc;

  pc.addEventListener("track", (event) => {
    if (event.streams && event.streams[0]) {
      videoEl.srcObject = event.streams[0];
      logLine(`[${path}] Track recebido`);
    }
  });

  pc.addEventListener("connectionstatechange", () => {
    logLine(`[${path}] Connection state: ${pc.connectionState}`);
    if (pc.connectionState === "connected") {
      setStatus(statusEl, "Conectado", "ok");
      setDotActive(dotEl, true);
    }
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      setStatus(statusEl, "Falha na conexao", "err");
      setDotActive(dotEl, false);
      if (onDisconnect) {
        onDisconnect();
      }
    }
  });

  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitForIceGathering(pc);

  await postSignal(baseUrl, "answer", {
    path,
    type: pc.localDescription.type,
    sdp: pc.localDescription.sdp,
  });
  logLine(`[${path}] Answer enviado`);
  if (fingerprint) {
    lastAnsweredOffer.set(id, fingerprint);
  }
  setStatus(statusEl, "Conectando...");

  return pc;
}

async function startWhepStream({ videoEl, mediaBase, path, statusEl, session, onDisconnect, dotEl }) {
  const pc = new RTCPeerConnection();
  session.pc = pc;
  session.mode = "whep";
  session.whepBase = normalizeMediaBase(mediaBase);

  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  pc.addEventListener("track", (event) => {
    if (event.streams && event.streams[0]) {
      videoEl.srcObject = event.streams[0];
      logLine(`[${path}] Track recebido (WHEP)`);
    }
  });

  pc.addEventListener("connectionstatechange", () => {
    logLine(`[${path}] Connection state: ${pc.connectionState}`);
    if (pc.connectionState === "connected") {
      setStatus(statusEl, "Conectado", "ok");
      setDotActive(dotEl, true);
    }
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      setStatus(statusEl, "Falha na conexao", "err");
      setDotActive(dotEl, false);
      if (onDisconnect) {
        onDisconnect();
      }
    }
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGathering(pc);

  const { answerSdp, location } = await postWhep(session.whepBase, path, pc.localDescription.sdp);
  session.whepResource = location;
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  logLine(`[${path}] Answer recebido (WHEP)`);
  setStatus(statusEl, "Conectando...");

  return pc;
}

function stopStream(id, videoEl, statusEl) {
  const session = activePeers.get(id);
  if (session) {
    session.stopped = true;
    if (session.pc) {
      session.pc.close();
    }
    if (session.mode === "whep" && session.whepBase && session.whepResource) {
      deleteWhep(session.whepBase, session.whepResource).catch((error) => {
        console.error(error);
        logLine(`[${id}] Falha ao encerrar WHEP`);
      });
    }
    activePeers.delete(id);
  }
  videoEl.srcObject = null;
  setStatus(statusEl, "Desconectado");
}

function renderCameras(cameras) {
  grid.innerHTML = "";
  cameraPaths.clear();
  audioButtons.clear();
  audioVideos.clear();
  cameras.forEach((camera) => {
    const node = template.content.cloneNode(true);
    const card = node.querySelector(".card");
    const nameEl = node.querySelector(".name");
    const connectBtn = node.querySelector(".connect");
    const disconnectBtn = node.querySelector(".disconnect");
    const fullscreenBtn = node.querySelector(".fullscreen");
    const audioBtn = node.querySelector(".audio");
    const recordMenu = node.querySelector(".record-menu");
    const recordBtn = node.querySelector(".record");
    const recordOptions = node.querySelector(".record-options");
    const recordOptionButtons = Array.from(node.querySelectorAll(".record-option"));
    const stopRecordBtn = node.querySelector(".stop-record");
    const recIndicator = node.querySelector(".rec-indicator");
    const statusEl = node.querySelector(".status");
    const dotEl = node.querySelector(".dot");
    const motionControls = node.querySelector(".motion-controls");
    const motionEnable = node.querySelector(".motion-enable");
    const motionSensitivity = node.querySelector(".motion-sensitivity");
    const motionValue = node.querySelector(".motion-value");
    const motionStop = node.querySelector(".motion-stop");
    const motionStopValue = node.querySelector(".motion-stop-value");
    const videoWrap = node.querySelector(".video-wrap");
    const videoEl = node.querySelector("video");
    card.dataset.id = camera.id || camera.path;
    const cameraId = card.dataset.id;
    const cameraPath = camera.path || camera.id || cameraId;
    cameraPaths.set(cameraId, cameraPath);
    audioVideos.set(cameraId, videoEl);
    if (audioBtn) {
      audioButtons.set(cameraId, audioBtn);
    }
    const storedAlias = getStoredAlias(cameraId);
    const baseName = camera.name || camera.path || "Camera";
    nameEl.textContent = storedAlias || baseName;
    nameEl.setAttribute("contenteditable", "true");
    nameEl.setAttribute("spellcheck", "false");
    nameEl.dataset.baseName = baseName;
    nameEl.title = "Clique para renomear";

    const source = (camera.source || "webrtc").toString().toLowerCase();
    const isWebrtc = source === "webrtc";
    setDotActive(dotEl, false);
    const rtspConfigured =
      typeof camera.rtspConfigured === "boolean" ? camera.rtspConfigured : true;
    if (!isWebrtc) {
      const parts = ["IP camera"];
      if (camera.host) {
        parts.push(camera.host);
      }
      if (camera.rtspReachable === true) {
        parts.push("RTSP ok");
      }
      if (camera.rtspReachable === false) {
        parts.push("RTSP off");
      }
      if (!rtspConfigured) {
        parts.push("RTSP nao configurado");
      }
      let kind = camera.rtspReachable === true ? "ok" : camera.rtspReachable === false ? "err" : undefined;
      if (!rtspConfigured) {
        kind = "err";
      }
      setStatus(statusEl, parts.join(" - "), kind);
      connectBtn.textContent = "Assistir";
      connectBtn.dataset.defaultLabel = "Assistir";
      if (!rtspConfigured) {
        connectBtn.classList.add("hidden");
        disconnectBtn.classList.add("hidden");
      } else {
        connectBtn.classList.remove("hidden");
        disconnectBtn.classList.add("hidden");
      }
    } else {
      setStatus(statusEl, "Aguardando");
      connectBtn.textContent = "Conectar";
      connectBtn.dataset.defaultLabel = "Conectar";
      connectBtn.classList.remove("hidden");
      disconnectBtn.classList.add("hidden");
    }
    recordBtn.disabled = true;
    stopRecordBtn.disabled = true;
    if (forceHttpsBlocked) {
      connectBtn.disabled = true;
      connectBtn.textContent = "HTTPS necessario";
    }

    const recordUi = { recordMenu, recordBtn, recordOptions, stopRecordBtn, recIndicator };
    let motionSettings = getMotionSettings(cameraId);
    if (motionEnable) {
      motionEnable.checked = motionSettings.enabled;
    }
    if (motionSensitivity) {
      motionSensitivity.value = motionSettings.sensitivity;
    }
    if (motionValue) {
      motionValue.textContent = motionSettings.sensitivity;
    }
    if (motionStop) {
      motionStop.value = motionSettings.stopAfter;
    }
    if (motionStopValue) {
      motionStopValue.textContent = `${motionSettings.stopAfter}s`;
    }

    const setConnectedUi = (connected) => {
      if (fullscreenBtn) {
        fullscreenBtn.classList.toggle("hidden", !connected);
      }
      if (audioBtn) {
        audioBtn.classList.toggle("hidden", !connected);
      }
      if (recordMenu) {
        recordMenu.classList.toggle("hidden", !connected);
      }
      if (motionControls) {
        motionControls.classList.toggle("hidden", !connected);
      }
      if (!connected) {
        recIndicator.classList.add("hidden");
        stopRecordBtn.classList.add("hidden");
        if (recordOptions) {
          recordOptions.classList.add("hidden");
        }
      }
    };

    setConnectedUi(false);
    stopMotionDetection(cameraId);
    updateAudioUi();

    nameEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        nameEl.blur();
      }
    });
    nameEl.addEventListener("blur", () => {
      const value = nameEl.textContent.replace(/\s+/g, " ").trim();
      if (!value || value === baseName) {
        storeAlias(cameraId, "");
        nameEl.textContent = baseName;
        return;
      }
      storeAlias(cameraId, value);
      nameEl.textContent = value;
    });

    if (fullscreenBtn) {
      fullscreenBtn.addEventListener("click", () => {
        toggleFullscreen(videoWrap);
        logLine(`[${cameraPath}] Tela cheia alternada`);
      });
    }
    if (audioBtn) {
      audioBtn.addEventListener("click", () => {
        const id = card.dataset.id;
        if (!activePeers.has(id)) {
          return;
        }
        setActiveAudio(id);
      });
    }
    if (recordBtn) {
      recordBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        const id = card.dataset.id;
        if (!activePeers.has(id) || activeRecorders.has(id)) {
          return;
        }
        if (!recordOptions) {
          return;
        }
        const shouldOpen = recordOptions.classList.contains("hidden");
        closeRecordOptions(recordOptions);
        recordOptions.classList.toggle("hidden", !shouldOpen);
      });
    }
    recordOptionButtons.forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const id = card.dataset.id;
        if (!activePeers.has(id)) {
          return;
        }
        const format = button.dataset.format || "mp4";
        closeRecordOptions();
        startRecording(id, camera, videoEl.srcObject, recordUi, statusEl, {
          format,
          mode: "manual",
          saveMode: getSaveMode(),
        });
      });
    });

    const applyMotionSettings = (shouldRestart) => {
      if (motionEnable) {
        motionSettings.enabled = motionEnable.checked;
      }
      if (motionSensitivity) {
        motionSettings.sensitivity = Number(motionSensitivity.value) || motionSettings.sensitivity;
      }
      if (motionStop) {
        motionSettings.stopAfter = Number(motionStop.value) || motionSettings.stopAfter;
      }
      if (motionValue) {
        motionValue.textContent = motionSettings.sensitivity;
      }
      if (motionStopValue) {
        motionStopValue.textContent = `${motionSettings.stopAfter}s`;
      }
      saveMotionSettings(cameraId, motionSettings);
      if (!shouldRestart || !activePeers.has(cameraId)) {
        return;
      }
      if (motionSettings.enabled) {
        const existingState = motionStates.get(cameraId);
        if (existingState) {
          existingState.settings = { ...motionSettings };
          return;
        }
        startMotionDetection({
          id: cameraId,
          camera,
          videoEl,
          recordUi,
          statusEl,
          settings: motionSettings,
        });
        return;
      }
      stopMotionDetection(cameraId);
      const entry = activeRecorders.get(cameraId);
      if (entry && entry.mode === "auto" && !entry.stopping) {
        stopRecording(cameraId, recordUi);
      }
    };

    if (motionEnable) {
      motionEnable.addEventListener("change", () => {
        applyMotionSettings(true);
        if (motionSettings.enabled) {
          logLine(`[${cameraPath}] Deteccao de movimento ativada`);
        } else {
          logLine(`[${cameraPath}] Deteccao de movimento desativada`);
        }
      });
    }
    if (motionSensitivity) {
      motionSensitivity.addEventListener("input", () => {
        applyMotionSettings(true);
      });
    }
    if (motionStop) {
      motionStop.addEventListener("input", () => {
        applyMotionSettings(true);
      });
    }

    connectBtn.addEventListener("click", async () => {
      const id = card.dataset.id;
      if (activePeers.has(id)) return;
      if (forceHttpsBlocked) {
        setStatus(statusEl, "HTTPS necessario", "err");
        return;
      }
      logLine(`[${cameraPath}] Conectar acionado`);
      const session = { stopped: false, pc: null, mode: isWebrtc ? "webrtc" : "whep" };
      activePeers.set(id, session);
      setStatus(statusEl, isWebrtc ? "Aguardando publisher..." : "Conectando camera IP...");
      connectBtn.textContent = "Carregando...";
      connectBtn.disabled = true;

      const onDisconnect = () => {
        stopRecording(id, recordUi);
        stopMotionDetection(id);
        setConnectedUi(false);
        disconnectBtn.classList.add("hidden");
        connectBtn.classList.remove("hidden");
        connectBtn.textContent = connectBtn.dataset.defaultLabel || "Conectar";
        if (recordBtn) {
          recordBtn.disabled = true;
        }
        if (recordOptions) {
          recordOptions.classList.add("hidden");
        }
        stopRecordBtn.disabled = true;
        clearActiveAudio(id);
        setDotActive(dotEl, false);
        if (forceHttpsBlocked) {
          connectBtn.disabled = true;
          connectBtn.textContent = "HTTPS necessario";
        }
      };

      try {
        if (isWebrtc) {
          await startDirectStream({
            id,
            videoEl,
            baseUrl: baseUrlInput.value.trim(),
            path: cameraPath,
            statusEl,
            session,
            onDisconnect,
            dotEl,
          });
        } else {
          const mediaBaseValue = mediaBaseInput ? mediaBaseInput.value.trim() : "";
          if (!mediaBaseValue) {
            throw new Error("Media Base URL vazio");
          }
          await startWhepStream({
            videoEl,
            mediaBase: mediaBaseValue,
            path: cameraPath,
            statusEl,
            session,
            onDisconnect,
            dotEl,
          });
        }
        if (session.stopped) {
          return;
        }
        connectBtn.classList.add("hidden");
        disconnectBtn.classList.remove("hidden");
        setConnectedUi(true);
        if (motionSettings.enabled) {
          startMotionDetection({
            id: cameraId,
            camera,
            videoEl,
            recordUi,
            statusEl,
            settings: motionSettings,
          });
        }
        if (recordBtn) {
          recordBtn.disabled = false;
        }
        updateAudioUi();
        logLine(`[${cameraPath}] Conectado`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Falha";
        if (message === "Cancelado" && session.stopped) {
          setStatus(statusEl, "Desconectado");
          logLine(`[${cameraPath}] Conexao cancelada`);
        } else {
          setStatus(statusEl, `Erro ao conectar (${message})`, "err");
          console.error(error);
          session.stopped = true;
          logLine(`[${cameraPath}] Erro ao conectar: ${message}`);
        }
        activePeers.delete(id);
        clearActiveAudio(id);
        connectBtn.textContent = connectBtn.dataset.defaultLabel || "Conectar";
      } finally {
        if (forceHttpsBlocked) {
          connectBtn.disabled = true;
          connectBtn.textContent = "HTTPS necessario";
        } else {
          connectBtn.disabled = false;
          if (!connectBtn.classList.contains("hidden")) {
            connectBtn.textContent = connectBtn.dataset.defaultLabel || "Conectar";
          }
        }
      }
    });

    disconnectBtn.addEventListener("click", () => {
      const id = card.dataset.id;
      stopRecording(id, recordUi);
      stopMotionDetection(id);
      stopStream(id, videoEl, statusEl);
      if (isWebrtc) {
        resetSignal(baseUrlInput.value.trim(), cameraPath);
      }
      clearActiveAudio(id);
      logLine(`[${cameraPath}] Desconectado`);
      disconnectBtn.classList.add("hidden");
      connectBtn.classList.remove("hidden");
      connectBtn.textContent = connectBtn.dataset.defaultLabel || "Conectar";
      setDotActive(dotEl, false);
      setConnectedUi(false);
      if (forceHttpsBlocked) {
        connectBtn.disabled = true;
        connectBtn.textContent = "HTTPS necessario";
      }
      if (recordBtn) {
        recordBtn.disabled = true;
      }
      if (recordOptions) {
        recordOptions.classList.add("hidden");
      }
      stopRecordBtn.disabled = true;
    });

    stopRecordBtn.addEventListener("click", () => {
      const id = card.dataset.id;
      stopRecording(id, recordUi);
    });

    grid.appendChild(node);
  });

  if (activeAudioId && !audioVideos.has(activeAudioId)) {
    activeAudioId = null;
  }
  updateAudioUi();
}

async function fetchCamerasFromServer() {
  const baseUrl = baseUrlInput.value.trim() || DEFAULT_SIGNAL_BASE;
  const url = `${normalizeBaseUrl(baseUrl)}/cameras`;
  logLine(`Cameras GET -> ${url}`);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Cameras error: ${response.status}`);
  }
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

async function loadCameras() {
  try {
    logLine("Carregando cameras...");
    const data = await fetchCamerasFromServer();
    if (!data.length) {
      grid.innerHTML = "<div class=\"status\">Nenhuma camera ativa. Abra publish.html no dispositivo a ser utilizado como camera.</div>";
      cameraPaths.clear();
      logLine("Nenhuma camera ativa");
      return;
    }
    renderCameras(data);
    logLine(`Cameras carregadas: ${data.length}`);
  } catch (error) {
    console.error(error);
    grid.innerHTML = "<div class=\"status err\">Erro ao carregar cameras.</div>";
    logLine("Erro ao carregar cameras");
  }
}

function lockField(input) {
  if (!input) return;
  input.readOnly = true;
  input.disabled = true;
  input.setAttribute("aria-readonly", "true");
  input.classList.add("is-locked");
}

function applyHttpsPolicy() {
  forceHttpsBlocked = forceHttps && window.location.protocol !== "https:";
  if (httpsWarningEl) {
    httpsWarningEl.classList.toggle("hidden", !forceHttpsBlocked);
  }
}

async function loadServerConfig() {
  const defaultSignal = DEFAULT_SIGNAL_BASE;
  const defaultMedia = DEFAULT_MEDIA_BASE;
  baseUrlInput.value = defaultSignal;
  lockField(baseUrlInput);
  if (mediaBaseInput) {
    mediaBaseInput.value = defaultMedia;
    lockField(mediaBaseInput);
  }
  try {
    const response = await fetch(`${window.location.origin}/config`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Config error: ${response.status}`);
    }
    const data = await response.json();
    const signalBase = (data.signalBase || "").toString().trim();
    const mediaBase = (data.mediaBase || "").toString().trim();
    const format = (data.recordingFormat || "").toString().trim().toLowerCase();
    const pattern = (data.recordingNamePattern || "").toString().trim();
    baseUrlInput.value = signalBase || defaultSignal;
    if (mediaBaseInput) {
      mediaBaseInput.value = mediaBase || defaultMedia;
      logLine(`Media base: ${mediaBaseInput.value}`);
    }
    if (format === "mp4" || format === "webm") {
      defaultRecordingFormat = format;
    } else {
      defaultRecordingFormat = "mp4";
    }
    recordingNamePattern = pattern || "{camera}-{data}-{hora}";
    if (data.motionDefaults) {
      motionDefaults = {
        enabled: Boolean(data.motionDefaults.enabled),
        sensitivity: Number(data.motionDefaults.sensitivity) || 60,
        stopAfter: Number(data.motionDefaults.stopAfter) || 6,
      };
    } else {
      motionDefaults = { enabled: false, sensitivity: 60, stopAfter: 6 };
    }
    if (typeof data.forceHttps === "boolean") {
      forceHttps = data.forceHttps;
    } else {
      forceHttps = false;
    }
    if (typeof data.logsVerbose === "boolean") {
      logVerbose = data.logsVerbose;
    } else {
      logVerbose = true;
    }
    applyHttpsPolicy();
    logLine(`Config carregada: base=${baseUrlInput.value}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha";
    logLine(`Falha ao carregar config: ${message}`);
  }
}

async function init() {
  logLine(`Init: base=${DEFAULT_SIGNAL_BASE}`);

  if (saveServerInput) {
    const storedSave = localStorage.getItem("saveServer");
    saveServerInput.checked = storedSave === "true";
    saveServerInput.addEventListener("change", () => {
      localStorage.setItem("saveServer", saveServerInput.checked ? "true" : "false");
      logLine(`Gravacoes no servidor: ${saveServerInput.checked ? "sim" : "nao"}`);
    });
  }

  document.addEventListener("click", (event) => {
    if (event.target.closest(".record-menu")) {
      return;
    }
    closeRecordOptions();
  });
  reloadButton.addEventListener("click", async () => {
    await loadServerConfig();
    loadCameras();
  });
  await loadServerConfig();
  loadCameras();
  if (clearLogBtn && logEl) {
    clearLogBtn.addEventListener("click", () => {
      logEl.textContent = "";
      logLine("Logs limpos");
    });
  }

  window.addEventListener("pagehide", () => {
    const baseUrl = baseUrlInput.value.trim() || DEFAULT_SIGNAL_BASE;
    for (const [id] of activePeers) {
      const path = cameraPaths.get(id) || id;
      resetSignalBeacon(baseUrl, path);
    }
  });
}

init();
