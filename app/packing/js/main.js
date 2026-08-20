// Packing screen.
// Creator JS API v2, ES5-flavoured (var/function), no init()
//
// A MODULE with one exported handle, PackingScreen. It was briefly loaded by the
// finishing widget as a second tab as well; packing is its own widget now, but
// the module shape and the "pack-" id prefix are kept - they cost nothing and
// they are what made sharing a page safe when it mattered.
//
// It does NOT boot itself. widget.html calls PackingScreen.init().
//
// THE MARKUP IS ALMOST ALL BUILT HERE. widget.html carries a count line and an
// empty list; everything below is generated, which keeps the page to a dozen
// lines and the rendering in one place.
//
// ACCORDION, ONE ORDER OPEN AT A TIME. Same shape as the finishing screen's job
// cards next door and the store screen's material cards: pick a supervisor, see
// his orders, click one to open it in place. Full width matters here because the
// carton table is seven columns.
//
// WHAT THIS SCREEN IS NOT. There is no bin-packing solver and no capacity model.
// The carton list is fixed, the packer PICKS the carton, and each option names
// both cartons - the branded inner and the outer it ships inside - because one
// outer holds exactly one inner. The solver that used to be here could only
// guess: no garment dimensions exist anywhere in this app, so it fell back to
// 10 x 10 x 2 cm for every product.
//
// ONE ROW IS ONE PHYSICAL CARTON, the rule the rest of this app follows. It is
// what answers "what is in carton 3" for a customer query months later.

var PackingScreen = (function () {
    'use strict';

    var SUPERVISORS = [];
    var SELECTED_SUP = '';        // set to the first supervisor on load
    var STAFF_LIST = [];
    var SELECTED_STAFF = '';

    var QUEUE = [];

    // The same flat list for every order, straight off Packing_Inclusion.
    // Displayed only - see inclusionsSection.
    var INCLUSIONS = [];
    var ACTIVE_ORDER_ID = null;
    var ACTIVE_ORDER = null;
    // ACTIVE_ORDER = {
    //   id, orderNo, source,
    //   items:   [ { lineNo, sku, itemName, qty } ],   qty = finished pieces
    //   boxes:   [ { boxTypeId, lineNo, qty, grossWeight } ],
    //   cartons: [ { id, name, outerLength, outerWidth, outerHeight,
    //                hasInner, innerLength, innerWidth, innerHeight,
    //                volumetricWeight } ]
    // }

    var LOADING_DETAIL = false;
    var SAVING = false;
    var BOOTED = false;

    // ----------------------------------------------------
    // TABS
    //
    // Two: the job, and what was already done. Same split and the same shared
    // classes as the store screen.
    //
    // HISTORY IS LAZY and stays loaded once fetched. Arriving at the queue must
    // not pay for a list nobody has asked for, and re-fetching on every switch
    // would make a tab that is mostly read feel slower than the one that is
    // worked in. Refresh re-fetches whichever tabs have been opened.
    //
    // FILTERED IN THE WIDGET, not the query. getPackingHistory cannot filter on
    // the supervisor server-side either - it is not on the Packing record, it
    // comes off the plan - so it stamps every row with one and both ends apply
    // the same test. Changing the picker re-renders; it does not re-fetch.
    // ----------------------------------------------------
    var ACTIVE_TAB = 'queue';
    var HISTORY = [];
    var HISTORY_LOADED = false;
    var HISTORY_LOADING = false;
    var HISTORY_ERROR = '';
    var OPEN_PACKING_ID = null;

    // ----------------------------------------------------
    // HELPERS
    // ----------------------------------------------------

    function el(id) {
        return document.getElementById('pack-' + id);
    }

    function isRunningInCreator() {
        return (window.self !== window.top) && (typeof ZOHO !== 'undefined' && ZOHO.CREATOR);
    }

    function esc(str) {
        return String(str === null || str === undefined ? '' : str).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function n(v) {
        var x = Number(v);
        return isNaN(x) ? 0 : x;
    }

    function kg(v) {
        return n(v).toFixed(2);
    }

    function plural(count, word) {
        return count + ' ' + word + (count === 1 ? '' : 's');
    }

    // One place that knows a Deluge reply is only good if it says success:true.
    // Reading the wrong key is how the packing screen that used to live in the
    // finishing widget reported server failures as "saved successfully".
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

    // ----------------------------------------------------
    // BOOT
    // ----------------------------------------------------

    function init() {
        var dateEl = el('date');
        if (dateEl) {
            dateEl.innerText = new Date().toLocaleDateString('en-GB', {
                weekday: 'long', day: 'numeric', month: 'short', year: 'numeric'
            });
        }

        if (!BOOTED) {
            BOOTED = true;
            loadPeople();
            wireTabs();
        }
        loadQueue();
    }

    // Wired once. Keyed off data-packtab so the buttons, the panels and showTab
    // all agree without any of them holding a list - moving a button in the HTML
    // moves the tab and nothing here has to know.
    function wireTabs() {
        var strip = el('tab-strip');
        if (!strip) return;

        var btns = strip.querySelectorAll('.tab-btn');
        Array.prototype.forEach.call(btns, function (btn) {
            btn.addEventListener('click', function () {
                showTab(btn.getAttribute('data-packtab'));
            });
        });
    }

    function showTab(name) {
        if (!name) return;
        ACTIVE_TAB = name;

        var strip = el('tab-strip');
        if (strip) {
            Array.prototype.forEach.call(strip.querySelectorAll('.tab-btn'), function (b) {
                b.classList.toggle('is-active', b.getAttribute('data-packtab') === name);
            });
        }

        ['queue', 'history'].forEach(function (t) {
            var panel = el('panel-' + t);
            if (panel) panel.classList.toggle('is-active', t === name);
        });

        // Fetched on first open, then kept. See the note on ACTIVE_TAB.
        if (name === 'history' && !HISTORY_LOADED && !HISTORY_LOADING) {
            loadHistory();
        }
    }

    function loadPeople() {
        if (!isRunningInCreator()) {
            SUPERVISORS = [{ id: '10', name: 'Baljinder Singh' }, { id: '11', name: 'Harpreet Kaur' }];
            STAFF_LIST = [{ id: '1', name: 'Ravi' }, { id: '2', name: 'Sunita' }];
            SELECTED_STAFF = STAFF_LIST[0].name;
            renderSupervisorPicker();
            return;
        }

        callApi('getStorePackingStaff', {}).then(function (parsed) {
            SUPERVISORS = parsed.supervisors || [];
            STAFF_LIST = (parsed.staff && parsed.staff.length) ? parsed.staff : SUPERVISORS.slice();
            if (STAFF_LIST.length) SELECTED_STAFF = STAFF_LIST[0].name;
            renderSupervisorPicker();
            renderBody();
        }).catch(function (err) {
            console.error('getStorePackingStaff failed:', err);
            var sel = el('sup-select');
            if (sel) sel.innerHTML = '<option value="">Could not load staff</option>';
        });
    }

    function renderSupervisorPicker() {
        var sel = el('sup-select');
        if (!sel) return;

        if (!SUPERVISORS.length) {
            sel.innerHTML = '<option value="">No supervisors found</option>';
            return;
        }

        // The first supervisor is selected on load rather than a placeholder,
        // so the screen opens on work instead of on an empty list. Same as the
        // supervisor and finishing screens.
        if (!SELECTED_SUP) SELECTED_SUP = String(SUPERVISORS[0].id);

        sel.innerHTML = SUPERVISORS.map(function (sup) {
            return '<option value="' + esc(sup.id) + '"' +
                (String(sup.id) === String(SELECTED_SUP) ? ' selected' : '') +
                '>' + esc(sup.name) + '</option>';
        }).join('');

        sel.onchange = function () {
            SELECTED_SUP = sel.value;
            ACTIVE_ORDER_ID = null;
            ACTIVE_ORDER = null;
            // Both lists are his. Re-rendered, not re-fetched - every row already
            // carries the supervisor it belongs to, so the filter is free.
            OPEN_PACKING_ID = null;
            renderQueue();
            renderHistory();
        };
    }

    function setStaff(name) {
        SELECTED_STAFF = name;
        renderValidation();
    }

    // ----------------------------------------------------
    // QUEUE
    // ----------------------------------------------------

    function loadQueue() {
        var container = el('queue-list');

        if (!isRunningInCreator()) {
            QUEUE = [
                { id: '9001', orderNo: 'SO-00140', source: 'Shopify', supervisorId: '10', supervisorName: 'Baljinder Singh', itemCount: 1, totalPieces: 20 },
                { id: '9002', orderNo: 'SO-00002', source: 'Shopify', supervisorId: '11', supervisorName: 'Harpreet Kaur', itemCount: 2, totalPieces: 44 }
            ];
            INCLUSIONS = [{ id: '1', name: 'Thank-you card' }, { id: '2', name: 'Care card' }, { id: '3', name: 'Fabric swatch' }];
            renderQueue();
            return;
        }

        if (container) container.innerHTML = '<div class="pack-hint">Loading orders&hellip;</div>';

        callApi('getPackingQueue', {}).then(function (parsed) {
            QUEUE = parsed.orders || [];
            INCLUSIONS = parsed.inclusions || [];
            renderQueue();
        }).catch(function (err) {
            console.error('getPackingQueue failed:', err);
            if (container) container.innerHTML = '<div class="pack-hint is-bad">' + esc(err.message) + '</div>';
        });
    }

    function visibleOrders() {
        if (!SELECTED_SUP) return [];
        return QUEUE.filter(function (o) { return String(o.supervisorId) === String(SELECTED_SUP); });
    }

    function renderQueue() {
        var container = el('queue-list');
        var countEl = el('queue-count');
        var orders = visibleOrders();

        if (countEl) {
            countEl.innerText = orders.length ? plural(orders.length, 'order') + ' to pack' : '';
        }
        // The tab badge, from the list already in hand - a badge is not worth a
        // round trip of its own, which is the same rule the store strip follows.
        var qBadge = el('count-queue');
        if (qBadge) {
            qBadge.innerText = orders.length ? String(orders.length) : '';
            qBadge.classList.toggle('hidden', orders.length === 0);
        }
        if (!container) return;

        if (!orders.length) {
            container.innerHTML = '<div class="pack-hint">' +
                'Nothing waiting to be packed for this supervisor' +
                '</div>';
            return;
        }

        // Drawn with the SHARED item-card classes the supervisor and store screens
        // use - serial circle, title row, meta line, chevron - so the three lists
        // read as one product rather than three takes on a list.
        container.innerHTML = orders.map(function (o, i) {
            var open = (String(o.id) === String(ACTIVE_ORDER_ID));
            var pieces = n(o.totalPieces);

            // Amber rather than green when nothing has cleared finishing: the
            // order is in the queue but there is nothing in it to box yet, and he
            // should know that before he opens it.
            var colour = pieces > 0 ? '#059669' : '#d97706';
            var badge = pieces > 0 ? 'Ready to pack' : 'Nothing finished yet';

            return '<div class="item-card' + (open ? ' open' : '') + '">' +
                '<div class="item-header" onclick="PackingScreen.selectOrder(\'' + esc(o.id) + '\')">' +
                    '<div class="item-title-row">' +
                        '<div class="item-serial">' + (i + 1) + '</div>' +
                        '<div class="item-header-info">' +
                            '<h2>' + esc(o.orderNo || '—') + '</h2>' +
                            '<div class="item-meta-line" style="display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;">' +
                                '<span class="item-qty">' + plural(n(o.itemCount), 'line') + ' &middot; ' + pieces + ' pcs finished</span>' +
                                '<span class="item-status-badge" style="color:' + colour + '; font-weight:600; font-size:0.8rem; background:' + colour + '15; padding:0.1rem 0.5rem; border-radius:1rem;">' + badge + '</span>' +
                                (o.planNo ? '<span class="pack-plan">' + esc(o.planNo) + '</span>' : '') +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="item-header-right"><span class="chevron">' +
                        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>' +
                    '</span></div>' +
                '</div>' +
                (open ? '<div class="item-body" id="pack-body-host"></div>' : '') +
                '</div>';
        }).join('');

        if (ACTIVE_ORDER_ID) renderBody();
    }

    function selectOrder(orderId) {
        if (SAVING) return;

        // Clicking the open one closes it.
        if (String(orderId) === String(ACTIVE_ORDER_ID)) {
            ACTIVE_ORDER_ID = null;
            ACTIVE_ORDER = null;
            renderQueue();
            return;
        }

        ACTIVE_ORDER_ID = orderId;
        ACTIVE_ORDER = null;
        LOADING_DETAIL = true;
        renderQueue();

        if (!isRunningInCreator()) {
            LOADING_DETAIL = false;
            setupActiveOrder({
                salesOrderId: orderId,
                orderNo: 'SO-00140',
                source: 'Shopify',
                items: [
                    { lineNo: 1, sku: 'LN-001', itemName: 'Linen Olive Flat Sheet', qty: 20 },
                    { lineNo: 2, sku: 'LN-002', itemName: 'Linen Napkin Set', qty: 24 }
                ],
                boxes: [
                    { id: '1', name: 'Box 1', outerLength: 35, outerWidth: 35, outerHeight: 10, hasInner: true, innerLength: 32.5, innerWidth: 32.5, innerHeight: 7.5, volumetricWeight: 2.45 },
                    { id: '3', name: 'Box 3', outerLength: 35, outerWidth: 28, outerHeight: 5, hasInner: true, innerLength: 32.5, innerWidth: 26.5, innerHeight: 4, volumetricWeight: 0.98 },
                    { id: '6', name: 'Box 6', outerLength: 30, outerWidth: 58, outerHeight: 22, hasInner: false, innerLength: 0, innerWidth: 0, innerHeight: 0, volumetricWeight: 7.66 }
                ]
            });
            return;
        }

        callApi('getPackingDetails', { salesOrderId: orderId }).then(function (parsed) {
            LOADING_DETAIL = false;
            if (String(parsed.salesOrderId) !== String(ACTIVE_ORDER_ID)) return;   // he moved on
            setupActiveOrder(parsed);
        }).catch(function (err) {
            LOADING_DETAIL = false;
            console.error('getPackingDetails failed:', err);
            var host = el('body-host');
            if (host) host.innerHTML = '<div class="pack-hint is-bad">' + esc(err.message) + '</div>';
        });
    }

    function setupActiveOrder(details) {
        ACTIVE_ORDER = {
            id: details.salesOrderId,
            orderNo: details.orderNo,
            source: details.source,
            items: (details.items || []).filter(function (it) { return n(it.qty) > 0; }),
            cartons: details.boxes || [],
            boxes: []
        };
        renderBody();
    }

    // ----------------------------------------------------
    // CARTONS
    // ----------------------------------------------------

    // Pre-filled with whatever is still outstanding on the line he pressed,
    // because that is what he is about to put in the box. Everything stays
    // editable.
    function addBox(lineNo) {
        if (!ACTIVE_ORDER || !ACTIVE_ORDER.cartons.length) return;

        var target = null;

        if (lineNo !== undefined && lineNo !== null) {
            target = ACTIVE_ORDER.items.filter(function (it) { return n(it.lineNo) === n(lineNo); })[0];
        } else {
            ACTIVE_ORDER.items.forEach(function (it) {
                var left = remainingFor(it.lineNo);
                if (left > 0 && (!target || left > remainingFor(target.lineNo))) target = it;
            });
            if (!target) target = ACTIVE_ORDER.items[0];
        }
        if (!target) return;

        ACTIVE_ORDER.boxes.push({
            boxTypeId: ACTIVE_ORDER.cartons[0].id,
            lineNo: target.lineNo,
            qty: Math.max(remainingFor(target.lineNo), 1),
            grossWeight: ''
        });

        renderBody();
    }

    function removeBox(i) { if (ACTIVE_ORDER) { ACTIVE_ORDER.boxes.splice(i, 1); renderBody(); } }
    function setBoxCarton(i, v) { if (ACTIVE_ORDER) { ACTIVE_ORDER.boxes[i].boxTypeId = v; renderBody(); } }
    function setBoxLine(i, v) { if (ACTIVE_ORDER) { ACTIVE_ORDER.boxes[i].lineNo = n(v); renderBody(); } }
    function setBoxQty(i, v) { if (ACTIVE_ORDER) { ACTIVE_ORDER.boxes[i].qty = Math.max(0, Math.floor(n(v))); renderBody(); } }

    function setBoxWeight(i, v) {
        if (!ACTIVE_ORDER) return;
        // Kept as typed rather than coerced, and only the totals are re-rendered,
        // so a half-entered "1." does not jump back to 1 under the packer's
        // fingers and the field does not lose focus mid-keystroke.
        ACTIVE_ORDER.boxes[i].grossWeight = v;
        renderTotals();
    }

    function cartonById(id) {
        if (!ACTIVE_ORDER) return null;
        var hit = ACTIVE_ORDER.cartons.filter(function (c) { return String(c.id) === String(id); });
        return hit.length ? hit[0] : null;
    }

    function boxedFor(lineNo) {
        if (!ACTIVE_ORDER) return 0;
        return ACTIVE_ORDER.boxes.reduce(function (sum, b) {
            return sum + (n(b.lineNo) === n(lineNo) ? n(b.qty) : 0);
        }, 0);
    }

    function remainingFor(lineNo) {
        if (!ACTIVE_ORDER) return 0;
        var item = ACTIVE_ORDER.items.filter(function (it) { return n(it.lineNo) === n(lineNo); })[0];
        return item ? n(item.qty) - boxedFor(lineNo) : -boxedFor(lineNo);
    }

    // ----------------------------------------------------
    // RENDER — the open card's body
    // ----------------------------------------------------

    function renderBody() {
        var host = el('body-host');
        if (!host) return;

        if (LOADING_DETAIL || !ACTIVE_ORDER) {
            host.innerHTML = '<div class="pack-hint">Loading&hellip;</div>';
            return;
        }

        // ONE ANSWER, ONCE. An order with nothing finished used to render an
        // empty lines table, an empty cartons table AND a footer, each saying the
        // same thing in a different box.
        if (!ACTIVE_ORDER.items.length) {
            host.innerHTML = '<div class="pack-hint">Nothing has cleared finishing for this order yet' +
                '<span>Cartons can be packed once a finishing job closes a batch.</span></div>';
            return;
        }

        host.innerHTML = packedBySection() + linesSection() + cartonsSection() + inclusionsSection() + footerSection();
        renderTotals();
    }

    function linesSection() {
        var rows = ACTIVE_ORDER.items.map(function (it) {
            var boxed = boxedFor(it.lineNo);
            var left = n(it.qty) - boxed;
            var cls = left === 0 ? 'is-clear' : (left < 0 ? 'is-over' : 'is-open');

            return '<tr' + (left === 0 ? ' class="row-done"' : '') + '>' +
                '<td><span class="it-name">' + esc(it.itemName) + '</span>' +
                (it.sku ? '<span class="it-sku">' + esc(it.sku) + '</span>' : '') + '</td>' +
                '<td class="col-num">' + n(it.qty) + '</td>' +
                '<td class="col-num">' + boxed + '</td>' +
                '<td class="col-num"><span class="left-pill ' + cls + '">' + left + '</span></td>' +
                '<td class="col-act">' + (left > 0
                    ? '<button type="button" class="mini-btn" onclick="PackingScreen.addBox(' + n(it.lineNo) + ')">+ carton</button>'
                    : '') + '</td>' +
                '</tr>';
        }).join('');

        return '<section class="pack-sec">' +
            '<div class="pack-sec-head"><h3>To be boxed</h3><span class="pack-sec-hint">every line must reach zero</span></div>' +
            '<div class="pack-scroll"><table class="pack-tbl">' +
            '<thead><tr><th>Item</th><th class="col-num">Finished</th><th class="col-num">Boxed</th>' +
            '<th class="col-num">Left</th><th class="col-act"></th></tr></thead>' +
            '<tbody>' + rows + '</tbody></table></div></section>';
    }

    function dims(l, w, h) {
        return n(l) + ' × ' + n(w) + ' × ' + n(h);
    }

    // THE PACKER CHOOSES THE INNER BOX; THE OUTER FOLLOWS. One outer holds exactly
    // one inner, and the pairing is fixed on the Box_Master record, so the outer is
    // shown beside his choice as a DISABLED field: it is what actually ships and
    // what the courier is billed on, so hiding it would be hiding the answer - but
    // it is derived, and a field he cannot type in says that without a word.
    function cartonsSection() {
        var body;

        if (!ACTIVE_ORDER.boxes.length) {
            body = '<tr class="empty-row"><td colspan="8">No cartons yet — add one against a line above</td></tr>';
        } else {
            body = ACTIVE_ORDER.boxes.map(function (b, i) {
                var carton = cartonById(b.boxTypeId);

                // The dropdown names the INNER box and its inner dimensions,
                // because that is the carton he physically picks up. A box option
                // with no branded inner says so instead of showing a size it has
                // not got.
                var cartonOpts = ACTIVE_ORDER.cartons.map(function (c) {
                    var label = c.hasInner
                        ? esc(c.name) + ' · ' + dims(c.innerLength, c.innerWidth, c.innerHeight)
                        : esc(c.name) + ' · no inner box';
                    return '<option value="' + esc(c.id) + '"' +
                        (String(c.id) === String(b.boxTypeId) ? ' selected' : '') + '>' + label + '</option>';
                }).join('');

                var lineOpts = ACTIVE_ORDER.items.map(function (it) {
                    return '<option value="' + n(it.lineNo) + '"' + (n(it.lineNo) === n(b.lineNo) ? ' selected' : '') + '>' +
                        esc(it.itemName) + '</option>';
                }).join('');

                var outerTxt = carton ? dims(carton.outerLength, carton.outerWidth, carton.outerHeight) : '—';

                return '<tr>' +
                    '<td class="col-no"><span class="box-no">' + (i + 1) + '</span></td>' +
                    '<td class="col-carton"><select class="cell-select" onchange="PackingScreen.setBoxCarton(' + i + ', this.value)">' + cartonOpts + '</select></td>' +
                    '<td class="col-outer"><input type="text" class="cell-input is-derived" value="' + esc(outerTxt) + '" disabled title="Fixed by the inner box - one outer holds one inner"></td>' +
                    '<td class="col-item"><select class="cell-select" onchange="PackingScreen.setBoxLine(' + i + ', this.value)">' + lineOpts + '</select></td>' +
                    '<td class="col-num"><input type="number" class="cell-input" min="1" step="1" value="' + n(b.qty) + '" onchange="PackingScreen.setBoxQty(' + i + ', this.value)"></td>' +
                    '<td class="col-num"><input type="number" class="cell-input" min="0" step="0.01" placeholder="—" value="' + esc(b.grossWeight) + '" oninput="PackingScreen.setBoxWeight(' + i + ', this.value)"></td>' +
                    '<td class="col-num vol">' + kg(carton ? carton.volumetricWeight : 0) + '</td>' +
                    '<td class="col-act"><button type="button" class="x-btn" title="Remove this carton" onclick="PackingScreen.removeBox(' + i + ')">✕</button></td>' +
                    '</tr>';
            }).join('');
        }

        return '<section class="pack-sec">' +
            '<div class="pack-sec-head">' +
                '<h3>Cartons <span class="pack-sec-unit">L × W × H in cm</span></h3>' +
                '<button type="button" class="mini-btn" onclick="PackingScreen.addBox()">+ Add a carton</button>' +
            '</div>' +
            '<div class="pack-scroll"><table class="pack-tbl">' +
            '<thead><tr><th class="col-no">#</th><th class="col-carton">Inner box</th>' +
            '<th class="col-outer">Outer box</th><th class="col-item">Item</th>' +
            '<th class="col-num">Pieces</th><th class="col-num">Weight kg</th><th class="col-num">Volumetric</th>' +
            '<th class="col-act"></th></tr></thead>' +
            '<tbody>' + body + '</tbody><tfoot id="pack-boxes-tfoot"></tfoot></table></div></section>';
    }

    // ALSO IN THE BOX - the care card, the thank-you note, the swatch.
    //
    // A PLAIN LIST, NOT CHECKBOXES. Nothing here is recorded: the list is the
    // same for every order, it comes straight off Packing_Inclusion, and the save
    // payload does not carry it. Checkboxes offered a state that was thrown away
    // the moment he opened another order, which is worse than no state at all -
    // a control that looks like it remembers something and does not.
    //
    // Nothing here blocks the save either. An insert that does not apply to an
    // order is an ordinary thing.
    //
    // The whole section is skipped when no inclusions are defined, rather than
    // rendering an empty box asking him to remember nothing.
    function inclusionsSection() {
        if (!INCLUSIONS.length) return '';

        var items = INCLUSIONS.map(function (inc) {
            return '<span class="inc-item">' + esc(inc.name) + '</span>';
        }).join('');

        return '<section class="pack-sec">' +
            '<div class="pack-sec-head">' +
                '<h3>Also in the box</h3>' +
                '<span class="pack-sec-hint">put these in with the garments</span>' +
            '</div>' +
            '<div class="inc-list">' + items + '</div>' +
            '</section>';
    }

    // WHO IS PACKING IT COMES FIRST, at the top of the card. It was in the footer
    // next to the save button, which put the first thing he does at the bottom of
    // everything he does after it.
    function packedBySection() {
        var staffOpts = STAFF_LIST.map(function (s) {
            return '<option value="' + esc(s.name) + '"' + (s.name === SELECTED_STAFF ? ' selected' : '') + '>' + esc(s.name) + '</option>';
        }).join('');

        return '<div class="pack-topbar">' +
            '<label class="pack-picker"><span>Packed by</span>' +
            '<select onchange="PackingScreen.setStaff(this.value)">' +
            (staffOpts || '<option value="">No packing staff found</option>') + '</select></label>' +
            '</div>';
    }

    function footerSection() {
        return '<footer class="pack-foot">' +
            '<div class="pack-msg" id="pack-validation-msg"></div>' +
            '<button type="button" class="primary-btn" id="pack-save-btn" onclick="PackingScreen.save()">Complete packing</button>' +
            '</footer>';
    }

    // Totals and the carton note only - so typing a weight does not rebuild the
    // dropdowns the packer is working in.
    // The footnote that used to spell out the cartons in use is gone: both sets of
    // dimensions are now on the row itself, so it was saying the same thing twice.
    //
    // Column count is EIGHT - #, inner, outer, item, pieces, weight, volumetric,
    // action - and the two colspans below have to add up to it or the totals slide
    // out from under the numbers they total.
    function renderTotals() {
        var tfoot = el('boxes-tfoot');
        if (!ACTIVE_ORDER) return;

        var pieces = 0, gross = 0, vol = 0;
        ACTIVE_ORDER.boxes.forEach(function (b) {
            pieces += n(b.qty);
            gross += n(b.grossWeight);
            var c = cartonById(b.boxTypeId);
            if (c) vol += n(c.volumetricWeight);
        });

        if (tfoot) {
            tfoot.innerHTML = !ACTIVE_ORDER.boxes.length ? '' :
                '<tr><td colspan="4">' + plural(ACTIVE_ORDER.boxes.length, 'carton') + '</td>' +
                '<td class="col-num">' + pieces + '</td><td class="col-num">' + kg(gross) + '</td>' +
                '<td class="col-num">' + kg(vol) + '</td><td class="col-act"></td></tr>';
        }

        renderValidation();
    }

    // ----------------------------------------------------
    // VALIDATION
    // ----------------------------------------------------
    //
    // EVERY FINISHED PIECE MUST BE IN A CARTON before this saves. A mismatch is a
    // counting error, cheaper to find here than to have the customer find it.
    // savePackingRecord enforces the same rule server-side - a Custom API is
    // callable from anywhere, so the screen agreeing is not the same as it being
    // true.

    function problems() {
        if (!ACTIVE_ORDER) return ['No order loaded'];
        if (!ACTIVE_ORDER.items.length) return ['Nothing has cleared finishing for this order'];

        var out = [];

        ACTIVE_ORDER.items.forEach(function (it) {
            var left = n(it.qty) - boxedFor(it.lineNo);
            if (left > 0) out.push(it.itemName + ': ' + left + ' of ' + n(it.qty) + ' not in a carton');
            else if (left < 0) out.push(it.itemName + ': ' + Math.abs(left) + ' more boxed than finished');
        });

        if (!ACTIVE_ORDER.boxes.length) out.push('No cartons added yet');

        ACTIVE_ORDER.boxes.forEach(function (b, i) {
            if (n(b.qty) <= 0) out.push('Carton ' + (i + 1) + ' is empty');
            if (String(b.grossWeight).trim() === '' || n(b.grossWeight) <= 0) out.push('Carton ' + (i + 1) + ' has not been weighed');
        });

        if (!SELECTED_STAFF) out.push('Choose who packed it');

        return out;
    }

    function renderValidation() {
        var msg = el('validation-msg');
        var btn = el('save-btn');
        if (!msg) return;

        var list = problems();

        if (list.length) {
            msg.innerHTML = '<span class="bad">' + esc(list[0]) + '</span>' +
                (list.length > 1 ? ' <span class="more">and ' + (list.length - 1) + ' more</span>' : '');
            if (btn) btn.disabled = true;
        } else {
            msg.innerHTML = '<span class="ok">Every finished piece is in a carton</span>';
            if (btn) btn.disabled = false;
        }
    }

    // ----------------------------------------------------
    // SAVE
    // ----------------------------------------------------

    function save() {
        if (!ACTIVE_ORDER || SAVING) return;

        var list = problems();
        if (list.length) {
            alert('Sort these out first:\n\n' + list.join('\n'));
            return;
        }

        var btn = el('save-btn');
        SAVING = true;
        if (btn) { btn.disabled = true; btn.innerText = 'Saving…'; }

        var payload = {
            salesOrderId: ACTIVE_ORDER.id,
            staffName: SELECTED_STAFF,
            boxes: ACTIVE_ORDER.boxes.map(function (b, i) {
                var item = ACTIVE_ORDER.items.filter(function (it) { return n(it.lineNo) === n(b.lineNo); })[0] || {};
                return {
                    boxNo: i + 1,
                    boxTypeId: b.boxTypeId,
                    lineNo: b.lineNo,
                    sku: item.sku || '',
                    itemName: item.itemName || '',
                    qty: n(b.qty),
                    grossWeight: n(b.grossWeight)
                };
            })
        };

        function done() {
            SAVING = false;
            var b2 = el('save-btn');
            if (b2) { b2.disabled = false; b2.innerText = 'Complete packing'; }
        }

        if (!isRunningInCreator()) {
            console.log('Simulated save:', payload);
            setTimeout(function () { alert('Packed (simulation).'); done(); closeAndRefresh(); }, 400);
            return;
        }

        callApi('savePackingRecord', payload).then(function (parsed) {
            if (!parsed.success) throw new Error(parsed.error || 'Unknown server error.');
            // Same two figures the history card shows, and in the same order, so
            // the confirmation and the record he opens afterwards agree. The
            // server still returns chargeableWeight; it is simply not quoted.
            alert(parsed.message + '\n\nGross ' + parsed.grossWeight + ' kg, volumetric ' +
                parsed.volumetricWeight + ' kg.');
            done();
            closeAndRefresh();
        }).catch(function (err) {
            console.error('savePackingRecord failed:', err);
            alert('Could not save the packing record:\n\n' + (err && err.message ? err.message : err));
            done();
        });
    }

    function closeAndRefresh() {
        ACTIVE_ORDER_ID = null;
        ACTIVE_ORDER = null;
        loadQueue();
        // The order that just left the queue is the newest thing in the history,
        // so a stale copy would be missing the one row he most expects to see.
        // Only if he has already opened that tab - otherwise it loads on first
        // open with the new row already in it.
        if (HISTORY_LOADED) loadHistory();
    }

    // ----------------------------------------------------
    // HISTORY
    // ----------------------------------------------------

    function loadHistory() {
        var container = el('history-list');
        HISTORY_LOADING = true;
        HISTORY_ERROR = '';

        if (!isRunningInCreator()) {
            HISTORY = [{
                id: '7001', salesOrder: 'SO-00002', planNo: 'PLAN-00003',
                supervisorId: '11', supervisor: 'Harpreet Kaur', packedBy: 'Ravi',
                packedOn: '19-Aug-2026 15:20', boxCount: 2,
                grossWeight: 9.4, volumetricWeight: 12.1, chargeableWeight: 12.1,
                boxes: [
                    { boxNo: 1, carton: 'Box 3', lineNo: 1, sku: 'SKU-00002', itemName: 'Linen Liana Basket', qty: 12, grossWeight: 4.7, volumetricWeight: 6.05 },
                    { boxNo: 2, carton: 'Box 3', lineNo: 1, sku: 'SKU-00002', itemName: 'Linen Liana Basket', qty: 8, grossWeight: 4.7, volumetricWeight: 6.05 }
                ]
            }];
            HISTORY_LOADING = false;
            HISTORY_LOADED = true;
            renderHistory();
            return;
        }

        if (container) container.innerHTML = '<div class="pack-hint">Loading packed orders&hellip;</div>';

        // THE SUPERVISOR IS DELIBERATELY NOT SENT, and that is the fix for a bug
        // rather than an omission.
        //
        // It used to send SELECTED_SUP, so the server returned only that
        // supervisor's rows. Switching the picker then filtered an
        // already-narrowed list - which held nothing for anybody else - and
        // HISTORY_LOADED blocked a re-fetch, so the tab sat on "nothing packed"
        // for ever with no call going out. That is exactly what it looked like:
        // an API that was not being called.
        //
        // Fetching unfiltered costs nothing, because getPackingHistory applies
        // its "newest 50" range BEFORE the supervisor test. Sending the id never
        // gave a supervisor his own fifty - it only trimmed the same page - so
        // the coverage is identical and switching is now instant and correct.
        //
        // The server still accepts supervisorId. It is a Custom API and another
        // caller may want one supervisor; this screen is simply not that caller.
        callApi('getPackingHistory', {})
            .then(function (parsed) {
                HISTORY = parsed.packings || [];
                HISTORY_LOADING = false;
                HISTORY_LOADED = true;
                renderHistory();
            })
            .catch(function (err) {
                console.error('getPackingHistory failed:', err);
                HISTORY_LOADING = false;
                HISTORY_ERROR = (err && err.message) ? err.message : String(err);
                renderHistory();
            });
    }

    function visibleHistory() {
        if (!SELECTED_SUP) return [];
        return HISTORY.filter(function (p) {
            return String(p.supervisorId) === String(SELECTED_SUP);
        });
    }

    function toggleHistory(id) {
        OPEN_PACKING_ID = (String(OPEN_PACKING_ID) === String(id)) ? null : String(id);
        renderHistory();
    }

    function renderHistory() {
        var container = el('history-list');
        var countEl = el('history-count');
        var badge = el('count-history');
        var rows = visibleHistory();

        if (badge) {
            badge.innerText = rows.length ? String(rows.length) : '';
            badge.classList.toggle('hidden', rows.length === 0);
        }
        if (countEl) {
            countEl.innerText = rows.length ? plural(rows.length, 'order') + ' packed' : '';
        }
        if (!container) return;

        if (HISTORY_ERROR) {
            container.innerHTML = '<div class="pack-hint is-bad">' + esc(HISTORY_ERROR) + '</div>';
            return;
        }
        if (HISTORY_LOADING) {
            container.innerHTML = '<div class="pack-hint">Loading packed orders&hellip;</div>';
            return;
        }
        if (!rows.length) {
            container.innerHTML = '<div class="pack-hint">Nothing packed yet for this supervisor</div>';
            return;
        }

        // Same accordion and the same shared item-card classes as the queue above
        // and the store screen's history, so the two tabs read as one screen.
        container.innerHTML = rows.map(function (p) {
            var open = (String(p.id) === String(OPEN_PACKING_ID));

            // One row per PHYSICAL box, which is what Packed_Boxes holds and what
            // answers "what is in box 3" months later.
            var boxRows = (p.boxes || []).map(function (b) {
                return '<tr>' +
                    '<td class="col-num">' + n(b.boxNo) + '</td>' +
                    '<td>' + esc(b.carton || '') + '</td>' +
                    '<td class="material-name-cell">' +
                        '<div class="mat-name">' + esc(b.itemName || '') + '</div>' +
                        (b.sku ? '<div class="mat-sku">' + esc(b.sku) + '</div>' : '') +
                    '</td>' +
                    '<td class="col-num col-strong">' + n(b.qty) + '</td>' +
                    '<td class="col-num">' + kg(b.grossWeight) + '</td>' +
                    '<td class="col-num">' + kg(b.volumetricWeight) + '</td>' +
                    '</tr>';
            }).join('');

            // VOLUMETRIC ON THE HEADER. Chargeable used to lead here - the
            // greater of gross and volumetric, which is what the courier bills -
            // but it is a derived figure and on a garment carton it is almost
            // always just the volumetric repeated, so the card carried the same
            // number twice under two names. Volumetric is the one that is
            // measured from the carton, so it is the one shown.
            //
            // The server still returns chargeableWeight; nothing on this screen
            // reads it now, and savePackingRecord still computes it for the
            // message it returns on save.
            var meta = esc(p.packedOn || '') +
                (p.packedBy ? ' &middot; ' + esc(p.packedBy) : '') +
                ' &middot; ' + plural(n(p.boxCount), 'box');

            return '<div class="item-card' + (open ? ' open' : '') + '">' +
                '<div class="item-header" onclick="PackingScreen.toggleHistory(\'' + esc(p.id) + '\')">' +
                '<div class="item-header-info">' +
                '<h2>' + esc(p.salesOrder || '—') + '</h2>' +
                '<div class="item-meta-line"><span>' + meta + '</span></div>' +
                '</div>' +
                '<div class="item-header-right">' +
                '<span class="pack-charge">' + kg(p.volumetricWeight) +
                '<span class="unit">kg volumetric</span></span>' +
                '<span class="chevron" aria-hidden="true">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
                'stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>' +
                '</span>' +
                '</div>' +
                '</div>' +
                '<div class="item-body">' +
                // Gross stays: it is what the packer actually put on the scale,
                // the one figure here that was measured rather than derived, and
                // the only thing volumetric can be checked against.
                '<div class="pack-hist-totals">' +
                '<span>Gross <b>' + kg(p.grossWeight) + ' kg</b></span>' +
                '<span>Volumetric <b>' + kg(p.volumetricWeight) + ' kg</b></span>' +
                (p.planNo ? '<span>Plan <b>' + esc(p.planNo) + '</b></span>' : '') +
                '</div>' +
                '<div class="table-wrapper">' +
                '<table><thead><tr>' +
                '<th class="col-num">Box</th><th>Carton</th><th>Item</th>' +
                '<th class="col-num">Pieces</th><th class="col-num">Gross kg</th>' +
                '<th class="col-num">Volumetric kg</th>' +
                '</tr></thead><tbody>' + boxRows + '</tbody></table>' +
                '</div>' +
                '</div>' +
                '</div>';
        }).join('');
    }

    // Refresh reloads whichever tabs have been opened - the same rule the store
    // screen's TAB_LOADERS follow. A tab never opened costs nothing.
    function refreshAll() {
        loadQueue();
        if (HISTORY_LOADED) loadHistory();
    }

    // Only what the generated markup's onclick handlers and the host page need.
    return {
        init: init,
        refresh: refreshAll,
        showTab: showTab,
        toggleHistory: toggleHistory,
        selectOrder: selectOrder,
        setStaff: setStaff,
        addBox: addBox,
        removeBox: removeBox,
        setBoxCarton: setBoxCarton,
        setBoxLine: setBoxLine,
        setBoxQty: setBoxQty,
        setBoxWeight: setBoxWeight,
        save: save,
        // for the stub-DOM tests only
        _setHistory: function (h) { HISTORY = h; HISTORY_LOADED = true; renderHistory(); },
        _visibleHistory: visibleHistory,
        _state: function () { return ACTIVE_ORDER; },
        _setup: setupActiveOrder,
        _setQueue: function (q) { QUEUE = q; renderQueue(); },
        _setSup: function (id) { SELECTED_SUP = id; renderQueue(); },
        _visible: visibleOrders,
        _remainingFor: remainingFor
    };
})();
