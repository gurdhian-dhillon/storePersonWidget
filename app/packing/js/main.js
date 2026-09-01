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
// his orders, click one to open it in place.
//
// A BOX IS A CARD, NOT A TABLE ROW, and that is the shape of this screen now.
// A box carries its own carton, its own six dimensions, whether an inner carton
// went in, three weights AND a list of the items inside it. That is two grains,
// and a table can only draw one - the row either repeats per item and lies about
// the weights, or it holds one item and cannot hold two. So the box is a card
// with a small table of contents inside it.
//
// THE CARTON IS AUTOFILL. Picking one from Box_Master seeds the six dimension
// fields and stops there; every one of them stays editable, and what is left in
// them is what gets stored and what the volumetric weight is computed from. The
// catalogue is a starting point, not a claim about the box on the bench.
//
// THE INNER CARTON IS OPTIONAL, PER BOX. Some orders ship in the outer alone.
// Has_Inner_Carton on the catalogue row only decides whether the inner fields
// are seeded when a carton is picked.
//
// WHAT THIS SCREEN IS NOT. There is no bin-packing solver and no capacity model.
// The packer knows what fits. The solver that used to be here could only guess:
// no garment dimensions exist anywhere in this app, so it fell back to
// 10 x 10 x 2 cm for every product.

var PackingScreen = (function () {
    'use strict';

    // Volumetric divisor - what FedEx and Blue Dart bill express shipments at.
    // It lives HERE (live, as he types a dimension) and in savePackingRecord
    // (authoritative, from the dimensions actually stored) and nowhere else. Air
    // freight uses 6000 and some domestic surface 4000.
    var VOL_DIVISOR = 5000;

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
    //   items:   [ { lineNo, sku, itemName, qty, unitWeight } ]  qty = finished
    //   cartons: [ { id, name, outerLength, outerWidth, outerHeight,
    //                hasInner, innerLength, innerWidth, innerHeight } ]
    //   boxes:   [ { boxTypeId, usesInner,
    //                innerLength, innerWidth, innerHeight,
    //                outerLength, outerWidth, outerHeight,
    //                grossWeight,
    //                items: [ { lineNo, qty } ] } ]
    // }
    //
    // Every editable number on a box is held AS TYPED, as a string. Coercing on
    // each keystroke makes a half-entered "32." jump back to 32 under the
    // packer's fingers; n() is applied when it is read, not when it is stored.

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

    // packingId -> { state: 'loading'|'ok'|'error', urls: [...] }. Box_Images is a
    // multi-image field on the parent Packing record; getPackingHistory only
    // sends imageCount, and the URLs are fetched lazily with getRecords when a
    // history card is opened.
    var PHOTO_CACHE = {};
    var CREATOR_ORIGIN = (function () {
        try { return new URL(document.referrer).origin; } catch (e) { return ''; }
    })();

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

    // A weight of zero is not "0.00 kg", it is "we do not know". Item_Master
    // carries no weight for every product yet, and printing a confident zero
    // beside a measured figure invites the packer to reconcile them.
    function kgOrDash(v) {
        return n(v) > 0 ? n(v).toFixed(2) : '—';
    }

    // "box" is the word this screen says most often and it is the one an "add an
    // s" pluraliser gets wrong.
    function plural(count, word) {
        if (count === 1) return count + ' ' + word;
        var tail = /(x|s|ch|sh)$/.test(word) ? 'es' : 's';
        return count + ' ' + word + tail;
    }

    // Trailing zeroes off a dimension - 35.00 is a carton nobody measured that
    // precisely, and the six of them across two rows are the busiest numbers on
    // the card.
    function cm(v) {
        var x = n(v);
        return x % 1 === 0 ? String(x) : String(Math.round(x * 100) / 100);
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
                    { lineNo: 1, sku: 'LN-001', itemName: 'Linen Olive Flat Sheet', qty: 20, unitWeight: 0.85 },
                    { lineNo: 2, sku: 'LN-002', itemName: 'Linen Napkin Set', qty: 24, unitWeight: 0.32 }
                ],
                boxes: [
                    { id: '1', name: 'Box 1', outerLength: 35, outerWidth: 35, outerHeight: 10, hasInner: true, innerLength: 32.5, innerWidth: 32.5, innerHeight: 7.5, outerWeight: 0.35, innerWeight: 0.15 },
                    { id: '3', name: 'Box 3', outerLength: 35, outerWidth: 28, outerHeight: 5, hasInner: true, innerLength: 32.5, innerWidth: 26.5, innerHeight: 4, outerWeight: 0.25, innerWeight: 0.10 },
                    { id: '6', name: 'Box 6', outerLength: 30, outerWidth: 58, outerHeight: 22, hasInner: false, innerLength: 0, innerWidth: 0, innerHeight: 0, outerWeight: 0.50, innerWeight: 0.00 }
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
    // BOXES
    // ----------------------------------------------------

    function cartonById(id) {
        if (!ACTIVE_ORDER) return null;
        var hit = ACTIVE_ORDER.cartons.filter(function (c) { return String(c.id) === String(id); });
        return hit.length ? hit[0] : null;
    }

    // The carton's six numbers and two weights, copied onto the box. From here on
    // they belong to the box: editing one changes this box and nothing else, and
    // Box_Master is never written back to.
    function applyCartonTo(box, carton) {
        if (!carton) return;
        box.boxTypeId = carton.id;
        box.outerLength = cm(carton.outerLength);
        box.outerWidth = cm(carton.outerWidth);
        box.outerHeight = cm(carton.outerHeight);
        box.outerWeight = carton.outerWeight !== undefined ? cm(carton.outerWeight) : '0';
        box.usesInner = !!carton.hasInner;
        box.innerLength = carton.hasInner ? cm(carton.innerLength) : '';
        box.innerWidth = carton.hasInner ? cm(carton.innerWidth) : '';
        box.innerHeight = carton.hasInner ? cm(carton.innerHeight) : '';
        box.innerWeight = (carton.hasInner && carton.innerWeight !== undefined) ? cm(carton.innerWeight) : '';

        // Auto-populate actual weight
        if (!box.grossWeightEdited) {
            box.grossWeight = kg(estimatedFor(box));
        }
    }

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

        var box = {
            grossWeight: '', grossWeightEdited: false,
            imageFiles: [], imagePreviewUrls: [],
            items: [{ lineNo: target.lineNo, qty: Math.max(remainingFor(target.lineNo), 1) }]
        };
        applyCartonTo(box, ACTIVE_ORDER.cartons[0]);
        ACTIVE_ORDER.boxes.push(box);

        renderBody();
    }

    function removeBox(i) {
        if (!ACTIVE_ORDER) return;
        var box = ACTIVE_ORDER.boxes[i];
        if (box && box.imagePreviewUrls) {
            box.imagePreviewUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
        }
        ACTIVE_ORDER.boxes.splice(i, 1);
        renderBody();
    }

    // Changing the carton re-seeds all six dimensions, the two carton weights,
    // and the inner/outer choice. It is the one control on the card that is
    // allowed to overwrite what he typed, because picking a different carton is
    // saying the box is a different box.
    function setBoxCarton(i, v) {
        if (!ACTIVE_ORDER) return;
        var box = ACTIVE_ORDER.boxes[i];
        box.grossWeightEdited = false; // Reset override on carton change
        applyCartonTo(box, cartonById(v));
        renderBody();
    }

    // Outer only clears the inner dimensions and inner weight rather than hiding
    // them - the record has to say what went out, and zeroes left behind a
    // disabled field are the kind of thing that turns up on a packing list a
    // year later.
    function setBoxPackaging(i, v) {
        if (!ACTIVE_ORDER) return;
        var box = ACTIVE_ORDER.boxes[i];
        var carton = cartonById(box.boxTypeId);

        if (v === 'both') {
            box.usesInner = true;
            // Re-seeded only from a carton that HAS an inner size on file. A
            // carton with none would seed three zeroes, which look filled in and
            // are not - he types the size of whatever inner he actually used.
            if (!n(box.innerLength) && carton && carton.hasInner) {
                box.innerLength = cm(carton.innerLength);
                box.innerWidth = cm(carton.innerWidth);
                box.innerHeight = cm(carton.innerHeight);
            }
            if (!n(box.innerWeight) && carton && carton.hasInner) {
                box.innerWeight = cm(carton.innerWeight || 0);
            }
        } else {
            box.usesInner = false;
            box.innerLength = '';
            box.innerWidth = '';
            box.innerHeight = '';
            box.innerWeight = '';
        }
        if (!box.grossWeightEdited) {
            box.grossWeight = kg(estimatedFor(box));
        }
        renderBody();
    }

    // Dimensions and weights are LIVE - stored as typed and only the derived
    // numbers redrawn, so a half-entered "32." does not jump back to 32 under the
    // packer's fingers and the field does not lose focus mid-keystroke.
    function setBoxDim(i, field, v) {
        if (!ACTIVE_ORDER) return;
        var box = ACTIVE_ORDER.boxes[i];
        box[field] = v;
        if (!box.grossWeightEdited) {
            box.grossWeight = kg(estimatedFor(box));
        }
        renderLive();
    }

    function setBoxWeight(i, v) {
        if (!ACTIVE_ORDER) return;
        var box = ACTIVE_ORDER.boxes[i];
        box.grossWeight = v;
        box.grossWeightEdited = true; // Mark as manually overridden
        renderLive();
    }

    function setBoxCartonWeight(i, prefix, v) {
        if (!ACTIVE_ORDER) return;
        var box = ACTIVE_ORDER.boxes[i];
        box[prefix + 'Weight'] = v;
        if (!box.grossWeightEdited) {
            box.grossWeight = kg(estimatedFor(box));
        }
        renderLive();
    }

    // ----------------------------------------------------
    // WHAT IS IN A BOX
    // ----------------------------------------------------

    function addItem(i) {
        if (!ACTIVE_ORDER) return;
        var box = ACTIVE_ORDER.boxes[i];
        var inBox = box.items.map(function (it) { return n(it.lineNo); });

        var free = ACTIVE_ORDER.items.filter(function (it) { return inBox.indexOf(n(it.lineNo)) === -1; });
        if (!free.length) return;

        // The line with most still to box, so the pre-filled quantity is the one
        // he is most likely to want.
        var pick = free[0];
        free.forEach(function (it) {
            if (remainingFor(it.lineNo) > remainingFor(pick.lineNo)) pick = it;
        });

        box.items.push({ lineNo: pick.lineNo, qty: Math.max(remainingFor(pick.lineNo), 1) });
        if (!box.grossWeightEdited) {
            box.grossWeight = kg(estimatedFor(box));
        }
        renderBody();
    }

    function removeItem(i, j) {
        if (!ACTIVE_ORDER) return;
        var box = ACTIVE_ORDER.boxes[i];
        box.items.splice(j, 1);
        if (!box.grossWeightEdited) {
            box.grossWeight = kg(estimatedFor(box));
        }
        renderBody();
    }

    // Moving an item onto a line the box already holds would give one box two
    // rows for one product; they are merged instead of refused, because that is
    // what he meant.
    function setItemLine(i, j, v) {
        if (!ACTIVE_ORDER) return;
        var box = ACTIVE_ORDER.boxes[i];
        var newLine = n(v);

        var dupe = -1;
        box.items.forEach(function (it, k) {
            if (k !== j && n(it.lineNo) === newLine) dupe = k;
        });

        if (dupe > -1) {
            box.items[dupe].qty = n(box.items[dupe].qty) + n(box.items[j].qty);
            box.items.splice(j, 1);
        } else {
            box.items[j].lineNo = newLine;
        }
        if (!box.grossWeightEdited) {
            box.grossWeight = kg(estimatedFor(box));
        }
        renderBody();
    }

    function setItemQty(i, j, v) {
        if (!ACTIVE_ORDER) return;
        var box = ACTIVE_ORDER.boxes[i];
        box.items[j].qty = v;
        if (!box.grossWeightEdited) {
            box.grossWeight = kg(estimatedFor(box));
        }
        renderLive();
    }

    // Box photos are held as File objects on the box until the record is saved,
    // then every box's photos are uploaded to the parent Packing.Box_Images
    // multi-image field. Previews are object URLs, revoked as they go.
    function addBoxImages(i, fileList) {
        if (!ACTIVE_ORDER) return;
        var box = ACTIVE_ORDER.boxes[i];
        if (!box.imageFiles) { box.imageFiles = []; box.imagePreviewUrls = []; }
        Array.prototype.slice.call(fileList || []).forEach(function (f) {
            if (!f) return;
            if (f.type && f.type.indexOf('image/') !== 0) return;
            box.imageFiles.push(f);
            box.imagePreviewUrls.push(URL.createObjectURL(f));
        });
        renderBody();
    }

    function removeBoxImage(i, k) {
        if (!ACTIVE_ORDER) return;
        var box = ACTIVE_ORDER.boxes[i];
        if (!box || !box.imageFiles || k < 0 || k >= box.imageFiles.length) return;
        try { URL.revokeObjectURL(box.imagePreviewUrls[k]); } catch (e) {}
        box.imageFiles.splice(k, 1);
        box.imagePreviewUrls.splice(k, 1);
        renderBody();
    }

    // ----------------------------------------------------
    // THE NUMBERS
    // ----------------------------------------------------

    function unitWeightFor(lineNo) {
        if (!ACTIVE_ORDER) return 0;
        var item = ACTIVE_ORDER.items.filter(function (it) { return n(it.lineNo) === n(lineNo); })[0];
        return item ? n(item.unitWeight) : 0;
    }

    function boxedFor(lineNo) {
        if (!ACTIVE_ORDER) return 0;
        var total = 0;
        ACTIVE_ORDER.boxes.forEach(function (b) {
            b.items.forEach(function (it) {
                if (n(it.lineNo) === n(lineNo)) total += n(it.qty);
            });
        });
        return total;
    }

    function remainingFor(lineNo) {
        if (!ACTIVE_ORDER) return 0;
        var item = ACTIVE_ORDER.items.filter(function (it) { return n(it.lineNo) === n(lineNo); })[0];
        return item ? n(item.qty) - boxedFor(lineNo) : -boxedFor(lineNo);
    }

    function piecesIn(box) {
        return box.items.reduce(function (sum, it) { return sum + n(it.qty); }, 0);
    }

    // ESTIMATED WEIGHT is Item_Master.Weight, kilograms for one saleable unit,
    // times the pieces in the box plus the outer carton weight and optionally
    // the inner packaging weight.
    function estimatedFor(box) {
        var itemsEst = box.items.reduce(function (sum, it) {
            return sum + unitWeightFor(it.lineNo) * n(it.qty);
        }, 0);
        var boxEst = n(box.outerWeight) + (box.usesInner ? n(box.innerWeight) : 0);
        return itemsEst + boxEst;
    }

    function volumetricFor(box) {
        return (n(box.outerLength) * n(box.outerWidth) * n(box.outerHeight)) / VOL_DIVISOR;
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

        host.innerHTML = packedBySection() + linesSection() + boxesSection() + inclusionsSection() + footerSection();
        renderLive();
    }

    function linesSection() {
        var rows = ACTIVE_ORDER.items.map(function (it) {
            var wt = unitWeightFor(it.lineNo);

            return '<tr id="pack-line-' + n(it.lineNo) + '">' +
                '<td><span class="it-name">' + esc(it.itemName) + '</span>' +
                (it.sku ? '<span class="it-sku">' + esc(it.sku) + '</span>' : '') + '</td>' +
                '<td class="col-num">' + (wt > 0 ? kg(wt) : '—') + '</td>' +
                '<td class="col-num">' + n(it.qty) + '</td>' +
                '<td class="col-num" id="pack-boxed-' + n(it.lineNo) + '">0</td>' +
                '<td class="col-num"><span class="left-pill" id="pack-left-' + n(it.lineNo) + '">0</span></td>' +
                '<td class="col-act" id="pack-lineact-' + n(it.lineNo) + '"></td>' +
                '</tr>';
        }).join('');

        return '<section class="pack-sec">' +
            '<div class="pack-sec-head"><h3>To be boxed</h3><span class="pack-sec-hint">every line must reach zero</span></div>' +
            '<div class="pack-scroll"><table class="pack-tbl">' +
            '<thead><tr><th>Item</th><th class="col-num">Unit kg</th><th class="col-num">Finished</th>' +
            '<th class="col-num">Boxed</th><th class="col-num">Left</th><th class="col-act"></th></tr></thead>' +
            '<tbody>' + rows + '</tbody></table></div></section>';
    }

    function dims(l, w, h) {
        return cm(l) + ' × ' + cm(w) + ' × ' + cm(h);
    }

    // One dimension row - three inputs and the two multiplication signs between
    // them. Sizes are always Length × Width on this app's screens; height follows.
    function dimRow(i, label, prefix, disabled) {
        var box = ACTIVE_ORDER.boxes[i];
        var off = disabled ? ' disabled' : '';

        function field(part, title) {
            return '<input type="number" class="dim-input' + (disabled ? ' is-derived' : '') + '" min="0" step="0.1"' +
                ' aria-label="' + esc(label + ' ' + title) + '" title="' + esc(title) + '"' +
                ' value="' + esc(box[prefix + part] === undefined ? '' : box[prefix + part]) + '"' +
                ' oninput="PackingScreen.setBoxDim(' + i + ', \'' + prefix + part + '\', this.value)"' + off + '>';
        }

        var wtVal = (box[prefix + 'Weight'] === undefined || box[prefix + 'Weight'] === null) ? '' : box[prefix + 'Weight'];
        var wtField = '<input type="number" class="dim-input' + (disabled ? ' is-derived' : '') + '" min="0" step="0.01"' +
            ' aria-label="' + esc(label + ' Weight') + '" title="' + esc(label + ' Weight') + '"' +
            ' value="' + esc(wtVal) + '"' +
            ' oninput="PackingScreen.setBoxCartonWeight(' + i + ', \'' + prefix + '\', this.value)"' + off + '>' +
            '<span class="dim-unit">kg</span>';

        return '<div class="dim-row">' +
            '<span class="dim-label">' + esc(label) + '</span>' +
            field('Length', 'Length') + '<span class="dim-x">×</span>' +
            field('Width', 'Width') + '<span class="dim-x">×</span>' +
            field('Height', 'Height') +
            '<span class="dim-unit">cm</span>' +
            wtField +
            (disabled ? '<span class="dim-note">no inner carton used</span>' : '') +
            '</div>';
    }

    // A BOX IS A CARD, IN TWO COLUMNS.
    //
    //   left   what the box IS   - carton, packaging, the six dimensions
    //   right  what is IN it     - the contents table
    //   under  what it WEIGHS    - estimated and volumetric derived, actual typed
    //
    // The two columns are capped rather than stretched. Everything on this card
    // was one full-width row each to begin with, which on a wide screen put a
    // 900-pixel dropdown next to a two-character quantity field and left the
    // weight stranded on the far side of the card from the numbers it belongs
    // to. A form reads at a fixed width; the card can be as wide as it likes.
    function boxCard(box, i) {
        var cartonOpts = ACTIVE_ORDER.cartons.map(function (c) {
            return '<option value="' + esc(c.id) + '"' +
                (String(c.id) === String(box.boxTypeId) ? ' selected' : '') + '>' +
                esc(c.name) + ' · ' + dims(c.outerLength, c.outerWidth, c.outerHeight) +
                (c.hasInner ? '' : ' · outer only') + '</option>';
        }).join('');

        var itemRows = box.items.map(function (bi, j) {
            var lineOpts = ACTIVE_ORDER.items.map(function (it) {
                return '<option value="' + n(it.lineNo) + '"' +
                    (n(it.lineNo) === n(bi.lineNo) ? ' selected' : '') + '>' +
                    esc(it.itemName) + '</option>';
            }).join('');

            return '<tr>' +
                '<td class="col-item"><select class="cell-select" onchange="PackingScreen.setItemLine(' + i + ', ' + j + ', this.value)">' + lineOpts + '</select></td>' +
                '<td class="col-num"><input type="number" class="cell-input" min="1" step="1" value="' + esc(bi.qty) + '" oninput="PackingScreen.setItemQty(' + i + ', ' + j + ', this.value)"></td>' +
                '<td class="col-act">' + (box.items.length > 1
                    ? '<button type="button" class="x-btn" title="Take this item out of the box" onclick="PackingScreen.removeItem(' + i + ', ' + j + ')">✕</button>'
                    : '') + '</td>' +
                '</tr>';
        }).join('');

        var allLinesUsed = box.items.length >= ACTIVE_ORDER.items.length;

        var carton = cartonById(box.boxTypeId);
        var nImgs = (box.imagePreviewUrls || []).length;

        return '<div class="box-card" id="pack-box-' + i + '">' +
            '<div class="box-topline">' +
                '<span class="box-no">' + (i + 1) + '</span>' +
                '<span class="box-topline-name">' + esc(carton ? carton.name : 'Box') + '</span>' +
                '<span class="box-topline-pieces" id="pack-boxpieces-' + i + '"></span>' +
                '<button type="button" class="x-btn box-remove" title="Remove this box" onclick="PackingScreen.removeBox(' + i + ')">✕</button>' +
            '</div>' +
            '<div class="box-setup">' +
                '<label class="box-field"><span>Carton</span>' +
                    '<select class="cell-select" onchange="PackingScreen.setBoxCarton(' + i + ', this.value)">' + cartonOpts + '</select>' +
                '</label>' +
                '<label class="box-field"><span>Packaging</span>' +
                    '<select class="cell-select" onchange="PackingScreen.setBoxPackaging(' + i + ', this.value)">' +
                        '<option value="both"' + (box.usesInner ? ' selected' : '') + '>Inner + outer</option>' +
                        '<option value="outer"' + (box.usesInner ? '' : ' selected') + '>Outer only</option>' +
                    '</select>' +
                '</label>' +
                '<div class="box-dims">' +
                    dimRow(i, 'Inner', 'inner', !box.usesInner) +
                    dimRow(i, 'Outer', 'outer', false) +
                '</div>' +
            '</div>' +
            '<div class="box-right-col">' +
                '<div class="box-contents">' +
                    '<div class="box-sub-head"><span>In this box</span>' +
                        (allLinesUsed ? '' : '<button type="button" class="mini-btn" onclick="PackingScreen.addItem(' + i + ')">+ item</button>') +
                    '</div>' +
                    '<table class="pack-tbl box-items-tbl">' +
                    '<thead><tr><th class="col-item">Item</th><th class="col-num">Pieces</th><th class="col-act"></th></tr></thead>' +
                    '<tbody>' + itemRows + '</tbody></table>' +
                '</div>' +
                '<div class="box-photo-col">' +
                    '<div class="box-sub-head"><span>Box photos</span>' +
                        (nImgs ? '<span class="photo-count">' + nImgs + '</span>' : '') +
                    '</div>' +
                    '<div class="photo-strip">' +
                        (box.imagePreviewUrls || []).map(function (url, k) {
                            return '<div class="photo-thumb">' +
                                '<img src="' + esc(url) + '" alt="Box photo" title="View full size" onclick="window.open(this.src, \'_blank\')">' +
                                '<button type="button" class="photo-thumb-x" title="Remove photo" onclick="PackingScreen.removeBoxImage(' + i + ', ' + k + ')">✕</button>' +
                            '</div>';
                        }).join('') +
                        '<label class="photo-add" for="pack-image-' + i + '">' +
                            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>' +
                            '<span>' + (nImgs ? 'Add more' : 'Add photos') + '</span>' +
                        '</label>' +
                        '<input type="file" class="file-input-hidden" accept="image/*" multiple id="pack-image-' + i + '" onchange="PackingScreen.addBoxImages(' + i + ', this.files); this.value=\'\';">' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="box-foot">' +
                '<span class="box-stat">Estimated <b id="pack-est-' + i + '">—</b> kg</span>' +
                '<span class="box-stat">Volumetric <b id="pack-vol-' + i + '">—</b> kg</span>' +
                '<label class="box-weigh"><span>Actual kg</span>' +
                    '<input type="number" class="cell-input" id="pack-gross-' + i + '" min="0" step="0.01" placeholder="—" value="' + esc(box.grossWeight) + '" oninput="PackingScreen.setBoxWeight(' + i + ', this.value)">' +
                '</label>' +
            '</div>' +
            '</div>';
    }

    function boxesSection() {
        var body = !ACTIVE_ORDER.boxes.length
            ? '<div class="box-empty">No boxes yet — add one against a line above</div>'
            : ACTIVE_ORDER.boxes.map(boxCard).join('');

        return '<section class="pack-sec">' +
            '<div class="pack-sec-head">' +
                '<h3>Boxes <span class="pack-sec-unit">dimensions in cm, L × W × H</span></h3>' +
                '<button type="button" class="mini-btn" onclick="PackingScreen.addBox()">+ Add a box</button>' +
            '</div>' +
            '<div class="box-list">' + body + '</div>' +
            '<div class="box-totals" id="pack-box-totals"></div>' +
            '</section>';
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

    // ----------------------------------------------------
    // LIVE NUMBERS
    // ----------------------------------------------------
    //
    // Everything derived from a typed number, updated IN PLACE. Nothing here
    // rebuilds an input, so the field being typed into keeps its focus, its
    // caret and its half-finished value. renderBody is for changes of shape - a
    // box added, an item removed, a carton picked.

    function renderLive() {
        if (!ACTIVE_ORDER) return;

        ACTIVE_ORDER.items.forEach(function (it) {
            var boxed = boxedFor(it.lineNo);
            var left = n(it.qty) - boxed;

            var boxedEl = el('boxed-' + n(it.lineNo));
            if (boxedEl) boxedEl.innerText = String(boxed);

            var leftEl = el('left-' + n(it.lineNo));
            if (leftEl) {
                leftEl.innerText = String(left);
                leftEl.className = 'left-pill ' + (left === 0 ? 'is-clear' : (left < 0 ? 'is-over' : 'is-open'));
            }

            var rowEl = el('line-' + n(it.lineNo));
            if (rowEl) rowEl.classList.toggle('row-done', left === 0);

            // The "+ box" button only exists while there is something left to
            // put in one, so it is redrawn rather than hidden - a button that
            // does nothing is worse than no button.
            var actEl = el('lineact-' + n(it.lineNo));
            if (actEl) {
                actEl.innerHTML = left > 0
                    ? '<button type="button" class="mini-btn" onclick="PackingScreen.addBox(' + n(it.lineNo) + ')">+ box</button>'
                    : '';
            }
        });

        var pieces = 0, est = 0, gross = 0, vol = 0, inners = 0;

        ACTIVE_ORDER.boxes.forEach(function (b, i) {
            var bEst = estimatedFor(b);
            var bVol = volumetricFor(b);

            var estEl = el('est-' + i);
            if (estEl) estEl.innerText = kgOrDash(bEst);

            var volEl = el('vol-' + i);
            if (volEl) volEl.innerText = kgOrDash(bVol);

            var bPieces = piecesIn(b);
            var pcEl = el('boxpieces-' + i);
            if (pcEl) pcEl.innerText = plural(bPieces, 'piece');

            var grossInput = el('gross-' + i);
            if (grossInput) {
                grossInput.value = b.grossWeight === undefined ? '' : b.grossWeight;
            }

            pieces += bPieces;
            est += bEst;
            gross += n(b.grossWeight);
            vol += bVol;
            if (b.usesInner) inners += 1;
        });

        var totalsEl = el('box-totals');
        if (totalsEl) {
            totalsEl.innerHTML = !ACTIVE_ORDER.boxes.length ? '' :
                '<span>' + plural(ACTIVE_ORDER.boxes.length, 'box') + '</span>' +
                '<span>' + inners + ' with an inner carton</span>' +
                '<span>' + plural(pieces, 'piece') + '</span>' +
                '<span>Estimated <b>' + kgOrDash(est) + '</b> kg</span>' +
                '<span>Actual <b>' + kgOrDash(gross) + '</b> kg</span>' +
                '<span>Volumetric <b>' + kgOrDash(vol) + '</b> kg</span>';
        }

        renderValidation();
    }

    // ----------------------------------------------------
    // VALIDATION
    // ----------------------------------------------------
    //
    // EVERY FINISHED PIECE MUST BE IN A BOX before this saves. A mismatch is a
    // counting error, cheaper to find here than to have the customer find it.
    // savePackingRecord enforces the same rule server-side - a Custom API is
    // callable from anywhere, so the screen agreeing is not the same as it being
    // true. The dimension and contents checks below are mirrored there too.

    function problems() {
        if (!ACTIVE_ORDER) return ['No order loaded'];
        if (!ACTIVE_ORDER.items.length) return ['Nothing has cleared finishing for this order'];

        var out = [];

        ACTIVE_ORDER.items.forEach(function (it) {
            var left = n(it.qty) - boxedFor(it.lineNo);
            if (left > 0) out.push(it.itemName + ': ' + left + ' of ' + n(it.qty) + ' not in a box');
            else if (left < 0) out.push(it.itemName + ': ' + Math.abs(left) + ' more boxed than finished');
        });

        if (!ACTIVE_ORDER.boxes.length) out.push('No boxes added yet');

        ACTIVE_ORDER.boxes.forEach(function (b, i) {
            var no = 'Box ' + (i + 1);

            if (!b.items.length) out.push(no + ' has nothing in it');
            b.items.forEach(function (bi) {
                if (n(bi.qty) <= 0) out.push(no + ' has an item with no pieces');
            });

            if (n(b.outerLength) <= 0 || n(b.outerWidth) <= 0 || n(b.outerHeight) <= 0) {
                out.push(no + ' is missing an outer dimension');
            }
            if (b.usesInner && (n(b.innerLength) <= 0 || n(b.innerWidth) <= 0 || n(b.innerHeight) <= 0)) {
                out.push(no + ' is missing an inner dimension');
            }
            if (String(b.grossWeight).trim() === '' || n(b.grossWeight) <= 0) {
                out.push(no + ' has not been weighed');
            }
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
            msg.innerHTML = '<span class="ok">Every finished piece is in a box</span>';
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

        // The SKU and the item name are deliberately NOT sent. savePackingRecord
        // resolves both from the order line, along with the unit weight, so
        // nothing describing an item can arrive from outside.
        var payload = {
            salesOrderId: ACTIVE_ORDER.id,
            staffName: SELECTED_STAFF,
            boxes: ACTIVE_ORDER.boxes.map(function (b, i) {
                return {
                    boxNo: i + 1,
                    boxTypeId: b.boxTypeId,
                    usesInner: !!b.usesInner,
                    innerLength: b.usesInner ? n(b.innerLength) : 0,
                    innerWidth: b.usesInner ? n(b.innerWidth) : 0,
                    innerHeight: b.usesInner ? n(b.innerHeight) : 0,
                    innerWeight: b.usesInner ? n(b.innerWeight) : 0,
                    outerLength: n(b.outerLength),
                    outerWidth: n(b.outerWidth),
                    outerHeight: n(b.outerHeight),
                    outerWeight: n(b.outerWeight),
                    grossWeight: n(b.grossWeight),
                    items: b.items.map(function (bi) {
                        return { lineNo: n(bi.lineNo), qty: n(bi.qty) };
                    })
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

            var packId = parsed.packingId;

            // Photos upload AFTER the record exists. Box_Images is a MULTI-IMAGE
            // field on the PARENT Packing form (a subform file field is neither
            // reportable nor cleanly readable from the widget SDK), so every
            // box's photos go to that one field against packId - each uploadFile
            // call appends one more. Failures never block the close; a count is
            // surfaced in the confirmation instead.
            var uploadPromises = [];
            if (isRunningInCreator() && packId) {
                // v2 SDK exposes ZOHO.CREATOR.FILE.uploadFile; older builds put it
                // on ZOHO.CREATOR.API. Same config shape either way.
                var fileNs = (ZOHO && ZOHO.CREATOR && ZOHO.CREATOR.FILE && ZOHO.CREATOR.FILE.uploadFile) ? ZOHO.CREATOR.FILE
                    : (ZOHO && ZOHO.CREATOR && ZOHO.CREATOR.API && ZOHO.CREATOR.API.uploadFile) ? ZOHO.CREATOR.API
                    : null;
                if (fileNs) {
                    var allPhotos = [];
                    ACTIVE_ORDER.boxes.forEach(function (b, i) {
                        (b.imageFiles || []).forEach(function (f) { allPhotos.push({ box: i + 1, file: f }); });
                    });
                    allPhotos.forEach(function (p) {
                        uploadPromises.push(
                            fileNs.uploadFile({
                                reportName: 'Packing_Report',
                                id: packId,
                                fieldName: 'Box_Images',
                                file: p.file
                            }).then(function () { return { ok: true }; })
                              .catch(function (err) {
                                  console.error('Photo upload failed (box ' + p.box + ')', err);
                                  return { ok: false };
                              })
                        );
                    });
                } else {
                    console.warn('No file-upload API on this SDK build - box photos not uploaded.');
                }
            }

            if (uploadPromises.length > 0) {
                var btn2 = el('save-btn');
                if (btn2) { btn2.innerText = 'Uploading photos…'; }
                return Promise.all(uploadPromises).then(function (results) {
                    parsed._photoTotal = results.length;
                    parsed._photoFailed = results.filter(function (r) { return !r.ok; }).length;
                    return parsed;
                });
            }
            return parsed;

        }).then(function (parsed) {
            var msg = parsed.message + '\n\nActual ' + parsed.grossWeight + ' kg, volumetric ' +
                parsed.volumetricWeight + ' kg.';
            if (parsed._photoTotal) {
                msg += '\n\n' + (parsed._photoTotal - parsed._photoFailed) + ' of ' + parsed._photoTotal +
                    ' photo' + (parsed._photoTotal === 1 ? '' : 's') + ' uploaded.';
            }
            alert(msg);
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
                id: '7001', salesOrder: 'SO-00002', source: 'Shopify', planNo: 'PLAN-00003',
                supervisorId: '11', supervisor: 'Harpreet Kaur', packedBy: 'Ravi',
                packedOn: '19-Aug-2026 15:20', boxCount: 2, innerBoxCount: 1, pieces: 20,
                estimatedWeight: 8.9, grossWeight: 9.4, volumetricWeight: 12.1, chargeableWeight: 12.1,
                boxes: [
                    {
                        boxNo: 1, carton: 'Box 3', usesInner: true,
                        innerLength: 32.5, innerWidth: 26.5, innerHeight: 4,
                        outerLength: 35, outerWidth: 28, outerHeight: 5,
                        pieces: 12, estimatedWeight: 5.34, grossWeight: 4.7, volumetricWeight: 0.98,
                        items: [
                            { lineNo: 1, sku: 'SKU-00002', itemName: 'Linen Liana Basket', qty: 8, unitWeight: 0.45 },
                            { lineNo: 2, sku: 'SKU-00007', itemName: 'Linen Napkin Set', qty: 4, unitWeight: 0.42 }
                        ]
                    },
                    {
                        boxNo: 2, carton: 'Box 6', usesInner: false,
                        innerLength: 0, innerWidth: 0, innerHeight: 0,
                        outerLength: 30, outerWidth: 58, outerHeight: 22,
                        pieces: 8, estimatedWeight: 3.56, grossWeight: 4.7, volumetricWeight: 7.66,
                        items: [{ lineNo: 1, sku: 'SKU-00002', itemName: 'Linen Liana Basket', qty: 8, unitWeight: 0.45 }]
                    }
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
        if (OPEN_PACKING_ID) {
            var p = HISTORY.filter(function (x) { return String(x.id) === OPEN_PACKING_ID; })[0];
            if (p && n(p.imageCount) > 0 && !PHOTO_CACHE[OPEN_PACKING_ID]) {
                loadPackingPhotos(OPEN_PACKING_ID);
            }
        }
    }

    // Pull Box_Images off the Packing record and turn whatever getRecords returns
    // for a multi-image field into a list of usable <img> URLs.
    function photoUrlsFromRecord(rec) {
        if (!rec) return [];
        var raw = rec.Box_Images;
        if (raw === undefined || raw === null || raw === '') return [];
        var parts = [];
        if (Array.isArray(raw)) {
            raw.forEach(function (v) {
                if (!v) return;
                if (typeof v === 'string') parts.push(v);
                else if (v.url) parts.push(v.url);
                else if (v.download_Url) parts.push(v.download_Url);
                else if (v.filepath) parts.push(v.filepath);
            });
        } else if (typeof raw === 'object') {
            if (raw.url) parts.push(raw.url);
        } else {
            String(raw).split(/[\n,]/).forEach(function (s) { if (s.trim()) parts.push(s.trim()); });
        }
        return parts.map(function (s) {
            // getRecords may hand back an <a href="…"> wrapper, a bare /api/v2
            // path, or a full URL. Normalise to something an <img> can load.
            var m = String(s).match(/(?:href=")?((?:https?:)?\/\/[^"\s]+|\/[^"\s]+)/);
            var u = m ? m[1] : s;
            if (/^https?:\/\//.test(u)) return u;
            if (/^\/\//.test(u)) return 'https:' + u;
            if (u.charAt(0) === '/') return (CREATOR_ORIGIN || '') + u;
            return u;
        }).filter(Boolean);
    }

    function loadPackingPhotos(packId) {
        PHOTO_CACHE[packId] = { state: 'loading', urls: [] };
        paintPackingPhotos(packId);

        if (!isRunningInCreator() || !(ZOHO && ZOHO.CREATOR && ZOHO.CREATOR.DATA && ZOHO.CREATOR.DATA.getRecords)) {
            PHOTO_CACHE[packId] = { state: 'error', urls: [] };
            paintPackingPhotos(packId);
            return;
        }
        ZOHO.CREATOR.DATA.getRecords({
            reportName: 'Packing_Report',
            criteria: '(ID == ' + packId + ')',
            fieldConfig: 'quick_view'
        }).then(function (resp) {
            var recs = (resp && (resp.data || resp.records)) || [];
            var rec = Array.isArray(recs) ? recs[0] : recs;
            PHOTO_CACHE[packId] = { state: 'ok', urls: photoUrlsFromRecord(rec) };
            paintPackingPhotos(packId);
        }).catch(function (err) {
            console.error('getRecords for packing photos failed:', err);
            PHOTO_CACHE[packId] = { state: 'error', urls: [] };
            paintPackingPhotos(packId);
        });
    }

    function paintPackingPhotos(packId) {
        var box = el('hist-photos-' + packId);
        if (!box) return;
        box.innerHTML = photoGalleryHtml(packId);
    }

    function photoGalleryHtml(packId) {
        var hit = PHOTO_CACHE[packId];
        if (!hit || hit.state === 'loading') return '<span class="hist-photos-note">Loading photos…</span>';
        if (hit.state === 'error') return '<span class="hist-photos-note">Could not load photos.</span>';
        if (!hit.urls.length) return '<span class="hist-photos-note">No photos on this record.</span>';
        return hit.urls.map(function (u) {
            return '<a class="hist-photo" href="' + esc(u) + '" target="_blank" rel="noopener">' +
                '<img src="' + esc(u) + '" alt="Box photo" loading="lazy"></a>';
        }).join('');
    }

    // A PACKED BOX IS ANSWERED FOR MONTHS LATER, so an opened history card shows
    // everything the record holds: the carton, both sets of dimensions, whether
    // an inner went in, all three weights, and every item inside with the unit
    // weight the estimate was built from. Summarising it would mean going to
    // Creator to answer the question this tab exists to answer.
    function historyBox(p, b) {
        var itemRows = (b.items || []).map(function (it) {
            return '<tr>' +
                '<td class="material-name-cell">' +
                    '<div class="mat-name">' + esc(it.itemName || '') + '</div>' +
                    (it.sku ? '<div class="mat-sku">' + esc(it.sku) + '</div>' : '') +
                '</td>' +
                '<td class="col-num col-strong">' + n(it.qty) + '</td>' +
                '<td class="col-num">' + kgOrDash(it.unitWeight) + '</td>' +
                '<td class="col-num">' + kgOrDash(n(it.unitWeight) * n(it.qty)) + '</td>' +
                '</tr>';
        }).join('');

        var packaging = b.usesInner ? 'Inner + outer' : 'Outer only';

        return '<div class="hist-box">' +
            '<div class="hist-box-head">' +
                '<span class="box-no">' + n(b.boxNo) + '</span>' +
                '<span class="hist-box-carton">' + esc(b.carton || '—') + '</span>' +
                '<span class="hist-box-tag' + (b.usesInner ? '' : ' is-outer') + '">' + packaging + '</span>' +
                (b.legacyDims ? '<span class="hist-box-tag is-legacy" title="Packed before dimensions were recorded on the box - these are the carton\'s">carton size</span>' : '') +
                '<span class="hist-box-pieces">' + plural(n(b.pieces), 'piece') + '</span>' +
            '</div>' +
            '<div class="hist-box-dims">' +
                (b.usesInner ? '<span>Inner <b>' + dims(b.innerLength, b.innerWidth, b.innerHeight) + '</b> cm</span>' : '') +
                '<span>Outer <b>' + dims(b.outerLength, b.outerWidth, b.outerHeight) + '</b> cm</span>' +
                '<span>Estimated <b>' + kgOrDash(b.estimatedWeight) + '</b> kg</span>' +
                '<span>Actual <b>' + kgOrDash(b.grossWeight) + '</b> kg</span>' +
                '<span>Volumetric <b>' + kgOrDash(b.volumetricWeight) + '</b> kg</span>' +
            '</div>' +
            '<div class="table-wrapper">' +
            '<table><thead><tr>' +
            '<th>Item</th><th class="col-num">Pieces</th>' +
            '<th class="col-num">Unit kg</th><th class="col-num">Est kg</th>' +
            '</tr></thead><tbody>' + itemRows + '</tbody></table>' +
            '</div>' +
            '</div>';
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

            // VOLUMETRIC ON THE HEADER. Chargeable used to lead here - the
            // greater of gross and volumetric, which is what the courier bills -
            // but it is a derived figure and on a garment carton it is almost
            // always just the volumetric repeated, so the card carried the same
            // number twice under two names. Volumetric is the one that is
            // measured from the carton, so it is the one shown.
            var meta = esc(p.packedOn || '') +
                (p.packedBy ? ' &middot; ' + esc(p.packedBy) : '') +
                ' &middot; ' + plural(n(p.boxCount), 'box') +
                ' &middot; ' + plural(n(p.pieces), 'piece');

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
                // The whole header of the run, on one strip. Actual is what the
                // packer put on the scale - the one figure here that was measured
                // rather than derived, and the only thing the estimate and the
                // volumetric can be checked against.
                // Chargeable, the plan and the supervisor are NOT quoted here,
                // and getPackingHistory still returns all three. Chargeable is
                // derived - the greater of actual and volumetric, which on a
                // garment carton is the volumetric already on this strip under
                // another name. The plan and the supervisor belong to how the
                // order was made, not to how it was boxed, and the supervisor is
                // already the picker this list is filtered by.
                '<div class="pack-hist-totals">' +
                '<span>Estimated <b>' + kgOrDash(p.estimatedWeight) + ' kg</b></span>' +
                '<span>Actual <b>' + kg(p.grossWeight) + ' kg</b></span>' +
                '<span>Volumetric <b>' + kg(p.volumetricWeight) + ' kg</b></span>' +
                '<span>Inner cartons <b>' + n(p.innerBoxCount) + ' of ' + n(p.boxCount) + '</b></span>' +
                (p.source ? '<span>Source <b>' + esc(p.source) + '</b></span>' : '') +
                '</div>' +
                (n(p.imageCount) > 0
                    ? '<div class="hist-photos-wrap"><div class="hist-photos-head">Photos</div>' +
                      '<div class="hist-photos" id="hist-photos-' + esc(p.id) + '">' +
                      (open ? photoGalleryHtml(p.id) : '') + '</div></div>'
                    : '') +
                (p.boxes || []).map(function (b) { return historyBox(p, b); }).join('') +
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

    function viewPhoto(url) {
        if (url) window.open(url, '_blank');
    }

    // Only what the generated markup's onclick handlers and the host page need.
    return {
        init: init,
        refresh: refreshAll,
        showTab: showTab,
        toggleHistory: toggleHistory,
        viewPhoto: viewPhoto,
        selectOrder: selectOrder,
        setStaff: setStaff,
        addBox: addBox,
        removeBox: removeBox,
        setBoxCarton: setBoxCarton,
        setBoxPackaging: setBoxPackaging,
        setBoxDim: setBoxDim,
        setBoxWeight: setBoxWeight,
        setBoxCartonWeight: setBoxCartonWeight,
        addBoxImages: addBoxImages,
        removeBoxImage: removeBoxImage,
        addItem: addItem,
        removeItem: removeItem,
        setItemLine: setItemLine,
        setItemQty: setItemQty,
        save: save,
        // for the stub-DOM tests only
        _setHistory: function (h) { HISTORY = h; HISTORY_LOADED = true; renderHistory(); },
        _visibleHistory: visibleHistory,
        _state: function () { return ACTIVE_ORDER; },
        _setup: setupActiveOrder,
        _setQueue: function (q) { QUEUE = q; renderQueue(); },
        _setSup: function (id) { SELECTED_SUP = id; renderQueue(); },
        _visible: visibleOrders,
        _remainingFor: remainingFor,
        _problems: problems,
        _estimatedFor: estimatedFor,
        _volumetricFor: volumetricFor
    };
})();
