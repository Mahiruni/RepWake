import {
  DEFAULT_CONFIG,
  Effect,
  RepConfig,
  RepEvent,
  RepState,
  Vec3,
} from './types';

/**
 * Pure rep-counting state machine.
 *
 * No timers, no sensor handles, no React. It takes timestamped sensor events
 * and returns the next state plus a list of effects. Every timing decision is
 * made from the timestamps carried on the events, so the machine is fully
 * deterministic and can be replayed against a recorded trace in a test.
 *
 * Everything that makes this hard lives here: distinguishing a push-up from a
 * hand waved over the sensor.
 */

const GRAVITY = 9.80665;

const norm = (v: Vec3) => Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);

const sub = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

/** Angle between two vectors, in degrees. */
function angleDeg(a: Vec3, b: Vec3): number {
  const na = norm(a);
  const nb = norm(b);
  if (na < 1e-6 || nb < 1e-6) return 0;
  const c = Math.min(1, Math.max(-1, dot(a, b) / (na * nb)));
  return (Math.acos(c) * 180) / Math.PI;
}

export function initialState(now = 0): RepState {
  return {
    phase: 'WAITING_DOWN',
    reps: 0,
    startedAt: now,
    lastRepAt: -Infinity,
    windowStart: -Infinity,
    nearSince: -Infinity,
    near: false,
    touching: false,
    ref: null,
    lastAccel: null,
    maxTilt: 0,
    jerkBuf: [],
    minRestJerk: Infinity,
    consecutiveMoveRejects: 0,
    gravity: null,
    vertical: 0,
    lastReject: null,
    rejectCount: 0,
  };
}

/** Clear the per-rep accumulators and open a new attempt window. */
function openWindow(s: RepState, t: number): RepState {
  return {
    ...s,
    windowStart: t,
    ref: s.lastAccel,
    maxTilt: 0,
    minRestJerk: Infinity,
    jerkBuf: [],
  };
}

function reject(
  s: RepState,
  reason: RepState['lastReject'],
  effects: Effect[],
  cfg: RepConfig,
): RepState {
  effects.push({ type: 'REJECT', reason: reason! });

  const consecutiveMoveRejects =
    reason === 'device_moved' ? s.consecutiveMoveRejects + 1 : 0;

  if (
    reason === 'device_moved' &&
    consecutiveMoveRejects >= cfg.miscalibrationAfter
  ) {
    effects.push({
      type: 'SUSPECT_MISCALIBRATION',
      consecutive: consecutiveMoveRejects,
    });
  }

  return {
    ...s,
    phase: 'WAITING_DOWN',
    windowStart: -Infinity,
    nearSince: -Infinity,
    ref: null,
    maxTilt: 0,
    minRestJerk: Infinity,
    jerkBuf: [],
    lastReject: reason,
    rejectCount: s.rejectCount + 1,
    consecutiveMoveRejects,
  };
}

/**
 * Accelerometer cross-check: is this phone lying on the floor, or in a hand?
 *
 * Two signals, both grounded in physics rather than tuning:
 *
 *  1. TILT. A phone resting on the floor cannot change orientation, no matter
 *     how heavily its owner lands beside it. A phone swung at a chest must
 *     rotate. Measured traces: genuine reps drift under 8 degrees even with a
 *     very heavy landing; waving the phone produces 40+.
 *
 *  2. REST FLOOR. The quietest 100ms of the rep window. A phone on the floor
 *     goes genuinely still between reps (sensor noise only). A hand always
 *     trembles. This is what catches the level-translation cheat -- moving the
 *     phone up and down without rotating it -- which tilt alone would miss.
 *
 * Deliberately NOT used: total accumulated jerk over the window. It rises with
 * how hard the user lands, not with whether they are cheating, and it
 * false-rejects heavy users on hard floors. Since this alarm cannot be
 * dismissed, a false rejection is a much worse failure than a missed cheat.
 * See docs in README, "Why the cross-check works".
 */
function crossCheck(s: RepState, cfg: RepConfig): RepState['lastReject'] | null {
  if (s.maxTilt > cfg.maxTiltDeg) return 'device_moved';
  if (s.minRestJerk > cfg.maxRestJerk) return 'device_moved';
  return null;
}

/** Common guards applied at the moment a rep would be credited. */
function creditRep(
  s: RepState,
  cfg: RepConfig,
  t: number,
  effects: Effect[],
): RepState {
  if (t - s.lastRepAt < cfg.minRepGapMs) return reject(s, 'too_fast', effects, cfg);
  if (t - s.windowStart > cfg.maxRepMs) return reject(s, 'stalled', effects, cfg);
  if (s.touching) return reject(s, 'touching', effects, cfg);

  const bad = crossCheck(s, cfg);
  if (bad) return reject(s, bad, effects, cfg);

  const reps = s.reps + 1;
  effects.push({ type: 'REP', index: reps, durationMs: t - s.windowStart });

  const next: RepState = {
    ...s,
    reps,
    lastRepAt: t,
    phase: reps >= cfg.targetReps ? 'DONE' : 'WAITING_DOWN',
    windowStart: -Infinity,
    nearSince: -Infinity,
    ref: null,
    maxTilt: 0,
    minRestJerk: Infinity,
    jerkBuf: [],
    lastReject: null,
    consecutiveMoveRejects: 0,
  };

  if (next.phase === 'DONE') {
    effects.push({ type: 'COMPLETE', totalMs: t - s.startedAt });
  }
  return next;
}

/** Fold an accelerometer sample into the motion accumulators. */
function absorbAccel(s: RepState, v: Vec3, cfg: RepConfig): RepState {
  const gravityVec: Vec3 = s.gravity
    ? {
        x: s.gravity.x + cfg.gravityAlpha * (v.x - s.gravity.x),
        y: s.gravity.y + cfg.gravityAlpha * (v.y - s.gravity.y),
        z: s.gravity.z + cfg.gravityAlpha * (v.z - s.gravity.z),
      }
    : v;

  // Linear acceleration projected onto the gravity axis, low-pass filtered.
  const gn = norm(gravityVec) || GRAVITY;
  const along = dot(v, gravityVec) / gn - gn;
  const vertical = s.vertical + cfg.lowPassAlpha * (along - s.vertical);

  let maxTilt = s.maxTilt;
  let jerkBuf = s.jerkBuf;
  let minRestJerk = s.minRestJerk;

  if (s.windowStart > -Infinity && s.lastAccel) {
    if (s.ref) maxTilt = Math.max(maxTilt, angleDeg(v, s.ref));

    jerkBuf = [...s.jerkBuf, norm(sub(v, s.lastAccel))];
    if (jerkBuf.length > cfg.restWindowSamples) jerkBuf = jerkBuf.slice(1);
    if (jerkBuf.length === cfg.restWindowSamples) {
      const mean = jerkBuf.reduce((a, b) => a + b, 0) / jerkBuf.length;
      minRestJerk = Math.min(minRestJerk, mean);
    }
  }

  return {
    ...s,
    lastAccel: v,
    gravity: gravityVec,
    vertical,
    maxTilt,
    jerkBuf,
    minRestJerk,
  };
}

export function reduce(
  state: RepState,
  event: RepEvent,
  cfg: RepConfig = DEFAULT_CONFIG,
): { state: RepState; effects: Effect[] } {
  const effects: Effect[] = [];
  let s = state;

  if (s.phase === 'DONE') return { state: s, effects };

  switch (event.type) {
    case 'TOUCH':
      s = { ...s, touching: event.down };
      break;

    case 'ACCEL': {
      s = absorbAccel(s, event.v, cfg);
      if (cfg.mode !== 'accel') break;

      // Accel-only mode: Schmitt trigger on the filtered vertical signal.
      // A rep is a dip below the low band followed by a rise above the high
      // band, subject to the same timing and touch guards.
      if (s.phase === 'WAITING_DOWN' && s.vertical < cfg.accelLowThreshold) {
        s = { ...openWindow(s, event.t), phase: 'DIPPED' };
      } else if (s.phase === 'DIPPED') {
        if (event.t - s.windowStart > cfg.maxRepMs) {
          s = reject(s, 'stalled', effects, cfg);
        } else if (s.vertical > cfg.accelHighThreshold) {
          // In this mode the phone is strapped to the body, so the
          // motion/tilt cross-check would reject every genuine rep. Skip it
          // and lean on the timing guards instead. See README: accel mode is
          // deliberately the weaker of the two.
          s = creditRep(
            { ...s, maxTilt: 0, minRestJerk: 0 },
            cfg,
            event.t,
            effects,
          );
        }
      }
      break;
    }

    case 'PROXIMITY': {
      if (cfg.mode !== 'proximity') {
        s = { ...s, near: event.near };
        break;
      }
      const wasNear = s.near;
      s = { ...s, near: event.near };

      if (!wasNear && event.near) {
        // Chest coming down over the sensor.
        if (s.phase === 'WAITING_DOWN') {
          s = { ...openWindow(s, event.t), phase: 'CONFIRMING_NEAR', nearSince: event.t };
        }
      } else if (wasNear && !event.near) {
        if (s.phase === 'CONFIRMING_NEAR') {
          // Released before the hold threshold — a flick, not a push-up.
          s = reject(s, 'flick', effects, cfg);
        } else if (s.phase === 'HELD_NEAR') {
          s = creditRep(s, cfg, event.t, effects);
        }
      }
      break;
    }

    case 'TICK':
      break;
  }

  // Time-driven transitions. Evaluated on every event so the machine does not
  // depend on TICK arriving, but TICK guarantees they fire while sensors are
  // quiet (e.g. someone holding still at the bottom).
  const t = event.t;

  if (s.phase === 'CONFIRMING_NEAR' && t - s.nearSince >= cfg.minNearHoldMs) {
    s = { ...s, phase: 'HELD_NEAR' };
  }

  if (
    (s.phase === 'CONFIRMING_NEAR' || s.phase === 'HELD_NEAR' || s.phase === 'DIPPED') &&
    t - s.windowStart > cfg.maxRepMs
  ) {
    s = reject(s, 'stalled', effects, cfg);
  }

  return { state: s, effects };
}

/** Convenience wrapper for replaying a whole trace, used heavily in tests. */
export function replay(
  events: RepEvent[],
  cfg: RepConfig = DEFAULT_CONFIG,
  start = initialState(events.length ? events[0].t : 0),
): { state: RepState; effects: Effect[] } {
  let s = start;
  const all: Effect[] = [];
  for (const e of events) {
    const r = reduce(s, e, cfg);
    s = r.state;
    all.push(...r.effects);
  }
  return { state: s, effects: all };
}
