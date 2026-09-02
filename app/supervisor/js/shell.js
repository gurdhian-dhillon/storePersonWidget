// Supervisor dashboard shell: tabs, the shared supervisor picker, and Refresh.
//
// Receive and Production were two separate widgets on two Creator pages. He
// moves between them constantly — confirm the cloth, then start cutting it —
// and a page navigation tears the widget down and refetches everything. One
// widget with client-side tabs keeps both alive.
//
// The two tab scripts are loaded unchanged apart from namespaced element ids.
// They have no global names in common, so they coexist without wrapping.

var TAB_LOADERS = {};
var tabsLoaded = {};

function showTab(name) {
    document.querySelectorAll('.tab-btn').forEach(function (b) {
        b.classList.toggle('is-active', b.getAttribute('data-tab') === name);
    });
    document.querySelectorAll('.tab-panel').forEach(function (p) {
        p.classList.toggle('is-active', p.id === 'panel-' + name);
    });

    if (!tabsLoaded[name] && TAB_LOADERS[name]) {
        tabsLoaded[name] = true;
        TAB_LOADERS[name]();
    }
}

function activeTab() {
    var btn = document.querySelector('.tab-btn.is-active');
    return btn ? btn.getAttribute('data-tab') : 'receive';
}

// A tab count is hidden at zero rather than shown as "0" — a badge should mean
// "there is something here", and a row of zeroes trains people to ignore them.
function setTabCount(id, n) {
    var el = document.getElementById(id);
    if (!el) return;
    if (!n || n <= 0) {
        el.textContent = '';
        el.classList.add('hidden');
    } else {
        el.textContent = n;
        el.classList.remove('hidden');
    }
}

function currentSupervisorId() {
    var sel = document.getElementById('sup-select');
    return sel ? sel.value : '';
}

function setTodayLabel() {
    var el = document.getElementById('app-date');
    if (!el) return;
    var d = new Date();
    var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    el.textContent = days[d.getDay()] + ', ' + d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
}

document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
        showTab(btn.getAttribute('data-tab'));
    });
});

// Badges before the tabs are opened, the same way the store does it. Without
// this a supervisor only learns a tab has something in it by opening the tab —
// which is backwards, because the badge is what should send him there. One
// small call that counts records and reads almost none of them.
//
// Every tab still fetches its own list when opened; this only draws numbers.
function loadSupCounts() {
    var supId = currentSupervisorId();
    if (!supId) {
        ['count-receive', 'count-production', 'count-order-overview', 'count-disputes', 'count-waste', 'count-reissue']
            .forEach(function (id) { setTabCount(id, 0); });
        return;
    }

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getSupervisorCounts',
        http_method: 'POST',
        payload: { supervisorId: String(supId) }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('getSupervisorCounts parse failed:', e, response.result);
            return;
        }
        if (parsed.errors && parsed.errors.length > 0) {
            console.error('getSupervisorCounts:', parsed.errors);
            return;
        }
        // Receive is the one badge somebody else owns. Its own render counts the
        // actual lines awaiting him; this call can only count handovers, which
        // is a close proxy and not the same number. Whoever is more accurate
        // wins, so the proxy fills the gap only until that tab has loaded — two
        // sources writing one badge would flicker between two answers.
        if (!tabsLoaded.receive) {
            setTabCount('count-receive', parsed.pendingReceive || 0);
        }
        setTabCount('count-production', parsed.activePlans || 0);
        // Order Overview lists the same open plans, so activePlans is the exact
        // count. Its own render overrides with orders.length once loaded (which
        // is the same number) — the proxy just fills in before first open.
        if (!tabsLoaded['order-overview']) {
            setTabCount('count-order-overview', parsed.activePlans || 0);
        }
        setTabCount('count-disputes', parsed.openDisputes || 0);
        setTabCount('count-waste', parsed.wasteWaiting || 0);
        // Counted from open Material_Damage headers, while the tab's own render
        // counts ITEMS — one item can carry damage from several reports, so the
        // two are legitimately different numbers. Same rule as receive: whoever
        // is more accurate wins, so the proxy only fills in until the tab loads.
        if (!tabsLoaded.reissue) {
            setTabCount('count-reissue', parsed.reissueWaiting || 0);
        }
    }).catch(function (err) {
        // A badge is not worth a visible failure — the tabs still work, they
        // just open without a number on them.
        console.error('getSupervisorCounts error:', err);
    });
}

// Changing supervisor invalidates every tab, not just the visible one — so the
// loaded flags are cleared and the open tab reloads. The others reload when
// next opened rather than now, which is the whole point of loading them lazily.
document.getElementById('sup-select').addEventListener('change', function () {
    var active = activeTab();
    Object.keys(tabsLoaded).forEach(function (k) {
        if (k !== active) tabsLoaded[k] = false;
    });
    if (TAB_LOADERS[active]) {
        tabsLoaded[active] = true;
        TAB_LOADERS[active]();
    }
    // The badges belong to the person, not the tab, so they are the one thing
    // that must refetch on every change of picker.
    loadSupCounts();
});

// REFRESH.
//
// Driven off tabsLoaded, not a hand-written list of tab names. This button did
// nothing at all — on every tab — because receive.js and production.js each say
// "Refresh is wired by the shell" and the shell never wired it. A list spelled
// out here would rot the same way the moment a seventh tab is added; a loop
// cannot, because registering a loader is what puts a tab in it.
//
// Only tabs already OPENED are reloaded, which is the point of loading them
// lazily - a tab never shown has nothing to bring up to date, and will fetch
// when it is opened.
document.getElementById('refresh-btn').addEventListener('click', function () {
    Object.keys(tabsLoaded).forEach(function (name) {
        if (tabsLoaded[name] && TAB_LOADERS[name]) {
            TAB_LOADERS[name]();
        }
    });
    // Same rule as the picker: badges belong to the person, not to a tab, so
    // they refetch whether or not the tab that shows them is open.
    loadSupCounts();
});

setTodayLabel();
