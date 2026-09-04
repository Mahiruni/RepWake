import { replay, initialState, reduce } from '../src/detection/repMachine';
import { DEFAULT_CONFIG, Effect, RepConfig } from '../src/detection/types';
import {
  armbandSet,
  cleanSet,
  flickSet,
  handWaveSpam,
  pickedUpAndWaved,
  heavyLandingSet,
  levelTranslationCheat,
  stalledRep,
  touchingSet,
} from './fixtures/traces';

const cfg = (over: Partial<RepConfig> = {}): RepConfig => ({ ...DEFAULT_CONFIG, ...over });

const reps = (effects: Effect[]) => effects.filter(e => e.type === 'REP').length;
const rejects = (effects: Effect[], reason?: string) =>
  effects.filter(e => e.type === 'REJECT' && (!reason || (e as any).reason === reason)).length;

describe('proximity mode — genuine sets', () => {
  it('counts a clean set of 20', () => {
    const { state, effects } = replay(cleanSet(20), cfg());
    expect(state.reps).toBe(20);
    expect(reps(effects)).toBe(20);
    expect(state.phase).toBe('DONE');
  });

  it('emits COMPLETE exactly once, at the target', () => {
    const { effects } = replay(cleanSet(25), cfg({ targetReps: 20 }));
    const done = effects.filter(e => e.type === 'COMPLETE');
    expect(done).toHaveLength(1);
    expect(reps(effects)).toBe(20);
  });

  it('accepts a slow but legal cadence', () => {
    const { state } = replay(cleanSet(20, 5000, 1500), cfg());
    expect(state.reps).toBe(20);
  });

  it('tolerates a rep right at the minimum gap', () => {
    const { state } = replay(cleanSet(5, 950, 300), cfg());
    expect(state.reps).toBe(5);
  });
});

describe('proximity mode — cheats', () => {
  it('rejects rapid hand-waving on cadence', () => {
    const { state, effects } = replay(handWaveSpam(30), cfg());
    expect(state.reps).toBe(0);
    expect(rejects(effects, 'flick')).toBeGreaterThan(0);
  });

  it('rejects flicks that hold for less than 250ms', () => {
    const { state, effects } = replay(flickSet(20), cfg());
    expect(state.reps).toBe(0);
    expect(rejects(effects, 'flick')).toBe(20);
  });

  it('rejects a level translation that never tilts the phone', () => {
    // Regression: tilt alone cannot see this one. The rest-floor test must.
    const { state, effects } = replay(levelTranslationCheat(20), cfg());
    expect(state.reps).toBe(0);
    expect(rejects(effects, 'device_moved')).toBeGreaterThan(0);
  });

  it('rejects a phone picked up and waved at a believable cadence', () => {
    const { state, effects } = replay(pickedUpAndWaved(20), cfg());
    expect(state.reps).toBe(0);
    expect(rejects(effects, 'device_moved')).toBeGreaterThan(0);
  });

  it('does not count reps while the screen is being touched', () => {
    const { state, effects } = replay(touchingSet(10), cfg());
    expect(state.reps).toBe(0);
    expect(rejects(effects, 'touching')).toBe(10);
  });

  it('counts again once the finger is lifted', () => {
    const trace = [
      { type: 'TOUCH' as const, down: true, t: 500 },
      ...cleanSet(4),
      { type: 'TOUCH' as const, down: false, t: 8000 },
      ...cleanSet(4).map(e => ({ ...e, t: e.t + 9000 })),
    ].sort((a, b) => a.t - b.t);
    const { state } = replay(trace as any, cfg());
    expect(state.reps).toBe(4);
  });
});

describe('proximity mode — false rejections (the worse failure)', () => {
  // This alarm cannot be dismissed, so wrongly refusing a real rep traps a
  // real person. These cases matter more than any missed cheat.
  it('counts reps from a heavy user landing hard on a wooden floor', () => {
    const { state, effects } = replay(heavyLandingSet(20, 8), cfg());
    expect(state.reps).toBe(20);
    expect(rejects(effects, 'device_moved')).toBe(0);
  });

  it('still counts at an extreme landing impulse', () => {
    const { state } = replay(heavyLandingSet(20, 14), cfg());
    expect(state.reps).toBe(20);
  });

  it('raises SUSPECT_MISCALIBRATION rather than silently refusing forever', () => {
    const { effects } = replay(pickedUpAndWaved(20), cfg());
    const flagged = effects.filter(e => e.type === 'SUSPECT_MISCALIBRATION');
    expect(flagged.length).toBeGreaterThan(0);
    expect((flagged[0] as any).consecutive).toBe(DEFAULT_CONFIG.miscalibrationAfter);
  });
});

describe('proximity mode — stalls and resets', () => {
  it('resets a rep held past maxRepMs without counting it', () => {
    const { state, effects } = replay(stalledRep(), cfg());
    expect(state.reps).toBe(0);
    expect(rejects(effects, 'stalled')).toBeGreaterThan(0);
    expect(state.phase).toBe('WAITING_DOWN');
  });

  it('recovers and counts normally after a stall', () => {
    const trace = [
      ...stalledRep(),
      ...cleanSet(3).map(e => ({ ...e, t: e.t + 14000 })),
    ].sort((a, b) => a.t - b.t);
    const { state } = replay(trace as any, cfg());
    expect(state.reps).toBe(3);
  });

  it('does not need TICK to reject a stall if sensors keep reporting', () => {
    const noTicks = stalledRep().filter(e => e.type !== 'TICK');
    const { effects } = replay(noTicks, cfg());
    expect(rejects(effects, 'stalled')).toBeGreaterThan(0);
  });
});

describe('accel-only mode', () => {
  it('counts an armband set from vertical oscillation', () => {
    const { state } = replay(armbandSet(20), cfg({ mode: 'accel' }));
    expect(state.reps).toBe(20);
  });

  it('ignores proximity events entirely in accel mode', () => {
    const { state } = replay(handWaveSpam(40), cfg({ mode: 'accel' }));
    expect(state.reps).toBe(0);
  });
});

describe('determinism and purity', () => {
  it('never mutates the state it is given', () => {
    const s0 = initialState(0);
    const frozen = Object.freeze({ ...s0 });
    reduce(frozen as any, { type: 'PROXIMITY', near: true, raw: 0, t: 100 }, cfg());
    expect(frozen.reps).toBe(0);
    expect(frozen.phase).toBe('WAITING_DOWN');
  });

  it('produces identical results on repeated replays', () => {
    const trace = cleanSet(20);
    const a = replay(trace, cfg());
    const b = replay(trace, cfg());
    expect(a.state).toEqual(b.state);
    expect(a.effects).toEqual(b.effects);
  });

  it('ignores everything after the target is reached', () => {
    const { state } = replay(cleanSet(40), cfg({ targetReps: 20 }));
    expect(state.reps).toBe(20);
    expect(state.phase).toBe('DONE');
  });
});
