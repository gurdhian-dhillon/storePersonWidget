// Finishing screen.
// Creator JS API v2, ES5-flavoured (var/function), no init()
//
// Pick a supervisor, see the batches of his that still need folding, pressing and
// branding, open one and work it. Two tabs - To finish and History - the same
// strip the checker screen uses.
//
// THE SAME ACCORDION AS PACKING, deliberately, drawn with the SHARED item-card
// classes the supervisor and store screens use (item-serial, item-title-row,
// item-meta-line, chevron, item-body). Four screens, one list.
//
// WHAT A CARD SAYS, AND WHAT IT NO LONGER SAYS. Item name, SKU, quantity, and the
// order it belongs to. The round number, the "Alteration batch" tag and the
// remake reason are gone: they are facts about why the batch exists, and the
// finisher's job is the same either way - fold it, press it, brand it. They were
// noise on every row.
//
// NOTHING IS HELD IN THE BROWSER. The row is opened on the first press by
// startFinishingJob, each sub-stage is stamped by saveFinishingStage as it
// happens, and completeFinishingJob closes it. A refresh, a closed tab or a shift
// handover resumes exactly where the last press left off. Every stamp is the
// SERVER's clock: the widget used to format its own timestamps and post them at
// the end of the job, so a tablet with a wrong clock wrote wrong times and two
// devices on one job wrote two disagreeing sets.

var STAGE_NAMES = ['folding', 'pressing', 'branding'];
var STAGE_LABELS = ['Folding', 'Pressing', 'Branding'];

var SUPERVISORS = [];
var SELECTED_SUP = '';
var OPERATORS_LIST = [];
var SELECTED_OPERATOR = '';

var JOBS_QUEUE = [];
var COMPLETED_HISTORY = [];
var ACTIVE_JOB_ID = null;
var ACTIVE_STAGE = 0;

var ACTIVE_TAB = 'queue';
var STAGE_BUSY = false;
var HISTORY_LOADED = false;

// ----------------------------------------------------
// HELPERS
// ----------------------------------------------------

function escapeHtml(str) {
    return String(str === null || str === undefined ? '' : str).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

function n(v) {
    var x = Number(v);
    return isNaN(x) ? 0 : x;
}

function plural(count, word) {
    return count + ' ' + word + (count === 1 ? '' : 's');
}

function isRunningInCreator() {
    return (window.self !== window.top) && (typeof ZOHO !== 'undefined' && ZOHO.CREATOR);
}

function fmtDuration(seconds) {
    if (seconds === null || seconds === undefined) return '—';
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return m === 0 ? s + 's' : m + 'm ' + s + 's';
}

// A Creator Time field renders as "14:23:05" or as "2:23:05 PM" depending on how
// the field is configured, and both arrive here. Reading "2:23 PM" as 2am turns a
// twenty-minute stage into a fourteen-hour one, which is why this is parsed
// rather than split on colons.
function parseClockToSeconds(str) {
    if (!str || typeof str !== 'string') return null;
    var txt = str.trim();
    var lower = txt.toLowerCase();
    var isPm = lower.indexOf('pm') !== -1;
    var isAm = lower.indexOf('am') !== -1;

    var clock = '';
    var pieces = txt.split(/\s+/);
    for (var i = 0; i < pieces.length; i++) {
        if (pieces[i].indexOf(':') !== -1) clock = pieces[i];
    }
    if (!clock) return null;

    var parts = clock.split(':');
    if (parts.length < 2) return null;

    var hh = parseInt(parts[0], 10);
    var mm = parseInt(parts[1], 10);
    var ss = parts[2] ? parseInt(String(parts[2]).replace(/[^0-9]/g, ''), 10) : 0;
    if (isNaN(hh) || isNaN(mm)) return null;
    if (isNaN(ss)) ss = 0;

    if (isPm && hh < 12) hh += 12;
    else if (isAm && hh === 12) hh = 0;

    return hh * 3600 + mm * 60 + ss;
}

// The sub-stage fields are Time, not Date-Time, so they hold a clock reading with
// no date and a night-shift stage ends "before" it starts. Wrapping is right for
// any stage under a day, and no finishing stage is not.
function getDurationFromTimes(startStr, endStr) {
    var sSecs = parseClockToSeconds(startStr);
    var eSecs = parseClockToSeconds(endStr);
    if (sSecs === null || eSecs === null) return null;
    var diff = eSecs - sSecs;
    if (diff < 0) diff += 24 * 3600;
    return diff;
}

function shortTime(str) {
    if (!str) return '—';
    var secs = parseClockToSeconds(str);
    if (secs === null) return str;
    var hh = Math.floor(secs / 3600);
    var mm = Math.floor((secs % 3600) / 60);
    return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
}

// An empty string from Deluge means "not stamped yet" and has to become null -
// the render layer tests `=== null` to decide whether a stage has been started.
function hydrateStages(raw) {
    var out = {};
    for (var i = 0; i < STAGE_NAMES.length; i++) {
        var nm = STAGE_NAMES[i];
        var src = (raw && raw[nm]) ? raw[nm] : {};
        var start = src.start ? src.start : null;
        var end = src.end ? src.end : null;
        out[nm] = {
            start: start,
            end: end,
            duration: (start && end) ? getDurationFromTimes(start, end) : null
        };
    }
    return out;
}

// One place that knows a Deluge reply is only good if it says success:true.
function callApi(apiName, payload) {
    return ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: apiName,
        http_method: 'POST',
        payload: { payloadJson: JSON.stringify(payload) }
    }).then(function (response) {
        var parsed = null;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            throw new Error('Could not read the reply from ' + apiName);
        }
        if (parsed && parsed.errors && parsed.errors.length) {
            throw new Error(parsed.errors.join(', '));
        }
        return parsed;
    });
}

function activeJob() {
    var hit = JOBS_QUEUE.filter(function (j) { return String(j.id) === String(ACTIVE_JOB_ID); });
    return hit.length ? hit[0] : null;
}

// ----------------------------------------------------
// BOOT + TABS
// ----------------------------------------------------

document.addEventListener('DOMContentLoaded', function () {
    var dateEl = document.getElementById('app-date-el');
    if (dateEl) {
        dateEl.innerText = new Date().toLocaleDateString('en-GB', {
            weekday: 'long', day: 'numeric', month: 'short', year: 'numeric'
        });
    }
    setTimeout(function () {
        loadPeople();
    }, 150);
});

function switchTab(tab) {
    ACTIVE_TAB = tab;

    var buttons = document.querySelectorAll('.tab-btn');
    for (var i = 0; i < buttons.length; i++) {
        if (buttons[i].getAttribute('data-tab') === tab) buttons[i].classList.add('is-active');
        else buttons[i].classList.remove('is-active');
    }

    var qPanel = document.getElementById('panel-queue');
    var hPanel = document.getElementById('panel-history');
    if (qPanel) qPanel.className = tab === 'queue' ? 'tab-panel is-active' : 'tab-panel';
    if (hPanel) hPanel.className = tab === 'history' ? 'tab-panel is-active' : 'tab-panel';

    // History is loaded on FIRST open, not at page load: it is a query, and
    // somebody who only ever works the queue should not be paying for it.
    if (tab === 'history' && !HISTORY_LOADED) loadHistory();
}

function onRefreshClicked() {
    if (ACTIVE_TAB === 'history') {
        loadHistory();
        return;
    }
    loadQueue();
}

function loadPeople() {
    if (!isRunningInCreator()) {
        SUPERVISORS = [{ id: '10', name: 'Suraj' }, { id: '11', name: 'Vivek' }];
        OPERATORS_LIST = [{ id: '1', name: 'Aniket' }, { id: '2', name: 'Sambhav' }];
        SELECTED_OPERATOR = OPERATORS_LIST[0].name;
        renderSupervisorPicker();
        loadQueue();
        return;
    }

    callApi('getStorePackingStaff', {}).then(function (parsed) {
        SUPERVISORS = parsed.supervisors || [];
        OPERATORS_LIST = (parsed.staff && parsed.staff.length) ? parsed.staff : SUPERVISORS.slice();
        if (OPERATORS_LIST.length) SELECTED_OPERATOR = OPERATORS_LIST[0].name;
        renderSupervisorPicker();
        loadQueue();
    }).catch(function (err) {
        console.error('getStorePackingStaff failed:', err);
        var sel = document.getElementById('sup-select');
        if (sel) sel.innerHTML = '<option value="">Could not load staff</option>';
    });
}

function renderSupervisorPicker() {
    var sel = document.getElementById('sup-select');
    if (!sel) return;

    if (!SUPERVISORS.length) {
        sel.innerHTML = '<option value="">No supervisors found</option>';
        return;
    }

    // The first supervisor is selected on load rather than a placeholder, so the
    // screen opens on work instead of on an empty list.
    if (!SELECTED_SUP) SELECTED_SUP = String(SUPERVISORS[0].id);

    sel.innerHTML = SUPERVISORS.map(function (sup) {
        return '<option value="' + escapeHtml(sup.id) + '"' +
            (String(sup.id) === String(SELECTED_SUP) ? ' selected' : '') +
            '>' + escapeHtml(sup.name) + '</option>';
    }).join('');

    sel.onchange = function () {
        SELECTED_SUP = sel.value;
        ACTIVE_JOB_ID = null;
        ACTIVE_STAGE = 0;
        HISTORY_LOADED = false;
        loadQueue();
        if (ACTIVE_TAB === 'history') loadHistory();
    };
}

// ----------------------------------------------------
// QUEUE
// ----------------------------------------------------

function loadQueue() {
    var container = document.getElementById('queue-list');

    if (!isRunningInCreator()) {
        JOBS_QUEUE = [
            { id: '1', finishingId: null, salesOrder: 'SO-00008', planNo: 'PLAN-00016', itemName: 'Linen Hamlet Throw', sku: 'SKU-00003', qty: 11, status: 'Pending', stages: hydrateStages(null) },
            { id: '2', finishingId: null, salesOrder: 'SO-00008', planNo: 'PLAN-00016', itemName: 'Linen Maize Duvet Cover', sku: 'SKU-00005', qty: 10, status: 'Pending', stages: hydrateStages(null) }
        ];
        renderQueue();
        return;
    }

    if (container) container.innerHTML = '<div class="fin-hint">Loading&hellip;</div>';

    callApi('getFinishingItems', { supervisorId: SELECTED_SUP }).then(function (parsed) {
        JOBS_QUEUE = (parsed.queue || []).map(function (row) {
            return {
                id: String(row.id),
                finishingId: (row.finishingId && row.finishingId !== '0') ? String(row.finishingId) : null,
                salesOrder: row.salesOrder,
                planNo: row.planNo,
                itemName: row.itemName,
                sku: row.sku || '',
                qty: n(row.qty),
                status: row.status || 'Pending',
                stages: hydrateStages(row.stages)
            };
        });

        // Re-derive which stage is open from what the SERVER says is stamped.
        // Keeping a stale ACTIVE_STAGE would put the screen a step ahead of the
        // record, which is the state that makes an operator press twice.
        if (ACTIVE_JOB_ID && activeJob()) ACTIVE_STAGE = firstOpenStageIndex(activeJob());
        else { ACTIVE_JOB_ID = null; ACTIVE_STAGE = 0; }

        renderQueue();
    }).catch(function (err) {
        console.error('getFinishingItems failed:', err);
        if (container) container.innerHTML = '<div class="fin-hint is-bad">' + escapeHtml(err.message) + '</div>';
    });
}

function firstOpenStageIndex(job) {
    for (var i = 0; i < STAGE_NAMES.length; i++) {
        var stg = job.stages[STAGE_NAMES[i]];
        if (!stg || stg.end === null) return i;
    }
    return STAGE_NAMES.length - 1;
}

function renderQueue() {
    var container = document.getElementById('queue-list');
    var countLine = document.getElementById('queue-count');
    var tabCount = document.getElementById('count-queue');

    if (countLine) {
        countLine.innerText = JOBS_QUEUE.length ? plural(JOBS_QUEUE.length, 'batch') + ' to finish' : '';
    }
    if (tabCount) {
        tabCount.innerText = JOBS_QUEUE.length ? JOBS_QUEUE.length : '';
        if (JOBS_QUEUE.length) tabCount.classList.remove('hidden');
        else tabCount.classList.add('hidden');
    }
    if (!container) return;

    if (!JOBS_QUEUE.length) {
        container.innerHTML = '<div class="fin-hint">Nothing waiting to be finished for this supervisor</div>';
        return;
    }

    container.innerHTML = JOBS_QUEUE.map(function (job, i) {
        var open = (String(job.id) === String(ACTIVE_JOB_ID));
        var started = job.status === 'In_Progress';

        // Only two states a card can be in, and they are the only two that change
        // what he does next: nobody has started it, or somebody has.
        var colour = started ? '#2563eb' : '#64748b';
        var badge = started ? 'In progress' : 'Not started';

        return '<div class="item-card' + (open ? ' open' : '') + '">' +
            '<div class="item-header" onclick="selectJob(\'' + escapeHtml(job.id) + '\')">' +
                '<div class="item-title-row">' +
                    '<div class="item-serial">' + (i + 1) + '</div>' +
                    '<div class="item-header-info">' +
                        '<h2>' + escapeHtml(job.itemName) + '</h2>' +
                        '<div class="item-meta-line" style="display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;">' +
                            (job.sku ? '<span class="fin-sku">' + escapeHtml(job.sku) + '</span>' : '') +
                            '<span class="item-qty">' + plural(job.qty, 'pc') + '</span>' +
                            '<span class="item-status-badge" style="color:' + colour + '; font-weight:600; font-size:0.8rem; background:' + colour + '15; padding:0.1rem 0.5rem; border-radius:1rem;">' + badge + '</span>' +
                            '<span class="fin-order">' + escapeHtml(job.salesOrder || '') +
                                (job.planNo ? ' · ' + escapeHtml(job.planNo) : '') + '</span>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="item-header-right"><span class="chevron">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>' +
                '</span></div>' +
            '</div>' +
            (open ? '<div class="item-body">' + jobBody(job) + '</div>' : '') +
            '</div>';
    }).join('');
}

function selectJob(jobId) {
    if (STAGE_BUSY) return;

    // Clicking the open one closes it. Nothing is lost either way - every stamp
    // is already on the record.
    if (String(jobId) === String(ACTIVE_JOB_ID)) {
        ACTIVE_JOB_ID = null;
        ACTIVE_STAGE = 0;
        renderQueue();
        return;
    }

    ACTIVE_JOB_ID = jobId;
    var job = activeJob();
    ACTIVE_STAGE = job ? firstOpenStageIndex(job) : 0;
    renderQueue();
}

// ----------------------------------------------------
// THE OPEN CARD
// ----------------------------------------------------

function jobBody(job) {
    var operatorOpts = OPERATORS_LIST.map(function (op) {
        return '<option value="' + escapeHtml(op.name) + '"' +
            (op.name === (job.selectedOperator || SELECTED_OPERATOR) ? ' selected' : '') +
            '>' + escapeHtml(op.name) + '</option>';
    }).join('');

    // ALL THREE STAMPED BUT STILL OPEN IS A REACHABLE STATE, and without this it
    // was a dead end: every stage renders as done, so no stage offers a button,
    // and the batch sits on the queue for ever with no way to close it from the
    // screen.
    //
    // It happens when the closing write lands everywhere except Finishing_Status
    // - the stamps are Time/Date-Time/Number fields and go in regardless, while
    // the status is a Dropdown that silently refuses a value its picklist does
    // not carry. completeFinishingJob now reads the status back and says so, but
    // the rows already in that state still need a way out.
    var allStamped = true;
    for (var s = 0; s < STAGE_NAMES.length; s++) {
        if (job.stages[STAGE_NAMES[s]].end === null) allStamped = false;
    }

    var closeRow = '';
    if (allStamped) {
        closeRow = '<div class="fin-close-row">' +
            '<span>All three stages are stamped, but this job was never closed.</span>' +
            '<button type="button" class="fin-btn is-end" onclick="closeJob()">Close the job</button>' +
            '</div>';
    }

    return '<div class="fin-topbar">' +
            '<label class="fin-picker"><span>Finished by</span>' +
            '<select onchange="onOperatorChanged(this.value)">' +
            (operatorOpts || '<option value="">No operators found</option>') + '</select></label>' +
        '</div>' +
        '<div class="fin-stages">' + STAGE_NAMES.map(function (name, i) {
            return stageRow(job, name, i);
        }).join('') + '</div>' +
        closeRow;
}

// The recovery path for the state above. completeFinishingJob is idempotent and
// does not re-stamp a branding end that already exists, so this only closes the
// row, writes Qty_Finished and asks the order the question it never got asked.
function closeJob() {
    var job = activeJob();
    if (!job || STAGE_BUSY) return;

    if (!job.finishingId) {
        alert('This job was never opened on the server. Refresh and start it again.');
        loadQueue();
        return;
    }

    if (!isRunningInCreator()) {
        JOBS_QUEUE = JOBS_QUEUE.filter(function (j) { return j.id !== job.id; });
        ACTIVE_JOB_ID = null;
        renderQueue();
        return;
    }

    setStageBusy(true);

    callApi('completeFinishingJob', { finishingId: job.finishingId }).then(function (res) {
        alert(res.message ? res.message : ('Closed ' + job.itemName + '.'));
        ACTIVE_JOB_ID = null;
        ACTIVE_STAGE = 0;
        setStageBusy(false);
        HISTORY_LOADED = false;
        loadQueue();
    }).catch(function (err) {
        setStageBusy(false);
        alert('Could not close the job:\n\n' + (err && err.message ? err.message : err));
    });
}

function stageRow(job, stageName, index) {
    var stage = job.stages[stageName];
    var label = STAGE_LABELS[index];

    var state, detail, action;

    if (stage.end !== null) {
        state = 'is-done';
        detail = shortTime(stage.start) + ' → ' + shortTime(stage.end) +
            '<span class="fin-dur">' + fmtDuration(stage.duration) + '</span>';
        action = '';
    } else if (index === ACTIVE_STAGE && stage.start !== null) {
        state = 'is-running';
        detail = 'Started ' + shortTime(stage.start);
        action = '<button type="button" class="fin-btn is-end" onclick="completeStage(\'' + stageName + '\')">End ' + label + '</button>';
    } else if (index === ACTIVE_STAGE) {
        state = 'is-next';
        detail = 'Ready to start';
        action = '<button type="button" class="fin-btn is-start" onclick="startStage(\'' + stageName + '\')">Start ' + label + '</button>';
    } else {
        state = 'is-waiting';
        detail = 'Waiting for ' + STAGE_LABELS[index - 1];
        action = '';
    }

    return '<div class="fin-stage ' + state + '">' +
        '<div class="fin-stage-dot">' + (stage.end !== null ? '✓' : (index + 1)) + '</div>' +
        '<div class="fin-stage-main">' +
            '<span class="fin-stage-name">' + label + '</span>' +
            '<span class="fin-stage-detail">' + detail + '</span>' +
        '</div>' +
        '<div class="fin-stage-act">' + action + '</div>' +
        '</div>';
}

function onOperatorChanged(name) {
    SELECTED_OPERATOR = name;
    var job = activeJob();
    if (job) job.selectedOperator = name;
}

function setStageBusy(busy) {
    STAGE_BUSY = busy;
    var btns = document.querySelectorAll('.fin-btn');
    for (var i = 0; i < btns.length; i++) {
        btns[i].disabled = busy;
        btns[i].style.opacity = busy ? '0.6' : '';
    }
}

// ----------------------------------------------------
// THE THREE PRESSES
// ----------------------------------------------------

function startStage(stageName) {
    var job = activeJob();
    if (!job || STAGE_BUSY) return;

    var stage = job.stages[stageName];
    if (!stage || stage.start !== null) return;

    if (!isRunningInCreator()) {
        stage.start = '10:00:00';
        renderQueue();
        return;
    }

    setStageBusy(true);

    // THE ROW IS OPENED ON THE FIRST PRESS. startFinishingJob is idempotent, so a
    // resumed job skips straight to the stamp and a double press cannot fork it
    // into two rows.
    var opened;
    if (job.finishingId) {
        opened = Promise.resolve(null);
    } else {
        opened = callApi('startFinishingJob', {
            itemCheckId: job.id,
            staffName: job.selectedOperator || SELECTED_OPERATOR
        }).then(function (res) {
            job.finishingId = res.finishingId;
            job.status = 'In_Progress';
        });
    }

    opened.then(function () {
        return callApi('saveFinishingStage', {
            finishingId: job.finishingId,
            stage: stageName,
            event: 'start'
        });
    }).then(function (res) {
        stage.start = res.time;
        setStageBusy(false);
        renderQueue();
    }).catch(function (err) {
        setStageBusy(false);
        alert('Could not record the start of ' + stageName + ':\n\n' + (err && err.message ? err.message : err));
        loadQueue();
    });
}

function completeStage(stageName) {
    var job = activeJob();
    if (!job || STAGE_BUSY) return;

    var stage = job.stages[stageName];
    if (!stage || stage.start === null || stage.end !== null) return;

    var index = STAGE_NAMES.indexOf(stageName);
    var isLast = (index === STAGE_NAMES.length - 1);

    if (!isRunningInCreator()) {
        stage.end = '10:20:00';
        stage.duration = getDurationFromTimes(stage.start, stage.end);
        if (isLast) {
            JOBS_QUEUE = JOBS_QUEUE.filter(function (j) { return j.id !== job.id; });
            ACTIVE_JOB_ID = null;
        } else {
            ACTIVE_STAGE = index + 1;
        }
        renderQueue();
        return;
    }

    if (!job.finishingId) {
        alert('This job was never opened on the server. Refresh and start it again.');
        loadQueue();
        return;
    }

    setStageBusy(true);

    if (!isLast) {
        callApi('saveFinishingStage', {
            finishingId: job.finishingId,
            stage: stageName,
            event: 'end'
        }).then(function (res) {
            stage.end = res.time;
            stage.duration = getDurationFromTimes(stage.start, stage.end);
            ACTIVE_STAGE = index + 1;
            setStageBusy(false);
            renderQueue();
        }).catch(function (err) {
            setStageBusy(false);
            alert('Could not record the end of ' + stageName + ':\n\n' + (err && err.message ? err.message : err));
            loadQueue();
        });
        return;
    }

    // THE LAST PRESS IS ONE CALL. completeFinishingJob stamps the branding end,
    // closes the row, writes Qty_Finished from the inspection and asks the order
    // whether that was the last batch it was waiting for - so there is no window
    // in which the work is recorded but the job is still open.
    callApi('completeFinishingJob', { finishingId: job.finishingId }).then(function (res) {
        alert(res.message ? res.message : ('Finished ' + job.itemName + '.'));
        ACTIVE_JOB_ID = null;
        ACTIVE_STAGE = 0;
        setStageBusy(false);
        HISTORY_LOADED = false;
        loadQueue();
    }).catch(function (err) {
        setStageBusy(false);
        alert('Could not close the finishing job:\n\n' + (err && err.message ? err.message : err) +
            '\n\nNothing is lost - every stage time is already saved. Refresh and press End again.');
        renderQueue();
    });
}

// ----------------------------------------------------
// HISTORY
// ----------------------------------------------------

function loadHistory() {
    var container = document.getElementById('history-list');

    if (!isRunningInCreator()) {
        COMPLETED_HISTORY = [{
            id: '1', salesOrder: 'SO-00008', planNo: 'PLAN-00016', itemName: 'Linen Hamlet Throw',
            qty: 11, staff: 'Aniket', completedOn: '20-Aug-2026 14:05:00',
            stages: { folding: { duration: 300 }, pressing: { duration: 420 }, branding: { duration: 180 } }
        }];
        HISTORY_LOADED = true;
        renderHistory();
        return;
    }

    if (container) container.innerHTML = '<div class="fin-hint">Loading&hellip;</div>';

    callApi('getFinishingHistory', { supervisorId: SELECTED_SUP }).then(function (parsed) {
        COMPLETED_HISTORY = parsed.history || [];
        HISTORY_LOADED = true;
        renderHistory();
    }).catch(function (err) {
        console.error('getFinishingHistory failed:', err);
        if (container) container.innerHTML = '<div class="fin-hint is-bad">' + escapeHtml(err.message) + '</div>';
    });
}

function renderHistory() {
    var container = document.getElementById('history-list');
    if (!container) return;

    if (!COMPLETED_HISTORY.length) {
        container.innerHTML = '<div class="fin-hint">Nothing finished yet</div>';
        return;
    }

    var rows = COMPLETED_HISTORY.map(function (run) {
        var st = run.stages || {};
        return '<tr>' +
            '<td><span class="fin-hist-name">' + escapeHtml(run.itemName) + '</span></td>' +
            '<td class="col-num">' + n(run.qty) + '</td>' +
            '<td>' + escapeHtml(run.salesOrder || '—') + '</td>' +
            '<td>' + escapeHtml(run.staff || '—') + '</td>' +
            '<td class="col-num">' + fmtDuration(st.folding ? st.folding.duration : null) + '</td>' +
            '<td class="col-num">' + fmtDuration(st.pressing ? st.pressing.duration : null) + '</td>' +
            '<td class="col-num">' + fmtDuration(st.branding ? st.branding.duration : null) + '</td>' +
            '<td>' + escapeHtml(run.completedOn || '—') + '</td>' +
            '</tr>';
    }).join('');

    container.innerHTML = '<div class="fin-scroll"><table class="fin-tbl">' +
        '<thead><tr><th>Item</th><th class="col-num">Pcs</th><th>Order</th><th>Finished by</th>' +
        '<th class="col-num">Folding</th><th class="col-num">Pressing</th><th class="col-num">Branding</th>' +
        '<th>Completed</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>';
}
