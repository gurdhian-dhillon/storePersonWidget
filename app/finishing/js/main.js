// Finishing Workflow Controller - Timestamp Edition

var DEMO_MODE = false; // Set to true to use mock queue/history data for lead presentation, while keeping live employee loading!

var ACTIVE_JOB = null;
var ACTIVE_STAGE = 0; // 0 = Folding, 1 = Pressing, 2 = Branding
var STAGE_NAMES = ['folding', 'pressing', 'branding'];
var STAGE_LABELS = ['Folding', 'Pressing', 'Branding'];

var SELECTED_STAFF = 'Abhijay'; // Default staff
var SELECTED_OPERATOR = ''; // Default operator
var OPERATORS_LIST = [];

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
    if (typeof timestamp === 'string' && timestamp.indexOf(':') !== -1) {
        var parts = timestamp.split(':');
        if (parts.length === 2) {
            return timestamp + ':00';
        }
        return timestamp;
    }
    var date = new Date(timestamp);
    var hrs = date.getHours();
    var mins = date.getMinutes();
    var secs = date.getSeconds();
    
    // Formatting as standard HH:MM:SS (24-hour style)
    return (hrs < 10 ? '0' : '') + hrs + ':' + 
           (mins < 10 ? '0' : '') + mins + ':' + 
           (secs < 10 ? '0' : '') + secs;
}

function formatTimeForDeluge(timestamp) {
    if (!timestamp) return '';
    var d = new Date(timestamp);
    var hh = d.getHours();
    var min = d.getMinutes();
    var ss = d.getSeconds();

    return (hh < 10 ? '0' : '') + hh + ':' + 
           (min < 10 ? '0' : '') + min + ':' + 
           (ss < 10 ? '0' : '') + ss;
}

function formatDateTimeForDeluge(timestamp) {
    if (!timestamp) return '';
    var d = new Date(timestamp);
    var yyyy = d.getFullYear();
    var mm = d.getMonth() + 1;
    var dd = d.getDate();
    var hh = d.getHours();
    var min = d.getMinutes();
    var ss = d.getSeconds();

    return yyyy + '-' + 
           (mm < 10 ? '0' : '') + mm + '-' + 
           (dd < 10 ? '0' : '') + dd + ' ' + 
           (hh < 10 ? '0' : '') + hh + ':' + 
           (min < 10 ? '0' : '') + min + ':' + 
           (ss < 10 ? '0' : '') + ss;
}

function getDurationFromTimes(startStr, endStr) {
    if (!startStr || !endStr) return null;
    if (typeof startStr !== 'string' || typeof endStr !== 'string') return null;
    
    var sParts = startStr.split(':');
    var eParts = endStr.split(':');
    if (sParts.length < 2 || eParts.length < 2) return null;
    
    var sSecs = parseInt(sParts[0], 10) * 3600 + parseInt(sParts[1], 10) * 60 + (sParts[2] ? parseInt(sParts[2], 10) : 0);
    var eSecs = parseInt(eParts[0], 10) * 3600 + parseInt(eParts[1], 10) * 60 + (eParts[2] ? parseInt(eParts[2], 10) : 0);
    
    var diff = eSecs - sSecs;
    if (diff < 0) {
        diff += 24 * 3600;
    }
    return diff;
}

function renderQueue() {
    var queueContainer = document.getElementById('queue-list');
    if (!queueContainer) return;

    if (JOBS_QUEUE.length === 0) {
        queueContainer.innerHTML = '<div class="empty-state" style="padding: 2rem 1rem;"><div class="icon">🧵</div><p>No items remaining in the queue</p></div>';
        renderPlanSummary();
        return;
    }

    queueContainer.innerHTML = JOBS_QUEUE.map(function (job) {
        var isActive = (ACTIVE_JOB && ACTIVE_JOB.id === job.id);
        var activeClass = isActive ? ' active' : '';
        
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

        var isAlt = false;
        if (job.rounds) {
            for (var r = 0; r < job.rounds.length; r++) {
                if (job.rounds[r] > 1) {
                    isAlt = true;
                    break;
                }
            }
        }
        var altPillHtml = isAlt ? '<span class="meta-pill" style="margin: 0; background: #ffe4e6; color: #e11d48; font-weight: 600; font-size: 0.75rem; padding: 2px 8px; border-radius: 4px;">Alteration batch</span>' : '';

        // Render the card (using full-width layout)
        var html = '<div class="queue-card' + activeClass + '" style="padding: 1.25rem; background: var(--surface); border: 1px solid ' + (isActive ? 'var(--primary)' : 'var(--border)') + '; border-radius: var(--radius); cursor: pointer; display: flex; flex-direction: column; gap: 0.75rem; transition: all 0.2s ease;' + (isActive ? 'box-shadow: 0 4px 12px rgba(37, 99, 235, 0.08); background-color: #f8fafc;' : '') + '" onclick="selectJob(\'' + escapeHtml(job.id) + '\')">' +
            '<div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">' +
                '<div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">' +
                    '<span class="queue-item-name" style="font-size: 1.05rem; font-weight: 700; color: var(--text-main);">' + escapeHtml(job.itemName) + '</span>' +
                    (job.sku ? '<span style="font-size: 10px; font-weight: 700; background: #e2e8f0; color: #475569; padding: 2px 6px; border-radius: 4px; font-family: monospace;">' + escapeHtml(job.sku) + '</span>' : '') +
                '</div>' +
                '<div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">' +
                    '<span style="font-size: 11px; font-weight: 600; background: rgba(37, 99, 235, 0.08); color: var(--primary); padding: 2px 8px; border-radius: 4px;">' + job.qty + ' pc to produce</span>' +
                    '<span style="font-size: 11px; font-weight: 600; background: #f1f5f9; color: var(--text-muted); padding: 2px 8px; border-radius: 4px;">Rnds: ' + escapeHtml(job.roundText || '1') + '</span>' +
                    altPillHtml +
                '</div>' +
            '</div>';

        if (isActive) {
            var opSelectorHtml = '<div class="operator-selector-container" style="display: flex; flex-direction: column; gap: 6px; max-width: 320px; margin-bottom: 0.5rem;">' +
                '<span style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.03em;">Assign Operator for Work</span>' +
                '<select class="staff-select" id="active-operator-select-el" style="width: 100%; font-weight: 600;" onchange="onOperatorChanged()">' +
                    getOperatorsOptionsHtml() +
                '</select>' +
                '</div>';

            // Expand the active tracker panel inside this card
            html += '<div class="active-tracker-inline" style="border-top: 1px solid var(--border); margin-top: 0.75rem; padding-top: 1.25rem; display: flex; flex-direction: column; gap: 1.25rem;" onclick="event.stopPropagation();">' +
                opSelectorHtml +
                getStepperHtml(job) +
                '<div class="stages-list-container" style="display: flex; flex-direction: column; gap: 0.75rem;">' +
                    getStagesHtml(job) +
                '</div>' +
                '</div>';
        } else {
            // Unselected footer
            html += '<div class="queue-footer" style="margin-top: 4px; padding-top: 6px; border-top: 1px solid #f8fafc;">' +
                '<span style="font-size: 11px; color: var(--text-muted); font-style: italic;">Click to select and start finishing tracking</span>' +
                '<span class="' + progressBadgeClass + '" style="font-size: 10px; margin: 0; padding: 1px 6px;">' + escapeHtml(currentStageName) + '</span>' +
                '</div>';
        }

        html += '</div>';
        return html;
    }).join('');

    renderPlanSummary();
}

function renderActiveJob() {
    renderQueue();
}

function getStepperHtml(job) {
    var progressPercent = (ACTIVE_STAGE / (STAGE_NAMES.length - 1)) * 100;

    var stepperHtml = '<div class="stepper-container" style="margin-bottom: 0.5rem;">' +
        '<div class="stepper">' +
            '<div class="stepper-progress" style="width: ' + progressPercent + '%;"></div>';

    for (var i = 0; i < STAGE_LABELS.length; i++) {
        var stepClass = 'step';
        var stepData = job.stages[STAGE_NAMES[i]];
        
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
    return stepperHtml;
}

function getStagesHtml(job) {
    return STAGE_NAMES.map(function (stageName, index) {
        var stageLabel = STAGE_LABELS[index];
        var stageData = job.stages[stageName];
        
        var cardClass = 'stage-card';
        var statusIcon = '';
        var statusText = '';
        var timeInfoHtml = '';
        var actionBtnHtml = '';

        if (index < ACTIVE_STAGE) {
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

        var foldDur = (foldDetail && foldDetail.duration !== undefined && foldDetail.duration !== null) ? foldDetail.duration : (foldDetail ? getDurationFromTimes(foldDetail.start, foldDetail.end) : null);
        var pressDur = (pressDetail && pressDetail.duration !== undefined && pressDetail.duration !== null) ? pressDetail.duration : (pressDetail ? getDurationFromTimes(pressDetail.start, pressDetail.end) : null);
        var brandDur = (brandDetail && brandDetail.duration !== undefined && brandDetail.duration !== null) ? brandDetail.duration : (brandDetail ? getDurationFromTimes(brandDetail.start, brandDetail.end) : null);

        return '<tr>' +
            '<td>' +
                '<strong>' + escapeHtml(job.salesOrder) + '</strong>' +
                '<div class="emp-sub">' + escapeHtml(job.planNo) + '</div>' +
            '</td>' +
            '<td>' + escapeHtml(job.itemName) + '</td>' +
            '<td class="r"><strong>' + job.qty + '</strong></td>' +
            '<td>' + escapeHtml(job.staff) + '</td>' +
            '<td class="r" style="font-variant-numeric: tabular-nums;">' +
                '<div class="duration-val">' + fmtDuration(foldDur) + '</div>' +
                (foldDetail && foldDetail.start ? '<div class="timestamp-sub">' + formatTime(foldDetail.start) + ' - ' + formatTime(foldDetail.end) + '</div>' : '') +
            '</td>' +
            '<td class="r" style="font-variant-numeric: tabular-nums;">' +
                '<div class="duration-val">' + fmtDuration(pressDur) + '</div>' +
                (pressDetail && pressDetail.start ? '<div class="timestamp-sub">' + formatTime(pressDetail.start) + ' - ' + formatTime(pressDetail.end) + '</div>' : '') +
            '</td>' +
            '<td class="r" style="font-variant-numeric: tabular-nums;">' +
                '<div class="duration-val">' + fmtDuration(brandDur) + '</div>' +
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
    if (!ACTIVE_JOB.selectedOperator && OPERATORS_LIST.length > 0) {
        ACTIVE_JOB.selectedOperator = OPERATORS_LIST[0].name;
    }
    
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
            staff: ACTIVE_JOB.selectedOperator || SELECTED_STAFF,
            completedOn: completedTimestamp,
            stages: {
                folding: { ...ACTIVE_JOB.stages.folding },
                pressing: { ...ACTIVE_JOB.stages.pressing },
                branding: { ...ACTIVE_JOB.stages.branding }
            }
        };

        // Submit to Zoho Creator
        if (isRunningInCreator() && !DEMO_MODE) {
            var activeCard = document.querySelector('.queue-card.active');
            if (activeCard) {
                var trackerInline = activeCard.querySelector('.active-tracker-inline');
                if (trackerInline) {
                    trackerInline.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--text-muted);">' +
                        '<div class="icon active-spin" style="font-size: 2rem; margin-bottom: 0.5rem; animation: rotate-gear 2s linear infinite;">⚙</div>' +
                        '<p style="font-weight: 600; margin: 0;">Saving finishing logs...</p>' +
                        '</div>';
                }
            }

            ZOHO.CREATOR.DATA.invokeCustomApi({
                api_name: 'completeFinishingJob',
                http_method: 'POST',
                payload: {
                    payloadJson: JSON.stringify({
                        planItemId: ACTIVE_JOB.planItemId,
                        itemCheckId: ACTIVE_JOB.checkIds.join(','),
                        qty: ACTIVE_JOB.qty,
                        staffName: ACTIVE_JOB.selectedOperator || SELECTED_STAFF,
                        foldingDuration: ACTIVE_JOB.stages.folding.duration,
                        pressingDuration: ACTIVE_JOB.stages.pressing.duration,
                        brandingDuration: ACTIVE_JOB.stages.branding.duration,
                        foldingStart: formatTimeForDeluge(ACTIVE_JOB.stages.folding.start),
                        foldingEnd: formatTimeForDeluge(ACTIVE_JOB.stages.folding.end),
                        pressingStart: formatTimeForDeluge(ACTIVE_JOB.stages.pressing.start),
                        pressingEnd: formatTimeForDeluge(ACTIVE_JOB.stages.pressing.end),
                        brandingStart: formatTimeForDeluge(ACTIVE_JOB.stages.branding.start),
                        brandingEnd: formatTimeForDeluge(ACTIVE_JOB.stages.branding.end),
                        finishingStart: formatDateTimeForDeluge(ACTIVE_JOB.stages.folding.start),
                        finishingEnd: formatDateTimeForDeluge(ACTIVE_JOB.stages.branding.end)
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
                    loadFinishingPlans();
                    var select = document.getElementById('plan-select-el');
                    var selectedPlan = select ? select.value : '';
                    loadFinishingQueue(selectedPlan);
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
        OPERATORS_LIST = [
            { id: "op1", name: "Operator A" },
            { id: "op2", name: "Operator B" },
            { id: "op3", name: "Operator C" }
        ];
        var select = document.getElementById('staff-select-el');
        if (select) {
            select.innerHTML = '<option value="Supervisor X">Supervisor X</option>' +
                               '<option value="Supervisor Y">Supervisor Y</option>';
            SELECTED_STAFF = select.value;
        }
        return;
    }

    var select = document.getElementById('staff-select-el');
    if (!select) return;

    select.innerHTML = '<option value="">Loading supervisors...</option>';

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
            select.innerHTML = '<option value="">Err: Parse failed</option>';
            return;
        }

        if (parsed.errors && parsed.errors.length > 0) {
            console.error('getStorePackingStaff error:', parsed.errors);
            select.innerHTML = '<option value="">Err: ' + escapeHtml(parsed.errors.join(', ')) + '</option>';
            return;
        }

        // Store operators globally
        OPERATORS_LIST = parsed.staff || [];
        console.log('Successfully fetched operators:', OPERATORS_LIST);

        // Populate supervisors dropdown
        var supervisors = parsed.supervisors || [];
        console.log('Successfully fetched supervisors:', supervisors);
        if (supervisors.length > 0) {
            var optionsHtml = supervisors.map(function (emp) {
                return '<option value="' + escapeHtml(emp.name) + '">' + escapeHtml(emp.name) + '</option>';
            }).join('');
            select.innerHTML = optionsHtml;
            SELECTED_STAFF = select.value;
        } else {
            select.innerHTML = '<option value="">No supervisors found</option>';
        }
    }).catch(function (err) {
        console.error('Failed to load dynamic supervisor list:', err);
        var errStr = String(err && err.message ? err.message : err);
        select.innerHTML = '<option value="">Err: ' + escapeHtml(errStr) + '</option>';
    });
}

function loadFinishingQueue(planNo) {
    if (DEMO_MODE || !isRunningInCreator()) {
        console.log("Using mock queue data for demonstration.");
        JOBS_QUEUE = [
            {
                id: "Linen Olive Flat Sheet (Queen)",
                planItemId: "PI-001",
                salesOrder: "SO-2026-9811",
                planNo: "PLAN-FL-403",
                itemName: "Linen Olive Flat Sheet (Queen)",
                sku: "SKU-9811",
                qty: 150,
                checkIds: ["JOB-001"],
                rounds: [1],
                roundText: "1",
                status: "Pending",
                stages: {
                    folding: { start: null, end: null, duration: null },
                    pressing: { start: null, end: null, duration: null },
                    branding: { start: null, end: null, duration: null }
                }
            },
            {
                id: "Cotton White Duvet Cover (King)",
                planItemId: "PI-002",
                salesOrder: "SO-2026-9812",
                planNo: "PLAN-FL-404",
                itemName: "Cotton White Duvet Cover (King)",
                sku: "SKU-9812",
                qty: 80,
                checkIds: ["JOB-002"],
                rounds: [2],
                roundText: "2",
                status: "Pending",
                stages: {
                    folding: { start: null, end: null, duration: null },
                    pressing: { start: null, end: null, duration: null },
                    branding: { start: null, end: null, duration: null }
                }
            }
        ];
        if (planNo) {
            JOBS_QUEUE = JOBS_QUEUE.filter(function (x) { return x.planNo === planNo; });
        }
        renderQueue();
        renderActiveJob();
        return;
    }

    var queueContainer = document.getElementById('queue-list');
    if (!planNo) {
        JOBS_QUEUE = [];
        renderQueue();
        if (queueContainer) {
            queueContainer.innerHTML = '<div class="empty-state" style="padding: 2rem 1rem;"><div class="icon">🔍</div><p>Please select a plan number to load items</p></div>';
        }
        return;
    }

    if (queueContainer) {
        queueContainer.innerHTML = '<div class="empty-state" style="padding: 2rem 1rem;"><div class="icon active-spin">⚙</div><p>Loading items for ' + escapeHtml(planNo) + '...</p></div>';
    }

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getFinishingItems',
        http_method: 'POST',
        payload: {
            planNo: planNo
        }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('getFinishingItems parse failed:', e, response.result);
            if (queueContainer) queueContainer.innerHTML = '<div class="error-state" style="color:var(--text-danger); padding:10px;">Parse failed</div>';
            return;
        }

        if (parsed.errors && parsed.errors.length > 0) {
            console.error('getFinishingItems error:', parsed.errors);
            if (queueContainer) queueContainer.innerHTML = '<div class="error-state" style="color:var(--text-danger); padding:10px;">' + escapeHtml(parsed.errors.join(', ')) + '</div>';
            return;
        }

        var rawQueue = parsed.queue || [];
        
        // Group raw queue by itemName (unique product SKU name in plan)
        var groupedMap = {};
        for (var i = 0; i < rawQueue.length; i++) {
            var item = rawQueue[i];
            var nameKey = item.itemName;
            if (!groupedMap[nameKey]) {
                groupedMap[nameKey] = {
                    id: nameKey,
                    planItemId: item.planItemId,
                    salesOrder: item.salesOrder,
                    planNo: item.planNo,
                    itemName: item.itemName,
                    sku: item.sku || '',
                    qty: 0,
                    checkIds: [],
                    rounds: [],
                    stages: {
                        folding: { start: null, end: null, duration: null },
                        pressing: { start: null, end: null, duration: null },
                        branding: { start: null, end: null, duration: null }
                    }
                };
            }
            groupedMap[nameKey].qty += item.qty;
            groupedMap[nameKey].checkIds.push(item.id);
            groupedMap[nameKey].rounds.push(item.round);
        }
        
        // Convert map back to list
        JOBS_QUEUE = [];
        for (var key in groupedMap) {
            if (groupedMap.hasOwnProperty(key)) {
                var group = groupedMap[key];
                group.rounds.sort(function(a, b){ return a - b; });
                group.roundText = group.rounds.join(', ');
                JOBS_QUEUE.push(group);
            }
        }
        
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

function loadFinishingPlans() {
    if (DEMO_MODE || !isRunningInCreator()) {
        console.log("Using mock plans.");
        var select = document.getElementById('plan-select-el');
        if (select) {
            select.innerHTML = '<option value="">Choose a Plan...</option>' +
                '<option value="PLAN-FL-403">SO-2026-9800 (PLAN-FL-403)</option>' +
                '<option value="PLAN-FL-404">SO-2026-9801 (PLAN-FL-404)</option>';
        }
        return;
    }

    var select = document.getElementById('plan-select-el');
    if (!select) return;

    select.innerHTML = '<option value="">Loading plans...</option>';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getFinishingPlans',
        http_method: 'GET'
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('getFinishingPlans parse failed:', e, response.result);
            select.innerHTML = '<option value="">Err: Parse failed</option>';
            return;
        }

        if (parsed.errors && parsed.errors.length > 0) {
            console.error('getFinishingPlans error:', parsed.errors);
            select.innerHTML = '<option value="">Err: ' + escapeHtml(parsed.errors.join(', ')) + '</option>';
            return;
        }

        var plans = parsed.plans || [];
        console.log('Successfully fetched plans:', plans);
        
        var optionsHtml = '<option value="">Choose a Plan...</option>';
        if (plans.length > 0) {
            optionsHtml += plans.map(function (p) {
                var displayName = p.planNo;
                if (p.salesOrder) {
                    displayName = p.salesOrder + ' (' + p.planNo + ')';
                }
                return '<option value="' + escapeHtml(p.planNo) + '">' + escapeHtml(displayName) + '</option>';
            }).join('');
        } else {
            optionsHtml = '<option value="">No plans pending finishing</option>';
        }
        select.innerHTML = optionsHtml;
    }).catch(function (err) {
        console.error('Failed to load plans:', err);
        var errStr = String(err && err.message ? err.message : err);
        select.innerHTML = '<option value="">Err: ' + escapeHtml(errStr) + '</option>';
    });
}

function onPlanSelected() {
    var select = document.getElementById('plan-select-el');
    var selectedPlan = select ? select.value : '';
    ACTIVE_JOB = null;
    ACTIVE_STAGE = 0;
    loadFinishingQueue(selectedPlan);
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
        http_method: 'GET'
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
    // Setup staff selection listener (Supervisor)
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
        loadFinishingPlans();
        loadFinishingHistory();
    }, 100);

    renderQueue();
    renderActiveJob();
    renderHistory();
});

function renderPlanSummary() {
    var container = document.getElementById('plan-summary-container');
    if (!container) return;

    var select = document.getElementById('plan-select-el');
    var selectedPlan = select ? select.value : '';

    if (!selectedPlan || JOBS_QUEUE.length === 0) {
        container.innerHTML = '';
        return;
    }

    var salesOrder = JOBS_QUEUE[0].salesOrder || 'N/A';
    
    // Count unique items based on item name
    var uniqueItems = {};
    var qtyToFinish = 0;
    for (var i = 0; i < JOBS_QUEUE.length; i++) {
        uniqueItems[JOBS_QUEUE[i].itemName] = true;
        qtyToFinish += JOBS_QUEUE[i].qty;
    }
    var pendingItems = Object.keys(uniqueItems).length;

    // Calculate finished quantity from history for this plan
    var qtyFinished = 0;
    for (var i = 0; i < COMPLETED_HISTORY.length; i++) {
        if (COMPLETED_HISTORY[i].planNo === selectedPlan) {
            qtyFinished += COMPLETED_HISTORY[i].qty;
        }
    }

    var totalApproved = qtyToFinish + qtyFinished;

    // Using plan date or current formatted date
    var planDate = new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });

    container.innerHTML = 
        '<div style="background: #f8fafc; border: 1px solid var(--border); border-radius: var(--radius); padding: 1rem 1.5rem; display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 1.5rem; box-shadow: var(--shadow-sm);">' +
            '<div>' +
                '<span style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--text-muted); display: block; margin-bottom: 4px; letter-spacing: 0.05em;">Sales Order</span>' +
                '<strong style="font-size: 1.1rem; color: var(--text-main); font-weight: 700;">' + escapeHtml(salesOrder) + '</strong>' +
            '</div>' +
            '<div>' +
                '<span style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--text-muted); display: block; margin-bottom: 4px; letter-spacing: 0.05em;">Plan</span>' +
                '<strong style="font-size: 1.1rem; color: var(--text-main); font-family: monospace; font-weight: 700;">' + escapeHtml(selectedPlan) + '</strong>' +
            '</div>' +
            '<div>' +
                '<span style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--text-muted); display: block; margin-bottom: 4px; letter-spacing: 0.05em;">Plan Date</span>' +
                '<strong style="font-size: 1.1rem; color: var(--text-main); font-weight: 700;">' + planDate + '</strong>' +
            '</div>' +
            '<div>' +
                '<span style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--text-muted); display: block; margin-bottom: 4px; letter-spacing: 0.05em;">Items</span>' +
                '<strong style="font-size: 1.1rem; color: var(--text-main); font-weight: 700;">' + pendingItems + '</strong>' +
            '</div>' +
            '<div>' +
                '<span style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--text-muted); display: block; margin-bottom: 4px; letter-spacing: 0.05em;">Total Approved</span>' +
                '<strong style="font-size: 1.1rem; color: var(--text-main); font-weight: 700;">' + totalApproved + ' pcs</strong>' +
            '</div>' +
            '<div>' +
                '<span style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--text-muted); display: block; margin-bottom: 4px; letter-spacing: 0.05em;">Finished</span>' +
                '<strong style="font-size: 1.1rem; color: var(--status-success); font-weight: 700;">' + qtyFinished + ' pcs</strong>' +
            '</div>' +
            '<div>' +
                '<span style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--text-muted); display: block; margin-bottom: 4px; letter-spacing: 0.05em;">Remaining</span>' +
                '<strong style="font-size: 1.1rem; color: var(--primary); font-weight: 700;">' + qtyToFinish + ' pcs</strong>' +
            '</div>' +
        '</div>';
}

function getOperatorsOptionsHtml() {
    if (DEMO_MODE || !isRunningInCreator()) {
        var mockOps = ['Operator A', 'Operator B', 'Operator C'];
        return mockOps.map(function (op) {
            var selected = (ACTIVE_JOB && ACTIVE_JOB.selectedOperator === op) ? ' selected' : '';
            return '<option value="' + escapeHtml(op) + '"' + selected + '>' + escapeHtml(op) + '</option>';
        }).join('');
    }
    if (OPERATORS_LIST.length === 0) {
        return '<option value="">No operators found</option>';
    }
    return OPERATORS_LIST.map(function (op) {
        var selected = (ACTIVE_JOB && ACTIVE_JOB.selectedOperator === op.name) ? ' selected' : '';
        return '<option value="' + escapeHtml(op.name) + '"' + selected + '>' + escapeHtml(op.name) + '</option>';
    }).join('');
}

function onOperatorChanged() {
    var select = document.getElementById('active-operator-select-el');
    if (select && ACTIVE_JOB) {
        ACTIVE_JOB.selectedOperator = select.value;
    }
}

function onSupervisorChanged() {
    var select = document.getElementById('staff-select-el');
    if (select) {
        SELECTED_STAFF = select.value;
    }
}
