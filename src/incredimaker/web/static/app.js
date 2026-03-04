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
  autoModeEnabled: false,
  autoLastLoopNumber: -1,
  autoBusy: false,
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
const autoModeToggle = document.getElementById("autoModeToggle");
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
  const loopMultiple = Math.max(1, Number(charInfo.loop_multiple) || 1);
  return `${charInfo.role} ${n || ""} [x${loopMultiple}]`.trim();
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

function clearSlotPlaybackImmediately(slot) {
  if (!state.audioCtx) return;
  const now = state.audioCtx.currentTime + 0.005;
  stopPlayer(slot.id, now);
  slot.charId = null;
  slot.pending = false;
  slot.pendingCharId = null;
  if (!isAnyAudioPlaying()) {
    state.transportStart = null;
    state.autoLastLoopNumber = -1;
  }
}

function isAnyAudioPlaying() {
  return state.players.size > 0;
}

function getActiveMaxLoopMultiple() {
  let maxMultiple = 1;
  for (const player of state.players.values()) {
    const charInfo = getCharacterById(player.charId);
    if (!charInfo) continue;
    const loopMultiple = Math.max(1, Number(charInfo.loop_multiple) || 1);
    if (loopMultiple > maxMultiple) maxMultiple = loopMultiple;
  }
  return maxMultiple;
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

function randomIntInclusive(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandom(items) {
  if (!items.length) return null;
  return items[Math.floor(Math.random() * items.length)];
}

function getLoopNumberNow() {
  if (!state.audioCtx || state.transportStart === null) return 0;
  const elapsed = Math.max(0, state.audioCtx.currentTime - state.transportStart);
  return Math.floor(elapsed / getCurrentLoopSeconds());
}

async function addCharacterImmediatelyToSlot(slot, charInfo) {
  if (!state.audioCtx) return;
  const when = state.audioCtx.currentTime + 0.02;
  await startCharacterInSlot(slot, charInfo, when);
  slot.charId = charInfo.id;
  slot.pending = false;
  slot.pendingCharId = null;
}

async function runAutoModeForLoop() {
  if (state.autoBusy || !state.currentBox || !state.audioCtx) return;
  state.autoBusy = true;
  try {
    const actions = randomIntInclusive(1, 3);
    for (let i = 0; i < actions; i += 1) {
      const filledSlots = state.slots.filter((s) => !!s.charId);
      const emptySlots = state.slots.filter((s) => !s.charId);
      const activeIds = new Set(filledSlots.map((s) => s.charId));
      const inactiveChars = state.currentBox.characters.filter((c) => !activeIds.has(c.id));

      const canRemove = filledSlots.length > 0;
      const canAdd = emptySlots.length > 0 && inactiveChars.length > 0;
      if (!canRemove && !canAdd) break;

      const shouldAdd = canAdd && (!canRemove || Math.random() < 0.55);
      if (shouldAdd) {
        const targetSlot = pickRandom(emptySlots);
        const charInfo = pickRandom(inactiveChars);
        if (targetSlot && charInfo) {
          await addCharacterImmediatelyToSlot(targetSlot, charInfo);
        }
      } else {
        const targetSlot = pickRandom(filledSlots);
        if (targetSlot) {
          clearSlotPlaybackImmediately(targetSlot);
        }
      }
    }
  } finally {
    state.autoBusy = false;
    renderStage();
    updateTransportStatus();
  }
}

async function scheduleSlotUpdate(slot, charInfo) {
  ensureAudioContext();
  const isStartingFromSilence = !isAnyAudioPlaying() && !!charInfo;
  let boundary = nextLoopBoundary();
  if (isStartingFromSilence && state.audioCtx) {
    boundary = state.audioCtx.currentTime + 0.02;
    state.transportStart = boundary;
  }
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
  state.transportStart = null;
  state.autoLastLoopNumber = -1;
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
  ensureAudioContext();

  const targetSlot = state.slots.find((s) => s.id === slotId);
  if (!targetSlot) return;

  // Moving/replacing via drop should mute previous audio immediately.
  for (const slot of state.slots) {
    if (slot.id !== slotId && slot.charId === charId) {
      clearSlotPlaybackImmediately(slot);
    }
  }

  if (targetSlot.charId && targetSlot.charId !== charId) {
    clearSlotPlaybackImmediately(targetSlot);
  }

  renderStage();
  updateTransportStatus();
  scheduleSlotUpdate(targetSlot, charInfo).catch(console.error);
}

function createSlotNodes() {
  stageEl.innerHTML = "";
  const count = Number(slotCountInput.value) || 9;
  const safeCount = Math.min(Math.max(count, 4), 16);
  const { cols } = computeGrid(safeCount);
  stageEl.style.gridTemplateColumns = `repeat(${cols}, minmax(90px, 1fr))`;

  const existing = new Map(state.slots.map((slot) => [slot.id, slot]));
  state.slots = Array.from({ length: safeCount }, (_, i) => {
    return existing.get(i) || { id: i, charId: null, pending: false, pendingCharId: null };
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
      el.innerHTML = `<div class="assigned">${characterLabel(assigned)}</div><div class="hint">Click: remove now</div>`;
    } else {
      el.innerHTML = `<div class="hint">Drop character here</div>`;
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
    el.addEventListener("click", () => {
      if (!slot.charId) return;
      ensureAudioContext();
      clearSlotPlaybackImmediately(slot);
      renderStage();
      updateTransportStatus();
    });

    stageEl.appendChild(el);
  }
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
    node.querySelector(".role").textContent = `${charInfo.role} loop`;

    node.addEventListener("dragstart", (event) => {
      ensureAudioContext();
      event.dataTransfer.setData("text/plain", charInfo.id);
      event.dataTransfer.effectAllowed = "copyMove";
    });
    node.addEventListener("click", () => {
      ensureAudioContext();
      const fallback = state.slots.find((slot) => !slot.charId);
      if (fallback) {
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
  const maxLoopMultiple = getActiveMaxLoopMultiple();
  const loopIndex = (Math.floor(elapsed / loopSeconds) % maxLoopMultiple) + 1;

  if (maxLoopMultiple > 1) {
    loopIndexText.classList.remove("hidden");
    loopIndexText.textContent = `Loop ${loopIndex}/${maxLoopMultiple}`;
  } else {
    loopIndexText.classList.add("hidden");
  }
  loopProgressText.textContent = `${Math.round(progress * 100)}%`;
  loopProgressFill.style.width = `${(progress * 100).toFixed(1)}%`;

  if (state.autoModeEnabled) {
    const loopNumber = getLoopNumberNow();
    if (loopNumber !== state.autoLastLoopNumber) {
      state.autoLastLoopNumber = loopNumber;
      runAutoModeForLoop().catch(console.error);
    }
  }

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
  loopIndexText.classList.add("hidden");
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

autoModeToggle.addEventListener("change", () => {
  state.autoModeEnabled = !!autoModeToggle.checked;
  if (state.autoModeEnabled) {
    state.autoLastLoopNumber = -1;
    if (!isAnyAudioPlaying()) {
      ensureAudioContext();
      runAutoModeForLoop().catch(console.error);
    }
  }
});

window.addEventListener("pointerdown", () => {
  ensureAudioContext();
}, { once: true });

createSlotNodes();
updateTransportStatus();
loadBoxes().catch(console.error);
