const finite = (value) => Number.isFinite(value) ? value : 0;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const frameMilliseconds = (value) => clamp(finite(value), 0, 50);
const stopped = (velocity) => Math.abs(velocity) < 0.0005 ? 0 : velocity;

/** Integrate radians/second over a bounded frame, with exponential drag. */
export function integrateOrbitVelocity(vTheta, vPhi, deltaMs, { decay = 4.2 } = {}) {
  const seconds = frameMilliseconds(deltaMs) / 1000;
  const damping = Math.max(0, finite(decay));
  const attenuation = Math.exp(-damping * seconds);
  const travel = damping ? -Math.expm1(-damping * seconds) / damping : seconds;
  const theta = finite(vTheta), phi = finite(vPhi);
  return {
    deltaTheta: theta * travel,
    deltaPhi: phi * travel,
    velocityTheta: stopped(theta * attenuation),
    velocityPhi: stopped(phi * attenuation),
  };
}

/** Derive a bounded release velocity from one pointer-movement sample. */
export function dragOrbitVelocity(dx, dy, elapsedMs) {
  const seconds = clamp(finite(elapsedMs), 8, 80) / 1000;
  return {
    theta: clamp(-finite(dx) * 0.007 / seconds, -3, 3) || 0,
    phi: clamp(-finite(dy) * 0.007 / seconds, -3, 3) || 0,
  };
}

// Integral of a smoothstep speed ramp, in milliseconds of full-speed travel.
function idleTravel(quietMs) {
  if (quietMs <= 1200) return 0;
  if (quietMs >= 3000) return 900 + quietMs - 3000;
  const progress = (quietMs - 1200) / 1800;
  return 1800 * (progress ** 3 - 0.5 * progress ** 4);
}

/** Slow positive orbit; quietMs is time since interaction at frame end. */
export function idleOrbitDelta(deltaMs, quietMs) {
  const milliseconds = frameMilliseconds(deltaMs);
  const quiet = Math.max(0, finite(quietMs));
  if (!milliseconds || quiet <= 1200) return 0;
  // Avoid subtracting two very large timestamps after the ramp is complete.
  if (quiet - milliseconds >= 3000) return milliseconds * 0.035 / 1000;
  return (idleTravel(quiet) - idleTravel(Math.max(0, quiet - milliseconds))) * 0.035 / 1000;
}
