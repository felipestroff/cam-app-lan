const signalInput = document.getElementById("signalBase");
const mediaInput = document.getElementById("mediaBase");
const recordingsInput = document.getElementById("recordingsDir");
const forceHttpsInput = document.getElementById("forceHttps");
const logsVerboseInput = document.getElementById("logsVerbose");
const recordingFormatSelect = document.getElementById("recordingFormat");
const recordingNameInput = document.getElementById("recordingNamePattern");
const motionDefaultEnabled = document.getElementById("motionDefaultEnabled");
const motionDefaultSensitivity = document.getElementById("motionDefaultSensitivity");
const motionDefaultValue = document.getElementById("motionDefaultValue");
const motionDefaultStop = document.getElementById("motionDefaultStop");
const motionDefaultStopValue = document.getElementById("motionDefaultStopValue");
const mediamtxStatus = document.getElementById("mediamtxStatus");
const resolvedEl = document.getElementById("resolvedDir");
const statusEl = document.getElementById("status");
const saveBtn = document.getElementById("save");
const reloadBtn = document.getElementById("reload");
const logEl = document.getElementById("log");
const clearLogBtn = document.getElementById("clearLog");

const DEFAULT_SIGNAL_BASE = window.location.origin;
const DEFAULT_MEDIA_BASE = `${window.location.protocol}//${window.location.hostname}:8889`;
const DEFAULT_RECORDING_FORMAT = "mp4";
const DEFAULT_RECORDING_NAME = "{camera}-{data}-{hora}";
const DEFAULT_MOTION = { enabled: false, sensitivity: 60, stopAfter: 6 };

function logLine(message) {
  if (!logEl) return;
  const time = new Date().toISOString().slice(11, 19);
  logEl.textContent += `[${time}] ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.classList.remove("ok", "err");
  if (kind) statusEl.classList.add(kind);
}

function setMediaStatus(text, kind) {
  if (!mediamtxStatus) return;
  mediamtxStatus.textContent = text;
  mediamtxStatus.classList.remove("ok", "err");
  if (kind) mediamtxStatus.classList.add(kind);
}

function updateMotionLabels() {
  if (motionDefaultValue && motionDefaultSensitivity) {
    motionDefaultValue.textContent = motionDefaultSensitivity.value;
  }
  if (motionDefaultStopValue && motionDefaultStop) {
    motionDefaultStopValue.textContent = `${motionDefaultStop.value}s`;
  }
}

async function checkMediaStatus() {
  if (!mediamtxStatus) return;
  setMediaStatus("MediaMTX: checando...");
  try {
    const response = await fetch(`${window.location.origin}/mediamtx/status`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Status error: ${response.status}`);
    }
    const data = await response.json();
    if (data.ok) {
      setMediaStatus(`MediaMTX: online (${data.status || "ok"})`, "ok");
    } else {
      setMediaStatus("MediaMTX: offline", "err");
    }
  } catch (error) {
    setMediaStatus("MediaMTX: offline", "err");
  }
}

async function loadConfig() {
  setStatus("Carregando...");
  if (signalInput) {
    signalInput.value = DEFAULT_SIGNAL_BASE;
  }
  if (mediaInput) {
    mediaInput.value = DEFAULT_MEDIA_BASE;
  }
  if (recordingFormatSelect) {
    recordingFormatSelect.value = DEFAULT_RECORDING_FORMAT;
  }
  if (recordingNameInput) {
    recordingNameInput.value = DEFAULT_RECORDING_NAME;
  }
  if (forceHttpsInput) {
    forceHttpsInput.checked = false;
  }
  if (logsVerboseInput) {
    logsVerboseInput.checked = true;
  }
  if (motionDefaultEnabled) {
    motionDefaultEnabled.checked = DEFAULT_MOTION.enabled;
  }
  if (motionDefaultSensitivity) {
    motionDefaultSensitivity.value = DEFAULT_MOTION.sensitivity;
  }
  if (motionDefaultStop) {
    motionDefaultStop.value = DEFAULT_MOTION.stopAfter;
  }
  updateMotionLabels();
  try {
    const response = await fetch(`${window.location.origin}/config`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Config error: ${response.status}`);
    }
    const data = await response.json();
    if (signalInput) {
      signalInput.value = data.signalBase || DEFAULT_SIGNAL_BASE;
    }
    if (mediaInput) {
      mediaInput.value = data.mediaBase || DEFAULT_MEDIA_BASE;
    }
    if (recordingFormatSelect) {
      recordingFormatSelect.value = data.recordingFormat || DEFAULT_RECORDING_FORMAT;
    }
    if (recordingNameInput) {
      recordingNameInput.value = data.recordingNamePattern || DEFAULT_RECORDING_NAME;
    }
    if (forceHttpsInput) {
      forceHttpsInput.checked = Boolean(data.forceHttps);
    }
    if (logsVerboseInput) {
      logsVerboseInput.checked = data.logsVerbose !== false;
    }
    if (data.motionDefaults) {
      if (motionDefaultEnabled && typeof data.motionDefaults.enabled === "boolean") {
        motionDefaultEnabled.checked = data.motionDefaults.enabled;
      }
      if (motionDefaultSensitivity && Number.isFinite(Number(data.motionDefaults.sensitivity))) {
        motionDefaultSensitivity.value = data.motionDefaults.sensitivity;
      }
      if (motionDefaultStop && Number.isFinite(Number(data.motionDefaults.stopAfter))) {
        motionDefaultStop.value = data.motionDefaults.stopAfter;
      }
    }
    updateMotionLabels();
    if (recordingsInput) {
      recordingsInput.value = data.recordingsDir || "";
    }
    if (resolvedEl) {
      resolvedEl.textContent = data.recordingsDirResolved || "-";
    }
    setStatus("Pronto", "ok");
    logLine("Configuracao carregada");
    checkMediaStatus();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha";
    setStatus(`Erro ao carregar (${message})`, "err");
    logLine(`Erro ao carregar: ${message}`);
  }
}

async function saveConfig() {
  const signalBase = signalInput ? signalInput.value.trim() : "";
  const mediaBase = mediaInput ? mediaInput.value.trim() : "";
  const recordingsDir = recordingsInput ? recordingsInput.value.trim() : "";
  const recordingFormat = recordingFormatSelect ? recordingFormatSelect.value : DEFAULT_RECORDING_FORMAT;
  const recordingNamePattern = recordingNameInput ? recordingNameInput.value.trim() : "";
  const forceHttps = forceHttpsInput ? forceHttpsInput.checked : false;
  const logsVerbose = logsVerboseInput ? logsVerboseInput.checked : true;
  const motionDefaults = {
    enabled: motionDefaultEnabled ? motionDefaultEnabled.checked : DEFAULT_MOTION.enabled,
    sensitivity: motionDefaultSensitivity ? Number(motionDefaultSensitivity.value) : DEFAULT_MOTION.sensitivity,
    stopAfter: motionDefaultStop ? Number(motionDefaultStop.value) : DEFAULT_MOTION.stopAfter,
  };
  setStatus("Salvando...");
  try {
    const response = await fetch(`${window.location.origin}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recordingsDir,
        signalBase,
        mediaBase,
        recordingFormat,
        recordingNamePattern,
        forceHttps,
        logsVerbose,
        motionDefaults,
      }),
    });
    if (!response.ok) {
      throw new Error(`Config error: ${response.status}`);
    }
    const data = await response.json();
    if (signalInput) {
      signalInput.value = data.signalBase || DEFAULT_SIGNAL_BASE;
    }
    if (mediaInput) {
      mediaInput.value = data.mediaBase || DEFAULT_MEDIA_BASE;
    }
    if (recordingFormatSelect) {
      recordingFormatSelect.value = data.recordingFormat || DEFAULT_RECORDING_FORMAT;
    }
    if (recordingNameInput) {
      recordingNameInput.value = data.recordingNamePattern || DEFAULT_RECORDING_NAME;
    }
    if (forceHttpsInput) {
      forceHttpsInput.checked = Boolean(data.forceHttps);
    }
    if (logsVerboseInput) {
      logsVerboseInput.checked = data.logsVerbose !== false;
    }
    if (data.motionDefaults) {
      if (motionDefaultEnabled && typeof data.motionDefaults.enabled === "boolean") {
        motionDefaultEnabled.checked = data.motionDefaults.enabled;
      }
      if (motionDefaultSensitivity && Number.isFinite(Number(data.motionDefaults.sensitivity))) {
        motionDefaultSensitivity.value = data.motionDefaults.sensitivity;
      }
      if (motionDefaultStop && Number.isFinite(Number(data.motionDefaults.stopAfter))) {
        motionDefaultStop.value = data.motionDefaults.stopAfter;
      }
    }
    updateMotionLabels();
    if (recordingsInput) {
      recordingsInput.value = data.recordingsDir || "";
    }
    if (resolvedEl) {
      resolvedEl.textContent = data.recordingsDirResolved || "-";
    }
    setStatus("Salvo", "ok");
    logLine("Configuracao salva");
    checkMediaStatus();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha";
    setStatus(`Erro ao salvar (${message})`, "err");
    logLine(`Erro ao salvar: ${message}`);
  }
}

function init() {
  loadConfig();
  if (saveBtn) {
    saveBtn.addEventListener("click", saveConfig);
  }
  if (reloadBtn) {
    reloadBtn.addEventListener("click", loadConfig);
  }
  if (motionDefaultSensitivity) {
    motionDefaultSensitivity.addEventListener("input", updateMotionLabels);
  }
  if (motionDefaultStop) {
    motionDefaultStop.addEventListener("input", updateMotionLabels);
  }
  if (clearLogBtn && logEl) {
    clearLogBtn.addEventListener("click", () => {
      logEl.textContent = "";
      logLine("Logs limpos");
    });
  }
}

init();
