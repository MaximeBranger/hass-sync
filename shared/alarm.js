// Watch-side. Schedules the wake-up that *is* the background send's clock — nothing else on this
// watch can measure the passage of time (see app-service/index.js for the mechanisms measured not to
// work).
//
// The half of this that lives in app.json, not here: the woken file must also be declared as
// `module.app-event.path`, or the alarm fires into nothing at all — `set()` returns a real id,
// `getAllAlarms()` lists it, it fires on time, and no handler exists to receive it. That omission
// cost an afternoon of believing this watch could not run alarms.
//
// ---------------------------------------------------------------------------
// Why one non-repeating alarm, re-armed each run, rather than a repeating one
// ---------------------------------------------------------------------------
// `repeat_period` is documented only through a worked example — "every 21 days" as
// `repeat_period: 20, repeat_duration: 1` — which does not even agree with the prose beside it. Read
// as "a cycle spans period + duration", a one-minute interval becomes `repeat_period: 0`, and on
// device that alarm never fired: over two minutes at a one-minute interval the service was woken
// exactly once, by the non-repeating alarm set alongside it.
//
// Rather than keep guessing at the arithmetic, this drops repetition entirely. A one-shot alarm has
// no configuration to get wrong. Each run arms the next one before it does anything else, so the
// chain continues even if the run is cut short — see app-service/index.js's onInit.
//
// The chain's one weakness is that a run which never happens ends it. Opening the app re-arms it,
// and system-event recovery can repair it while the app is closed.
import { REPEAT_ONCE, cancel, getAllAlarms, set } from '@zos/alarm'
import { APP_SERVICE_FILE, SERVICE_TRIGGER_ALARM, encodeServiceParam } from './constants'

// Cancels every alarm this mini program owns. Called before arming a new one from the page, because
// `set()` creates an additional alarm rather than replacing any existing one — and an earlier
// version of this app, which set one without cancelling, accumulated a backlog large enough to bury
// the watch. Returns how many were cancelled, which is a diagnostic in itself: a number that climbs
// across app opens means cancellation isn't working and they are piling up again.
export function cancelAllAlarms() {
  let cancelled = 0
  try {
    const ids = getAllAlarms()
    if (!ids || !ids.length) return 0
    for (let i = 0; i < ids.length; i++) {
      try {
        cancel(ids[i])
        cancelled++
      } catch {
        // One that won't cancel must not stop the rest from being cancelled.
      }
    }
  } catch {
    // getAllAlarms is gated on the alarm permission and can fail outright; nothing to clean up then.
  }
  return cancelled
}

function createAlarm(intervalMinutes) {
  try {
    const id = set({
      url: APP_SERVICE_FILE,
      // Reaches the service as onInit's argument: what woke this run, and the pace to keep arming.
      param: encodeServiceParam(SERVICE_TRIGGER_ALARM, intervalMinutes),
      delay: intervalMinutes * 60,
      repeat_type: REPEAT_ONCE,
      store: true,
    })
    return typeof id === 'number' ? id : 0
  } catch {
    return 0
  }
}

// Arms the next wake-up, `intervalMinutes` from now. Returns its id, or 0 if the API refused.
//
// Deliberately does not sweep: this is what the *service* calls, in a context where every extra API
// call is budget it may not have, and where exactly one alarm is pending at a time anyway — the one
// that woke this run has already been consumed by firing.
//
// `store: true` so it survives a reboot. Without it the chain would break the first time the watch
// restarted, and only reopening the app would restore it.
//
// Balance 2 testing showed occasional alarm creation failures. One immediate retry keeps a transient
// `set()` failure from silently ending the entire one-shot chain.
export function armNextAlarm(intervalMinutes) {
  let id = createAlarm(intervalMinutes)
  if (id > 0) return id
  return createAlarm(intervalMinutes)
}

// The page's version: sweep first, then arm. Returns `{ id, cancelled }` — the new alarm's id and
// how many stale ones were cleared, which is the leak detector described on cancelAllAlarms().
//
// Sweeping here and not in the service is deliberate. The page is the one context that can afford
// the calls and the one that needs to heal an accumulated backlog; the service only ever adds the
// single alarm that replaces the one it consumed.
export function scheduleSendAlarm(intervalMinutes) {
  const cancelled = cancelAllAlarms()
  return { id: armNextAlarm(intervalMinutes), cancelled }
}

// System-event watchdog recovery uses the same sweep-and-arm operation as the page, but without
// needing the page to be opened. This is intentionally separate from armNextAlarm(): recovery runs
// are allowed to remove stale alarms before rebuilding the chain.
export function repairAlarmChain(intervalMinutes) {
  const cancelled = cancelAllAlarms()
  return { id: armNextAlarm(intervalMinutes), cancelled }
}
