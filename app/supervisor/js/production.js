const API = {
	getProductionData: "getProductionWidgetData",
	savePhase: "saveProductionPhase",
	// One call for every kind of change to a share: add, re-size, end, remove.
	// The action rides in the payload.
	saveAssignment: "saveStageAssignment",
	expectedWaste: "getExpectedWaste",
	saveWaste: "saveWasteFromCutting",
	sendToThirdParty: "sendToThirdParty",
	receiveFromThirdParty: "receiveFromThirdParty",
	outsourceRateHistory: "getOutsourceRateHistory",
};

// Cutting is the only stage that produces remnants.
// Matched exactly to "Cutting" as per business rules.
function isCuttingPhase(name) {
	return String(name || "").trim() === "Cutting";
}

// A batch of garments the checker sent back to be fixed rather than remade.
//
// Everything that differs about it hangs off this ONE server flag and never off
// the shape of the phase list: a batch the checker sent to a single stage looks
// exactly like a one-stage BOM, and guessing from the list would give an
// ordinary item the alteration rules the first time somebody wrote a short BOM.
function isAlterationItem(item) {
	return !!item && item.isAlteration === true;
}

// A batch the checker rejected that nobody has asked the store for yet.
//
// The distinction matters because every "waiting for material" message on this
// screen names the STORE as who to chase, and here that is wrong: saveItemCheck
// deliberately asks them for nothing, so the batch waits on HIM until he raises
// it on the Reissue tab. Told to wait on the store he would wait for ever, and
// the store would have nothing to find when he asked why.
//
// The test is the same one the server uses — a Check_Reject batch with no
// requirements against it. Its own requirements are the only record of whether
// it has been raised, so an empty list IS the answer, not a loading state.
function isUnraisedRemake(item) {
	return (
		!!item &&
		item.remakeReason === "Check_Reject" &&
		item.status === "Awaiting_Material" &&
		(item.materials || []).length === 0
	);
}

// What a stage is working on.
//
// An ordinary stage receives what the stage before it produced. An alteration
// stage receives what the CHECKER asked to be fixed there — the whole batch is
// physically present at every stage, because a garment that gets restitched is
// not consumed by it. Chaining off the previous log would do two wrong things at
// once: carry one stage's "7 to alter" into every stage after it, and read a
// Qty_Out that the server writes equal to Qty_In by definition.
function stageQtyIn(item, phases, idx) {
	if (isAlterationItem(item)) return Number(phases[idx].plannedQty) || 0;
	return qtyInFor(item, phases, idx);
}

// Four kinds of batch and they must never collapse into one another: a
// replacement is cloth he spoiled on the floor, a failed check came back from
// the inspector days later, and an alteration is the garment being SAVED rather
// than made again. One helper because the item card and the order-finished
// summary both print this — two copies of the branch is how two screens end up
// describing the same item differently.
function remakeTagText(reason) {
	if (reason === "Production_Loss") return "Replacement batch";
	if (reason === "Alteration") return "Alteration batch";
	// An empty reason reads as a rejection on purpose. A batch of unknown cause
	// is more honestly a failed check than an alteration, which would promise
	// alteration stages that do not exist.
	return "Remake";
}

// Waste rows being edited in the End dialog. Kept flat with a rowKey so add and
// delete do not have to reason about array indices shifting under them.
let wasteDraft = [];
let wasteFabricOptions = [];
let wasteRowSeq = 0;
let pendingEnd = null; // {card, item, plan, payload} held while he edits waste

let operators = [];
let supervisors = [];
let plans = [];
// Absent until getProductionWidgetData is re-saved in Creator, and an empty
// list simply means no party covers any stage so the Send button never offers
// one.
let parties = [];
let selectedSupId = null;
let selectedPlanId = null;

// Which plan we have ALREADY re-asked the server for, so the detail retry below
// can fire once and never twice. Without it a plan the server declines to
// detail - one belonging to another supervisor, one that has left the live set
// between the two calls - would refetch for ever, each answer selecting the same
// plan and finding it detail-less again.
let detailRetryFor = null;

// Items where the supervisor has pressed "Start production" but not yet started
// a stage. Nothing is written to Creator for that click — it only reveals the
// flow — so a spurious tracking row never gets created. Once the first stage
// starts, item.logs is non-empty and this set stops mattering.
const revealedItems = new Set();

// Which item card is expanded. Held in state rather than in the DOM because
// every save triggers a full re-render — without this, logging a stage on the
// third item would snap the page back to the first one.
// undefined = not chosen yet (default to the first item); null = deliberately
// collapsed, which must survive the re-render rather than springing back open.
let openItemId;

// ---- Item pagination + search ----
//
// A Faire wholesale order is one plan with ~110 Plan_Item rows. The server now
// sends ONE PAGE of them (getProductionWidgetData's itemPageJson arg); this is
// the widget's half of it.
//
// ITEM_PAGE_SIZE is fixed at 10 by decision — one screen of cards. The server
// caps it at 50 regardless, so this is the only place it is set.
const ITEM_PAGE_SIZE = 10;

// Zero-based page index and the current search term. Reset to 0 / "" whenever
// the plan changes — a stale page or filter carried onto a different order is
// never what he wants.
let itemPage = 0;
let itemSearch = "";
// Rows in the filtered list, off the server's reply. Drives the pager.
let itemTotal = 0;
// Set for exactly one fetch when a save moves focus to an item that is not on
// the page on screen — tells the server "return the page holding this one".
// Cleared as soon as that fetch is issued so it cannot pin the view.
let pendingFocusItemId = "";

// Which page fetch we have already re-asked for with a focus hint, so the
// off-page recovery below fires once and never loops.
let focusRetryFor = null;

function nowHHMM() {
	const d = new Date();
	return (
		String(d.getHours()).padStart(2, "0") +
		":" +
		String(d.getMinutes()).padStart(2, "0")
	);
}

// A Creator Time comes back as "18:16:00", and seconds on a shop-floor clock are
// noise — three stages in a row read as a wall of colons. Trimmed for DISPLAY
// only; what is stored is untouched.
//
// Defensive about the shape rather than parsing it: the same field renders as
// "18:16", "18:16:00" and "06:16 PM" depending on where it came from, so this
// only ever removes a trailing :SS and leaves anything it does not recognise
// exactly as it arrived.
function hhmm(t) {
	const s = String(t == null ? "" : t).trim();
	if (!s) return "—";
	return s.replace(/^(\d{1,2}:\d{2}):\d{2}/, "$1");
}

// A stage's input quantity is never typed. The first stage receives the whole
// order; every later one receives exactly what the stage before it produced.
function qtyInFor(item, phases, idx) {
	if (idx === 0) return Number(item.qty) || 0;
	const prev = (item.logs || []).find(
		(l) => l.phase === phases[idx - 1].operation,
	);
	return prev ? Number(prev.qtyOut) || 0 : 0;
}

// Stage logs carry the operator's id, not their name — resolved here against
// the list the widget already loaded rather than asking the server to send the
// name on every log row.
function operatorName(id) {
	if (!id) return "";
	const op = operators.find((o) => String(o.id) === String(id));
	return op ? op.name : "";
}

function phaseState(log) {
	if (!log || !log.start) return "todo";
	return log.end ? "done" : "active";
}

// ---- Shares of a stage ----
//
// A stage's work is split between several operators, one Stage_Assignment each.
// The server sends them on the stage log as `assigns`; everything below reads
// that one array so the card, the buttons and the totals can never disagree
// about who is on the stage.
//
// An OLD stage log has no assigns at all — every stage logged before the split
// existed, and every outsourced one. Defaulting to [] is what lets those render
// from the header's own operator and figures instead of throwing.
function sharesOf(log) {
	return (log && log.assigns) || [];
}

function shareTotal(log, key) {
	return sharesOf(log).reduce((sum, a) => sum + (Number(a[key]) || 0), 0);
}

function openShares(log) {
	return sharesOf(log).filter((a) => a.status !== "Done");
}

// ---- A share held by a third party ----
//
// A VENDOR IS AN OPERATOR WHO WORKS OFF-SITE. He takes a share of the stage like
// anyone else — `party` filled instead of `operator` — and the remainder is
// handed out in-house from the same pool. Forty pieces at a vendor and sixty
// across two cutters is ONE stage with three shares, and the moment the vendor is
// drawn anywhere but this table the two halves stop adding up to Qty_In.
//
// That is what the old model got wrong: sending part of a stage out overwrote the
// stage's own Qty_In with the sent quantity, so the pieces that stayed behind
// disappeared from every count with nothing on any screen to say where they went.
function isPartyShare(a) {
	return !!(a && a.party);
}

// Blocks of this item still at a vendor, keyed by the reference they went out
// under. One entry per trip — a block spanning three stages is three shares and
// one entry, because it comes back in one van.
function openPartyBlocks(item) {
	const seen = {};
	const out = [];
	(item.logs || []).forEach((log) => {
		sharesOf(log).forEach((a) => {
			if (!isPartyShare(a) || a.returnedOn) return;
			const ref = String(a.osRef || "");
			if (seen[ref]) {
				seen[ref].shares.push(a);
				seen[ref].names.push(log.phase);
				return;
			}
			seen[ref] = {
				ref: ref,
				partyId: a.party,
				sentOn: a.sentOn || "",
				qtySent: Number(a.assigned) || 0,
				shares: [a],
				// The stages this trip is carrying them through, so the return
				// dialog can name them. Collected off the logs rather than the
				// shares because item.logs already arrives in sequence order.
				names: [log.phase],
			};
			out.push(seen[ref]);
		});
	});
	return out;
}

// ---- Where a block ends, and what that means for the stages before it ----
//
// THE VAN COMES BACK ONCE, AFTER THE LAST OPERATION. Everything below follows
// from that one physical fact.
//
// **Take it back belongs on the block's FINAL stage and nowhere else.** Offering
// it on the first invites him to receive pieces the vendor has not started on,
// and the count he would be asked for is the count after every operation.
//
// **An EARLIER stage of the block is not waiting for that van.** Those pieces
// left it the moment they were loaded — it is finished with them. The rule that
// the loss lands on the block's last stage says so exactly: every earlier stage
// passes its full quantity through, which is what `receiveFromThirdParty` writes
// on the return. So an earlier stage can close while the van is still out, and it
// has to be able to: the in-house half of a split stage is otherwise held up for
// days by pieces that are not even in the building.
//
// `item.logs` arrives sorted by Sequence_No, so the last stage seen for a
// reference is that block's final one.
function osBlockLastPhase(item) {
	const last = {};
	(item.logs || []).forEach((log) => {
		sharesOf(log).forEach((a) => {
			if (isPartyShare(a) && a.osRef) last[a.osRef] = log.phase;
		});
	});
	return last;
}

// This share is at a vendor, on a stage the vendor has already carried it past.
// Its pieces are spent as far as THIS stage is concerned.
function isPassThrough(a, phaseName, osLast) {
	return (
		isPartyShare(a) &&
		a.status !== "Done" &&
		!!a.osRef &&
		osLast[a.osRef] !== phaseName
	);
}

// What a share has contributed to this stage's output. Reading Qty_Out on a
// pass-through share would report its pieces as zero and make a closed stage look
// like it lost every one of them.
function shareOutFor(a, passThrough) {
	return Number(passThrough ? a.assigned : a.qtyOut) || 0;
}

// Who holds a share — a man, or a vendor. One helper because the running card and
// the finished-stage summary both print it, and the summary was naming a vendor
// "Not recorded" because it only ever looked at Operator.
function shareWho(a) {
	if (isPartyShare(a)) {
		const p = typeof partyById === "function" ? partyById(a.party) : null;
		return p ? p.name : "Third party";
	}
	return operatorName(a.operator) || "Not recorded";
}

// A stage started under the OLD single-operator code: it is running, it has an
// operator on the header, and nobody has been assigned a share.
//
// Kept working rather than migrated. Whatever is mid-run on the floor the day
// this ships must still be endable — a supervisor who cannot close the stage he
// is standing at would have to leave it open for ever.
function isLegacyStage(log) {
	return !!(log && log.start && log.operator && sharesOf(log).length === 0);
}

// Who the admin has put on this stage. The server hands every operator a
// `stages` array, matched here rather than in Deluge.
//
// AN ASSIGNMENT IS A RESTRICTION WHEN IT EXISTS; NO ASSIGNMENT IS NOT ONE.
// Assign Cutting to three men and Cutting offers those three. Leave Stitching
// unassigned and Stitching offers everyone, rather than nobody — otherwise the
// morning the admin forgets, every picker on the floor is empty and the whole
// factory stops. A gate people cannot pass teaches them to work around the
// record.
function operatorsForStage(stageName, selectedId) {
	const want = String(stageName || "").trim();
	// Exact match, never includes() — "Machine Embroidery" sits inside "Manual
	// Machine Embroidery", so a substring test offers the wrong men.
	const assigned = want
		? operators.filter((o) =>
				(o.stages || []).some((s) => String(s).trim() === want),
			)
		: [];
	let list = assigned.length > 0 ? assigned : operators;

	// Whoever is already on the stage stays listed, assigned or not. Without
	// this, re-rendering a running stage drops the operator it is holding out of
	// its own dropdown and the next save writes back an empty one. Same rule the
	// server states for inactive third parties: a name that has left the picker
	// must still show where it is already in use.
	if (selectedId && !list.some((o) => String(o.id) === String(selectedId))) {
		const cur = operators.find((o) => String(o.id) === String(selectedId));
		if (cur) list = [cur].concat(list);
	}
	return list;
}

const elSupSelect = document.getElementById("sup-select");
const elPlanSelect = document.getElementById("plan-select");
const elRefreshBtn = document.getElementById("refresh-btn");
const elPlanContainer = document.getElementById("prod-container");
const elDynamicContent = document.getElementById("prod-content");
const elEmptyState = document.getElementById("prod-empty");

function showLoading(msg) {
	parkPlanSelect();
	elDynamicContent.innerHTML = `
        <div class="skeleton-card">
            <div class="skeleton-line w-40"></div>
            <div class="skeleton-line w-70"></div>
            <div class="skeleton-line"></div>
        </div>
    `;
	elEmptyState.classList.add("hidden");
}

function showError(msg) {
	parkPlanSelect();
	elDynamicContent.innerHTML = `
        <div class="prod-empty" style="border-color: var(--status-danger);">
            <div class="icon" style="color: var(--status-danger);">⚠️</div>
            <h2>Error</h2>
            <p style="color: var(--status-danger);">${msg}</p>
        </div>
    `;
}

// Supervisors who actually have a plan on this screen, worked out from the
// plans themselves. Used when the server did not send the list.
function derivedSupervisors() {
	const seen = {};
	const out = [];
	plans.forEach((p) => {
		const id = String(p.assignedTo || "");
		if (!id || seen[id]) return;
		seen[id] = true;
		const emp = operators.find((o) => String(o.id) === id);
		out.push({ id: id, name: emp ? emp.name : "Unknown" });
	});
	return out;
}

// The picker is shared across tabs and filled once by Receive. Rebuilding it
// here would wipe that list and reset the selection every time Production
// loaded — so this only ADDS supervisors Receive could not know about: someone
// with production work but nothing left to receive.
function renderSupDropdown() {
	const existing = {};
	Array.prototype.forEach.call(elSupSelect.options, (o) => {
		existing[String(o.value)] = true;
	});

	supervisors.forEach((op) => {
		if (existing[String(op.id)]) return;
		const opt = document.createElement("option");
		opt.value = op.id;
		opt.textContent = op.name;
		elSupSelect.appendChild(opt);
	});

	if (selectedSupId) {
		elSupSelect.value = selectedSupId;
	}
}

function renderPlanDropdown() {
	elPlanSelect.innerHTML = `<option value="">-- Select a Sales Order --</option>`;
	if (!selectedSupId) {
		elPlanSelect.disabled = true;
		selectedPlanId = null;
		return;
	}
	elPlanSelect.disabled = false;

	const filteredPlans = plans.filter((p) => p.assignedTo === selectedSupId);
	filteredPlans.forEach((p) => {
		const opt = document.createElement("option");
		opt.value = p.id;
		opt.textContent =
			p.salesOrder +
			" (" +
			p.planNo +
			")" +
			(p.orderStatus === "Pending" ? " — awaiting material" : "");
		elPlanSelect.appendChild(opt);
	});

	setTabCount("count-production", filteredPlans.length);

	// If the currently selected plan is no longer in the filtered list, reset it.
	if (selectedPlanId && !filteredPlans.find((p) => p.id === selectedPlanId)) {
		selectedPlanId = null;
	}

	// Open an order rather than the "No order open" placeholder. Most
	// supervisors have one or two, and picking from a dropdown to see the only
	// thing on your plate is a step that earns nothing.
	//
	// A Pending order is skipped in favour of one with material, because it has
	// nothing he can act on — every stage on it shows "Waiting on Store". It is
	// still in the dropdown, just not what the tab opens on.
	if (!selectedPlanId && filteredPlans.length > 0) {
		const workable = filteredPlans.find((p) => p.orderStatus !== "Pending");
		selectedPlanId = (workable || filteredPlans[0]).id;
		// New order on screen, so open its first item rather than carrying over
		// whichever index was expanded on a previous one — and start at page 1
		// with no filter, since both belong to the order we just left.
		openItemId = undefined;
		itemPage = 0;
		itemSearch = "";
	}

	if (selectedPlanId) {
		elPlanSelect.value = selectedPlanId;
	} else {
		elPlanSelect.value = "";
	}
}

// afterRender fires once the new data is on screen. The order-complete popup
// uses it so the next order is already open behind the dialog when it appears -
// showing it first would announce a move that had not happened yet.
function fetchAllData(afterRender) {
	elRefreshBtn.disabled = true;
	// Scoped server-side now. The picker is filled by Receive from the full
	// Employee list, so narrowing this does not shrink the dropdown — it only
	// stops the factory's entire day being fetched to draw one man's screen.
	const forSup = elSupSelect ? elSupSelect.value || "" : "";

	// The page holding the item we want in view. pendingFocusItemId wins for one
	// fetch (a save moved focus off-page); otherwise the plain page index.
	const focusForThis = pendingFocusItemId;
	pendingFocusItemId = "";
	// This fetch is NOT a focus-recovery retry, so clear the guard — the next
	// render is free to try recovering again if the open item is off-page.
	if (!focusForThis) focusRetryFor = null;

	ZOHO.CREATOR.DATA.invokeCustomApi({
		api_name: API.getProductionData,
		http_method: "POST",
		payload: {
			supervisorId: String(forSup),
			// Only this plan comes back with items. Everything else is a
			// dropdown row, and nothing the dropdown shows comes from an item.
			planId: String(selectedPlanId || ""),
			// ONE PAGE of that plan's items. A single JSON string so a later
			// paging tweak never needs another Creator Custom API config change.
			itemPageJson: JSON.stringify({
				skip: itemPage * ITEM_PAGE_SIZE,
				limit: ITEM_PAGE_SIZE,
				focusItemId: focusForThis,
				search: itemSearch,
			}),
		},
	})
		.then((response) => {
			elRefreshBtn.disabled = false;
			try {
				const data = JSON.parse(response.result);
				if (data.errors && data.errors.length > 0) {
					showError(data.errors.join("<br>"));
					return;
				}
				operators = data.operators || [];
				plans = data.plans || [];

				// Absent until getProductionWidgetData is re-saved in Creator.
				// Defaulting to [] means no party covers any stage, which renders
				// as a Send button that offers nobody rather than throwing on a
				// key that is not there yet.
				parties = data.parties || [];

				// Prefer the server's list, but derive it from the plans if the
				// function has not been re-saved yet. A missing key would otherwise
				// render an empty dropdown that looks like lost data rather than a
				// stale deployment.
				supervisors = data.supervisors || derivedSupervisors();

				// Read from the shared control rather than local state: the
				// shell may have changed it while this tab was closed.
				selectedSupId = elSupSelect.value || selectedSupId;

				renderSupDropdown();

				// THE PLAN THE WIDGET OPENS AND THE PLAN THE SERVER DETAILED ARE
				// PICKED BY TWO DIFFERENT RULES, and on a first load they can
				// disagree.
				//
				// planId leaves here empty the first time, so getProductionWidgetData
				// falls back to the FIRST plan in its list. renderPlanDropdown then
				// auto-opens the first plan that is not "Pending", because a Pending
				// order has nothing he can act on. A supervisor whose oldest order is
				// still awaiting material therefore lands on a different plan from the
				// one that came back with items - and the screen said "No Items Found"
				// on an order that has them.
				//
				// hasDetail is the server saying which plan it answered for, so this
				// asks it rather than trying to keep the two rules in step. The change
				// handler on the dropdown already does exactly this; the auto-selection
				// was the path with no guard on it.
				renderPlanDropdown();

				const shownPlan = plans.find(
					(p) => String(p.id) === String(selectedPlanId),
				);
				if (
					selectedPlanId &&
					(!shownPlan || shownPlan.hasDetail !== true) &&
					detailRetryFor !== String(selectedPlanId)
				) {
					detailRetryFor = String(selectedPlanId);
					showLoading();
					fetchAllData(afterRender);
					return;
				}
				detailRetryFor = null;

				// The pager reads these off the DETAILED plan's light row — the
				// server clamps skip to the real list length, so trusting the
				// reply rather than what we asked for keeps the pager in step
				// with the rows actually on screen.
				const detailedPlan = plans.find(
					(p) => String(p.id) === String(selectedPlanId),
				);
				if (detailedPlan && detailedPlan.hasDetail === true) {
					itemTotal = Number(detailedPlan.itemTotal) || 0;
					const srvLimit =
						Number(detailedPlan.itemLimit) || ITEM_PAGE_SIZE;
					itemPage = Math.floor(
						(Number(detailedPlan.itemSkip) || 0) / srvLimit,
					);
				}

				renderSelectedPlan();

				if (typeof afterRender === "function") {
					afterRender();
				}
			} catch (e) {
				console.error(e, response);
				showError("Failed to parse server data: " + e.message);
			}
		})
		.catch((err) => {
			elRefreshBtn.disabled = false;
			showError("Failed to fetch data. Check console.");
			console.error(err);
		});
}

// The order picker belongs with the order it identifies, not floating above the
// page - so it sits inside the plan header beside the status badge. Parked back
// in the toolbar whenever no plan is open, otherwise there would be nowhere to
// pick one from.
function parkPlanSelect() {
	const sel = document.getElementById("plan-select");
	const toolbar = document.querySelector(".prod-toolbar");
	if (sel && toolbar && sel.parentElement !== toolbar) {
		// Put it back FIRST, so it sits before the toggle rather than after it.
		toolbar.insertBefore(sel, toolbar.firstChild);
	}
}

function dockPlanSelect() {
	const sel = document.getElementById("plan-select");
	const slot = document.getElementById("plan-slot");
	if (sel && slot) {
		slot.appendChild(sel);
	}
}

function renderSelectedPlan() {
	// Park BEFORE any innerHTML assignment below. Once docked, the select lives
	// inside elDynamicContent, and wiping that removes the node from the
	// document - after which there is nothing left to move back.
	parkPlanSelect();

	if (!selectedPlanId) {
		elDynamicContent.innerHTML = "";
		elEmptyState.classList.remove("hidden");
		parkPlanSelect();
		return;
	}
	elEmptyState.classList.add("hidden");

	const plan = plans.find((p) => p.id === selectedPlanId);
	if (!plan) {
		showError("Selected plan not found.");
		parkPlanSelect();
		return;
	}

	// Nothing on screen — three different reasons, three different messages, all
	// with the header and search box still shown so he can act.
	//   - a search that matched nothing
	//   - every original done and only (also-done) remakes left: the moment
	//     between QC rejecting and the store issuing
	//   - the plan genuinely has no items
	// The header reads plan.itemStats regardless, so it keeps describing the
	// whole order.
	if (!plan.items || plan.items.length === 0) {
		const s = plan.itemStats || {};
		const allDone =
			!itemSearch &&
			Number(s.count) > 0 &&
			Number(s.doneCount) === Number(s.count);

		let body;
		if (itemSearch) {
			body = `<div class="prod-empty">
                <div class="icon">🔍</div>
                <h2>No items match “${escapeHtml(itemSearch)}”</h2>
                <p>Clear the search above to see the whole order.</p>
            </div>`;
		} else if (allDone) {
			body = `<div class="prod-empty">
                <div class="icon">✅</div>
                <h2>Nothing to work on</h2>
                <p>Every item on this plan is complete.</p>
            </div>`;
		} else {
			body = `<div class="prod-empty">
                <div class="icon">🔍</div>
                <h2>No Items Found</h2>
                <p>This plan does not have any finished items attached.</p>
            </div>`;
		}

		elDynamicContent.innerHTML = renderPlanHeader(plan) + body;
		dockPlanSelect();
		wireItemSearch();
		return;
	}

	// The server now applies the "hide finished originals once a plan carries a
	// QC remake" filter AND the search AND the paging, so this list is exactly
	// what to draw. renderPlanHeader reads plan.itemStats, not this list, so the
	// header still describes the whole order.
	const visibleItems = plan.items;

	// The open item is not on this page — a save moved focus off it. Ask the
	// server once for the page that holds it rather than snapping to the first
	// card of whatever page we are on. Guarded so it cannot loop.
	if (
		openItemId !== null &&
		openItemId !== undefined &&
		!visibleItems.find((i) => i.id === openItemId) &&
		focusRetryFor !== String(openItemId)
	) {
		focusRetryFor = String(openItemId);
		pendingFocusItemId = String(openItemId);
		showLoading();
		fetchAllData();
		return;
	}
	focusRetryFor = null;

	// Default to the first item on the page when nothing is open (fresh plan,
	// or the open one really has gone away and the focus fetch above already
	// ran).
	if (
		openItemId !== null &&
		!visibleItems.find((i) => i.id === openItemId)
	) {
		openItemId = visibleItems[0].id;
	}

	elDynamicContent.innerHTML = renderPlanHeader(plan);
	dockPlanSelect();
	wireItemSearch();

	// index is the position ON THE PAGE; the serial the card prints has to be
	// the position in the WHOLE list, so it is offset by where the page starts.
	const pageBase = itemPage * ITEM_PAGE_SIZE;
	visibleItems.forEach((item, index) => {
		const card = renderItemCard(plan, item, pageBase + index);
		elDynamicContent.appendChild(card);

		const hasFabric = (item.materials || []).some(
			(m) => m.isFabric && !m.isWaste,
		);
		if (!hasFabric) return;

		// The server folds the expected-waste prediction into the item now
		// (item.expectedWaste). Fill the cells from it directly — zero extra
		// calls. Only fall back to the per-item getExpectedWaste call when the
		// field is absent, which means the .dg has not been redeployed yet.
		if (item.expectedWaste && Array.isArray(item.expectedWaste.fabrics)) {
			fillExpectedWaste(item.id, item.expectedWaste.fabrics);
			return;
		}

		ZOHO.CREATOR.DATA.invokeCustomApi({
			api_name: API.expectedWaste,
			http_method: "POST",
			payload: {
				planId: plan.id,
				planItemId: item.id,
				qtyOut: String(item.qty || 0),
			},
		}).then((response) => {
			try {
				const data = JSON.parse(response.result);
				fillExpectedWaste(item.id, data.fabrics || []);
			} catch (e) {
				console.error("Waste parse error", e);
			}
		});
	});

	renderItemPager(plan);
}

// Paint the "Expected waste" cells for one item from a fabrics[] array — the
// same shape whether it came folded into the item or from a standalone
// getExpectedWaste call.
function fillExpectedWaste(itemId, fabrics) {
	fabrics.forEach((f) => {
		const el = document.getElementById(`exp-waste-${itemId}-${f.materialId}`);
		if (!el) return;
		if (f.waste && f.waste.length > 0) {
			el.innerHTML = f.waste
				.map(
					(w) =>
						`<div style="padding: 2px 0;"><b>${w.count}</b> <span class="unit">pc${w.count > 1 ? "s" : ""}</span> of ${w.length}&times;${w.width}<span class="unit">cm</span></div>`,
				)
				.join("");
			el.style.opacity = "1";
			el.classList.remove("is-muted");
		} else {
			el.innerHTML = "No waste";
		}
	});
}

// ---- The item search box, in the plan header ----
//
// Re-wired after every render because the whole panel is rebuilt on each fetch.
//
// The search runs on BLUR, on Enter, or on the button beside it — NOT on every
// keystroke. A per-keystroke fetch re-renders the whole panel under the cursor
// (losing the caret, needing a re-focus dance) and fires a server call per
// letter; committing the term once he is done typing is both simpler and
// cheaper. Escape clears it.
function wireItemSearch() {
	const box = document.getElementById("item-search");
	const btn = document.getElementById("item-search-go");
	if (!box) return;

	const commit = () => {
		const next = box.value.trim();
		if (next === itemSearch) return;
		itemSearch = next;
		// A new filter starts at its first page — page 6 of a search that only
		// has two is not where he means to be.
		itemPage = 0;
		openItemId = undefined;
		showLoading();
		fetchAllData();
	};

	box.addEventListener("blur", commit);
	box.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			commit();
		} else if (e.key === "Escape") {
			box.value = "";
			commit();
		}
	});
	if (btn) btn.addEventListener("click", commit);
}

// ---- Item pager ----
//
// The same control the store widget uses on its history tabs (pageListFor /
// pagerHtml there). Ported here rather than shared because the two widgets are
// separate bundles. Server-paged: each button re-fetches one page.

function itemPageListFor(cur, last) {
	const want = {};
	want[1] = true;
	want[last] = true;
	for (let p = cur - 1; p <= cur + 1; p++) {
		if (p >= 1 && p <= last) want[p] = true;
	}
	const nums = Object.keys(want)
		.map(Number)
		.sort((a, b) => a - b);
	const out = [];
	let prev = 0;
	nums.forEach((n) => {
		if (prev > 0 && n - prev > 1) out.push(null);
		out.push(n);
		prev = n;
	});
	return out;
}

function renderItemPager(plan) {
	const total = itemTotal || 0;
	const shown = (plan.items || []).length;
	const last = Math.max(1, Math.ceil(total / ITEM_PAGE_SIZE));
	const cur = itemPage + 1;
	const from = total === 0 ? 0 : itemPage * ITEM_PAGE_SIZE + 1;
	const to = itemPage * ITEM_PAGE_SIZE + shown;

	// A single page of an unsearched order needs no control at all — the header
	// already says how many items there are.
	if (last <= 1 && !itemSearch) return;

	const btn = (page, label, extra, off) =>
		`<button type="button" class="pg-btn${extra || ""}"${
			off ? " disabled" : ""
		} data-page="${page}">${label}</button>`;

	let controls = "";
	if (last > 1) {
		controls =
			btn(cur - 1, "&lsaquo;", " pg-arrow", cur === 1) +
			itemPageListFor(cur, last)
				.map((p) =>
					p === null
						? `<span class="pg-gap">&hellip;</span>`
						: btn(p, p, p === cur ? " is-current" : "", p === cur),
				)
				.join("") +
			btn(cur + 1, "&rsaquo;", " pg-arrow", cur === last);
	}

	const wrap = document.createElement("div");
	wrap.className = "item-pager";
	wrap.innerHTML =
		`<span class="pg-count">Showing ${from}&ndash;${to} of ${total}` +
		`${itemSearch ? " matching" : ""} item${total === 1 ? "" : "s"}</span>` +
		controls;

	wrap.querySelectorAll(".pg-btn").forEach((b) => {
		if (b.disabled) return;
		b.addEventListener("click", () => {
			const n = Number(b.getAttribute("data-page"));
			if (!n || n === cur) return;
			itemPage = n - 1;
			// New page, so let it open its own first card rather than hunting
			// for whichever item was expanded on the last one.
			openItemId = undefined;
			showLoading();
			fetchAllData();
		});
	});

	elDynamicContent.appendChild(wrap);
}

// What the supervisor is looking at, stated once at the top. Without it the
// screen opens straight into item cards and the only clue which order is on
// screen is a dropdown he set several clicks ago.
function renderPlanHeader(plan) {
	// The header describes the WHOLE ORDER, and the page on screen is one slice
	// of it, so these come from plan.itemStats — computed server-side over every
	// Plan_Item with no child queries. Deriving them from plan.items here would
	// make a 10-item page report a 10-item order.
	//
	// itemStats is only filled on the detailed plan's row. A plan that has not
	// been detailed yet (should not reach here) falls back to counting what it
	// was given, which is the old behaviour.
	const s = plan.itemStats || {};
	const totalItems =
		s.count != null ? Number(s.count) || 0 : (plan.items || []).length;
	const totalQty =
		s.toProduce != null
			? Number(s.toProduce) || 0
			: (plan.items || [])
					.filter((i) => !i.isRemake)
					.reduce((sum, i) => sum + (Number(i.qty) || 0), 0);
	const producedQty =
		s.produced != null
			? Number(s.produced) || 0
			: (plan.items || []).reduce(
					(sum, i) => sum + (Number(i.produced) || 0),
					0,
				);
	const doneCount = s.doneCount != null ? Number(s.doneCount) || 0 : 0;
	const remakeQty = s.remakeQty != null ? Number(s.remakeQty) || 0 : 0;

	const stats = [
		["Sales order", plan.salesOrder || "—"],
		["Plan", plan.planNo || "—"],
		["Plan date", plan.planDate || "—"],
		["Items", String(totalItems)],
		["To produce", `${totalQty} pcs`],
		["Produced", `${producedQty} pcs`],
	];

	// Only when there is remake work outstanding. On a plan that never had any,
	// the header is exactly what it always was.
	if (remakeQty > 0) {
		stats.push(["Remaking", `${remakeQty} pcs`]);
	}

	return `
        <div class="plan-header">
            <div class="plan-header-top">
                <div>
                    <div class="plan-header-title">${plan.salesOrder || plan.planNo || "Plan"}</div>
                    <div class="plan-header-sub">${doneCount} of ${totalItems} items complete${
											remakeQty > 0
												? ` &middot; remaking ${remakeQty} pcs after QC`
												: ""
										}</div>
                </div>
                <div class="plan-header-controls">
                    <div class="item-search-group">
                        <input type="search" id="item-search" class="item-search"
                            placeholder="Find an item in this order…"
                            value="${escapeHtml(itemSearch)}"
                            autocomplete="off">
                        <button type="button" id="item-search-go" class="item-search-go">Search</button>
                    </div>
                    <div id="plan-slot"></div>
                    <span class="plan-status-pill">${plan.orderStatus || "—"}</span>
                </div>
            </div>
            <div class="plan-header-stats">
                ${stats
									.map(
										([label, value]) => `
                    <div class="plan-stat">
                        <div class="plan-stat-label">${label}</div>
                        <div class="plan-stat-value">${value}</div>
                    </div>
                `,
									)
									.join("")}
            </div>
        </div>
    `;
}

// Deferred a frame: renderSelectedPlan has only just written the cards, and
// scrolling to an element the browser has not laid out yet measures the old
// positions and lands in the wrong place.
function scrollItemIntoView(itemId) {
	requestAnimationFrame(() => {
		const el = elDynamicContent.querySelector(
			'.item-card[data-item-id="' + itemId + '"]',
		);
		if (el) {
			el.scrollIntoView({ behavior: "smooth", block: "start" });
		}
	});
}

function generateOperatorDropdown(selectedId, disabled, stageName) {
	// No inline width — the field grid decides how wide this is, and 120px was
	// clipping longer operator names.
	let html = `<select class="issue-input" ${disabled ? "disabled" : ""}>`;
	html += `<option value="">-- Operator --</option>`;
	operatorsForStage(stageName, selectedId).forEach((op) => {
		const sel = op.id === selectedId ? "selected" : "";
		html += `<option value="${op.id}" ${sel}>${op.name}</option>`;
	});
	html += `</select>`;
	return html;
}

function renderItemCard(plan, item, index) {
	const card = document.createElement("div");
	// One item open at a time — a supervisor works one item through its stages,
	// and several expanded cards of stage controls is a lot to scroll past.
	card.className = item.id === openItemId ? "item-card open" : "item-card";
	// Every render builds fresh nodes, so this is how the card is found again
	// afterwards to scroll to it.
	card.setAttribute("data-item-id", item.id);

	let statusText = "Ready";
	let statusColor = "var(--text-muted)";

	if (item.status === "Awaiting_Material") {
		// "Waiting on store" named who to chase, not what is missing. The cases
		// below are what he actually needs to tell apart: nobody has asked for it
		// yet, nothing has arrived at all, or some has and he is short the rest.
		const anyReceived = (item.materials || []).some(
			(m) => Number(m.received) > 0,
		);
		if (isUnraisedRemake(item)) {
			statusText = "Not asked for yet";
		} else {
			statusText = anyReceived
				? "Material partially received"
				: "No material yet";
		}
		statusColor = "#d97706"; // Amber
	} else if (item.status === "Ready_For_Production") {
		statusText = "Ready to start";
		statusColor = "#2563eb"; // Blue
	} else if (item.status === "Awaiting_Check") {
		// Production is finished and the inspector has not been yet. Without its
		// own branch this falls into the catch-all below, which sees every stage
		// closed and prints "Finishing" — neither a stage any more nor what is
		// actually happening to the garments.
		statusText = "Waiting for checking";
		statusColor = "#0891b2"; // Teal — done, not an error, not finished either
	} else if (item.status === "Complete") {
		statusText = "Completed";
		statusColor = "#16a34a"; // Green
	} else {
		let currentPhase = "In production";
		if (item.phases && item.phases.length > 0) {
			const sortedPhases = item.phases
				.slice()
				.sort((a, b) => a.sequence - b.sequence);
			let pIdx = sortedPhases.length;
			sortedPhases.forEach((p, i) => {
				const log = (item.logs || []).find((l) => l.phase === p.operation);
				if (!(log && log.end) && i < pIdx) pIdx = i;
			});
			if (pIdx < sortedPhases.length) {
				currentPhase = "At " + sortedPhases[pIdx].operation;
			} else if (isAlterationItem(item)) {
				// The ONLY way to be In_Production with every stage closed. An
				// ordinary item's last stage sets Awaiting_Check and is caught
				// above; an alteration batch is deliberately left here until the
				// supervisor declares how many garments are going back, because
				// no stage figure can answer that.
				//
				// "Finishing" was the old fallback and is now doubly wrong: it
				// is not a stage any more, and it reads as work still happening
				// when what is actually needed is one number from him.
				currentPhase = "Alteration done — declare returns";
			} else {
				currentPhase = "Production finished";
			}
		}
		statusText = currentPhase;
		statusColor = "#9333ea"; // Purple
	}

	// Header
	const header = document.createElement("div");
	header.className = "item-header";
	header.innerHTML = `
        <div class="item-title-row">
            <div class="item-serial">${index + 1}</div>
            <div class="item-header-info">
                <h2>${item.name}${
									item.sku ? `<span class="item-sku">${item.sku}</span>` : ""
								}</h2>
                <div class="item-meta-line" style="display: flex; align-items: center; gap: 0.75rem;">
                    <span class="item-qty">${item.qty} ${Number(item.qty) === 1 ? "pc" : "pcs"} to produce</span>
                    <span class="item-status-badge" style="color:${statusColor}; font-weight:600; font-size:0.8rem; background: ${statusColor}15; padding: 0.1rem 0.5rem; border-radius: 1rem;">${statusText}</span>
                    ${
											// Three kinds now, and they mean different things to
											// him. A failed check replaces a piece the inspector
											// rejected days later; a replacement batch replaces
											// one he lost on the floor and asked for cloth for;
											// an alteration is the same garments coming back to
											// be fixed. One label for all three left him guessing
											// which — and only one of them is his to explain.
											item.isRemake
												? `<span class="remake-tag${isAlterationItem(item) ? " is-alteration" : ""}">${remakeTagText(item.remakeReason)}</span>`
												: ""
										}
                </div>
            </div>
        </div>
        <div class="item-header-right">
            <span class="chevron">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
            </span>
        </div>
    `;
	header.addEventListener("click", () => {
		openItemId = item.id === openItemId ? null : item.id;
		renderSelectedPlan();
		// Opening item 2 collapses item 1, which removes several hundred pixels
		// from ABOVE the click. The browser keeps the scroll offset, so the page
		// appears to jump — he lands somewhere in the middle of the stage list he
		// just opened, or past the end of it. Put its title back under his eyes.
		if (openItemId) {
			scrollItemIntoView(openItemId);
		}
	});
	card.appendChild(header);

	const body = document.createElement("div");
	body.className = "item-body";

	// 1. Materials Section
	//
	// ONE row per physical thing, and every column means the same on every row:
	// what it is, what size to cut, how much of it he is holding, how many
	// pieces it makes. Fresh cloth and an offcut are the same kind of answer to
	// the same question, so they sit in the same table.
	//
	// Earlier versions split this into grouped blocks with totals. That was more
	// structure than the question needs - he is standing at a table deciding
	// what to lay out next, not reconciling an account.
	let matHtml = `
        <div class="tables-container" style="border-bottom: 1px solid var(--border);">
            <div class="section-title section-title-row">
                <span>Materials for this item</span>
            </div>
            <div class="table-wrapper">
                <table>
                    <thead>
                        <tr>
                            <th>Material</th>
                            <th>Per piece size <span class="cut-axis">(L &times; W)</span></th>
                            <th>Material You have</th>
                            <th>Pieces to cut</th>
                            <th>Expected waste</th>
                        </tr>
                    </thead>
                    <tbody>
    `;

	// GROUPED, not interleaved: the plan's own material, then the replacements,
	// then offcuts. The server already merges the three damage reports on one
	// thread into a single 24-Cone line; this is what stops that line landing
	// between two plan rows where it reads as more of the same.
	//
	// A rank rather than a filter, so the three groups stay in one table with one
	// set of column headings — "You have" and "Pieces to cut" mean exactly the
	// same thing in all three, and splitting them into separate tables would say
	// they do not.
	const matRank = (m) => (m.isWaste ? 2 : m.isReissue === true ? 1 : 0);
	const ordered = (item.materials || [])
		.map((m, i) => ({ m: m, i: i }))
		// Index as the tie-break keeps the server's order inside each group —
		// Array.prototype.sort is not required to be stable in older engines.
		.sort((a, b) => matRank(a.m) - matRank(b.m) || a.i - b.i)
		.map((x) => x.m);

	let lastRank = -1;

	if (ordered.length > 0) {
		ordered.forEach((mat) => {
			// A heading the first time each group appears. Nothing is printed for
			// a group with no rows, so an item that never had damage looks exactly
			// as it does today.
			const rank = matRank(mat);
			if (rank !== lastRank) {
				lastRank = rank;
				if (rank === 1) {
					matHtml += `
                <tr class="mat-group-head is-reissue-head">
                    <td colspan="5">Reissued &mdash; replacing material damaged in production</td>
                </tr>`;
				}
			}

			const hasCut = Number(mat.cutWidth) > 0 && Number(mat.cutLength) > 0;
			const cutCell = hasCut
				? `<span class="cut-size">${mat.cutLength} &times; ${mat.cutWidth}<span class="unit">cm</span></span>`
				: `<span class="is-muted">&mdash;</span>`;

			let nameCell;
			let haveCell;
			let cutCount = 0;

			if (mat.isWaste) {
				// An offcut is a specific piece he has to find and lay out, so it
				// is named by its size. What it cuts is its yield times how many
				// actually arrived - a 4-up offcut that never turned up is worth
				// nothing on the cutting table.
				const have = Number(mat.received) || 0;
				cutCount = have * (Number(mat.yields) || 0);
				// No badge: the name already ends in "(Waste)", the row is tinted,
				// and the piece size sits underneath. A fourth marker for the
				// same fact was just noise.
				nameCell =
					`<div class="mat-name">&#9851; ${mat.name}</div>` +
					`<div class="mat-sku">piece ${fmt(mat.pieceLength)} &times; ${fmt(mat.pieceWidth)} cm</div>`;
				haveCell = `${have} <span class="unit">${have === 1 ? "piece" : "pieces"}</span>`;
			} else {
				// The group heading above already says these are reissues, so the
				// name carries no second badge — a marker repeated on every row
				// under a heading that says the same thing is noise.
				nameCell = `<div class="mat-name">${mat.name}</div>`;
				haveCell = `${fmt(mat.received)} <span class="unit">${mat.unit}</span>`;

				if (mat.isFabric) {
					// Only the pieces coming off FRESH cloth. The rest are on the
					// offcut rows below, so adding the requirement here would
					// count them twice.
					const fromRaw = Number(mat.piecesFromRaw) || 0;
					const fromWaste = Number(mat.piecesFromWaste) || 0;
					cutCount = fromRaw;
					if (fromRaw === 0 && fromWaste === 0) {
						cutCount = Number(mat.requiredPieces) || 0;
					}
				}
			}

			const cutCountCell =
				cutCount > 0
					? `<b>${cutCount}</b> <span class="unit">pcs</span>`
					: `<span class="is-muted">&mdash;</span>`;

			const expectedWasteCell =
				mat.isFabric && !mat.isWaste
					? `<span class="is-muted" id="exp-waste-${item.id}-${mat.materialId}" style="font-size: 0.85em; opacity: 0.7;">Loading...</span>`
					: `<span class="is-muted">&mdash;</span>`;

			matHtml += `
                <tr${
									mat.isWaste
										? ' class="waste-row"'
										: mat.isReissue === true
											? ' class="reissue-row"'
											: ""
								}>
                    <td class="material-name-cell">${nameCell}</td>
                    <td>${cutCell}</td>
                    <td class="col-strong">${haveCell}</td>
                    <td>${cutCountCell}</td>
                    <td>${expectedWasteCell}</td>
                </tr>
            `;
		});
	} else if (isUnraisedRemake(item)) {
		// An empty table on a rejected batch is not a gap in the record — it is
		// the batch's own state, and saying "no materials logged" would read as
		// something having gone missing.
		matHtml += `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">Nothing asked for yet. Raise it on the <b>Reissue</b> tab and the store will see it.</td></tr>`;
	} else {
		matHtml += `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">No materials logged against this item.</td></tr>`;
	}

	matHtml += `</tbody></table></div>`;

	// One sentence, and only when it matters: the pieces on the rows above do
	// not add up to the item. That is the case where he has to stop and go back
	// to the store, and it is not obvious from four separate row totals.
	const needPcs = Number(item.qty) || 0;
	let cutTotal = 0;
	(item.materials || []).forEach((m) => {
		if (m.isWaste) {
			cutTotal += (Number(m.received) || 0) * (Number(m.yields) || 0);
		} else if (m.isFabric) {
			const fr = Number(m.piecesFromRaw) || 0;
			const fw = Number(m.piecesFromWaste) || 0;
			cutTotal += fr === 0 && fw === 0 ? Number(m.requiredPieces) || 0 : fr;
		}
	});

	const anyFabric = (item.materials || []).some((m) => m.isFabric || m.isWaste);
	if (anyFabric && needPcs > 0 && cutTotal < needPcs) {
		matHtml += `
            <div class="cut-short">These add up to <b>${cutTotal}</b> of the
            <b>${needPcs}</b> pieces this item needs &mdash; ${needPcs - cutTotal} short.</div>`;
	}

	matHtml += `</div>`;

	// 2. Production Phases Section
	let phHtml = `<div class="tables-container">`;

	const hasPhases = item.phases && item.phases.length > 0;
	const started = (item.logs || []).length > 0 || revealedItems.has(item.id);
	const isAlt = isAlterationItem(item);

	// Only an alteration batch may ask for material out of the blue. Everywhere
	// else the question is asked for him, when a stage closes with fewer pieces
	// out than went in — and an alteration stage never does, so without this
	// button he cannot ask for so much as a reel of thread while fixing a batch.
	const reqMatBtn = isAlt
		? `<button type="button" class="damage-btn btn-request-material">Request material</button>`
		: "";

	// THE ONLY WAY AN ALTERATION BATCH REACHES THE CHECKER.
	//
	// Its stages cannot answer how many garments survived — one garment can be
	// worked at two of them, so the figures cannot be added up without knowing
	// which overlap, and nobody records that. So the count is declared once,
	// here, and Awaiting_Check is reachable through nothing else. If the batch
	// could slip past this, the shortfall would surface weeks later as an order
	// that will not close.
	//
	// canCloseAlteration is the server's own answer to "every stage done and no
	// material outstanding". closeAlterationBatch re-tests both and refuses with
	// STAGES_OPEN / MATERIAL_PENDING regardless — this only avoids offering a
	// button that would be turned down.
	const closeAltBtn =
		isAlt && item.canCloseAlteration === true
			? `<button type="button" class="primary-btn btn-close-alteration">Alteration finished</button>`
			: "";

	if (!hasPhases) {
		// An alteration batch has no BOM to be missing — its stages are the ones
		// the checker named, so an empty list means the check wrote none and
		// saying "BOM" would send him looking in the wrong place.
		phHtml += isAlt
			? `<div style="text-align:center; color:var(--text-muted); padding:2rem;">No alteration stages were recorded for this batch.</div>`
			: `<div style="text-align:center; color:var(--text-muted); padding:2rem;">No phases found in BOM.</div>`;
	} else if (!started) {
		// Nothing to log until he actually begins, so the flow stays out of the
		// way and the card is just "here is your material, ready when you are".
		if (item.status === "Awaiting_Material") {
			// Two different waits, and naming the wrong one costs days. A batch
			// the checker rejected is waiting on HIM — nothing has been asked
			// for — so it is sent to the Reissue tab rather than told to expect
			// a delivery that nobody has requested.
			const note = isUnraisedRemake(item)
				? `The store has not been asked for this yet — raise it on the Reissue tab · ${item.qty} ${Number(item.qty) === 1 ? "pc" : "pcs"}`
				: `Nothing to cut until the store issues the material · ${item.phases.length} stages · ${item.qty} ${Number(item.qty) === 1 ? "pc" : "pcs"}`;
			phHtml += `
                <div class="start-prod-row" style="background:#f8fafc; border-color:#e2e8f0; opacity: 0.8;">
                    <button type="button" class="primary-btn" disabled style="background:var(--text-muted); cursor:not-allowed;">Cannot start yet</button>
                    <span class="start-prod-note">${note}</span>
                    ${reqMatBtn}
                </div>
            `;
		} else {
			// The outsource button belongs here too: the FIRST stage can go out
			// to a third party, and it would otherwise only appear once
			// production had already started in-house. Not offered on the
			// Awaiting_Material branch above — there is nothing to send yet.
			phHtml += `
                <div class="start-prod-row">
                    <button type="button" class="primary-btn btn-start-production">Start production</button>
                    <span class="start-prod-note">${item.phases.length} ${isAlt ? "stages to alter" : "stages"} · ${item.qty} ${Number(item.qty) === 1 ? "pc" : "pcs"}</span>
                    ${reqMatBtn}
                    <button type="button" class="outsource-btn"></button>
                </div>
            `;
		}
	} else {
		item.phases.sort((a, b) => a.sequence - b.sequence);

		let currentPhaseIndex = item.phases.length; // Assume all done
		item.phases.forEach((phase, idx) => {
			const log = (item.logs || []).find((l) => l.phase === phase.operation);
			if (!(log && log.end) && idx < currentPhaseIndex) currentPhaseIndex = idx;
		});

		phHtml += `
            <div class="section-title section-title-row" style="margin-bottom:0.5rem;">
                <span>${isAlt ? "Alteration stages" : "Production Flow"}</span>
                ${reqMatBtn}
                ${closeAltBtn}
            </div>`;
		phHtml += `<div class="flow-trail"><div class="flow-trail-track">`;
		item.phases.forEach((phase, idx) => {
			let chipClass = "";
			if (idx < currentPhaseIndex) chipClass = "is-done";
			else if (idx === currentPhaseIndex) chipClass = "is-active";

			phHtml += `<div class="flow-chip ${chipClass}">${phase.operation}</div>`;
			if (idx < item.phases.length - 1) {
				// The connector is green only while it joins two finished stages.
				// The point the green run stops IS the boundary between what is
				// done and what is not — no label needed to find it.
				const armClass =
					idx < currentPhaseIndex ? "flow-arrow is-done" : "flow-arrow";
				phHtml += `<div class="${armClass}">→</div>`;
			}
		});
		phHtml += `</div></div>`;

		// Which stage each outsourced block ends on. Worked out once for the whole
		// item — every stage card needs it, and it is a fact about the trips, not
		// about any one stage.
		const osLast = osBlockLastPhase(item);

		phHtml += `<div class="stage-stack">`;
		item.phases.forEach((phase, idx) => {
			const log = (item.logs || []).find((l) => l.phase === phase.operation);

			//----------------------------------------------------------------
			// ONE STAGE AT A TIME — EXCEPT WHERE A VAN HAS ALREADY BEEN.
			//
			// One send covers a block of stages, so pieces can be at a vendor for
			// step 4 while step 2 is still being cut. Those stages have a share on
			// them already; hiding them until their turn came meant the supervisor
			// could see five pieces leave and then not find them anywhere, which is
			// the same complaint as losing them.
			//
			// So a later stage is drawn as soon as it is holding a share. It is a
			// LOOK-AHEAD card: it says what has gone out and nothing else, because
			// what it received is the previous stage's output and that is not
			// settled yet. It cannot be handed out from and it cannot be ended.
			//----------------------------------------------------------------
			const aheadShares = idx > currentPhaseIndex ? sharesOf(log) : [];
			if (idx > currentPhaseIndex && aheadShares.length === 0) return;

			// Its input is unknown until the stage before it closes, so every
			// figure on the card that derives from Qty_In has to say so instead of
			// printing the zero that stands in for it.
			const prevLog =
				idx > 0
					? (item.logs || []).find(
							(l) => l.phase === item.phases[idx - 1].operation,
						)
					: null;
			const awaitingPrev = idx > 0 && !(prevLog && prevLog.end);
			const prevName = idx > 0 ? item.phases[idx - 1].operation : "";

			const state = phaseState(log);
			const qtyIn = stageQtyIn(item, item.phases, idx);

			// Sequence_No is 10/20/30 for insertion room — showing "10." reads
			// as a step number when this is step 1 of 5.
			const stepLabel = `Step ${idx + 1} of ${item.phases.length} &middot; ${phase.operation}`;

			if (state === "done") {
				// Who worked it. A split stage names each man with what he
				// personally finished, because "out 96" on a stage three people
				// shared answers nothing about which of them came up short.
				//
				// A stage with no shares falls back to the header's own operator
				// — that is every stage logged before the split existed, and
				// every outsourced one.
				// A vendor is named here too. It was reading "Not recorded",
				// because this only ever looked at Operator — and a stage that
				// closed while its block was still out showed the vendor's pieces
				// as zero, which is the closed-stage version of losing them.
				const doneShares = sharesOf(log);
				const whoHtml = doneShares.length
					? `<span class="stage-who">${doneShares
							.map((a) => {
								const n = isAlt
									? Number(a.assigned) || 0
									: shareOutFor(a, isPassThrough(a, phase.operation, osLast));
								return `<span class="stage-who-one">${shareWho(a)} <b>${n}</b> <span class="unit">pcs</span></span>`;
							})
							.join("")}</span>`
					: operatorName(log.operator)
						? `<span>by <b>${operatorName(log.operator)}</b></span>`
						: "";

				// "in 7 → out 7" on an alteration stage is a sum that answers
				// nothing: the server writes Qty_Out equal to Qty_In because the
				// row records WORK, not attrition. What the stage is actually
				// about is how many of the batch had to be fixed here, so that is
				// what it says.
				const doneQtyHtml = isAlt
					? `<span><b>${qtyIn}</b> altered of <b>${item.qty}</b> in the batch</span>`
					: `<span>in <b>${log.qtyIn}</b> &rarr; out <b>${log.qtyOut}</b></span>`;

				phHtml += `
                    <div class="stage-card is-done" data-phase="${phase.operation}">
                        <div class="stage-card-head">
                            <span>${stepLabel}</span>
                            <span class="stage-status">Completed</span>
                        </div>
                        <div class="stage-summary">
                            ${doneQtyHtml}
                            <span>${hhmm(log.start)} &ndash; ${hhmm(log.end)}</span>
                            ${whoHtml}
                            ${log.remarks ? `<span class="stage-remark">${log.remarks}</span>` : ""}
                        </div>
                    </div>
                `;
				return;
			}

			//----------------------------------------------------------------
			// LEGACY: A WHOLE STAGE AT A THIRD PARTY. A locked summary.
			//
			// Only a block sent before the vendor became a share reaches this.
			// That model put the party on the stage HEADER and overwrote its
			// Qty_In with the sent quantity, so the stage really did belong
			// entirely to the vendor and there was nothing to put anybody on.
			//
			// Kept working rather than migrated, for the same reason
			// isLegacyStage is: whatever was on a van the day this shipped has to
			// be receivable. Nothing new lands here — sendToThirdParty writes
			// shares now and never touches Is_Outsourced.
			//----------------------------------------------------------------
			if (log && log.outsourced === true && !log.returnedOn) {
				const party =
					typeof partyById === "function" ? partyById(log.party) : null;
				phHtml += `
                    <div class="stage-card is-outsourced" data-phase="${phase.operation}">
                        <div class="stage-card-head">
                            <span>${stepLabel}</span>
                            <div style="display:flex; align-items:center; gap:0.5rem;">
                                <span class="stage-status">At ${party ? party.name : "third party"}</span>
                                <button type="button" class="outsource-btn"></button>
                            </div>
                        </div>
                        <div class="stage-summary">
                            <span>sent <b>${log.qtyIn}</b> pcs</span>
                            ${log.sentOn ? `<span>on <b>${log.sentOn}</b></span>` : ""}
                            ${log.remarks ? `<span class="stage-remark">${log.remarks}</span>` : ""}
                            <span class="stage-remark">Use <b>Take it back</b> above to close this.</span>
                        </div>
                    </div>
                `;
				return;
			}

			const isActive = state === "active";
			const logId = log && log.id ? log.id : "";

			//----------------------------------------------------------------
			// A STAGE THAT WAS STARTED UNDER THE OLD SINGLE-OPERATOR CODE.
			//
			// One man on the header, no shares, already running. It gets the
			// card it was started with so it can be finished the way it was
			// begun — the alternative is a supervisor standing at a stage he
			// cannot close because the screen changed underneath it.
			//
			// Only ever a RUNNING stage: anything not yet started gets the
			// split card below, whatever it is.
			//----------------------------------------------------------------
			if (isLegacyStage(log)) {
				phHtml += `
                <div class="stage-card is-running" data-phase="${phase.operation}" data-qtyin="${qtyIn}" data-left="0" data-logid="${logId}" data-legacy="1">
                    <div class="stage-card-head">
                        <span>${stepLabel}</span>
                        <div style="display:flex; align-items:center; gap:0.5rem;">
                            <span class="stage-status">In progress</span>
                        </div>
                    </div>
                    <div class="stage-card-body">
                        <p class="share-note">Started before the work was split between operators, so it is finished the old way — one operator, one count.</p>
                        <div class="grid-2">
                            <div class="field">
                                <label>Operator</label>
                                ${generateOperatorDropdown(log.operator, true, phase.operation)}
                            </div>
                            <div class="field">
                                <label>Start time</label>
                                <input type="time" class="phase-start" value="${log.start}" disabled>
                            </div>
                            <div class="field">
                                <label>Qty in</label>
                                <div class="qty-static">${qtyIn} <span class="unit">pcs</span></div>
                            </div>
                            <div class="field">
                                <label>Qty out</label>
                                <input type="number" class="phase-qtyout" min="0" max="${qtyIn}" value="${qtyIn}">
                            </div>
                            <div class="field">
                                <label>Remarks</label>
                                <textarea class="phase-remarks" rows="2" placeholder="Notes for this stage — e.g. why fewer pieces came out">${log.remarks ? log.remarks : ""}</textarea>
                            </div>
                            <div class="field">
                                <label>End time</label>
                                <div class="stage-time-row">
                                    <input type="time" class="phase-end" value="">
                                    <button type="button" class="btn btn-stage btn-stage-end btn-save" data-action="end">End</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
				return;
			}

			//----------------------------------------------------------------
			// THE STAGE, SPLIT BETWEEN OPERATORS.
			//
			// One row per man: what he was given, when he started, what he
			// finished. The supervisor hands out shares as people become free
			// rather than dividing the whole stage up front — a second cutter
			// joins at eleven, and a screen that demanded the full split at nine
			// would have been guessed at.
			//
			// The stage closes on its own button, and only once every share is
			// in. That press is what declares the waste, rolls the item up and
			// can finish the order, so it stays a deliberate act rather than
			// something that happens when the last man happens to finish.
			//----------------------------------------------------------------
			const shares = sharesOf(log);
			const assignedQty = shareTotal(log, "assigned");
			const leftQty = awaitingPrev ? 0 : Math.max(0, qtyIn - assignedQty);

			// What this stage has produced, counting a vendor's pass-through
			// pieces as spent. Without that a stage reads as having lost
			// everything that is on a van, and the End button would open the
			// damage dialog asking what happened to cloth that is fine.
			const madeQty = shares.reduce(
				(s, a) => s + shareOutFor(a, isPassThrough(a, phase.operation, osLast)),
				0,
			);

			// WHO IS ACTUALLY HOLDING THIS STAGE OPEN.
			//
			// Not every open share is. A vendor's share on a stage he has already
			// carried the pieces past is finished with THIS stage — the van is
			// only owed at the block's last one. Counting it here kept a cutting
			// stage shut for the days a vendor had the panels, with the in-house
			// half of it stranded behind pieces that were not in the building.
			//
			// A LOOK-AHEAD STAGE still cannot be ended whatever its shares say:
			// its Qty_Out would go forward as the next stage's input while the
			// stage before it is still producing what it has not received yet.
			const blockingOpen = openShares(log).filter(
				(a) => !isPassThrough(a, phase.operation, osLast),
			);
			const stillOpen = blockingOpen.length;
			const canEnd = shares.length > 0 && stillOpen === 0 && !awaitingPrev;

			// Nobody can be on the same stage twice — the server refuses it, and
			// offering the name is only an invitation to find out.
			const onStage = {};
			shares.forEach((a) => {
				onStage[String(a.operator)] = true;
			});
			const addable = operatorsForStage(phase.operation, "").filter(
				(o) => !onStage[String(o.id)],
			);

			const shareRows = shares
				.map((a) => {
					//------------------------------------------------------------
					// A THIRD PARTY'S SHARE. Same table, same columns.
					//
					// None of the operator controls apply to it, and the server
					// refuses all three: his count is not the supervisor's to
					// correct, his share is not the supervisor's to re-size, and
					// taking the vendor off the stage would claim the van never
					// left — which frees those pieces to be handed out a second
					// time while they are still in someone else's workshop.
					//
					// The one action is the return, and it belongs on the LAST
					// stage of the block — one van, one gate, one arrival. On
					// every earlier stage the vendor is carrying the pieces
					// onward, so the row says where they come back instead of
					// offering a button that would receive work not yet done.
					//------------------------------------------------------------
					if (isPartyShare(a)) {
						const pGiven = Number(a.assigned) || 0;
						const isBack = !!a.returnedOn;
						const blockEnd = !a.osRef || osLast[a.osRef] === phase.operation;
						const backAt = a.osRef ? osLast[a.osRef] : "";
						const through = isPassThrough(a, phase.operation, osLast);

						return `
                    <tr class="share-row is-party${isBack ? " is-done" : ""}" data-asgid="${a.id}" data-given="${pGiven}" data-osref="${a.osRef || ""}">
                        <!-- The tag is the pieces' whereabouts, so it has to stop
                             saying "out" once they are back — a returned row was
                             carrying a tag that contradicted its own date and
                             tick. Same slot, two words, always true. -->
                        <td class="share-who"><span class="share-party-tag">${isBack ? "back" : "out"}</span> ${shareWho(a)}</td>
                        <td class="col-num">${pGiven}</td>
                        <td class="share-time">${a.sentOn ? `sent ${a.sentOn}` : "sent"}${isBack ? ` &ndash; back ${a.returnedOn}` : ""}</td>
                        <td class="col-num">${
													isBack || through
														? shareOutFor(a, through)
														: '<span class="is-muted">at vendor</span>'
												}</td>
                        <td class="share-act">
                            <div class="share-act-in">
                                ${
																	isBack
																		? '<span class="share-tick" title="Came back">&#10003;</span>'
																		: blockEnd
																			? '<button type="button" class="btn btn-stage btn-share-back">Take it back</button>'
																			: `<span class="share-back-at">back at ${backAt}</span>`
																}
                            </div>
                        </td>
                    </tr>`;
					}

					const done = a.status === "Done";
					const who = operatorName(a.operator) || "Not recorded";
					const given = Number(a.assigned) || 0;

					if (done) {
						// A CLOSED SHARE IS READ-ONLY, and the count is text rather
						// than a field.
						//
						// It was editable, behind a "Fix" button, so a mistyped count
						// could be corrected while the stage was still open. What that
						// actually bought was a way to REDUCE a finished count long
						// after the moment the shortfall would have been explained.
						//
						// The pieces a stage loses are only replaced by
						// saveMaterialDamage, which opens the Production_Loss batch and
						// writes the damage lines the Reissue tab asks the store from.
						// That dialog is offered once, when the STAGE ends. Lower a
						// share afterwards and the stage simply produces fewer pieces,
						// with nothing anywhere raising a replacement - the order ends
						// short and nothing says why.
						//
						// Correcting it is not lost, it just costs the stage: the
						// figures are still open until "End stage" is pressed, and the
						// shortfall is asked about there, which is where the answer
						// belongs.
						//
						// NOTE THIS DOES NOT STOP A SHORT CLOSE. The open row above
						// still has an editable "finished" field beside its Done
						// button, and it is meant to - "he finished 38 of the 40 he was
						// given" is a real thing that has to be recordable. This only
						// stops the number moving after the fact.
						const short = given - (Number(a.qtyOut) || 0);
						return `
                    <tr class="share-row is-done" data-asgid="${a.id}" data-given="${given}">
                        <td class="share-who">${who}</td>
                        <td class="col-num">${given}</td>
                        <td class="share-time">${hhmm(a.start)} &ndash; ${hhmm(a.end)}</td>
                        <td class="col-num">
                            <span class="share-out-done">${Number(a.qtyOut) || 0}</span>
                            ${short > 0 ? `<div class="short-hint">${short} short</div>` : ""}
                        </td>
                        <td class="share-act">
                            <div class="share-act-in">
                                <span class="share-tick" title="Finished">&#10003;</span>
                            </div>
                        </td>
                    </tr>`;
					}

					// Assigned qty stays editable while he is working: he was given
					// 40, Arjun turned up, and 40 was too many. Re-sizing keeps his
					// start time; removing and re-adding would not.
					return `
                    <tr class="share-row" data-asgid="${a.id}" data-given="${given}">
                        <td class="share-who">${who}</td>
                        <td class="col-num"><input type="number" class="share-qty" min="1" max="${qtyIn}" value="${given}" ${isCuttingPhase(phase.operation) ? "disabled" : ""}></td>
                        <td class="share-time">${hhmm(a.start)} &ndash; <span class="is-muted">working</span></td>
                        <td class="col-num"><input type="number" class="share-out" min="0" max="${given}" value="${given}"></td>
                        <td class="share-act">
                            <div class="share-act-in">
                                <button type="button" class="btn btn-stage btn-share-done">Done</button>
                                <button type="button" class="btn-share-remove" title="Take him off this stage">&times;</button>
                            </div>
                        </td>
                    </tr>`;
				})
				.join("");

			// THE ASSIGN CONTROLS ARE NOT A TABLE ROW.
			//
			// They were, and they could not line up: the columns a share row needs
			// (given, start-end, finished) are not the columns "put someone on"
			// needs, so the button ended up under a heading it had nothing to do
			// with. The table now lists who is on the stage; this is the control
			// that puts them there.
			// THIRD PARTIES SIT IN THE SAME PICKER AS THE MEN. Sending work out is
			// the same decision as handing it to somebody — "who is taking these
			// forty pieces" — and it used to be a separate button at the top of
			// the card, which is why it was possible to send out a quantity the
			// stage had already handed out.
			//
			// ONE OPTION, NOT A LIST OF VENDORS. Which party can take the work is
			// decided by the STAGES, and the stages are not chosen until the
			// dialog: one send covers a contiguous block, and only a vendor who
			// does every stage in it may be offered. Naming vendors here would be
			// answering that question a step too early — he would pick one for
			// Stitching, tick Embroidery as well, and find his choice was never
			// valid. So the picker offers the action and the dialog names the
			// vendors, once it knows what it is asking about.
			//
			// Offered whenever any party exists at all, not filtered by this
			// stage. If none covers the block he ends up ticking, the dialog says
			// exactly which stage nobody does — a real answer, where a missing
			// option would just be a dead end.
			const anyParties = typeof parties !== "undefined" && parties.length > 0;

			const isCuttingMaxed =
				isCuttingPhase(phase.operation) && shares.length >= 1;

			const assignRow =
				leftQty > 0 && !isCuttingMaxed
					? `
                    <div class="share-assign">
                        <select class="share-op" aria-label="Who is taking these">
                            <option value="">Choose who is taking these…</option>
                            ${
															addable.length
																? `<optgroup label="Operators">${addable.map((o) => `<option value="${o.id}">${o.name}</option>`).join("")}</optgroup>`
																: ""
														}
                            ${anyParties ? `<option value="tp:">Send to a third party…</option>` : ""}
                        </select>
                        <div class="share-assign-qty">
                            <input type="number" class="share-add-qty" min="1" max="${leftQty}" value="${leftQty}" aria-label="Pieces" ${isCuttingPhase(phase.operation) ? "disabled" : ""}>
                            <span class="unit">of ${leftQty} left</span>
                        </div>
                        <button type="button" class="btn btn-stage btn-share-add">Add &amp; start</button>
                    </div>`
					: "";

			// How much of this stage has been handed to somebody.
			//
			// NOT amber while it is simply early. A stage that has just opened has
			// handed out nothing, which is the normal state of a stage nobody has
			// started - flagging it made every fresh stage look like a problem. The
			// warning belongs at the moment it becomes one, which is the End button
			// below, and it says so there.
			const meterLeft =
				leftQty > 0
					? assignedQty === 0
						? `<span class="stage-meter-left">${leftQty} to hand out</span>`
						: `<span class="stage-meter-left">${leftQty} still to hand out</span>`
					: `<span class="stage-meter-all">all handed out</span>`;

			// "Qty in 0 · all handed out" is a lie on a look-ahead stage — it has
			// not received anything yet, and the vendor's five are not the whole of
			// it. The dash is the honest figure until the stage before it closes.
			const meter = awaitingPrev
				? `<div class="stage-meter">
                        <span>Qty in <b>&mdash;</b></span>
                        <span>Already out <b>${assignedQty}</b></span>
                        <span class="stage-meter-left">waiting on ${prevName}</span>
                    </div>`
				: `<div class="stage-meter">
                        <span>Qty in <b>${qtyIn}</b></span>
                        <span>Handed out <b>${assignedQty}</b></span>
                        <span>${meterLeft}</span>
                        ${madeQty > 0 ? `<span>Finished <b>${madeQty}</b></span>` : ""}
                    </div>`;

			// Why the End button is shut, said where the button is. "Disabled
			// with no reason given" is the single most common way a screen makes
			// somebody phone the office.
			//
			// The amber one is the LAST case, not the first two: those say "not
			// yet", and this one says "you are about to write off pieces".
			let endNote = "";
			let endWarn = false;
			if (awaitingPrev) {
				// Said as a fact about the stage, not as a refusal. Nothing is
				// wrong here — the pieces genuinely have not arrived.
				endNote = `${prevName} has to finish before the rest of this stage can be handed out.`;
			} else if (shares.length === 0) {
				endNote = "Put someone on this stage first.";
			} else if (stillOpen > 0) {
				// A batch at a vendor holds the stage open exactly as a man does —
				// but only on the block's LAST stage, which is what blockingOpen
				// already filtered to. "1 operator is still working" is the wrong
				// sentence for it either way; he would go looking for somebody on
				// the floor.
				const openArr = blockingOpen;
				const atVendor = openArr.filter(isPartyShare).length;
				const men = openArr.length - atVendor;
				const bits = [];
				if (men > 0)
					bits.push(
						`${men} ${men === 1 ? "operator is" : "operators are"} still working`,
					);
				if (atVendor > 0)
					bits.push(
						`${atVendor === 1 ? "a batch is" : atVendor + " batches are"} still with a third party`,
					);
				endNote = `${bits.join(" and ")}.`;
			} else if (leftQty > 0) {
				endNote = `${leftQty} pcs were never handed to anyone — ending now records them as lost.`;
				endWarn = true;
			}

			phHtml += `
                <div class="stage-card ${awaitingPrev ? "is-ahead" : isActive ? "is-running" : "is-todo"}" data-phase="${phase.operation}" data-qtyin="${qtyIn}" data-qtyout="${madeQty}" data-left="${leftQty}" data-logid="${logId}">
                    <div class="stage-card-head">
                        <span>${stepLabel}</span>
                        <div style="display:flex; align-items:center; gap:0.5rem;">
                            <span class="stage-status">${awaitingPrev ? "Not its turn yet" : isActive ? "In progress" : "Not started"}</span>
                        </div>
                    </div>
                    <div class="stage-card-body">
                        ${meter}
                        ${
													shares.length > 0
														? `<div class="table-wrapper">
                            <table class="share-table">
                                <thead>
                                    <tr>
                                        <!-- NOT "Operator". This column holds men
                                             and vendors alike now, and it was the
                                             one heading that contradicted its own
                                             rows. -->
                                        <th>Who</th>
                                        <th class="col-num">Pieces</th>
                                        <th>Start &ndash; end</th>
                                        <th class="col-num">Finished</th>
                                        <th class="col-act"></th>
                                    </tr>
                                </thead>
                                <tbody>${shareRows}</tbody>
                            </table>
                        </div>`
														: ""
												}
                        ${assignRow}
                        ${
													shares.length === 0 && !assignRow
														? `<div class="share-empty">Nothing came out of the stage before this one, so there is nothing to hand out.</div>`
														: ""
												}
                        <div class="stage-end-row">
                            <div class="stage-end-remarks">
                                <label>Remarks for the whole stage</label>
                                <textarea class="phase-remarks" rows="2" placeholder="e.g. why fewer pieces came out">${log && log.remarks ? log.remarks : ""}</textarea>
                            </div>
                            <div class="stage-end-action">
                                <label>End time</label>
                                <div class="stage-time-row">
                                    <input type="time" class="phase-end" value="" ${canEnd ? "" : "disabled"}>
                                    <button type="button" class="btn btn-stage btn-stage-end btn-save" data-action="end" ${canEnd ? "" : "disabled"}>End stage</button>
                                </div>
                                ${endNote ? `<div class="share-note${endWarn ? " is-warn" : ""}">${endNote}</div>` : ""}
                            </div>
                        </div>
                    </div>
                </div>
            `;
		});
		phHtml += `</div>`;

		if (currentPhaseIndex >= item.phases.length) {
			const lastLog = (item.logs || []).find(
				(l) => l.phase === item.phases[item.phases.length - 1].operation,
			);
			const produced = lastLog ? lastLog.qtyOut : 0;
			phHtml += `<div class="all-done-banner">All stages completed &middot; ${produced} pcs produced</div>`;
		}
	}

	phHtml += `</div>`;

	body.innerHTML = matHtml + phHtml;

	// LEGACY ONLY. The card head still carries this button on a whole-stage block
	// sent under the old model, where the vendor is on the stage header and there
	// is no share table to put a Take it back button in.
	//
	// Sending out is no longer here at all — it is an entry in the stage's own
	// "who is taking these" picker, next to the men. One control for one question
	// is what makes the remainder impossible to lose: the picker is capped at
	// what is left to hand out, and a button at the top of the card never was.
	const btnOsList = body.querySelectorAll(".outsource-btn");
	btnOsList.forEach((btnOs) => {
		const blockOut =
			typeof openOsBlock === "function" ? openOsBlock(item) : null;
		if (typeof openReceiveDialog !== "function" || !blockOut) {
			// js/outsource.js not uploaded, or the block has come back. Removed
			// rather than left to throw — unlike Report damage this button has
			// siblings on the card that still work.
			btnOs.remove();
		} else {
			btnOs.textContent = "Take it back";
			btnOs.classList.add("is-out");
			btnOs.addEventListener("click", () =>
				openReceiveDialog(plan, item, blockOut.ref),
			);
		}
	});

	// Alteration batches only. Opens the damage dialog in its MANUAL mode — no
	// third argument — where the spoiled-piece count starts at 0 and he types
	// what he needs. Everywhere else the dialog is opened for him when a stage
	// closes short, and an alteration stage never closes short by construction.
	//
	// Checked at CLICK time, not render time, for the same reason the outsource
	// button above is: removing it when reissue.js is missing turns "you forgot
	// to upload a file" into "the feature does not exist".
	const btnReqMat = body.querySelector(".btn-request-material");
	if (btnReqMat) {
		btnReqMat.addEventListener("click", () => {
			if (typeof openDamageDialog !== "function") {
				alert(
					"Cannot open the material request — js/reissue.js is not loaded.",
				);
				return;
			}
			openDamageDialog(plan, item);
		});
	}

	const btnCloseAlt = body.querySelector(".btn-close-alteration");
	if (btnCloseAlt) {
		btnCloseAlt.addEventListener("click", () =>
			openCloseAlterationDialog(plan, item),
		);
	}

	// Reveal-only: no server write, so pressing this by accident costs nothing.
	const btnStartProd = body.querySelector(".btn-start-production");
	if (btnStartProd) {
		btnStartProd.addEventListener("click", () => {
			revealedItems.add(item.id);
			renderSelectedPlan();
		});
	}

	// Attach event listeners
	const phaseCards = body.querySelectorAll(".stage-card[data-phase]");
	phaseCards.forEach((card) => {
		const cardLogId = card.getAttribute("data-logid");
		const cardPhase = card.getAttribute("data-phase");
		const cardQtyIn = Number(card.getAttribute("data-qtyin")) || 0;

		// The stage's position in the BOM, needed by both the share calls and
		// the stage End. Worked out once here rather than in three handlers.
		const sortedPhases = (item.phases || [])
			.slice()
			.sort((a, b) => a.sequence - b.sequence);
		const cardIdx = sortedPhases.findIndex((p) => p.operation === cardPhase);
		const cardSeq = cardIdx >= 0 ? sortedPhases[cardIdx].sequence : 0;

		//--------------------------------------------------------------------
		// Handing a share out, re-sizing it, closing it, taking it back.
		//
		// All four go through one call and one refetch. A share changes what
		// every other row on the stage may do — how much is left, whether the
		// stage can close — so re-reading is the only way the card stays
		// truthful, and the alternative is patching four counters by hand.
		//--------------------------------------------------------------------
		const btnAdd = card.querySelector(".btn-share-add");
		const elShareOp = card.querySelector(".share-op");
		const cardLeft = Number(card.getAttribute("data-left")) || 0;

		// The button says what it is about to do. Handing pieces to a man starts
		// his clock here and now; handing them to a vendor opens a dialog, because
		// a van also needs a date and the stages it is carrying them through.
		if (btnAdd && elShareOp) {
			elShareOp.addEventListener("change", () => {
				btnAdd.textContent =
					elShareOp.value.indexOf("tp:") === 0 ? "Send out" : "Add & start";
			});
		}

		if (btnAdd) {
			btnAdd.addEventListener("click", () => {
				const elOp = card.querySelector(".share-op");
				const elQty = card.querySelector(".share-add-qty");
				const opId = elOp ? elOp.value : "";
				const qty = elQty ? Number(elQty.value) : 0;

				if (!opId) {
					alert("Pick who is taking these first.");
					return;
				}
				if (!qty || isNaN(qty) || qty < 1) {
					alert("How many pieces are they taking?");
					return;
				}

				//--------------------------------------------------------------
				// A THIRD PARTY. The same share, asked for differently.
				//
				// The extra questions are real and cannot be inferred: which
				// stages the van is carrying them through, and when it left. One
				// trip can cover three operations before the panels come back, and
				// guessing "just this stage" would make every multi-stage vendor
				// send into three trips that never happened.
				//
				// The quantity and the stage travel with it, so the dialog opens
				// on the answers he has already given rather than asking twice.
				// WHICH VENDOR does not, and cannot: the dialog derives that list
				// from the stages he is about to tick, so partyId leaves here
				// empty and the dialog fills it in.
				//--------------------------------------------------------------
				if (opId.indexOf("tp:") === 0) {
					if (typeof openSendDialog !== "function") {
						alert(
							"Nothing can be sent out — js/outsource.js has not been uploaded.",
						);
						return;
					}
					openSendDialog(plan, item, {
						qty: qty,
						max: cardLeft,
						qtyIn: cardQtyIn,
						phaseName: cardPhase,
					});
					return;
				}

				saveAssignment(
					{
						action: "add",
						planId: plan.id,
						planItemId: item.id,
						phaseName: cardPhase,
						sequence: cardSeq,
						qtyIn: cardQtyIn,
						operatorId: opId,
						assignedQty: qty,
						// Stamped on the CLICK, not at render. A page left open
						// since morning would otherwise say he started then.
						startTime: nowHHMM(),
					},
					btnAdd,
				);
			});
		}

		// Taking a vendor's batch back. On his own row, because that is where the
		// pieces are — and the return closes every stage of the block at once, so
		// it is one press wherever in the block he happens to be looking.
		card.querySelectorAll(".btn-share-back").forEach((btnBack) => {
			btnBack.addEventListener("click", () => {
				const row = btnBack.closest("tr");
				const ref = row.getAttribute("data-osref");
				if (typeof openReceiveDialog !== "function") {
					alert(
						"Nothing can be received — js/outsource.js has not been uploaded.",
					);
					return;
				}
				openReceiveDialog(plan, item, ref);
			});
		});

		// Closing a share — "this is what he finished". A closed share is not
		// re-openable from here any more; see the read-only row above for why.
		// saveStageAssignment still accepts "end" on a Done share while the stage
		// is open, deliberately: it is a Custom API, the guard that matters
		// (STAGE_DONE) is the one on the stage, and nothing should depend on a
		// button being absent from one screen.
		card.querySelectorAll(".btn-share-done").forEach((btnDone) => {
			btnDone.addEventListener("click", () => {
				const row = btnDone.closest("tr");
				const asgId = row.getAttribute("data-asgid");
				const elOut = row.querySelector(".share-out");
				// Read off the row rather than the input: a finished row shows what
				// he was given as text, and only the open one has a field for it.
				const given = Number(row.getAttribute("data-given")) || 0;
				const out = elOut ? Number(elOut.value) : 0;

				if (isNaN(out) || out < 0) {
					alert("Finished pieces must be zero or more.");
					return;
				}
				// The server caps this too — here only so he finds out before the
				// round trip.
				if (out > given) {
					alert(
						"He cannot finish more than the " + given + " pieces he was given.",
					);
					return;
				}

				saveAssignment(
					{
						action: "end",
						assignmentId: asgId,
						qtyOut: out,
						endTime: nowHHMM(),
					},
					btnDone,
				);
			});
		});

		card.querySelectorAll(".btn-share-remove").forEach((btnRm) => {
			btnRm.addEventListener("click", () => {
				const row = btnRm.closest("tr");
				const asgId = row.getAttribute("data-asgid");
				const who = row.querySelector(".share-who").textContent.trim();

				if (!confirm("Take " + who + " off this stage?")) return;

				saveAssignment({ action: "remove", assignmentId: asgId }, btnRm);
			});
		});

		// Re-sizing writes on change rather than behind a Save button — the
		// number is the whole edit, and a button beside it would be pressed
		// about half the time.
		card.querySelectorAll(".share-qty").forEach((elQty) => {
			elQty.addEventListener("change", () => {
				const row = elQty.closest("tr");
				const asgId = row.getAttribute("data-asgid");
				const qty = Number(elQty.value) || 0;

				if (qty < 1) {
					alert("A share has to be at least one piece. Remove him instead.");
					renderSelectedPlan();
					return;
				}

				saveAssignment(
					{ action: "update", assignmentId: asgId, assignedQty: qty },
					null,
					elQty,
				);
			});
		});

		const btnsSave = card.querySelectorAll(".btn-save");
		btnsSave.forEach((btnSave) => {
			btnSave.addEventListener("click", () => {
				const action = btnSave.getAttribute("data-action");

				// A stage started under the old code still carries one operator on
				// the header and one typed count. Everything else is split, and its
				// output is the sum of the shares — read off the card rather than
				// typed, so there is no second opinion about it.
				const isLegacyCard = card.getAttribute("data-legacy") === "1";

				const elEnd = card.querySelector(".phase-end");
				const elQtyOut = card.querySelector(".phase-qtyout");
				const elRemarks = card.querySelector(".phase-remarks");
				const elOpSel = card.querySelector("select.issue-input");

				const qtyIn = cardQtyIn;

				let opSelect = "";
				if (isLegacyCard) {
					opSelect = elOpSel ? elOpSel.value : "";
					if (!opSelect) {
						alert("Please select an operator.");
						return;
					}
				}

				// Stamp the time NOW, on the click — not when the card was
				// rendered. A page left open since morning would otherwise
				// record the moment he opened it, not the moment he acted.
				// A value he typed himself is left alone.
				if (action === "end" && elEnd && !elEnd.value) {
					elEnd.value = nowHHMM();
				}

				const startTime = "";
				const endTime = elEnd ? elEnd.value : "";
				const remarks = elRemarks ? elRemarks.value : "";

				let qtyOut = 0;
				if (action === "end") {
					qtyOut = isLegacyCard
						? elQtyOut
							? Number(elQtyOut.value)
							: 0
						: Number(card.getAttribute("data-qtyout")) || 0;

					if (isNaN(qtyOut) || qtyOut < 0) {
						alert("Qty out must be zero or more.");
						return;
					}
					// The server caps this too — this is just so he finds out
					// before the round trip.
					if (qtyOut > qtyIn) {
						alert(
							"Qty out cannot be more than the " +
								qtyIn +
								" received by this stage.",
						);
						return;
					}
				}

				const payload = {
					planId: plan.id,
					// item.id is the Plan_Item record id — stage logs hang off
					// the item now, not off the plan filtered by SKU.
					planItemId: item.id,
					phaseName: cardPhase,
					sequence: cardSeq,
					// The server rolls the item to Complete on the last stage,
					// and the plan to Production Complete when every item is.
					isLastStage: cardIdx === sortedPhases.length - 1,
					// Empty on a split stage — the people are on the shares, and
					// the header belongs to nobody.
					operatorId: opSelect,
					startTime: startTime,
					endTime: endTime,
					qtyIn: qtyIn,
					// Sent for the legacy single-operator stage. On a split stage
					// the server ignores this and adds the shares up itself.
					qtyOut: qtyOut,
					remarks: remarks,
				};

				const originalText = btnSave.textContent;
				btnSave.textContent = "Saving...";
				btnSave.disabled = true;

				// Fewer out than in. Carried through the save so the material
				// question is asked at the moment he knows the answer, rather
				// than waiting for him to remember to press Report damage.
				const shortBy = action === "end" ? qtyIn - qtyOut : 0;
				const lost =
					shortBy > 0 ? { plan: plan, item: item, pieces: shortBy } : null;

				// Ending a cutting stage declares waste first. The phase is not
				// closed until that is saved, so a failed waste save leaves the
				// stage open to retry rather than losing the declaration.
				if (action === "end" && isCuttingPhase(payload.phaseName)) {
					pendingEnd = {
						payload: payload,
						btn: btnSave,
						originalText: originalText,
						lost: lost,
					};
					// Nothing is saving yet — it is waiting on the waste dialog.
					// Stays disabled so the modal is the only way forward.
					btnSave.textContent = originalText;
					openWasteDialog(plan, item, qtyOut);
					return;
				}

				savePhasePayload(payload, btnSave, originalText, lost);
			});
		});
	});

	card.appendChild(body);
	return card;
}

// `lost` is {plan, item, pieces} when this save closed a stage with fewer pieces
// coming out than went in. Null otherwise.
//
// THE SHORTFALL PROMPT LIVES HERE and not on the stage card, because both routes
// into a phase ending — the ordinary one and the cutting one, which detours
// through the waste dialog first — funnel through this function. Putting it on
// either caller would have covered one of them and quietly missed the other,
// and Cutting is exactly where pieces get ruined.
function savePhasePayload(payload, btnSave, originalText, lost) {
	ZOHO.CREATOR.DATA.invokeCustomApi({
		api_name: API.savePhase,
		http_method: "POST",
		payload: { payloadJson: JSON.stringify(payload) },
	})
		.then((response) => {
			try {
				const data = JSON.parse(response.result);
				// The order-finished popup hangs off orderComplete in this
				// response, and there is no other signal that it should have
				// fired. Logged so "no popup" can be told apart from "the order
				// was not actually finished".
				console.log("saveProductionPhase ->", data);

				if (data.success) {
					// THE ONE FAILURE THAT MUST NOT BE QUIET.
					//
					// The stage saved, but coverProductionLoss could not open the
					// batch for the pieces that did not come out. Everything else
					// on screen will look normal and the order will quietly end
					// short - which is the exact bug the batch exists to prevent -
					// so this is said before anything else happens.
					if (data.lossWarning) {
						alert("MISSING PIECES WERE NOT QUEUED\n\n" + data.lossWarning);
					}

					// Re-fetch so the whole state re-renders cleanly. If that save
					// finished the last item on the order, the summary is shown
					// AFTERWARDS - by then the plan has dropped out of the live list
					// and the next one is already selected behind the dialog.
					var finished = data.orderComplete ? data : null;

					// Asked AFTER the refetch, so the stage is already saved and
					// showing its real numbers behind the dialog. He can always
					// cancel — the pieces are recorded as lost either way, and
					// the material question is a separate one he may not be able
					// to answer standing at the machine.
					//
					// The finished-order popup wins if both are due. That one
					// closes the whole order; a material question can wait for
					// the Report damage button on the item.
					const askDamage =
						lost && typeof openDamageDialog === "function"
							? () =>
									openDamageDialog(lost.plan, lost.item, {
										pieces: lost.pieces,
										phaseName: payload.phaseName,
										stageLogId: data.logId || "",
									})
							: null;

					fetchAllData(function () {
						if (finished) {
							// CHAINED, not skipped. The completion popup used to
							// win outright — so ending the LAST stage short showed
							// "3 short of the order" and then never asked whether
							// those pieces were being made again. The one moment
							// the question matters most was the one moment it was
							// not asked.
							afterOrderDone = askDamage;
							showOrderCompleteDialog(finished);
						} else if (askDamage) {
							askDamage();
						}
					});
				} else if (
					data.code === "SHARES_OPEN" ||
					data.code === "STAGE_DONE" ||
					data.code === "STAGE_OUTSOURCED"
				) {
					// The stage moved between the page rendering and the click —
					// somebody's share was reopened, or the stage was closed from
					// another screen. Nothing was written, so redraw from the
					// server rather than leaving him arguing with a stale card.
					alert(data.error);
					fetchAllData(null);
				} else {
					alert("Error saving: " + data.error);
					btnSave.textContent = originalText;
					btnSave.disabled = false;
				}
			} catch (e) {
				alert("Error parsing save response: " + e.message);
				btnSave.textContent = originalText;
				btnSave.disabled = false;
			}
		})
		.catch((err) => {
			alert("Network error. Check console.");
			console.error(err);
			btnSave.textContent = originalText;
			btnSave.disabled = false;
		});
}

// Add, re-size, close or remove one operator's share of a stage.
//
// Every outcome ends in a refetch, success or failure. A share changes what the
// rest of the stage may do — how many pieces are left, whether the End button
// opens — and a refused call means the screen was describing a stage that had
// already moved on, so redrawing from the server is the fix in both directions.
//
// `btn` is disabled while the call is in flight; `input` covers the re-size
// case, where the control is a number field rather than a button.
function saveAssignment(payload, btn, input) {
	const wasText = btn ? btn.textContent : "";
	if (btn) {
		btn.disabled = true;
		btn.textContent = "…";
	}
	if (input) input.disabled = true;

	ZOHO.CREATOR.DATA.invokeCustomApi({
		api_name: API.saveAssignment,
		http_method: "POST",
		payload: { payloadJson: JSON.stringify(payload) },
	})
		.then((response) => {
			try {
				const data = JSON.parse(response.result);
				console.log("saveStageAssignment ->", data);

				if (!data.success) {
					alert(data.error || "That could not be saved.");
				}
				fetchAllData(null);
			} catch (e) {
				alert("Error parsing the response: " + e.message);
				if (btn) {
					btn.disabled = false;
					btn.textContent = wasText;
				}
				if (input) input.disabled = false;
			}
		})
		.catch((err) => {
			alert("Network error. Check console.");
			console.error(err);
			if (btn) {
				btn.disabled = false;
				btn.textContent = wasText;
			}
			if (input) input.disabled = false;
		});
}

// ---- Order finished ----
//
// Shown once, when the last stage of the last item on an order ends. The figures
// come from saveProductionPhase rather than from the screen, because the moment
// that call returns the plan leaves every live query and the widget can no
// longer see what it just finished.

function orderDoneEl() {
	let el = document.getElementById("order-done-modal");
	if (!el) {
		el = document.createElement("div");
		el.id = "order-done-modal";
		el.className = "waste-modal hidden";
		document.body.appendChild(el);
	}
	return el;
}

// Something to do once the completion popup is dismissed. Set before showing it,
// fired and cleared on close — so two dialogs that are both due appear one after
// the other instead of one silently winning.
let afterOrderDone = null;

function closeOrderDone() {
	orderDoneEl().classList.add("hidden");
	const next = afterOrderDone;
	afterOrderDone = null;
	if (typeof next === "function") next();
}

// ---------------------------------------------------------------------------
// Closing an alteration batch
//
// THE ONE NUMBER THAT CANNOT BE DERIVED. Everywhere else in production a
// stage's Qty_Out says how many came through. An alteration batch has no such
// figure: the garments travel as one pile through the stages the checker named,
// one garment can be worked at two of them, and adding the stages up would
// count those twice. So how many are going back is DECLARED, once, by the man
// holding the pile.
//
// He may only reduce it. A batch cannot return more garments than went into it,
// and the server refuses that too — this just avoids letting him type it.
// ---------------------------------------------------------------------------

function altCloseEl() {
	let el = document.getElementById("alt-close-modal");
	if (!el) {
		el = document.createElement("div");
		el.id = "alt-close-modal";
		el.className = "waste-modal hidden";
		document.body.appendChild(el);
	}
	return el;
}

function closeAltDialog() {
	altCloseEl().classList.add("hidden");
}

function openCloseAlterationDialog(plan, item) {
	const el = altCloseEl();
	const size = Number(item.qty) || 0;

	// The last stage by sequence, so a shortfall can be attributed somewhere on
	// the damage report. Approximate on purpose: nothing computes from it, which
	// is exactly why it is safe to ask for and safe to guess at.
	const phases = (item.phases || [])
		.slice()
		.sort((a, b) => a.sequence - b.sequence);
	const lastPhase = phases.length ? phases[phases.length - 1].operation : "";

	el.classList.remove("hidden");
	el.innerHTML = `
        <div class="waste-panel">
            <div class="waste-head">
                <div>
                    <h3>Alteration finished</h3>
                    <p>${item.name} &middot; ${size} ${size === 1 ? "garment" : "garments"} went out for alteration.</p>
                </div>
            </div>

            <div class="alt-close-body">
                <label for="alt-return-qty">How many are going back for checking?</label>
                <input type="number" id="alt-return-qty" min="0" max="${size}" step="1" value="${size}">
                <p class="alt-close-hint">Anything short of ${size} is treated as garments lost during the
                alteration, and you will be asked what happened to them.</p>
            </div>

            <p class="alt-close-error hidden" id="alt-close-error"></p>

            <div class="waste-actions">
                <button type="button" class="ghost-btn" id="alt-close-cancel">Cancel</button>
                <button type="button" class="primary-btn" id="alt-close-save">Send for checking</button>
            </div>
        </div>`;

	document
		.getElementById("alt-close-cancel")
		.addEventListener("click", closeAltDialog);
	document.getElementById("alt-close-save").addEventListener("click", () => {
		const errEl = document.getElementById("alt-close-error");
		const qty = Number(document.getElementById("alt-return-qty").value);
		const btn = document.getElementById("alt-close-save");

		if (!isFinite(qty) || qty < 0 || qty > size) {
			errEl.textContent = `Enter a number between 0 and ${size}.`;
			errEl.classList.remove("hidden");
			return;
		}

		errEl.classList.add("hidden");
		btn.disabled = true;
		btn.textContent = "Saving…";

		ZOHO.CREATOR.DATA.invokeCustomApi({
			api_name: "closeAlterationBatch",
			http_method: "POST",
			payload: {
				payloadJson: JSON.stringify({
					planItemId: String(item.id),
					supervisorId: String(currentSupervisorId() || ""),
					qtyReturning: qty,
					note: "",
				}),
			},
		})
			.then((response) => {
				console.log("closeAlterationBatch raw:", response);
				let parsed;
				try {
					parsed = JSON.parse(response.result);
				} catch (e) {
					parsed = null;
				}

				if (!parsed || !parsed.success) {
					btn.disabled = false;
					btn.textContent = "Send for checking";
					// Shown verbatim: STAGES_OPEN and MATERIAL_PENDING come back
					// worded for the man reading them, and rewording them here
					// would only make the two disagree.
					errEl.textContent =
						parsed && parsed.error
							? parsed.error
							: "The server did not accept it.";
					errEl.classList.remove("hidden");
					return;
				}

				closeAltDialog();

				const lost = Number(parsed.qtyLost) || 0;
				// Asked AFTER the save, so the batch is already recorded and a
				// cancelled damage report cannot undo it. The garments are gone
				// either way; the material question is a separate one he may not
				// be able to answer standing there.
				const askDamage =
					lost > 0 && typeof openDamageDialog === "function"
						? () =>
								openDamageDialog(plan, item, {
									pieces: lost,
									phaseName: lastPhase,
									stageLogId: "",
								})
						: null;

				fetchAllData(function () {
					if (askDamage) askDamage();
				});
			})
			.catch((err) => {
				console.error("closeAlterationBatch failed:", err);
				btn.disabled = false;
				btn.textContent = "Send for checking";
				errEl.textContent = "Could not reach the server. " + String(err);
				errEl.classList.remove("hidden");
			});
	});
}

function showOrderCompleteDialog(data) {
	const el = orderDoneEl();
	const rows = data.summary || [];

	// A remake carries its original's item name AND its SKU, so an unmarked
	// remake row is indistinguishable from the line it replaces. It also has no
	// Ordered figure worth showing - nobody ordered it, QC did - and printing
	// one made the column sum to more than the header total above it.
	const body = rows
		.map((r) => {
			const ordered = Number(r.ordered) || 0;
			const made = Number(r.produced) || 0;
			const gap = ordered - made;
			const rm = r.isRemake === true;
			return `
                <tr${rm ? ' class="is-remake-row"' : ""}>
                    <td class="material-name-cell">
                        <div class="mat-name">${r.item || "—"}${
													rm
														? ` <span class="remake-tag">${
																r.remakeReason === "Production_Loss"
																	? "Replacement"
																	: "QC remake"
															}</span>`
														: ""
												}</div>
                        ${r.sku ? `<div class="mat-sku">${r.sku}</div>` : ""}
                    </td>
                    <td class="col-num">${
											rm ? `<span class="is-muted">&mdash;</span>` : ordered
										}</td>
                    <td class="col-num col-strong">${made}</td>
                    <td class="col-num">${
											rm
												? `<span class="is-muted">replaces ${ordered}</span>`
												: gap > 0
													? `<span class="short-hint" style="text-align:right;">${gap} short</span>`
													: `<span class="is-muted">&mdash;</span>`
										}</td>
                </tr>`;
		})
		.join("");

	// Ordered and Produced are both ORIGINAL lines only. Mixing remake output
	// into Produced read as "45 of 36" - and let a genuine shortfall hide, since
	// 30 originals plus 6 remakes also totals 36. Remakes get their own line.
	const ordered = Number(data.totalOrdered) || 0;
	const made = Number(data.totalProduced) || 0;
	const remade = Number(data.totalRemade) || 0;
	const shortBy = ordered - made;

	// Where he goes next, worked out AFTER the refresh - so this is what is
	// actually behind the dialog, not a guess about what should be.
	const next = plans.find((p) => p.id === selectedPlanId);
	const nextLine = next
		? `Next up: <b>${next.salesOrder}</b> (${next.planNo}), already open behind this.`
		: `Nothing else is open for you right now.`;

	el.classList.remove("hidden");
	el.innerHTML = `
        <div class="waste-panel">
            <div class="waste-head">
                <div>
                    <h3>${data.salesOrder || "Order"} is finished</h3>
                    <p>Every item on ${
											data.planNo ? data.planNo : "this plan"
										} has been through its last stage.</p>
                </div>
            </div>

            <div class="order-done-total${shortBy > 0 ? " is-short" : ""}">
                <b>${made}</b> of <b>${ordered}</b> pieces produced${
									shortBy > 0
										? ` &middot; <span class="is-short-txt">${shortBy} short of the order</span>`
										: ""
								}${
									remade > 0
										? `<div class="order-done-remade">plus <b>${remade}</b> remade after QC</div>`
										: ""
								}
            </div>

            <div class="table-wrapper">
                <table>
                    <thead><tr>
                        <th>Item</th>
                        <th class="col-num">Ordered</th>
                        <th class="col-num">Produced</th>
                        <th class="col-num"></th>
                    </tr></thead>
                    <tbody>${
											body ||
											`<tr><td colspan="4" class="is-muted" style="text-align:center;">No items recorded.</td></tr>`
										}</tbody>
                </table>
            </div>

            <p class="exc-hint" style="margin-top:0.75rem;">${nextLine}</p>

            <div class="waste-foot">
                <button type="button" class="primary-btn" onclick="closeOrderDone()">
                    ${next ? "Go to next order" : "Close"}
                </button>
            </div>
        </div>
    `;
}

// ---- Waste declaration (Cutting only) ----

function wasteDialogEl() {
	let el = document.getElementById("waste-modal");
	if (!el) {
		el = document.createElement("div");
		el.id = "waste-modal";
		el.className = "waste-modal hidden";
		document.body.appendChild(el);
	}
	return el;
}

// Lots the item's cloth came off, per material, from the prediction.
let wasteLotsByMat = {};

// Only pre-select when there is nothing to choose. Two lots means the cloth was
// split, and nothing on the bench says which roll a given remnant came off —
// picking the bigger one would put a tone on the piece that might be a lie.
function defaultLotFor(materialId) {
	const lots = wasteLotsByMat[String(materialId)] || [];
	return lots.length === 1 ? String(lots[0].lotId) : "";
}

function openWasteDialog(plan, item, qtyOut) {
	const el = wasteDialogEl();
	el.classList.remove("hidden");
	el.innerHTML = `<div class="waste-panel"><div class="waste-head">Working out the waste…</div></div>`;

	ZOHO.CREATOR.DATA.invokeCustomApi({
		api_name: API.expectedWaste,
		http_method: "POST",
		payload: { planId: plan.id, planItemId: item.id, qtyOut: String(qtyOut) },
	})
		.then((response) => {
			let data;
			try {
				data = JSON.parse(response.result);
			} catch (e) {
				console.error(e, response);
				data = {
					fabrics: [],
					fabricOptions: [],
					errors: ["Could not read the prediction"],
				};
			}
			wasteFabricOptions = data.fabricOptions || [];
			// WHICH LOT EACH FABRIC CAME OFF, keyed by material. An offcut goes
			// back to the lot it was cut from, so the row has to name one — and
			// when the cloth came off two lots only he can say which.
			wasteLotsByMat = {};
			(data.fabrics || []).forEach((f) => {
				wasteLotsByMat[String(f.materialId)] = f.lots || [];
			});
			// ONE ROW PER PHYSICAL THING, counted — not one row per source.
			//
			// The prediction emits a row per ORIGIN: the side strip off this
			// lot, the part-filled row off that one, the tail. Several of those
			// are routinely the same offcut described twice, so the dialog was
			// showing six identical lines each reading "1" where the rack will
			// hold six identical pieces. That is a worse description of the same
			// fact, and he has to check every line of it before saving.
			//
			// Merged on fabric + lot + size. LOT IS IN THE KEY deliberately:
			// same size, different tone is not the same piece, and merging those
			// would send an offcut back to the wrong lot.
			//
			// `origin` is dropped, as it always was here — nothing in this dialog
			// reads it. The prediction keeps its per-origin breakdown for the
			// admin audit screen, which is where that working belongs.
			wasteDraft = [];
			const wasteMerge = {};
			(data.fabrics || []).forEach((f) => {
				(f.waste || []).forEach((w) => {
					const matId = String(w.materialId);
					const count = Number(w.count) || 0;
					if (count <= 0) return;

					const lotId = w.lotId ? String(w.lotId) : defaultLotFor(matId);
					const length = Number(w.length) || 0;
					const width = Number(w.width) || 0;

					// An unplaced piece on a material with SEVERAL lots stays its
					// own row. He may know which lot it came off even though the
					// prediction could not, and merging would take that choice
					// away — he could only get it back by splitting the row again
					// by hand.
					const unplaced = !lotId && (wasteLotsByMat[matId] || []).length > 1;
					const key = `${matId}|${lotId}|${length.toFixed(2)}|${width.toFixed(2)}`;

					if (!unplaced && wasteMerge[key]) {
						wasteMerge[key].count += count;
						return;
					}

					const row = {
						key: ++wasteRowSeq,
						materialId: matId,
						width: width,
						length: length,
						count: count,
						keep: true,
						predicted: true,
						// The prediction knows which lot this remnant was cut
						// from — each lot's cloth is cut separately, so the row
						// carries its own answer rather than a per-material
						// guess. Blank only where the cloth could not be placed.
						lotId: lotId,
					};
					if (!unplaced) wasteMerge[key] = row;
					wasteDraft.push(row);
				});
			});
			renderWasteDialog(data.errors || []);
		})
		.catch((err) => {
			console.error(err);
			wasteFabricOptions = [];
			wasteDraft = [];
			renderWasteDialog([
				"Could not reach the server — you can still enter the waste by hand.",
			]);
		});
}

// One lot: shown, not asked about. Two: he picks, and it starts blank so an
// unanswered row is visibly unanswered rather than silently wrong. None: the
// handover predates lots, and saying so beats an empty box.
function lotCellHtml(r) {
	const lots = wasteLotsByMat[String(r.materialId)] || [];

	// The prediction already placed this piece — show what it decided rather
	// than asking again. He can still change it by editing the row's fabric.
	if (r.lotId) {
		const named = lots.find((l) => String(l.lotId) === String(r.lotId));
		if (named && lots.length === 1) {
			return `<span class="w-lot-fixed">${escapeHtml(named.lotNumber || "—")}</span>`;
		}
		if (named) {
			const opts = lots
				.map(
					(l) =>
						`<option value="${l.lotId}" ${String(l.lotId) === String(r.lotId) ? "selected" : ""}>${escapeHtml(l.lotNumber || "—")}</option>`,
				)
				.join("");
			return `<select class="w-lot" ${r.keep ? "" : "disabled"}>${opts}</select>`;
		}
	}

	if (lots.length === 0) return `<span class="w-lot-none">not recorded</span>`;
	if (lots.length === 1)
		return `<span class="w-lot-fixed">${escapeHtml(lots[0].lotNumber || "—")}</span>`;

	const opts = lots
		.map(
			(l) =>
				`<option value="${l.lotId}" ${String(l.lotId) === String(r.lotId) ? "selected" : ""}>${escapeHtml(l.lotNumber || "—")}</option>`,
		)
		.join("");
	return `<select class="w-lot" ${r.keep ? "" : "disabled"}><option value="">Which lot?</option>${opts}</select>`;
}

function renderWasteDialog(errors) {
	const el = wasteDialogEl();
	const opts = wasteFabricOptions;

	const rows = wasteDraft
		.map((r) => {
			const sel = opts
				.map(
					(o) =>
						`<option value="${o.materialId}" ${o.materialId === r.materialId ? "selected" : ""}>${o.material}</option>`,
				)
				.join("");
			// Discarding does NOT delete the row — it flips it to scrap, which is
			// still written so "how much did we throw away this month" stays
			// answerable. A deleted row is silent loss.
			return `
            <tr data-key="${r.key}" class="${r.keep ? "" : "w-discarded"}">
                <td><select class="w-mat" ${r.keep ? "" : "disabled"}>${sel}</select></td>
                <td>${lotCellHtml(r)}</td>
                <td><input type="number" class="w-length" min="0" step="0.01" value="${r.length}" ${r.keep ? "" : "disabled"}></td>
                <td><input type="number" class="w-width" min="0" step="0.01" value="${r.width}" ${r.keep ? "" : "disabled"}></td>
                <td><input type="number" class="w-count" min="1" step="1" value="${r.count}" ${r.keep ? "" : "disabled"}></td>
                <td class="w-actions">
                    <button type="button" class="btn btn-secondary w-del">${r.keep ? "Discard" : "Keep"}</button>
                </td>
            </tr>
        `;
		})
		.join("");

	el.innerHTML = `
        <div class="waste-panel">
            <div class="waste-head">
                <div>
                    <h3>Waste from this cutting</h3>
                    <p>Edit anything that is wrong, discard what is not worth keeping, add anything the maths missed.</p>
                </div>
            </div>
            ${errors && errors.length ? `<div class="waste-warn">${errors.join("<br>")}</div>` : ""}
            <div class="table-wrapper">
                <table>
                    <thead><tr>
                        <th>Fabric</th>
                        <th>Back to lot</th>
                        <th class="col-num">Length (cm)</th>
                        <th class="col-num">Width (cm)</th>
                        <!-- NOT "Pieces to cut" — that is the materials table's
                             heading and means garment pieces still to be cut.
                             Here the row already IS one offcut of a given size,
                             so the number is simply how many of them there are.
                             The two tables sit two clicks apart and the shared
                             wording made this column read as work outstanding. -->
                        <th class="col-num">How many</th>
                        <th></th>
                    </tr></thead>
                    <tbody id="waste-rows">
                        ${rows || `<tr><td colspan="6" class="waste-empty">No waste — nothing will be sent back to the store.</td></tr>`}
                    </tbody>
                </table>
            </div>
            <button type="button" class="btn btn-secondary" id="waste-add">+ Add a piece</button>
            <div class="waste-foot">
                <button type="button" class="btn btn-secondary" id="waste-cancel">Cancel</button>
                <button type="button" class="primary-btn" id="waste-confirm">Save waste &amp; end cutting</button>
            </div>
        </div>
    `;

	el.querySelectorAll(".w-del").forEach((btn) => {
		btn.addEventListener("click", () => {
			const key = Number(btn.closest("tr").getAttribute("data-key"));
			syncWasteDraft();
			const row = wasteDraft.find((r) => r.key === key);
			if (!row) return;
			// A row the supervisor added by mistake has nothing worth recording,
			// so that one really is removed. Anything the maths predicted is
			// kept and marked scrap.
			if (!row.keep && row.predicted === false) {
				wasteDraft = wasteDraft.filter((r) => r.key !== key);
			} else {
				row.keep = !row.keep;
			}
			renderWasteDialog([]);
		});
	});

	document.getElementById("waste-add").addEventListener("click", () => {
		syncWasteDraft();
		if (opts.length === 0) {
			alert("No fabric on this order to attach a piece to.");
			return;
		}
		wasteDraft.push({
			key: ++wasteRowSeq,
			materialId: opts[0].materialId,
			lotId: defaultLotFor(opts[0].materialId),
			width: 0,
			length: 0,
			count: 1,
			keep: true,
			predicted: false,
		});
		renderWasteDialog([]);
	});

	document
		.getElementById("waste-cancel")
		.addEventListener("click", closeWasteDialog);
	document
		.getElementById("waste-confirm")
		.addEventListener("click", confirmWaste);
}

// Pull whatever is currently typed back into the draft before re-rendering,
// otherwise adding a row would wipe edits made to the others.
function syncWasteDraft() {
	document.querySelectorAll("#waste-rows tr[data-key]").forEach((tr) => {
		const key = Number(tr.getAttribute("data-key"));
		const row = wasteDraft.find((r) => r.key === key);
		if (!row || !row.keep) return;
		const prevMat = row.materialId;
		row.materialId = tr.querySelector(".w-mat").value;

		const lotSel = tr.querySelector(".w-lot");
		if (lotSel) row.lotId = lotSel.value;
		// Changing the fabric invalidates the lot — it belonged to the old one.
		if (row.materialId !== prevMat) row.lotId = defaultLotFor(row.materialId);
		row.width = Number(tr.querySelector(".w-width").value) || 0;
		row.length = Number(tr.querySelector(".w-length").value) || 0;
		row.count = Number(tr.querySelector(".w-count").value) || 0;
	});
}

function closeWasteDialog() {
	wasteDialogEl().classList.add("hidden");
	if (pendingEnd) {
		pendingEnd.btn.textContent = pendingEnd.originalText;
		pendingEnd.btn.disabled = false;
		pendingEnd = null;
	}
}

function confirmWaste() {
	syncWasteDraft();

	// Only kept rows have to be valid — a discarded one is scrap, and scrap with
	// a nonsense size is simply not worth recording.
	const bad = wasteDraft.find(
		(r) => r.keep && (r.width <= 0 || r.length <= 0 || r.count <= 0),
	);
	if (bad) {
		alert(
			"Every piece needs a width, a length and a count greater than zero. Discard the row if it is not real.",
		);
		return;
	}

	// Only when there was a choice to make. One lot is filled in already, and a
	// pre-lot handover has none to give.
	const noLot = wasteDraft.find(
		(r) =>
			r.keep &&
			(wasteLotsByMat[String(r.materialId)] || []).length > 1 &&
			!r.lotId,
	);
	if (noLot) {
		alert(
			"This fabric was issued to you off two lots. Say which one each piece came off, so it goes back to the right one.",
		);
		return;
	}

	// COMBINE IDENTICAL PIECES before sending. Cutting throws off the same
	// remnant several times over — the side strip down a marker, three tails one
	// length — and a hand-added or edited row that lands on the same
	// sku+size+lot+keep as another is the same physical stack. saveWasteFromCutting
	// merges these server-side too (it is the authority — a Custom API is
	// callable from anywhere), but folding here keeps the payload matching what
	// ends up on the Waste returns tab. Same key the server uses.
	const pieceMerge = {};
	const pieces = [];
	wasteDraft
		.filter((r) => r.width > 0 && r.length > 0 && r.count > 0)
		.forEach((r) => {
			const key = [
				r.materialId,
				r.width,
				r.length,
				r.lotId || "",
				r.keep ? "1" : "0",
			].join("|");
			if (pieceMerge[key]) {
				pieceMerge[key].count += r.count;
				return;
			}
			const p = {
				sku: r.materialId,
				width: r.width,
				length: r.length,
				count: r.count,
				lotId: r.lotId || "",
				// false lands as Scrapped rather than Pending_Receipt, so
				// thrown-away cloth stays reportable instead of vanishing.
				keep: r.keep,
				remarks: "",
			};
			pieceMerge[key] = p;
			pieces.push(p);
		});

	const btn = document.getElementById("waste-confirm");
	btn.disabled = true;
	btn.textContent = "Saving…";

	const finishPhase = () => {
		const p = pendingEnd;
		wasteDialogEl().classList.add("hidden");
		pendingEnd = null;
		savePhasePayload(p.payload, p.btn, p.originalText, p.lost);
	};

	// Waste is saved BEFORE the phase closes, so a failed phase save leaves the
	// stage open to retry. Without this flag the retry would write a second set
	// of remnants — and nothing downstream could tell the duplicate from real
	// cloth, because a Waste_Master row carries no source.
	if (pieces.length === 0 || pendingEnd.wasteSaved) {
		finishPhase();
		return;
	}

	ZOHO.CREATOR.DATA.invokeCustomApi({
		api_name: API.saveWaste,
		http_method: "POST",
		payload: {
			planId: pendingEnd.payload.planId,
			// These two resolve the Stage_Log server-side, which is what makes a
			// repeat declaration refusable even after a page reload.
			planItemId: pendingEnd.payload.planItemId,
			phaseName: pendingEnd.payload.phaseName,
			piecesJson: JSON.stringify(pieces),
		},
	})
		.then((response) => {
			let data;
			try {
				data = JSON.parse(response.result);
			} catch (e) {
				data = null;
			}
			if (data && data.errors && data.errors.length > 0) {
				alert("Waste not saved:\n" + data.errors.join("\n"));
				btn.disabled = false;
				btn.textContent = "Save waste & end cutting";
				return;
			}
			// duplicate:true means the server found a movement already logged against
			// this stage — the waste is recorded, this is a retry, carry on and close
			// the stage. Not an error, and nothing to tell the supervisor about.
			if (data && data.duplicate) {
				console.info("Waste already declared for this stage; skipping.");
			}
			// Saves a round trip on a same-session retry; the server guard is the
			// one that survives a reload.
			pendingEnd.wasteSaved = true;

			// The remnants he just declared belong on the Waste returns tab. It
			// is a different tab holding its own cached copy, so without this it
			// would keep showing the list as it was before he cut — and the only
			// way to correct it would be reloading the whole widget.
			//
			// Reloaded rather than just invalidated, so the tab badge updates
			// now. He is looking at Production; the point is that he can see the
			// count change without going anywhere.
			if (typeof loadSupWaste === "function" && currentSupervisorId()) {
				tabsLoaded.waste = true;
				loadSupWaste();
			}

			finishPhase();
		})
		.catch((err) => {
			console.error(err);
			alert(
				"Could not save the waste. The stage has been left open — try again.",
			);
			btn.disabled = false;
			btn.textContent = "Save waste & end cutting";
		});
}

// Initial setup
// Picker changes are handled by the shell, which reloads whichever tab is
// open. selectedSupId is read from the shared control at fetch time.

elPlanSelect.addEventListener("change", (e) => {
	selectedPlanId = e.target.value;
	// New order, start at its first item / first page with no filter rather
	// than carrying over whatever was open on the previous one.
	openItemId = undefined;
	itemPage = 0;
	itemSearch = "";

	// REFETCH, not just re-render. Only the plan that was on screen came back
	// with items — the rest are dropdown rows — so switching order means asking
	// for the one he has just picked. One call per switch, and every other
	// order's items never travel at all.
	const chosen = plans.find((p) => String(p.id) === String(selectedPlanId));
	if (selectedPlanId && (!chosen || chosen.hasDetail !== true)) {
		showLoading();
		fetchAllData();
	} else {
		renderSelectedPlan();
	}
});

// Refresh is wired by the shell, off TAB_LOADERS - it reloads every tab that
// has been opened at least once, this one included. Do NOT add a second
// listener here: the shell already calls this loader, and a listener of our own
// would fetch production twice on every click.

// NOT loaded on boot. Production is a lazy tab: the shell calls this the first
// time it is opened, so arriving at Receive does not pay for it.
TAB_LOADERS.production = function () {
	showLoading();
	fetchAllData();
};
