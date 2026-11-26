// Stage clocks use base milliseconds. Playback rate converts
// wall time into that shared clock, so UI, WebGL and CSS can scale together.
export const ASSEMBLY_MS = 1800;
export const STAGE_MS = Object.freeze([2200, 5200, 4200, 7200, 2400, 2400]);
export const PADDING_FILL_MS = 4400;
export const ROUND_STEP_MS = 100;
export const TRANSITION_MS = Object.freeze([1100, 1100, 1100, 1100, 1800, 1100]);
export const ROUND_PHASES = Object.freeze({
  entranceEnd: TRANSITION_MS[3],
  separationEnd: TRANSITION_MS[3] + 2000,
  scanEnd: STAGE_MS[3] - 250,
  end: STAGE_MS[3],
});
// Retained for the earlier moving-viewport comparison study and renderer
// support. The active comparison keeps the digest panes side by side.
export const COMPARE_PHASES = Object.freeze({
  compactEnd: 0.20,
  verticalEnd: 0.425,
  horizontalEnd: 0.65,
  end: 1,
});
export const SLOW_TOTAL_MS = ASSEMBLY_MS + STAGE_MS.reduce((sum, value) => sum + value, 0);
export const FAST_TOTAL_MS = 4000;
export const DEFAULT_DURATION_SECONDS = 8;
export const MIN_DURATION_SECONDS = 1;
export const MAX_DURATION_SECONDS = 120;
const CLOCK_TOLERANCE_MS = 1e-7;

/** Complete visual duration, including assembly, digest and comparison reveal. */
export function playbackTiming(durationSeconds = DEFAULT_DURATION_SECONDS) {
  // Keep the former presets as source-compatible references. The development
  // interface supplies seconds directly and does not expose animal modes.
  const mode = durationSeconds === 'rabbit' || durationSeconds === 'turtle' ? durationSeconds : 'custom';
  const seconds = mode === 'rabbit' ? FAST_TOTAL_MS / 1000 : mode === 'turtle' ? SLOW_TOTAL_MS / 1000 : durationSeconds;
  if (!Number.isFinite(seconds) || seconds < MIN_DURATION_SECONDS || seconds > MAX_DURATION_SECONDS) {
    throw new RangeError(`Choose an animation duration from ${MIN_DURATION_SECONDS} to ${MAX_DURATION_SECONDS} seconds.`);
  }
  const totalMs = seconds * 1000;
  const rate = SLOW_TOTAL_MS / totalMs;
  const scale = 1 / rate;
  return Object.freeze({
    mode, seconds, rate, scale, totalMs,
    assemblyMs: ASSEMBLY_MS * scale,
    stageMs: Object.freeze(STAGE_MS.map((duration) => duration * scale)),
    transitionMs: Object.freeze(TRANSITION_MS.map((duration) => duration * scale)),
    paddingFillMs: PADDING_FILL_MS * scale,
  });
}

function clampRoundValue(value, minimum, maximum) {
  if (!Number.isFinite(value)) throw new RangeError('Round playback values must be finite numbers.');
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Rounds first enter with all 64 layers, separate, then scan All / 1..64.
 * All and each actual layer receive one equal scan slot. A final All hold
 * clears the layer emphasis before Digest. Keep the full round available
 * throughout; selecting a layer only changes its visual emphasis.
 */
export function roundPlaybackFrame(elapsed) {
  const time = clampRoundValue(elapsed, 0, ROUND_PHASES.end);
  if (time + CLOCK_TOLERANCE_MS >= ROUND_PHASES.scanEnd) {
    return { phase: 'complete', spread: 1, layer: null, round: 64 };
  }
  if (time + CLOCK_TOLERANCE_MS < ROUND_PHASES.entranceEnd) {
    return { phase: 'entrance', spread: 0, layer: null, round: 64 };
  }
  if (time + CLOCK_TOLERANCE_MS < ROUND_PHASES.separationEnd) {
    return { phase: 'separate', spread: Math.max(0, (time - ROUND_PHASES.entranceEnd) / (ROUND_PHASES.separationEnd - ROUND_PHASES.entranceEnd)), layer: null, round: 64 };
  }
  const scanProgress = Math.max(0, (time - ROUND_PHASES.separationEnd) / (ROUND_PHASES.scanEnd - ROUND_PHASES.separationEnd));
  // Inverting a selected layer can land infinitesimally below its slot because
  // of floating-point division. This tolerance is far below a visible frame.
  const slot = Math.min(64, Math.floor(scanProgress * 65 + 1e-10));
  return { phase: 'scan', spread: 1, layer: slot === 0 ? null : slot - 1, round: 64 };
}

/** Seek the linear separation sweep without changing its selected amount. */
export function roundSeparationElapsed(spread) {
  return ROUND_PHASES.entranceEnd + clampRoundValue(spread, 0, 1) * (ROUND_PHASES.separationEnd - ROUND_PHASES.entranceEnd);
}

/** Seek the beginning of All (null) or one of the 64 actual layer slots. */
export function roundLayerElapsed(layer) {
  if (layer !== null && (!Number.isInteger(layer) || layer < 0 || layer > 63)) {
    throw new RangeError('Select All or a round layer from 0 to 63.');
  }
  const slot = layer === null ? 0 : layer + 1;
  return ROUND_PHASES.separationEnd + slot / 65 * (ROUND_PHASES.scanEnd - ROUND_PHASES.separationEnd);
}

function smoothComparisonLeg(progress, start, end) {
  const fraction = Math.max(0, Math.min(1, (progress - start) / (end - start)));
  return fraction * fraction * (3 - 2 * fraction);
}

/** Retained study: comparison progress shared by geometry and viewport placement. */
export function compareChoreographyFrame(progress) {
  if (!Number.isFinite(progress)) throw new RangeError('Comparison progress must be a finite number.');
  const time = Math.max(0, Math.min(1, progress));
  const compact = smoothComparisonLeg(time, 0, COMPARE_PHASES.compactEnd);
  const vertical = smoothComparisonLeg(time, COMPARE_PHASES.compactEnd, COMPARE_PHASES.verticalEnd);
  const horizontal = smoothComparisonLeg(time, COMPARE_PHASES.verticalEnd, COMPARE_PHASES.horizontalEnd);
  const stretch = smoothComparisonLeg(time, COMPARE_PHASES.horizontalEnd, COMPARE_PHASES.end);
  return { compact, vertical, horizontal, stretch, scale: (1 - compact) + 0.42 * compact };
}

/**
 * Rectangles use percentages of the shared stage; padding uses CSS pixels.
 * Keep the viewport columns separate until their rows are fully separated,
 * then widen and recenter each row before the 256 points unfold into a line.
 */
export function compareLayoutFrame(progress) {
  const { vertical, horizontal } = compareChoreographyFrame(progress);
  const width = 50 + 50 * horizontal;
  const height = 100 - 50 * vertical;
  const padding = {
    paddingTop: 70 * (1 - vertical) + 30 * vertical,
    paddingRight: 20 * horizontal,
    paddingBottom: 30 * (1 - vertical) + 46 * vertical,
    paddingLeft: 20 * horizontal,
  };
  return {
    A: { left: 0, top: 0, width, height, ...padding },
    B: { left: 50 * (1 - horizontal), top: 50 * vertical, width, height, ...padding },
  };
}

/**
 * Advance the six-stage base clock without losing time at stage boundaries.
 * crossedStages lists the new stage indices entered, in chronological order.
 * Finishing the comparison stays at stage5, clamped to its final duration.
 */
export function advancePlayback(stage, elapsed, deltaBaseMs) {
  if (!Number.isInteger(stage) || stage < 0 || stage >= STAGE_MS.length) throw new RangeError('Select a playback stage from 0 to 5.');
  if (!Number.isFinite(elapsed) || elapsed < 0 || !Number.isFinite(deltaBaseMs) || deltaBaseMs < 0) {
    throw new RangeError('Playback time must be finite and non-negative.');
  }
  let remaining = elapsed + deltaBaseMs;
  if (!Number.isFinite(remaining)) throw new RangeError('Playback time exceeds the supported clock.');
  const crossedStages = [];
  // Round-off across repeated frame deltas must not add another frame to an
  // exact-duration sequence. This tolerance is far below a visible tick.
  while (stage < STAGE_MS.length - 1 && remaining + CLOCK_TOLERANCE_MS >= STAGE_MS[stage]) {
    remaining = Math.max(0, remaining - STAGE_MS[stage]);
    crossedStages.push(++stage);
  }
  const finished = stage === STAGE_MS.length - 1 && remaining + CLOCK_TOLERANCE_MS >= STAGE_MS[stage];
  return { stage, elapsed: finished ? STAGE_MS[stage] : remaining, finished, crossedStages };
}
