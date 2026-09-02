// ---- Order Overview tab ----
//
// The supervisor's open orders, one card each, so he can decide which to
// produce next. He sees customer, expected delivery date, order status and item
// count without opening anything; a sort control re-orders the list (delivery
// date / priority / customer / status); expanding a card lazily loads that
// order's items with their status; and an "Open in Production" button on each
// card header jumps to the Production tab with that plan preselected.
//
// TWO SERVER CALLS, and the split is deliberate:
//   getSupervisorOrderOverview(supervisorId)  - the whole list in one go, plans
//       only, no Plan_Item field scan (safe at ~100 orders).
//   getOrderItemList(planId)                  - one order's items, fired ONLY
//       when he opens that card, cached for the session.
//
// ES5 to match the other supervisor tab scripts.

// planId -> { state: 'loading' | 'ok' | 'error', items: [], remakeCount: 0 }
var OV_ITEM_CACHE = {};

// Last fetched list, kept so re-sorting / filtering never re-fetches.
var OV_ORDERS = [];

// Toolbar state, remembered for the session (a supervisor change reloads the
// whole tab anyway).
var OV_SORT = 'delivery';       // 'priority' | 'delivery' | 'customer' | 'status'
var OV_QUERY = '';              // free-text filter on SO number + customer
var OV_OVERDUE_ONLY = false;    // "Overdue" toggle chip

// ---- status -> pill ----
//
// The ITEM status map is the same one production.js renderItemCard uses -
// kept in step by hand, one product across screens.
function ovItemStatus(s) {
    if (s === 'Awaiting_Material') return { text: 'No material yet', cls: 'status-partial' };
    if (s === 'Ready_For_Production') return { text: 'Ready to start', cls: 'status-sufficient' };
    if (s === 'In_Production') return { text: 'In production', cls: 'status-washing' };
    if (s === 'Awaiting_Check') return { text: 'Waiting for checking', cls: 'status-partial' };
    if (s === 'Complete') return { text: 'Completed', cls: 'status-done' };
    return { text: (s || '').replace(/_/g, ' ') || '—', cls: 'status-partial' };
}

// The ORDER (sales-order) status - spaces, printed straight from the server.
function ovOrderStatus(s) {
    if (s === 'Pending') return { text: 'Awaiting material', cls: 'status-partial' };
    if (s === 'Material Ready') return { text: 'Material ready', cls: 'status-sufficient' };
    if (s === 'Partially Received') return { text: 'Part material', cls: 'status-partial' };
    if (s === 'In Progress') return { text: 'In production', cls: 'status-washing' };
    return { text: s || '—', cls: 'status-partial' };
}

// "dd-MMM-yyyy" -> Date (local midnight), or null. Deluge sends this exact
// shape; anything else returns null so the row sorts as undated rather than
// throwing.
function ovParseDate(txt) {
    if (!txt) return null;
    var m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(txt).trim());
    if (!m) return null;
    var months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    var mi = months[m[2].toLowerCase()];
    if (mi === undefined) return null;
    return new Date(Number(m[3]), mi, Number(m[1]));
}

function ovTodayMidnight() {
    var d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function ovIsOverdue(txt) {
    var d = ovParseDate(txt);
    return d != null && d < ovTodayMidnight();
}

// ---- load ----

function loadOrderOverview() {
    var panel = document.getElementById('panel-order-overview');
    var supId = currentSupervisorId();

    if (!supId) {
        panel.innerHTML = '<div class="panel-placeholder"><h2>Choose a supervisor</h2>' +
            '<p>Pick who you are from the header to see your orders.</p></div>';
        return;
    }

    panel.innerHTML = '<div class="panel-loading">Loading your orders…</div>';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getSupervisorOrderOverview',
        http_method: 'POST',
        payload: { supervisorId: String(supId) }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('getSupervisorOrderOverview parse failed:', e, response.result);
            panel.innerHTML = '<div class="panel-placeholder"><h2>Could not read the list</h2>' +
                '<p>Check the browser console.</p></div>';
            return;
        }
        if (parsed.errors && parsed.errors.length > 0) {
            panel.innerHTML = '<div class="panel-placeholder"><h2>Could not load your orders</h2>' +
                '<p>' + escapeHtml(parsed.errors.join(' ')) + '</p></div>';
            return;
        }
        OV_ORDERS = parsed.orders || [];
        // A fresh list - drop item caches so a re-opened accordion re-reads
        // (statuses move while he is on other tabs).
        OV_ITEM_CACHE = {};
        renderOrderOverview();
    }).catch(function (err) {
        console.error('getSupervisorOrderOverview error:', err);
        panel.innerHTML = '<div class="panel-placeholder"><h2>Failed to load</h2>' +
            '<p>Check the browser console.</p></div>';
    });
}

// ---- filter + sort ----

// Free-text match on SO number and customer name. Case-insensitive, substring.
function ovMatchesQuery(o, q) {
    if (!q) return true;
    var hay = ((o.salesOrder || '') + ' ' + (o.customerPerson || '')).toLowerCase();
    return hay.indexOf(q) !== -1;
}

// What is actually drawn: OV_ORDERS filtered by the search box + the overdue
// chip, then sorted. Everything client-side - the whole list is in hand.
function ovVisibleOrders() {
    var q = OV_QUERY.trim().toLowerCase();
    var list = OV_ORDERS.filter(function (o) {
        if (!ovMatchesQuery(o, q)) return false;
        if (OV_OVERDUE_ONLY && !ovIsOverdue(o.deliveryDate)) return false;
        return true;
    });
    return ovSortOrders(list);
}

function ovSortOrders(input) {
    var list = input.slice();

    if (OV_SORT === 'priority') {
        list.sort(function (a, b) {
            return (Number(a.priorityKey) || 0) - (Number(b.priorityKey) || 0);
        });
    } else if (OV_SORT === 'customer') {
        list.sort(function (a, b) {
            var an = (a.customerPerson || '').toLowerCase();
            var bn = (b.customerPerson || '').toLowerCase();
            // Blank customer sorts last.
            if (an === '' && bn !== '') return 1;
            if (bn === '' && an !== '') return -1;
            if (an !== bn) return an < bn ? -1 : 1;
            // Tiebreak: soonest delivery first within one customer.
            return ovDateRank(a) - ovDateRank(b);
        });
    } else if (OV_SORT === 'status') {
        var rank = { 'Pending': 0, 'Material Ready': 1, 'Partially Received': 2, 'In Progress': 3 };
        list.sort(function (a, b) {
            var ar = rank[a.orderStatus];
            var br = rank[b.orderStatus];
            if (ar === undefined) ar = 9;
            if (br === undefined) br = 9;
            if (ar !== br) return ar - br;
            return (Number(a.priorityKey) || 0) - (Number(b.priorityKey) || 0);
        });
    } else {
        // 'delivery' (default) - soonest first, undated last (by priority among
        // themselves).
        list.sort(function (a, b) {
            var ad = ovParseDate(a.deliveryDate);
            var bd = ovParseDate(b.deliveryDate);
            if (ad && bd) return ad - bd;
            if (ad && !bd) return -1;
            if (bd && !ad) return 1;
            return (Number(a.priorityKey) || 0) - (Number(b.priorityKey) || 0);
        });
    }
    return list;
}

// A big number for an undated order, so it sorts after every dated one.
function ovDateRank(o) {
    var d = ovParseDate(o.deliveryDate);
    return d ? d.getTime() : 8.64e15;
}

function onOvSort(key) {
    if (!key || key === OV_SORT) return;
    OV_SORT = key;
    ovRerender();
}

function onOvSearch(v) {
    OV_QUERY = v || '';
    ovRerender(true);
}

function onOvClearSearch() {
    OV_QUERY = '';
    ovRerender();
}

function onOvOverdueToggle() {
    OV_OVERDUE_ONLY = !OV_OVERDUE_ONLY;
    ovRerender();
}

// Re-render, optionally keeping focus in the search box (typing must not lose
// the caret when the list under it redraws).
function ovRerender(keepSearchFocus) {
    var caret = null;
    if (keepSearchFocus) {
        var box0 = document.getElementById('ov-search');
        if (box0) caret = box0.selectionStart;
    }
    renderOrderOverview();
    if (keepSearchFocus) {
        var box = document.getElementById('ov-search');
        if (box) {
            box.focus();
            if (caret != null) {
                try { box.setSelectionRange(caret, caret); } catch (e) {}
            }
        }
    }
}

// ---- render ----

function ovToolbarHtml(shownCount) {
    var total = OV_ORDERS.length;

    // Search box (left). Filters SO number + customer, live.
    var clearBtn = OV_QUERY
        ? '<button type="button" class="ov-search-clear" onclick="onOvClearSearch()" aria-label="Clear search">&times;</button>'
        : '';
    var search =
        '<div class="ov-search-wrap">' +
            '<span class="ov-search-icn" aria-hidden="true">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/>' +
            '<path d="M21 21l-4.5-4.5"/></svg></span>' +
            '<input type="text" id="ov-search" class="ov-search-input" ' +
            'placeholder="Search order or customer" value="' + escapeHtml(OV_QUERY) + '" ' +
            'oninput="onOvSearch(this.value)">' +
            clearBtn +
        '</div>';

    // Overdue chip.
    var chip = '<button type="button" class="ov-chip' +
        (OV_OVERDUE_ONLY ? ' is-on' : '') +
        '" onclick="onOvOverdueToggle()">Overdue only</button>';

    // Sort as small text links (right).
    var opts = [
        ['priority', 'Default'],
        ['delivery', 'Delivery'],
        ['customer', 'Customer'],
        ['status', 'Status']
    ];
    var links = opts.map(function (o) {
        return '<button type="button" class="ov-sort-link' +
            (o[0] === OV_SORT ? ' is-active' : '') +
            '" onclick="onOvSort(\'' + o[0] + '\')">' + escapeHtml(o[1]) + '</button>';
    }).join('<span class="ov-sort-sep">&middot;</span>');

    // Count - "N of M" when a filter is narrowing it, else the plain total.
    var countTxt = (OV_QUERY || OV_OVERDUE_ONLY)
        ? shownCount + ' of ' + total + ' order' + (total === 1 ? '' : 's')
        : total + ' open order' + (total === 1 ? '' : 's');

    return '<div class="ov-toolbar">' +
        '<div class="ov-toolbar-left">' + search + chip + '</div>' +
        '<div class="ov-toolbar-right">' +
            '<span class="ov-sort-label">Sort by</span>' + links +
            '<span class="ov-count">' + countTxt + '</span>' +
        '</div>' +
        '</div>';
}

function renderOrderOverview() {
    var panel = document.getElementById('panel-order-overview');
    setTabCount('count-order-overview', OV_ORDERS.length);

    if (OV_ORDERS.length === 0) {
        panel.innerHTML = '<div class="panel-placeholder"><h2>No open orders</h2>' +
            '<p>Nothing assigned to you is awaiting material or in production.</p></div>';
        return;
    }

    var orders = ovVisibleOrders();
    var toolbar = ovToolbarHtml(orders.length);

    if (orders.length === 0) {
        // The list has orders, but the search / overdue filter matched none.
        panel.innerHTML = toolbar +
            '<div class="panel-placeholder"><h2>No orders match</h2>' +
            '<p>Clear the search or the Overdue filter to see all ' +
            OV_ORDERS.length + '.</p></div>';
        return;
    }

    var cards = orders.map(function (o, idx) {
        var itemN = Number(o.itemCount) || 0;

        // One line, thin rule between the three fields - readable without
        // eating vertical space on a scan list. Label in small grey caps,
        // value in normal text right after it.
        var meta =
            '<span class="ov-meta-cell"><span class="ov-meta-k">Customer</span> ' +
                escapeHtml(o.customerPerson || '—') + '</span>' +
            '<span class="ov-meta-cell"><span class="ov-meta-k">Delivery</span> ' +
                (o.deliveryDate ? escapeHtml(o.deliveryDate) : 'not set') + '</span>' +
            '<span class="ov-meta-cell"><span class="ov-meta-k">Items</span> ' +
                itemN + '</span>';

        // Title: sales order, with the plan number in parens (same as the
        // Production tab's plan picker).
        var title = escapeHtml(o.salesOrder || o.planNo || 'Order');
        if (o.salesOrder && o.planNo) {
            title += ' <span class="ov-plan-no">(' + escapeHtml(o.planNo) + ')</span>';
        }

        var pills = '';
        if (ovIsOverdue(o.deliveryDate)) {
            pills += '<span class="status-pill status-shortfall">Overdue</span>';
        }
        var os = ovOrderStatus(o.orderStatus);
        pills += '<span class="status-pill ' + os.cls + '">' + escapeHtml(os.text) + '</span>';

        // planId is safe to inline single-quoted - it is a numeric record id.
        var jumpBtn = '<button type="button" class="raise-btn ov-jump-btn" ' +
            'onclick="ovOpenInProduction(event, \'' + o.planId + '\')">Open in Production</button>';

        return '<div class="item-card ov-order-card" id="ov-card-' + idx + '" data-plan="' + o.planId + '">' +
            '<div class="item-header" onclick="toggleOvOrder(' + idx + ')">' +
                '<div class="item-header-info">' +
                    '<h2>' + title + '</h2>' +
                    '<div class="item-meta-line ov-meta-row">' + meta + '</div>' +
                '</div>' +
                '<div class="item-header-right">' +
                    pills + jumpBtn +
                    '<span class="chevron" aria-hidden="true">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
                    'stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>' +
                    '</span>' +
                '</div>' +
            '</div>' +
            '<div class="item-body" id="ov-body-' + idx + '">' +
                ovBodyHtml(o.planId) +
            '</div>' +
        '</div>';
    }).join('');

    panel.innerHTML = toolbar + cards;
}

// The body content for one order, from whatever is in the cache right now.
function ovBodyHtml(planId) {
    var hit = OV_ITEM_CACHE[planId];
    if (!hit || hit.state === 'loading') {
        return '<div class="panel-loading">Loading items…</div>';
    }
    if (hit.state === 'error') {
        return '<div class="bd-empty">Could not load the items. ' +
            '<button type="button" class="raise-btn is-stale" ' +
            'onclick="ovRetryItems(\'' + planId + '\')">Retry</button></div>';
    }

    var items = hit.items || [];
    if (items.length === 0) {
        return '<div class="bd-empty">No items on this order.</div>';
    }

    var rows = items.map(function (it) {
        var st = ovItemStatus(it.status);
        return '<tr>' +
            '<td class="material-name-cell"><div class="mat-name">' + escapeHtml(it.name || '—') + '</div></td>' +
            '<td class="col-num col-strong">' + fmt(it.qty) +
                '<span class="unit"> pcs</span></td>' +
            '<td><span class="status-pill ' + st.cls + '">' + escapeHtml(st.text) + '</span></td>' +
        '</tr>';
    }).join('');

    var note = '';
    if (Number(hit.remakeCount) > 0) {
        note = '<div class="section-note">+ ' + hit.remakeCount + ' remake batch' +
            (Number(hit.remakeCount) === 1 ? '' : 'es') +
            ' in progress &mdash; see the Production tab.</div>';
    }

    return '<div class="tables-container"><div class="table-wrapper"><table>' +
        '<thead><tr><th>Item</th><th class="col-num">To produce</th><th>Status</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>' + note + '</div>';
}

// ---- expand / lazy load ----

function toggleOvOrder(i) {
    var card = document.getElementById('ov-card-' + i);
    if (!card) return;
    var opening = !card.classList.contains('open');
    card.classList.toggle('open');
    if (!opening) return;

    var planId = card.getAttribute('data-plan');
    if (OV_ITEM_CACHE[planId] && OV_ITEM_CACHE[planId].state === 'ok') return;

    ovFetchItems(planId, i);
}

function ovRetryItems(planId) {
    // Find the card index for this plan so the right body re-renders.
    var card = document.querySelector('.ov-order-card[data-plan="' + planId + '"]');
    if (!card) return;
    var i = Number(card.id.replace('ov-card-', ''));
    ovFetchItems(planId, i);
}

function ovFetchItems(planId, cardIdx) {
    OV_ITEM_CACHE[planId] = { state: 'loading', items: [], remakeCount: 0 };
    var body = document.getElementById('ov-body-' + cardIdx);
    if (body) body.innerHTML = ovBodyHtml(planId);

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getOrderItemList',
        http_method: 'POST',
        payload: { planId: String(planId) }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('getOrderItemList parse failed:', e, response.result);
            OV_ITEM_CACHE[planId] = { state: 'error', items: [], remakeCount: 0 };
            ovRefreshBody(planId);
            return;
        }
        if (parsed.errors && parsed.errors.length > 0) {
            console.warn('getOrderItemList:', parsed.errors);
            OV_ITEM_CACHE[planId] = { state: 'error', items: [], remakeCount: 0 };
        } else {
            OV_ITEM_CACHE[planId] = {
                state: 'ok',
                items: parsed.items || [],
                remakeCount: Number(parsed.remakeCount) || 0
            };
        }
        ovRefreshBody(planId);
    }).catch(function (err) {
        console.error('getOrderItemList error:', err);
        OV_ITEM_CACHE[planId] = { state: 'error', items: [], remakeCount: 0 };
        ovRefreshBody(planId);
    });
}

// Re-render just the one order's body from the cache - the card index is looked
// up fresh because a re-sort may have moved it.
function ovRefreshBody(planId) {
    var card = document.querySelector('.ov-order-card[data-plan="' + planId + '"]');
    if (!card) return;
    var body = card.querySelector('.item-body');
    if (body) body.innerHTML = ovBodyHtml(planId);
}

// ---- cross-tab jump ----

function ovOpenInProduction(ev, planId) {
    if (ev && ev.stopPropagation) ev.stopPropagation();

    // The Production loader reads this on its next run (covers "production tab
    // not opened yet"); productionSelectPlan covers "already loaded".
    window.__ovJumpPlanId = String(planId);
    showTab('production');
    if (tabsLoaded.production && typeof productionSelectPlan === 'function') {
        productionSelectPlan(planId);
    }
}

// Lazy tab - shell.js calls this on first open, on Refresh, and on supervisor
// change. No boot self-run.
TAB_LOADERS['order-overview'] = loadOrderOverview;
