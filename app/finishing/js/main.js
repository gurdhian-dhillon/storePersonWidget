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

var STAGE_NAMES = ['pressing', 'folding', 'branding'];
var STAGE_LABELS = ['Pressing', 'Folding', 'Branding'];

var SUPERVISORS = [];
var SELECTED_SUP = '';
var OPERATORS_LIST = [];
var SELECTED_OPERATOR = '';

var JOBS_QUEUE = [];
var COMPLETED_HISTORY = [];
var ACTIVE_SO = null;
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

// The stamp as it was taken, seconds and all. Truncating to HH:mm made two
// stages that were eight seconds apart read as the same minute, which looks
// like the screen failed to record one of them.
function exactTime(str) {
    if (!str) return '—';
    var secs = parseClockToSeconds(str);
    if (secs === null) return str;
    var hh = Math.floor(secs / 3600);
    var mm = Math.floor((secs % 3600) / 60);
    var ss = secs % 60;
    return (hh < 10 ? '0' : '') + hh + ':' +
           (mm < 10 ? '0' : '') + mm + ':' +
           (ss < 10 ? '0' : '') + ss;
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

function activeJobGroup() {
    var hit = JOBS_QUEUE.filter(function (j) { return String(j.id) === String(ACTIVE_JOB_ID); });
    if (!hit.length) return [];
    var refJob = hit[0];
    return JOBS_QUEUE.filter(function (j) {
        return j.salesOrder === refJob.salesOrder && 
               (refJob.sku ? j.sku === refJob.sku : j.itemName === refJob.itemName);
    });
}

function getCombinedActiveJob() {
    var group = activeJobGroup();
    if (!group.length) return null;
    
    var ref = group[0];
    var totalQty = group.reduce(function (sum, j) { return sum + n(j.qty); }, 0);
    
    var combinedStages = hydrateStages(null);
    STAGE_NAMES.forEach(function (name) {
        var start = null;
        var end = null;
        for (var i = 0; i < group.length; i++) {
            if (group[i].stages[name].start !== null) {
                start = group[i].stages[name].start;
                break;
            }
        }
        var allEnded = true;
        for (var i = 0; i < group.length; i++) {
            if (group[i].stages[name].end === null) {
                allEnded = false;
                break;
            }
        }
        if (allEnded && start !== null) {
            end = group[0].stages[name].end; // use first one's end clock
        }
        combinedStages[name] = {
            start: start,
            end: end,
            duration: (start && end) ? getDurationFromTimes(start, end) : null
        };
    });
    
    var status = 'Pending';
    for (var i = 0; i < group.length; i++) {
        if (group[i].status === 'In_Progress') {
            status = 'In_Progress';
            break;
        }
    }
    
    var selectedOperator = '';
    for (var i = 0; i < group.length; i++) {
        if (group[i].selectedOperator) {
            selectedOperator = group[i].selectedOperator;
            break;
        }
    }
    
    return {
        id: ref.id,
        finishingId: ref.finishingId,
        salesOrder: ref.salesOrder,
        planNo: ref.planNo,
        itemName: ref.itemName,
        sku: ref.sku,
        qty: totalQty,
        status: status,
        stages: combinedStages,
        selectedOperator: selectedOperator,
        jobs: group
    };
}

function activeJob() {
    return getCombinedActiveJob();
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
    var refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.innerText = 'Refreshing…';
    }

    var cleanUp = function () {
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.innerText = 'Refresh';
        }
    };

    if (ACTIVE_TAB === 'history') {
        loadHistory().then(cleanUp).catch(cleanUp);
        return;
    }

    // Refresh staff/supervisors and queue together
    loadPeople().then(cleanUp).catch(cleanUp);
}

function loadPeople() {
    if (!isRunningInCreator()) {
        SUPERVISORS = [{ id: '10', name: 'Suraj' }, { id: '11', name: 'Vivek' }];
        OPERATORS_LIST = [{ id: '1', name: 'Aniket' }, { id: '2', name: 'Sambhav' }];
        SELECTED_OPERATOR = OPERATORS_LIST[0].name;
        renderSupervisorPicker();
        return loadQueue();
    }

    return callApi('getStorePackingStaff', {}).then(function (parsed) {
        SUPERVISORS = parsed.supervisors || [];
        OPERATORS_LIST = (parsed.staff && parsed.staff.length) ? parsed.staff : SUPERVISORS.slice();
        if (OPERATORS_LIST.length) SELECTED_OPERATOR = OPERATORS_LIST[0].name;
        renderSupervisorPicker();
        return loadQueue();
    }).catch(function (err) {
        console.error('getStorePackingStaff failed:', err);
        var sel = document.getElementById('sup-select');
        if (sel) sel.innerHTML = '<option value="">Could not load staff</option>';
        return loadQueue();
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
        return Promise.resolve();
    }

    if (container) container.innerHTML = '<div class="fin-hint">Loading&hellip;</div>';

    return callApi('getFinishingItems', { supervisorId: SELECTED_SUP }).then(function (parsed) {
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
        throw err;
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

    // Sync open state flags
    if (ACTIVE_JOB_ID !== null) {
        var openJobObj = JOBS_QUEUE.filter(function (j) { return String(j.id) === String(ACTIVE_JOB_ID); })[0];
        if (openJobObj) {
            ACTIVE_SO = openJobObj.salesOrder;
        } else {
            ACTIVE_JOB_ID = null;
        }
    }
    if (ACTIVE_SO !== null && !JOBS_QUEUE.some(function (j) { return String(j.salesOrder) === String(ACTIVE_SO); })) {
        ACTIVE_SO = null;
    }

    // Group jobs by salesOrder
    var groupsMap = {};
    var groupsList = [];

    JOBS_QUEUE.forEach(function (job) {
        var so = job.salesOrder || '—';
        if (!groupsMap[so]) {
            groupsMap[so] = [];
            groupsList.push(so);
        }
        groupsMap[so].push(job);
    });

    container.innerHTML = groupsList.map(function (so, idx) {
        var groupJobs = groupsMap[so];
        var isOpen = (String(so) === String(ACTIVE_SO));

        // Get unique item names in this sales order
        var itemNames = groupJobs.map(function (j) { return j.itemName; }).filter(function (v, i, self) {
            return self.indexOf(v) === i;
        }).join(', ');

        var totalQty = groupJobs.reduce(function (sum, j) { return sum + n(j.qty); }, 0);

        // Header for Sales Order card
        var cardHtml = '<div class="item-card' + (isOpen ? ' open' : '') + '">' +
            '<div class="item-header" onclick="selectSalesOrder(\'' + escapeHtml(so) + '\')">' +
                '<div class="item-title-row">' +
                    '<div class="item-serial">' + (idx + 1) + '</div>' +
                    '<div class="item-header-info">' +
                        '<h2>' + escapeHtml(so) + '</h2>' +
                        '<div class="item-meta-line" style="display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;">' +
                            '<span class="item-qty" style="font-weight: 500; color: var(--text-dark);">' + escapeHtml(itemNames) + '</span>' +
                            '<span class="round-tag" style="background-color: #f1f5f9; color: #475569;">' + totalQty + ' pcs total</span>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="item-header-right"><span class="chevron">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>' +
                '</span></div>' +
            '</div>';

        if (isOpen) {
            cardHtml += '<div class="so-items-container">';

            var subGroupsMap = {};
            var subGroupsList = [];

            groupJobs.forEach(function (job) {
                var key = job.sku ? job.sku : job.itemName;
                if (!subGroupsMap[key]) {
                    subGroupsMap[key] = [];
                    subGroupsList.push(key);
                }
                subGroupsMap[key].push(job);
            });

            subGroupsList.forEach(function (key, subIdx) {
                var subGroup = subGroupsMap[key];
                var ref = subGroup[0];
                var totalSubQty = subGroup.reduce(function (sum, j) { return sum + n(j.qty); }, 0);
                
                var groupJobIds = subGroup.map(function (j) { return String(j.id); });
                var subIsOpen = (ACTIVE_JOB_ID !== null && groupJobIds.indexOf(String(ACTIVE_JOB_ID)) !== -1);
                
                var started = subGroup.some(function (j) { return j.status === 'In_Progress'; });
                var colour = started ? '#2563eb' : '#64748b';
                var badge = started ? 'In progress' : 'Not started';

                var plans = subGroup.map(function (j) { return j.planNo; }).filter(function (v, i, self) {
                    return v && self.indexOf(v) === i;
                }).join(', ');

                cardHtml += '<div class="sub-item-row' + (subIsOpen ? ' open' : '') + '">' +
                    '<div class="sub-item-header" onclick="selectJob(\'' + escapeHtml(ref.id) + '\'); event.stopPropagation();">' +
                        '<div class="item-title-row" style="display: flex; gap: 1rem; align-items: center;">' +
                            '<div class="item-serial sub-serial">' + (subIdx + 1) + '</div>' +
                            '<div class="item-header-info">' +
                                '<h3 style="margin: 0 0 0.25rem 0; font-size: 1rem; color: var(--text-dark); font-weight: 600;">' + escapeHtml(ref.itemName) + '</h3>' +
                                '<div class="item-meta-line" style="display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;">' +
                                    (ref.sku ? '<span class="fin-sku">' + escapeHtml(ref.sku) + '</span>' : '') +
                                    '<span class="item-qty">' + plural(totalSubQty, 'pc') + '</span>' +
                                    '<span class="item-status-badge" style="color:' + colour + '; font-weight:600; font-size:0.8rem; background:' + colour + '15; padding:0.1rem 0.5rem; border-radius:1rem;">' + badge + '</span>' +
                                    (plans ? '<span class="fin-order">' + escapeHtml(plans) + '</span>' : '') +
                                '</div>' +
                            '</div>' +
                        '</div>' +
                        '<div class="item-header-right"><span class="chevron">' +
                            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>' +
                        '</span></div>' +
                    '</div>' +
                    (subIsOpen ? '<div class="item-body">' + jobBody(getCombinedActiveJob()) + '</div>' : '') +
                    '</div>';
            });

            cardHtml += '</div>';
        }

        cardHtml += '</div>';
        return cardHtml;
    }).join('');
}

function selectSalesOrder(so) {
    if (STAGE_BUSY) return;
    if (String(so) === String(ACTIVE_SO)) {
        ACTIVE_SO = null;
        ACTIVE_JOB_ID = null;
    } else {
        ACTIVE_SO = so;
        ACTIVE_JOB_ID = null;
    }
    renderQueue();
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
    if (job) {
        ACTIVE_SO = job.salesOrder;
        ACTIVE_STAGE = firstOpenStageIndex(job);
    } else {
        ACTIVE_STAGE = 0;
    }
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
    var combined = activeJob();
    if (!combined || STAGE_BUSY) return;

    var group = combined.jobs;
    if (!isRunningInCreator()) {
        var ids = group.map(function (j) { return j.id; });
        JOBS_QUEUE = JOBS_QUEUE.filter(function (j) { return ids.indexOf(j.id) === -1; });
        ACTIVE_JOB_ID = null;
        renderQueue();
        return;
    }

    setStageBusy(true);

    var promises = group.map(function (job) {
        if (!job.finishingId) return Promise.resolve(null);
        return callApi('completeFinishingJob', { finishingId: job.finishingId });
    });

    Promise.all(promises).then(function (results) {
        alert('Finished ' + combined.itemName + ' (' + combined.qty + ' pcs total).');
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
        detail = exactTime(stage.start) + ' → ' + exactTime(stage.end) +
            '<span class="fin-dur">' + fmtDuration(stage.duration) + '</span>';
        action = '';
    } else if (index === ACTIVE_STAGE && stage.start !== null) {
        state = 'is-running';
        detail = 'Started ' + exactTime(stage.start);
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
    var group = activeJobGroup();
    group.forEach(function (j) { j.selectedOperator = name; });
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
    var combined = activeJob();
    if (!combined || STAGE_BUSY) return;

    var group = combined.jobs;

    if (!isRunningInCreator()) {
        group.forEach(function (j) {
            j.stages[stageName].start = '10:00:00';
        });
        renderQueue();
        return;
    }

    setStageBusy(true);

    var promises = group.map(function (job) {
        var stage = job.stages[stageName];
        if (!stage || stage.start !== null) return Promise.resolve(null);

        var openedPromise;
        if (job.finishingId) {
            openedPromise = Promise.resolve(null);
        } else {
            openedPromise = callApi('startFinishingJob', {
                itemCheckId: job.id,
                staffName: job.selectedOperator || SELECTED_OPERATOR
            }).then(function (res) {
                job.finishingId = res.finishingId;
                job.status = 'In_Progress';
            });
        }

        return openedPromise.then(function () {
            return callApi('saveFinishingStage', {
                finishingId: job.finishingId,
                stage: stageName,
                event: 'start'
            }).then(function (res) {
                stage.start = res.time;
            });
        });
    });

    Promise.all(promises).then(function () {
        setStageBusy(false);
        renderQueue();
    }).catch(function (err) {
        setStageBusy(false);
        alert('Could not record the start of ' + stageName + ':\n\n' + (err && err.message ? err.message : err));
        loadQueue();
    });
}

function completeStage(stageName) {
    var combined = activeJob();
    if (!combined || STAGE_BUSY) return;

    var group = combined.jobs;
    var index = STAGE_NAMES.indexOf(stageName);
    var isLast = (index === STAGE_NAMES.length - 1);

    if (!isRunningInCreator()) {
        group.forEach(function (j) {
            var stg = j.stages[stageName];
            stg.end = '10:20:00';
            stg.duration = getDurationFromTimes(stg.start, stg.end);
        });
        if (isLast) {
            var ids = group.map(function (j) { return j.id; });
            JOBS_QUEUE = JOBS_QUEUE.filter(function (j) { return ids.indexOf(j.id) === -1; });
            ACTIVE_JOB_ID = null;
        } else {
            ACTIVE_STAGE = index + 1;
        }
        renderQueue();
        return;
    }

    for (var i = 0; i < group.length; i++) {
        if (!group[i].finishingId) {
            alert('One or more jobs were never opened on the server. Refresh and start again.');
            loadQueue();
            return;
        }
    }

    setStageBusy(true);

    if (!isLast) {
        var promises = group.map(function (job) {
            var stage = job.stages[stageName];
            if (!stage || stage.start === null || stage.end !== null) return Promise.resolve(null);
            
            return callApi('saveFinishingStage', {
                finishingId: job.finishingId,
                stage: stageName,
                event: 'end'
            }).then(function (res) {
                stage.end = res.time;
                stage.duration = getDurationFromTimes(stage.start, stage.end);
            });
        });

        Promise.all(promises).then(function () {
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

    var promises = group.map(function (job) {
        return callApi('completeFinishingJob', { finishingId: job.finishingId });
    });

    Promise.all(promises).then(function () {
        alert(combined.itemName + ' (' + combined.qty + ' pcs total) finished.');
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
        return Promise.resolve();
    }

    if (container) container.innerHTML = '<div class="fin-hint">Loading&hellip;</div>';

    return callApi('getFinishingHistory', { supervisorId: SELECTED_SUP }).then(function (parsed) {
        COMPLETED_HISTORY = parsed.history || [];
        HISTORY_LOADED = true;
        renderHistory();
    }).catch(function (err) {
        console.error('getFinishingHistory failed:', err);
        if (container) container.innerHTML = '<div class="fin-hint is-bad">' + escapeHtml(err.message) + '</div>';
        throw err;
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
            '<td class="col-num">' + fmtDuration(st.pressing ? st.pressing.duration : null) + '</td>' +
            '<td class="col-num">' + fmtDuration(st.folding ? st.folding.duration : null) + '</td>' +
            '<td class="col-num">' + fmtDuration(st.branding ? st.branding.duration : null) + '</td>' +
            '<td>' + escapeHtml(run.completedOn || '—') + '</td>' +
            '</tr>';
    }).join('');

    container.innerHTML = '<div class="fin-scroll"><table class="fin-tbl">' +
        '<thead><tr><th>Item</th><th class="col-num">Pcs</th><th>Order</th><th>Finished by</th>' +
        '<th class="col-num">Pressing</th><th class="col-num">Folding</th><th class="col-num">Branding</th>' +
        '<th>Completed</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>';
}
