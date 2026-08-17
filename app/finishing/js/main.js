// Finishing Workflow Controller - Timestamp Edition

var DEMO_MODE = true; // Set to true to use mock queue/history data for lead presentation, while keeping live employee loading!

var ACTIVE_JOB = null;
var ACTIVE_STAGE = 0; // 0 = Folding, 1 = Pressing, 2 = Branding
var STAGE_NAMES = ['folding', 'pressing', 'branding'];
var STAGE_LABELS = ['Folding', 'Pressing', 'Branding'];

var SELECTED_STAFF = 'Abhijay'; // Default staff

// Queue of items that have passed the checking stage
var JOBS_QUEUE = [];

// Completed history
var COMPLETED_HISTORY = [];

function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

function fmtDuration(seconds) {
    if (seconds === null || seconds === undefined) return '—';
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    if (m === 0) return s + 's';
    return m + 'm ' + s + 's';
}

function formatTime(timestamp) {
    if (!timestamp) return '—';
    var date = new Date(timestamp);
    var hrs = date.getHours();
    var mins = date.getMinutes();
    var secs = date.getSeconds();
    
    // Formatting as standard HH:MM:SS (24-hour style)
    return (hrs < 10 ? '0' : '') + hrs + ':' + 
           (mins < 10 ? '0' : '') + mins + ':' + 
           (secs < 10 ? '0' : '') + secs;
}

function renderQueue() {
    var queueContainer = document.getElementById('queue-list');
    if (!queueContainer) return;

    if (JOBS_QUEUE.length === 0) {
        queueContainer.innerHTML = '<div class="empty-state" style="padding: 2rem 1rem;"><div class="icon">🧵</div><p>No items remaining in the queue</p></div>';
        return;
    }

    queueContainer.innerHTML = JOBS_QUEUE.map(function (job) {
        var activeClass = (ACTIVE_JOB && ACTIVE_JOB.id === job.id) ? ' active' : '';
        
        // Find current stage based on which stages are not completed yet
        var currentStageName = "Ready to start";
        var progressBadgeClass = "pill-so-status so-pending";
        
        for (var i = 0; i < STAGE_NAMES.length; i++) {
            var stg = job.stages[STAGE_NAMES[i]];
            if (!stg || stg.end === null) {
                currentStageName = STAGE_LABELS[i];
                if (i > 0 || (stg && stg.start !== null)) {
                    progressBadgeClass = "pill-so-status so-progress";
                }
                break;
            }
        }

        return '<div class="queue-card' + activeClass + '" onclick="selectJob(\'' + escapeHtml(job.id) + '\')">' +
            '<div class="queue-header">' +
                '<span class="queue-so">' + escapeHtml(job.salesOrder) + '</span>' +
                '<span class="queue-plan">' + escapeHtml(job.planNo) + '</span>' +
            '</div>' +
            '<div class="queue-item-name">' + escapeHtml(job.itemName) + '</div>' +
            '<div class="queue-footer">' +
                '<span style="font-size: 11px; color: var(--text-muted);">Qty: <strong>' + job.qty + '</strong></span>' +
                '<span class="' + progressBadgeClass + '" style="font-size: 10px; margin: 0; padding: 1px 6px;">' + escapeHtml(currentStageName) + '</span>' +
            '</div>' +
            '</div>';
    }).join('');
}

function renderActiveJob() {
    var panel = document.getElementById('active-tracker-panel');
    if (!panel) return;

    if (!ACTIVE_JOB) {
        panel.innerHTML = '<div class="empty-state" style="padding: 6rem 2rem;">' +
            '<div class="icon">📥</div>' +
            '<h2>No active job selected</h2>' +
            '<p>Choose a checked item from the queue list on the left to start finishing.</p>' +
            '</div>';
        return;
    }

    // Build Stepper progress bar width
    var progressPercent = (ACTIVE_STAGE / (STAGE_NAMES.length - 1)) * 100;

    var stepperHtml = '<div class="stepper-container">' +
        '<div class="stepper">' +
            '<div class="stepper-progress" style="width: ' + progressPercent + '%;"></div>';

    for (var i = 0; i < STAGE_LABELS.length; i++) {
        var stepClass = 'step';
        var stepData = ACTIVE_JOB.stages[STAGE_NAMES[i]];
        
        if (i < ACTIVE_STAGE) {
            stepClass += ' completed';
        } else if (i === ACTIVE_STAGE) {
            stepClass += ' active';
        } else {
            stepClass += ' pending';
        }

        var labelSub = '';
        if (stepData && stepData.start !== null && stepData.end === null) {
            labelSub = '<span class="step-lbl-sub">Started</span>';
        } else if (stepData && stepData.end !== null) {
            labelSub = '<span class="step-lbl-sub">' + fmtDuration(stepData.duration) + '</span>';
        }

        stepperHtml += '<div class="' + stepClass + '">' +
            '<div class="step-circle">' + (i < ACTIVE_STAGE ? '✓' : (i + 1)) + '</div>' +
            '<span class="step-label">' + STAGE_LABELS[i] + '</span>' +
            labelSub +
            '</div>';
    }
    stepperHtml += '</div></div>';

    // Build Stage Cards
    var stagesHtml = STAGE_NAMES.map(function (stageName, index) {
        var stageLabel = STAGE_LABELS[index];
        var stageData = ACTIVE_JOB.stages[stageName];
        
        var cardClass = 'stage-card';
        var statusIcon = '';
        var statusText = '';
        var timeInfoHtml = '';
        var actionBtnHtml = '';

        if (index < ACTIVE_STAGE) {
            // Completed stage
            cardClass += ' stage-completed';
            statusIcon = '<span class="stage-status-icon success">✓</span>';
            statusText = 'Completed';
            timeInfoHtml = '<div class="stage-timestamps">' +
                '<span><b>Start:</b> ' + formatTime(stageData.start) + '</span>' +
                '<span class="ts-separator">·</span>' +
                '<span><b>End:</b> ' + formatTime(stageData.end) + '</span>' +
                '<span class="ts-separator">·</span>' +
                '<span class="duration-badge">Duration: ' + fmtDuration(stageData.duration) + '</span>' +
                '</div>';
        } else if (index === ACTIVE_STAGE) {
            // Active stage
            cardClass += ' stage-active';
            statusIcon = '<span class="stage-status-icon active-pulse">⚙</span>';
            statusText = 'In Progress';
            
            if (stageData.start === null) {
                statusText = 'Ready to Start';
                timeInfoHtml = '<div class="stage-timestamps muted">Click Start to record beginning timestamp</div>';
                actionBtnHtml = '<button type="button" class="btn-stage-action start" onclick="startStage(\'' + stageName + '\')">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>' +
                    'Start ' + stageLabel +
                    '</button>';
            } else {
                timeInfoHtml = '<div class="stage-timestamps">' +
                    '<span class="pulsing-text"><b>Started at:</b> ' + formatTime(stageData.start) + '</span>' +
                    '</div>';
                actionBtnHtml = '<button type="button" class="btn-stage-action complete" onclick="completeStage(\'' + stageName + '\')">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>' +
                    'Complete ' + stageLabel +
                    '</button>';
            }
        } else {
            // Pending stage
            cardClass += ' stage-pending';
            statusIcon = '<span class="stage-status-icon pending">○</span>';
            statusText = 'Pending';
            timeInfoHtml = '<div class="stage-timestamps muted">Waiting for previous stage</div>';
        }

        return '<div class="' + cardClass + '">' +
            '<div class="stage-card-left">' +
                statusIcon +
                '<div class="stage-details">' +
                    '<div class="stage-header-row">' +
                        '<span class="stage-name">' + stageLabel + '</span>' +
                        '<span class="stage-badge-status ' + statusText.toLowerCase().replace(/\s+/g, '-') + '">' + statusText + '</span>' +
                    '</div>' +
                    timeInfoHtml +
                '</div>' +
            '</div>' +
            '<div class="stage-card-right">' +
                actionBtnHtml +
            '</div>' +
            '</div>';
    }).join('');

    panel.innerHTML = '<div class="tracker-panel-modern">' +
        '<div class="tracker-header-modern">' +
            '<div style="display: flex; flex-direction: column; gap: 4px; width: 100%;">' +
                '<div style="font-size: 11px; color: var(--primary); font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;">Active Job Tracking</div>' +
                '<h2 class="active-item-title">' + escapeHtml(ACTIVE_JOB.itemName) + '</h2>' +
                '<div class="active-item-meta">' +
                    '<span class="meta-pill">SO: ' + escapeHtml(ACTIVE_JOB.salesOrder) + '</span>' +
                    '<span class="meta-pill">Plan: ' + escapeHtml(ACTIVE_JOB.planNo) + '</span>' +
                    '<span class="meta-pill qty">Qty: <b>' + ACTIVE_JOB.qty + '</b></span>' +
                '</div>' +
            '</div>' +
        '</div>' +
        stepperHtml +
        '<div class="stages-list-container">' +
            stagesHtml +
        '</div>' +
        '</div>';
}

function renderHistory() {
    var el = document.getElementById('history-list');
    if (!el) return;

    if (COMPLETED_HISTORY.length === 0) {
        el.innerHTML = '<tr><td colspan="8" class="c muted" style="padding: 2rem;">No items completed in this session</td></tr>';
        return;
    }

    el.innerHTML = COMPLETED_HISTORY.slice().reverse().map(function (job) {
        var foldDetail = job.stages.folding;
        var pressDetail = job.stages.pressing;
        var brandDetail = job.stages.branding;

        return '<tr>' +
            '<td>' +
                '<strong>' + escapeHtml(job.salesOrder) + '</strong>' +
                '<div class="emp-sub">' + escapeHtml(job.planNo) + '</div>' +
            '</td>' +
            '<td>' + escapeHtml(job.itemName) + '</td>' +
            '<td class="r"><strong>' + job.qty + '</strong></td>' +
            '<td>' + escapeHtml(job.staff) + '</td>' +
            '<td class="r" style="font-variant-numeric: tabular-nums;">' +
                '<div class="duration-val">' + fmtDuration(foldDetail ? foldDetail.duration : null) + '</div>' +
                (foldDetail && foldDetail.start ? '<div class="timestamp-sub">' + formatTime(foldDetail.start) + ' - ' + formatTime(foldDetail.end) + '</div>' : '') +
            '</td>' +
            '<td class="r" style="font-variant-numeric: tabular-nums;">' +
                '<div class="duration-val">' + fmtDuration(pressDetail ? pressDetail.duration : null) + '</div>' +
                (pressDetail && pressDetail.start ? '<div class="timestamp-sub">' + formatTime(pressDetail.start) + ' - ' + formatTime(pressDetail.end) + '</div>' : '') +
            '</td>' +
            '<td class="r" style="font-variant-numeric: tabular-nums;">' +
                '<div class="duration-val">' + fmtDuration(brandDetail ? brandDetail.duration : null) + '</div>' +
                (brandDetail && brandDetail.start ? '<div class="timestamp-sub">' + formatTime(brandDetail.start) + ' - ' + formatTime(brandDetail.end) + '</div>' : '') +
            '</td>' +
            '<td>' + escapeHtml(job.completedOn) + '</td>' +
            '</tr>';
    }).join('');
}

function selectJob(jobId) {
    // If a job is active and has started some stage, verify if they want to discard
    var anyStarted = false;
    if (ACTIVE_JOB) {
        for (var i = 0; i < STAGE_NAMES.length; i++) {
            var stg = ACTIVE_JOB.stages[STAGE_NAMES[i]];
            if (stg && stg.start !== null && stg.end === null) {
                anyStarted = true;
                break;
            }
        }
    }

    if (anyStarted) {
        var leave = confirm("Work has already started for the active job. Switching jobs will lose your current time progress. Do you want to switch?");
        if (!leave) return;
    }

    var job = null;
    for (var i = 0; i < JOBS_QUEUE.length; i++) {
        if (JOBS_QUEUE[i].id === jobId) {
            job = JOBS_QUEUE[i];
            break;
        }
    }

    if (!job) return;
    ACTIVE_JOB = job;
    
    // Find where the operator left off in the stages
    ACTIVE_STAGE = 0;
    for (var i = 0; i < STAGE_NAMES.length; i++) {
        if (job.stages[STAGE_NAMES[i]].end === null) {
            ACTIVE_STAGE = i;
            break;
        }
    }

    renderQueue();
    renderActiveJob();
}

function startStage(stageName) {
    if (!ACTIVE_JOB) return;
    
    // Set start time
    ACTIVE_JOB.stages[stageName].start = Date.now();
    
    renderActiveJob();
    renderQueue();
}

function completeStage(stageName) {
    if (!ACTIVE_JOB) return;
    
    var stageData = ACTIVE_JOB.stages[stageName];
    if (!stageData || stageData.start === null) return;
    
    stageData.end = Date.now();
    stageData.duration = Math.floor((stageData.end - stageData.start) / 1000);
    
    // Check if it is the last stage
    if (ACTIVE_STAGE < STAGE_NAMES.length - 1) {
        ACTIVE_STAGE++;
        renderActiveJob();
        renderQueue();
    } else {
        // Complete the entire finishing job!
        var now = new Date();
        var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        var completedTimestamp = now.getDate() + '-' + months[now.getMonth()] + '-' + now.getFullYear() + ' ' + 
            (now.getHours() < 10 ? '0' : '') + now.getHours() + ':' + (now.getMinutes() < 10 ? '0' : '') + now.getMinutes();

        var completedItem = {
            id: ACTIVE_JOB.id,
            salesOrder: ACTIVE_JOB.salesOrder,
            planNo: ACTIVE_JOB.planNo,
            itemName: ACTIVE_JOB.itemName,
            qty: ACTIVE_JOB.qty,
            staff: SELECTED_STAFF,
            completedOn: completedTimestamp,
            stages: {
                folding: { ...ACTIVE_JOB.stages.folding },
                pressing: { ...ACTIVE_JOB.stages.pressing },
                branding: { ...ACTIVE_JOB.stages.branding }
            }
        };

        // Submit to Zoho Creator
        if (isRunningInCreator() && !DEMO_MODE) {
            var panel = document.getElementById('active-tracker-panel');
            if (panel) {
                panel.innerHTML = '<div class="empty-state" style="padding: 6rem 2rem;">' +
                    '<div class="icon active-spin">⚙</div>' +
                    '<h2>Saving finishing logs...</h2>' +
                    '<p>Logging timestamps to Zoho Creator database.</p>' +
                    '</div>';
            }

            ZOHO.CREATOR.DATA.invokeCustomApi({
                api_name: 'completeFinishingJob',
                http_method: 'POST',
                payload: {
                    payloadJson: JSON.stringify({
                        planItemId: ACTIVE_JOB.id,
                        staffName: SELECTED_STAFF,
                        foldingDuration: ACTIVE_JOB.stages.folding.duration,
                        pressingDuration: ACTIVE_JOB.stages.pressing.duration,
                        brandingDuration: ACTIVE_JOB.stages.branding.duration
                    })
                }
            }).then(function (response) {
                var parsed;
                try {
                    parsed = JSON.parse(response.result);
                } catch (e) {
                    parsed = null;
                }

                if (parsed && parsed.success) {
                    alert('Success! ' + ACTIVE_JOB.itemName + ' has been fully finished and logged to Zoho Creator.');
                    ACTIVE_JOB = null;
                    ACTIVE_STAGE = 0;
                    loadFinishingQueue();
                    loadFinishingHistory();
                } else {
                    alert('Failed to log to Zoho Creator: ' + ((parsed && parsed.error) || 'unknown error'));
                    renderActiveJob();
                }
            }).catch(function (err) {
                console.error('completeFinishingJob error:', err);
                alert('Connection failure while saving logs.');
                renderActiveJob();
            });
        } else {
            // Fallback for local testing and Demo Mode
            COMPLETED_HISTORY.push(completedItem);
            JOBS_QUEUE = JOBS_QUEUE.filter(function (x) { return x.id !== ACTIVE_JOB.id; });
            alert('Success! ' + ACTIVE_JOB.itemName + ' has been fully finished (local prototype save).');
            ACTIVE_JOB = null;
            ACTIVE_STAGE = 0;
            renderQueue();
            renderActiveJob();
            renderHistory();
        }
    }
}

function isRunningInCreator() {
    return (window.self !== window.top) && (typeof ZOHO !== 'undefined' && ZOHO.CREATOR);
}

function loadStaffDropdown() {
    if (!isRunningInCreator()) {
        console.log("Running outside Zoho Creator.");
        return;
    }

    var select = document.getElementById('staff-select-el');

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getStorePackingStaff',
        http_method: 'POST',
        payload: {
            payloadJson: ""
        }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('getStorePackingStaff parse failed:', e, response.result);
            if (select) select.innerHTML = '<option value="">Err: Parse failed</option>';
            return;
        }

        if (parsed.errors && parsed.errors.length > 0) {
            console.error('getStorePackingStaff error:', parsed.errors);
            if (select) select.innerHTML = '<option value="">Err: ' + escapeHtml(parsed.errors.join(', ')) + '</option>';
            return;
        }

        var staff = parsed.staff || [];
        console.log('Successfully fetched packing staff from Employee Master:', staff);
        if (staff.length > 0) {
            if (select) {
                // Populate options dynamically
                var optionsHtml = staff.map(function (emp) {
                    return '<option value="' + escapeHtml(emp.name) + '">' + escapeHtml(emp.name) + '</option>';
                }).join('');
                select.innerHTML = optionsHtml;
                SELECTED_STAFF = select.value;
            }
        } else {
            if (select) select.innerHTML = '<option value="">No packing staff found</option>';
        }
    }).catch(function (err) {
        console.error('Failed to load dynamic staff list:', err);
        var errStr = String(err && err.message ? err.message : err);
        if (select) select.innerHTML = '<option value="">Err: ' + escapeHtml(errStr) + '</option>';
    });
}

function loadFinishingQueue() {
    if (DEMO_MODE || !isRunningInCreator()) {
        console.log("Using mock queue data for demonstration.");
        JOBS_QUEUE = [
            {
                id: "JOB-001",
                salesOrder: "SO-2026-9811",
                planNo: "PLAN-FL-403",
                itemName: "Linen Olive Flat Sheet (Queen)",
                qty: 150,
                status: "Pending",
                stages: {
                    folding: { start: null, end: null, duration: null },
                    pressing: { start: null, end: null, duration: null },
                    branding: { start: null, end: null, duration: null }
                }
            },
            {
                id: "JOB-002",
                salesOrder: "SO-2026-9812",
                planNo: "PLAN-FL-404",
                itemName: "Cotton White Duvet Cover (King)",
                qty: 80,
                status: "Pending",
                stages: {
                    folding: { start: null, end: null, duration: null },
                    pressing: { start: null, end: null, duration: null },
                    branding: { start: null, end: null, duration: null }
                }
            }
        ];
        renderQueue();
        renderActiveJob();
        return;
    }

    var queueContainer = document.getElementById('queue-list');

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getFinishingQueue',
        http_method: 'POST',
        payload: {}
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('getFinishingQueue parse failed:', e, response.result);
            if (queueContainer) queueContainer.innerHTML = '<div class="error-state" style="color:var(--text-danger); padding:10px;">Parse failed</div>';
            return;
        }

        if (parsed.errors && parsed.errors.length > 0) {
            console.error('getFinishingQueue error:', parsed.errors);
            if (queueContainer) queueContainer.innerHTML = '<div class="error-state" style="color:var(--text-danger); padding:10px;">' + escapeHtml(parsed.errors.join(', ')) + '</div>';
            return;
        }

        JOBS_QUEUE = parsed.queue || [];
        renderQueue();
        if (ACTIVE_JOB) {
            // Find active job in new queue to keep it synced
            var found = false;
            for (var i = 0; i < JOBS_QUEUE.length; i++) {
                if (JOBS_QUEUE[i].id === ACTIVE_JOB.id) {
                    ACTIVE_JOB = JOBS_QUEUE[i];
                    found = true;
                    break;
                }
            }
            if (!found) {
                ACTIVE_JOB = null;
                ACTIVE_STAGE = 0;
            }
        }
        renderActiveJob();
    }).catch(function (err) {
        console.error('Failed to load finishing queue:', err);
        var errStr = String(err && err.message ? err.message : err);
        if (queueContainer) queueContainer.innerHTML = '<div class="error-state" style="color:var(--text-danger); padding:10px;">Err: ' + escapeHtml(errStr) + '</div>';
    });
}

function loadFinishingHistory() {
    if (DEMO_MODE || !isRunningInCreator()) {
        console.log("Using mock history data for demonstration.");
        COMPLETED_HISTORY = [
            {
                id: "JOB-099",
                salesOrder: "SO-2026-9800",
                planNo: "PLAN-FL-395",
                itemName: "Linen Blush Fitted Sheet (Queen)",
                qty: 100,
                staff: SELECTED_STAFF,
                completedOn: "14-Aug-2026 13:10",
                stages: {
                    folding: { duration: 75 },
                    pressing: { duration: 120 },
                    branding: { duration: 45 }
                }
            }
        ];
        renderHistory();
        return;
    }

    var historyContainer = document.getElementById('history-list');

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getFinishingHistory',
        http_method: 'POST',
        payload: {}
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('getFinishingHistory parse failed:', e, response.result);
            if (historyContainer) historyContainer.innerHTML = '<tr><td colspan="8" style="color:var(--text-danger); text-align:center;">Parse failed</td></tr>';
            return;
        }

        if (parsed.errors && parsed.errors.length > 0) {
            console.error('getFinishingHistory error:', parsed.errors);
            if (historyContainer) historyContainer.innerHTML = '<tr><td colspan="8" style="color:var(--text-danger); text-align:center;">' + escapeHtml(parsed.errors.join(', ')) + '</td></tr>';
            return;
        }

        COMPLETED_HISTORY = parsed.history || [];
        renderHistory();
    }).catch(function (err) {
        console.error('Failed to load finishing history:', err);
        var errStr = String(err && err.message ? err.message : err);
        if (historyContainer) historyContainer.innerHTML = '<tr><td colspan="8" style="color:var(--text-danger); text-align:center;">Err: ' + escapeHtml(errStr) + '</td></tr>';
    });
}

document.addEventListener('DOMContentLoaded', function () {
    // Setup staff selection listener
    var select = document.getElementById('staff-select-el');
    if (select) {
        SELECTED_STAFF = select.value;
        select.addEventListener('change', function () {
            SELECTED_STAFF = select.value;
        });
    }

    // Call load functions with a small delay to allow SDK handshake to finish
    setTimeout(function () {
        loadStaffDropdown();
        loadFinishingQueue();
        loadFinishingHistory();
    }, 100);

    renderQueue();
    renderActiveJob();
    renderHistory();
});
