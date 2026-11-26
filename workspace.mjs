import { inspectPointFiles, stagePointData } from './point-model.mjs';
import { createPairedPointScene } from './voxel-scene.mjs';
import { scheduleFrame } from './schedule-story.mjs';
import { scheduleGroupingFrame } from './schedule-bridge.mjs';
import { normalizeExpectedHash, sampledByteOffset } from './compare-core.mjs';
import { digestBits } from './voxel-model.mjs';
import { paddingFlightCounts } from './padding-motion.mjs';
import { hashComparison } from './hash-comparison.mjs';
import { renderMatrixText } from './matrix-text.mjs';
import { createSplitFlap, setSplitFlapFrame, setSplitFlapValue } from './split-flap.mjs';
import { ASSEMBLY_MS, STAGE_MS, PADDING_FILL_MS, ROUND_PHASES, roundPlaybackFrame, roundSeparationElapsed, roundLayerElapsed, MIN_DURATION_SECONDS, MAX_DURATION_SECONDS, playbackTiming, advancePlayback } from './playback-timing.mjs';

const $ = (id) => document.getElementById(id);
const matrixText = (id, value) => renderMatrixText($(id), value, document);
const instrumentFlaps = new Map();
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const compactLayout = window.matchMedia('(max-width: 600px), (max-height: 500px) and (pointer: coarse)');
const touchInput = window.matchMedia('(pointer: coarse)');
const mobileInputsToggle = $('mobile-inputs-toggle');
function instrumentValue(id, value, duration = 320) {
  setSplitFlapValue(instrumentFlaps.get(id), String(value), { duration, reducedMotion: reducedMotion() });
}
function initializeInstruments() {
  const values = { 'stage-fixed-zero': '0', 'stage-dial': '1', 'stage-total-zero': '0', 'stage-total-six': '6',
    'difference-dial-hundreds': '0', 'difference-dial-tens': '0', 'difference-dial-ones': '0',
    'file-letter-a': 'A', 'file-letter-b': 'B', 'timeline-letter-a': 'A', 'timeline-letter-b': 'B' };
  for (const [id, value] of Object.entries(values)) {
    const view = createSplitFlap(document, { value });
    $(id).replaceChildren(view.element); instrumentFlaps.set(id, view);
  }
  for (const id of ['stage-title', 'stage-explanation', 'point-count-a', 'point-count-b']) matrixText(id, $(id).textContent);
}
const number = new Intl.NumberFormat('en-GB');
const stages = ['bytes', 'padding', 'schedule', 'rounds', 'digest', 'compare'];
let timing = playbackTiming();
const motion = () => ({ flowMode: true, animationRate: timing.rate, transitionDuration: 1100 * timing.scale });
const stageMotion = () => ({ ...motion(), transitionDuration: timing.transitionMs[stage] });
const descriptions = [
  ['Gather the bytes.', 'Read bytes arrive as floating particles. Once both files are loaded, they gather into ordered cubes.'],
  ['Extend the array.', 'Padding dots fly in and complete the array.'],
  ['Gather into the schedule.', 'Nearby dots converge, then open into the next array.'],
  ['Scan the rounds.', 'Separate the stack, scan every layer, then return to all sixty-four.'],
  ['Compact the digest.', 'Each array gathers into one layer of 256 final hash bits.'],
  ['Compare the bits.', 'Compare the two complete hashes in their side-by-side grids.'],
];
const files = { a: null, b: null };
const inputModes = { a: 'file', b: 'file' };
const expectedHashes = { a: null, b: null };
const isHashInput = (slot) => inputModes[slot] === 'hash';
const hashMode = () => isHashInput('a') || isHashInput('b');
const twoHashes = () => isHashInput('a') && isHashInput('b');
const otherSlot = (slot) => slot === 'a' ? 'b' : 'a';
const hasInputs = () => ['a', 'b'].every(slot => isHashInput(slot) ? expectedHashes[slot] : files[slot]);
const inputLabel = (slot) => {
  if (!isHashInput(slot)) return `File ${slot.toUpperCase()}`;
  return twoHashes() ? `Hash ${slot.toUpperCase()}` : 'Expected hash';
};
const hashLabel = (slot) => twoHashes() ? `SHA-256 ${slot.toUpperCase()}` : isHashInput(slot) ? 'Expected SHA-256' : `File ${slot.toUpperCase()} SHA-256`;
const hashControl = (id, slot) => $(slot === 'a' ? `${id}-a` : id);
let models = null;
let result = null;
let worker = null;
let readController = null;
let token = 0;
let stage = 0;
let round = 0;
let scheduleWord = 0;
let paddingProgress = 0;
let playing = false;
let timer = null;
let elapsed = 0;
let layer = null;
let spread = 0;
let selected = null;
let cache = new Map();
let scene = null;
let graphicsError = '';
let reads = null;
let autoStarted = false;
let byteAssembly = 0;
let assemblyTimer = null;
let hashOutputModel = null;
let hashOutputSignature = '';
const hashRollers = { a: [], b: [] };
let assemblyLastTime = null;
let assemblyCarry = 0;
let playLastTime = null;
let replayRequested = false;
let comparisonComplete = false;
function setAnimationDuration() {
  const input = $('duration-seconds');
  const seconds = Number(input.value);
  if (!input.value.trim() || !Number.isFinite(seconds) || seconds < MIN_DURATION_SECONDS || seconds > MAX_DURATION_SECONDS) {
    input.setAttribute('aria-invalid', 'true'); return false;
  }
  input.setAttribute('aria-invalid', 'false');
  const next = playbackTiming(seconds);
  if (next.totalMs === timing.totalMs) return true;
  const now = performance.now(), previousRate = timing.rate;
  let completedAssembly = false;
  if (assemblyTimer !== null && assemblyLastTime !== null) {
    const position = byteAssembly * ASSEMBLY_MS + Math.max(0, now - assemblyLastTime) * previousRate;
    byteAssembly = Math.min(1, position / ASSEMBLY_MS);
    assemblyLastTime = now;
    if (byteAssembly === 1) {
      assemblyCarry = Math.max(0, position - ASSEMBLY_MS);
      stopAssembly(); completedAssembly = true;
    }
  }
  if (playing && playLastTime !== null) {
    elapsed += Math.max(0, now - playLastTime) * previousRate;
    playLastTime = now;
  }
  timing = next;
  $('app').dataset.duration = String(timing.seconds);
  if (stage === 3 && playing) syncRoundPlayback();
  if (reads) render(stage === 3 && playing && elapsed >= ROUND_PHASES.entranceEnd);
  if (completedAssembly) maybeStartWalkthrough();
  return true;
}
function commitAnimationDuration() {
  setAnimationDuration();
  $('duration-seconds').value = String(timing.seconds);
  $('duration-seconds').setAttribute('aria-invalid', 'false');
}

function readsComplete() {
  return !hashMode() && !!reads && ['a', 'b'].every((slot) => reads[slot].processed === reads[slot].total && reads[slot].readCount === reads[slot].sampleTotal);
}
function stopAssembly() {
  if (assemblyTimer !== null) clearInterval(assemblyTimer);
  assemblyTimer = null;
  assemblyLastTime = null;
}
function beginAssembly() {
  if (!readsComplete() || byteAssembly === 1 || assemblyTimer !== null) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || graphicsError || (reads.a.sampleTotal === 0 && reads.b.sampleTotal === 0)) {
    byteAssembly = 1;
    if (stage === 0) render();
    maybeStartWalkthrough(); return;
  }
  if (document.hidden) return;
  const current = token;
  assemblyLastTime = performance.now();
  message('Both files read · arranging particles into cubes.');
  const activeTimer = setInterval(() => {
    if (current !== token || !reads || assemblyTimer !== activeTimer) return;
    if (document.hidden) { stopAssembly(); return; }
    const now = performance.now();
    const position = byteAssembly * ASSEMBLY_MS + Math.max(0, now - assemblyLastTime) * timing.rate;
    assemblyLastTime = now;
    byteAssembly = Math.min(1, position / ASSEMBLY_MS);
    if (stage === 0) render();
    if (byteAssembly === 1) {
      assemblyCarry = Math.max(0, position - ASSEMBLY_MS);
      stopAssembly();
      message('Byte cubes formed.');
      maybeStartWalkthrough();
    }
  }, 16);
  assemblyTimer = activeTimer;
}

function resetReads() {
  reads = {};
  for (const slot of ['a', 'b']) {
    const total = files[slot].size;
    const sampleTotal = Math.min(total, 65536);
    const remainder = total % 64;
    const paddingAdded = remainder < 56 ? 64 - remainder : 128 - remainder;
    reads[slot] = { total, processed: 0, readCount: 0, sampleTotal,
      values: Array(sampleTotal).fill(0), kinds: Array(sampleTotal).fill('message'),
      sourceOffsets: Array.from({ length: sampleTotal }, (_, index) => sampledByteOffset(total, index)),
      capacity: sampleTotal + paddingAdded };
  }
}
function readProgress(data) {
  const state = reads?.[data.lane];
  if (!state) return;
  if (hashMode()) {
    state.processed = data.processed;
    renderReadLabels();
    renderHashReveal();
    return;
  }
  if (data.total !== state.total || data.sampleStart !== state.readCount || data.sampleTotal !== state.sampleTotal
    || data.processed < state.processed || data.processed > state.total
    || state.readCount + data.sampleBytes.length > state.sampleTotal) {
    fail('The file reader returned inconsistent progress. Choose the files again.'); return;
  }
  for (let i = 0; i < data.sampleBytes.length; i++) state.values[state.readCount + i] = data.sampleBytes[i];
  state.readCount += data.sampleBytes.length;
  state.processed = data.processed;
  renderReadLabels();
  if (stage === 0) render();
  beginAssembly();
}
function setReadStatus(slot, state, text) {
  $(`read-label-${slot}`).textContent = text;
  const lamp = $(`file-status-${slot}`);
  lamp.dataset.state = state;
  lamp.title = `${inputLabel(slot)}: ${text}`;
  lamp.setAttribute('aria-label', lamp.title);
}
function renderReadLabels() {
  if (!reads) return;
  for (const [slot, state] of Object.entries(reads)) {
    const percent = state.total ? Math.floor(state.processed / state.total * 100) : 100;
    const text = state.processed === state.total
      ? result ? 'Read complete · hash ready' : 'Read complete · finishing hash…'
      : `${number.format(state.processed)} / ${number.format(state.total)} bytes read · ${percent}%`;
    setReadStatus(slot, state.processed !== state.total ? 'reading' : result ? 'ready' : 'hashing', text);
  }
}
function syncReadModels() {
  if (!models || !reads) return;
  for (const slot of ['a', 'b']) models[slot].sampleBytes = reads[slot].values.slice();
}
function maybeStartWalkthrough() {
  if (!models || !result || autoStarted) return;
  if (['a', 'b'].some((slot) => reads[slot].processed !== reads[slot].total || reads[slot].readCount !== reads[slot].sampleTotal)) {
    fail('The complete read could not be verified. Choose the files again.'); return;
  }
  syncReadModels();
  if (byteAssembly < 1) { beginAssembly(); return; }
  autoStarted = true;
  elapsed = assemblyCarry; assemblyCarry = 0;
  renderReadLabels(); render();
  const requested = replayRequested; replayRequested = false;
  if (requested || !window.matchMedia('(prefers-reduced-motion: reduce)').matches) play();
  else message('Both files read. Step through the stages or press Play.');
}

function message(text) { $('status').textContent = text; }
function shortSize(size) {
  return size < 1024 ? `${number.format(size)} bytes` : `${(size / 1024 ** Math.min(3, Math.floor(Math.log2(size) / 10))).toFixed(1)} ${['', 'KiB', 'MiB', 'GiB'][Math.min(3, Math.floor(Math.log2(size) / 10))]}`;
}
function stop() {
  playing = false;
  if (timer !== null) clearInterval(timer);
  timer = null;
  playLastTime = null;
  $('play').textContent = 'Play';
  if (models) message(result ? 'Paused · complete hashes ready.' : 'Paused · full files are still being read.');
}
function cancelRun() {
  token++;
  stop();
  stopAssembly();
  worker?.terminate(); worker = null;
  readController?.abort(); readController = null;
  models = null; result = null; cache = new Map();
  delete $('comparison-result').dataset.identical;
  delete $('comparison-result').dataset.matches;
  comparisonComplete = false; renderVerdict();
  hashOutputModel = null; hashOutputSignature = '';
  resetHashOutputs();
  for (const slot of ['a', 'b']) {
    setReadStatus(slot, 'idle', 'Waiting for file.');
    matrixText(`point-count-${slot}`, '0 bytes');
  }
  reads = null; autoStarted = false;
  byteAssembly = 0;
  assemblyCarry = 0;
  replayRequested = false;
  stage = 0; round = 0; paddingProgress = 0; elapsed = 0; selected = null; layer = null; spread = 0;
  $('layer').value = '0'; $('layer-value').textContent = 'All 64';
  $('round-track').style.setProperty('--round-progress', '0%');
  $('layer').setAttribute('aria-valuetext', 'All 64 layers');
  $('spread').value = '0';
  scheduleWord = 0;
  $('bit').value = '1';
  $('comparison-result').hidden = false;
  $('value-dialog').close();
  $('value-a').textContent = ''; $('value-b').textContent = '';
  scene?.setData({ ...motion(), transitionDuration: 0, a: { values: [] }, b: { values: [] }, stage: 'bytes' });
}
function displayFiles() {
  for (const slot of ['a', 'b']) {
    const file = files[slot];
    $(`name-${slot}`).textContent = file ? file.name : `Choose ${slot === 'a' ? 'first' : 'second'} file`;
    $(`name-${slot}`).title = file?.name || '';
    $(`size-${slot}`).textContent = file ? shortSize(file.size) : 'or drop it here · any format';
    $(`picker-action-${slot}`).textContent = file ? 'Replace file' : 'Choose file';
    $(`file-${slot}`).setAttribute('aria-label', `${file ? 'Replace' : 'Choose'} ${slot === 'a' ? 'first' : 'second'} file`);
    $(`remove-${slot}`).hidden = !file;
    $(`file-${slot}`).value = '';
  }
}
function showHashMessage(slot, text = '', invalid = false) {
  const hint = hashControl('hash-error', slot);
  hint.textContent = text;
  hint.hidden = !text;
  hint.classList[invalid ? 'add' : 'remove']('invalid');
  hashControl('expected-hash', slot).setAttribute('aria-invalid', String(invalid));
}
function choose(update = {}) {
  cancelRun();
  for (const [slot, file] of Object.entries(update)) {
    files[slot] = file;
    if (file) {
      inputModes[slot] = 'file';
      expectedHashes[slot] = null;
    }
  }
  displayFiles();
  $('app').dataset.compareMode = hashMode() ? 'hash' : 'files';
  $('duration-row').inert = hashMode();
  $('clear').textContent = hashMode() ? 'New comparison' : 'New files';
  for (const slot of ['a', 'b']) {
    const pasted = isHashInput(slot);
    const expected = expectedHashes[slot];
    const other = otherSlot(slot);
    hashControl('mode-files', slot).setAttribute('aria-pressed', String(!pasted));
    hashControl('mode-hash', slot).setAttribute('aria-pressed', String(pasted));
    $(`file-${slot}-actions`).inert = pasted;
    hashControl('hash-form', slot).inert = !pasted;
    $(`readout-type-${slot}`).textContent = pasted ? 'Hash' : 'File';
    $(`slot-${slot}`).dataset.inputMode = inputModes[slot];
    $(`slot-${slot}`).setAttribute('aria-label', inputLabel(slot));
    $(`legend-${slot}-label`).textContent = inputLabel(slot);
    $(`value-label-${slot}`).textContent = inputLabel(slot);
    if (pasted) {
      matrixText(`point-count-${slot}`, expected ? '256 bits' : 'SHA-256');
      setReadStatus(slot, expected ? 'ready' : 'idle', expected ? 'SHA-256 ready.' : 'Waiting for a SHA-256 hash.');
      $(`hash-label-${slot}`).textContent = hashLabel(slot);
      $(`hash-code-${slot}`).setAttribute('aria-label', `${hashLabel(slot)}: ${expected ?? 'awaiting input.'}`);
    } else setReadStatus(slot, 'idle', 'Waiting for file.');

    let hint = '';
    if (pasted && expected) {
      if (isHashInput(other) && !expectedHashes[other]) hint = `Enter the SHA-256 hash for ${other.toUpperCase()}.`;
      if (!isHashInput(other) && !files[other]) hint = `Choose File ${other.toUpperCase()} to compare.`;
    }
    showHashMessage(slot, hint);
  }
  if (hasInputs()) startRun();
  else {
    const leavingRun = $('app').dataset.mode === 'run';
    $('app').dataset.mode = 'pick'; $('workshop').hidden = true;
    mobileInputsToggle?.setAttribute('aria-expanded', 'false');
    if (leavingRun && compactLayout.matches) window.scrollTo?.(0, 0);
    message(hashMode() ? 'Complete both inputs to compare.' : files.a || files.b ? 'Choose the other file to begin.' : 'Ready for two files.');
  }
}
function ensureScene() {
  if (scene) return;
  scene = createPairedPointScene($('scene-a'), $('scene-b'), {
    onError: (error) => { graphicsError = error; $('scene-error').hidden = !error; $('scene-error').textContent = error ? `${error} The comparison still runs. Open Values for the hashes.` : ''; },
    onPick: ({ index, valueA, valueB }) => {
      stop(); selected = index; scene.setSelected(index);
      if (stage === 0 && reads) {
        const a = index >= reads.a.sampleTotal ? 'absent' : index < reads.a.readCount ? valueA : 'not read yet';
        const b = index >= reads.b.sampleTotal ? 'absent' : index < reads.b.readCount ? valueB : 'not read yet';
        const offsetA = reads.a.sourceOffsets[index], offsetB = reads.b.sourceOffsets[index];
        const bothRead = index < reads.a.readCount && index < reads.b.readCount;
        const verdict = bothRead ? offsetA === offsetB ? a === b ? ' · same' : ' · different' : ' · different source offsets' : '';
        message(`A byte ${offsetA === undefined ? 'absent' : number.format(offsetA + 1)}: ${a} · B byte ${offsetB === undefined ? 'absent' : number.format(offsetB + 1)}: ${b}${verdict}`); return;
      }
      if (stage === 2) { setScheduleWord(Math.floor(index / 32)); }
      else if (stage >= 4) { $('bit').value = String(index + 1); renderBitDetail(); }
      else message(`${stage === 2 ? `W${Math.floor(index / 32)} · bit ${index % 32 + 1}` : `Point ${number.format(index + 1)}`} · A: ${valueA ?? 'absent'} · B: ${valueB ?? 'absent'}${valueA === valueB ? ' · same' : ' · different'}`);
    },
  });
}
async function startRun() {
  const current = token;
  const pastedSlot = isHashInput('a') ? 'a' : 'b';
  const fileSlot = otherSlot(pastedSlot);
  const enteringRun = $('app').dataset.mode !== 'run';
  $('app').dataset.mode = 'run'; $('workshop').hidden = false;
  if (enteringRun && compactLayout.matches) window.scrollTo?.(0, 0);
  $('scene-error').hidden = !graphicsError;
  $('scene-error').textContent = graphicsError ? `${graphicsError} The comparison still runs. Open Values for the hashes.` : '';
  if (hashMode()) {
    stage = 5;
    reads = twoHashes() ? {} : { [fileSlot]: { total: files[fileSlot].size, processed: 0 } };
  } else resetReads();
  renderReadLabels();
  message(hashMode() ? twoHashes() ? 'Comparing the two hashes.' : `Calculating SHA-256 for ${inputLabel(fileSlot)}.` : 'Reading both files locally. Preparing the byte arrays.');
  ensureScene();
  if (twoHashes()) {
    const { a: hashA, b: hashB } = expectedHashes;
    finishHashComparison({ hashA, hashB, matches: hashA === hashB });
    return;
  }
  render();
  try {
    worker = new Worker(new URL('./compare-worker.mjs', import.meta.url), { type: 'module' });
    const thisWorker = worker;
    worker.onmessage = ({ data }) => {
      if (token !== current || worker !== thisWorker) return;
      if (data.type === 'read') {
        readProgress(hashMode() ? { ...data, lane: fileSlot } : data);
      } else if (data.type === 'progress') {
        // Hash progress is separate from completed reads; it must not rewind
        // the independently reported read counts or populate byte points.
      } else if (data.type === 'result') {
        thisWorker.terminate(); worker = null;
        if (hashMode()) {
          const { hashA, hashB, matches } = data.result;
          finishHashComparison(fileSlot === 'a' ? { hashA, hashB, matches } : { hashA: hashB, hashB: hashA, matches });
          return;
        }
        result = data.result;
        message('Both files read. Complete hashes ready.');
        renderReadLabels();
        maybeStartWalkthrough();
      } else fail(hashMode() ? `${inputLabel(fileSlot)} could not be read. Choose it again or retry the hash comparison.` : 'A file could not be read. Choose it again to retry.');
    };
    worker.onerror = (event) => { event.preventDefault(); if (token === current) fail('The file reader could not start. Reload and choose the files again.'); };
    if (hashMode()) {
      worker.postMessage({ type: 'start', fileA: files[fileSlot], fileB: null, expectedHash: expectedHashes[pastedSlot] });
      return;
    }
    worker.postMessage({ fileA: files.a, fileB: files.b });
    readController = new AbortController();
    const inspected = await inspectPointFiles(files.a, files.b, { signal: readController.signal });
    if (current !== token) return;
    models = inspected;
    stage = 0; render();
    maybeStartWalkthrough();
  } catch (error) {
    if (current !== token || error?.name === 'AbortError') return;
    fail(hashMode() ? `${inputLabel(fileSlot)} could not be checked. Choose it again to retry.` : 'The visualization could not read a file. Choose both files again to retry.');
  }
}
function finishHashComparison(comparison) {
  result = comparison;
  comparisonComplete = true;
  selected = Number($('bit').value) - 1;
  renderReadLabels();
  render();
  message(result.matches ? 'Hash matches.' : 'Hash does not match.');
}
function fail(text) {
  token++;
  stopAssembly();
  worker?.terminate(); worker = null; readController?.abort();
  result = null; autoStarted = false;
  comparisonComplete = false; renderVerdict();
  replayRequested = false;
  stage = hashMode() ? 5 : 0;
  if (reads && !hashMode()) scene?.setData({ ...motion(), transitionDuration: 0, a: reads.a, b: reads.b, stage: 'bytes', byteCloud: false, byteAssembly: 1 });
  stop(); message(text);
  renderHeading();
  $('scene-error').hidden = false; $('scene-error').textContent = text;
  for (const slot of Object.keys(reads ?? {})) setReadStatus(slot, 'error', 'Processing interrupted.');
}
function pairForStage() {
  const key = stages[stage];
  if (!cache.has(key)) {
    const pair = {};
    for (const slot of ['a', 'b']) {
      if (hashMode()) {
        const values = digestBits(slot === 'a' ? result.hashA : result.hashB);
        pair[slot] = { values, kinds: Array(values.length).fill('digest') };
        continue;
      }
      const model = models[slot];
      pair[slot] = { ...stagePointData(model, key, round, 0, result?.[slot === 'a' ? 'hashA' : 'hashB'] ?? null), capacity: model.sampleBytes.length + model.paddedLength - model.size };
      if (key === 'padding') pair[slot].sourceOffsets = [...reads[slot].sourceOffsets,
        ...Array.from({ length: model.paddedLength - model.size }, (_, index) => model.size + index)];
    }
    cache.set(key, pair);
  }
  return cache.get(key);
}
function renderHeading() {
  renderLegend();
  $('stage-index').textContent = `0${stage + 1} / 06`;
  instrumentValue('stage-dial', stage + 1);
  const title = stage === 0 ? byteAssembly === 1 ? 'The bytes, in order.' : readsComplete() ? 'Bring the bytes into order.' : 'Gather the bytes.' : descriptions[stage][0];
  const explanation = stage === 0 ? byteAssembly === 1
    ? 'The particles have settled. Padding fills out this same volume.'
    : readsComplete() ? 'The floating particles settle into their cube positions.'
      : 'Read bytes arrive and drift into view.' : descriptions[stage][1];
  matrixText('stage-title', hashMode() ? result ? 'SHA-256 comparison' : 'Calculating SHA-256' : title);
  matrixText('stage-explanation', hashMode() ? twoHashes() ? 'Compare the two pasted hashes.' : 'Compare the file with the expected hash.' : explanation);
  $('stage-explanation').hidden = false;
  for (const button of document.querySelectorAll('[data-stage]')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.stage) === stage));
    button.disabled = Number(button.dataset.stage) > 0 && (!result || byteAssembly < 1);
  }
  $('previous').disabled = stage === 0;
  $('next').disabled = stage === 5 || !result || byteAssembly < 1;
  $('play').disabled = !models || !result || byteAssembly < 1;
  $('values').disabled = !result || (!hashMode() && !models);
  $('padding-tools').hidden = stage !== 1;
  $('schedule-inspector').hidden = stage !== 2;
  $('round-tools').hidden = stage !== 3;
  $('layer-tools').hidden = stage !== 3;
  $('bit-tools').hidden = stage < 4 || (hashMode() && !result);
  $('comparison-result').hidden = false;
  renderVerdict();
  renderHashOutputs();
  $('scene-hint').textContent = touchInput.matches
    ? stage >= 4 ? 'Tap a dot · Pinch to zoom' : 'Drag to rotate · Pinch to zoom'
    : stage >= 4 ? 'Select a dot to inspect its bit · Scroll to zoom' : 'Drag to rotate · Scroll or pinch to zoom';
  for (const slot of ['a', 'b']) {
    const detail = hashMode() ? 'SHA-256 bit grid.' : descriptions[stage].join(' ');
    $(`scene-${slot}`).setAttribute('aria-label', `${inputLabel(slot)}: ${detail} Cameras are linked. Exact numeric values are available with Values.`);
  }
  $('scene-wrap').dataset.comparison = String(stage >= 4);
}
function renderLegend() {
  const extraColours = stage === 1 || stage === 2;
  $('legend-marker').hidden = !extraColours;
  $('legend-length').hidden = !extraColours;
  const labels = stage === 2 ? ['Active word', 'Source words'] : ['Padding', 'Bit length'];
  for (const [index, id] of ['legend-marker-label', 'legend-length-label'].entries()) {
    if ($(id).textContent !== labels[index]) $(id).textContent = labels[index];
  }
  $('legend-difference').title = stage === 0 ? 'Differences appear after both bytes are read.' : 'Different values in the two arrays.';
}
function renderVerdict() {
  const lit = comparisonComplete && result ? (hashMode() ? result.matches : result.identical) ? 'same' : 'different' : 'none';
  $('comparison-result').dataset.lit = lit;
  for (const slot of ['a', 'b']) {
    const canCopy = lit !== 'none' && !isHashInput(slot);
    const button = $(`copy-hash-${slot}`);
    button.hidden = !canCopy;
    if (!canCopy && button.textContent !== 'Copy hash') button.textContent = 'Copy hash';
  }
  const same = hashMode() ? 'Hash matches' : 'Same files';
  const different = hashMode() ? 'Hash does not match' : 'Different files';
  for (const [id, label] of [['verdict-same', same], ['verdict-different', different]]) {
    if ($(id).textContent !== label) $(id).textContent = label;
  }
  const text = lit === 'none' ? 'Comparison in progress.' : lit === 'same' ? same : different;
  if ($('verdict').textContent !== text) $('verdict').textContent = text;
  renderDifferenceCount(lit === 'none' ? null : hashComparison(result.hashA, result.hashB).differentBits);
}
async function copyHash(slot) {
  if (!comparisonComplete || !result || isHashInput(slot)) return;
  const currentResult = result;
  const digest = slot === 'a' ? result.hashA : result.hashB;
  const button = $(`copy-hash-${slot}`);
  try {
    await navigator.clipboard.writeText(digest);
  } catch {
    if (result !== currentResult || button.hidden) return;
    renderValues();
    const hint = $('copy-hash-error');
    hint.textContent = `Select and copy the hash for File ${slot.toUpperCase()} below.`;
    hint.hidden = false;
    if (!$('value-dialog').open) $('value-dialog').showModal();
    return;
  }
  if (result !== currentResult || button.hidden) return;
  button.textContent = 'Copied';
  message(`Copied File ${slot.toUpperCase()} SHA-256.`);
}
function renderDifferenceCount(different) {
  if (different === null) {
    if ($('difference-count').textContent !== 'Hash-bit comparison pending.') $('difference-count').textContent = 'Hash-bit comparison pending.';
  } else $('difference-count').replaceChildren(document.createTextNode(String(different)), Object.assign(document.createElement('small'), { textContent: ' / 256 hash bits differ' }));
  const digits = String(different ?? 0).padStart(3, '0');
  ['hundreds', 'tens', 'ones'].forEach((place, index) => {
    instrumentValue(`difference-dial-${place}`, digits[index]);
  });
}
function syncRoundPlayback() {
  const frame = roundPlaybackFrame(elapsed);
  round = frame.round; spread = frame.spread; layer = frame.layer;
}
function render(directRoundSpread = false) {
  renderHeading();
  if (hashMode()) {
    $('scope-note').textContent = result ? 'Each dot represents one SHA-256 bit.' : '';
    if (result) {
      scene.setData({ ...stageMotion(), ...pairForStage(), stage: 'compare', compareLayout: 'grid', selectedBit: selected });
      for (const slot of ['a', 'b']) matrixText(`point-count-${slot}`, '16 × 16 · 256 bits');
      $('comparison-result').dataset.matches = String(result.matches);
      renderBitDetail();
    } else for (const [slot, state] of Object.entries(reads ?? {})) {
      matrixText(`point-count-${slot}`, `${number.format(state.total)} bytes`);
    }
    return;
  }
  if (stage === 0 && reads) {
    scene.setData({ ...motion(), a: reads.a, b: reads.b, stage: 'bytes', selectedBit: selected, byteCloud: true, byteAssembly });
    for (const slot of ['a', 'b']) {
      const state = reads[slot];
      matrixText(`point-count-${slot}`, `${number.format(state.readCount)} / ${number.format(state.sampleTotal)} byte points`);
    }
    const sampled = reads.a.total > 65536 || reads.b.total > 65536;
    $('scope-note').textContent = sampled
      ? 'Up to 65,536 actual read samples per file. Their motion is illustrative; the read counters remain exact.'
      : 'One particle = one byte actually read. Motion illustrates arrival; the read counters remain exact.';
    return;
  }
  if (!models || (stage >= 4 && !result)) return;
  const pair = pairForStage();
  scene.setData({ ...stageMotion(), ...pair, stage: stages[stage], round, layer, spread,
    compareLayout: stage >= 4 ? 'grid' : undefined,
    directSpread: stage === 3 && directRoundSpread, selectedBit: selected,
    scheduleWordCount: 64, scheduleWord, scheduleGrouping: 1, scheduleSources: [],
    paddingStart: { a: models.a.sampleBytes.length, b: models.b.sampleBytes.length }, paddingProgress });
  $('round').value = String(round); $('round-value').textContent = `${round} / 64`;
  $('round-track').style.setProperty('--round-progress', `${round / 64 * 100}%`);
  $('layer').value = layer === null ? '0' : String(layer + 1);
  $('layer-value').textContent = layer === null ? 'All 64' : `${layer + 1} / 64`;
  $('layer').setAttribute('aria-valuetext', layer === null ? 'All 64 layers' : `Layer ${layer + 1} of 64`);
  $('spread').value = String(spread * 100);
  if ($('value-dialog').open) renderValues();
  $('padding-progress').value = String(Math.round(paddingProgress * 100));
  for (const slot of ['a', 'b']) {
    const model = models[slot];
    const added = model.paddedLength - model.size;
    if (stage === 0) matrixText(`point-count-${slot}`, `${number.format(model.size)} bytes`);
    else if (stage === 1) {
      const flight = paddingFlightCounts(added, paddingProgress);
      const totalBytes = model.size + flight.arrived;
      const arriving = flight.started - flight.arrived;
      matrixText(`point-count-${slot}`, `${number.format(totalBytes)} bytes · ${BigInt(totalBytes) * 8n} bits${arriving ? ` · ${arriving} arriving` : ''}`);
    } else if (stage === 2) matrixText(`point-count-${slot}`, '64 words · 2,048 bits');
    else if (stage === 3) matrixText(`point-count-${slot}`, layer === null ? `Round ${round} · ${round} / 64 layers` : `Layer ${layer + 1} / 64 · 32 bytes`);
    else matrixText(`point-count-${slot}`, '16 × 16 · 256 bits');
  }
  if (stage === 1) {
    const a = models.a.paddedLength - models.a.size; const b = models.b.paddedLength - models.b.size;
    $('padding-count').textContent = `Add ${a === b ? a : `${a} / ${b}`} bytes → ${models.a.paddedLength === models.b.paddedLength ? number.format(models.a.paddedLength) : `${number.format(models.a.paddedLength)} / ${number.format(models.b.paddedLength)}`} · ${Math.round(paddingProgress * 100)}%`;
  }
  const sampled = models.a.sampled || models.b.sampled;
  $('scope-note').textContent = stage < 2
    ? `${stage === 1 ? '' : 'One point = one byte. '}${sampled ? 'Up to 65,536 bytes sampled across each file; full files are hashed.' : `Exact ${stage === 1 ? 'original + padding' : 'file'} point counts.`}`
    : stage === 3 ? 'One dot = one round-state byte · First block shown; hashes compare the complete files.'
      : stage >= 4 ? 'One dot = one final hash bit · Hashes cover the complete files.'
        : `One point per schedule bit. ${models.a.blockCount > 1 || models.b.blockCount > 1 ? 'First block shown; hashes include all blocks.' : 'Single-block data.'}`;
  if (stage >= 4 && result) renderBitDetail();
  if (stage === 5 && result) {
    $('comparison-result').dataset.identical = String(result.identical);
  }
}
function go(index, automatic = false, initialElapsed = 0) {
  if (!models) return;
  if (index > 0 && !result) { message('Waiting for both files to finish reading.'); return; }
  if (index > 0 && byteAssembly < 1) { message('The particles are still gathering into their cubes.'); return; }
  if (!automatic) stop();
  comparisonComplete = false;
  stage = Math.max(0, Math.min(5, index)); elapsed = initialElapsed; selected = stage >= 4 ? Number($('bit').value) - 1 : null; layer = null;
  $('layer').value = '0';
  $('layer-value').textContent = 'All 64';
  $('layer').setAttribute('aria-valuetext', 'All 64 layers');
  if (stage === 1) paddingProgress = Math.min(1, elapsed / PADDING_FILL_MS);
  if (stage === 2) scheduleWord = 0;
  if (stage === 3) syncRoundPlayback();
  render(stage === 3 && automatic && elapsed >= ROUND_PHASES.entranceEnd);
}
function setScheduleWord(value) {
  if (!models || stage !== 2 || !Number.isInteger(value) || value < 0 || value > 63) return;
  stop(); scheduleWord = value; selected = value * 32;
  scene?.setSelected(selected);
  if ($('value-dialog').open) renderValues();
  else message(`W${value} selected · open Values to inspect.`);
}
function play() {
  if (!models || !result || byteAssembly < 1) return;
  if (playing) { stop(); return; }
  if (stage === 5 && elapsed >= STAGE_MS[5]) {
    stop(); stopAssembly();
    byteAssembly = 0; assemblyCarry = 0; autoStarted = false; replayRequested = true;
    spread = 0; $('spread').value = '0';
    go(0, true); beginAssembly(); return;
  }
  playing = true; $('play').textContent = 'Pause';
  if (stage === 3) { syncRoundPlayback(); render(elapsed >= ROUND_PHASES.entranceEnd); }
  playLastTime = performance.now();
  const current = token;
  const activeTimer = setInterval(() => {
    if (current !== token || timer !== activeTimer || !playing) return;
    if (document.hidden) { stop(); return; }
    const now = performance.now();
    const next = advancePlayback(stage, elapsed, Math.max(0, now - playLastTime) * timing.rate);
    playLastTime = now;
    if (next.stage !== stage) {
      // The complete stack is the source of the Digest fold even if one
      // timer tick crosses the final All-layers hold.
      if (stage === 3) { elapsed = ROUND_PHASES.end; syncRoundPlayback(); render(true); }
      go(next.stage, true, next.elapsed);
    }
    else elapsed = next.elapsed;
    if (stage === 1) { paddingProgress = Math.min(1, elapsed / PADDING_FILL_MS); render(); }
    if (stage === 3) { syncRoundPlayback(); render(elapsed >= ROUND_PHASES.entranceEnd); }
    if (stage >= 4) renderHashReveal();
    if (next.finished) {
      comparisonComplete = true; renderVerdict();
      stop(); message('Comparison complete. Inspect a bit or press Play to replay.');
    }
  }, 16);
  timer = activeTimer;
  message(result ? 'Complete hashes ready · walkthrough playing.' : 'Reading full files · walkthrough playing.');
}
function renderBitDetail() {
  if ((!hashMode() && !models) || !result || stage < 4) return;
  const position = Number($('bit').value);
  if (!Number.isInteger(position) || position < 1 || position > 256) return;
  const pair = pairForStage(), a = pair.a.values[position - 1], b = pair.b.values[position - 1];
  $('bit-detail').textContent = `A ${a} · B ${b} · ${a === b ? 'same' : 'different'}`;
}
function inspectBit() {
  const position = Number($('bit').value);
  if ((!hashMode() && !models) || !result || stage < 4 || !Number.isInteger(position) || position < 1 || position > 256) return;
  stop(); selected = position - 1; scene?.setSelected(selected); renderBitDetail();
  if ($('value-dialog').open) renderValues();
}
function initializeHashRollers() {
  for (const slot of ['a', 'b']) {
    const row = $(`hash-rollers-${slot}`);
    for (let index = 0; index < 64; index++) {
      const flap = createSplitFlap(document, { className: 'hash-digit' });
      const cell = flap.element;
      row.append(cell); hashRollers[slot].push({ cell, flap });
    }
  }
  resetHashOutputs();
}
function resetHashOutputs() {
  for (const slot of ['a', 'b']) {
    $(`hash-output-${slot}`).hidden = false;
    $(`hash-code-${slot}`).textContent = '';
    $(`hash-code-${slot}`).setAttribute('aria-label', `File ${slot.toUpperCase()} SHA-256: awaiting Digest.`);
    $(`hash-rollers-${slot}`).dataset.ready = 'false';
    $(`hash-rollers-${slot}`).dataset.progress = '0';
    $(`hash-rollers-${slot}`).dataset.mode = 'empty';
    $(`hash-rollers-${slot}`).dataset.readFraction = '0';
    $(`hash-rollers-${slot}`).dataset.readCells = '0';
    $(`hash-label-${slot}`).textContent = 'Full-file SHA-256';
    for (const { cell, flap } of hashRollers[slot]) {
      cell.classList.remove('different'); cell.title = '';
      cell.classList.remove('read-filled');
      cell.dataset.digit = ''; cell.dataset.startBit = ''; cell.dataset.differentBits = '';
      setSplitFlapValue(flap, '', { duration: 0 });
    }
  }
}
function renderHashOutputs() {
  if (stage < 4 || !result) {
    for (const slot of ['a', 'b']) {
      $(`hash-code-${slot}`).textContent = '';
      const detail = isHashInput(slot) ? expectedHashes[slot] ?? 'awaiting input.' : hashMode() ? 'calculating.' : 'awaiting Digest.';
      $(`hash-code-${slot}`).setAttribute('aria-label', `${hashLabel(slot)}: ${detail}`);
    }
    renderHashReveal(); return;
  }
  if (!hashOutputModel) hashOutputModel = hashComparison(result.hashA, result.hashB);
  const signature = `${hashOutputModel.a}:${hashOutputModel.b}`;
  if (signature !== hashOutputSignature) {
    for (const slot of ['a', 'b']) {
      hashOutputModel.digits.forEach((digit, index) => {
        const { cell } = hashRollers[slot][index];
        if (digit.different) cell.classList.add('different'); else cell.classList.remove('different');
        cell.dataset.digit = digit[slot];
        cell.dataset.startBit = String(digit.startBit);
        cell.dataset.differentBits = String(digit.differentBits);
        cell.title = `Bits ${digit.startBit + 1}–${digit.endBit + 1} · A ${digit.binaryA} · B ${digit.binaryB} · ${digit.differentBits} different`;
      });
    }
    hashOutputSignature = signature;
  }
  for (const slot of ['a', 'b']) {
    const code = $(`hash-code-${slot}`);
    if (code.textContent !== hashOutputModel[slot]) code.textContent = hashOutputModel[slot];
    code.setAttribute('aria-label', `${hashLabel(slot)}: ${hashOutputModel[slot]}`);
  }
  renderHashReveal();
}
function renderHashReveal() {
  const ready = stage >= 4 && !!result;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const progress = !ready ? 0 : reduced || stage > 4 ? 1 : Math.max(0, Math.min(1, elapsed / STAGE_MS[4]));
  for (const slot of ['a', 'b']) {
    const row = $(`hash-rollers-${slot}`);
    row.dataset.ready = String(ready); row.dataset.progress = String(progress);
    const readState = stage === 0 || (hashMode() && !result) ? reads?.[slot] : null;
    const readFraction = readState ? readState.total ? Math.max(0, Math.min(1, readState.processed / readState.total)) : 1 : 0;
    const readCells = readState ? readState.processed === readState.total ? 64 : Math.floor(readFraction * 64) : 0;
    row.dataset.mode = ready ? 'hash' : readState ? 'read' : 'empty';
    row.dataset.readFraction = String(readFraction); row.dataset.readCells = String(readCells);
    $(`hash-label-${slot}`).textContent = readState ? `File read · ${Math.floor(readFraction * 100)}%` : isHashInput(slot) ? hashLabel(slot) : 'Full-file SHA-256';
    hashRollers[slot].forEach(({ cell, flap }, index) => {
      if (index < readCells) cell.classList.add('read-filled'); else cell.classList.remove('read-filled');
      // Leave time to tick through the wheel, then land each paired column.
      // Both rows use one clock; easing belongs to the final flap, not the sweep.
      const q = Math.max(0, Math.min(1, (progress - .45 * index / 63) / .55));
      if (ready) setSplitFlapFrame(flap, '', cell.dataset.digit, q);
      else setSplitFlapValue(flap, index < readCells ? '\u2588' : '', { duration: readState ? 120 : 0, reducedMotion: reduced });
    });
  }
}

for (const slot of ['a', 'b']) {
  $(`copy-hash-${slot}`).addEventListener('click', () => copyHash(slot));
  $(`file-${slot}`).addEventListener('change', (event) => { if (event.target.files[0]) choose({ [slot]: event.target.files[0] }); });
  $(`remove-${slot}`).addEventListener('click', () => choose({ [slot]: null }));
  const target = $(`slot-${slot}`);
  target.addEventListener('dragover', (event) => { if (Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); target.classList.add('dragging'); } });
  target.addEventListener('dragleave', () => target.classList.remove('dragging'));
  target.addEventListener('drop', (event) => { event.preventDefault(); event.stopPropagation(); target.classList.remove('dragging'); const dropped = Array.from(event.dataTransfer.files); if (dropped.length === 1) choose({ [slot]: dropped[0] }); else message('Drop one file on each side.'); });
  const input = hashControl('expected-hash', slot);
  hashControl('mode-files', slot).addEventListener('click', () => {
    if (!isHashInput(slot)) return;
    inputModes[slot] = 'file';
    expectedHashes[slot] = null;
    choose();
  });
  hashControl('mode-hash', slot).addEventListener('click', () => {
    if (!isHashInput(slot)) {
      inputModes[slot] = 'hash';
      choose();
    }
    if (!touchInput.matches) input.focus?.({ preventScroll: !compactLayout.matches });
  });
  input.addEventListener('input', () => {
    showHashMessage(slot);
    if (!expectedHashes[slot]) return;
    expectedHashes[slot] = null;
    choose();
  });
  hashControl('hash-form', slot).addEventListener('submit', (event) => {
    event.preventDefault();
    if (!isHashInput(slot)) return;
    const normalized = normalizeExpectedHash(input.value);
    if (!normalized) {
      showHashMessage(slot, 'Enter all 64 hexadecimal characters (0–9, A–F).', true);
      input.focus?.();
      return;
    }
    input.value = normalized;
    expectedHashes[slot] = normalized;
    if (touchInput.matches) input.blur?.();
    choose();
  });
}
mobileInputsToggle?.addEventListener('click', () => {
  mobileInputsToggle.setAttribute('aria-expanded', String(mobileInputsToggle.getAttribute('aria-expanded') !== 'true'));
});
document.addEventListener('dragover', (event) => { if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault(); });
document.addEventListener('drop', (event) => { if (!Array.from(event.dataTransfer.types).includes('Files')) return; event.preventDefault(); const dropped = Array.from(event.dataTransfer.files); if (dropped.length === 2) choose({ a: dropped[0], b: dropped[1] }); else message('Choose one file on each side, or drop exactly two together.'); });
$('clear').addEventListener('click', () => {
  for (const slot of ['a', 'b']) {
    expectedHashes[slot] = null;
    hashControl('expected-hash', slot).value = '';
  }
  choose({ a: null, b: null });
});
$('example').addEventListener('click', () => { const a = new Uint8Array(256); for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 19) & 255; const b = a.slice(); b[29] ^= 1; choose({ a: new File([a], 'original.bin'), b: new File([b], 'one-bit-change.bin') }); });
$('previous').addEventListener('click', () => go(stage - 1));
$('next').addEventListener('click', () => go(stage + 1));
$('play').addEventListener('click', play);
for (const button of document.querySelectorAll('[data-stage]')) button.addEventListener('click', () => go(Number(button.dataset.stage)));
$('padding-progress').addEventListener('input', () => { stop(); paddingProgress = Number($('padding-progress').value) / 100; elapsed = paddingProgress * PADDING_FILL_MS; render(); });
$('schedule-word').addEventListener('input', () => { if ($('schedule-word').value !== '') setScheduleWord(Number($('schedule-word').value)); });
$('round').addEventListener('input', () => {
  const value = Number($('round').value);
  if (!models || stage !== 3 || !Number.isInteger(value) || value < 0 || value > 64) return;
  stop(); round = value; layer = null; spread = 1;
  elapsed = roundLayerElapsed(round ? round - 1 : null);
  render();
  if ($('value-dialog').open) renderValues();
});
$('layer').addEventListener('input', () => {
  const value = Number($('layer').value);
  if (!models || stage !== 3 || !Number.isInteger(value) || value < 0 || value > 64) return;
  stop(); layer = value === 0 ? null : value - 1;
  round = 64; spread = 1;
  elapsed = roundLayerElapsed(layer);
  render();
  if ($('value-dialog').open) renderValues();
});
$('spread').addEventListener('input', () => {
  const value = Number($('spread').value) / 100;
  if (!models || stage !== 3 || !Number.isFinite(value) || value < 0 || value > 1) return;
  stop(); spread = value; round = 64; layer = null;
  elapsed = roundSeparationElapsed(spread);
  scene?.setSpread(spread); render();
  if ($('value-dialog').open) renderValues();
});
$('bit').addEventListener('input', inspectBit);
function renderValues() {
  if (hashMode() && result) {
    $('value-title').textContent = 'SHA-256 comparison';
    $('value-summary').textContent = result.matches ? 'The hashes match.' : 'The hashes differ.';
    $('value-a').textContent = result.hashA;
    $('value-b').textContent = result.hashB;
    $('value-note').textContent = 'Each grid shows the 256 bits of the corresponding hash.';
    return;
  }
  if (!models) return;
  const inspectedRound = layer === null ? round : layer + 1;
  $('schedule-word').value = String(scheduleWord);
  $('value-title').textContent = stage === 2 ? $('stage-title').textContent : descriptions[stage][0];
  $('value-summary').textContent = stage >= 4 ? 'The complete SHA-256 hashes of both files.' : stage === 1 ? 'A 1 bit, zero bits and the original 64-bit length field are appended. Your source files are unchanged.' : stage === 2 ? scheduleWord < 16 ? `W${scheduleWord}: four original padded-block bytes, packed most-significant byte first.` : `W${scheduleWord}: four earlier words supply the terms below. All additions wrap at 32 bits.` : stage === 3 ? `The eight 32-bit working words after round ${inspectedRound}, for the first block.` : 'Actual file data, shown in hexadecimal.';
  for (const slot of ['a', 'b']) {
    const model = models[slot];
    let text;
    if (stage >= 4) text = result?.[slot === 'a' ? 'hashA' : 'hashB'] || 'Still reading…';
    else if (stage === 1) text = `${number.format(model.size)} original bytes\n+ ${model.paddedLength - model.size} padding bytes\n= ${number.format(model.paddedLength)} bytes\n= ${BigInt(model.paddedLength) * 8n} bits`;
    else if (stage === 2) {
      if (scheduleWord < 16) {
        const frame = scheduleGroupingFrame(model, scheduleWord);
        text = `${frame.bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ')}\n→ W${scheduleWord} = ${frame.hex}\n\n${frame.bits.join('')}\n\n4 bytes × 8 = 32 bits\n16 words × 32 = 512 bits`;
      } else {
        const frame = scheduleFrame(model.blocks[0], 64, scheduleWord);
        text = `${frame.operands.map((operand) => `${operand.label} = ${operand.value.toString(16).padStart(8, '0')}`).join('\n')}\n\nW${scheduleWord} = ${frame.hex}`;
      }
    }
    else if (stage === 3) text = (inspectedRound ? model.blocks[0].rounds[inspectedRound - 1].after : model.blocks[0].initial).map((word) => word.toString(16).padStart(8, '0')).join('\n');
    else text = pairForStage()[slot].values.slice(0, 16).map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
    $(`value-${slot}`).textContent = text;
  }
  $('value-note').textContent = stage >= 4 ? 'Each grid contains the 256 actual bits of its complete-file hash. The identity verdict also compares exact file bytes.' : stage === 3 ? 'These working words are from the first block. Digest and comparison use the hashes of the complete files.' : stage === 2 ? 'Particle paths are visual choreography, not literal data dependencies. The displayed schedule bits are calculated from the first padded block; the final hashes use every block.' : stage === 0 ? 'First 16 displayed bytes. The complete files are used for the final hashes.' : 'The animation uses calculated states. Gathering paths are illustrative and independent of the file reader’s speed.';
}
$('values').addEventListener('click', () => {
  stop(); if (!models && !(hashMode() && result)) return;
  $('copy-hash-error').hidden = true;
  renderValues();
  $('value-dialog').showModal();
});
$('close-values').addEventListener('click', () => $('value-dialog').close());
$('duration-seconds').addEventListener('input', setAnimationDuration);
$('duration-seconds').addEventListener('change', commitAnimationDuration);
$('duration-seconds').addEventListener('blur', commitAnimationDuration);
document.addEventListener('visibilitychange', () => { if (document.hidden) { stop(); stopAssembly(); } else beginAssembly(); });
window.addEventListener('pagehide', () => { stop(); stopAssembly(); readController?.abort(); if (worker || (hashMode() ? !result : !models)) cancelRun(); });
window.addEventListener('pageshow', () => { if (hasInputs() && (hashMode() ? !result : !models) && !worker) choose(); else beginAssembly(); });
if (typeof Worker !== 'function' || typeof File !== 'function') { $('example').disabled = true; message('A current browser with local file and worker support is required.'); }
$('duration-seconds').value = String(timing.seconds);
$('app').dataset.duration = String(timing.seconds);
initializeInstruments();
initializeHashRollers();
