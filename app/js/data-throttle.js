// THE getRecords COUNTERPART TO supervisor/js/api-throttle.js.
//
// Every JS-Data-API read path in this app (api-experiment.js, print-data.js,
// receive-read.js, handover-detail.js, consumption-detail.js, pipeline-data.js)
// opens with a Promise.all of 6-8 getAll() calls, each of which is its own
// cursor-paged walk of ZOHO.CREATOR.DATA.getRecords. That is a burst of many
// simultaneous getRecords calls with no cap, and Creator refuses the overflow
// with code 2955 ("maximum number of API calls that can be simultaneously
// initiated") — the same limit api-throttle.js already handles for
// invokeCustomApi, but getRecords is a different SDK method and was never
// wrapped, so every getRecords-based screen was exposed.
//
// SAME SHAPE AS api-throttle.js, deliberately: cap concurrency, retry a 2955
// after a short wait, never drop or merge a call (a getRecords cursor walk is
// stateful — coalescing page N of one walk with page N of another would
// scramble both). No coalescing here for that reason; api-throttle.js's
// coalescing is specific to a small allowlist of read-after-write Custom API
// calls and does not apply to a raw Data API cursor walk.
//
// installDataThrottle(target, options) takes injectable now/setTimeout the
// same way installApiThrottle does, so this is unit-testable rather than a
// hardcoded IIFE — see tools/data-throttle.test.js.
function installDataThrottle(target, options) {
    options = options || {};

    var maxInflight = options.maxInflight || 4;
    var maxRetries = options.maxRetries === undefined ? 4 : options.maxRetries;
    var retryWaitMs = options.retryWaitMs || 6000;
    // A hung SDK promise (network stall, tab backgrounded mid-request) would
    // otherwise never decrement inflight and permanently wedge the queue at
    // maxInflight — the whole screen looks like a stuck spinner with nothing
    // in the console. This frees the slot and rejects that one caller; it does
    // not (and cannot) cancel the underlying request.
    var callTimeoutMs = options.callTimeoutMs || 25000;
    var now = options.now || function () { return Date.now(); };
    var later = options.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
    var clearLater = options.clearTimeout || function (id) { clearTimeout(id); };
    var onRetry = options.onRetry || function () {};
    var onTimeout = options.onTimeout || function () {};

    if (!target || typeof target.getRecords !== 'function') return null;
    // Installing twice would put the queue behind itself for no reason.
    if (target.getRecords.isThrottled) return target.getRecords;

    var real = target.getRecords;
    var waiting = [];
    var inflight = 0;
    var blockedUntil = 0;
    var timer = null;

    // Also ported back into api-throttle.js's copy, so the two stay identical
    // rather than drifting: stringify + code + status + message text.
    function isRateLimited(err) {
        if (!err) return false;
        var code = err.code !== undefined ? String(err.code) : '';
        if (code === '2955') return true;
        var status = err.status || err.statusCode || (err.response && err.response.status);
        if (String(status) === '429') return true;
        var txt = '';
        try { txt = JSON.stringify(err); } catch (e) { txt = String(err); }
        txt += ' ' + (err.description || err.message || '') + (err.responseText || '');
        return /2955|limit for a minute|maximum number of api calls/i.test(txt);
    }

    function pump() {
        while (waiting.length) {
            var t = now();
            if (t < blockedUntil) {
                if (timer === null) {
                    timer = later(function () { timer = null; pump(); }, blockedUntil - t);
                }
                return;
            }
            if (inflight >= maxInflight) return;
            dispatch(waiting.shift());
        }
    }

    function dispatch(job) {
        inflight++;
        var settled = false;
        var timeoutId = later(function () {
            if (settled) return;
            settled = true;
            inflight--;
            onTimeout(job.cfg && job.cfg.report_name);
            job.reject(new Error((job.cfg && job.cfg.report_name || 'getRecords') +
                ': timed out after ' + callTimeoutMs + 'ms — slot freed, call abandoned'));
            pump();
        }, callTimeoutMs);

        // Forward every argument, not just cfg — real is single-arg today
        // (confirmed: every getAll() in this repo calls getRecords(cfg) only),
        // but a wrapper that hardcodes arity is the kind of thing that breaks
        // silently the day a second argument shows up.
        real.apply(target, job.args).then(function (res) {
            if (settled) return;
            settled = true;
            clearLater(timeoutId);
            inflight--;
            job.resolve(res);
            pump();
        }, function (err) {
            if (settled) return;
            settled = true;
            clearLater(timeoutId);
            inflight--;
            if (isRateLimited(err) && job.tries < maxRetries) {
                job.tries++;
                blockedUntil = now() + retryWaitMs;
                waiting.unshift(job);
                onRetry(job.cfg && job.cfg.report_name, job.tries, retryWaitMs);
            } else {
                job.reject(err);
            }
            pump();
        });
    }

    function throttled() {
        var args = Array.prototype.slice.call(arguments);
        return new Promise(function (resolve, reject) {
            waiting.push({ cfg: args[0], args: args, resolve: resolve, reject: reject, tries: 0 });
            pump();
        });
    }

    throttled.isThrottled = true;
    throttled.pending = function () { return { queued: waiting.length, inflight: inflight }; };
    target.getRecords = throttled;
    return throttled;
}

// Installed as early as possible, same pattern as api-throttle.js.
(function () {
    var tries = 0;
    function attempt() {
        var data = (typeof ZOHO !== 'undefined' && ZOHO.CREATOR && ZOHO.CREATOR.DATA) ? ZOHO.CREATOR.DATA : null;
        if (installDataThrottle(data, {
            onRetry: function (name, tryNo, waitMs) {
                console.warn('[data-throttle] getRecords rate-limited (' + name + ', attempt ' +
                    tryNo + ') — retrying in ' + Math.round(waitMs / 1000) + 's');
            },
            onTimeout: function (name) {
                console.error('[data-throttle] getRecords for ' + name + ' timed out — slot freed');
            }
        })) {
            return;
        }
        tries++;
        if (tries < 20) setTimeout(attempt, 100);
        else console.warn('[data-throttle] could not install — ZOHO.CREATOR.DATA never appeared');
    }
    attempt();
}());

if (typeof module !== 'undefined' && module.exports) module.exports = { installDataThrottle: installDataThrottle };
