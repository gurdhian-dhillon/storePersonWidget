// CREATOR REFUSES CUSTOM API CALLS PAST ~50 A MINUTE PER USER, and the
// production tab goes over it when the supervisor works quickly.
//
//   code 2955 - "You have reached your API call limit for a minute."
//
// It is NOT the daily quota. Widget-to-Custom-API calls are unmetered against
// that, which is why this looks like it should be impossible - but the
// per-minute rate limit applies to them all the same.
//
// WHY IT ADDS UP. Every action on the production screen is TWO calls: the save,
// and then a full fetchAllData to redraw from the server. Click Done on four
// operators' shares in quick succession and four saves go out, each of which
// fires its own refetch on the way back - eight calls, and SEVEN of them were
// worth making. The four refetches ask the identical question and the first
// three answers are thrown away the moment the next one lands.
//
//------------------------------------------------------------------------
// WHAT THIS DOES - AND WHAT IT DELIBERATELY NO LONGER DOES.
//
// It does NOT pace calls. It used to: a rolling-minute budget that queued
// anything past 45 a minute. That was wrong and it hung the screen. Creator had
// not refused anything - the widget was holding calls back on its own guess,
// and once the queue built, every later action waited on a window that would
// not roll for another minute. Delaying work Creator would have accepted is
// worse than the error it was avoiding.
//
// What it does instead:
//
//   1. DROPS SUPERSEDED READS. A queued read is discarded when an identical one
//      is asked for behind it, and its caller is handed the newer answer. Four
//      identical refetches become one call and four renders.
//   2. CAPS CONCURRENCY at 4. Creator allows 6 per account; this leaves room
//      for the other tabs and keeps a burst from arriving as one spike.
//   3. RETRIES A 2955. A rate-limited call was refused BEFORE it executed, so
//      retrying it cannot repeat any work - that is what makes this safe for a
//      save as well as a read.
//
//------------------------------------------------------------------------
// NOTHING THAT WRITES IS EVER DROPPED. This is the whole safety argument, so it
// is worth being exact about it:
//
//   - COALESCE_SAFE is an explicit allowlist, not a rule about names. Every
//     entry was checked against its .dg file for insert / update / delete and
//     has none. A function not on the list is never dropped, so the failure
//     mode of forgetting one is a wasted call, never a lost write.
//   - Only a call still WAITING is dropped, never one already in flight.
//     Dropping the older for the newer always hands the caller FRESHER data.
//     Merging into an in-flight call would do the opposite: a save that landed
//     in between would be missing from the answer, and the screen would show a
//     stage that had already moved on.
//   - The payload has to match too, so two reads asking different questions are
//     never confused for one.

var COALESCE_SAFE = [
    'getProductionWidgetData',
    'getExpectedWaste',
    'getDamageProposal',
    'getReissueDrafts',
    'getSupervisorCounts',
    'getSupervisorDisputes',
    'getSupervisorMaterials',
    'getSupervisorWasteReturns',
    'getSupervisorProductionHistory'
];

function installApiThrottle(target, options) {
    options = options || {};

    var maxInflight = options.maxInflight || 4;
    var maxRetries = options.maxRetries === undefined ? 4 : options.maxRetries;
    var retryWaitMs = options.retryWaitMs || 6000;
    var safeList = options.coalesceSafe || COALESCE_SAFE;
    var now = options.now || function () { return Date.now(); };
    var later = options.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
    var onDrop = options.onDrop || function () {};
    var onRetry = options.onRetry || function () {};

    if (!target || typeof target.invokeCustomApi !== 'function') return null;
    // Installing twice would put the queue behind itself for no reason.
    if (target.invokeCustomApi.isThrottled) return target.invokeCustomApi;

    var real = target.invokeCustomApi;
    var waiting = [];
    var inflight = 0;
    var blockedUntil = 0;
    var timer = null;

    function isCoalesceSafe(opts) {
        var name = opts && opts.api_name;
        if (!name) return false;
        for (var i = 0; i < safeList.length; i++) {
            if (safeList[i] === name) return true;
        }
        return false;
    }

    // api_name plus the payload. Two reads asking different questions must
    // never be treated as one; a signature that fails to match simply means no
    // coalescing, which costs a call and loses nothing.
    function signature(opts) {
        var payload = (opts && opts.payload) || {};
        var body;
        try { body = JSON.stringify(payload); } catch (e) { body = String(now()); }
        return (opts && opts.api_name) + '|' + body;
    }

    // Creator surfaces the limit as a rejection carrying code 2955. The HTTP
    // status and the message are checked too - the same condition arrives as a
    // bare 429 on some paths, and a wrapper that knew only one shape would
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

    function settleJob(job, ok, value) {
        if (ok) job.resolve(value); else job.reject(value);
        // Everyone whose call this one replaced gets the same answer. They
        // asked the identical question, so it IS their answer - and a newer one
        // than the call they queued would have returned.
        for (var i = 0; i < job.replaced.length; i++) {
            if (ok) job.replaced[i].resolve(value); else job.replaced[i].reject(value);
        }
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

        real.call(target, job.opts).then(function (res) {
            inflight--;
            settleJob(job, true, res);
            pump();
        }, function (err) {
            inflight--;
            if (isRateLimited(err) && job.tries < maxRetries) {
                job.tries++;
                // Nothing may go out until the window has moved on, and this
                // job goes first when it does - so ordering survives a retry.
                blockedUntil = now() + retryWaitMs;
                waiting.unshift(job);
                onRetry(job.opts && job.opts.api_name, job.tries, retryWaitMs);
            } else {
                settleJob(job, false, err);
            }
            pump();
        });
    }

    function throttled(opts) {
        return new Promise(function (resolve, reject) {
            var job = { opts: opts, resolve: resolve, reject: reject, tries: 0, replaced: [] };

            if (isCoalesceSafe(opts)) {
                job.sig = signature(opts);
                for (var i = waiting.length - 1; i >= 0; i--) {
                    if (waiting[i].sig === job.sig) {
                        var dead = waiting.splice(i, 1)[0];
                        // Its own replaced list comes along, or the caller two
                        // supersessions back is never settled at all.
                        job.replaced = job.replaced.concat([dead], dead.replaced);
                        onDrop(opts.api_name);
                    }
                }
            }

            waiting.push(job);
            pump();
        });
    }

    throttled.isThrottled = true;
    throttled.pending = function () { return { queued: waiting.length, inflight: inflight }; };

    target.invokeCustomApi = throttled;
    return throttled;
}

// Installed as early as possible - the SDK script tag is above this one, so
// ZOHO.CREATOR.DATA is normally already there. The retries cover the case where
// it is not yet, because a tab script that ran before the wrapper was in place
// would keep the raw function for the life of the page.
(function () {
    var tries = 0;

    function attempt() {
        var data = (typeof ZOHO !== 'undefined' && ZOHO.CREATOR && ZOHO.CREATOR.DATA) ? ZOHO.CREATOR.DATA : null;

        if (installApiThrottle(data, {
            onDrop: function (name) {
                console.log('API: dropped a superseded ' + name + ' - a newer identical one is queued behind it');
            },
            onRetry: function (name, tryNo, waitMs) {
                console.warn('API: Creator rate-limited ' + name + ' (attempt ' + tryNo + ') - retrying in ' + Math.round(waitMs / 1000) + 's');
            }
        })) {
            return;
        }

        tries++;
        if (tries < 20) setTimeout(attempt, 100);
        else console.warn('API wrapper could not install - ZOHO.CREATOR.DATA never appeared');
    }

    attempt();
}());
