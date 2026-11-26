// Split-flap cell material adapted from splitflap.org.
// Source pin and MIT notice: ./THIRD-PARTY-SPLITFLAP.txt.
// Every character now turns a two-sided leaf, including intermediate glyphs.

function glyph(value) { return value === null || value === undefined || value === ' ' ? '' : String(value); }
function text(node, value) {
  if (node.children.length || node.textContent !== value) node.textContent = value;
}
function style(node, name, value) { if (node.style[name] !== value) node.style[name] = value; }
const clamp = (value) => Math.max(0, Math.min(1, value));
const STEP_MS = 80, FINAL_MS = 160, TURN_FRACTION = .88, TIME_TOLERANCE_MS = 1e-7;

function wheel(from, to, alphabet) {
  if (alphabet !== undefined) {
    if (typeof alphabet !== 'string' && !Array.isArray(alphabet)) throw new TypeError('Provide a split-flap alphabet as a string or array.');
    const characters = [...alphabet].map(glyph);
    if (!characters.length || new Set(characters).size !== characters.length) throw new RangeError('A split-flap alphabet must contain distinct glyphs.');
    return characters;
  }
  if (/^\d$/.test(from) && /^\d$/.test(to)) return [...'0123456789'];
  if (/^[0-9a-f]?$/.test(from) && /^[0-9a-f]?$/.test(to)) return ['', ...'0123456789abcdef'];
  if (/^[A-Z]?$/.test(from) && /^[A-Z]?$/.test(to)) return ['', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
  return [];
}

function route(from, to, alphabet) {
  const characters = wheel(from, to, alphabet);
  const start = characters.indexOf(from), end = characters.indexOf(to), path = [];
  if (from !== to) {
    if (start < 0 || end < 0) path.push(to);
    else {
      const count = (end - start + characters.length) % characters.length;
      for (let step = 1; step <= count; step++) path.push(characters[(start + step) % characters.length]);
    }
  }
  const intermediate = Math.max(0, path.length - 1);
  const totalMs = path.length ? intermediate * STEP_MS + FINAL_MS : 0;
  return { from, to, characters, path, totalMs,
    finalStart: totalMs ? intermediate * STEP_MS / totalMs : 0,
    previous: path.length > 1 ? path[path.length - 2] : from };
}

// CSS ease-in-out is cubic-bezier(.42,0,.58,1), not smoothstep in time.
function easeInOut(progress) {
  if (progress === 0 || progress === 1) return progress;
  let parameter = progress;
  for (let iteration = 0; iteration < 8; iteration++) {
    const inverse = 1 - parameter;
    const x = 3 * inverse * inverse * parameter * .42 + 3 * inverse * parameter * parameter * .58 + parameter ** 3;
    if (Math.abs(x - progress) < 1e-10) break;
    const slope = 3 * inverse * inverse * .42 + 6 * inverse * parameter * .16 + 3 * parameter * parameter * .42;
    parameter = clamp(parameter - (x - progress) / slope);
  }
  return parameter * parameter * (3 - 2 * parameter);
}

function stepTiming(plan, index) {
  const start = index * STEP_MS;
  const duration = index === plan.path.length - 1 ? FINAL_MS : STEP_MS;
  return { start, duration, startFraction: start / plan.totalMs, endFraction: (start + duration) / plan.totalMs,
    turnEnd: (start + duration * TURN_FRACTION) / plan.totalMs };
}

function motionFrame(plan, progress) {
  const fraction = clamp(progress), count = plan.path.length;
  const base = { stepCount: count, finalStart: plan.finalStart };
  if (fraction === 0) return { phase: 'idle', previous: plan.from, next: plan.from, display: plan.from,
    fallProgress: 0, rawFallProgress: 0, stepProgress: 0, stepIndex: 0, stepStart: 0,
    stepEnd: count ? stepTiming(plan, 0).endFraction : 1, ...base };
  if (fraction === 1 || !count) return { phase: 'settled', previous: plan.previous, next: plan.to, display: plan.to,
    fallProgress: 1, rawFallProgress: 1, stepProgress: 1, stepIndex: count, stepStart: plan.finalStart, stepEnd: 1, ...base };
  const time = fraction * plan.totalMs;
  const index = Math.min(count - 1, Math.floor((time + TIME_TOLERANCE_MS) / STEP_MS));
  const timing = stepTiming(plan, index);
  let stepProgress = clamp((time - timing.start) / timing.duration);
  if (Math.abs(stepProgress - TURN_FRACTION) * timing.duration <= TIME_TOLERANCE_MS) stepProgress = TURN_FRACTION;
  let rawFallProgress = clamp(stepProgress / TURN_FRACTION);
  if (Math.abs(rawFallProgress - .5) * timing.duration <= TIME_TOLERANCE_MS) rawFallProgress = .5;
  const previous = index ? plan.path[index - 1] : plan.from, next = plan.path[index];
  return { phase: stepProgress < TURN_FRACTION ? 'fall' : 'hold', previous, next,
    display: rawFallProgress < .5 ? previous : next, fallProgress: easeInOut(rawFallProgress), rawFallProgress,
    stepProgress, stepIndex: index + 1, stepStart: timing.startFraction, stepEnd: timing.endFraction, ...base };
}

/** Ordered whole-leaf turns: 80ms steps, 160ms final step, each with a 12% landed hold. */
export function splitFlapMotionFrame(from, to, progress, { alphabet } = {}) {
  if (!Number.isFinite(progress)) throw new RangeError('Split-flap progress must be a finite number.');
  return motionFrame(route(glyph(from), glyph(to), alphabet), progress);
}

function cachedRoute(view, from, to, alphabet) {
  const key = JSON.stringify(wheel(from, to, alphabet));
  if (view._route?.from !== from || view._route.to !== to || view._routeKey !== key) {
    view._route = route(from, to, alphabet); view._routeKey = key;
  }
  return view._route;
}

function currentMotion(view) {
  if (!view._discrete) return view._motion;
  const { plan, duration, master } = view._discrete;
  const time = Number(master.currentTime);
  return motionFrame(plan, Number.isFinite(time) ? time / duration : 0);
}

function cancelAnimations(view) {
  const animations = view._animations;
  view._animations = []; view._discrete = null;
  for (const animation of animations) {
    animation.onfinish = null;
    try { animation.cancel(); } catch { /* A removed effect needs no cleanup. */ }
  }
}

function paintStatic(view, value) {
  for (const node of [view.topText, view.bottomText, view.frontText, view.backText]) text(node, value);
  style(view.falling, 'transform', 'rotateX(-180deg)');
  style(view.falling, 'opacity', '0');
  view._display = value;
}

function paintFrame(view, frame) {
  if (frame.phase !== 'fall') { paintStatic(view, frame.display); return; }
  text(view.topText, frame.next); text(view.bottomText, frame.previous);
  text(view.frontText, frame.previous); text(view.backText, frame.next);
  style(view.falling, 'transform', 'rotateX(' + (-180 * frame.fallProgress) + 'deg)');
  style(view.falling, 'opacity', '1');
  view._display = frame.display;
}

function synchronizeStartTimes(view, revision) {
  const master = view._discrete?.master;
  if (!master) return;
  const synchronize = () => {
    if (view._revision !== revision || view._discrete?.master !== master || !Number.isFinite(master.startTime)) return;
    for (const effect of view._animations) if (effect !== master) {
      try { effect.startTime = master.startTime; } catch { /* Paused or removed effects retain their sampled time. */ }
    }
  };
  synchronize();
  if (master.ready?.then) master.ready.then(synchronize, () => {});
}

function pauseNative(view) {
  const time = Number(view._discrete?.master.currentTime);
  for (const effect of view._animations) effect.pause?.();
  if (Number.isFinite(time)) for (const effect of view._animations) effect.currentTime = time;
  return view;
}
function playNative(view) {
  for (const effect of view._animations) effect.play?.();
  synchronizeStartTimes(view, view._revision);
  return view;
}
function seekNative(view, milliseconds) {
  if (!Number.isFinite(milliseconds)) throw new RangeError('Split-flap seek time must be finite.');
  if (view._discrete) {
    const time = Math.max(0, Math.min(view._discrete.duration, milliseconds));
    for (const effect of view._animations) effect.currentTime = time;
  }
  return view;
}

/** Create one decorative cell; its readable semantic value belongs to the caller. */
export function createSplitFlap(doc, { value = '', className = '' } = {}) {
  if (!doc || typeof doc.createElement !== 'function') throw new TypeError('Provide a document for the split-flap cell.');
  const span = (name) => {
    const node = doc.createElement('span'); node.className = name; node.setAttribute('aria-hidden', 'true'); return node;
  };
  const element = span('split-flap' + (className ? ' ' + className : ''));
  const top = span('split-flap__half split-flap__top'), bottom = span('split-flap__half split-flap__bottom');
  const falling = span('split-flap__leaf split-flap__falling');
  const front = span('split-flap__face split-flap__front'), back = span('split-flap__face split-flap__back');
  const topText = span('split-flap__glyph'), bottomText = span('split-flap__glyph');
  const frontText = span('split-flap__glyph'), backText = span('split-flap__glyph');
  const topStrip = span('split-flap__strip'), bottomStrip = span('split-flap__strip');
  const frontStrip = span('split-flap__strip'), backStrip = span('split-flap__strip');
  top.append(topText); bottom.append(bottomText); front.append(frontText); back.append(backText);
  falling.append(front, back); element.append(top, bottom, falling);
  const initial = glyph(value);
  const view = { element, top, bottom, falling, leaf: falling, front, back, topText, bottomText, frontText, backText,
    fallingText: frontText, topStrip, bottomStrip, frontStrip, backStrip,
    get value() { return currentMotion(this)?.display ?? this._display; },
    get target() { return this._target; }, get motion() { return currentMotion(this); },
    pause() { return pauseNative(this); }, play() { return playNative(this); }, seek(milliseconds) { return seekNative(this, milliseconds); },
    _display: initial, _target: initial, _mode: 'value', _revision: 0, _animations: [], _frame: null,
    _route: null, _routeKey: '', _motion: null, _discrete: null, _span: span, _stripKey: '' };
  paintStatic(view, initial);
  return view;
}

/** Render a clock-owned turn without starting an animation or another clock. */
export function setSplitFlapFrame(view, from, to, progress, { alphabet } = {}) {
  if (!Number.isFinite(progress)) throw new RangeError('Split-flap progress must be a finite number.');
  const start = glyph(from), target = glyph(to), fraction = clamp(progress);
  const plan = cachedRoute(view, start, target, alphabet), previous = view._frame;
  if (view._mode === 'frame' && previous?.plan === plan && previous.progress === fraction) return view;
  view._revision++; cancelAnimations(view);
  view._mode = 'frame'; view._target = target; view._frame = { plan, progress: fraction };
  view._motion = motionFrame(plan, fraction); paintFrame(view, view._motion);
  return view;
}

function prepareStrips(view, plan) {
  const sequences = [[], [], [], []];
  plan.path.forEach((next, index) => {
    const previous = index ? plan.path[index - 1] : plan.from;
    sequences[0].push(next, next); sequences[1].push(previous, next);
    sequences[2].push(previous, previous); sequences[3].push(next, next);
  });
  const strips = [view.topStrip, view.bottomStrip, view.frontStrip, view.backStrip];
  const key = JSON.stringify(sequences);
  if (view._stripKey !== key) {
    sequences.forEach((characters, index) => strips[index].replaceChildren(...characters.map((character) => {
      const node = view._span('split-flap__strip-glyph'); node.textContent = character; return node;
    })));
    view._stripKey = key;
  }
  [view.topText, view.bottomText, view.frontText, view.backText].forEach((host, index) => {
    if (host.children.length !== 1 || host.children[0] !== strips[index]) host.replaceChildren(strips[index]);
  });
  return strips;
}

/** Animate a discrete actual-value change with five synchronized native effects. */
export function setSplitFlapValue(view, value, { duration = 160, reducedMotion = false, alphabet } = {}) {
  if (!Number.isFinite(duration) || duration < 0) throw new RangeError('Split-flap duration must be finite and non-negative.');
  const target = glyph(value);
  if (view._mode === 'value' && view._target === target && !reducedMotion && duration !== 0) return view;
  const from = view.value, plan = cachedRoute(view, from, target, alphabet);
  const revision = ++view._revision;
  cancelAnimations(view);
  view._mode = 'value'; view._target = target; view._frame = null; view._motion = motionFrame(plan, 0);
  const strips = [view.topStrip, view.bottomStrip, view.frontStrip, view.backStrip];
  if (duration === 0 || reducedMotion || from === target || typeof view.falling.animate !== 'function' || strips.some((strip) => typeof strip.animate !== 'function')) {
    view._motion = motionFrame(plan, 1); paintStatic(view, target); return view;
  }
  prepareStrips(view, plan);
  style(view.falling, 'transform', 'rotateX(0deg)'); style(view.falling, 'opacity', '1');
  view._display = from;
  const turns = [], selections = [];
  const position = (index) => 'translateY(calc(var(--flap-inner-height) * -' + index + '))';
  plan.path.forEach((_, index) => {
    const timing = stepTiming(plan, index);
    turns.push(
      { transform: 'rotateX(0deg)', opacity: 1, offset: timing.startFraction, easing: 'ease-in-out' },
      { transform: 'rotateX(-180deg)', opacity: 1, offset: timing.turnEnd },
      { transform: 'rotateX(-180deg)', opacity: 0, offset: timing.turnEnd, easing: 'steps(1, end)' },
      { transform: 'rotateX(-180deg)', opacity: 0, offset: timing.endFraction },
    );
    selections.push(
      { transform: position(index * 2), offset: timing.startFraction, easing: 'steps(1, end)' },
      { transform: position(index * 2 + 1), offset: timing.turnEnd, easing: 'steps(1, end)' },
    );
  });
  selections.push({ transform: position(plan.path.length * 2 - 1), offset: 1 });
  try {
    const master = view.falling.animate(turns, { duration, easing: 'linear', fill: 'forwards' });
    view._animations.push(master); view._discrete = { plan, duration, master };
    for (const strip of strips) {
      style(strip, 'transform', position(0));
      view._animations.push(strip.animate(selections, { duration, easing: 'linear', fill: 'forwards' }));
    }
    master.onfinish = () => {
      if (view._revision !== revision || view._mode !== 'value' || view._target !== target) return;
      cancelAnimations(view); view._motion = motionFrame(plan, 1); paintStatic(view, target);
    };
    synchronizeStartTimes(view, revision);
  } catch {
    cancelAnimations(view); view._motion = motionFrame(plan, 1); paintStatic(view, target);
  }
  return view;
}
