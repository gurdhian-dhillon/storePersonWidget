// CREATOR THROTTLES CUSTOM API CALLS AT ~50 PER MINUTE PER USER, and the
// production tab goes over it when the supervisor works quickly.
//
//   code 2955 - "You have reached your API call limit for a minute."
//
// It is NOT the daily quota. Widget-to-Custom-API calls are unmetered against
// that, which is why this looks like it should be impossible - but the
// per-minute rate limit applies to them all the same, and it is the one being
// hit here.
//
// WHY IT ADDS UP SO FAST. Every action on the production screen is TWO calls,
// not one: the save, and then a full fetchAllData to redraw from the server.
// Handing a stage to four operators and closing their shares is sixteen calls
// before the stage is even ended. Working through two or three stages at the
// pace someone actually clicks puts fifty inside a minute without anything
// being wrong.
//
// The refetch is deliberate and is not what should change - a share alters what
// the rest of the stage may do, and production.js is explicit that redrawing
// from the server is the fix in both directions. So the calls are real; what is
// missing is any pacing on them.
//
//------------------------------------------------------------------------
// WHAT THIS DOES
//
// Wraps ZOHO.CREATOR.DATA.invokeCustomApi once, before any tab script runs, so
// every existing call site is covered without any of them changing. Three
// things, in order of how often they matter:
//
//   1. PACES. At most maxPerMin calls in any rolling 60 seconds. A burst is
//      queued rather than refused, so the screen slows down instead of
//      breaking - which is the right trade when the alternative is an alert
//      saying "Network error. Check console."
//   2. CAPS CONCURRENCY. Creator allows 6 concurrent per account; 3 leaves room
//      for the other tabs and for anything else the account is doing.
//   3. RETRIES A 2955. Pacing makes it rare rather than impossible - another
//      tab, another user, or a burst that started before this loaded can still
//      trip it - so a rate-limited call goes back to the FRONT of the queue and
//      is tried again. Only a rate-limit is retried. Everything else rejects
//      exactly as it did, because a retried save is a save that might happen
//      twice.
//
// Ordering is preserved: the queue is FIFO and a retry keeps its place at the
// front. Two saves fired in sequence still reach the server in that sequence.
//
// The clock and the timer are injectable so this is testable without waiting a
// real minute - see tools/api-throttle.test.js.

function installApiThrottle(target, options) {
    options = options || {};

    var maxPerMin = options.maxPerMin || 45;
    var maxInflight = options.maxInflight || 3;
    var maxRetries = options.maxRetries === undefined ? 3 : options.maxRetries;
    var retryWaitMs = options.retryWaitMs || 12000;
    var now = options.now || function () { return Date.now(); };
    var later = options.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
    var onWait = options.onWait || function () {};

    if (!target || typeof target.invokeCustomApi !== 'function') return null;
    // Installing twice would queue behind itself and halve the rate for no
    // reason. Harmless to call again; it just does nothing.
    if (target.invokeCustomApi.isThrottled) return target.invokeCustomApi;

    var real = target.invokeCustomApi;
    var starts = [];        // when each call in the last 60s was dispatched
    var waiting = [];       // queued jobs, FIFO
    var inflight = 0;
    var blockedUntil = 0;   // set when the server says we are over the limit
    var timer = null;

    // Creator surfaces the limit as a rejection carrying code 2955. The string
    // and the HTTP status are checked too - the same condition arrives as a
    // bare 429 from some paths, and a wrapper that only knew one shape would
    // silently stop retrying if the other turned up.
    function isRateLimited(err) {
        if (!err) return false;
        var code = err.code !== undefined ? String(err.code) : '';
        if (code === '2955') return true;
        var status = err.status || err.statusCode || (err.response && err.response.status);
        if (String(status) === '429') return true;
        var txt = (err.description || err.message || '') + '';
        return txt.toLowerCase().indexOf('limit for a minute') !== -1;
    }

    function prune(t) {
        while (starts.length && t - starts[0] >= 60000) starts.shift();
    }

    // 0 = go now, >0 = wait this long, -1 = wait for a call to come back.
    function nextSlotIn() {
        var t = now();
        prune(t);
        if (t < blockedUntil) return blockedUntil - t;
        if (inflight >= maxInflight) return -1;
        if (starts.length >= maxPerMin) return 60000 - (t - starts[0]) + 50;
        return 0;
    }

    function pump() {
        while (waiting.length) {
            var wait = nextSlotIn();
            if (wait === -1) return;
            if (wait > 0) {
                if (timer === null) {
                    onWait(wait, waiting.length);
                    timer = later(function () { timer = null; pump(); }, wait);
                }
                return;
            }
            dispatch(waiting.shift());
        }
    }

    function dispatch(job) {
        inflight++;
        starts.push(now());

        real.call(target, job.opts).then(function (res) {
            inflight--;
            job.resolve(res);
            pump();
        }, function (err) {
            inflight--;
            if (isRateLimited(err) && job.tries < maxRetries) {
                job.tries++;
                // Nothing may go out until the window has moved on, and this
                // job goes first when it does.
                blockedUntil = now() + retryWaitMs;
                waiting.unshift(job);
            } else {
                job.reject(err);
            }
            pump();
        });
    }

    function throttled(opts) {
        return new Promise(function (resolve, reject) {
            waiting.push({ opts: opts, resolve: resolve, reject: reject, tries: 0 });
            pump();
        });
    }

    throttled.isThrottled = true;
    throttled.pending = function () { return { queued: waiting.length, inflight: inflight }; };

    target.invokeCustomApi = throttled;
    return throttled;
}

// Installed as early as possible - the SDK script tag is above this one, so
// ZOHO.CREATOR.DATA is normally there already. A few retries cover the case
// where it is not yet, because a tab that loaded before the wrapper was in
// place would keep the raw function for the life of the page.
(function () {
    var tries = 0;

    function attempt() {
        var data = (typeof ZOHO !== 'undefined' && ZOHO.CREATOR && ZOHO.CREATOR.DATA) ? ZOHO.CREATOR.DATA : null;

        if (installApiThrottle(data, {
            onWait: function (ms, queued) {
                console.log('API throttle: holding ' + queued + ' call(s) for ' + Math.round(ms / 100) / 10 + 's to stay under Creator\'s per-minute limit');
            }
        })) {
            return;
        }

        tries++;
        if (tries < 20) setTimeout(attempt, 100);
        else console.warn('API throttle could not install - ZOHO.CREATOR.DATA never appeared');
    }

    attempt();
}());
