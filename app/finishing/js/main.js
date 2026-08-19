// Finishing Workflow Controller - Timestamp Edition

var DEMO_MODE = false; // Set to true to use mock queue/history data for lead presentation, while keeping live employee loading!

var ACTIVE_JOB = null;
var ACTIVE_STAGE = 0; // 0 = Folding, 1 = Pressing, 2 = Branding
var STAGE_NAMES = ['folding', 'pressing', 'branding'];
var STAGE_LABELS = ['Folding', 'Pressing', 'Branding'];

var SELECTED_STAFF = 'Abhijay'; // Default staff
var SELECTED_OPERATOR = ''; // Default operator
var OPERATORS_LIST = [];
var ACTIVE_TOP_TAB = 'finishing'; // Track active tab ('finishing' or 'packing')

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
        populatePackerDropdown3D();
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
        OPERATORS_LIST.sort(function (a, b) {
            return a.name.localeCompare(b.name);
        });
        console.log('Successfully fetched operators:', OPERATORS_LIST);

        // Populate supervisors dropdown
        var supervisors = parsed.supervisors || [];
        supervisors.sort(function (a, b) {
            return a.name.localeCompare(b.name);
        });
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

        // Populate packer dropdown with finishing operators list
        populatePackerDropdown3D();
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
            onSupervisorChanged();
        });
    }

    // Set header date dynamically
    renderHeaderDate();

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
        
        // Update supervisor initials avatar
        var avatar = document.getElementById('staff-avatar-initial');
        if (avatar) {
            avatar.innerText = SELECTED_STAFF ? SELECTED_STAFF.charAt(0).toUpperCase() : 'S';
        }

        // Trigger updates on active screen
        if (ACTIVE_TOP_TAB === 'finishing') {
            onPlanSelected();
        } else {
            loadPackingDashboardData();
        }
    }
}

function renderHeaderDate() {
    var dateEl = document.getElementById('app-date-el');
    if (dateEl) {
        var now = new Date();
        // Format: Wednesday, 19 Aug 2026
        var formattedDate = now.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
        dateEl.innerText = formattedDate;
    }
}

function onRefreshClicked() {
    loadDashboardData();
    loadPackingDashboardData();
}

function loadDashboardData() {
    loadFinishingPlans();
    var select = document.getElementById('plan-select-el');
    var selectedPlan = select ? select.value : '';
    loadFinishingQueue(selectedPlan);
    loadFinishingHistory();
}

// ----------------------------------------------------
// TOP LEVEL TAB NAVIGATION
// ----------------------------------------------------

function switchTopTab(tab) {
    ACTIVE_TOP_TAB = tab;
    var tabFin = document.getElementById('tab-top-finishing');
    var tabPack = document.getElementById('tab-top-packing');
    var panelFin = document.getElementById('panel-top-finishing');
    var panelPack = document.getElementById('panel-top-packing');
    var titleEl = document.getElementById('app-title-el');
    
    if (tab === 'finishing') {
        tabFin.classList.add('is-active');
        tabPack.classList.remove('is-active');
        panelFin.style.display = 'block';
        panelPack.style.display = 'none';
        if (titleEl) titleEl.innerText = "Finishing Dashboard";
        
        // Refresh finishing dashboard
        loadDashboardData();
    } else {
        tabFin.classList.remove('is-active');
        tabPack.classList.add('is-active');
        panelFin.style.display = 'none';
        panelPack.style.display = 'block';
        if (titleEl) titleEl.innerText = "Packing Dashboard";
        
        // Boot packing dashboard
        initPackingDashboard();
    }
}

// ----------------------------------------------------
// PACKING CONTROLLER & STATE
// ----------------------------------------------------

var ACTIVE_PACKING_ORDER_ID = null;
var ACTIVE_PACKING_ORDER = null;
var PACKING_QUEUE = [];
var ACTIVE_PACKING_TAB = 'inner';
var SELECTED_PACKER = '';
var BOX_SIZES_MASTER = []; // Processed box master list
var SELECTED_OUTER_BOX_INDEX = null; // Visualized outer box index
var EXPANDED_SKUS = {}; // Track expanded items in accordion

var packingInnerCounter = 1;
var packingOuterCounter = 1;

function initPackingDashboard() {
    populatePackerDropdown3D();
    loadPackingDashboardData();
}

function populatePackerDropdown3D() {
    var select = document.getElementById('packer-select-el');
    if (!select) return;

    var listToUse = OPERATORS_LIST;
    if (DEMO_MODE || !isRunningInCreator() || listToUse.length === 0) {
        listToUse = [
            { id: "e1", name: "Operator A" },
            { id: "e2", name: "Operator B" },
            { id: "e3", name: "Operator C" }
        ];
    }

    var sortedList = listToUse.slice().sort(function (a, b) {
        return a.name.localeCompare(b.name);
    });

    select.innerHTML = sortedList.map(function (emp) {
        var selected = (SELECTED_PACKER === emp.name) ? ' selected' : '';
        return '<option value="' + escapeHtml(emp.name) + '"' + selected + '>' + escapeHtml(emp.name) + '</option>';
    }).join('');

    SELECTED_PACKER = select.value;
    updatePackerAvatar();

    select.onchange = function () {
        SELECTED_PACKER = select.value;
        updatePackerAvatar();
    };
}

function updatePackerAvatar() {
    var avatar = document.getElementById('packer-avatar-initial');
    if (avatar) {
        avatar.innerText = SELECTED_PACKER ? SELECTED_PACKER.charAt(0).toUpperCase() : 'P';
    }
}

function loadPackingDashboardData() {
    var queueContainer = document.getElementById('packing-order-queue-list');
    if (queueContainer) {
        queueContainer.innerHTML = '<div style="padding:2rem; text-align:center;"><div class="skeleton-line" style="width:80%; margin: 8px auto;"></div><div class="skeleton-line" style="width:60%; margin: 8px auto;"></div></div>';
    }

    if (!isRunningInCreator() || DEMO_MODE) {
        PACKING_QUEUE = [
            { id: "10001", orderNo: "SO-2026-0801", source: "Shopify", itemCount: 2, totalPieces: 5 },
            { id: "10002", orderNo: "SO-2026-0802", source: "Faire", itemCount: 1, totalPieces: 10 }
        ];
        renderPackingQueueList();
        return;
    }

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getPackingQueue',
        http_method: 'POST',
        payload: { payloadJson: "" }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('getPackingQueue parse error:', e);
            return;
        }

        if (parsed.errors && parsed.errors.length > 0) {
            console.error('getPackingQueue error:', parsed.errors);
            return;
        }

        PACKING_QUEUE = parsed.orders || [];
        renderPackingQueueList();
    }).catch(function (err) {
        console.error('getPackingQueue failed:', err);
    });
}

function renderPackingQueueList() {
    var container = document.getElementById('packing-order-queue-list');
    var countLabel = document.getElementById('packing-queue-count');
    if (!container) return;

    if (countLabel) countLabel.innerText = PACKING_QUEUE.length;

    if (PACKING_QUEUE.length === 0) {
        container.innerHTML = '<div class="empty-state-small"><div class="icon">📦</div><p>No orders pending packing</p></div>';
        return;
    }

    container.innerHTML = PACKING_QUEUE.map(function (order) {
        var activeClass = (ACTIVE_PACKING_ORDER_ID === order.id) ? ' is-active' : '';
        return '<div class="queue-item-card' + activeClass + '" onclick="selectPackingOrder(\'' + escapeHtml(order.id) + '\')">' +
            '<span class="order-no">' + escapeHtml(order.orderNo) + '</span>' +
            '<div class="order-meta">' +
                '<span>Src: ' + escapeHtml(order.source) + '</span>' +
                '<span>' + order.totalPieces + ' pcs</span>' +
            '</div>' +
            '</div>';
    }).join('');
}

function selectPackingOrder(orderId) {
    ACTIVE_PACKING_ORDER_ID = orderId;
    renderPackingQueueList();

    var editor = document.getElementById('packing-editor');
    var emptyState = document.getElementById('packing-workspace-empty-state');
    if (emptyState) emptyState.classList.add('hidden');
    if (editor) {
        editor.classList.remove('hidden');
        document.querySelector('#panel-top-packing .tab-body').style.opacity = '0.5';
    }

    if (!isRunningInCreator() || DEMO_MODE) {
        var matched = PACKING_QUEUE.filter(function (o) { return o.id === orderId; })[0] || PACKING_QUEUE[0];
        
        var mockItems = [];
        if (matched.id === "10002") {
            // Faire order: 10 Linen Tshirts (large batch to test multi-box inner and outer packing!)
            mockItems = [
                { lineNo: 1, sku: "Linen Tshirt", itemName: "Linen Tshirt - White / S", qty: 10, length: 15, width: 10, height: 4, weight: 0.2 }
            ];
        } else {
            // Shopify order: mixed order
            mockItems = [
                { lineNo: 1, sku: "Linen Tshirt", itemName: "Linen Tshirt - White / S", qty: 3, length: 15, width: 10, height: 4, weight: 0.2 },
                { lineNo: 2, sku: "Linen Basket", itemName: "Linen Basket - Large", qty: 2, length: 30, width: 30, height: 6, weight: 0.4 }
            ];
        }

        var mockDetails = {
            salesOrderId: orderId,
            orderNo: matched.orderNo,
            source: matched.source,
            items: mockItems,
            boxSizes: [
                { id: "b1", name: "Box 1 (O1/I1)", length: 35, width: 35, height: 10, volume: 12250 },
                { id: "b2", name: "Box 2 (O2/I2)", length: 40, width: 40, height: 15, volume: 24000 },
                { id: "b3", name: "Box 3 (O3/I3)", length: 35, width: 28, height: 5, volume: 4900 },
                { id: "b4", name: "Box 4 (O4/I4)", length: 60, width: 40, height: 30, volume: 72000 },
                { id: "b5", name: "Box 5 (O5/I5)", length: 30, width: 20, height: 4, volume: 2400 },
                { id: "b6", name: "Box 6 (O6)", length: 58, width: 30, height: 22, volume: 38280 },
                { id: "b7", name: "Box 7 (O7)", length: 42, width: 22, height: 20, volume: 18480 },
                { id: "b8", name: "Box 8 (O8)", length: 55, width: 28, height: 19, volume: 29260 }
            ],
            capacities: []
        };
        setupActivePackingOrder(mockDetails);
        return;
    }

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getPackingDetails',
        http_method: 'POST',
        payload: {
            payloadJson: JSON.stringify({ salesOrderId: orderId })
        }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('getPackingDetails parse failed:', e);
            alert("Error parsing order details.");
            return;
        }

        if (parsed.errors && parsed.errors.length > 0) {
            alert("Creator API Error: " + parsed.errors.join(', '));
            return;
        }

        setupActivePackingOrder(parsed);
    }).catch(function (err) {
        console.error('getPackingDetails call failed:', err);
    });
}

function setupActivePackingOrder(details) {
    // Process boxSizes using default fallback config
    BOX_SIZES_MASTER = (details.boxSizes || []).map(function (box) {
        var def = Packing3D.DEFAULT_BOX_MASTER.filter(function (d) {
            return d.name === box.name || box.name.indexOf(d.code) !== -1;
        })[0];

        return {
            id: box.id,
            code: def ? def.code : box.name,
            name: box.name,
            boxLevel: def ? def.boxLevel : "BOTH",
            outer: (function () {
                var isWLH = (box.name.indexOf("Box 6") !== -1 || box.name.indexOf("Box 7") !== -1 || box.name.indexOf("Box 8") !== -1 || (def && (def.code === "O6" || def.code === "O7" || def.code === "O8")));
                if (isWLH) {
                    return {
                        w: box.length || (def ? def.outer.w : 58),
                        l: box.width || (def ? def.outer.l : 30),
                        h: box.height || (def ? def.outer.h : 22)
                    };
                } else {
                    return {
                        w: box.width || (def ? def.outer.w : 35),
                        l: box.length || (def ? def.outer.l : 35),
                        h: box.height || (def ? def.outer.h : 10)
                    };
                }
            })(),
            inner: (function () {
                var isWLH = (box.name.indexOf("Box 6") !== -1 || box.name.indexOf("Box 7") !== -1 || box.name.indexOf("Box 8") !== -1 || (def && (def.code === "O6" || def.code === "O7" || def.code === "O8")));
                if (box.innerLength && box.innerWidth && box.innerHeight) {
                    if (isWLH) {
                        return {
                            w: box.innerLength,
                            l: box.innerWidth,
                            h: box.innerHeight
                        };
                    } else {
                        return {
                            w: box.innerWidth,
                            l: box.innerLength,
                            h: box.innerHeight
                        };
                    }
                } else if (def && def.inner) {
                    return {
                        w: def.inner.w,
                        l: def.inner.l,
                        h: def.inner.h
                    };
                }
                return null;
            })(),
            cost: box.cost || (def ? def.cost : 1.0),
            active: true
        };
    });

    if (BOX_SIZES_MASTER.length === 0) {
        BOX_SIZES_MASTER = Packing3D.DEFAULT_BOX_MASTER.slice();
    }

    ACTIVE_PACKING_ORDER = {
        id: details.salesOrderId,
        orderNo: details.orderNo,
        source: details.source,
        items: details.items || [],
        innerBoxes: [],
        outerBoxes: []
    };

    document.getElementById('packing-active-order-no').innerText = ACTIVE_PACKING_ORDER.orderNo;
    var badgeEl = document.getElementById('packing-active-source-badge');
    if (badgeEl) badgeEl.innerText = ACTIVE_PACKING_ORDER.source;
    var itemsCountEl = document.getElementById('packing-active-items-count');
    if (itemsCountEl) itemsCountEl.innerText = ACTIVE_PACKING_ORDER.items.length;

    var totalPcs = ACTIVE_PACKING_ORDER.items.reduce(function (sum, it) { return sum + it.qty; }, 0);
    var pcsCountEl = document.getElementById('packing-active-pcs-count');
    if (pcsCountEl) pcsCountEl.innerText = totalPcs;

    var banner = document.getElementById('packing-notification-banner');
    if (banner) banner.className = 'hidden';

    packingInnerCounter = 1;
    packingOuterCounter = 1;

    // Run 3D Auto Packer
    autoPackItems3D();

    document.querySelector('#panel-top-packing .tab-body').style.opacity = '1';
    switchPackingTab('inner');
}

function switchPackingTab(tab) {
    ACTIVE_PACKING_TAB = tab;
    var btnInner = document.getElementById('tab-inner-btn');
    var btnOuter = document.getElementById('tab-outer-btn');
    var panelInner = document.getElementById('panel-inner');
    var panelOuter = document.getElementById('panel-outer');

    if (tab === 'inner') {
        if (btnInner) btnInner.classList.add('is-active');
        if (btnOuter) btnOuter.classList.remove('is-active');
        if (panelInner) panelInner.style.display = 'block';
        if (panelOuter) panelOuter.style.display = 'none';
        renderInnerBoxes3D();
    } else {
        if (btnInner) btnInner.classList.remove('is-active');
        if (btnOuter) btnOuter.classList.add('is-active');
        if (panelInner) panelInner.style.display = 'none';
        if (panelOuter) panelOuter.style.display = 'block';
        renderOuterBoxes3D();
    }
    validatePacking3D();
}

// ----------------------------------------------------
// 3D SOLVER INTEGRATION
// ----------------------------------------------------

function showPackingNotification(message, type) {
    var banner = document.getElementById('packing-notification-banner');
    if (!banner) return;

    var bg = type === 'success' ? '#ecfdf5' : '#fef2f2';
    var border = type === 'success' ? '#10b981' : '#ef4444';
    var color = type === 'success' ? '#065f46' : '#991b1b';
    var icon = type === 'success' ? '⚡' : '⚠️';

    banner.innerHTML = '<div style="display:flex; align-items:center; gap:0.5rem; padding:0.75rem 1rem; border-radius:var(--radius); border:1px solid ' + border + '; background:' + bg + '; color:' + color + '; font-size:0.875rem; font-weight:600; animation:slideDownFade 0.25s ease-out;">' +
        '<span>' + icon + '</span>' +
        '<span style="flex-grow:1;">' + message + '</span>' +
        '<button type="button" onclick="document.getElementById(\'packing-notification-banner\').classList.add(\'hidden\')" style="background:none; border:none; color:' + color + '; font-weight:bold; cursor:pointer; font-size:14px; padding:0 4px;">✕</button>' +
    '</div>';
    banner.classList.remove('hidden');
}

function autoPackItems3D() {
    if (!ACTIVE_PACKING_ORDER) return;

    try {
        // Run Level 1 Solver: Products -> Inner Boxes
        var packedInners = Packing3D.packItemsIntoInnerBoxes(ACTIVE_PACKING_ORDER.items, BOX_SIZES_MASTER);

        // Run Level 2 Solver: Inner Boxes -> Outer Boxes
        var packedOuters = Packing3D.packInnerBoxesIntoOuterBoxes(packedInners, BOX_SIZES_MASTER);

        ACTIVE_PACKING_ORDER.innerBoxes = packedInners.map(function (ib) {
            // Find which outer box this inner box was placed in and its placement coordinates
            var parentOuter = null;
            var placement = null;
            packedOuters.forEach(function (ob) {
                var matches = ob.innerBoxes.filter(function (oib) { return oib.boxNo === ib.boxNo; });
                if (matches.length > 0) {
                    parentOuter = ob.outerBoxNo;
                    placement = matches[0].placement;
                }
            });

            return {
                boxNo: ib.boxNo,
                boxSize: ib.boxSize,
                boxCode: ib.boxCode,
                cost: ib.cost,
                sku: ib.sku, // Map SKU
                outerDim: ib.outerDim,
                innerDim: (function() {
                    var cfg = BOX_SIZES_MASTER.filter(function(b){ return b.name === ib.boxSize; })[0];
                    return (cfg && cfg.inner) ? { w: cfg.inner.w, l: cfg.inner.l, h: cfg.inner.h } : null;
                })(),
                items: ib.items,
                utilization: ib.utilization || 0,
                outerBoxNo: parentOuter,
                placement: placement
            };
        });

        ACTIVE_PACKING_ORDER.outerBoxes = packedOuters.map(function (ob) {
            return {
                outerBoxNo: ob.outerBoxNo,
                boxName: ob.boxName,
                boxCode: ob.boxCode,
                cost: ob.cost,
                dimensions: ob.dimensions,
                volumeUsed: ob.volumeUsed,
                utilization: ob.utilization,
                weight: parseFloat((ob.innerBoxes.reduce(function (w, ib) { return w + 1; }, 0) * 0.2 + 0.5).toFixed(1))
            };
        });

        // Set visualizer to focus on first outer box
        if (ACTIVE_PACKING_ORDER.outerBoxes.length > 0) {
            SELECTED_OUTER_BOX_INDEX = 0;
        } else {
            SELECTED_OUTER_BOX_INDEX = null;
        }

        var innerCount = ACTIVE_PACKING_ORDER.innerBoxes.length;
        var outerCount = ACTIVE_PACKING_ORDER.outerBoxes.length;
        var totalPcs = ACTIVE_PACKING_ORDER.items.reduce(function (sum, it) { return sum + it.qty; }, 0);
        showPackingNotification("Auto-pack completed successfully! Packed " + totalPcs + " items into " + innerCount + " inner box(es), which were placed into " + outerCount + " outer box(es).", "success");

    } catch (e) {
        showPackingNotification("3D Auto-Pack failed: " + e.message, "error");
        ACTIVE_PACKING_ORDER.innerBoxes = [];
        ACTIVE_PACKING_ORDER.outerBoxes = [];
        SELECTED_OUTER_BOX_INDEX = null;
    }

    updatePackingProgress3D();
    if (ACTIVE_PACKING_TAB === 'inner') {
        renderInnerBoxes3D();
    } else {
        renderOuterBoxes3D();
    }
    validatePacking3D();
}

function updatePackingProgress3D() {
    if (!ACTIVE_PACKING_ORDER) return;

    var progressMap = {};
    ACTIVE_PACKING_ORDER.items.forEach(function (itm) {
        progressMap[itm.sku] = 0;
    });

    ACTIVE_PACKING_ORDER.innerBoxes.forEach(function (ib) {
        ib.items.forEach(function (itm) {
            if (progressMap[itm.sku] !== undefined) {
                progressMap[itm.sku]++;
            }
        });
    });

    var container = document.getElementById('packing-items-progress-list');
    if (!container) return;

    container.innerHTML = ACTIVE_PACKING_ORDER.items.map(function (item) {
        var packed = progressMap[item.sku] || 0;
        var percent = Math.min(100, Math.round((packed / item.qty) * 100)) || 0;
        var barClass = 'item-progress-bar';
        if (packed === item.qty) barClass += ' complete';
        else if (packed > item.qty) barClass += ' overpack';

        var dimsTxt = (item.length && item.width && item.height) ? 
            ' (' + item.length + 'x' + item.width + 'x' + item.height + ' cm)' : '';

        return '<div class="item-progress-row">' +
            '<div class="item-progress-header">' +
                '<span>' + escapeHtml(item.itemName) + '<span style="font-size:10px; color:var(--text-muted); font-weight:normal;">' + dimsTxt + '</span></span>' +
                '<span class="sku-label">' + escapeHtml(item.sku) + '</span>' +
            '</div>' +
            '<div class="item-progress-header" style="font-size:11px; font-weight:normal; color:var(--text-muted);">' +
                '<span>Progress: ' + packed + ' / ' + item.qty + ' pcs</span>' +
                '<span>' + percent + '%</span>' +
            '</div>' +
            '<div class="item-progress-bar-wrapper">' +
                '<div class="' + barClass + '" style="width: ' + percent + '%;"></div>' +
            '</div>' +
            '</div>';
    }).join('');
}

function toggleSkuAccordion(sku) {
    EXPANDED_SKUS[sku] = !EXPANDED_SKUS[sku];
    renderInnerBoxes3D();
}

function renderInnerBoxes3D() {
    var accordionContainer = document.getElementById('packing-items-accordion');
    if (!accordionContainer) return;

    if (!ACTIVE_PACKING_ORDER) {
        accordionContainer.innerHTML = '';
        return;
    }

    if (ACTIVE_PACKING_ORDER.items.length === 0) {
        accordionContainer.innerHTML = '<div class="empty-state-small" style="grid-column: 1/-1;"><div class="icon">📦</div><p>No items in this order.</p></div>';
        return;
    }

    // Initialize EXPANDED_SKUS if empty
    if (Object.keys(EXPANDED_SKUS).length === 0) {
        ACTIVE_PACKING_ORDER.items.forEach(function (itm, idx) {
            EXPANDED_SKUS[itm.sku] = (idx === 0); // First one expanded by default
        });
    }

    // Build the inner-box options HTML (all box types that can serve as inner boxes)
    var innerBoxOptions = BOX_SIZES_MASTER.filter(function (b) {
        return (b.boxLevel === 'INNER' || b.boxLevel === 'BOTH') && b.inner !== null;
    }).map(function (b) {
        var cleanName = b.name.split(' ')[0] + ' ' + b.name.split(' ')[1];
        var innerDimTxt = b.inner.l + '×' + b.inner.w + '×' + b.inner.h + ' cm';
        return '<option value="' + escapeHtml(b.name) + '">' + escapeHtml(cleanName) + ' (' + innerDimTxt + ')</option>';
    }).join('');

    var html = ACTIVE_PACKING_ORDER.items.map(function (item) {
        // Find inner boxes assigned to this item
        var assignedBoxes = ACTIVE_PACKING_ORDER.innerBoxes.filter(function (ib) {
            return ib.sku === item.sku;
        });

        // Calculate pieces packed
        var packedQty = assignedBoxes.reduce(function (sum, ib) {
            return sum + ib.items.length;
        }, 0);

        var percent = Math.min(100, Math.round((packedQty / item.qty) * 100)) || 0;
        var progressClass = 'item-progress-bar';
        if (packedQty === item.qty) progressClass += ' complete';
        else if (packedQty > item.qty) progressClass += ' overpack';

        var isExpanded = EXPANDED_SKUS[item.sku];
        var chevron = isExpanded ? '▲' : '▼';
        var expandedStyle = isExpanded ? 'display: block;' : 'display: none;';

        // Render box cards inside the body of this accordion item
        var boxesHtml = '';
        if (assignedBoxes.length === 0) {
            boxesHtml = '<div style="font-size:12px; text-align:center; padding: 1.5rem 1rem; color:var(--text-muted); font-style:italic;">' +
                'No inner boxes created for this item yet. Click "Add Box" to start packing.</div>';
        } else {
            boxesHtml = '<div class="boxes-container">' + assignedBoxes.map(function (ib) {
                var sizeNum = ib.boxCode ? ib.boxCode.replace('I','').replace('O','') : '3';
                var sizeNumClass = 'size-' + sizeNum;
                var util = ib.utilization || 0;
                var utilColor = util > 90 ? '#f59e0b' : 'var(--primary)';
                var isValid = ib.fits !== false;

                // Box type select element
                var selectHtml = '<select class="box-type-select" onchange="updateInnerBoxType(\'' + ib.boxNo + '\', this.value)">' +
                    innerBoxOptions + '</select>';

                var invalidClass = isValid ? '' : ' invalid';
                var outerPlacementText = ib.outerBoxNo ? ('Placed in ' + ib.outerBoxNo) : 'Unplaced in Outer Box';
                var outerPlacementColor = ib.outerBoxNo ? '#10b981' : '#f59e0b';

                return '<div class="box-card ' + sizeNumClass + invalidClass + '" id="inner-card-' + ib.boxNo + '">' +
                    '<div class="box-card-header">' +
                        '<span class="box-id">' + ib.boxNo + '</span>' +
                        '<button type="button" class="btn-delete" title="Delete Box" onclick="deleteInnerBox3D(\'' + ib.boxNo + '\')">✕</button>' +
                    '</div>' +
                    '<div>' +
                        '<span class="box-type-label">Box Type</span>' +
                        selectHtml +
                    '</div>' +
                    '<div class="card-divider"></div>' +
                    '<div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;">' +
                        '<span style="font-size:12px; font-weight:700; color:var(--text-main);">Quantity Packed</span>' +
                        '<div class="item-qty-stepper">' +
                            '<button type="button" onclick="stepInnerBoxItemQty(\'' + ib.boxNo + '\',\'' + item.sku + '\',-1)">−</button>' +
                            '<input class="item-qty-input" type="number" min="0" max="' + item.qty + '" value="' + ib.items.length + '"' +
                                ' onchange="updateInnerBoxItemQty(\'' + ib.boxNo + '\',\'' + item.sku + '\', parseInt(this.value)||0)"' +
                                ' onblur="updateInnerBoxItemQty(\'' + ib.boxNo + '\',\'' + item.sku + '\', parseInt(this.value)||0)">' +
                            '<button type="button" onclick="stepInnerBoxItemQty(\'' + ib.boxNo + '\',\'' + item.sku + '\',1)">+</button>' +
                        '</div>' +
                    '</div>' +
                    '<div class="card-divider"></div>' +
                    '<div class="box-util-info">' +
                        '<span>Space Used: <strong>' + util + '%</strong></span>' +
                        '<span style="color:' + outerPlacementColor + '; font-size:10px; font-weight:700;">' + outerPlacementText + '</span>' +
                    '</div>' +
                    '<div class="box-util-bar-wrapper"><div class="box-util-bar" style="width:' + util + '%; background:' + utilColor + ';"></div></div>' +
                '</div>';
            }).join('') + '</div>';
        }

        var dimsTxt = (item.length && item.width && item.height) ?
            ' (' + item.length + 'x' + item.width + 'x' + item.height + ' cm)' : '';

        return '<div class="accordion-item" style="border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); box-shadow: var(--shadow-sm); overflow: hidden; margin-bottom: 0.75rem;">' +
            // Accordion Header
            '<div class="accordion-header" style="padding: 1rem; cursor: pointer; display: flex; align-items: center; justify-content: space-between; background: #f8fafc; border-bottom: ' + (isExpanded ? '1px solid var(--border)' : 'none') + '; user-select: none;" onclick="toggleSkuAccordion(\'' + item.sku + '\')">' +
                '<div style="display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; padding-right: 1.5rem;">' +
                    '<div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">' +
                        '<span style="font-weight: 700; color: var(--text-main); font-size: 0.95rem;">' + escapeHtml(item.itemName) + '</span>' +
                        '<span class="sku-label" style="font-family: monospace; font-size: 0.75rem; background: #e2e8f0; padding: 2px 6px; border-radius: 4px; color: var(--text-muted); font-weight: 600;">' + escapeHtml(item.sku) + '</span>' +
                    '</div>' +
                    '<div style="font-size: 11px; color: var(--text-muted); display: flex; align-items: center; gap: 8px;">' +
                        '<span>Dimensions: ' + (dimsTxt ? dimsTxt : 'N/A') + '</span>' +
                        '<span>|</span>' +
                        '<span style="font-weight: 700; color: ' + (packedQty === item.qty ? '#10b981' : '#f59e0b') + ';">Packed: ' + packedQty + ' / ' + item.qty + ' pcs</span>' +
                    '</div>' +
                    '<div class="item-progress-bar-wrapper" style="width: 150px; height: 6px; margin-top: 4px; background: #e2e8f0; border-radius: 9999px; overflow: hidden;">' +
                        '<div class="' + progressClass + '" style="width: ' + percent + '%; height: 100%;"></div>' +
                    '</div>' +
                '</div>' +
                '<div style="display: flex; align-items: center; gap: 1rem; flex-shrink: 0;">' +
                    '<button type="button" class="action-btn-primary" style="padding: 6px 12px; font-size: 0.75rem;" onclick="event.stopPropagation(); addInnerBox3D(\'' + item.sku + '\')">➕ Add Box</button>' +
                    '<span style="font-size: 0.85rem; color: var(--text-muted); font-weight: bold; width: 15px; text-align: center;">' + chevron + '</span>' +
                '</div>' +
            '</div>' +
            // Accordion Body
            '<div class="accordion-body" style="padding: 1.25rem; ' + expandedStyle + '">' +
                boxesHtml +
            '</div>' +
        '</div>';
    }).join('');

    accordionContainer.innerHTML = html;

    // After rendering, set the select value correctly for each card
    ACTIVE_PACKING_ORDER.innerBoxes.forEach(function (ib) {
        var card = document.getElementById('inner-card-' + ib.boxNo);
        if (!card) return;
        var sel = card.querySelector('.box-type-select');
        if (sel) sel.value = ib.boxSize;
    });
}

function renderOuterBoxes3D() {
    // 1. Render unplaced inner boxes
    var unplacedContainer = document.getElementById('packing-unplaced-inner-boxes-list');
    var unplacedBoxes = ACTIVE_PACKING_ORDER.innerBoxes.filter(function (ib) { return ib.outerBoxNo === null; });

    if (unplacedContainer) {
        if (unplacedBoxes.length === 0) {
            unplacedContainer.innerHTML = '<div style="font-size:11px; text-align:center; padding: 1.5rem; color:var(--text-muted); font-style:italic; width:100%;">All inner boxes are placed.</div>';
        } else {
            unplacedContainer.innerHTML = unplacedBoxes.map(function (ib) {
                var sizeNum = ib.boxCode ? ib.boxCode.replace('I', '') : '3';
                return '<div class="draggable-box-pill size-' + sizeNum + '" data-box-no="' + ib.boxNo + '" style="cursor: default;">' +
                    '<span>' + ib.boxNo + ' (' + ib.boxCode + ')</span>' +
                    '<span style="font-size: 11px; font-weight:700; color:var(--primary);">' + ib.items.length + ' pcs</span>' +
                    '</div>';
            }).join('');
        }
    }

    // 2. Compute compatibility for all outer box types vs. current inner boxes
    var compatMap = {};
    getCompatibleOuterBoxes().forEach(function (entry) {
        compatMap[entry.cfg.name] = entry.fits;
    });

    // 3. Render Outer Boxes list
    var outerContainer = document.getElementById('packing-outer-boxes-list');
    if (!outerContainer) return;

    if (ACTIVE_PACKING_ORDER.outerBoxes.length === 0) {
        outerContainer.innerHTML = '<div class="empty-state-small" style="grid-column: 1/-1;"><div class="icon">📦</div><p>No outer boxes configured. Click "Add Outer Box" to see options.</p></div>';
        return;
    }

    outerContainer.innerHTML = ACTIVE_PACKING_ORDER.outerBoxes.map(function (ob, idx) {
        var outerNo = ob.outerBoxNo;
        var isCompatible = (compatMap[ob.boxName] !== false);

        var cardClass = 'outer-box-card' + (isCompatible ? '' : ' incompatible');
        var borderStyle = ''; // No selected outline since visualizer is removed
        var compatBadge = isCompatible
            ? '<span class="compatible-badge">✓ Compatible</span>'
            : '<span class="incompatible-badge">✗ Incompatible</span>';

        var pctUsed = ob.utilization || 0;
        var utilColor = pctUsed > 90 ? '#f59e0b' : 'var(--primary)';
        var placedInThis = ACTIVE_PACKING_ORDER.innerBoxes.filter(function (ib) { return ib.outerBoxNo === outerNo; });

        var innerPillsHtml = placedInThis.map(function (ib) {
            var sizeNum = ib.boxCode ? ib.boxCode.replace('I','').replace('O','') : '3';
            return '<div class="draggable-box-pill size-' + sizeNum + '" data-box-no="' + ib.boxNo + '" style="cursor: default;">' +
                '<span>' + ib.boxNo + ' (' + ib.boxCode + ') — ' + ib.items.length + ' pcs</span>' +
                '<button type="button" class="pill-del-btn" title="Remove from outer box" onclick="removeBoxFromOuter3D(\'' + ib.boxNo + '\')">✕</button>' +
                '</div>';
        }).join('');

        // Generate dropdown select for unplaced inner boxes
        var selectOptionsHtml = '<option value="">➕ Add Inner Box...</option>' +
            unplacedBoxes.map(function (ib) {
                var cfg = BOX_SIZES_MASTER.filter(function (b) { return b.name === ib.boxSize; })[0];
                var dimText = '';
                if (cfg && cfg.inner) {
                    dimText = ' - ' + cfg.inner.l + '×' + cfg.inner.w + '×' + cfg.inner.h + ' cm';
                }
                var cleanName = ib.boxSize ? (ib.boxSize.split(' ')[0] + ' ' + ib.boxSize.split(' ')[1]) : ib.boxSize;
                return '<option value="' + ib.boxNo + '">' + ib.boxNo + ' (' + cleanName + dimText + ') — ' + ib.items.length + ' pcs</option>';
            }).join('');

        var selectDropdownHtml = '';
        if (unplacedBoxes.length > 0) {
            selectDropdownHtml = '<div style="margin-top: 12px;">' +
                '<select class="add-inner-select" style="width:100%; padding:0.45rem 0.6rem; border-radius:6px; border:1px solid var(--border); font-size:12px; font-weight:600; cursor:pointer; background:#fff; color:var(--text-main);" onchange="if(this.value) { placeBoxInOuter3D(this.value, \'' + outerNo + '\'); this.value=\'\'; }">' +
                    selectOptionsHtml +
                '</select>' +
            '</div>';
        }

        return '<div class="' + cardClass + '" style="' + borderStyle + '">' +
            '<div class="outer-box-info">' +
                '<div style="display:flex; flex-direction:column; gap:4px;">' +
                    '<span class="outer-box-title">' + outerNo + ' (' + ob.boxName + ')</span>' +
                    compatBadge +
                '</div>' +
                '<button type="button" class="btn-delete" title="Delete Outer Box" onclick="deleteOuterBox3D(\'' + outerNo + '\')">✕</button>' +
            '</div>' +
            '<div class="box-util-info">' +
                '<span style="font-weight:700;">Utilization: ' + pctUsed + '%</span>' +
                '<span style="color:var(--text-muted); font-size:11px;">' + ob.dimensions.l + '×' + ob.dimensions.w + '×' + ob.dimensions.h + ' cm</span>' +
            '</div>' +
            '<div class="box-util-bar-wrapper" style="margin-top: -6px; margin-bottom: 4px;">' +
                '<div class="box-util-bar" style="width:' + pctUsed + '%; background:' + utilColor + ';"></div>' +
            '</div>' +
            '<div class="outer-box-inner-list" data-outer-no="' + outerNo + '">' +
                innerPillsHtml +
            '</div>' +
            selectDropdownHtml +
        '</div>';
    }).join('');
}

function selectOuterBoxForVis(idx) {
    SELECTED_OUTER_BOX_INDEX = idx;
    renderOuterBoxes3D();
}

// ----------------------------------------------------
// DRAG & DROP WITH 3D FIT VALIDATION
// ----------------------------------------------------

var draggedBoxNo = null;

function onBoxDragStart(ev) {
    draggedBoxNo = ev.currentTarget.getAttribute('data-box-no');
    ev.dataTransfer.setData("text", draggedBoxNo);
}

function onBoxDragOver(ev) {
    ev.preventDefault();
    ev.currentTarget.classList.add('dragover');
}

function onBoxDragLeave(ev) {
    ev.currentTarget.classList.remove('dragover');
}

function onBoxDrop(ev) {
    ev.preventDefault();
    var container = ev.currentTarget;
    container.classList.remove('dragover');

    var boxNo = ev.dataTransfer.getData("text") || draggedBoxNo;
    var outerBoxNo = container.getAttribute('data-outer-no');

    if (boxNo && outerBoxNo) {
        placeBoxInOuter3D(boxNo, outerBoxNo);
    }
}

function placeBoxInOuter3D(innerBoxNo, outerBoxNo) {
    if (!ACTIVE_PACKING_ORDER) return;

    // Find inner box
    var innerBox = ACTIVE_PACKING_ORDER.innerBoxes.filter(function (ib) { return ib.boxNo === innerBoxNo; })[0];
    // Find target outer box
    var outerBox = ACTIVE_PACKING_ORDER.outerBoxes.filter(function (ob) { return ob.outerBoxNo === outerBoxNo; })[0];

    if (!innerBox || !outerBox) return;

    // Evaluate 3D spatial layout including this new box
    var outerBoxConfig = BOX_SIZES_MASTER.filter(function (b) { return b.name === outerBox.boxName; })[0];
    if (!outerBoxConfig) return;

    // Gather all inner boxes currently in this outer box, plus the new one
    var siblings = ACTIVE_PACKING_ORDER.innerBoxes.filter(function (ib) {
        return ib.outerBoxNo === outerBoxNo && ib.boxNo !== innerBoxNo;
    }).concat([innerBox]);

    var trialItems = siblings.map(function (ib) {
        var sz = ib.innerDim ? ib.innerDim : ib.outerDim;
        return {
            w: sz.w,
            l: sz.l,
            h: sz.h
        };
    });

    // Run 3D Checker
    var container = outerBoxConfig.outer;
    var check = Packing3D.fitItemsInContainer(container, trialItems, true);

    if (!check.fit) {
        var innerSize = innerBox.innerDim ? innerBox.innerDim : innerBox.outerDim;
        alert("⚠️ Physical Mismatch! Inner Box " + innerBoxNo + " (" + innerSize.l + "x" + innerSize.w + "x" + innerSize.h + " cm) does not physically fit in Outer Box " + outerBoxNo + " with existing items due to dimension limits.");
        return;
    }

    // Move successful! Save coordinates
    innerBox.outerBoxNo = outerBoxNo;

    // Update coordinates in the outer box for display
    siblings.forEach(function (sib, idx) {
        var placement = check.placements.filter(function (p) { return p.originalIndex === idx; })[0];
        sib.placement = placement; // store for isometric visualizer
    });

    // Update outer box properties
    outerBox.volumeUsed = check.volumeUsed;
    outerBox.utilization = check.utilization;

    renderOuterBoxes3D();
    validatePacking3D();
}

function removeBoxFromOuter3D(innerBoxNo) {
    if (!ACTIVE_PACKING_ORDER) return;

    var innerBox = ACTIVE_PACKING_ORDER.innerBoxes.filter(function (ib) { return ib.boxNo === innerBoxNo; })[0];
    if (!innerBox) return;

    var prevOuterNo = innerBox.outerBoxNo;
    innerBox.outerBoxNo = null;
    innerBox.placement = null;

    // Recalculate properties for the previous outer box
    if (prevOuterNo) {
        var outerBox = ACTIVE_PACKING_ORDER.outerBoxes.filter(function (ob) { return ob.outerBoxNo === prevOuterNo; })[0];
        if (outerBox) {
            var siblings = ACTIVE_PACKING_ORDER.innerBoxes.filter(function (ib) { return ib.outerBoxNo === prevOuterNo; });
            var outerBoxConfig = BOX_SIZES_MASTER.filter(function (b) { return b.name === outerBox.boxName; })[0];

            if (siblings.length === 0) {
                outerBox.volumeUsed = 0;
                outerBox.utilization = 0;
            } else if (outerBoxConfig) {
                var trialItems = siblings.map(function (ib) {
                    var sz = ib.innerDim ? ib.innerDim : ib.outerDim;
                    return { w: sz.w, l: sz.l, h: sz.h };
                });
                var container = outerBoxConfig.outer;
                var check = Packing3D.fitItemsInContainer(container, trialItems, true);
                if (check.fit) {
                    outerBox.volumeUsed = check.volumeUsed;
                    outerBox.utilization = check.utilization;
                    siblings.forEach(function (sib, idx) {
                        sib.placement = check.placements.filter(function (p) { return p.originalIndex === idx; })[0];
                    });
                }
            }
        }
    }

    renderOuterBoxes3D();
    validatePacking3D();
}

// ----------------------------------------------------
// 3D DRAW VISUALIZATION
// ----------------------------------------------------

function drawPacking3DVisualizer() {
    // Visualizer removed from UI
}

// ----------------------------------------------------
// MANUAL CONTROLS & ADJUSTMENTS
// ----------------------------------------------------

// -------------------------------------------------------
// HELPER: Update inner box type when operator changes dropdown
// -------------------------------------------------------
function updateInnerBoxType(boxNo, newBoxName) {
    if (!ACTIVE_PACKING_ORDER) return;
    var ib = ACTIVE_PACKING_ORDER.innerBoxes.filter(function (b) { return b.boxNo === boxNo; })[0];
    if (!ib) return;

    var cfg = BOX_SIZES_MASTER.filter(function (b) { return b.name === newBoxName; })[0];
    if (!cfg) return;

    ib.boxSize = cfg.name;
    ib.boxCode = cfg.code;
    ib.cost = cfg.cost || 0;
    ib.outerDim = { w: cfg.outer.w, l: cfg.outer.l, h: cfg.outer.h };
    ib.innerDim = cfg.inner ? { w: cfg.inner.w, l: cfg.inner.l, h: cfg.inner.h } : null;

    // Re-validate items still fit in the new box size
    if (cfg.inner) {
        ib.items = ib.items.filter(function (itm) {
            var dims = itm.dimensions || { w: 10, l: 10, h: 2 };
            return dims.w <= cfg.inner.w && dims.l <= cfg.inner.l && dims.h <= cfg.inner.h;
        });
    }

    recalculateInnerBoxUtilization(ib);
    reevaluateOuterBoxes();
    renderInnerBoxes3D();
    validatePacking3D();
}

// -------------------------------------------------------
// HELPER: Set item qty in inner box (low-level, no redistribution)
// -------------------------------------------------------
function _setBoxItemQty(ib, sku, qty, ordItem) {
    var itemName = ordItem ? ordItem.itemName : sku;
    var dims = ordItem ? { w: ordItem.length || 10, l: ordItem.width || 10, h: ordItem.height || 2 } : { w: 10, l: 10, h: 2 };
    qty = Math.max(0, qty);
    ib.items = ib.items.filter(function (i) { return i.sku !== sku; });
    for (var q = 0; q < qty; q++) {
        ib.items.push({ sku: sku, itemName: itemName, dimensions: dims, placement: null });
    }
}

// -------------------------------------------------------
// HELPER: Set item qty — enforces total = ordered qty
//   Smart redistribution: if adding to this box would exceed
//   the order qty, it automatically pulls from other boxes.
// -------------------------------------------------------
function updateInnerBoxItemQty(boxNo, sku, requestedQty) {
    if (!ACTIVE_PACKING_ORDER) return;
    var ib = ACTIVE_PACKING_ORDER.innerBoxes.filter(function (b) { return b.boxNo === boxNo; })[0];
    if (!ib) return;

    var ordItem = (ACTIVE_PACKING_ORDER.items || []).filter(function (it) { return it.sku === sku; })[0];
    var orderedQty = ordItem ? ordItem.qty : 0;

    requestedQty = Math.max(0, Math.min(parseInt(requestedQty) || 0, orderedQty));

    // Total currently in OTHER boxes for this SKU
    var totalInOthers = ACTIVE_PACKING_ORDER.innerBoxes.reduce(function (sum, b) {
        if (b.boxNo === boxNo) return sum;
        return sum + b.items.filter(function (i) { return i.sku === sku; }).length;
    }, 0);

    // How many can we put in this box without exceeding the order total?
    var maxForThisBox = orderedQty - totalInOthers;
    var actualQty = Math.min(requestedQty, maxForThisBox);

    // If requested > what's available (all already in other boxes),
    // redistribute: move the shortfall from the OTHER boxes (take from the largest donor first)
    if (requestedQty > maxForThisBox && requestedQty <= orderedQty) {
        var shortfall = requestedQty - maxForThisBox;
        var donorBoxes = ACTIVE_PACKING_ORDER.innerBoxes
            .filter(function (b) {
                return b.boxNo !== boxNo && b.sku === sku && b.items.length > 0;
            })
            .sort(function (a, b) {
                return b.items.length - a.items.length;
            });

        for (var d = 0; d < donorBoxes.length && shortfall > 0; d++) {
            var donor = donorBoxes[d];
            var donorQty = donor.items.length;
            var toTake = Math.min(donorQty, shortfall);
            _setBoxItemQty(donor, sku, donorQty - toTake, ordItem);
            recalculateInnerBoxUtilization(donor);
            shortfall -= toTake;
        }
        actualQty = requestedQty - shortfall; // whatever we managed to free up
    }

    _setBoxItemQty(ib, sku, actualQty, ordItem);
    recalculateInnerBoxUtilization(ib);
    reevaluateOuterBoxes();
    renderInnerBoxes3D();
    validatePacking3D();
}

function recalculateInnerBoxUtilization(ib) {
    if (!ib) return;
    if (ib.items.length === 0) {
        ib.utilization = 0;
        ib.fits = true;
        return;
    }
    var cfg = BOX_SIZES_MASTER.filter(function (b) { return b.name === ib.boxSize; })[0];
    if (!cfg || !cfg.inner) {
        ib.utilization = 0;
        ib.fits = true;
        return;
    }

    var trialItems = ib.items.map(function (itm) {
        var dims = itm.dimensions || { w: 10, l: 10, h: 2 };
        return {
            w: dims.w,
            l: dims.l,
            h: dims.h,
            allowRotation: true
        };
    });

    var check = Packing3D.fitItemsInContainer(cfg.inner, trialItems, true);
    ib.utilization = check.utilization || 0;
    ib.fits = check.fit;
}

function reevaluateOuterBoxes() {
    if (!ACTIVE_PACKING_ORDER) return;

    ACTIVE_PACKING_ORDER.outerBoxes.forEach(function (ob) {
        var siblings = ACTIVE_PACKING_ORDER.innerBoxes.filter(function (ib) {
            return ib.outerBoxNo === ob.outerBoxNo;
        });

        if (siblings.length === 0) {
            ob.volumeUsed = 0;
            ob.utilization = 0;
            return;
        }

        var outerBoxConfig = BOX_SIZES_MASTER.filter(function (b) { return b.name === ob.boxName; })[0];
        if (!outerBoxConfig) return;

        var trialItems = siblings.map(function (ib) {
            var sz = ib.innerDim ? ib.innerDim : ib.outerDim;
            return {
                w: sz.w,
                l: sz.l,
                h: sz.h
            };
        });

        var container = outerBoxConfig.outer;
        var check = Packing3D.fitItemsInContainer(container, trialItems, true);
        if (check.fit) {
            ob.volumeUsed = check.volumeUsed;
            ob.utilization = check.utilization;
            siblings.forEach(function (sib, idx) {
                sib.placement = check.placements.filter(function (p) { return p.originalIndex === idx; })[0];
            });
        } else {
            // Eject inner boxes that no longer fit
            siblings.forEach(function (sib) {
                sib.outerBoxNo = null;
                sib.placement = null;
            });
            ob.volumeUsed = 0;
            ob.utilization = 0;
            alert("⚠️ Inner boxes were removed from outer box " + ob.outerBoxNo + " because they no longer fit due to size/quantity changes.");
        }
    });
}

// -------------------------------------------------------
// HELPER: +/- stepper button for item qty (with redistribution)
// -------------------------------------------------------
function stepInnerBoxItemQty(boxNo, sku, delta) {
    if (!ACTIVE_PACKING_ORDER) return;
    var ib = ACTIVE_PACKING_ORDER.innerBoxes.filter(function (b) { return b.boxNo === boxNo; })[0];
    if (!ib) return;
    var current = ib.items.filter(function (i) { return i.sku === sku; }).length;
    updateInnerBoxItemQty(boxNo, sku, current + delta);
}

// -------------------------------------------------------
// HELPER: Return compatible outer box configs for current inner boxes
// -------------------------------------------------------
function getCompatibleOuterBoxes() {
    if (!ACTIVE_PACKING_ORDER || ACTIVE_PACKING_ORDER.innerBoxes.length === 0) {
        // No inner boxes yet: all outer boxes are valid candidates
        return BOX_SIZES_MASTER.filter(function (b) {
            return b.boxLevel === 'OUTER' || b.boxLevel === 'BOTH';
        }).map(function (b) { return { cfg: b, fits: true }; });
    }

    var outerCandidates = BOX_SIZES_MASTER.filter(function (b) {
        return b.boxLevel === 'OUTER' || b.boxLevel === 'BOTH';
    });

    // Check compatibility only against unplaced inner boxes
    var targetInners = ACTIVE_PACKING_ORDER.innerBoxes.filter(function (ib) {
        return ib.outerBoxNo === null;
    });

    // If no unplaced inner boxes exist, check against all inner boxes
    if (targetInners.length === 0) {
        targetInners = ACTIVE_PACKING_ORDER.innerBoxes;
    }

    return outerCandidates.map(function (cfg) {
        var container = cfg.outer;
        var canFitAny = false;
        targetInners.forEach(function (ib) {
            var innerSize = ib.innerDim ? ib.innerDim : ib.outerDim;
            var check = Packing3D.fitItemsInContainer(container, [{ w: innerSize.w, l: innerSize.l, h: innerSize.h }], true);
            if (check.fit) {
                canFitAny = true;
            }
        });
        return { cfg: cfg, fits: canFitAny, utilization: 0 };
    });
}

function addInnerBox3D(sku) {
    if (!ACTIVE_PACKING_ORDER) return;

    var innerBoxTypes = BOX_SIZES_MASTER.filter(function (b) {
        return (b.boxLevel === 'INNER' || b.boxLevel === 'BOTH') && b.inner !== null;
    });

    // Build modal HTML
    var optionsHtml = innerBoxTypes.map(function (b) {
        var innerDimTxt = b.inner ? (b.inner.l + '×' + b.inner.w + '×' + b.inner.h + ' cm') : '';
        var cleanName = b.name.split(' ')[0] + ' ' + b.name.split(' ')[1];
        return '<div class="box-option-item" onclick="_doAddInnerBox(\'' + escapeHtml(b.name) + '\', \'' + escapeHtml(sku) + '\')">'
            + '<div class="box-option-left" style="display:flex; flex-direction:column; gap:2px;">'
                + '<span class="box-option-name" style="font-weight:700;">' + escapeHtml(cleanName) + '</span>'
                + '<span class="box-option-dims" style="font-size:11px; color:var(--text-muted); font-weight:600;">Dimensions: ' + innerDimTxt + '</span>'
            + '</div>'
        + '</div>';
    }).join('');

    var overlay = document.createElement('div');
    overlay.className = 'box-selector-overlay';
    overlay.id = 'box-selector-overlay';
    overlay.innerHTML = '<div class="box-selector-modal">'
        + '<h3>📦 Select Inner Box Type</h3>'
        + '<div class="box-option-list">' + optionsHtml + '</div>'
        + '<button class="box-selector-cancel" onclick="_closeBoxSelectorModal()">Cancel</button>'
    + '</div>';
    document.body.appendChild(overlay);
}

function _doAddInnerBox(boxName, sku) {
    _closeBoxSelectorModal();
    if (!ACTIVE_PACKING_ORDER) return;
    var cfg = BOX_SIZES_MASTER.filter(function (b) { return b.name === boxName; })[0];
    if (!cfg) return;

    // Dynamically calculate the next available IB number to prevent duplicates
    var maxInner = 0;
    ACTIVE_PACKING_ORDER.innerBoxes.forEach(function (ib) {
        var num = parseInt(ib.boxNo.replace('IB-', ''));
        if (!isNaN(num) && num > maxInner) maxInner = num;
    });
    packingInnerCounter = maxInner + 1;

    var ordItem = (ACTIVE_PACKING_ORDER.items || []).filter(function (it) { return it.sku === sku; })[0];
    var remaining = 0;
    var itemsToAdd = [];

    if (ordItem) {
        var totalAssigned = ACTIVE_PACKING_ORDER.innerBoxes.reduce(function (sum, b) {
            return sum + b.items.filter(function (i) { return i.sku === sku; }).length;
        }, 0);
        remaining = ordItem.qty - totalAssigned;

        if (remaining > 0 && cfg.inner) {
            var dims = { w: ordItem.length || 10, l: ordItem.width || 10, h: ordItem.height || 2 };
            var trialItems = [];
            var actualQty = 0;
            for (var q = 0; q < remaining; q++) {
                trialItems.push({ w: dims.w, l: dims.l, h: dims.h, allowRotation: true });
                var test = Packing3D.fitItemsInContainer(cfg.inner, trialItems, true);
                if (test.fit) {
                    actualQty = q + 1;
                } else {
                    break;
                }
            }

            for (var q = 0; q < actualQty; q++) {
                itemsToAdd.push({
                    sku: sku,
                    itemName: ordItem.itemName,
                    dimensions: dims,
                    placement: null
                });
            }
        }
    }

    var newBox = {
        boxNo: 'IB-' + String(packingInnerCounter++).padStart(3, '0'),
        boxSize: cfg.name,
        boxCode: cfg.code,
        cost: cfg.cost || 0,
        sku: sku,
        outerDim: { w: cfg.outer.w, l: cfg.outer.l, h: cfg.outer.h },
        innerDim: cfg.inner ? { w: cfg.inner.w, l: cfg.inner.l, h: cfg.inner.h } : null,
        items: itemsToAdd,
        outerBoxNo: null,
        utilization: 0,
        fits: true
    };

    recalculateInnerBoxUtilization(newBox);
    ACTIVE_PACKING_ORDER.innerBoxes.push(newBox);

    renderInnerBoxes3D();
    validatePacking3D();
}

function _closeBoxSelectorModal() {
    var overlay = document.getElementById('box-selector-overlay');
    if (overlay) overlay.parentNode.removeChild(overlay);
}

function deleteInnerBox3D(boxNo) {
    if (!ACTIVE_PACKING_ORDER) return;

    ACTIVE_PACKING_ORDER.innerBoxes = ACTIVE_PACKING_ORDER.innerBoxes.filter(function (ib) {
        return ib.boxNo !== boxNo;
    });

    renderInnerBoxes3D();
    reevaluateOuterBoxes();
    validatePacking3D();
}

function addOuterBox3D() {
    if (!ACTIVE_PACKING_ORDER) return;

    var compatInfo = getCompatibleOuterBoxes();

    // Only display compatible outer boxes (the ones in which the unplaced inner boxes can fit)
    var activeOptions = compatInfo.filter(function (entry) {
        return entry.fits;
    });

    var optionsHtml = '';
    if (activeOptions.length === 0) {
        optionsHtml = '<div style="font-size: 12px; padding: 1.5rem; text-align: center; color: var(--text-muted); font-style: italic; grid-column: 1/-1;">' +
            'No outer box sizes can physically fit the remaining unplaced inner boxes.</div>';
    } else {
        optionsHtml = activeOptions.map(function (entry) {
            var b = entry.cfg;
            var clickAttr = 'onclick="_doAddOuterBox(\'' + escapeHtml(b.name) + '\')"';
            return '<div class="box-option-item" ' + clickAttr + '>'
                + '<div class="box-option-left">'
                    + '<span class="box-option-name" style="font-weight: 700;">' + escapeHtml(b.name) + '</span>'
                    + '<span class="box-option-dims" style="font-size: 11px; color: var(--text-muted); font-weight: 600;">Dimensions: ' + b.outer.l + '×' + b.outer.w + '×' + b.outer.h + ' cm</span>'
                + '</div>'
                + '<div class="box-option-right"><span class="compatible-badge" style="background: #e6f4ea; color: #137333; padding: 4px 8px; border-radius: 4px; font-weight: 700;">✓ Fits</span></div>'
            + '</div>';
        }).join('');
    }

    var summaryHtml = '<div class="compatible-outer-summary" style="margin-bottom: 12px; padding: 8px 12px; background: #e8f0fe; color: #1a73e8; border-radius: 4px; font-size: 12px; font-weight: 600;">💡 Showing only the outer box sizes that can fit the remaining unplaced inner boxes.</div>';

    var overlay = document.createElement('div');
    overlay.className = 'box-selector-overlay';
    overlay.id = 'box-selector-overlay';
    overlay.innerHTML = '<div class="box-selector-modal">'
        + '<h3>📦 Add Outer Box</h3>'
        + summaryHtml
        + '<div class="box-option-list">' + optionsHtml + '</div>'
        + '<button class="box-selector-cancel" onclick="_closeBoxSelectorModal()">Cancel</button>'
    + '</div>';
    document.body.appendChild(overlay);
}

function _doAddOuterBox(boxName) {
    _closeBoxSelectorModal();
    if (!ACTIVE_PACKING_ORDER) return;
    var cfg = BOX_SIZES_MASTER.filter(function (b) { return b.name === boxName; })[0];
    if (!cfg) return;

    // Dynamically calculate the next available OB number to prevent duplicates
    var maxOuter = 0;
    ACTIVE_PACKING_ORDER.outerBoxes.forEach(function (ob) {
        var num = parseInt(ob.outerBoxNo.replace('OB-', ''));
        if (!isNaN(num) && num > maxOuter) maxOuter = num;
    });
    var packingOuterCounter = maxOuter + 1;

    var newOuterNo = 'OB-' + String(packingOuterCounter).padStart(3, '0');
    ACTIVE_PACKING_ORDER.outerBoxes.push({
        outerBoxNo: newOuterNo,
        boxName: cfg.name,
        boxCode: cfg.code,
        cost: cfg.cost || 0,
        dimensions: { w: cfg.outer.w, l: cfg.outer.l, h: cfg.outer.h },
        volumeUsed: 0,
        utilization: 0,
        weight: 0.5
    });

    if (SELECTED_OUTER_BOX_INDEX === null) {
        SELECTED_OUTER_BOX_INDEX = ACTIVE_PACKING_ORDER.outerBoxes.length - 1;
    }

    renderOuterBoxes3D();
    validatePacking3D();
}

function deleteOuterBox3D(outerBoxNo) {
    if (!ACTIVE_PACKING_ORDER) return;

    // Orphan inner boxes inside it
    ACTIVE_PACKING_ORDER.innerBoxes.forEach(function (ib) {
        if (ib.outerBoxNo === outerBoxNo) {
            ib.outerBoxNo = null;
            ib.placement = null;
        }
    });

    ACTIVE_PACKING_ORDER.outerBoxes = ACTIVE_PACKING_ORDER.outerBoxes.filter(function (ob) {
        return ob.outerBoxNo !== outerBoxNo;
    });

    SELECTED_OUTER_BOX_INDEX = ACTIVE_PACKING_ORDER.outerBoxes.length > 0 ? 0 : null;

    renderOuterBoxes3D();
    validatePacking3D();
}

function validatePacking3D() {
    var msg = document.getElementById('packing-validation-msg');
    if (!msg) return;

    if (!ACTIVE_PACKING_ORDER) {
        msg.innerHTML = '';
        return;
    }

    var errors = [];

    // 1. Check if all items are fully allocated
    var totalPiecesOrdered = ACTIVE_PACKING_ORDER.items.reduce(function (s, it) { return s + it.qty; }, 0);
    var totalPiecesPacked = 0;
    ACTIVE_PACKING_ORDER.innerBoxes.forEach(function (ib) {
        totalPiecesPacked += ib.items.length;
    });

    if (totalPiecesPacked < totalPiecesOrdered) {
        errors.push("Shortpack: " + totalPiecesPacked + " / " + totalPiecesOrdered + " pieces allocated to inner boxes.");
    } else if (totalPiecesPacked > totalPiecesOrdered) {
        errors.push("Overpack: " + totalPiecesPacked + " / " + totalPiecesOrdered + " pieces allocated.");
    }

    // 2. Check if all inner boxes are placed in outer boxes
    var unplacedCount = ACTIVE_PACKING_ORDER.innerBoxes.filter(function (ib) { return ib.outerBoxNo === null; }).length;
    if (unplacedCount > 0) {
        errors.push(unplacedCount + " inner box(es) still unplaced in outer boxes.");
    }

    // Render result
    if (errors.length === 0) {
        msg.className = "packing-validation-msg validation-ok";
        msg.innerHTML = "✅ Verification Passed: Ready to save packing record.";
        document.getElementById('save-packing-btn').disabled = false;
    } else {
        msg.className = "packing-validation-msg validation-error";
        msg.innerHTML = "⚠️ " + errors.join(" | ");
        document.getElementById('save-packing-btn').disabled = true;
    }
}

// ----------------------------------------------------
// PRINT & SAVE API INTEGRATION
// ----------------------------------------------------

function printPackingSlip3D() {
    if (!ACTIVE_PACKING_ORDER) return;

    var printContainer = document.getElementById('print-layout');
    if (!printContainer) return;

    var rows = ACTIVE_PACKING_ORDER.outerBoxes.map(function (ob) {
        var inners = ACTIVE_PACKING_ORDER.innerBoxes.filter(function (ib) { return ib.outerBoxNo === ob.outerBoxNo; });
        var innerDetails = inners.map(function (ib) {
            var itemsTxt = ib.items.map(function (it) { return it.sku + " (" + it.dimensions.w + "x" + it.dimensions.l + "x" + it.dimensions.h + " cm)"; }).join(', ');
            return "<li><strong>" + ib.boxNo + " (" + ib.boxSize + "):</strong> " + itemsTxt + "</li>";
        }).join('');

        return '<tr>' +
            '<td><strong>' + ob.outerBoxNo + '</strong> (' + ob.boxName + ')</td>' +
            '<td><ul style="margin:0; padding-left:15px;">' + innerDetails + '</ul></td>' +
            '<td>' + ob.utilization + '%</td>' +
            '<td>' + ob.weight + ' kg</td>' +
            '</tr>';
    }).join('');

    printContainer.innerHTML = 
        '<div class="print-slip-header">' +
            '<h1>PACKING SLIP</h1>' +
            '<div><strong>Order:</strong> ' + escapeHtml(ACTIVE_PACKING_ORDER.orderNo) + ' | <strong>Packer:</strong> ' + escapeHtml(SELECTED_PACKER) + '</div>' +
        '</div>' +
        '<div><strong>Packing Date:</strong> ' + new Date().toLocaleString() + '</div>' +
        '<table class="print-table">' +
            '<thead>' +
                '<tr>' +
                    '<th>Outer Box</th>' +
                    '<th>Contains Inner Boxes & Products</th>' +
                    '<th>Utilization</th>' +
                    '<th>Est. Weight</th>' +
                '</tr>' +
            '</thead>' +
            '<tbody>' +
                rows +
            '</tbody>' +
        '</table>';

    window.print();
}

function savePackingData3D() {
    if (!ACTIVE_PACKING_ORDER) return;

    // Construct saving payload
    var itemsPayload = ACTIVE_PACKING_ORDER.items.map(function (itm) {
        var packedCount = 0;
        ACTIVE_PACKING_ORDER.innerBoxes.forEach(function (ib) {
            packedCount += ib.items.filter(function (i) { return i.sku === itm.sku; }).length;
        });

        return {
            sku: itm.sku,
            itemName: itm.itemName,
            qtyToPack: itm.qty,
            qtyPacked: packedCount
        };
    });

    var innersPayload = ACTIVE_PACKING_ORDER.innerBoxes.map(function (ib) {
        return {
            boxNo: ib.boxNo,
            boxSize: ib.boxSize,
            sku: ib.items.length > 0 ? ib.items[0].sku : "", // main SKU inside
            qty: ib.items.length,
            outerBoxNo: ib.outerBoxNo || ""
        };
    });

    var outersPayload = ACTIVE_PACKING_ORDER.outerBoxes.map(function (ob) {
        return {
            outerBoxNo: ob.outerBoxNo,
            volumeUsed: ob.volumeUsed,
            weight: ob.weight,
            dimensions: ob.dimensions
        };
    });

    var savePayload = {
        salesOrderId: ACTIVE_PACKING_ORDER.id,
        staffName: SELECTED_PACKER,
        items: itemsPayload,
        innerBoxes: innersPayload,
        outerBoxes: outersPayload
    };

    var btn = document.getElementById('save-packing-btn');
    btn.disabled = true;
    btn.innerText = "Saving plan...";

    if (!isRunningInCreator()) {
        console.log("Mock Save Packing Payload:", savePayload);
        setTimeout(function () {
            alert("Packing Configuration Saved Successfully (Simulated)!");
            btn.disabled = false;
            btn.innerText = "Check & Complete Packing";
            // Return to empty state
            ACTIVE_PACKING_ORDER = null;
            ACTIVE_PACKING_ORDER_ID = null;
            document.getElementById('packing-editor').classList.add('hidden');
            document.getElementById('packing-workspace-empty-state').classList.remove('hidden');
            loadPackingDashboardData();
        }, 1000);
        return;
    }

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'savePackingRecord',
        http_method: 'POST',
        payload: {
            payloadJson: JSON.stringify(savePayload)
        }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('savePackingRecord parse error:', e);
            alert("Error parsing save result.");
            btn.disabled = false;
            btn.innerText = "Check & Complete Packing";
            return;
        }

        if (parsed.errors && parsed.errors.length > 0) {
            alert("Save failed: " + parsed.errors.join(', '));
            btn.disabled = false;
            btn.innerText = "Check & Complete Packing";
            return;
        }

        alert("Packing Plan completed & saved successfully!");
        
        // Reset state
        ACTIVE_PACKING_ORDER = null;
        ACTIVE_PACKING_ORDER_ID = null;
        document.getElementById('packing-editor').classList.add('hidden');
        document.getElementById('packing-workspace-empty-state').classList.remove('hidden');
        
        // Refresh queue
        loadPackingDashboardData();
    }).catch(function (err) {
        console.error('savePackingRecord call failed:', err);
        btn.disabled = false;
        btn.innerText = "Check & Complete Packing";
    });
}
