const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const smooth = (value) => value * value * (3 - 2 * value);
const FLIGHT_SPAN = 0.28;
const START_SPAN = 0.68;

function validateCount(count) {
  if (!Number.isInteger(count) || count < 1 || count > 72) throw new RangeError('Padding flights contain 1 to 72 actual byte points.');
}
function normalizedProgress(progress) { return Number.isFinite(progress) ? clamp(progress, 0, 1) : 0; }
function triple(value, label) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== 3 || Array.from(value).some((coordinate) => !Number.isFinite(coordinate))) {
    throw new TypeError(`${label} must contain three finite coordinates.`);
  }
  return Array.from(value);
}

/** One actual padding byte's staggered arrival, driven by the shared stage clock. */
export function paddingFlight(ordinal, count, progress) {
  validateCount(count);
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= count) throw new RangeError('Select an actual padding byte within this flight.');
  const stage = normalizedProgress(progress);
  const start = ordinal / Math.max(1, count - 1) * START_SPAN;
  const started = stage > 0 && stage >= start;
  const arrived = started && stage >= start + FLIGHT_SPAN - 1e-12;
  return { started, arrived, progress: arrived ? 1 : clamp((stage - start) / FLIGHT_SPAN, 0, 1) };
}

/** Counts of real padding bytes in flight and settled; no synthetic cube cells. */
export function paddingFlightCounts(count, progress) {
  validateCount(count);
  let started = 0, arrived = 0;
  for (let ordinal = 0; ordinal < count; ordinal++) {
    const flight = paddingFlight(ordinal, count, progress);
    started += Number(flight.started); arrived += Number(flight.arrived);
  }
  return { started, arrived, total: count };
}

/** A short deterministic flight from just outside the nearest cube face. */
export function paddingFlightPosition(target, ordinal, count, progress, halfExtents = [2.5, 2.5, 2.5]) {
  const destination = triple(target, 'The padding target');
  const bounds = triple(halfExtents, 'The cube half-extents');
  if (bounds.some((bound) => bound < 0) || destination.some((coordinate, axis) => Math.abs(coordinate) > bounds[axis] + 1e-7)) {
    throw new RangeError('The padding target must lie within non-negative cube half-extents.');
  }
  const flight = paddingFlight(ordinal, count, progress);
  if (flight.arrived) return destination;

  // Prefer the depth face for equal distances, matching the tail of a filled
  // byte lattice. The same byte ordinal follows the same path in both lanes.
  let face = 2;
  for (const axis of [1, 0]) if (bounds[axis] - Math.abs(destination[axis]) < bounds[face] - Math.abs(destination[face]) - 1e-12) face = axis;
  const side = Math.sign(destination[face]) || 1;
  const phase = ordinal * 2.399963229728653 + count * 0.17;
  const entry = destination.slice();
  entry[face] = side * (bounds[face] + 1 + 0.2 * Math.sin(phase) ** 2);
  const tangentA = (face + 1) % 3, tangentB = (face + 2) % 3;
  entry[tangentA] += Math.cos(phase) * 0.18;
  entry[tangentB] += Math.sin(phase) * 0.18;

  const travel = smooth(flight.progress);
  const point = destination.map((coordinate, axis) => entry[axis] + (coordinate - entry[axis]) * travel);
  const curve = Math.sin(Math.PI * travel) * 0.22;
  point[tangentA] += Math.sin(phase) * curve;
  point[tangentB] += Math.cos(phase) * curve;
  return point;
}
