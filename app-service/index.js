// Kept despite the import diet below: it pulls in no `@zos/*` module at all, only a pure-JS Promise
// polyfill, and it installs a *synchronous* promise scheduler. That matters here more than anywhere
// — the default scheduler is built on setTimeout, and a promise callback queued behind a timer that
// never fires is a send that never completes.
import '../shared/device-polyfill'
import { MessageBuilder, MessagePayloadDataTypeOp, MessagePayloadType } from '../shared/message'
import { exit } from '@zos/app-service'
import { armNextAlarm, repairAlarmChain } from '../shared/alarm'
import { getPackageInfo } from '@zos/app'
import { log as Logger } from '@zos/utils'
import * as ble from '@zos/ble'
import { readFileSync, writeFileSync } from '@zos/fs'
import { readSensors } from './sensors'
import {
  DEFAULT_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  MESSAGE_METHOD_SERVICE_REPORT,
  MESSAGE_METHOD_SEND,
  MESSAGE_SOURCE_SERVICE,
  SERVICE_STAGE_SENSORS,
  SERVICE_STAGE_SEND,
  SERVICE_TRACE_STORE,
  STATE_KEY_WD_DONE,
  STATE_KEY_WD_LAST,
  STATE_KEY_WD_RUNS,
  decodeServiceParam,
  isUnattendedTrigger,
} from '../shared/constants'

// Error text is sent over BLE and shown on a watch face; the useful part of a JS error message is
// always at the front.
const MAX_DETAIL_CHARS = 120

const logger = Logger.getLogger('hass-sync-service')

// Extra breadcrumb fields used only by the recovery watchdog. They intentionally stay local to this
// file so the upstream-facing change does not expand the public constants surface just for
// diagnostics.
const TRACE_INTERVAL_KEY = 'interval'
const TRACE_ALARM_FAILURES_KEY = 'alarmFailures'
const TRACE_RECOVERIES_KEY = 'recoveries'
const TRACE_LAST_EVENT_KEY = 'lastEvent'

// ---------------------------------------------------------------------------
// One send per run. The alarm is the clock.
// ---------------------------------------------------------------------------
// This VM has no working way to measure the passage of time, and that is now a measured fact rather
// than a suspicion. Three mechanisms have been tried on an Amazfit GTR 4 (Zepp OS 3.5, API 3.6):
//
//   setTimeout / setInterval  Documented as unavailable in App Service context. Present, `typeof`
//                             calls them functions, and nothing they schedule ever runs. A service
//                             started at 09:14 delivered exactly one send, at 09:14.
//   Time.onPerMinute          The platform's own sanctioned replacement, used by the official App
//                             Service sample. `new Time()` and `onPerMinute()` both return without
//                             throwing — the service reports a `tick` stage if either fails, and it
//                             never did — and the callback is then never invoked. A service started
//                             at 11:41 had still counted zero ticks at 11:48.
//   @zos/alarm on this file   Fires, but each firing is a *single execution*, which the system caps
//                             at 600ms. This service's entire job is a BLE round trip taking
//                             seconds, so every wake-up was killed mid-handshake.
//
// So the alarm supplies the cadence and wakes this file directly, which makes every alarm-driven run
// a single execution under that 600ms cap. Whether that is survivable is the open question this
// build exists to answer, and the reason for the breadcrumb below — see SERVICE_TRACE_STORE. The cap
// is documented as limiting "execution time", which could mean wall clock or CPU; a BLE round trip
// takes seconds of the former and almost none of the latter, so the two readings differ completely
// and only the device can say which is right.
//
// The detour that was tried instead is dead: an alarm woke a second, tiny service whose only job was
// to `start()` this one, on the theory that `start()`'s "continuous running" path escapes the cap.
// On device that `start()` returned 255 (Unknown Error), which fits the documentation describing
// start/stop as managed "from the Device App" rather than from inside another service. It also,
// unhelpfully, was the reason nobody had ever actually tested the direct wake: the build that
// "proved" the direct wake impossible predated the `app-event` declaration and never dispatched at
// all.
//
// Hence the shape of this file: it does exactly one send and then ends itself. Ending is not a
// tidiness measure, it is the mechanism. `start()` against a live service is a no-op, so a service
// that stayed resident without being able to pace itself would sit idle forever and block every
// subsequent alarm from achieving anything. Exiting frees the slot for the next one.
//
// The cost is honest and worth stating: one process start per send instead of one long-lived
// process, and a cadence no finer than the alarm's. Both are preferable to the alternative, which
// is a background send that does not happen.
//
// ---------------------------------------------------------------------------
// Why this file imports so little, and nothing that touches storage
// ---------------------------------------------------------------------------
// A module that isn't available in this VM fails at *import*, taking the whole file down before its
// first line runs, with no error attributable to anything. Wrapping the *calls* in try/catch cannot
// catch that — by then the module is already gone.
//
// Two builds appeared to prove the point: both imported a storage module — `@zos/storage` in one,
// `@zos/fs` in the other — and in both the service registered with the OS yet never executed a
// single statement, not even a breadcrumb written by the very first import. That reading was half
// wrong, and the correction is why two of the imports above exist:
//
//   `@zos/fs`     has since been observed writing from an alarm-woken App Service on a GTR 4. The
//                 capability table lists it as available here for writing while the screen is off,
//                 which is exactly when an alarm fires. It carries the breadcrumb and nothing else;
//                 every call is wrapped and off every load-bearing path.
//   `@zos/alarm`  arms the next wake-up. This is not optional the way the breadcrumb is: the alarm
//                 that woke a run is consumed by firing, so a run that cannot arm its successor
//                 ends the chain. It is listed as available in App Service context.
//
// Neither is a reason to relax the rule. The history behind it is real: what a missing module does
// here is fail at import, which presents as a service the OS lists and never runs — no error, no
// log line, nothing attributable. Anything added must be something a single background send is
// impossible without, and the reports still go to the phone rather than to local storage, because
// app-side/index.js is the only place the watch face can read a history from with confidence.

function describeError(error) {
  return (error && error.message) || String(error)
}

function readTraceStore() {
  try {
    const raw = readFileSync({ path: SERVICE_TRACE_STORE, options: { encoding: 'utf8' } })
    return typeof raw === 'string' && raw !== '' ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function writeTraceStore(store) {
  try {
    writeFileSync({ path: SERVICE_TRACE_STORE, data: JSON.stringify(store), options: { encoding: 'utf8' } })
    return true
  } catch {
    return false
  }
}

// The breadcrumb, and the only thing this service records on the watch itself. See
// SERVICE_TRACE_STORE for why it exists and what its two counters separate.
//
// Only alarm-woken runs are counted. A run the app started is not evidence of anything — the app
// being open is the condition this whole mechanism exists to work without — and counting those too
// would bury the signal under noise from every diagnostic check.
function trace(trigger, patch) {
  if (!isUnattendedTrigger(trigger)) return
  try {
    const previous = readTraceStore()
    const next = {
      ...previous,
      [STATE_KEY_WD_RUNS]: previous[STATE_KEY_WD_RUNS] || 0,
      [STATE_KEY_WD_DONE]: previous[STATE_KEY_WD_DONE] || 0,
      [STATE_KEY_WD_LAST]: previous[STATE_KEY_WD_LAST] || '',
      [TRACE_INTERVAL_KEY]: previous[TRACE_INTERVAL_KEY] || DEFAULT_INTERVAL_MINUTES,
      [TRACE_ALARM_FAILURES_KEY]: previous[TRACE_ALARM_FAILURES_KEY] || 0,
      [TRACE_RECOVERIES_KEY]: previous[TRACE_RECOVERIES_KEY] || 0,
      [TRACE_LAST_EVENT_KEY]: previous[TRACE_LAST_EVENT_KEY] || '',
    }
    if (patch.run) next[STATE_KEY_WD_RUNS] += 1
    if (patch.done) next[STATE_KEY_WD_DONE] += 1
    if (patch.last) next[STATE_KEY_WD_LAST] = String(patch.last).slice(0, 24)
    if (Number.isFinite(patch.intervalMinutes)) next[TRACE_INTERVAL_KEY] = patch.intervalMinutes
    if (patch.alarmFailed) next[TRACE_ALARM_FAILURES_KEY] += 1
    writeTraceStore(next)
  } catch {
    // A service that cannot write its own breadcrumb must still send.
  }
}

function normaliseEventParam(param) {
  if (typeof param === 'string') return param
  try {
    return JSON.stringify(param)
  } catch {
    return String(param || '')
  }
}

function isSystemEventParam(param) {
  return normaliseEventParam(param).indexOf('event:os.') !== -1
}

function getSystemEventName(param) {
  const text = normaliseEventParam(param)
  const match = text.match(/(?:^|&)event=(event:os\.[^&]+)/)
  if (match && match[1]) return match[1]
  const directIndex = text.indexOf('event:os.')
  if (directIndex !== -1) {
    const direct = text.slice(directIndex)
    const end = direct.indexOf('&')
    return (end === -1 ? direct : direct.slice(0, end)).slice(0, 80)
  }
  return text.slice(0, 80)
}

function readLastKnownInterval() {
  try {
    const store = readTraceStore()
    const value = Number(store[TRACE_INTERVAL_KEY])
    if (Number.isFinite(value) && value >= MIN_INTERVAL_MINUTES && value <= MAX_INTERVAL_MINUTES) {
      return value
    }
  } catch {
    // Fall back to the default below.
  }
  return DEFAULT_INTERVAL_MINUTES
}

function recordSystemEventRecovery(eventName, intervalMinutes, result) {
  try {
    const previous = readTraceStore()
    const next = {
      ...previous,
      [TRACE_INTERVAL_KEY]: intervalMinutes,
      [TRACE_RECOVERIES_KEY]: (previous[TRACE_RECOVERIES_KEY] || 0) + 1,
      [TRACE_LAST_EVENT_KEY]: String(eventName || 'unknown').slice(0, 80),
      [STATE_KEY_WD_LAST]: result.id > 0 ? 'recovered' : 'recovery-alarm-failed',
    }
    if (!result.id) {
      next[TRACE_ALARM_FAILURES_KEY] = (previous[TRACE_ALARM_FAILURES_KEY] || 0) + 1
    }
    writeTraceStore(next)
  } catch {
    // Recovery must not depend on diagnostics.
  }
}

// MessageBuilder.request()'s own `timeout` only starts counting after its BLE handshake resolves —
// if that handshake never resolves, the request hangs forever with no error. This wraps it with a
// hard deadline regardless of handshake state.
//
// Referencing `setTimeout` bare inside the executor where it doesn't exist throws a ReferenceError
// synchronously, which the Promise constructor turns into an immediate rejection — so the deadline
// would fail every request at 0ms and blame the timeout for a missing API. Feature-detect instead.
// In this VM the deadline is decorative: it is armed and never goes off. It costs nothing, and it
// protects contexts that do honour their timers.
//
// A request that never settles here now leaks a resident service rather than wedging a loop, which
// leaks a resident service. Opening the app clears it — see shared/service-boot.js — and until then
// every alarm firing is wasted, since `start()` against a live service does nothing.
function withTimeout(promise, ms, message) {
  if (typeof setTimeout !== 'function') {
    logger.error('setTimeout unavailable in this context — BLE request runs without a deadline')
    return promise
  }
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms)
    }),
  ])
}

AppService({
  onInit(param) {
    logger.log('app-service onInit, param=' + normaliseEventParam(param))

    // System Events are used only as a watchdog. They never send health data; they rebuild the
    // one-shot alarm chain and exit immediately. On the Balance 2 this gives a dead alarm chain a
    // chance to recover without requiring the user to reopen the app.
    if (isSystemEventParam(param)) {
      const eventName = getSystemEventName(param)
      const intervalMinutes = readLastKnownInterval()
      logger.log('system-event watchdog: ' + eventName + ', interval=' + intervalMinutes)

      let result
      try {
        result = repairAlarmChain(intervalMinutes)
      } catch (error) {
        logger.error('repairAlarmChain failed: ' + describeError(error))
        result = { id: 0, cancelled: 0 }
      }

      recordSystemEventRecovery(eventName, intervalMinutes, result)

      try {
        exit()
      } catch (error) {
        logger.error('system-event exit failed: ' + describeError(error))
      }
      return
    }

    // The trigger says what woke this run; the interval is the pace to arm the next alarm at, which
    // is the only reason this run needs to know it.
    const { trigger, intervalMinutes } = decodeServiceParam(param)
    this.trigger = trigger

    // Reported to the phone with every message: 'T' setTimeout, 'I' setInterval only, '-' neither.
    // It decides nothing — no mechanism here depends on a timer any more — but it stays visible,
    // because a device that disagrees with the documentation is the first thing worth knowing about
    // on a new watch.
    this.timerMode = typeof setTimeout === 'function' ? 'T' : typeof setInterval === 'function' ? 'I' : '-'
    logger.log('timer mode: ' + this.timerMode + ', trigger: ' + this.trigger)

    // Before anything else, and before the breadcrumb, because this is the line the whole chain
    // depends on: the alarm that woke this run has been consumed by firing, so if the next one is
    // not armed here there will never be another. Arming first means a run the system cuts short —
    // which is the open question about the 600ms cap — still keeps the schedule alive.
    //
    // Only for alarm-woken runs. A run the app started must not arm anything: the page has just
    // swept and armed, and adding another here would double up on every open.
    if (isUnattendedTrigger(this.trigger)) {
      let nextAlarmId = 0
      try {
        nextAlarmId = armNextAlarm(intervalMinutes)
      } catch (error) {
        logger.error('armNextAlarm failed: ' + describeError(error))
      }
      if (!nextAlarmId) logger.error('armNextAlarm returned 0 after retry')
      trace(this.trigger, { intervalMinutes, alarmFailed: !nextAlarmId })
    }

    // Then the breadcrumb, so that `runs` records the wake-up itself rather than a run that got
    // somewhere. If the system kills this execution at 600ms, this line has already landed and the
    // pair `runs` climbing / `done` frozen is the answer.
    trace(this.trigger, { run: true, intervalMinutes })

    this.runSend()
  },

  // Ends the service so the next alarm finds no resident instance to decline to relaunch. This is
  // the mechanism, not housekeeping — see the header.
  //
  // The timing is what earlier attempts got wrong. Calling this straight after runSend() returned
  // killed the service mid-handshake — `request()` negotiates before a single frame goes out — and
  // the phone went from one send per app open to nothing at all. So it hangs off the round trip's
  // own completion instead.
  //
  // Which works because this VM is not as inert as it looks. It was tempting to conclude it stops
  // executing when onInit returns, since nothing scheduled ever runs. But the sends *do* arrive at
  // the phone, and they could not: a handshake completes by way of a native receive callback firing
  // after onInit returned. BLE callbacks are delivered here; scheduled ones and sensor ticks are
  // not. That is a much narrower defect than "the VM is frozen", and it leaves this exact hook
  // available.
  //
  // If that reading is ever wrong on some device and this never runs, the service stays resident and
  // blocks every later alarm until the app is opened.
  standDown() {
    this.closeConnection()
    try {
      exit()
    } catch (error) {
      logger.error('exit failed: ' + describeError(error))
    }
  },

  // One short-lived BLE connection per exchange. `@zos/ble` is a single physical connection shared
  // by the whole app, so nothing here holds one open longer than a request.
  exchange(request) {
    let messageBuilder
    try {
      const { appId } = getPackageInfo()
      messageBuilder = new MessageBuilder({ appId, appDevicePort: 20, appSidePort: 0, ble })
      // Tracked on `this` so onDestroy() can close it if the system stops the service mid-exchange.
      this.messageBuilder = messageBuilder
      messageBuilder.connect()
    } catch (error) {
      return Promise.reject(error)
    }

    return withTimeout(
      messageBuilder.request(request, { timeout: 15000 }),
      20000,
      'BLE request to app-side timed out after 20s (handshake may never have completed)',
    )
  },

  // Releases the native receive callback that connect() registered. Leaking one per run is what used
  // to exhaust the device into a reboot.
  closeConnection() {
    try {
      this.messageBuilder && this.messageBuilder.disConnect()
    } catch (error) {
      logger.error('disConnect failed: ' + describeError(error))
    }
    this.messageBuilder = null
  },

  // Sends one message and does not wait for the reply. This is what an alarm-woken run uses, and it
  // exists because `request()` cannot possibly finish inside the budget such a run is given.
  //
  // `request()` ends with `return this.waitingShakePromise.then(_request)` — it waits for the BLE
  // handshake to come back from the phone *before emitting a single byte*, then waits again for the
  // response. Two round trips. On device, ten consecutive alarm-woken runs reached the send and not
  // one of them completed it: `wd:10/0`. Since a run that hung would have stayed resident and
  // blocked the next wake-up, and the wake-ups kept arriving, each run was being terminated from
  // outside — the documented 600ms cap on a single execution is a wall-clock lifetime.
  //
  // Everything below it, though, is synchronous. `connect()` registers listeners and puts the shake
  // on the wire without waiting; `sendJson()` fragments the payload and hands every frame to the BLE
  // stack in a plain loop. So calling them directly, and never awaiting anything, does the one thing
  // that actually matters — get the health data to the phone — in synchronous time.
  //
  // What is given up is the reply, and with it the phone's `background` summary and any confirmation
  // that the webhook succeeded. Neither is a loss worth the round trip: app-side records the send on
  // *arrival*, before it calls the webhook, so the phone's history stays accurate, and the watch
  // face reads that history through the config pull it makes on every app open.
  //
  // The shake still goes out first, immediately before the data, and BLE preserves ordering — so the
  // phone sees exactly the sequence it would have seen anyway. What it no longer does is make this
  // run wait for the answer.
  sendWithoutWaiting(request) {
    const { appId } = getPackageInfo()
    const messageBuilder = new MessageBuilder({ appId, appDevicePort: 20, appSidePort: 0, ble })
    this.messageBuilder = messageBuilder

    messageBuilder.connect()
    messageBuilder.sendJson({
      json: request,
      type: MessagePayloadType.Request,
      contentType: MessagePayloadDataTypeOp.JSON,
      dataType: MessagePayloadDataTypeOp.JSON,
    })
  },

  // Tells the phone what went wrong. Fire-and-forget: a report must never affect the cycle it
  // reports on, and must never report its own failure — that would loop over a connection already
  // known to be unhappy.
  report(stage, detail) {
    return this.exchange({
      method: MESSAGE_METHOD_SERVICE_REPORT,
      payload: {
        stage,
        detail: detail ? String(detail).slice(0, MAX_DETAIL_CHARS) : '',
        timerMode: this.timerMode,
        trigger: this.trigger,
      },
    }).catch((error) => {
      logger.error('report(' + stage + ') failed: ' + describeError(error))
    })
  },

  // Sends exactly one message, and never chains a second behind the first. Earlier versions put a
  // startup "hello" ahead of the send and gated the send on its reply; on a watch where replies do
  // not come back, the hello went out and the send never did — not one byte of health data was ever
  // delivered. The send is its own announcement: app-side records contact from any message on
  // arrival. If the sensors fail before it can be built, the report below goes out in its place.
  runSend() {
    let payload
    try {
      // Deliberately not logging the payload or its length: measuring it costs a full extra
      // JSON.stringify() of the whole object, in the most memory-constrained context in the app, on
      // every cycle. json2buf() serialises it again on the way out, so that made three copies of a
      // multi-KB payload to produce one number in a log nobody reads in the field.
      payload = readSensors()
    } catch (error) {
      logger.error('readSensors failed: ' + describeError(error))
      trace(this.trigger, { done: true, last: SERVICE_STAGE_SENSORS })
      // An alarm-woken run cannot report this: report() goes through exchange(), which waits for the
      // handshake, which is the very thing that does not fit its budget. The breadcrumb above is all
      // it can leave, and it is enough — `wd:…:sensors` names the failure on the watch face.
      if (isUnattendedTrigger(this.trigger)) return
      // The report is the last thing this run does, so it stands down behind it too.
      return this.report(SERVICE_STAGE_SENSORS, describeError(error)).then(() => this.standDown())
    }

    const message = {
      method: MESSAGE_METHOD_SEND,
      payload,
      source: MESSAGE_SOURCE_SERVICE,
      timerMode: this.timerMode,
      trigger: this.trigger,
    }

    // An alarm-woken run has a few hundred milliseconds and cannot afford a round trip; a run the
    // app started has as long as it needs and may as well collect the reply. Same message either
    // way — only the waiting differs.
    if (isUnattendedTrigger(this.trigger)) {
      try {
        this.sendWithoutWaiting(message)
        // Recorded once the synchronous send has returned, which means every frame has been handed
        // to the BLE stack. It is the strongest claim this run can make: it cannot know whether the
        // phone liked the data, only that it left. `a:` on the watch face, which comes from the
        // phone, is what confirms the other half.
        trace(this.trigger, { done: true, last: 'sent' })
      } catch (error) {
        logger.error('one-way send failed: ' + describeError(error))
        trace(this.trigger, { done: true, last: 'ble:' + describeError(error) })
      }
      // Deliberately no standDown(): disconnecting or exiting now could cut off frames the BLE stack
      // has accepted but not yet put on the air. A single-execution run is ended by the system
      // anyway, and letting it end that way is what gives those frames the most time to flush.
      return
    }

    // Only reachable for a run the app started, which is why nothing here writes the breadcrumb:
    // that file counts alarm-woken runs, and an app open is not evidence of anything.
    return this.exchange(message)
      .catch((error) => {
        logger.error('runSend failed: ' + describeError(error))
        this.closeConnection()
        return this.report(SERVICE_STAGE_SEND, describeError(error))
      })
      // Success or failure, the run is over here and the slot must be released for the next alarm.
      .then(() => this.standDown())
  },

  onDestroy() {
    logger.log('app-service onDestroy')
    this.closeConnection()
  },
})