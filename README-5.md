# RepWake

An Android alarm that will not turn off until you have done your push-ups,
verified by the phone's own sensors. Fully offline, no accounts, no paid SDKs.

---

## Setup

```bash
npm install
npx react-native run-android
npm test          # rep-counting state machine
npm run typecheck
```

Register the native package in `MainApplication.kt`:

```kotlin
override fun getPackages(): List<ReactPackage> =
    PackageList(this).packages.apply {
        add(RepWakePackage())
    }
```

Add an `AlarmTheme` in `res/values/styles.xml` (no action bar, translucent
system bars) so the ringing activity renders edge to edge.

`minSdkVersion 29`, `targetSdkVersion 35`, `compileSdkVersion 35`.

---

## How the detection works

The rep counter is a pure state machine in `src/detection/repMachine.ts`. It
holds no timers, no sensor handles and no React. Native code delivers
timestamped samples; the machine folds them into state and returns effects.
Everything is replayable, so the whole algorithm is testable without a phone.

Timestamps come from `SensorEvent.timestamp`, not `Date.now()` on the JS
thread. A stalled bridge must not be able to fabricate or destroy reps.

### Proximity mode (default)

Phone on the floor, screen up, beneath your chest. A rep is a `NEAR → FAR`
transition, subject to four guards:

| Guard | Value | Catches |
|---|---|---|
| Minimum gap between reps | 900 ms | Rapid hand-waving |
| Maximum time per rep | 8 s | Stalling at the bottom; auto-resets |
| Minimum `NEAR` hold | 250 ms | Flicking a hand past the sensor |
| Screen not being touched | — | Tapping the phone instead of moving |

### Why the cross-check works

The interesting cheat is picking the phone up and waving it at your chest at a
believable cadence with a believable hold. None of the guards above see it —
only the accelerometer can.

The first thing I tried was total accumulated jerk over the rep window, which
is the obvious approach and is wrong. Measured across the trace fixtures:

| Scenario | Summed jerk | Max tilt |
|---|---|---|
| Genuine rep, light landing | 1.5 | 0.6° |
| Genuine rep, heavy landing | 15.1 | 6.5° |
| Genuine rep, very heavy landing | 22.2 | 8.3° |
| Cheat — gentle swing | 7.5 | 41.1° |
| Cheat — hard swing | 17.7 | 45.9° |

Summed jerk overlaps completely: a heavy person landing hard on a wooden floor
scores higher than someone cheating gently. Shipping it would have thrown out
real reps from real users — and since the alarm cannot be dismissed, **a false
rejection traps someone**, which is a far worse failure than a missed cheat.
So it was removed entirely.

Two signals replaced it, both grounded in physics rather than tuning:

1. **Tilt** (max gravity-vector drift within the rep window, threshold 25°). A
   phone resting on the floor cannot change orientation however hard its owner
   lands beside it. A phone swung at a chest must rotate. Complete separation:
   genuine reps stay under 8°, cheats produce 40°+.

2. **Rest floor** (quietest 100 ms of the window, threshold 0.06 m/s²). A phone
   on the floor goes genuinely still between reps — sensor noise only. A hand
   always trembles. Genuine: 0.024–0.030 regardless of landing force. Hand-held:
   0.084–0.132. This is what catches the subtle version of the cheat, lifting
   the phone and translating it up and down *without* rotating it, which tilt
   alone would miss.

Both thresholds are validated only against synthetic traces so far. See
"Before you ship" below.

### When detection is wrong about the user

Four consecutive `device_moved` rejections emit `SUSPECT_MISCALIBRATION`. At
that point the app assumes **it** is wrong, not the user: it says so on screen
and brings the escape hatch forward to immediately available. A person doing
real push-ups that a bad threshold refuses to count must never be stuck waiting
out a timer.

### Armband mode

Phone strapped to the arm. Gravity is tracked with an EMA, linear acceleration
is projected onto that axis and low-pass filtered, and a Schmitt trigger counts
a dip-then-rise as one rep. The same timing guards apply; the tilt and rest-floor
checks are skipped, because on a limb they would reject every genuine rep.

This mode is deliberately the weaker of the two and is trivially cheatable by
shaking your arm. It exists for people whose phone has no usable proximity
sensor. Don't present it as equivalent.

### Calibration

Proximity sensors vary wildly, and a case can shift the baseline, compress the
range, or pin the sensor permanently near. So the threshold is measured per
device on first run: one reading uncovered, one covered, threshold biased
toward the near end because a false `FAR` ends a rep early — much more annoying
than a slightly late `NEAR`. If the two readings are too close, the app says
plainly that this case won't work and points at armband mode.

---

## The escape hatch

`src/components/EscapeHatch.tsx`. After the configured delay (default 3
minutes, **hard-capped at 10 in code**, not just in the settings UI), an
"I can't do this" button appears. Tapping it starts a 60-second countdown that
cannot be skipped or shortened, then dismisses the alarm and logs a skip.

This is not a nice-to-have and it is not negotiable:

- Someone can be injured, ill, mid-panic-attack, or dealing with an emergency
  in the next room. No sensor can distinguish them from someone who is merely
  unwilling, so the exit must always exist.
- Detection can fail. Bad calibration, a new case, an unusual floor. Without an
  exit, a bug becomes a person trapped by a screaming phone.

The 60 seconds is the entire anti-abuse mechanism, and it is enough: long
enough that skipping is never the easy path, short enough that it is never the
dangerous one. A skip is logged neutrally — no red, no penalty, no broken
streak. Punishing it would push people to force-stop the app instead, which
breaks every alarm they have.

If you fork this, keep it.

---

## Anti-cheat: what is actually enforceable

Being straight about this, because several items in the original spec cannot be
done on modern Android and it's better to know now than to ship something that
silently doesn't work.

| Requirement | Status |
|---|---|
| Back button blocked | ✅ Fully |
| Volume buttons don't silence | ✅ Swallowed while the activity has focus |
| Alarm survives swipe-away | ✅ `onTaskRemoved` + own task + `START_STICKY` |
| Survives reboot | ✅ `BootReceiver` + device-protected storage |
| Ignores ringer / silent / DND | ✅ `STREAM_ALARM` + `setBypassDnd` |
| Full-screen over lock screen | ✅ `setShowWhenLocked` / `setTurnScreenOn` |
| Home button blocked | ⚠️ **Not blockable.** We detect focus loss and relaunch after 2 s |
| Status bar pull-down disabled | ⚠️ **Not blockable** without device-owner or kiosk mode. Immersive mode hides it; a determined user can still drag it. Relaunch-on-focus-loss is the real mitigation |
| Unlocks a secure keyguard | ❌ **Impossible.** With a PIN set, no app can dismiss the keyguard. We show *over* it, which is correct behaviour for an alarm |
| Watchdog survives force-stop | ❌ **Impossible.** Android puts a force-stopped package into a stopped state and cancels its alarms. Nothing runs until the user opens the app again |

The watchdog in `AlarmScheduler.armWatchdog` re-fires after 60 s and does cover
the real case it was written for: an aggressive OEM task-killer killing the
service mid-ring. It does not cover deliberate force-stop, and no app can.
Anything claiming otherwise is wrong.

A user determined to beat this can always force-stop the app or reboot. That's
fine. The target is the half-asleep version of someone who *chose* this, not an
adversary.

---

## OEM battery killers

The single largest source of "my alarm didn't go off" reports, and it is not
your code.

| Vendor | What breaks | Where to send the user |
|---|---|---|
| **Xiaomi / Redmi / POCO** (MIUI, HyperOS) | Autostart off by default kills scheduled alarms outright. Battery saver kills the foreground service mid-ring | Security → Permissions → Autostart. Also lock the app in recents (drag down on the card) |
| **Oppo / Realme / OnePlus** (ColorOS) | "Sleep standby optimisation" and per-app battery freeze | Battery → App battery management → allow background activity + disable optimisation |
| **Vivo / iQOO** (Funtouch, OriginOS) | High background power consumption manager | Battery → Background power consumption management → allow |
| **Huawei / Honor** (EMUI, MagicOS) | App launch "managed automatically" | Battery → App launch → Manage manually, enable all three toggles |
| **Samsung** (One UI) | Apps unused for a few days get put to sleep | Battery → Background usage limits → Never sleeping apps |
| **Stock / Pixel** | Generally fine with `setAlarmClock` | Battery optimisation exemption is enough |

`Native.openOemAutostartSettings()` tries the known vendor activities by
component name and falls back to app details. There is no public API for any of
this and no way to verify the toggle afterwards, so the permission screen asks
the user to confirm rather than claiming to have checked.

---

## Permissions

| Permission | Why |
|---|---|
| `USE_EXACT_ALARM` | Auto-granted to alarm-clock apps on API 33+. No prompt, not revocable |
| `SCHEDULE_EXACT_ALARM` | API 31–32 fallback. Revocable — needs the runtime flow |
| `USE_FULL_SCREEN_INTENT` | Launches the counter over the lock screen. Auto-granted to alarm apps on 14+, but verify with `canUseFullScreenIntent()` |
| `POST_NOTIFICATIONS` | Required from API 33. Without it the service cannot foreground |
| `FOREGROUND_SERVICE_MEDIA_PLAYBACK` | API 34+ requires a declared type. There is no "alarm" type; `mediaPlayback` is correct for a service playing alarm audio |
| `RECEIVE_BOOT_COMPLETED` | Alarms are in-memory; without this they die at reboot |
| `WAKE_LOCK`, `VIBRATE` | Keep the CPU awake while ringing; vibration |

`getGates()` in `src/permissions.ts` orders the prompts by how badly the alarm
breaks without each one, and each explains the specific failure rather than
selling the permission.

---

## Architecture notes

**Alarms are mirrored to SharedPreferences.** JS owns alarm state, but
`BootReceiver` has to reschedule before React Native has started, and native
code cannot read MMKV or AsyncStorage. Every store write calls
`Native.syncAlarms()`, which writes to device-protected storage so it survives
direct boot.

**The ringing screen is a second RN root.** `AlarmActivity` mounts
`"RepWakeAlarm"` directly (registered in `index.js`), in its own task with
`excludeFromRecents`. It never sits behind navigation state that could fail to
restore at 6am, and swiping the main app away cannot take it along.

**Repeating alarms roll forward in `AlarmReceiver`**, before anything else, so a
crash during the set cannot silently drop tomorrow's alarm.

**The alarm stream volume is raised if needed** and restored on dismiss.
`STREAM_ALARM` already bypasses ringer and DND, but a user who set that slider
to zero will not wake up.

---

## Before you ship

The fixtures in `__tests__/fixtures/traces.ts` are **synthetic**. They model the
shape of real sensor output and they are enough to pin the state machine's
logic — which is what the test suite is for. They are **not** enough to prove
the thresholds are right on real hardware.

`tools/capture.ts` dumps a real session in the same format. Before release,
record and replay:

- A clean set, on hardwood and on carpet
- A set by someone heavy landing hard (the false-rejection case)
- A set with the phone in its usual case
- Every cheat you can think of, including the level-translation one
- At least three handsets, ideally including one Xiaomi and one Samsung

Then tune `maxTiltDeg` and `maxRestJerk` against the recordings. If you have to
choose, **bias toward accepting**. A missed cheat costs the user nothing they
didn't choose. A false rejection traps them.
