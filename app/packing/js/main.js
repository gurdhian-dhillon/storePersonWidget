// Packing Workflow Controller
// Creator JS API v2, ES5-flavoured (var/function), no init()

var DEMO_MODE = false;

// Active State
var ACTIVE_ORDER_ID = null;
var ACTIVE_ORDER = null; 
// Structure of ACTIVE_ORDER:
// {
//     id: "salesId",
//     orderNo: "SO-1234",
//     source: "Shopify",
//     items: [ { lineNo: 1, sku: "SKU1", itemName: "Item 1", qty: 25, packedQty: 0 } ],
//     boxSizes: [ { name: "Size 1", length: 15, width: 15, height: 10, volume: 2250 } ],
//     capacities: [ { sku: "SKU1", boxSize: "Size 1", capacity: 10 } ],
//     innerBoxes: [ { boxNo: "IB-001", boxSize: "Size 3", sku: "SKU1", qty: 10, capacity: 10, outerBoxNo: "OB-001" } ],
//     outerBoxes: [ { outerBoxNo: "OB-001", volumeUsed: 12000, weight: 0 } ]
// }

var STAFF_LIST = [];
var SELECTED_STAFF = '';
var QUEUE = [];
var ACTIVE_TAB = 'inner';

// Constants for Outer Box points-based capacity
var BOX_POINTS = {
    "Size 1": 1,
    "Size 2": 2,
    "Size 3": 4,
    "Size 4": 8,
    "Size 5": 16,
    "Size 6": 32
};
var MAX_OUTER_POINTS = 64;

// Auto-increment counters
var innerBoxCounter = 1;
var outerBoxCounter = 1;

function isRunningInCreator() {
    return (window.self !== window.top) && (typeof ZOHO !== 'undefined' && ZOHO.CREATOR);
}

function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

// ----------------------------------------------------
// BOOTSTRAP & INITIALIZATION
// ----------------------------------------------------

document.addEventListener('DOMContentLoaded', function () {
    // Setup tabs
    switchTab('inner');

    // Register Drag and Drop events for Outer Box placement
    setupDragAndDrop();

    // Call load functions with a delay to let Creator SDK handshake complete
    setTimeout(function () {
        loadStaffList();
        loadDashboardData();
    }, 150);
});

function loadStaffList() {
    if (!isRunningInCreator()) {
        STAFF_LIST = [
            { id: "e1", name: "Abhijay" },
            { id: "e2", name: "Packer A" },
            { id: "e3", name: "Packer B" }
        ];
        populateStaffDropdown();
        return;
    }

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getStorePackingStaff',
        http_method: 'POST',
        payload: { payloadJson: "" }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('getStorePackingStaff JSON parse error:', e);
            return;
        }

        if (parsed.errors && parsed.errors.length > 0) {
            console.error('getStorePackingStaff returned errors:', parsed.errors);
            return;
        }

        // Combine supervisors and staff into one selection list
        var sups = parsed.supervisors || [];
        var staff = parsed.staff || [];
        STAFF_LIST = sups.concat(staff);
        populateStaffDropdown();
    }).catch(function (err) {
        console.error('getStorePackingStaff call failed:', err);
    });
}

function populateStaffDropdown() {
    var select = document.getElementById('staff-select-el');
    if (!select) return;

    if (STAFF_LIST.length === 0) {
        select.innerHTML = '<option value="">No staff found</option>';
        return;
    }

    select.innerHTML = STAFF_LIST.map(function (emp) {
        return '<option value="' + escapeHtml(emp.name) + '">' + escapeHtml(emp.name) + '</option>';
    }).join('');

    SELECTED_STAFF = select.value;
    updateStaffAvatar();

    select.onchange = function () {
        SELECTED_STAFF = select.value;
        updateStaffAvatar();
    };
}

function updateStaffAvatar() {
    var avatar = document.getElementById('staff-avatar-initial');
    if (avatar) {
        avatar.innerText = SELECTED_STAFF ? SELECTED_STAFF.charAt(0).toUpperCase() : 'P';
    }
}

function loadDashboardData() {
    var queueContainer = document.getElementById('order-queue-list');
    if (queueContainer) {
        queueContainer.innerHTML = '<div style="padding:2rem; text-align:center;"><div class="skeleton-line" style="width:80%; margin: 8px auto;"></div><div class="skeleton-line" style="width:60%; margin: 8px auto;"></div></div>';
    }

    if (!isRunningInCreator() || DEMO_MODE) {
        // Mock Queue Data
        QUEUE = [
            { id: "10001", orderNo: "SO-2026-0801", source: "Shopify", itemCount: 2, totalPieces: 58 },
            { id: "10002", orderNo: "SO-2026-0802", source: "Faire", itemCount: 1, totalPieces: 10 },
            { id: "10003", orderNo: "SO-2026-0803", source: "Custom", itemCount: 3, totalPieces: 12 }
        ];
        renderQueueList();
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
            console.error('getPackingQueue parse error:', e, response.result);
            return;
        }

        if (parsed.errors && parsed.errors.length > 0) {
            console.error('getPackingQueue error:', parsed.errors);
            return;
        }

        QUEUE = parsed.orders || [];
        renderQueueList();
    }).catch(function (err) {
        console.error('getPackingQueue failed:', err);
    });
}

function renderQueueList() {
    var container = document.getElementById('order-queue-list');
    var countLabel = document.getElementById('queue-count');
    if (!container) return;

    if (countLabel) countLabel.innerText = QUEUE.length;

    if (QUEUE.length === 0) {
        container.innerHTML = '<div class="empty-state-small"><div class="icon">📦</div><p>No orders pending packing</p></div>';
        return;
    }

    container.innerHTML = QUEUE.map(function (order) {
        var activeClass = (ACTIVE_ORDER_ID === order.id) ? ' is-active' : '';
        return '<div class="queue-item-card' + activeClass + '" onclick="selectOrder(\'' + escapeHtml(order.id) + '\')">' +
            '<span class="order-no">' + escapeHtml(order.orderNo) + '</span>' +
            '<div class="order-meta">' +
                '<span>Src: ' + escapeHtml(order.source) + '</span>' +
                '<span>' + order.totalPieces + ' pcs</span>' +
            '</div>' +
            '</div>';
    }).join('');
}

// ----------------------------------------------------
// WORKSPACE ACTIONS
// ----------------------------------------------------

function selectOrder(orderId) {
    ACTIVE_ORDER_ID = orderId;
    renderQueueList(); // update active class representation
    
    // Show spinner in workspace
    var editor = document.getElementById('packing-editor');
    var emptyState = document.getElementById('workspace-empty-state');
    if (emptyState) emptyState.classList.add('hidden');
    if (editor) {
        editor.classList.remove('hidden');
        // temporarily hide internal tabs and show loading skeleton
        document.querySelector('.tab-body').style.opacity = '0.5';
    }

    if (!isRunningInCreator() || DEMO_MODE) {
        // Populate mock order details
        var mockDetails = {
            salesOrderId: orderId,
            orderNo: "SO-2026-0801",
            source: "Shopify",
            items: [
                { lineNo: 1, sku: "Linen Tshirt", itemName: "Linen Tshirt - White / S", qty: 50 },
                { lineNo: 2, sku: "Linen Basket", itemName: "Linen Basket - Large", qty: 8 }
            ],
            boxSizes: [
                { id: "b1", name: "Size 1", length: 15, width: 15, height: 10, volume: 2250 },
                { id: "b2", name: "Size 2", length: 20, width: 20, height: 15, volume: 6000 },
                { id: "b3", name: "Size 3", length: 30, width: 20, height: 20, volume: 12000 },
                { id: "b4", name: "Size 4", length: 40, width: 30, height: 20, volume: 24000 },
                { id: "b5", name: "Size 5", length: 50, width: 40, height: 30, volume: 60000 },
                { id: "b6", name: "Size 6", length: 60, width: 50, height: 40, volume: 120000 }
            ],
            capacities: [
                { sku: "Linen Basket", boxSize: "Size 1", capacity: 0 },
                { sku: "Linen Basket", boxSize: "Size 2", capacity: 0 },
                { sku: "Linen Basket", boxSize: "Size 3", capacity: 1 },
                { sku: "Linen Basket", boxSize: "Size 4", capacity: 2 },
                { sku: "Linen Basket", boxSize: "Size 5", capacity: 4 },
                { sku: "Linen Basket", boxSize: "Size 6", capacity: 8 },
                { sku: "Linen Tshirt", boxSize: "Size 1", capacity: 5 },
                { sku: "Linen Tshirt", boxSize: "Size 2", capacity: 10 },
                { sku: "Linen Tshirt", boxSize: "Size 3", capacity: 20 },
                { sku: "Linen Tshirt", boxSize: "Size 4", capacity: 35 },
                { sku: "Linen Tshirt", boxSize: "Size 5", capacity: 60 },
                { sku: "Linen Tshirt", boxSize: "Size 6", capacity: 100 }
            ]
        };
        // Find matching item count/pieces from Queue representation
        for (var q = 0; q < QUEUE.length; q++) {
            if (QUEUE[q].id === orderId) {
                mockDetails.orderNo = QUEUE[q].orderNo;
                mockDetails.source = QUEUE[q].source;
            }
        }
        setupActiveOrder(mockDetails);
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
            console.error('getPackingDetails parse failed:', e, response.result);
            alert("Error parsing order details from Zoho Creator.");
            return;
        }

        if (parsed.errors && parsed.errors.length > 0) {
            alert("Creator API Error: " + parsed.errors.join(', '));
            return;
        }

        setupActiveOrder(parsed);
    }).catch(function (err) {
        console.error('getPackingDetails call failed:', err);
    });
}

function setupActiveOrder(details) {
    ACTIVE_ORDER = {
        id: details.salesOrderId,
        orderNo: details.orderNo,
        source: details.source,
        items: details.items || [],
        boxSizes: details.boxSizes || [],
        capacities: details.capacities || [],
        innerBoxes: [],
        outerBoxes: []
    };

    // Auto-populate finished quantity representation
    ACTIVE_ORDER.items.forEach(function (item) {
        item.packedQty = 0; // tracking how much has been allocated to boxes so far
    });

    document.getElementById('active-order-no').innerText = ACTIVE_ORDER.orderNo;
    document.getElementById('active-order-source').innerText = ACTIVE_ORDER.source;
    document.getElementById('active-item-count').innerText = ACTIVE_ORDER.items.length;
    
    var totalPieces = ACTIVE_ORDER.items.reduce(function (sum, it) { return sum + it.qty; }, 0);
    document.getElementById('active-total-pieces').innerText = totalPieces;

    // Reset counters
    innerBoxCounter = 1;
    outerBoxCounter = 1;

    // Run Auto Packer instantly to present a ready setup
    autoPackItems();

    // Enable workspace interactions
    document.querySelector('.tab-body').style.opacity = '1';
    switchTab('inner');
}

// ----------------------------------------------------
// PACKING SOLVER ALGORITHM
// ----------------------------------------------------

function autoPackItems() {
    if (!ACTIVE_ORDER) return;

    ACTIVE_ORDER.innerBoxes = [];
    ACTIVE_ORDER.outerBoxes = [];
    innerBoxCounter = 1;
    outerBoxCounter = 1;

    // Step 1: Pack items of each SKU into Inner Boxes (STRICT RULE: Separate SKUs)
    ACTIVE_ORDER.items.forEach(function (item) {
        var sku = item.sku;
        var totalQty = item.qty;
        if (totalQty <= 0) return;

        // Find available sizes and capacities for this SKU
        var skuCaps = ACTIVE_ORDER.capacities.filter(function (c) {
            return c.sku === sku && c.capacity > 0;
        });

        // If no capacity rules are defined, default to a standard lookup fallback (e.g. Size 3 = 10, Size 4 = 20)
        if (skuCaps.length === 0) {
            skuCaps = [
                { sku: sku, boxSize: "Size 3", capacity: 10 },
                { sku: sku, boxSize: "Size 4", capacity: 20 },
                { sku: sku, boxSize: "Size 5", capacity: 40 },
                { sku: sku, boxSize: "Size 6", capacity: 80 }
            ];
        }

        // Sort capacities descending (largest boxes first)
        skuCaps.sort(function (a, b) {
            return b.capacity - a.capacity;
        });

        var remaining = totalQty;
        
        // Greedy fit into boxes
        skuCaps.forEach(function (rule) {
            if (remaining <= 0) return;
            
            var cap = rule.capacity;
            // How many full boxes of this size can we pack?
            if (remaining >= cap) {
                var numBoxes = Math.floor(remaining / cap);
                for (var b = 0; b < numBoxes; b++) {
                    ACTIVE_ORDER.innerBoxes.push({
                        boxNo: generateInnerBoxNo(),
                        boxSize: rule.boxSize,
                        sku: sku,
                        qty: cap,
                        capacity: cap,
                        outerBoxNo: null
                    });
                }
                remaining = remaining % cap;
            }
        });

        // If there's still a remainder, pack it in the smallest available box size that fits it
        if (remaining > 0) {
            // Find the smallest box size that has capacity >= remaining
            var bestFitRule = null;
            for (var c = skuCaps.length - 1; c >= 0; c--) {
                if (skuCaps[c].capacity >= remaining) {
                    bestFitRule = skuCaps[c];
                    break;
                }
            }

            // Fallback to the largest box if none are big enough
            if (!bestFitRule && skuCaps.length > 0) {
                bestFitRule = skuCaps[0];
            }

            if (bestFitRule) {
                ACTIVE_ORDER.innerBoxes.push({
                    boxNo: generateInnerBoxNo(),
                    boxSize: bestFitRule.boxSize,
                    sku: sku,
                    qty: remaining,
                    capacity: bestFitRule.capacity,
                    outerBoxNo: null
                });
            } else {
                // Absolute fallback (pack what's left in Size 3)
                ACTIVE_ORDER.innerBoxes.push({
                    boxNo: generateInnerBoxNo(),
                    boxSize: "Size 3",
                    sku: sku,
                    qty: remaining,
                    capacity: remaining,
                    outerBoxNo: null
                });
            }
            remaining = 0;
        }
    });

    // Step 2: Auto pack inner boxes into Outer Boxes (Point-based bin packing)
    // Points rule: Size 1 = 1, Size 2 = 2, Size 3 = 4, Size 4 = 8, Size 5 = 16, Size 6 = 32
    // Outer Box capacity = 64 points
    
    // Sort inner boxes by point size descending (largest first)
    var sortedInner = ACTIVE_ORDER.innerBoxes.slice().sort(function (a, b) {
        var ptsA = BOX_POINTS[a.boxSize] || 4;
        var ptsB = BOX_POINTS[b.boxSize] || 4;
        return ptsB - ptsA;
    });

    sortedInner.forEach(function (innerBox) {
        var boxPoints = BOX_POINTS[innerBox.boxSize] || 4;

        // Find an existing outer box with space
        var placed = false;
        for (var o = 0; o < ACTIVE_ORDER.outerBoxes.length; o++) {
            var outer = ACTIVE_ORDER.outerBoxes[o];
            var currentPoints = calculateOuterPoints(outer.outerBoxNo);
            if (currentPoints + boxPoints <= MAX_OUTER_POINTS) {
                innerBox.outerBoxNo = outer.outerBoxNo;
                placed = true;
                break;
            }
        }

        // If it doesn't fit in any existing outer box, spawn a new one
        if (!placed) {
            var newOuterNo = generateOuterBoxNo();
            ACTIVE_ORDER.outerBoxes.push({
                outerBoxNo: newOuterNo,
                volumeUsed: 0,
                weight: 0
            });
            innerBox.outerBoxNo = newOuterNo;
        }
    });

    // Recalculate outer volumes/weights
    recalculateOuterProperties();
    
    // Refresh panels
    updatePackingProgress();
    renderInnerBoxes();
    renderOuterBoxes();
    validatePacking();
}

function generateInnerBoxNo() {
    var num = innerBoxCounter++;
    var str = "" + num;
    while (str.length < 3) str = "0" + str;
    return "IB-" + str;
}

function generateOuterBoxNo() {
    var num = outerBoxCounter++;
    var str = "" + num;
    while (str.length < 3) str = "0" + str;
    return "OB-" + str;
}

function getSKUCapacity(sku, size) {
    if (!ACTIVE_ORDER) return 0;
    var rule = ACTIVE_ORDER.capacities.filter(function (c) {
        return c.sku === sku && c.boxSize === size;
    });
    if (rule.length > 0) return rule[0].capacity;
    // defaults
    if (sku === "Linen Tshirt") {
        if (size === "Size 1") return 5;
        if (size === "Size 2") return 10;
        if (size === "Size 3") return 20;
        if (size === "Size 4") return 35;
        if (size === "Size 5") return 60;
        return 100;
    }
    if (sku === "Linen Basket") {
        if (size === "Size 1" || size === "Size 2") return 0;
        if (size === "Size 3") return 1;
        if (size === "Size 4") return 2;
        if (size === "Size 5") return 4;
        return 8;
    }
    return 10; // general default
}

function calculateOuterPoints(outerBoxNo) {
    if (!ACTIVE_ORDER) return 0;
    return ACTIVE_ORDER.innerBoxes.reduce(function (sum, box) {
        if (box.outerBoxNo === outerBoxNo) {
            var pts = BOX_POINTS[box.boxSize] || 4;
            return sum + pts;
        }
        return sum;
    }, 0);
}

function recalculateOuterProperties() {
    if (!ACTIVE_ORDER) return;

    ACTIVE_ORDER.outerBoxes.forEach(function (outer) {
        var outerNo = outer.outerBoxNo;
        // Total Volume of placed inner boxes
        var totalVol = 0;
        ACTIVE_ORDER.innerBoxes.forEach(function (ib) {
            if (ib.outerBoxNo === outerNo) {
                var boxSizeInfo = ACTIVE_ORDER.boxSizes.filter(function (bs) { return bs.name === ib.boxSize; });
                if (boxSizeInfo.length > 0) {
                    totalVol += boxSizeInfo[0].volume;
                } else {
                    totalVol += 12000; // default points-relative vol
                }
            }
        });
        outer.volumeUsed = totalVol;
        // Weight calculation: items qty * unit weight (mock weight 0.2kg per pcs)
        var totalQty = ACTIVE_ORDER.innerBoxes.reduce(function (sum, ib) {
            return sum + (ib.outerBoxNo === outerNo ? ib.qty : 0);
        }, 0);
        outer.weight = parseFloat((totalQty * 0.2 + 0.5).toFixed(1)); // 0.2kg/pc + 0.5kg box tare weight
    });
}

// ----------------------------------------------------
// UI RENDERING & TAB ACTIONS
// ----------------------------------------------------

function switchTab(tab) {
    ACTIVE_TAB = tab;
    var btnInner = document.getElementById('tab-inner-btn');
    var btnOuter = document.getElementById('tab-outer-btn');
    var panelInner = document.getElementById('panel-inner');
    var panelOuter = document.getElementById('panel-outer');

    if (tab === 'inner') {
        if (btnInner) btnInner.classList.add('is-active');
        if (btnOuter) btnOuter.classList.remove('is-active');
        if (panelInner) panelInner.classList.add('is-active');
        if (panelOuter) panelOuter.classList.remove('is-active');
        renderInnerBoxes();
    } else {
        if (btnInner) btnInner.classList.remove('is-active');
        if (btnOuter) btnOuter.classList.add('is-active');
        if (panelInner) panelInner.classList.remove('is-active');
        if (panelOuter) panelOuter.classList.add('is-active');
        renderOuterBoxes();
    }
    validatePacking();
}

function updatePackingProgress() {
    if (!ACTIVE_ORDER) return;

    // Reset packed quantities
    ACTIVE_ORDER.items.forEach(function (item) {
        item.packedQty = 0;
    });

    // Sum from inner boxes
    ACTIVE_ORDER.innerBoxes.forEach(function (ib) {
        var it = ACTIVE_ORDER.items.filter(function (item) { return item.sku === ib.sku; });
        if (it.length > 0) {
            it[0].packedQty += ib.qty;
        }
    });

    // Render Progress List
    var container = document.getElementById('items-progress-list');
    if (!container) return;

    container.innerHTML = ACTIVE_ORDER.items.map(function (item) {
        var percent = Math.min(100, Math.round((item.packedQty / item.qty) * 100)) || 0;
        var barClass = 'item-progress-bar';
        if (item.packedQty === item.qty) barClass += ' complete';
        else if (item.packedQty > item.qty) barClass += ' overpack';

        return '<div class="item-progress-row">' +
            '<div class="item-progress-header">' +
                '<span>' + escapeHtml(item.itemName) + '</span>' +
                '<span class="sku-label">' + escapeHtml(item.sku) + '</span>' +
            '</div>' +
            '<div class="item-progress-header" style="font-size:11px; font-weight:normal; color:var(--text-muted);">' +
                '<span>Progress: ' + item.packedQty + ' / ' + item.qty + ' pcs</span>' +
                '<span>' + percent + '%</span>' +
            '</div>' +
            '<div class="item-progress-bar-wrapper">' +
                '<div class="' + barClass + '" style="width: ' + percent + '%;"></div>' +
            '</div>' +
            '</div>';
    }).join('');
}

function renderInnerBoxes() {
    var container = document.getElementById('inner-boxes-list');
    if (!container) return;

    if (ACTIVE_ORDER.innerBoxes.length === 0) {
        container.innerHTML = '<div class="empty-state-small" style="grid-column: 1/-1;"><div class="icon">📦</div><p>No inner boxes configured yet. Use "Auto-Pack" or "Add Box".</p></div>';
        return;
    }

    container.innerHTML = ACTIVE_ORDER.innerBoxes.map(function (ib) {
        var sizeNumClass = 'size-' + (ib.boxSize ? ib.boxSize.replace('Size ', '') : '3');
        var capacity = getSKUCapacity(ib.sku, ib.boxSize);
        var percent = Math.min(100, Math.round((ib.qty / (capacity || 1)) * 100));
        
        // Validation check for overflow or empty capacity
        var invalidClass = (ib.qty > capacity || capacity === 0) ? ' invalid' : '';
        
        var skuOptions = ACTIVE_ORDER.items.map(function (item) {
            var sel = (item.sku === ib.sku) ? ' selected' : '';
            return '<option value="' + escapeHtml(item.sku) + '"' + sel + '>' + escapeHtml(item.sku) + '</option>';
        }).join('');

        var sizeOptions = [1,2,3,4,5,6].map(function (n) {
            var szName = "Size " + n;
            var sel = (szName === ib.boxSize) ? ' selected' : '';
            return '<option value="' + szName + '"' + sel + '>' + szName + '</option>';
        }).join('');

        return '<div class="box-card ' + sizeNumClass + invalidClass + '">' +
            '<div class="box-card-header">' +
                '<span class="box-id">' + ib.boxNo + '</span>' +
                '<button type="button" class="btn-delete" title="Delete Box" onclick="deleteInnerBox(\'' + ib.boxNo + '\')">✕</button>' +
            '</div>' +
            '<div class="box-control-row">' +
                '<label>Box Size</label>' +
                '<select class="box-select" onchange="changeInnerBoxSize(\'' + ib.boxNo + '\', this.value)">' +
                    sizeOptions +
                '</select>' +
            '</div>' +
            '<div class="box-control-row">' +
                '<label>Product</label>' +
                '<select class="box-select" onchange="changeInnerBoxSku(\'' + ib.boxNo + '\', this.value)">' +
                    skuOptions +
                '</select>' +
            '</div>' +
            '<div class="box-control-row">' +
                '<label>Qty Packed</label>' +
                '<div class="qty-adjuster">' +
                    '<button type="button" class="btn-qty" onclick="adjustInnerBoxQty(\'' + ib.boxNo + '\', -1)">-</button>' +
                    '<input type="number" class="input-qty" value="' + ib.qty + '" onchange="changeInnerBoxQty(\'' + ib.boxNo + '\', this.value)">' +
                    '<button type="button" class="btn-qty" onclick="adjustInnerBoxQty(\'' + ib.boxNo + '\', 1)">+</button>' +
                '</div>' +
            '</div>' +
            '<div class="box-util-info">' +
                '<span style="color:var(--text-muted);">Max Capacity: ' + capacity + '</span>' +
                '<span>' + percent + '% Full</span>' +
            '</div>' +
            '<div class="box-util-bar-wrapper">' +
                '<div class="box-util-bar' + (percent > 90 ? ' warning' : '') + '" style="width:' + percent + '%;"></div>' +
            '</div>' +
            '</div>';
    }).join('');
}

function renderOuterBoxes() {
    // 1. Render unplaced inner boxes
    var unplacedContainer = document.getElementById('unplaced-inner-boxes-list');
    var unplacedBoxes = ACTIVE_ORDER.innerBoxes.filter(function (ib) { return ib.outerBoxNo === null; });

    if (unplacedContainer) {
        if (unplacedBoxes.length === 0) {
            unplacedContainer.innerHTML = '<div style="font-size:11px; text-align:center; padding: 1.5rem; color:var(--text-muted); font-style:italic;">All inner boxes are placed.</div>';
        } else {
            unplacedContainer.innerHTML = unplacedBoxes.map(function (ib) {
                var sizeNum = ib.boxSize.replace('Size ', '');
                return '<div class="draggable-box-pill size-' + sizeNum + '" draggable="true" data-box-no="' + ib.boxNo + '" ondragstart="onBoxDragStart(event)">' +
                    '<span>' + ib.boxNo + ' (' + ib.boxSize + ')</span>' +
                    '<span style="font-size: 10px; color:var(--text-muted);">' + ib.qty + ' pcs</span>' +
                    '</div>';
            }).join('');
        }
    }

    // 2. Render Outer Boxes list
    var outerContainer = document.getElementById('outer-boxes-list');
    if (!outerContainer) return;

    if (ACTIVE_ORDER.outerBoxes.length === 0) {
        outerContainer.innerHTML = '<div class="empty-state-small" style="grid-column: 1/-1;"><div class="icon">📦</div><p>No outer boxes configured. Add an outer box to begin placement.</p></div>';
        return;
    }

    outerContainer.innerHTML = ACTIVE_ORDER.outerBoxes.map(function (ob) {
        var outerNo = ob.outerBoxNo;
        var pointsUsed = calculateOuterPoints(outerNo);
        var pctUsed = Math.min(100, Math.round((pointsUsed / MAX_OUTER_POINTS) * 100));
        
        var pointsColor = (pointsUsed > MAX_OUTER_POINTS) ? 'var(--status-danger)' : 'var(--text-muted)';
        var borderWarn = (pointsUsed > MAX_OUTER_POINTS) ? 'border-color: var(--danger-border); box-shadow: 0 0 0 2px var(--status-danger-bg);' : '';

        // Get inner boxes placed in this outer box
        var placedInThis = ACTIVE_ORDER.innerBoxes.filter(function (ib) { return ib.outerBoxNo === outerNo; });
        var innerPillsHtml = placedInThis.map(function (ib) {
            var sizeNum = ib.boxSize.replace('Size ', '');
            return '<div class="draggable-box-pill size-' + sizeNum + '" draggable="true" data-box-no="' + ib.boxNo + '" ondragstart="onBoxDragStart(event)">' +
                '<span>' + ib.boxNo + ' (' + ib.boxSize + ') - ' + ib.sku + ' (' + ib.qty + ')</span>' +
                '<button type="button" class="pill-del-btn" title="Remove from Outer Box" onclick="removeBoxFromOuter(\'' + ib.boxNo + '\')">✕</button>' +
                '</div>';
        }).join('');

        return '<div class="outer-box-card" style="' + borderWarn + '" data-outer-no="' + outerNo + '">' +
            '<div class="outer-box-info">' +
                '<span class="outer-box-title">' + outerNo + '</span>' +
                '<button type="button" class="btn-delete" title="Delete Outer Box" onclick="deleteOuterBox(\'' + outerNo + '\')">✕</button>' +
            '</div>' +
            '<div class="box-util-info">' +
                '<span style="color:' + pointsColor + '; font-weight:700;">Points: ' + pointsUsed + ' / ' + MAX_OUTER_POINTS + '</span>' +
                '<span style="color:var(--text-muted); font-size:11px;">Volume: ' + ob.volumeUsed.toLocaleString() + ' cm³ | Wt: ' + ob.weight + ' kg</span>' +
            '</div>' +
            '<div class="box-util-bar-wrapper" style="margin-top: -6px; margin-bottom: 4px;">' +
                '<div class="box-util-bar' + (pointsUsed > MAX_OUTER_POINTS ? ' overpack' : '') + '" style="width:' + pctUsed + '%; background:' + (pointsUsed > MAX_OUTER_POINTS ? 'var(--status-danger)' : 'var(--primary)') + ';"></div>' +
            '</div>' +
            '<div class="outer-box-inner-list" data-outer-no="' + outerNo + '" ondragover="onBoxDragOver(event)" ondragleave="onBoxDragLeave(event)" ondrop="onBoxDrop(event)">' +
                innerPillsHtml +
            '</div>' +
            '</div>';
    }).join('');
}

// ----------------------------------------------------
// CARD ACTIONS (ADD / DELETE / MODIFY)
// ----------------------------------------------------

function addInnerBox() {
    if (!ACTIVE_ORDER) return;
    
    // Choose first SKU by default, Size 3
    var defaultSku = ACTIVE_ORDER.items.length > 0 ? ACTIVE_ORDER.items[0].sku : "Linen Tshirt";
    var ruleCap = getSKUCapacity(defaultSku, "Size 3");

    ACTIVE_ORDER.innerBoxes.push({
        boxNo: generateInnerBoxNo(),
        boxSize: "Size 3",
        sku: defaultSku,
        qty: ruleCap > 0 ? ruleCap : 10,
        capacity: ruleCap > 0 ? ruleCap : 10,
        outerBoxNo: null
    });

    updatePackingProgress();
    renderInnerBoxes();
    validatePacking();
}

function deleteInnerBox(boxNo) {
    if (!ACTIVE_ORDER) return;

    ACTIVE_ORDER.innerBoxes = ACTIVE_ORDER.innerBoxes.filter(function (ib) {
        return ib.boxNo !== boxNo;
    });

    recalculateOuterProperties();
    updatePackingProgress();
    renderInnerBoxes();
    validatePacking();
}

function changeInnerBoxSize(boxNo, newSize) {
    if (!ACTIVE_ORDER) return;

    ACTIVE_ORDER.innerBoxes.forEach(function (ib) {
        if (ib.boxNo === boxNo) {
            ib.boxSize = newSize;
            var cap = getSKUCapacity(ib.sku, newSize);
            ib.capacity = cap;
            // Cap qty if it exceeds capacity and cap > 0
            if (cap > 0 && ib.qty > cap) {
                ib.qty = cap;
            }
        }
    });

    recalculateOuterProperties();
    updatePackingProgress();
    renderInnerBoxes();
    validatePacking();
}

function changeInnerBoxSku(boxNo, newSku) {
    if (!ACTIVE_ORDER) return;

    ACTIVE_ORDER.innerBoxes.forEach(function (ib) {
        if (ib.boxNo === boxNo) {
            ib.sku = newSku;
            var cap = getSKUCapacity(newSku, ib.boxSize);
            ib.capacity = cap;
            if (cap > 0 && ib.qty > cap) {
                ib.qty = cap;
            }
        }
    });

    recalculateOuterProperties();
    updatePackingProgress();
    renderInnerBoxes();
    validatePacking();
}

function adjustInnerBoxQty(boxNo, delta) {
    if (!ACTIVE_ORDER) return;

    ACTIVE_ORDER.innerBoxes.forEach(function (ib) {
        if (ib.boxNo === boxNo) {
            var newQty = ib.qty + delta;
            var cap = getSKUCapacity(ib.sku, ib.boxSize);
            
            if (newQty < 1) newQty = 1;
            
            ib.qty = newQty;
        }
    });

    updatePackingProgress();
    renderInnerBoxes();
    validatePacking();
}

function changeInnerBoxQty(boxNo, val) {
    if (!ACTIVE_ORDER) return;
    
    var num = parseInt(val, 10);
    if (isNaN(num) || num < 1) num = 1;

    ACTIVE_ORDER.innerBoxes.forEach(function (ib) {
        if (ib.boxNo === boxNo) {
            ib.qty = num;
        }
    });

    updatePackingProgress();
    renderInnerBoxes();
    validatePacking();
}

function addOuterBox() {
    if (!ACTIVE_ORDER) return;
    
    ACTIVE_ORDER.outerBoxes.push({
        outerBoxNo: generateOuterBoxNo(),
        volumeUsed: 0,
        weight: 0
    });

    renderOuterBoxes();
    validatePacking();
}

function deleteOuterBox(outerNo) {
    if (!ACTIVE_ORDER) return;

    // Remove outer box
    ACTIVE_ORDER.outerBoxes = ACTIVE_ORDER.outerBoxes.filter(function (ob) {
        return ob.outerBoxNo !== outerNo;
    });

    // Unplace inner boxes inside it
    ACTIVE_ORDER.innerBoxes.forEach(function (ib) {
        if (ib.outerBoxNo === outerNo) {
            ib.outerBoxNo = null;
        }
    });

    renderOuterBoxes();
    validatePacking();
}

function removeBoxFromOuter(innerBoxNo) {
    if (!ACTIVE_ORDER) return;

    ACTIVE_ORDER.innerBoxes.forEach(function (ib) {
        if (ib.boxNo === innerBoxNo) {
            ib.outerBoxNo = null;
        }
    });

    recalculateOuterProperties();
    renderOuterBoxes();
    validatePacking();
}

// ----------------------------------------------------
// DRAG AND DROP HANDLERS
// ----------------------------------------------------

function setupDragAndDrop() {
    // These events bind to outer list zones dynamically
}

function onBoxDragStart(ev) {
    DRAGGED_BOX_ID = ev.target.getAttribute('data-box-no');
    ev.dataTransfer.setData("text", DRAGGED_BOX_ID);
    ev.target.classList.add('dragging');
}

function onBoxDragOver(ev) {
    ev.preventDefault();
    var listZone = ev.currentTarget;
    listZone.classList.add('dragover');
}

function onBoxDragLeave(ev) {
    var listZone = ev.currentTarget;
    listZone.classList.remove('dragover');
}

function onBoxDrop(ev) {
    ev.preventDefault();
    var listZone = ev.currentTarget;
    listZone.classList.remove('dragover');
    
    var boxNo = ev.dataTransfer.getData("text");
    var outerNo = listZone.getAttribute('data-outer-no');

    if (ACTIVE_ORDER && boxNo && outerNo) {
        ACTIVE_ORDER.innerBoxes.forEach(function (ib) {
            if (ib.boxNo === boxNo) {
                ib.outerBoxNo = outerNo;
            }
        });
        
        recalculateOuterProperties();
        renderOuterBoxes();
        validatePacking();
    }
}

// ----------------------------------------------------
// VALIDATION & PREPARATION
// ----------------------------------------------------

function validatePacking() {
    var msgDiv = document.getElementById('validation-msg');
    var saveBtn = document.getElementById('save-packing-btn');
    if (!msgDiv || !ACTIVE_ORDER) return [];

    var errors = [];
    var warnings = [];

    // Rule 1: Item Quantities must match
    ACTIVE_ORDER.items.forEach(function (item) {
        var totalPacked = ACTIVE_ORDER.innerBoxes.reduce(function (sum, ib) {
            return sum + (ib.sku === item.sku ? ib.qty : 0);
        }, 0);

        if (totalPacked < item.qty) {
            errors.push('SKU "' + item.sku + '" is under-packed (' + totalPacked + ' / ' + item.qty + ' pcs).');
        } else if (totalPacked > item.qty) {
            errors.push('SKU "' + item.sku + '" is over-packed (' + totalPacked + ' / ' + item.qty + ' pcs).');
        }
    });

    // Rule 2: Inner box capacity compliance
    ACTIVE_ORDER.innerBoxes.forEach(function (ib) {
        var cap = getSKUCapacity(ib.sku, ib.boxSize);
        if (ib.qty > cap) {
            errors.push('Box ' + ib.boxNo + ' exceeds capacity (' + ib.qty + ' / ' + cap + ' max).');
        }
        if (cap === 0) {
            errors.push('Box ' + ib.boxNo + ' uses ' + ib.boxSize + ' which is invalid for SKU "' + ib.sku + '".');
        }
    });

    // Rule 3: Placed inside outer boxes
    var unplacedCount = ACTIVE_ORDER.innerBoxes.filter(function (ib) { return ib.outerBoxNo === null; }).length;
    if (unplacedCount > 0) {
        warnings.push(unplacedCount + ' inner box(es) not placed inside outer boxes.');
    }

    // Rule 4: Outer box points limits
    ACTIVE_ORDER.outerBoxes.forEach(function (ob) {
        var pts = calculateOuterPoints(ob.outerBoxNo);
        if (pts > MAX_OUTER_POINTS) {
            errors.push('Outer Box ' + ob.outerBoxNo + ' exceeds limit (' + pts + ' / ' + MAX_OUTER_POINTS + ' points).');
        }
    });

    if (errors.length > 0) {
        msgDiv.innerHTML = '<span class="validation-error">❌ ' + errors[0] + ' (' + errors.length + ' errors)</span>';
        if (saveBtn) saveBtn.disabled = true;
    } else if (warnings.length > 0) {
        msgDiv.innerHTML = '<span class="validation-error" style="color:var(--status-warning);">⚠️ ' + warnings[0] + '</span>';
        if (saveBtn) saveBtn.disabled = false; // allow force save on warnings
    } else {
        msgDiv.innerHTML = '<span class="validation-ok">✅ Packing configuration valid & complete.</span>';
        if (saveBtn) saveBtn.disabled = false;
    }

    return { errors: errors, warnings: warnings };
}

// ----------------------------------------------------
// SAVE DATA & PRINT
// ----------------------------------------------------

function savePackingData() {
    if (!ACTIVE_ORDER) return;

    var validation = validatePacking();
    if (validation.errors && validation.errors.length > 0) {
        alert("Please resolve the packing errors before completing:\n\n" + validation.errors.join("\n"));
        return;
    }

    if (validation.warnings && validation.warnings.length > 0) {
        var confirmWarn = confirm("Warnings exist:\n\n" + validation.warnings.join("\n") + "\n\nDo you want to proceed and save anyway?");
        if (!confirmWarn) return;
    }

    var saveBtn = document.getElementById('save-packing-btn');
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerText = "Saving packing logs...";
    }

    // Roll up packed items summaries
    var rolledItems = ACTIVE_ORDER.items.map(function (it) {
        var packed = ACTIVE_ORDER.innerBoxes.reduce(function (sum, ib) {
            return sum + (ib.sku === it.sku ? ib.qty : 0);
        }, 0);
        return {
            sku: it.sku,
            itemName: it.itemName,
            qtyToPack: it.qty,
            qtyPacked: packed
        };
    });

    var payload = {
        salesOrderId: ACTIVE_ORDER.id,
        staffName: SELECTED_STAFF,
        items: rolledItems,
        innerBoxes: ACTIVE_ORDER.innerBoxes,
        outerBoxes: ACTIVE_ORDER.outerBoxes
    };

    if (!isRunningInCreator()) {
        console.log("Simulating Save in Local environment:", payload);
        setTimeout(function () {
            alert("Packing completed successfully (Simulation)!");
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.innerText = "Check & Complete Packing";
            }
            // Remove from local queue
            QUEUE = QUEUE.filter(function (q) { return q.id !== ACTIVE_ORDER_ID; });
            ACTIVE_ORDER_ID = null;
            ACTIVE_ORDER = null;
            renderQueueList();
            
            var editor = document.getElementById('packing-editor');
            var emptyState = document.getElementById('workspace-empty-state');
            if (emptyState) emptyState.classList.remove('hidden');
            if (editor) editor.classList.add('hidden');
        }, 1000);
        return;
    }

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'savePackingRecord',
        http_method: 'POST',
        payload: {
            payloadJson: JSON.stringify(payload)
        }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            parsed = null;
        }

        if (parsed && parsed.success) {
            alert("Packing completed and saved successfully!");
            
            // Clear current workspace & refresh queue
            var editor = document.getElementById('packing-editor');
            var emptyState = document.getElementById('workspace-empty-state');
            if (emptyState) emptyState.classList.remove('hidden');
            if (editor) editor.classList.add('hidden');

            ACTIVE_ORDER_ID = null;
            ACTIVE_ORDER = null;
            loadDashboardData();
        } else {
            var errMsg = (parsed && parsed.error) ? parsed.error : "Unknown server error.";
            alert("Failed to save packing record: " + errMsg);
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.innerText = "Check & Complete Packing";
            }
        }
    }).catch(function (err) {
        console.error('savePackingRecord error:', err);
        alert("Network or API error while saving packing logs.");
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerText = "Check & Complete Packing";
        }
    });
}

function printPackingSlip() {
    if (!ACTIVE_ORDER) return;

    var printDiv = document.getElementById('print-layout');
    if (!printDiv) return;

    var dateStr = new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    
    var html = '<div class="print-slip-header">' +
        '<div>' +
            '<h1>PACKING SLIP / BOX LABELS</h1>' +
            '<p style="font-size:12px; color:#555;">Order packing details for transport verification</p>' +
        '</div>' +
        '<div style="text-align:right;">' +
            '<strong>Date:</strong> ' + dateStr + '<br>' +
            '<strong>Packer:</strong> ' + escapeHtml(SELECTED_STAFF) +
        '</div>' +
        '</div>';

    html += '<div style="margin-bottom: 20px;">' +
        '<h3>Order Reference: ' + ACTIVE_ORDER.orderNo + '</h3>' +
        '<strong>Order Source:</strong> ' + ACTIVE_ORDER.source + '<br>' +
        '<strong>Total Inner Boxes:</strong> ' + ACTIVE_ORDER.innerBoxes.length + ' | ' +
        '<strong>Total Outer Boxes:</strong> ' + ACTIVE_ORDER.outerBoxes.length +
        '</div>';

    // 1. Render Outer Box Packing lists
    html += '<h3>Outer Boxes Details</h3>';
    
    ACTIVE_ORDER.outerBoxes.forEach(function (ob) {
        var outerNo = ob.outerBoxNo;
        var inners = ACTIVE_ORDER.innerBoxes.filter(function (ib) { return ib.outerBoxNo === outerNo; });
        var ptsUsed = calculateOuterPoints(outerNo);

        html += '<div style="border: 1px solid #000; padding: 15px; margin-bottom: 15px; page-break-inside: avoid;">' +
            '<div style="display:flex; justify-content:space-between; border-bottom: 1px solid #000; padding-bottom: 6px; margin-bottom: 10px;">' +
                '<strong>Outer Box ID: ' + outerNo + '</strong>' +
                '<span>Points Used: ' + ptsUsed + ' / ' + MAX_OUTER_POINTS + ' | Vol: ' + ob.volumeUsed.toLocaleString() + ' cm³ | Weight: ' + ob.weight + ' kg</span>' +
            '</div>';

        if (inners.length === 0) {
            html += '<p style="font-style:italic; color:#777; font-size:12px;">This outer box is empty.</p>';
        } else {
            html += '<table class="print-table">' +
                '<thead>' +
                    '<tr>' +
                        '<th>Inner Box ID</th>' +
                        '<th>Size</th>' +
                        '<th>SKU / Product Name</th>' +
                        '<th style="text-align:right;">Quantity</th>' +
                    '</tr>' +
                '</thead>' +
                '<tbody>';

            inners.forEach(function (ib) {
                var itName = ib.sku;
                var matchIt = ACTIVE_ORDER.items.filter(function (it) { return it.sku === ib.sku; });
                if (matchIt.length > 0) itName = matchIt[0].itemName;

                html += '<tr>' +
                    '<td>' + ib.boxNo + '</td>' +
                    '<td>' + ib.boxSize + '</td>' +
                    '<td><strong>' + ib.sku + '</strong> - ' + escapeHtml(itName) + '</td>' +
                    '<td style="text-align:right;">' + ib.qty + ' pcs</td>' +
                    '</tr>';
            });

            html += '</tbody></table>';
        }

        html += '</div>';
    });

    // 2. Render Unplaced Boxes (if any)
    var unplaced = ACTIVE_ORDER.innerBoxes.filter(function (ib) { return ib.outerBoxNo === null; });
    if (unplaced.length > 0) {
        html += '<h3>⚠️ Unplaced Inner Boxes (Not Loaded in Outer Boxes)</h3>' +
            '<table class="print-table" style="border: 1px solid red; margin-bottom: 20px;">' +
            '<thead>' +
                '<tr>' +
                    '<th>Inner Box ID</th>' +
                    '<th>Size</th>' +
                    '<th>SKU</th>' +
                    '<th style="text-align:right;">Quantity</th>' +
                '</tr>' +
            '</thead>' +
            '<tbody>';

        unplaced.forEach(function (ib) {
            html += '<tr>' +
                '<td>' + ib.boxNo + '</td>' +
                '<td>' + ib.boxSize + '</td>' +
                '<td>' + ib.sku + '</td>' +
                '<td style="text-align:right;">' + ib.qty + ' pcs</td>' +
                '</tr>';
        });

        html += '</tbody></table>';
    }

    printDiv.innerHTML = html;
    window.print();
}
