const DEFAULT_SIGNAL_BASE = window.location.origin;
const baseUrlInput = document.getElementById("baseUrl");
const reloadButton = document.getElementById("reload");
const grid = document.getElementById("grid");
const template = document.getElementById("camera-card");

const activePeers = new Map();
const activeRecorders = new Map();
const lastAnsweredOffer = new Map();
const cameraPaths = new Map();

function normalizeBaseUrl(url) {
  if (!url) return DEFAULT_SIGNAL_BASE;
  return url.replace(/\/+$/, "");
}

function buildSignalUrl(baseUrl, endpoint, path) {
  const base = normalizeBaseUrl(baseUrl);
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return `${base}/signal/${endpoint}${query}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postSignal(baseUrl, endpoint, payload) {
  const url = buildSignalUrl(baseUrl, endpoint);
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
  } catch (error) {
    console.error(error);
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
  const response = await fetch(url, { cache: "no-store" });
  if (response.status === 204) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Signal error: ${response.status}`);
  }
  return response.json();
}

function setStatus(statusEl, text, kind) {
  statusEl.textContent = text;
  statusEl.classList.remove("ok", "err");
  if (kind) statusEl.classList.add(kind);
}

function offerFingerprint(offer) {
  if (!offer) return "";
  return offer.ts || offer.sdp || "";
}

function orientationKey(id) {
  return `cameraOrientation:${id}`;
}

function getStoredOrientation(id) {
  const stored = localStorage.getItem(orientationKey(id));
  return stored === "portrait" ? "portrait" : "landscape";
}

function storeOrientation(id, orientation) {
  localStorage.setItem(orientationKey(id), orientation);
}

function applyOrientation(videoWrap, orientation) {
  if (!videoWrap) return;
  videoWrap.classList.toggle("portrait", orientation === "portrait");
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

function buildRecordingName(camera, ext) {
  const base =
    (camera.name || camera.id || camera.path || "camera")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "camera";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${base}-${stamp}.${ext}`;
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

function stopRecording(id, ui) {
  const entry = activeRecorders.get(id);
  if (!entry) return;
  entry.recorder.stop();
  activeRecorders.delete(id);
  if (ui) {
    const connected = activePeers.has(id);
    ui.recIndicator.classList.add("hidden");
    ui.stopRecordBtn.classList.add("hidden");
    ui.stopRecordBtn.disabled = true;
    ui.recordBtn.disabled = !connected;
    if (ui.formatSelect) {
      ui.formatSelect.disabled = false;
    }
  }
}

function startRecording(id, camera, stream, ui, statusEl) {
  if (activeRecorders.has(id)) return;
  if (!stream) {
    setStatus(statusEl, "Sem stream para gravar", "err");
    return;
  }
  if (typeof MediaRecorder === "undefined") {
    setStatus(statusEl, "MediaRecorder indisponivel", "err");
    return;
  }

  const selectedFormat = ui.formatSelect ? ui.formatSelect.value : "webm";
  const selectionLabel = selectedFormat.toUpperCase();

  let recorder;
  const { mimeType, ext, supported } = pickRecorderOptions(selectedFormat);
  if (!supported) {
    setStatus(statusEl, `${selectionLabel} nao suportado neste navegador`, "err");
    return;
  }
  const options = mimeType ? { mimeType } : {};
  try {
    recorder = new MediaRecorder(stream, options);
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
    downloadRecording(blob, filename);
    if (activeRecorders.has(id)) {
      activeRecorders.delete(id);
    }
    if (ui) {
      const connected = activePeers.has(id);
      ui.recIndicator.classList.add("hidden");
      ui.stopRecordBtn.classList.add("hidden");
      ui.stopRecordBtn.disabled = true;
      ui.recordBtn.disabled = !connected;
      if (ui.formatSelect) {
        ui.formatSelect.disabled = false;
      }
    }
  });
  recorder.addEventListener("error", (event) => {
    setStatus(statusEl, "Erro na gravacao", "err");
    console.error(event);
  });

  activeRecorders.set(id, { recorder });
  recorder.start();
  ui.recIndicator.classList.remove("hidden");
  ui.recordBtn.disabled = true;
  ui.stopRecordBtn.disabled = false;
  ui.stopRecordBtn.classList.remove("hidden");
  if (ui.formatSelect) {
    ui.formatSelect.disabled = true;
  }
}

async function waitForOffer(baseUrl, path, session, lastFingerprint) {
  while (!session.stopped) {
    const data = await getSignal(baseUrl, "offer", path);
    if (data && data.sdp) {
      const fingerprint = offerFingerprint(data);
      if (lastFingerprint && fingerprint === lastFingerprint) {
        await delay(500);
        continue;
      }
      return data;
    }
    await delay(1000);
  }
  throw new Error("Cancelado");
}

async function startDirectStream({ id, videoEl, baseUrl, path, statusEl, session, onDisconnect }) {
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
    }
  });

  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "connected") {
      setStatus(statusEl, "Conectado", "ok");
    }
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      setStatus(statusEl, "Falha na conexao", "err");
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
  if (fingerprint) {
    lastAnsweredOffer.set(id, fingerprint);
  }
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
    activePeers.delete(id);
  }
  videoEl.srcObject = null;
  setStatus(statusEl, "Desconectado");
}

function renderCameras(cameras) {
  grid.innerHTML = "";
  cameraPaths.clear();
  cameras.forEach((camera) => {
    const node = template.content.cloneNode(true);
    const card = node.querySelector(".card");
    const nameEl = node.querySelector(".name");
    const connectBtn = node.querySelector(".connect");
    const disconnectBtn = node.querySelector(".disconnect");
    const orientationSelect = node.querySelector(".orientation-select");
    const fullscreenBtn = node.querySelector(".fullscreen");
    const formatSelect = node.querySelector(".format-select");
    const recordBtn = node.querySelector(".record");
    const stopRecordBtn = node.querySelector(".stop-record");
    const recIndicator = node.querySelector(".rec-indicator");
    const statusEl = node.querySelector(".status");
    const videoWrap = node.querySelector(".video-wrap");
    const videoEl = node.querySelector("video");

    nameEl.textContent = camera.name || camera.path || "Camera";
    card.dataset.id = camera.id || camera.path;
    const cameraId = card.dataset.id;
    const cameraPath = camera.path || camera.id || cameraId;
    cameraPaths.set(cameraId, cameraPath);
    setStatus(statusEl, "Aguardando");
    recordBtn.disabled = true;
    stopRecordBtn.disabled = true;

    const recordUi = { recordBtn, stopRecordBtn, recIndicator, formatSelect };

    if (orientationSelect) {
      const storedOrientation = getStoredOrientation(cameraId);
      orientationSelect.value = storedOrientation;
      applyOrientation(videoWrap, storedOrientation);
      orientationSelect.addEventListener("change", () => {
        const value = orientationSelect.value === "portrait" ? "portrait" : "landscape";
        applyOrientation(videoWrap, value);
        storeOrientation(cameraId, value);
      });
    }

    if (fullscreenBtn) {
      fullscreenBtn.addEventListener("click", () => {
        toggleFullscreen(videoWrap);
      });
    }

    connectBtn.addEventListener("click", async () => {
      const id = card.dataset.id;
      if (activePeers.has(id)) return;
      const session = { stopped: false, pc: null };
      activePeers.set(id, session);
      setStatus(statusEl, "Aguardando publisher...");
      connectBtn.disabled = true;

      try {
        const pc = await startDirectStream({
          id,
          videoEl,
          baseUrl: baseUrlInput.value.trim(),
          path: cameraPath,
          statusEl,
          session,
          onDisconnect: () => {
            stopRecording(id, recordUi);
            recordBtn.disabled = true;
            stopRecordBtn.disabled = true;
          },
        });
        if (session.stopped) {
          return;
        }
        connectBtn.classList.add("hidden");
        disconnectBtn.classList.remove("hidden");
        recordBtn.disabled = false;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Falha";
        if (message === "Cancelado" && session.stopped) {
          setStatus(statusEl, "Desconectado");
        } else {
          setStatus(statusEl, `Erro ao conectar (${message})`, "err");
          console.error(error);
          session.stopped = true;
        }
        activePeers.delete(id);
      } finally {
        connectBtn.disabled = false;
      }
    });

    disconnectBtn.addEventListener("click", () => {
      const id = card.dataset.id;
      stopRecording(id, recordUi);
      stopStream(id, videoEl, statusEl);
      resetSignal(baseUrlInput.value.trim(), cameraPath);
      disconnectBtn.classList.add("hidden");
      connectBtn.classList.remove("hidden");
      recordBtn.disabled = true;
      stopRecordBtn.disabled = true;
    });

    recordBtn.addEventListener("click", () => {
      const id = card.dataset.id;
      startRecording(id, camera, videoEl.srcObject, recordUi, statusEl);
    });

    stopRecordBtn.addEventListener("click", () => {
      const id = card.dataset.id;
      stopRecording(id, recordUi);
    });

    grid.appendChild(node);
  });
}

async function loadCameras() {
  try {
    const response = await fetch("cameras.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Nao foi possivel carregar cameras.json");
    }
    const data = await response.json();
    renderCameras(Array.isArray(data) ? data : []);
  } catch (error) {
    console.error(error);
    grid.innerHTML = "<div class=\"status err\">Erro ao carregar cameras.</div>";
  }
}

function init() {
  const stored = localStorage.getItem("baseUrl");
  baseUrlInput.value = stored || DEFAULT_SIGNAL_BASE;
  if (baseUrlInput.value.includes(":8889")) {
    baseUrlInput.value = DEFAULT_SIGNAL_BASE;
  }

  baseUrlInput.addEventListener("change", () => {
    localStorage.setItem("baseUrl", baseUrlInput.value.trim());
  });
  reloadButton.addEventListener("click", loadCameras);
  loadCameras();

  window.addEventListener("pagehide", () => {
    const baseUrl = baseUrlInput.value.trim() || DEFAULT_SIGNAL_BASE;
    for (const [id] of activePeers) {
      const path = cameraPaths.get(id) || id;
      resetSignalBeacon(baseUrl, path);
    }
  });
}

init();
