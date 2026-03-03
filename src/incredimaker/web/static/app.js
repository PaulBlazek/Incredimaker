const preferredByRole = {
  beat: "top-left",
  bass: "top-right",
  fx: "top-right",
  harmony: "bottom-left",
  melody: "bottom-right",
  vocals: "bottom-right",
};

const rolePriority = ["beat", "bass", "fx", "harmony", "melody", "vocals"];

const state = {
  boxes: [],
  currentBoxId: null,
  currentBox: null,
  slots: [],
  audioCtx: null,
  transportStart: null,
  masterGain: null,
  players: new Map(), // slotId -> {source, gain, charId}
  bufferCache: new Map(), // charId -> AudioBuffer
  transportRafId: null,
};

const boxSelect = document.getElementById("boxSelect");
const slotCountInput = document.getElementById("slotCount");
const stageEl = document.getElementById("stage");
const paletteEl = document.getElementById("palette");
const refreshBtn = document.getElementById("refreshBtn");
const clearBtn = document.getElementById("clearBtn");
const transportStatus = document.getElementById("transportStatus");
const transportMeter = document.getElementById("transportMeter");
const loopIndexText = document.getElementById("loopIndexText");
const loopProgressText = document.getElementById("loopProgressText");
const loopProgressFill = document.getElementById("loopProgressFill");
const paletteTpl = document.getElementById("paletteItemTpl");

function sortedCharacters(chars) {
  return [...chars].sort((a, b) => {
    const ia = rolePriority.indexOf(a.role);
    const ib = rolePriority.indexOf(b.role);
    const ra = ia === -1 ? 999 : ia;
    const rb = ib === -1 ? 999 : ib;
    if (ra !== rb) return ra - rb;
    return a.id.localeCompare(b.id);
  });
}

function characterLabel(charInfo) {
  const [, n] = charInfo.id.split("_");
  return `${charInfo.role} ${n || ""}`.trim();
}

function getQuadrantForPosition(rowIndex, colIndex, rows, cols) {
  const top = rowIndex < rows / 2;
  const left = colIndex < cols / 2;
  if (top && left) return "top-left";
  if (top && !left) return "top-right";
  if (!top && left) return "bottom-left";
  return "bottom-right";
}

function getHintForQuadrant(quadrant) {
  if (quadrant === "top-left") return "Beat";
  if (quadrant === "top-right") return "Bass / FX";
  if (quadrant === "bottom-left") return "Harmony";
  return "Melody / Vocals";
}

function computeGrid(count) {
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  return { cols, rows };
}

function buildAudioUrl(boxId, charId) {
  return `/api/boxes/${encodeURIComponent(boxId)}/audio/${encodeURIComponent(charId)}`;
}

function getCurrentLoopSeconds() {
  return state.currentBox?.loop_seconds || 4.0;
}

function ensureAudioContext() {
  if (!state.audioCtx) {
    state.audioCtx = new AudioContext();
    state.masterGain = state.audioCtx.createGain();
    state.masterGain.gain.value = 0.9;
    state.masterGain.connect(state.audioCtx.destination);
  }
  if (state.audioCtx.state !== "running") {
    state.audioCtx.resume().catch(() => {});
  }
  if (state.transportStart === null) {
    state.transportStart = state.audioCtx.currentTime + 0.05;
  }
}

function nextLoopBoundary(afterSeconds = 0.03) {
  ensureAudioContext();
  const now = state.audioCtx.currentTime + afterSeconds;
  const loop = getCurrentLoopSeconds();
  if (now <= state.transportStart) return state.transportStart;
  const loopsSinceStart = Math.ceil((now - state.transportStart) / loop);
  return state.transportStart + loopsSinceStart * loop;
}

function stopPlayer(slotId, when) {
  const player = state.players.get(slotId);
  if (!player) return;
  player.gain.gain.setValueAtTime(player.gain.gain.value, when);
  player.gain.gain.linearRampToValueAtTime(0.0, when + 0.01);
  player.source.stop(when + 0.02);
  state.players.delete(slotId);
}

function isAnyAudioPlaying() {
  return state.players.size > 0;
}

async function getBuffer(charId) {
  if (state.bufferCache.has(charId)) return state.bufferCache.get(charId);
  const response = await fetch(buildAudioUrl(state.currentBoxId, charId));
  const arrayBuffer = await response.arrayBuffer();
  const buffer = await state.audioCtx.decodeAudioData(arrayBuffer);
  state.bufferCache.set(charId, buffer);
  return buffer;
}

async function startCharacterInSlot(slot, charInfo, when) {
  const buffer = await getBuffer(charInfo.id);
  if (!state.audioCtx || !state.masterGain) return;
  const loopSeconds = getCurrentLoopSeconds() * (charInfo.loop_multiple || 1);
  const source = state.audioCtx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.loopStart = 0;
  source.loopEnd = Math.min(loopSeconds, buffer.duration);

  const gain = state.audioCtx.createGain();
  gain.gain.setValueAtTime(0.0, when);
  gain.gain.linearRampToValueAtTime(1.0, when + 0.01);
  source.connect(gain);
  gain.connect(state.masterGain);
  source.start(when);

  state.players.set(slot.id, { source, gain, charId: charInfo.id });
}

async function scheduleSlotUpdate(slot, charInfo) {
  ensureAudioContext();
  const boundary = nextLoopBoundary();
  slot.pending = true;
  slot.pendingCharId = charInfo ? charInfo.id : null;
  renderStage();

  stopPlayer(slot.id, boundary);
  if (charInfo) {
    await startCharacterInSlot(slot, charInfo, boundary);
  }

  slot.charId = charInfo ? charInfo.id : null;
  slot.pending = false;
  slot.pendingCharId = null;
  renderStage();
  updateTransportStatus();
}

function stopAllPlayersNow() {
  if (!state.audioCtx) return;
  const now = state.audioCtx.currentTime + 0.01;
  for (const slot of state.slots) {
    stopPlayer(slot.id, now);
    slot.charId = null;
    slot.pending = false;
    slot.pendingCharId = null;
  }
  renderStage();
  updateTransportStatus();
}

function clearStageQuantized() {
  for (const slot of state.slots) {
    scheduleSlotUpdate(slot, null).catch(console.error);
  }
}

function getCharacterById(charId) {
  if (!state.currentBox) return null;
  return state.currentBox.characters.find((c) => c.id === charId) || null;
}

function assignCharacterToSlot(slotId, charId) {
  const charInfo = getCharacterById(charId);
  if (!charInfo) return;

  for (const slot of state.slots) {
    if (slot.id !== slotId && slot.charId === charId) {
      scheduleSlotUpdate(slot, null).catch(console.error);
    }
  }

  const slot = state.slots.find((s) => s.id === slotId);
  if (!slot) return;
  scheduleSlotUpdate(slot, charInfo).catch(console.error);
}

function createSlotNodes() {
  stageEl.innerHTML = "";
  const count = Number(slotCountInput.value) || 9;
  const safeCount = Math.min(Math.max(count, 4), 16);
  const { cols, rows } = computeGrid(safeCount);
  stageEl.style.gridTemplateColumns = `repeat(${cols}, minmax(90px, 1fr))`;

  const existing = new Map(state.slots.map((slot) => [slot.id, slot]));
  state.slots = Array.from({ length: safeCount }, (_, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const quadrant = getQuadrantForPosition(row, col, rows, cols);
    return existing.get(i) || { id: i, charId: null, pending: false, pendingCharId: null, quadrant };
  });

  for (const oldSlotId of existing.keys()) {
    if (oldSlotId >= safeCount) {
      stopPlayer(oldSlotId, state.audioCtx ? state.audioCtx.currentTime + 0.01 : 0);
    }
  }
  renderStage();
}

function renderStage() {
  stageEl.innerHTML = "";
  for (const slot of state.slots) {
    const assigned = slot.charId ? getCharacterById(slot.charId) : null;
    const pending = slot.pendingCharId ? getCharacterById(slot.pendingCharId) : null;
    const el = document.createElement("div");
    el.className = "slot";
    el.dataset.slotId = String(slot.id);

    if (assigned) {
      el.innerHTML = `<div class="assigned">${characterLabel(assigned)}</div><div class="hint">Double-click: mute next loop</div>`;
    } else {
      el.innerHTML = `<div class="hint">${getHintForQuadrant(slot.quadrant)}</div>`;
    }
    if (slot.pending && pending) {
      const p = document.createElement("div");
      p.className = "pending";
      p.textContent = `Queued: ${characterLabel(pending)}`;
      el.appendChild(p);
    } else if (slot.pending && !pending) {
      const p = document.createElement("div");
      p.className = "pending";
      p.textContent = "Queued: mute";
      el.appendChild(p);
    }

    el.addEventListener("dragover", (event) => {
      event.preventDefault();
      el.classList.add("over");
    });
    el.addEventListener("dragleave", () => {
      el.classList.remove("over");
    });
    el.addEventListener("drop", (event) => {
      event.preventDefault();
      el.classList.remove("over");
      const charId = event.dataTransfer.getData("text/plain");
      if (charId) assignCharacterToSlot(slot.id, charId);
    });
    el.addEventListener("dblclick", () => {
      scheduleSlotUpdate(slot, null).catch(console.error);
    });

    stageEl.appendChild(el);
  }
}

function preferredSlotIdForRole(role) {
  const targetQuadrant = preferredByRole[role];
  if (!targetQuadrant) return null;
  const preferred = state.slots.find((slot) => slot.quadrant === targetQuadrant && !slot.charId);
  return preferred ? preferred.id : null;
}

async function preloadCharacters() {
  ensureAudioContext();
  for (const c of state.currentBox.characters) {
    try {
      await getBuffer(c.id);
    } catch (err) {
      console.error("Failed to preload", c.id, err);
    }
  }
}

function renderPalette(characters) {
  paletteEl.innerHTML = "";
  const ordered = sortedCharacters(characters);
  for (const charInfo of ordered) {
    const node = paletteTpl.content.firstElementChild.cloneNode(true);
    node.querySelector(".name").textContent = characterLabel(charInfo);
    node.querySelector(".role").textContent = `${charInfo.role} x${charInfo.loop_multiple || 1}`;

    node.addEventListener("dragstart", (event) => {
      ensureAudioContext();
      event.dataTransfer.setData("text/plain", charInfo.id);
      event.dataTransfer.effectAllowed = "copyMove";
    });
    node.addEventListener("click", () => {
      ensureAudioContext();
      const preferredSlotId = preferredSlotIdForRole(charInfo.role);
      const fallback = state.slots.find((slot) => !slot.charId);
      if (preferredSlotId !== null) {
        assignCharacterToSlot(preferredSlotId, charInfo.id);
      } else if (fallback) {
        assignCharacterToSlot(fallback.id, charInfo.id);
      }
    });

    paletteEl.appendChild(node);
  }
}

function populateBoxSelect(boxes) {
  boxSelect.innerHTML = "";
  for (const box of boxes) {
    const option = document.createElement("option");
    option.value = box.id;
    option.textContent = box.name;
    boxSelect.appendChild(option);
  }
}

function updateTransportStatus() {
  const loopSec = getCurrentLoopSeconds().toFixed(2);
  const active = state.slots.filter((s) => s.charId).length;
  transportStatus.textContent = `Loop ${loopSec}s | Active ${active}`;
  updateTransportMeterVisibility();
}

function updateTransportMeterVisibility() {
  if (isAnyAudioPlaying()) {
    transportMeter.classList.remove("hidden");
    startTransportMeter();
  } else {
    transportMeter.classList.add("hidden");
    stopTransportMeter();
  }
}

function updateTransportMeterFrame() {
  if (!state.audioCtx || state.transportStart === null || !isAnyAudioPlaying()) {
    return;
  }

  const loopSeconds = getCurrentLoopSeconds();
  const elapsed = Math.max(0, state.audioCtx.currentTime - state.transportStart);
  const loopPhase = elapsed % loopSeconds;
  const progress = loopPhase / loopSeconds;
  const loopIndex = (Math.floor(elapsed / loopSeconds) % 2) + 1;

  loopIndexText.textContent = `Loop ${loopIndex}/2`;
  loopProgressText.textContent = `${Math.round(progress * 100)}%`;
  loopProgressFill.style.width = `${(progress * 100).toFixed(1)}%`;

  state.transportRafId = window.requestAnimationFrame(updateTransportMeterFrame);
}

function startTransportMeter() {
  if (state.transportRafId !== null) return;
  state.transportRafId = window.requestAnimationFrame(updateTransportMeterFrame);
}

function stopTransportMeter() {
  if (state.transportRafId !== null) {
    window.cancelAnimationFrame(state.transportRafId);
    state.transportRafId = null;
  }
  loopIndexText.textContent = "Loop 1/2";
  loopProgressText.textContent = "0%";
  loopProgressFill.style.width = "0%";
}

async function activateBox(boxId) {
  state.currentBoxId = boxId;
  state.currentBox = state.boxes.find((b) => b.id === boxId) || null;
  state.bufferCache.clear();
  stopAllPlayersNow();
  if (!state.currentBox) {
    paletteEl.innerHTML = "<p>No box selected.</p>";
    return;
  }
  renderPalette(state.currentBox.characters);
  await preloadCharacters();
  updateTransportStatus();
}

async function loadBoxes() {
  const response = await fetch("/api/boxes");
  const data = await response.json();
  state.boxes = data.boxes || [];
  populateBoxSelect(state.boxes);

  if (!state.boxes.length) {
    state.currentBoxId = null;
    state.currentBox = null;
    paletteEl.innerHTML = "<p>No boxes found in library directory.</p>";
    stopAllPlayersNow();
    updateTransportStatus();
    return;
  }

  if (!state.currentBoxId || !state.boxes.some((b) => b.id === state.currentBoxId)) {
    state.currentBoxId = state.boxes[0].id;
  }
  boxSelect.value = state.currentBoxId;
  await activateBox(state.currentBoxId);
}

boxSelect.addEventListener("change", () => {
  activateBox(boxSelect.value).catch(console.error);
});

slotCountInput.addEventListener("change", () => {
  createSlotNodes();
  updateTransportStatus();
});

refreshBtn.addEventListener("click", () => {
  loadBoxes().catch(console.error);
});

clearBtn.addEventListener("click", () => {
  clearStageQuantized();
});

window.addEventListener("pointerdown", () => {
  ensureAudioContext();
}, { once: true });

createSlotNodes();
updateTransportStatus();
loadBoxes().catch(console.error);
