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
  autoTimerId: null,
  isPaused: false,
  custom: {
    hiddenIds: new Set(),
    images: {},
  },
};

const boxSelect = document.getElementById("boxSelect");
const slotCountInput = document.getElementById("slotCount");
const stageEl = document.getElementById("stage");
const paletteEl = document.getElementById("palette");
const refreshBtn = document.getElementById("refreshBtn");
const clearBtn = document.getElementById("clearBtn");
const pauseBtn = document.getElementById("pauseBtn");
const transportStatus = document.getElementById("transportStatus");
const transportMeter = document.getElementById("transportMeter");
const loopIndexText = document.getElementById("loopIndexText");
const loopProgressText = document.getElementById("loopProgressText");
const loopProgressFill = document.getElementById("loopProgressFill");
const autoModeToggle = document.getElementById("autoModeToggle");
const paletteTpl = document.getElementById("paletteItemTpl");
const customCharSelect = document.getElementById("customCharSelect");
const separateStageImageToggle = document.getElementById("separateStageImageToggle");
const paletteImageInput = document.getElementById("paletteImageInput");
const stageImageInput = document.getElementById("stageImageInput");
const stageImageControl = document.getElementById("stageImageControl");
const clearImagesBtn = document.getElementById("clearImagesBtn");
const hideCharBtn = document.getElementById("hideCharBtn");
const hiddenCharList = document.getElementById("hiddenCharList");

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

function customStorageKey(boxId) {
  return `incredimaker_custom_${boxId}`;
}

function getVisibleCharacters() {
  if (!state.currentBox) return [];
  return state.currentBox.characters.filter((c) => !state.custom.hiddenIds.has(c.id));
}

function getImageConfig(charId) {
  return state.custom.images[charId] || null;
}

function getPaletteImage(charId) {
  const cfg = getImageConfig(charId);
  if (!cfg) return null;
  return cfg.palette || null;
}

function getStageImage(charId) {
  const cfg = getImageConfig(charId);
  if (!cfg) return null;
  if (cfg.separateStage && cfg.stage) return cfg.stage;
  return cfg.palette || null;
}

function saveCustomState() {
  if (!state.currentBoxId) return;
  const payload = {
    hiddenIds: [...state.custom.hiddenIds],
    images: state.custom.images,
  };
  localStorage.setItem(customStorageKey(state.currentBoxId), JSON.stringify(payload));
}

function loadCustomState() {
  state.custom = { hiddenIds: new Set(), images: {} };
  if (!state.currentBoxId) return;
  try {
    const raw = localStorage.getItem(customStorageKey(state.currentBoxId));
    if (!raw) return;
    const parsed = JSON.parse(raw);
    state.custom.hiddenIds = new Set(Array.isArray(parsed.hiddenIds) ? parsed.hiddenIds : []);
    state.custom.images = typeof parsed.images === "object" && parsed.images ? parsed.images : {};
  } catch (_err) {
    state.custom = { hiddenIds: new Set(), images: {} };
  }
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

function ensureAudioContext(forceResume = false) {
  if (!state.audioCtx) {
    state.audioCtx = new AudioContext();
    state.masterGain = state.audioCtx.createGain();
    state.masterGain.gain.value = 0.9;
    state.masterGain.connect(state.audioCtx.destination);
    if (state.isPaused) {
      state.audioCtx.suspend().catch(() => {});
    }
  }
  const shouldResume = forceResume || !state.isPaused;
  if (shouldResume && state.audioCtx.state !== "running") {
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

function desiredAddProbability(activeCount, totalSlots) {
  if (totalSlots <= 0) return 0.5;
  const fill = activeCount / totalSlots;
  if (fill <= 0.2) return 0.9;
  if (fill <= 0.35) return 0.78;
  if (fill <= 0.55) return 0.55;
  if (fill <= 0.75) return 0.3;
  return 0.15;
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
    const eligibleCharacters = getVisibleCharacters();
    if (!eligibleCharacters.length) {
      return;
    }
    const actions = randomIntInclusive(1, 3);
    for (let i = 0; i < actions; i += 1) {
      const filledSlots = state.slots.filter((s) => !!s.charId);
      const emptySlots = state.slots.filter((s) => !s.charId);
      const activeIds = new Set(filledSlots.map((s) => s.charId));
      const inactiveChars = eligibleCharacters.filter((c) => !activeIds.has(c.id));

      // Never allow auto mode to clear the stage completely once audio is running.
      const canRemove = filledSlots.length > 1;
      const canAdd = emptySlots.length > 0 && inactiveChars.length > 0;
      if (!canRemove && !canAdd) break;

      const addChance = desiredAddProbability(filledSlots.length, state.slots.length);
      const shouldAdd = canAdd && (!canRemove || Math.random() < addChance);
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

function maybeRunAutoForCurrentLoop() {
  if (!state.autoModeEnabled || state.isPaused || !isAnyAudioPlaying()) return;
  const loopNumber = getLoopNumberNow();
  if (loopNumber !== state.autoLastLoopNumber) {
    state.autoLastLoopNumber = loopNumber;
    runAutoModeForLoop().catch(console.error);
  }
}

function ensureAutoTimer() {
  if (state.autoTimerId !== null) return;
  state.autoTimerId = window.setInterval(() => {
    maybeRunAutoForCurrentLoop();
  }, 250);
}

function stopAutoTimer() {
  if (state.autoTimerId === null) return;
  window.clearInterval(state.autoTimerId);
  state.autoTimerId = null;
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
  if (state.custom.hiddenIds.has(charId)) return;
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
  computeGrid(safeCount);

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
      const stageImage = getStageImage(assigned.id);
      if (stageImage) {
        el.innerHTML = `<img class="stage-image" src="${stageImage}" alt=""><div class="hint">Click: remove now</div>`;
      } else {
        el.innerHTML = `<div class="assigned">${characterLabel(assigned)}</div><div class="hint">Click: remove now</div>`;
      }
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
  for (const c of getVisibleCharacters()) {
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
  if (!ordered.length) {
    paletteEl.innerHTML = "<p>All characters are hidden. Restore one below.</p>";
    return;
  }
  for (const charInfo of ordered) {
    const node = paletteTpl.content.firstElementChild.cloneNode(true);
    const thumb = node.querySelector(".thumb");
    const name = node.querySelector(".name");
    const role = node.querySelector(".role");
    const paletteImage = getPaletteImage(charInfo.id);
    if (paletteImage) {
      thumb.src = paletteImage;
      thumb.classList.remove("hidden");
      name.classList.add("hidden");
      role.classList.add("hidden");
    } else {
      thumb.classList.add("hidden");
      name.classList.remove("hidden");
      role.classList.remove("hidden");
      name.textContent = characterLabel(charInfo);
      role.textContent = `${charInfo.role} loop`;
    }

    node.addEventListener("dragstart", (event) => {
      ensureAudioContext();
      event.dataTransfer.setData("text/plain", charInfo.id);
      event.dataTransfer.effectAllowed = "copyMove";
    });
    node.addEventListener("click", () => {
      focusCharacterInCustomizer(charInfo.id, false);
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

function removeCharacterFromStage(charId) {
  for (const slot of state.slots) {
    if (slot.charId === charId) {
      if (state.audioCtx) {
        clearSlotPlaybackImmediately(slot);
      } else {
        slot.charId = null;
        slot.pending = false;
        slot.pendingCharId = null;
      }
    }
    if (slot.pendingCharId === charId) {
      slot.pending = false;
      slot.pendingCharId = null;
    }
  }
}

function selectedCustomCharId() {
  return customCharSelect.value || "";
}

function focusCharacterInCustomizer(charId, scrollIntoView = false) {
  if (!charId) return;
  customCharSelect.value = charId;
  renderCustomizationPanel();
  if (scrollIntoView) {
    customCharSelect.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function ensureImageConfig(charId) {
  if (!state.custom.images[charId]) {
    state.custom.images[charId] = { palette: null, stage: null, separateStage: false };
  }
  return state.custom.images[charId];
}

async function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function renderHiddenCharList() {
  hiddenCharList.innerHTML = "";
  const hidden = sortedCharacters(
    state.currentBox ? state.currentBox.characters.filter((c) => state.custom.hiddenIds.has(c.id)) : []
  );
  if (!hidden.length) {
    hiddenCharList.textContent = "No hidden characters.";
    return;
  }
  for (const charInfo of hidden) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = `Restore ${characterLabel(charInfo)}`;
    btn.addEventListener("click", () => {
      state.custom.hiddenIds.delete(charInfo.id);
      saveCustomState();
      renderCustomizationPanel();
      renderPalette(getVisibleCharacters());
      renderStage();
    });
    hiddenCharList.appendChild(btn);
  }
}

function renderCustomizationPanel() {
  if (!state.currentBox) {
    customCharSelect.innerHTML = "";
    hiddenCharList.textContent = "";
    return;
  }
  const allChars = sortedCharacters(state.currentBox.characters);
  const current = selectedCustomCharId();
  customCharSelect.innerHTML = "";
  for (const c of allChars) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = state.custom.hiddenIds.has(c.id) ? `${characterLabel(c)} (hidden)` : characterLabel(c);
    customCharSelect.appendChild(opt);
  }
  if (current && allChars.some((c) => c.id === current)) {
    customCharSelect.value = current;
  }
  if (!customCharSelect.value && allChars.length) {
    customCharSelect.value = allChars[0].id;
  }

  const selectedId = selectedCustomCharId();
  const cfg = selectedId ? ensureImageConfig(selectedId) : { separateStage: false };
  separateStageImageToggle.checked = !!cfg.separateStage;
  stageImageControl.classList.toggle("hidden", !cfg.separateStage);

  if (selectedId && state.custom.hiddenIds.has(selectedId)) {
    hideCharBtn.textContent = "Unhide Character";
  } else {
    hideCharBtn.textContent = "Hide Character";
  }
  renderHiddenCharList();
}

function updateTransportStatus() {
  const loopSec = getCurrentLoopSeconds().toFixed(2);
  const active = state.slots.filter((s) => s.charId).length;
  const pausedLabel = state.isPaused ? " | Paused" : "";
  transportStatus.textContent = `Loop ${loopSec}s | Active ${active}${pausedLabel}`;
  updateTransportMeterVisibility();
  if (state.autoModeEnabled && !state.isPaused && isAnyAudioPlaying()) {
    ensureAutoTimer();
  } else {
    stopAutoTimer();
  }
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

  maybeRunAutoForCurrentLoop();

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
    renderCustomizationPanel();
    return;
  }
  loadCustomState();
  const validIds = new Set(state.currentBox.characters.map((c) => c.id));
  state.custom.hiddenIds = new Set([...state.custom.hiddenIds].filter((id) => validIds.has(id)));
  for (const id of Object.keys(state.custom.images)) {
    if (!validIds.has(id)) delete state.custom.images[id];
  }
  saveCustomState();

  renderPalette(getVisibleCharacters());
  renderCustomizationPanel();
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
    state.custom = { hiddenIds: new Set(), images: {} };
    renderCustomizationPanel();
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
  stopAllPlayersNow();
});

autoModeToggle.addEventListener("change", () => {
  state.autoModeEnabled = !!autoModeToggle.checked;
  if (state.autoModeEnabled) {
    state.autoLastLoopNumber = -1;
    if (!state.isPaused && !isAnyAudioPlaying()) {
      ensureAudioContext();
      runAutoModeForLoop().catch(console.error);
    }
    ensureAutoTimer();
  } else {
    stopAutoTimer();
  }
});

customCharSelect.addEventListener("change", () => {
  renderCustomizationPanel();
});

separateStageImageToggle.addEventListener("change", () => {
  const charId = selectedCustomCharId();
  if (!charId) return;
  const cfg = ensureImageConfig(charId);
  cfg.separateStage = !!separateStageImageToggle.checked;
  if (!cfg.separateStage) {
    cfg.stage = null;
  }
  saveCustomState();
  renderCustomizationPanel();
  renderStage();
  renderPalette(getVisibleCharacters());
});

paletteImageInput.addEventListener("change", async () => {
  const charId = selectedCustomCharId();
  const file = paletteImageInput.files?.[0];
  if (!charId || !file) return;
  const cfg = ensureImageConfig(charId);
  cfg.palette = await readFileAsDataUrl(file);
  saveCustomState();
  paletteImageInput.value = "";
  renderPalette(getVisibleCharacters());
  renderStage();
  renderCustomizationPanel();
});

stageImageInput.addEventListener("change", async () => {
  const charId = selectedCustomCharId();
  const file = stageImageInput.files?.[0];
  if (!charId || !file) return;
  const cfg = ensureImageConfig(charId);
  cfg.separateStage = true;
  cfg.stage = await readFileAsDataUrl(file);
  saveCustomState();
  stageImageInput.value = "";
  renderCustomizationPanel();
  renderStage();
});

clearImagesBtn.addEventListener("click", () => {
  const charId = selectedCustomCharId();
  if (!charId) return;
  delete state.custom.images[charId];
  saveCustomState();
  renderCustomizationPanel();
  renderPalette(getVisibleCharacters());
  renderStage();
});

hideCharBtn.addEventListener("click", () => {
  const charId = selectedCustomCharId();
  if (!charId) return;
  if (state.custom.hiddenIds.has(charId)) {
    state.custom.hiddenIds.delete(charId);
  } else {
    state.custom.hiddenIds.add(charId);
    removeCharacterFromStage(charId);
  }
  saveCustomState();
  renderCustomizationPanel();
  renderPalette(getVisibleCharacters());
  renderStage();
  updateTransportStatus();
});

function updatePauseButton() {
  pauseBtn.textContent = state.isPaused ? "Resume" : "Pause";
}

pauseBtn.addEventListener("click", async () => {
  state.isPaused = !state.isPaused;
  ensureAudioContext();
  if (!state.audioCtx) return;
  if (state.isPaused) {
    await state.audioCtx.suspend().catch(() => {});
  } else {
    await state.audioCtx.resume().catch(() => {});
  }
  updatePauseButton();
  updateTransportStatus();
});

window.addEventListener("pointerdown", () => {
  ensureAudioContext();
}, { once: true });

createSlotNodes();
updatePauseButton();
renderCustomizationPanel();
updateTransportStatus();
loadBoxes().catch(console.error);
