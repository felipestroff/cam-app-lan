const DEFAULT_SIGNAL_BASE = window.location.origin;
const baseInput = document.getElementById("signalBase");
const pathInput = document.getElementById("path");
const audioInput = document.getElementById("audio");
const facingSelect = document.getElementById("facing");
const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const statusEl = document.getElementById("status");
const previewEl = document.getElementById("preview");
const warningEl = document.getElementById("secureWarning");
const logEl = document.getElementById("log");
const clearLogBtn = document.getElementById("clearLog");

let pc = null;
let stream = null;
let stopRequested = false;
let lastBaseUrl = "";
let lastPath = "";
let restartTimer = null;
let restartInFlight = false;

function logLine(message) {
  if (!logEl) return;
  const time = new Date().toISOString().slice(11, 19);
  logEl.textContent += `[${time}] ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function formatError(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown error";
  }
}

function hasActiveStream(input) {
  if (!input) return false;
  return input.getTracks().some((track) => track.readyState === "live");
}

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

function clearRestartTimer() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
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
  return response;
}

async function sendResetSignal() {
  if (!lastBaseUrl || !lastPath) return;
  try {
    await postSignal(lastBaseUrl, "reset", { path: lastPath });
    logLine("Signal reset sent");
  } catch (error) {
    logLine(`Signal reset failed: ${formatError(error)}`);
  }
}

async function restartPublish(reason) {
  if (restartInFlight || stopRequested) return;
  restartInFlight = true;
  clearRestartTimer();
  setStatus("Reconectando...", "err");
  logLine(`Auto-restart (${reason})`);
  await sendResetSignal();
  if (pc) {
    pc.close();
    pc = null;
    logLine("Peer connection closed");
  }
  await delay(800);
  try {
    await startPublish();
  } finally {
    restartInFlight = false;
  }
}

function scheduleRestart(reason) {
  if (stopRequested || restartInFlight || restartTimer) return;
  logLine(`Scheduling reconnect (${reason})`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    const state = pc ? pc.connectionState : "none";
    const iceState = pc ? pc.iceConnectionState : "none";
    if (state === "failed" || state === "disconnected" || iceState === "failed" || iceState === "disconnected") {
      restartPublish(reason).catch((error) => {
        logLine(`Auto-restart failed: ${formatError(error)}`);
      });
    } else {
      logLine(`Reconnect canceled (state=${state}, ice=${iceState})`);
    }
  }, 1200);
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

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.classList.remove("ok", "err");
  if (kind) statusEl.classList.add(kind);
}

function waitForIceGathering(peer) {
  if (peer.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const handler = () => {
      if (peer.iceGatheringState === "complete") {
        peer.removeEventListener("icegatheringstatechange", handler);
        resolve();
      }
    };
    peer.addEventListener("icegatheringstatechange", handler);
  });
}

async function waitForAnswer(baseUrl, path) {
  while (!stopRequested) {
    const data = await getSignal(baseUrl, "answer", path);
    if (data && data.sdp) {
      return data;
    }
    await delay(1000);
  }
  throw new Error("Cancelado");
}

async function startPublish() {
  if (pc) return;

  clearRestartTimer();
  stopRequested = false;
  const baseUrl = baseInput.value.trim() || DEFAULT_SIGNAL_BASE;
  const path = pathInput.value.trim();
  if (!path) {
    setStatus("Informe um path", "err");
    logLine("Start blocked: missing path");
    return;
  }

  startBtn.disabled = true;
  stopBtn.disabled = false;

  lastBaseUrl = baseUrl;
  lastPath = path;

  if (!window.isSecureContext) {
    warningEl.classList.remove("hidden");
    logLine("Warning: insecure context");
  }

  try {
    setStatus("Abrindo camera...");
    logLine(`Starting publish: base=${baseUrl} path=${path}`);
    const facing = facingSelect.value;
    const audioEnabled = audioInput.checked;

    if (!hasActiveStream(stream)) {
      let constraints;
      if (facing === "auto") {
        constraints = { video: true, audio: audioEnabled };
      } else {
        constraints = {
          video: { facingMode: { ideal: facing } },
          audio: audioEnabled,
        };
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        logLine("getUserMedia ok (preferred constraints)");
      } catch (error) {
        logLine(`getUserMedia failed: ${formatError(error)}`);
        if (facing !== "auto") {
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: audioEnabled,
          });
          logLine("getUserMedia ok (fallback constraints)");
        } else {
          throw error;
        }
      }

      previewEl.srcObject = stream;
      stream.getTracks().forEach((track) => {
        logLine(`Track added: ${track.kind}`);
        track.addEventListener("ended", () => {
          setStatus("Camera parada");
          logLine(`Track ended: ${track.kind}`);
        });
      });
    }

    pc = new RTCPeerConnection();
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    pc.addEventListener("connectionstatechange", () => {
      logLine(`Connection state: ${pc.connectionState}`);
      if (pc.connectionState === "connected") {
        setStatus("Transmitindo", "ok");
      }
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        setStatus("Falha na conexao", "err");
        scheduleRestart(pc.connectionState);
      }
    });
    pc.addEventListener("iceconnectionstatechange", () => {
      logLine(`ICE state: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
        scheduleRestart(`ice-${pc.iceConnectionState}`);
      }
    });
    pc.addEventListener("signalingstatechange", () => {
      logLine(`Signaling state: ${pc.signalingState}`);
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);

    logLine("Signal POST -> /signal/offer");
    await postSignal(baseUrl, "offer", {
      path,
      type: pc.localDescription.type,
      sdp: pc.localDescription.sdp,
    });
    logLine("Offer sent");

    setStatus("Aguardando viewer...");
    logLine("Waiting for answer...");
    const answer = await waitForAnswer(baseUrl, path);
    await pc.setRemoteDescription(answer);
    logLine("Answer set");
    setStatus("Conectando...");

    startBtn.disabled = true;
    stopBtn.disabled = false;
    logLine("Publish started");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha";
    if (message === "Cancelado" && stopRequested) {
      logLine("Publish canceled");
      return;
    }
    setStatus(`Erro ao iniciar (${message})`, "err");
    logLine(`Publish failed: ${formatError(error)}`);
    console.error(error);
    if (pc) {
      pc.close();
      pc = null;
    }
    startBtn.disabled = false;
    stopBtn.disabled = false;
  }
}

async function stopPublish() {
  stopRequested = true;
  clearRestartTimer();
  await sendResetSignal();

  if (pc) {
    pc.close();
    pc = null;
    logLine("Peer connection closed");
  }
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
    logLine("Media tracks stopped");
  }

  previewEl.srcObject = null;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus("Parado");
  logLine("Publish stopped");
}

function init() {
  const storedBase = localStorage.getItem("signalBase") || localStorage.getItem("whipBase");
  const storedPath = localStorage.getItem("signalPath") || localStorage.getItem("whipPath");
  baseInput.value = storedBase || DEFAULT_SIGNAL_BASE;
  if (baseInput.value.includes(":8889")) {
    baseInput.value = DEFAULT_SIGNAL_BASE;
  }
  pathInput.value = storedPath || "cam1";

  logLine(`Init: base=${baseInput.value} path=${pathInput.value}`);

  baseInput.addEventListener("change", () => {
    localStorage.setItem("signalBase", baseInput.value.trim());
  });
  pathInput.addEventListener("change", () => {
    localStorage.setItem("signalPath", pathInput.value.trim());
  });

  startBtn.addEventListener("click", startPublish);
  stopBtn.addEventListener("click", stopPublish);
  if (clearLogBtn) {
    clearLogBtn.addEventListener("click", () => {
      logEl.textContent = "";
      logLine("Logs limpos");
    });
  }

  window.addEventListener("error", (event) => {
    logLine(`Window error: ${event.message}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    logLine(`Unhandled rejection: ${formatError(event.reason)}`);
  });

  if (!window.isSecureContext) {
    warningEl.classList.remove("hidden");
    logLine("Warning: insecure context");
  }
}

init();
