import * as THREE from './vendor/three/three.module.js';
import { integrateOrbitVelocity, dragOrbitVelocity, idleOrbitDelta } from './camera-motion.mjs';
import { paddingFlight, paddingFlightPosition } from './padding-motion.mjs';
import { compareChoreographyFrame } from './playback-timing.mjs';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const COLORS = { a: new THREE.Color('#2d8068'), b: new THREE.Color('#4066a7'), difference: new THREE.Color('#d86635'), marker: new THREE.Color('#a98b2f'), length: new THREE.Color('#8f6cad'), selected: new THREE.Color('#785b16') };
const STAGES = new Set(['bytes', 'padding', 'block', 'schedule', 'rounds', 'digest', 'compare']);
const smooth = (value) => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };
const MAX_FLOW_POINTS = 131216;
const HASH_COMPACT_SCALE = compareChoreographyFrame(1).scale;

// Spatial buckets keep the illustrative handoff local even for the largest
// sampled file. These visual neighbours do not assert a SHA-256 dependency.
function spatialLookup(positions, alpha = null) {
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  let count = 0;
  for (let point = 0; point < positions.length / 3; point++) {
    if (alpha && alpha[point] <= 0.01) continue;
    count++;
    for (let axis = 0; axis < 3; axis++) { const value = positions[point * 3 + axis]; low[axis] = Math.min(low[axis], value); high[axis] = Math.max(high[axis], value); }
  }
  if (!count) return () => -1;
  const cell = Math.max(0.001, ...high.map((value, axis) => value - low[axis])) / Math.max(1, Math.cbrt(count));
  const limits = high.map((value, axis) => Math.max(0, Math.floor((value - low[axis]) / cell)));
  const key = (x, y, z) => `${x},${y},${z}`;
  const buckets = new Map();
  for (let point = 0; point < positions.length / 3; point++) {
    if (alpha && alpha[point] <= 0.01) continue;
    const coordinates = low.map((value, axis) => Math.floor((positions[point * 3 + axis] - value) / cell));
    const name = key(...coordinates);
    if (!buckets.has(name)) buckets.set(name, []);
    buckets.get(name).push(point);
  }
  return (x, y, z, preferNeighbour = false) => {
    const query = [x, y, z], center = low.map((value, axis) => clamp(Math.floor((query[axis] - value) / cell), 0, limits[axis]));
    let best = -1, next = -1, distance = Infinity, nextDistance = Infinity;
    const maxRadius = Math.max(...limits, 1);
    for (let radius = 1; radius <= maxRadius + 1; radius++) {
      for (let bz = Math.max(0, center[2] - radius); bz <= Math.min(limits[2], center[2] + radius); bz++) {
        for (let by = Math.max(0, center[1] - radius); by <= Math.min(limits[1], center[1] + radius); by++) {
          for (let bx = Math.max(0, center[0] - radius); bx <= Math.min(limits[0], center[0] + radius); bx++) {
            if (radius > 1 && Math.max(Math.abs(bx - center[0]), Math.abs(by - center[1]), Math.abs(bz - center[2])) < radius) continue;
            for (const point of buckets.get(key(bx, by, bz)) ?? []) {
              const offset = point * 3;
              const candidate = (positions[offset] - x) ** 2 + (positions[offset + 1] - y) ** 2 + (positions[offset + 2] - z) ** 2;
              if (candidate < distance) { next = best; nextDistance = distance; best = point; distance = candidate; }
              else if (candidate < nextDistance) { next = point; nextDistance = candidate; }
            }
          }
        }
      }
      if (best >= 0) break;
    }
    // Identical layouts still pass through a small local regrouping. Never
    // send a point across the whole line just to introduce motion.
    return preferNeighbour && distance < 1e-10 && next >= 0 ? next : best;
  };
}

// A visual bridge from four round planes into one lasting256-dot sheet.
// Coalescing paths are choreography; they do not imply hash dependencies.
function roundsDigestPath(from, target, output, progress) {
  if (progress === 0) { output.set(from); return; }
  if (progress === 1) { output.set(target); return; }
  const folding = smooth(progress / 0.76);
  for (let offset = 0; offset < output.length; offset++) output[offset] = from[offset] + (target[offset] - from[offset]) * folding;
}

const digestSheetPosition = (bit) => [(bit % 16 - 7.5) * 0.36, (7.5 - Math.floor(bit / 16)) * 0.36, 0];

// The source offset, rather than frame order, gives a byte a stable place in
// the cloud. The same sampled byte follows the same path in both viewports.
function cloudSeed(index, sourceOffset = index) {
  let seed = ((sourceOffset % 0x100000000) ^ Math.floor(sourceOffset / 0x100000000) ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  const random = () => { seed = Math.imul(seed ^ (seed >>> 16), 0x21f0aaad); seed = Math.imul(seed ^ (seed >>> 15), 0x735a2d97); seed ^= seed >>> 15; return (seed >>> 0) / 0x100000000; };
  const x = (random() * 2 - 1) * 2.75, y = (random() * 2 - 1) * 2.45, z = (random() * 2 - 1) * 2.65;
  const phase = random() * Math.PI * 2;
  const angle = random() * Math.PI * 2, lift = (random() * 2 - 1) * 0.65;
  return [x, y, z, phase, Math.cos(angle) * 1.05, lift, Math.sin(angle) * 1.05];
}

/** A byte's bounded ambient/arrival position before it joins the exact grid. */
export function byteCloudPosition(index, sourceOffset = index, time = 0, age = 1000) {
  const [x, y, z, phase, entryX, entryY, entryZ] = cloudSeed(index, sourceOffset);
  const entry = 1 - smooth(age / 600);
  return [x + Math.sin(time * 0.00046 + phase) * 0.16 + entryX * entry,
    y + Math.sin(time * 0.00033 + phase * 1.7) * 0.18 + entryY * entry,
    z + Math.cos(time * 0.00039 + phase * 1.3) * 0.16 + entryZ * entry];
}

export function rectangularLayout(capacity) {
  if (!Number.isInteger(capacity) || capacity < 0 || capacity > 65608) throw new RangeError('A byte lattice has capacity 0 to 65,608.');
  // Size all three axes from the planned padded byte count. Reusing this
  // capacity in Bytes and Padding keeps every original byte in its place.
  // Unused cells in the final partial row/layer are never rendered as data.
  const count = Math.max(1, capacity);
  const columns = Math.ceil(Math.cbrt(count));
  const rows = Math.ceil(Math.sqrt(count / columns));
  const layers = Math.ceil(count / (columns * rows));
  return { columns, rows, layers, cell: 5 / Math.max(columns - 1, rows - 1, layers - 1, 1) };
}

/** Both independent viewports use identical centered coordinates and index order. */
export function pointPosition(index, count, stage, lane = 'a', spread = 0, windowStart = 0, windowSize = 256, paddingStart = count, paddingProgress = 1, capacity = count, scheduleGrouping = 1, animatePadding = true) {
  if (stage === 'digest') return digestSheetPosition(index);
  if (stage === 'compare') return [(index - windowStart - (windowSize - 1) / 2) * 0.12, 0, 0];
  if (stage === 'schedule') {
    const word = Math.floor(index / 32), bit = index % 32;
    const tileX = word % 2, tileY = Math.floor((word % 8) / 2);
    const x = tileX * 8 + bit % 8, y = tileY * 4 + Math.floor(bit / 8), z = Math.floor(word / 8);
    const tile = [(x - 7.5) * 0.32 + (tileX - 0.5) * 0.24,
      (7.5 - y) * 0.30 - (tileY - 1.5) * 0.18,
      (z - 3.5) * 0.72 * (1 + spread * 1.5)];
    if (index >= 512 || scheduleGrouping >= 1) return tile;
    // Exactly eight real bits begin at each of the64 isolated source bytes.
    // W16 onwards are computed words and have no byte parent to split from.
    const byte = pointPosition(Math.floor(index / 8), 64, 'block');
    const grouping = clamp(scheduleGrouping, 0, 1);
    return tile.map((coordinate, axis) => byte[axis] + (coordinate - byte[axis]) * grouping);
  }
  if (stage === 'rounds') return [(index % 8 - 3.5) * 0.72, (1.5 - Math.floor(index / 8) % 4) * 1.68, (Math.floor(index / 32) - 31.5) * (0.08 + spread * 0.20)];
  const { columns, rows, layers, cell } = rectangularLayout(stage === 'block' ? 64 : capacity);
  const position = [(index % columns - (columns - 1) / 2) * cell,
    ((rows - 1) / 2 - Math.floor(index / columns) % rows) * cell,
    (Math.floor(index / (columns * rows)) - (layers - 1) / 2) * cell];
  const added = count - paddingStart;
  return animatePadding && stage === 'padding' && index >= paddingStart && added > 0 && added <= 72
    ? paddingFlightPosition(position, index - paddingStart, added, paddingProgress,
      [(columns - 1) * cell / 2, (rows - 1) * cell / 2, (layers - 1) * cell / 2]) : position;
}

export function normalizePointLane(lane = {}, stage = 'bytes') {
  const values = Array.from(lane.values ?? lane.bits ?? []);
  const bits = stage === 'schedule' || stage === 'digest' || stage === 'compare';
  const cap = stage === 'block' ? 64 : stage === 'schedule' || stage === 'rounds' ? 2048 : bits ? 256 : stage === 'padding' ? 65608 : 65536;
  if (values.length > cap) throw new RangeError(`This stage supports up to ${cap} ${bits ? 'bits' : 'bytes'}.`);
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > (bits ? 1 : 255))) throw new TypeError(bits ? 'Final markers must be bits (0 or 1).' : 'Data points must be bytes (0 to 255).');
  const capacity = Number.isInteger(lane.capacity) ? lane.capacity : stage === 'block' ? 64 : values.length;
  if (stage === 'block' && capacity !== 64) throw new RangeError('An isolated SHA-256 block has capacity64 bytes.');
  if ((stage === 'bytes' || stage === 'padding') && capacity < values.length) throw new RangeError('Byte-lattice capacity must include every displayed byte.');
  if (stage === 'bytes' || stage === 'padding') rectangularLayout(capacity);
  const readCount = Number.isFinite(lane.readCount) ? clamp(Math.floor(lane.readCount), 0, values.length) : values.length;
  const sourceOffsets = lane.sourceOffsets == null ? null : Array.from(lane.sourceOffsets);
  if (sourceOffsets !== null && (sourceOffsets.length !== values.length
    || sourceOffsets.some((offset) => !Number.isSafeInteger(offset) || offset < 0))) {
    throw new TypeError('Every sampled byte point needs an exact non-negative source offset.');
  }
  return { values, kinds: Array.from(lane.kinds ?? []), name: String(lane.name ?? ''), capacity, readCount, sourceOffsets };
}

const vertexShader = `
attribute vec3 pointColor;
attribute float pointAlpha;
attribute float pointSelected;
uniform float pointSize;
uniform float pixelRatio;
uniform float perspectiveSize;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * p;
  float attenuation = mix(1.0, clamp(26.0 / max(1.0, -p.z), 0.35, 2.0), perspectiveSize);
  gl_PointSize = (pointSize + pointSelected * 5.0) * pixelRatio * attenuation;
  vColor = pointColor;
  vAlpha = pointAlpha;
}`;
const fragmentShader = `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float r = length(gl_PointCoord * 2.0 - 1.0);
  if (r > 1.0 || vAlpha < 0.01) discard;
  gl_FragColor = vec4(vColor, vAlpha * (1.0 - smoothstep(0.78, 1.0, r)));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * Local point renderer. onPick({lane,index,bitA,bitB,valueA,valueB}) uses
 * zero-based indices; byte stages expose byte values in all four value fields.
 * onError receives a readable failure or '' when the graphics context returns.
 * onCompareFrame reports rendered bit0/255 endpoints in viewport CSS pixels,
 * plus local line-unfolding progress, for aligned browser-native hash text.
 * Staged Digest→Compare also reports its raw shared overallProgress.
 * onCompareProgress runs before canvas measurement/rendering so the browser
 * can position both independent viewports on that same animation frame.
 * compareLayout: 'grid' keeps Compare in the Digest sheet and suppresses
 * line-layout callbacks; omitting it preserves the original line handoff.
 * animationRate scales pipeline motion and retimes an active transition in
 * place; camera inertia, idle orbit and actual-read arrival remain independent.
 */
export function createVoxelScene(canvas, { onPick, onError, onCameraChange, onCompareFrame, onCompareProgress, lane = 'a', motionLeader = true } = {}) {
  if (lane !== 'a' && lane !== 'b') throw new TypeError('Choose file lane a or b.');
  let renderer, disposed = false, contextLost = false;
  const report = (message) => { if (!disposed) onError?.(message); };
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' }); }
  catch {
    report('The 3D view needs WebGL 2. Enable hardware acceleration or try another browser. File comparison remains available.');
    return { available: false, setData() {}, setSelected() {}, setLayer() {}, setSpread() {}, getCameraState() { return { theta: 0, phi: 1.12, zoom: 1 }; }, setCameraState() {}, dispose() { disposed = true; } };
  }
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.debug.onShaderError = () => { contextLost = true; clearMotion(); clearGesture(); finishTransition(); report('The browser could not compile the 3D point renderer. Try another browser or graphics driver. File comparison remains available.'); };
  const scene = new THREE.Scene();
  const perspective = new THREE.PerspectiveCamera(38, 1, 0.1, 500);
  const orthographic = new THREE.OrthographicCamera(-18, 18, 10, -10, 0.1, 500);
  const flowCamera = new THREE.Camera();
  const flowFromProjection = new THREE.Matrix4(), flowTargetProjection = new THREE.Matrix4(), flowProjection = new THREE.Matrix4(), compactProjection = new THREE.Matrix4();
  orthographic.position.set(0, 0, 50); orthographic.lookAt(0, 0, 0);
  let camera = perspective;
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const oldTouchAction = canvas.style.touchAction; canvas.style.touchAction = 'none';
  let data = { a: { values: [], kinds: [] }, b: { values: [], kinds: [] }, stage: 'bytes', round: 64, paddingStart: 0, paddingProgress: 1,
    scheduleWordCount: 64, scheduleWord: 63, scheduleSources: [], scheduleGrouping: 1, byteCloud: false, byteAssembly: 1, flowMode: false, animationRate: 1, compareLayout: 'line' };
  let selectedBit = null, selectedLayer = null, spread = 0, bitWindowStart = 0, bitWindowSize = 256;
  let theta = 0, phi = 1.12, zoom = 1, width = 1, height = 1, pixelRatio = null, raf = null, transition = null, pendingCompare = null, gesture = null;
  let ownsMotion = motionLeader, velocityTheta = 0, velocityPhi = 0, motionFrame = null, quietSince = performance.now(), lastDrag = null;
  const pointers = new Map(), views = [];
  let connectorGeometry = null, connectorMaterial = null, connectorLines = null;
  const isBits = () => data.stage === 'digest' || data.stage === 'compare';
  const isCompareGrid = () => data.stage === 'compare' && data.compareLayout === 'grid';
  const isSheet = () => data.stage === 'digest' || isCompareGrid();
  const hasBitValues = () => isBits() || data.stage === 'schedule';
  for (const currentLane of [lane]) {
    const material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms: { pointSize: { value: 5 }, pixelRatio: { value: 1 }, perspectiveSize: { value: 1 } }, transparent: true, depthWrite: false, depthTest: true });
    views.push({ lane: currentLane, material, points: null, from: null, target: null, cloud: null, arrivals: null, baseAlpha: null, outgoing: null });
  }
  function schedule() { if (!disposed && !contextLost && !document.hidden && raf === null) raf = window.requestAnimationFrame(draw); }
  function clearMotion() { velocityTheta = 0; velocityPhi = 0; motionFrame = null; lastDrag = null; quietSince = performance.now(); }
  function clearGesture() {
    const captured = [...pointers.keys()]; pointers.clear(); gesture = null;
    for (const pointerId of captured) if (canvas.hasPointerCapture?.(pointerId)) canvas.releasePointerCapture?.(pointerId);
  }
  function takeMotion(broadcast = false) { ownsMotion = true; clearMotion(); if (broadcast && data.flowMode) onCameraChange?.(getCameraState()); }
  function orbitAvailable() {
    if (!data.flowMode || isBits() || reducedMotion.matches || contextLost || disposed || document.hidden) return false;
    return ['a', 'b'].some((key) => {
      if (data.stage === 'bytes') return data[key].readCount > 0;
      if (data.stage === 'padding') return lanePaddingStart(key) > 0 || data.paddingProgress > 0 && data[key].values.length > 0;
      if (data.stage === 'rounds') return data.round > 0 && data[key].values.length > 0;
      return data[key].values.length > 0;
    });
  }
  const orbitMoving = () => ownsMotion && orbitAvailable() && pointers.size === 0;
  function advanceOrbit(now) {
    const deltaMs = motionFrame === null ? 0 : Math.max(0, now - motionFrame); motionFrame = now;
    if (!orbitMoving()) return;
    let deltaTheta = 0, deltaPhi = 0;
    if (velocityTheta || velocityPhi) {
      const motion = integrateOrbitVelocity(velocityTheta, velocityPhi, deltaMs);
      velocityTheta = motion.velocityTheta; velocityPhi = motion.velocityPhi;
      deltaTheta = motion.deltaTheta; deltaPhi = motion.deltaPhi; quietSince = now;
    } else deltaTheta = idleOrbitDelta(deltaMs, Math.max(0, now - quietSince));
    if (deltaTheta || deltaPhi) {
      theta += deltaTheta; phi = clamp(phi + deltaPhi, 0.15, Math.PI - 0.15);
      if (phi === 0.15 || phi === Math.PI - 0.15) velocityPhi = 0;
      onCameraChange?.(getCameraState());
    }
  }
  function lanePaddingStart(lane) { return typeof data.paddingStart === 'object' ? data.paddingStart?.[lane] ?? data[lane].values.length : data.paddingStart; }
  function updateConnectors() {
    const view = views[0];
    const targetWord = data.scheduleWord;
    const sources = data.scheduleSources.filter((word) => word < data.scheduleWordCount
      && word !== targetWord && (word + 1) * 32 <= data[lane].values.length);
    if (data.flowMode || data.stage !== 'schedule' || targetWord < 16 || targetWord >= data.scheduleWordCount
      || (targetWord + 1) * 32 > data[lane].values.length || !sources.length || !view?.points) {
      if (connectorLines?.parent) scene.remove(connectorLines);
      connectorGeometry?.setDrawRange(0, 0);
      return;
    }
    if (!connectorLines) {
      connectorGeometry = new THREE.BufferGeometry();
      connectorGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
      connectorGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);
      connectorMaterial = new THREE.LineBasicMaterial({ color: '#89947e', transparent: true, opacity: 0.55, depthWrite: false });
      connectorLines = new THREE.LineSegments(connectorGeometry, connectorMaterial);
      connectorLines.userData.scheduleDependencies = true;
      connectorLines.frustumCulled = false;
    }
    if (!connectorLines.parent) scene.add(connectorLines);
    const position = view.points.geometry.attributes.position.array;
    const center = (word) => {
      const value = [0, 0, 0];
      for (let bit = 0; bit < 32; bit++) for (let axis = 0; axis < 3; axis++) value[axis] += position[(word * 32 + bit) * 3 + axis] / 32;
      return value;
    };
    const target = center(targetWord), connection = connectorGeometry.attributes.position;
    sources.slice(0, 4).forEach((sourceWord, index) => {
      connection.array.set(center(sourceWord), index * 6);
      connection.array.set(target, index * 6 + 3);
    });
    connectorGeometry.setDrawRange(0, Math.min(4, sources.length) * 2);
    connection.needsUpdate = true;
  }
  function updateColors() {
    for (const view of views) {
      if (!view.points) continue;
      const lane = data[view.lane], attributes = view.points.geometry.attributes;
      const paddingStart = clamp(lanePaddingStart(view.lane), 0, lane.values.length);
      for (let i = 0; i < lane.values.length; i++) {
        const value = lane.values[i], kind = lane.kinds?.[i] ?? 'message';
        const readReady = data.stage !== 'bytes' || (i < data.a.readCount && i < data.b.readCount);
        const sourceAligned = (data.stage !== 'bytes' && data.stage !== 'padding' && data.stage !== 'block')
          || (data.a.sourceOffsets?.[i] ?? i) === (data.b.sourceOffsets?.[i] ?? i);
        const comparable = readReady && sourceAligned;
        const difference = comparable && data.a.values[i] !== data.b.values[i];
        const word = Math.floor(i / 32);
        const activeWord = !data.flowMode && data.stage === 'schedule' && word === data.scheduleWord && word < data.scheduleWordCount;
        const sourceWord = !data.flowMode && data.stage === 'schedule' && data.scheduleSources.includes(word) && word < data.scheduleWordCount;
        const color = (difference ? COLORS.difference : i === selectedBit ? COLORS.selected : activeWord ? COLORS.marker : sourceWord ? COLORS.length : kind === 'marker' || kind === 'zero' ? COLORS.marker : kind === 'length' ? COLORS.length : COLORS[view.lane]).clone();
        color.multiplyScalar(i === selectedBit || difference ? 1 : hasBitValues() ? value ? 1 : 0.48 : 0.48 + value / 255 * 0.52);
        color.toArray(attributes.pointColor.array, i * 3);
        let alpha = hasBitValues() ? value ? 1 : 0.55 : 0.88;
        if (difference && isBits()) alpha = 1;
        if (data.stage === 'bytes' && i >= lane.readCount) alpha = 0;
        if (data.stage === 'schedule') {
          if (word >= data.scheduleWordCount || (data.scheduleGrouping < 1 && word >= 16)) alpha = 0;
          else if (!data.flowMode && !activeWord && !sourceWord) alpha *= 0.40;
        }
        if (data.stage === 'rounds') { const layer = Math.floor(i / 32); if (layer >= data.round) alpha = 0; else if (selectedLayer !== null && layer !== selectedLayer) alpha *= 0.07; }
        if (data.stage === 'padding' && i >= paddingStart) {
          const added = lane.values.length - paddingStart;
          if (added <= 72) {
            const flight = paddingFlight(i - paddingStart, added, data.paddingProgress);
            alpha *= reducedMotion.matches ? Number(flight.arrived) : flight.started ? clamp(flight.progress / 0.12, 0, 1) : 0;
          } else if (i >= paddingStart + Math.ceil(added * data.paddingProgress)) alpha = 0;
        }
        if (data.stage === 'compare' && (i < bitWindowStart || i >= bitWindowStart + bitWindowSize)) alpha = 0;
        if (view.baseAlpha) view.baseAlpha[i] = alpha;
        attributes.pointAlpha.array[i] = alpha * (transition?.flow ? incomingBloom(transition.progress ?? 0) : 1);
        attributes.pointSelected.array[i] = i === selectedBit ? 1 : activeWord ? 0.55 : sourceWord ? 0.18 : 0;
      }
      for (const key of ['pointColor', 'pointAlpha', 'pointSelected']) attributes[key].needsUpdate = true;
    }
    updateConnectors();
    schedule();
  }
  function targetsFor(view, target = new Float32Array(data[view.lane].values.length * 3)) {
    const values = data[view.lane].values;
    for (let i = 0; i < values.length; i++) target.set(pointPosition(i, values.length, isSheet() ? 'digest' : data.stage, view.lane, spread, bitWindowStart, bitWindowSize, lanePaddingStart(view.lane), data.paddingProgress, data[view.lane].capacity, data.scheduleGrouping, !reducedMotion.matches), i * 3);
    return target;
  }
  function seedCloud(view, now, previousReadCount = 0) {
    const laneData = data[view.lane], count = laneData.values.length;
    if (!view.cloud || view.cloud.length !== count * 7) {
      view.cloud = new Float32Array(count * 7);
      view.arrivals = new Float64Array(count); view.arrivals.fill(Infinity);
      for (let index = 0; index < count; index++) view.cloud.set(cloudSeed(index, laneData.sourceOffsets?.[index] ?? index), index * 7);
      previousReadCount = 0;
    }
    if (laneData.readCount < previousReadCount) { view.arrivals.fill(Infinity); previousReadCount = 0; }
    const added = laneData.readCount - previousReadCount;
    for (let index = previousReadCount; index < laneData.readCount; index++) {
      // Already-read points enter immediately, with a slight visual stagger
      // inside a completed read batch; no unread points are made visible.
      view.arrivals[index] = now - (added > 1 ? (index - previousReadCount) / (added - 1) * 160 : 0);
    }
  }
  function updateByteCloud(now) {
    if (data.stage !== 'bytes' || !data.byteCloud || transition?.flow) return;
    const assembly = smooth(data.byteAssembly), loose = 1 - assembly;
    for (const view of views) {
      if (!view.points) continue;
      const positions = view.points.geometry.attributes.position;
      const count = data[view.lane].readCount;
      for (let index = 0; index < count; index++) {
        const seed = index * 7, offset = index * 3, phase = view.cloud[seed + 3];
        const moving = !reducedMotion.matches;
        const arrival = moving ? 1 - smooth((now - view.arrivals[index]) / 600) : 0;
        const x = view.cloud[seed] + (moving ? Math.sin(now * 0.00046 + phase) * 0.16 : 0) + view.cloud[seed + 4] * arrival;
        const y = view.cloud[seed + 1] + (moving ? Math.sin(now * 0.00033 + phase * 1.7) * 0.18 : 0) + view.cloud[seed + 5] * arrival;
        const z = view.cloud[seed + 2] + (moving ? Math.cos(now * 0.00039 + phase * 1.3) * 0.16 : 0) + view.cloud[seed + 6] * arrival;
        positions.array[offset] = x * loose + view.target[offset] * assembly;
        positions.array[offset + 1] = y * loose + view.target[offset + 1] * assembly;
        positions.array[offset + 2] = z * loose + view.target[offset + 2] * assembly;
      }
      positions.needsUpdate = true;
    }
  }
  const cloudMoving = () => data.stage === 'bytes' && data.byteCloud && data.byteAssembly < 1 && data[lane].readCount > 0 && !reducedMotion.matches;
  function releaseOutgoing() {
    for (const view of views) {
      if (!view.outgoing) continue;
      scene.remove(view.outgoing.points); view.outgoing.points.geometry.dispose(); view.outgoing = null;
    }
  }
  function snapshotFlow(view) {
    const sources = [view.points, view.outgoing?.points].filter(Boolean);
    const count = Math.min(MAX_FLOW_POINTS, sources.reduce((sum, points) => sum + Array.from(points.geometry.attributes.pointAlpha.array).filter((alpha) => alpha > 0.01).length, 0));
    const positions = new Float32Array(count * 3), colors = new Float32Array(count * 3), alpha = new Float32Array(count), roundIndices = new Int32Array(count).fill(-1);
    let index = 0;
    for (const points of sources) {
      const attributes = points.geometry.attributes;
      for (let point = 0; point < attributes.position.count && index < count; point++) {
        if (attributes.pointAlpha.array[point] <= 0.01) continue;
        positions.set(attributes.position.array.subarray(point * 3, point * 3 + 3), index * 3);
        colors.set(attributes.pointColor.array.subarray(point * 3, point * 3 + 3), index * 3);
        if (data.stage === 'rounds' && points === view.points) roundIndices[index] = point;
        alpha[index++] = attributes.pointAlpha.array[point];
      }
    }
    return { positions, colors, alpha, roundIndices };
  }
  function cameraSnapshot() {
    updateCamera();
    return { position: camera.position.clone(), quaternion: camera.quaternion.clone(), projection: camera.projectionMatrix.clone(),
      view: camera.matrixWorldInverse.clone(),
      viewportHeight: height, zoom,
      pointSize: views[0].material.uniforms.pointSize.value, perspectiveSize: views[0].material.uniforms.perspectiveSize.value };
  }
  function finishTransition() {
    if (transition) applyMorph(1);
    transition = null; releaseOutgoing();
  }
  function retimeTransition(previousRate, nextRate, now) {
    if (!transition || previousRate === nextRate) return;
    const progress = clamp((now - transition.start) / transition.duration, 0, 1);
    applyMorph(transition.stagedCompare ? progress : smooth(progress));
    if (progress === 1) { finishTransition(); return; }
    transition.duration *= previousRate / nextRate;
    transition.start = now - progress * transition.duration;
  }
  function incomingBloom(progress) {
    if (transition?.identity) return 1;
    return transition?.roundsDigest ? smooth((progress - 0.68) / 0.26) : smooth(progress / 0.72);
  }
  function applyMorph(progress) {
    const phase = transition?.stagedCompare ? compareChoreographyFrame(progress) : null;
    if (transition?.flow) { transition.overallProgress = progress; transition.progress = phase ? phase.stretch : progress; }
    for (const view of views) {
      if (!view.points) continue;
      const current = view.points.geometry.attributes.position.array;
      if (phase) for (let i = 0; i < current.length; i++) current[i] = view.from[i] * phase.scale * (1 - phase.stretch) + view.target[i] * phase.stretch;
      else if (transition?.roundsDigest && view.digestSheet) roundsDigestPath(view.from, view.target, current, progress);
      else for (let i = 0; i < current.length; i++) current[i] = view.from[i] + (view.target[i] - view.from[i]) * progress;
      view.points.geometry.attributes.position.needsUpdate = true;
      if (transition?.flow) {
        const alpha = view.points.geometry.attributes.pointAlpha;
        const bloom = incomingBloom(progress);
        for (let point = 0; point < alpha.count; point++) alpha.array[point] = view.baseAlpha[point] * bloom;
        alpha.needsUpdate = true;
        if (view.outgoing) {
          const outgoing = view.outgoing, attributes = outgoing.points.geometry.attributes;
          if (transition.roundsDigest && outgoing.sheet) roundsDigestPath(outgoing.from, outgoing.target, attributes.position.array, progress);
          else for (let i = 0; i < outgoing.from.length; i++) attributes.position.array[i] = outgoing.from[i] + (outgoing.target[i] - outgoing.from[i]) * progress;
          const fade = 1 - (transition.roundsDigest ? smooth((progress - 0.76) / 0.24) : smooth((progress - 0.16) / 0.84));
          for (let point = 0; point < outgoing.alpha.length; point++) attributes.pointAlpha.array[point] = outgoing.alpha[point] * fade;
          attributes.position.needsUpdate = true; attributes.pointAlpha.needsUpdate = true;
        }
      }
    }
    updateConnectors();
  }
  function stretchHashPoints(flow = null) {
    // Digest and Compare contain the same256 bits. Each point keeps its own
    // buffer/index and stretches from its last rendered position to its line
    // position; it never borrows a spatial neighbour or fades into a duplicate.
    // Normal forward motion first compacts the square, waits for the panes to
    // reach their separate rows, and only then unfolds it into the line.
    releaseOutgoing();
    for (const view of views) {
      view.from = view.points.geometry.attributes.position.array.slice();
      view.target = targetsFor(view); view.digestSheet = null;
      if (!view.baseAlpha || view.baseAlpha.length !== 256) view.baseAlpha = new Float32Array(256);
    }
    transition = flow ? { start: performance.now(), duration: flow.duration, flow: true, identity: true,
      stagedCompare: !!flow.stagedCompare, overallProgress: 0, progress: 0, cameraFrom: flow.cameraFrom } : null;
    updateColors(); applyMorph(flow ? 0 : 1); schedule();
  }
  function rebuild(animate = true, sourceStage = null, previousOffsets = null, flow = null) {
    releaseOutgoing();
    let anyMovement = false;
    for (const view of views) {
      const old = view.points?.geometry.attributes.position.array, target = targetsFor(view), from = new Float32Array(target.length);
      const snapshot = flow?.snapshots[view.lane];
      view.digestSheet = null;
      if (flow?.roundsDigest && snapshot?.alpha.length) {
        view.digestSheet = new Float32Array(target.length);
        for (let bit = 0; bit < target.length / 3; bit++) view.digestSheet.set(digestSheetPosition(bit), bit * 3);
      }
      const incomingParent = snapshot?.alpha.length ? spatialLookup(snapshot.positions) : null;
      const incomingParents = incomingParent ? Int32Array.from({ length: target.length / 3 }, (_, point) => incomingParent(target[point * 3], target[point * 3 + 1], target[point * 3 + 2], true)) : null;
      const offsets = sourceStage ? previousOffsets?.[view.lane] : null;
      const sourcePoints = offsets ? new Map(offsets.map((offset, index) => [offset, index])) : null;
      for (let i = 0; i < target.length; i++) {
        const point = Math.floor(i / 3), axis = i % 3;
        // Extracted block bytes retain their exact padded source offset. Seed
        // words then split each of those bytes into eight bit-points; generated
        // words have no source byte and remain hidden at their destination.
        // Large-file points sample the entire file, not a contiguous prefix.
        // Only an actual point at this seed byte's file offset can be a parent.
        const parentOffset = sourceStage === 'block' ? data[view.lane].sourceOffsets?.[point] ?? point : Math.floor(point / 8);
        const parent = sourcePoints ? sourcePoints.get(parentOffset) ?? -1 : parentOffset;
        const hasParent = sourceStage === 'block' || point < 512;
        const source = sourceStage ? (hasParent && parent >= 0 ? parent * 3 + axis : -1) : i;
        if (view.digestSheet) {
          from[i] = view.digestSheet[i];
        } else if (incomingParent) {
          const parent = incomingParents[point];
          from[i] = parent >= 0 ? snapshot.positions[parent * 3 + axis] : target[i];
        } else from[i] = old && source >= 0 && source < old.length ? old[source] : target[i];
        if (Math.abs(from[i] - target[i]) > 0.0001) anyMovement = true;
      }
      if (view.points) { scene.remove(view.points); view.points.geometry.dispose(); }
      const geometry = new THREE.BufferGeometry(), count = data[view.lane].values.length;
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(animate ? from : target), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('pointColor', new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('pointAlpha', new THREE.BufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('pointSelected', new THREE.BufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage));
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);
      view.points = new THREE.Points(geometry, view.material); view.points.userData.lane = view.lane; view.points.frustumCulled = false;
      view.from = from; view.target = target; view.baseAlpha = new Float32Array(count); scene.add(view.points);
      if (snapshot?.alpha.length && target.length) {
        const nearest = spatialLookup(target), destination = new Float32Array(snapshot.positions.length), sheet = view.digestSheet ? new Float32Array(snapshot.positions.length) : null;
        for (let point = 0; point < snapshot.alpha.length; point++) {
          const offset = point * 3;
          const sourceIndex = snapshot.roundIndices[point];
          const column = sourceIndex >= 0 ? sourceIndex % 8 : clamp(Math.round(snapshot.positions[offset] / 0.72 + 3.5), 0, 7);
          const roundLayer = sourceIndex >= 0 ? Math.floor(sourceIndex / 32) : clamp(Math.round(snapshot.positions[offset + 2] / (0.08 + flow.sourceSpread * 0.20) + 31.5), 0, 63);
          const parent = sheet ? Math.floor(roundLayer / 2) * 8 + column : nearest(snapshot.positions[offset], snapshot.positions[offset + 1], snapshot.positions[offset + 2]);
          if (sheet) sheet.set(digestSheetPosition(parent), offset);
          destination.set(target.subarray(parent * 3, parent * 3 + 3), offset);
        }
        const outgoingGeometry = new THREE.BufferGeometry();
        outgoingGeometry.setAttribute('position', new THREE.BufferAttribute(snapshot.positions.slice(), 3).setUsage(THREE.DynamicDrawUsage));
        outgoingGeometry.setAttribute('pointColor', new THREE.BufferAttribute(snapshot.colors, 3));
        outgoingGeometry.setAttribute('pointAlpha', new THREE.BufferAttribute(snapshot.alpha.slice(), 1).setUsage(THREE.DynamicDrawUsage));
        outgoingGeometry.setAttribute('pointSelected', new THREE.BufferAttribute(new Float32Array(snapshot.alpha.length), 1));
        outgoingGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);
        const points = new THREE.Points(outgoingGeometry, view.material); points.userData.flowOutgoing = true; points.frustumCulled = false;
        view.outgoing = { points, from: snapshot.positions, sheet, target: destination, alpha: snapshot.alpha }; scene.add(points);
      }
      seedCloud(view, performance.now());
    }
    transition = animate && !reducedMotion.matches && (anyMovement || flow) ? { start: performance.now(), duration: flow?.duration ?? 700 / data.animationRate, flow: !!flow, roundsDigest: !!flow?.roundsDigest, progress: 0, cameraFrom: flow?.cameraFrom } : null;
    if (!transition) applyMorph(1);
    updateByteCloud(performance.now());
    updateColors(); if (transition?.flow) applyMorph(0); schedule();
  }
  function updateCamera() {
    const aspect = width / height;
    if (isBits()) {
      camera = orthographic;
      const halfWidth = isSheet() ? 3.2 * zoom : Math.max(1.8, bitWindowSize * 0.12 / 2 + 0.4) * zoom;
      const halfHeight = Math.max(isSheet() ? 3.2 * zoom : 1.4, halfWidth / aspect);
      orthographic.left = -halfHeight * aspect; orthographic.right = halfHeight * aspect; orthographic.top = halfHeight; orthographic.bottom = -halfHeight; orthographic.updateProjectionMatrix();
    } else {
      camera = perspective; perspective.aspect = aspect; perspective.updateProjectionMatrix();
      const lattice = data.stage === 'bytes' || data.stage === 'padding' || data.stage === 'block' ? rectangularLayout(data[lane].capacity ?? 0) : null;
      const cloudRoom = data.stage === 'bytes' && data.byteCloud ? 1 - smooth(data.byteAssembly) : 0;
      const reserve = (gridHalf) => gridHalf + (4.1 - gridHalf) * cloudRoom;
      const halfX = lattice ? reserve((lattice.columns - 1) * lattice.cell / 2 + 0.2) : 2.72;
      const halfY = lattice ? reserve((lattice.rows - 1) * lattice.cell / 2 + 0.2) : 2.72;
      const halfZ = lattice ? reserve((lattice.layers - 1) * lattice.cell / 2 + 0.2)
        : data.stage === 'rounds' ? 31.5 * (0.08 + spread * 0.20) + 0.2 : 3.5 * 0.72 * (1 + spread * 1.5) + 0.2;
      const radius = Math.max(0.5, Math.hypot(halfX, halfY, halfZ));
      const vertical = THREE.MathUtils.degToRad(perspective.fov), horizontal = 2 * Math.atan(Math.tan(vertical / 2) * aspect);
      const distance = radius / Math.sin(Math.min(vertical, horizontal) / 2) * 1.04 * zoom;
      perspective.position.set(distance * Math.sin(phi) * Math.sin(theta), distance * Math.cos(phi), distance * Math.sin(phi) * Math.cos(theta)); perspective.lookAt(0, 0, 0);
    }
    const targetCamera = camera;
    camera.updateMatrixWorld();
    const count = Math.max(data.a.values.length, data.b.values.length);
    const size = isSheet() ? clamp(Math.min(width, height) * 0.60 / 16, 3, 10)
      : data.stage === 'compare' ? clamp(width * 0.84 / bitWindowSize, 1, 10) : data.stage === 'rounds' ? 4.4 : data.stage === 'schedule' ? 3.5 : clamp(5.5 - Math.log2(Math.max(1, count / 512)) * 0.32, 2.1, 5.5);
    let pointSize = size, perspectiveSize = isBits() ? 0 : 1;
    if (transition?.flow && transition.cameraFrom) {
      const from = transition.cameraFrom, progress = transition.progress ?? 0;
      flowCamera.position.lerpVectors(from.position, targetCamera.position, progress);
      flowCamera.quaternion.slerpQuaternions(from.quaternion, targetCamera.quaternion, progress);
      flowCamera.updateMatrixWorld();
      // Normalize the origin's clip-W before blending projection types. A raw
      // perspective/orthographic matrix lerp shrinks the forming sheet before
      // abruptly enlarging it near the end of the handoff.
      flowFromProjection.multiplyMatrices(from.projection, from.view);
      if (transition.stagedCompare && transition.overallProgress > 0) {
        // Keep the compact grid square and almost constant in screen pixels
        // while the two independent canvas rectangles move into their rows.
        const sourceHeight = Math.abs(flowFromProjection.elements[15] / flowFromProjection.elements[5]);
        let halfHeight = sourceHeight * height / Math.max(1, from.viewportHeight);
        if (compareChoreographyFrame(transition.overallProgress).compact === 1) {
          let halfX = 0, halfY = 0;
          for (const view of views) for (let i = 0; i < view.from.length; i += 3) {
            halfX = Math.max(halfX, Math.abs(view.from[i])); halfY = Math.max(halfY, Math.abs(view.from[i + 1]));
          }
          halfHeight = Math.max(halfHeight, Math.max(halfY, halfX / aspect) * HASH_COMPACT_SCALE / 0.84 * from.zoom);
        }
        halfHeight *= zoom / from.zoom;
        compactProjection.makeOrthographic(-halfHeight * aspect, halfHeight * aspect, halfHeight, -halfHeight, 0.1, 500);
        flowFromProjection.multiplyMatrices(compactProjection, from.view);
      }
      flowTargetProjection.multiplyMatrices(targetCamera.projectionMatrix, targetCamera.matrixWorldInverse);
      const fromW = flowFromProjection.elements[15] || 1, targetW = flowTargetProjection.elements[15] || 1;
      const projectionScale = fromW + (targetW - fromW) * progress;
      for (let element = 0; element < 16; element++) flowProjection.elements[element] = (flowFromProjection.elements[element] / fromW * (1 - progress) + flowTargetProjection.elements[element] / targetW * progress) * projectionScale;
      flowCamera.projectionMatrix.multiplyMatrices(flowProjection, flowCamera.matrixWorld);
      flowCamera.projectionMatrixInverse.copy(flowCamera.projectionMatrix).invert();
      camera = flowCamera;
      pointSize = from.pointSize + (size - from.pointSize) * progress;
      if (transition.stagedCompare) pointSize = from.pointSize * compareChoreographyFrame(transition.overallProgress).scale * (1 - progress) + size * progress;
      perspectiveSize = from.perspectiveSize + (perspectiveSize - from.perspectiveSize) * progress;
    }
    for (const view of views) { view.material.uniforms.pointSize.value = pointSize; view.material.uniforms.pixelRatio.value = Math.min(window.devicePixelRatio || 1, 2); view.material.uniforms.perspectiveSize.value = perspectiveSize; }
  }
  function draw(now) {
    raf = null; if (disposed || contextLost || document.hidden) return;
    advanceOrbit(now);
    if (transition) { const p = clamp((now - transition.start) / transition.duration, 0, 1); applyMorph(transition.stagedCompare ? p : smooth(p)); if (p === 1) { transition = null; releaseOutgoing(); } }
    if (pendingCompare && !transition) { const next = pendingCompare; pendingCompare = null; setData(next); }
    reportCompareProgress();
    if (data.stage === 'compare') measureSize();
    updateByteCloud(now);
    updateCamera(); scene.updateMatrixWorld(true);
    try { renderer.render(scene, camera); } catch { contextLost = true; clearMotion(); clearGesture(); finishTransition(); report('The 3D view could not render. Reload the page to restore it. File comparison remains available.'); }
    if (!contextLost) reportCompareFrame();
    if (transition || cloudMoving() || orbitMoving()) schedule();
  }
  function reportCompareProgress() {
    if (isCompareGrid() || pendingCompare?.compareLayout === 'grid' || (!pendingCompare && data.stage !== 'compare') || disposed || contextLost || !onCompareProgress) return;
    onCompareProgress({ lane, overallProgress: pendingCompare ? 0 : transition?.flow ? transition.overallProgress ?? transition.progress ?? 0 : 1, settled: !pendingCompare && !transition });
  }
  function reportCompareFrame() {
    const view = views[0];
    if (data.stage !== 'compare' || isCompareGrid() || !onCompareFrame || !view?.points || view.points.geometry.attributes.position.count !== 256) return;
    const rect = canvas.getBoundingClientRect(), positions = view.points.geometry.attributes.position;
    const first = new THREE.Vector3().fromBufferAttribute(positions, 0).project(camera);
    const last = new THREE.Vector3().fromBufferAttribute(positions, 255).project(camera);
    const coordinates = [first.x, first.y, last.x, last.y];
    if (!coordinates.every(Number.isFinite)) return;
    onCompareFrame({ lane, xStart: rect.left + (first.x + 1) * rect.width / 2,
      xEnd: rect.left + (last.x + 1) * rect.width / 2,
      y: rect.top + (1 - (first.y + last.y) / 2) * rect.height / 2,
      progress: transition?.flow ? transition.progress ?? 0 : 1,
      overallProgress: transition?.flow ? transition.overallProgress ?? transition.progress ?? 0 : 1, settled: !transition });
  }
  function measureSize() {
    const rect = canvas.getBoundingClientRect(), nextWidth = Math.max(1, rect.width || canvas.clientWidth || 1), nextHeight = Math.max(1, rect.height || canvas.clientHeight || 1);
    const nextPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    if (nextPixelRatio !== pixelRatio) { pixelRatio = nextPixelRatio; renderer.setPixelRatio(pixelRatio); }
    if (nextWidth !== width || nextHeight !== height) { width = nextWidth; height = nextHeight; renderer.setSize(width, height, false); }
  }
  function resize() { if (!disposed) { measureSize(); schedule(); } }
  function sameValues(a, b) { return a.length === b.length && a.every((value, index) => value === b[index]); }
  function setData(next = {}) {
    if (disposed) return;
    const previousStage = data.stage;
    const previousOffsets = { a: data.a.sourceOffsets, b: data.b.sourceOffsets };
    const previousReads = { a: data.a.readCount ?? 0, b: data.b.readCount ?? 0 };
    const previousCloud = data.byteCloud;
    const previousPaddingProgress = data.paddingProgress;
    const stage = STAGES.has(next.stage) ? next.stage : 'bytes';
    const compareLayout = next.compareLayout === 'grid' ? 'grid' : 'line';
    const previousSheet = isSheet(), nextSheet = stage === 'digest' || stage === 'compare' && compareLayout === 'grid';
    const a = normalizePointLane(next.a ?? data.a, stage), b = normalizePointLane(next.b ?? data.b, stage);
    const flowMode = next.flowMode === true;
    const previousRate = data.animationRate;
    const animationRate = next.animationRate == null ? previousRate
      : Number.isFinite(next.animationRate) && next.animationRate > 0 ? clamp(next.animationRate, 0.01, 100) : 1;
    // Custom playback can stretch a single handoff beyond five seconds.
    const transitionDuration = Number.isFinite(next.transitionDuration) ? clamp(next.transitionDuration, 0, 120000) : 1100 / animationRate;
    if (transitionDuration > 0) retimeTransition(previousRate, animationRate, performance.now());
    if (stage !== 'compare' || !flowMode || transitionDuration === 0) pendingCompare = null;
    if (stage === 'compare' && data.stage === 'digest' && transition && flowMode
      && transitionDuration > 0 && !reducedMotion.matches && !document.hidden && !contextLost) {
      // A manual early Next keeps the remaining Digest motion visible in its
      // original panes. Its 256 points then begin the full staged handoff.
      data.animationRate = animationRate;
      pendingCompare = { ...next };
      reportCompareProgress(); schedule(); return;
    }
    pendingCompare = null;
    const identityHandoff = flowMode && ((previousStage === 'digest' && stage === 'compare') || (previousStage === 'compare' && stage === 'digest'))
      && a.values.length === 256 && b.values.length === 256
      && sameValues(data.a.values, a.values) && sameValues(data.b.values, b.values)
      && (nextSheet || ((!Number.isInteger(next.bitWindowSize) || next.bitWindowSize === 256) && (!Number.isInteger(next.bitWindowStart) || next.bitWindowStart === 0)))
      && views.every((view) => view.points?.geometry.attributes.position.count === 256 && !view.outgoing
        && view.points.geometry.attributes.pointAlpha.array.every((alpha) => alpha > 0.01));
    const staticSheetHandoff = identityHandoff && previousSheet && nextSheet;
    const flow = flowMode && !staticSheetHandoff && stage !== previousStage && !(previousStage === 'bytes' && stage === 'padding')
      && transitionDuration > 0 && !reducedMotion.matches && !document.hidden && !contextLost && views.some((view) => view.points && view.points.geometry.attributes.position.count > 0) && (lane === 'a' ? a : b).values.length
      ? { snapshots: Object.fromEntries(views.map((view) => [view.lane, snapshotFlow(view)])), cameraFrom: cameraSnapshot(), duration: transitionDuration,
        roundsDigest: previousStage === 'rounds' && stage === 'digest', sourceSpread: spread,
        stagedCompare: identityHandoff && !nextSheet && previousStage === 'digest' && stage === 'compare' && !transition } : null;
    if (transitionDuration === 0 || !flowMode && data.flowMode) { finishTransition(); clearMotion(); }
    if ((stage === 'digest' || stage === 'compare') && previousStage !== stage) clearMotion();
    const nextSpread = Number.isFinite(next.spread) ? clamp(next.spread, 0, 1) : spread;
    const spreadChanged = spread !== nextSpread;
    const directSpread = next.directSpread === true && stage === 'rounds' && previousStage === stage;
    const nextWindowSize = nextSheet ? 256 : Number.isInteger(next.bitWindowSize) ? clamp(next.bitWindowSize, 1, 256) : 256;
    const nextWindowStart = nextSheet ? 0 : Number.isInteger(next.bitWindowStart) ? clamp(next.bitWindowStart, 0, 256 - nextWindowSize) : 0;
    // Byte values arrive from the real reader. Their count and planned lattice
    // stay fixed, so an arriving chunk changes colors/visibility, not geometry.
    const samePointData = stage === 'bytes'
      ? data.a.values.length === a.values.length && data.b.values.length === b.values.length
      : sameValues(data.a.values, a.values) && sameValues(data.b.values, b.values);
    const sameGeometry = data.stage === stage && (stage !== 'compare' || data.compareLayout === compareLayout) && (!spreadChanged || directSpread) && bitWindowSize === nextWindowSize && bitWindowStart === nextWindowStart && data.a.capacity === a.capacity && data.b.capacity === b.capacity && samePointData;
    if (data.stage !== stage && !flowMode) zoom = 1;
    const scheduleWordCount = Number.isFinite(next.scheduleWordCount) ? clamp(Math.floor(next.scheduleWordCount), 0, 64) : 64;
    const scheduleWord = Number.isFinite(next.scheduleWord) ? clamp(Math.floor(next.scheduleWord), 0, 63) : Math.max(0, scheduleWordCount - 1);
    const scheduleSources = Array.isArray(next.scheduleSources) ? [...new Set(next.scheduleSources.filter((word) => Number.isInteger(word) && word >= 0 && word < 64))].slice(0, 4) : [];
    const explicitGrouping = stage === 'schedule' && Number.isFinite(next.scheduleGrouping);
    const scheduleGrouping = explicitGrouping ? clamp(next.scheduleGrouping, 0, 1) : 1;
    const groupingChanged = data.scheduleGrouping !== scheduleGrouping;
    data = { a, b, stage, flowMode, animationRate, compareLayout, round: Number.isFinite(next.round) ? clamp(Math.floor(next.round), 0, 64) : 64,
      byteCloud: stage === 'bytes' && next.byteCloud === true,
      byteAssembly: Number.isFinite(next.byteAssembly) ? clamp(next.byteAssembly, 0, 1) : 1,
      scheduleWordCount, scheduleWord, scheduleSources, scheduleGrouping,
      paddingStart: typeof next.paddingStart === 'object' ? next.paddingStart : Number.isInteger(next.paddingStart) ? next.paddingStart : a.values.length,
      paddingProgress: Number.isFinite(next.paddingProgress) ? clamp(next.paddingProgress, 0, 1) : 1 };
    selectedBit = Number.isInteger(next.selectedBit) && next.selectedBit >= 0 ? next.selectedBit : null;
    if (!directSpread || next.layer !== undefined) selectedLayer = Number.isInteger(next.layer) && next.layer >= 0 && next.layer < 64 ? next.layer : null;
    spread = nextSpread; bitWindowSize = nextWindowSize; bitWindowStart = nextWindowStart;
    // Progress/round ticks reuse all GPU buffers. Only visibility/colors change.
    if (identityHandoff) {
      stretchHashPoints(flow);
    } else if (sameGeometry) {
      if (directSpread && spreadChanged) {
        // The shared Rounds clock already interpolates separation. Follow its
        // exact frame without rebuilding buffers or starting a second tween.
        finishTransition();
        for (const view of views) targetsFor(view, view.target);
        applyMorph(1);
      }
      if (stage === 'bytes' && data.byteCloud) {
        for (const view of views) seedCloud(view, performance.now(), previousCloud ? previousReads[view.lane] : 0);
        updateByteCloud(performance.now());
      } else if (stage === 'bytes' && previousCloud) applyMorph(1);
      if (stage === 'padding') {
        const tween = previousPaddingProgress !== data.paddingProgress && transitionDuration > 0 && !reducedMotion.matches && !transition?.flow;
        if (tween && transition) {
          // A progress tick can run immediately before the display frame.
          // Sample the previous tween at this time before replacing its target,
          // so frequent ticks cannot repeatedly reset a flight to its old frame.
          const progress = clamp((performance.now() - transition.start) / transition.duration, 0, 1);
          applyMorph(smooth(progress));
          if (progress === 1) transition = null;
        }
        for (const view of views) {
          const values = data[view.lane].values;
          if (tween) view.from = view.points.geometry.attributes.position.array.slice();
          for (let i = lanePaddingStart(view.lane); i < values.length; i++) view.target.set(pointPosition(i, values.length, stage, view.lane, spread, bitWindowStart, bitWindowSize, lanePaddingStart(view.lane), data.paddingProgress, data[view.lane].capacity, data.scheduleGrouping, !reducedMotion.matches), i * 3);
        }
        if (tween) {
          // Ease from actual rendered positions, with the same pipeline speed
          // as the shared progress clock. Camera inertia keeps its own timing.
          transition = { start: performance.now(), duration: 100 / data.animationRate, flow: false };
          applyMorph(0);
        } else if (!transition) applyMorph(1);
      }
      if (stage === 'schedule' && groupingChanged) {
        // Grouping is driven by the UI's shared timeline. Reuse the same GPU
        // arrays and apply its exact progress instead of starting a second morph.
        transition = null;
        for (const view of views) targetsFor(view, view.target);
        applyMorph(1);
      }
      updateColors();
    } else {
      const sourceStage = stage === 'block' && (previousStage === 'padding' || previousStage === 'bytes') ? 'block'
        : stage === 'schedule' && !explicitGrouping && (previousStage === 'padding' || previousStage === 'bytes' || previousStage === 'block') ? 'schedule' : null;
      rebuild(transitionDuration > 0 && (!explicitGrouping || !!flow), sourceStage, previousOffsets, flow);
    }
    reportCompareProgress();
  }
  function setSelected(index) { if (!disposed) { selectedBit = Number.isInteger(index) && index >= 0 ? index : null; if (pendingCompare) pendingCompare.selectedBit = selectedBit; updateColors(); } }
  function setLayer(index) { if (!disposed) { selectedLayer = Number.isInteger(index) && index >= 0 && index < 64 ? index : null; updateColors(); } }
  function setSpread(value) {
    if (disposed) return;
    const flow = data.flowMode && !reducedMotion.matches && !document.hidden && !contextLost
      ? { snapshots: Object.fromEntries(views.map((view) => [view.lane, snapshotFlow(view)])), cameraFrom: cameraSnapshot(), duration: 1100 / data.animationRate } : null;
    spread = Number.isFinite(value) ? clamp(value, 0, 1) : 0; rebuild(true, null, null, flow);
  }
  function getCameraState() { return { theta, phi, zoom }; }
  function setCameraState(state, { silent = true, motionLeader = false } = {}) {
    if (disposed) return;
    ownsMotion = motionLeader; clearMotion();
    if (Number.isFinite(state?.theta)) theta = state.theta;
    if (Number.isFinite(state?.phi)) phi = clamp(state.phi, 0.15, Math.PI - 0.15);
    if (Number.isFinite(state?.zoom)) zoom = clamp(state.zoom, 0.4, 3.2);
    schedule();
    if (!silent) onCameraChange?.(getCameraState());
  }
  function cameraChanged() { quietSince = performance.now(); schedule(); onCameraChange?.(getCameraState()); }
  function pick(event) {
    // The handoff camera smoothly mixes perspective and orthographic matrices.
    // Picking resumes on settled real points once this short visual morph ends.
    if (transition?.flow) return;
    const rect = canvas.getBoundingClientRect(); pointer.set(((event.clientX - rect.left) / width) * 2 - 1, -((event.clientY - rect.top) / height) * 2 + 1);
    // Pick the same live positions that were most recently rendered. Updating
    // drift here would move the click target between observation and input.
    updateCamera(); scene.updateMatrixWorld(true); raycaster.setFromCamera(pointer, camera); raycaster.params.Points.threshold = isSheet() ? 0.10 : data.stage === 'compare' ? 0.06 : data.stage === 'rounds' ? 0.10 : 0.16;
    const hit = raycaster.intersectObjects(views.map((view) => view.points).filter(Boolean), false).find((candidate) => candidate.index !== undefined && candidate.object.geometry.attributes.pointAlpha.array[candidate.index] > 0.1);
    if (!hit) return; const index = hit.index; setSelected(index);
    const valueA = data.stage === 'bytes' && index >= data.a.readCount ? null : data.a.values[index] ?? null;
    const valueB = data.stage === 'bytes' && index >= data.b.readCount ? null : data.b.values[index] ?? null;
    const offsetA = index < data.a.values.length ? data.a.sourceOffsets?.[index] ?? index : null;
    const offsetB = index < data.b.values.length ? data.b.sourceOffsets?.[index] ?? index : null;
    onPick?.({ lane: hit.object.userData.lane, index, bitA: valueA, bitB: valueB, valueA, valueB, offsetA, offsetB });
  }
  function pointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return; takeMotion(true); pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); canvas.setPointerCapture?.(event.pointerId);
    if (pointers.size === 1) { gesture = { x: event.clientX, y: event.clientY, moved: false, multiple: false }; lastDrag = { time: performance.now() }; }
    else if (gesture) { gesture.multiple = true; velocityTheta = 0; velocityPhi = 0; lastDrag = null; }
  }
  function pointerMove(event) {
    const previous = pointers.get(event.pointerId); if (!previous) return;
    if (gesture && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 5) gesture.moved = true;
    if (pointers.size === 2) { const other = Array.from(pointers.entries()).find(([id]) => id !== event.pointerId)?.[1]; if (other) { const before = Math.hypot(previous.x - other.x, previous.y - other.y), after = Math.hypot(event.clientX - other.x, event.clientY - other.y); if (before > 2 && after > 2) zoom = clamp(zoom * before / after, 0.4, 3.2); } }
    else if (pointers.size === 1 && !isBits()) {
      const dx = event.clientX - previous.x, dy = event.clientY - previous.y, now = performance.now();
      theta -= dx * 0.007; phi = clamp(phi - dy * 0.007, 0.15, Math.PI - 0.15);
      if (data.flowMode && !reducedMotion.matches && lastDrag) { const velocity = dragOrbitVelocity(dx, dy, now - lastDrag.time); velocityTheta = velocity.theta; velocityPhi = velocity.phi; }
      lastDrag = { time: now };
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); cameraChanged();
  }
  function pointerUp(event) {
    if (!pointers.has(event.pointerId)) return; const click = event.type !== 'pointercancel' && pointers.size === 1 && gesture && !gesture.moved && !gesture.multiple; pointers.delete(event.pointerId);
    if (event.type === 'pointercancel' || click || gesture?.multiple || !lastDrag || performance.now() - lastDrag.time > 100) { velocityTheta = 0; velocityPhi = 0; }
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId); if (click) pick(event);
    if (!pointers.size) { gesture = null; lastDrag = null; motionFrame = null; quietSince = performance.now(); schedule(); }
  }
  function wheel(event) { event.preventDefault(); takeMotion(); zoom = clamp(zoom * Math.exp(clamp(event.deltaY, -200, 200) * 0.0015), 0.4, 3.2); cameraChanged(); }
  function keyDown(event) {
    let handled = true;
    if (event.key === 'ArrowLeft' && !isBits()) theta += 0.12; else if (event.key === 'ArrowRight' && !isBits()) theta -= 0.12;
    else if (event.key === 'ArrowUp' && !isBits()) phi = clamp(phi - 0.1, 0.15, Math.PI - 0.15); else if (event.key === 'ArrowDown' && !isBits()) phi = clamp(phi + 0.1, 0.15, Math.PI - 0.15);
    else if (event.key === '+' || event.key === '=') zoom = clamp(zoom / 1.12, 0.4, 3.2); else if (event.key === '-' || event.key === '_') zoom = clamp(zoom * 1.12, 0.4, 3.2);
    else if (event.key === 'Home') { theta = 0; phi = 1.12; zoom = 1; } else handled = false;
    if (handled) { takeMotion(); event.preventDefault(); cameraChanged(); }
  }
  function visibility() { if (document.hidden) { clearMotion(); clearGesture(); if (transition?.flow) finishTransition(); if (raf !== null) { window.cancelAnimationFrame(raf); raf = null; } } if (!document.hidden) { clearMotion(); resize(); schedule(); } }
  function lost(event) { event.preventDefault(); contextLost = true; clearMotion(); clearGesture(); if (transition?.flow) finishTransition(); if (raf !== null) { window.cancelAnimationFrame(raf); raf = null; } report('The 3D view lost its graphics context. It will resume if the browser restores it. File comparison remains available.'); }
  function captureLost(event) { if (pointers.has(event.pointerId)) { clearMotion(); clearGesture(); schedule(); } }
  function restored() { contextLost = false; clearMotion(); report(''); resize(); schedule(); }
  function motionChanged() {
    clearMotion(); if (reducedMotion.matches && transition) finishTransition();
    if (data.stage === 'padding') {
      for (const view of views) targetsFor(view, view.target);
      applyMorph(1); updateColors();
    }
    updateByteCloud(performance.now()); schedule();
  }
  const listeners = [['pointerdown', pointerDown], ['pointermove', pointerMove], ['pointerup', pointerUp], ['pointercancel', pointerUp], ['lostpointercapture', captureLost], ['wheel', wheel, { passive: false }], ['keydown', keyDown], ['webglcontextlost', lost], ['webglcontextrestored', restored]];
  for (const [event, listener, options] of listeners) canvas.addEventListener(event, listener, options);
  document.addEventListener('visibilitychange', visibility); window.addEventListener('resize', resize); reducedMotion.addEventListener?.('change', motionChanged);
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null; resizeObserver?.observe(canvas); rebuild(false); resize();
  function dispose() {
    if (disposed) return; disposed = true; if (raf !== null) window.cancelAnimationFrame(raf); clearGesture();
    releaseOutgoing(); transition = null; pendingCompare = null; clearMotion();
    for (const [event, listener, options] of listeners) canvas.removeEventListener(event, listener, options);
    document.removeEventListener('visibilitychange', visibility); window.removeEventListener('resize', resize); reducedMotion.removeEventListener?.('change', motionChanged); resizeObserver?.disconnect(); canvas.style.touchAction = oldTouchAction;
    for (const view of views) { view.points?.geometry.dispose(); view.material.dispose(); }
    connectorGeometry?.dispose(); connectorMaterial?.dispose();
    renderer.dispose(); renderer.forceContextLoss();
  }
  return { setData, setSelected, setLayer, setSpread, getCameraState, setCameraState, dispose, available: true };
}

/** Independent WebGL contexts with linked orbit/zoom; one real file per canvas. */
export function createPairedPointScene(canvasA, canvasB, { onPick, onError, onCameraChange, onCompareFrame, onCompareProgress } = {}) {
  const scenes = {}, errors = { a: '', b: '' };
  let disposed = false;
  let cameraState = { theta: 0, phi: 1.12, zoom: 1 };
  const synchronize = (from, state) => {
    if (disposed) return;
    cameraState = { ...state };
    scenes[from === 'a' ? 'b' : 'a']?.setCameraState(state);
    onCameraChange?.({ ...state });
  };
  for (const [lane, canvas] of [['a', canvasA], ['b', canvasB]]) {
    scenes[lane] = createVoxelScene(canvas, {
      lane, onPick, onCompareFrame, onCompareProgress, motionLeader: lane === 'a',
      onCameraChange: (state) => synchronize(lane, state),
      onError: (message) => { errors[lane] = message; if (!disposed) onError?.(['a', 'b'].filter((key) => errors[key]).map((key) => `File ${key.toUpperCase()}: ${errors[key]}`).join(' ')); },
    });
  }
  const each = (method, value) => { if (!disposed) for (const scene of Object.values(scenes)) scene[method](value); };
  return {
    available: scenes.a.available && scenes.b.available,
    setData(value) {
      each('setData', value);
      // Preserve the shared state, including flow mode's retained user zoom.
      if (scenes.a.available) cameraState = scenes.a.getCameraState();
      else if (scenes.b.available) cameraState = scenes.b.getCameraState();
    },
    setSelected: (value) => each('setSelected', value),
    setLayer: (value) => each('setLayer', value),
    setSpread: (value) => each('setSpread', value),
    getCameraState: () => ({ ...cameraState }),
    setCameraState(value) { if (disposed) return; scenes.a.setCameraState(value, { motionLeader: true }); scenes.b.setCameraState(value, { motionLeader: false }); if (scenes.a.available) cameraState = scenes.a.getCameraState(); else if (scenes.b.available) cameraState = scenes.b.getCameraState(); },
    dispose() { if (disposed) return; disposed = true; for (const scene of Object.values(scenes)) scene.dispose(); },
  };
}
