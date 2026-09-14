# Faire → Live Linen → Texus → GAD order flow

Session log of what was found and fixed getting a Faire order to flow through
Zoho Books (Live Linen USA) → Zoho Books (Texus Inc, India) → Zoho Inventory (GAD),
matching the sales chain described in the main `CLAUDE.md`.

## Company chain (context)

- **Live Linen USA** — Shopify USA, Faire, custom orders → LL Books, converted to a PO
  against Texus.
- **Texus Inc (India)** — receives LL's PO as its own Sales Order; also has its own
  Shopify India / custom orders. Converts to a PO against GAD.
- **GAD Fashions (manufacturing)** — receives Texus's PO as a Sales Order in GAD
  Inventory, which is what actually reaches the Creator ERP (`getStoreMaterial` /
  `storePersonWidget`, the rest of this repo).
- Each company is independent and keeps its own cost/margin. No direct LL↔GAD link;
  Texus is the only source of sales orders for GAD.
- No PO record is kept on GAD's side — the Texus SO number is stored in Creator's
  reference field, and packing info is pushed back to the Texus SO.

## Files in this folder

| File | Org / trigger | Role |
|---|---|---|
| `faire_to_books.dg` | LL Books, standalone function | **Dead.** First pass at Faire→Books sync; superseded by the schedule. No workflow rule attached. Kept for reference only. |
| `custom_faire_orders.dg` | LL Books, **Schedule** (was hourly, meant to be daily) | Fetches Faire orders (paged, cursor-based), creates the LL Sales Order only (no PO). |
| `sales_to_purchase.dg` | LL Books, workflow rule `so_to_po` (Sales Order → Created, all orders) | LL SO → LL PO against vendor Texus. Calls `po_to_so` directly. |
| `po_to_so.dg` | Called directly from `sales_to_purchase`; also had an (now-deleted) `po_to_so` rule on LL PO → Created | LL PO → Texus SO (create + confirm). Historically also built the Texus PO and pushed to GAD inline (Edit C block) — **superseded** by `texus_sales_to_purchase.dg` + `create_so_in_gad_inventory`, which run in Texus Books via its own workflow rule. |
| `texus_sales_to_purchase.dg` | Texus Books, workflow rule on Sales Order → Created | Texus SO → Texus PO against vendor GAD. Calls `create_so_in_gad_inventory` (not in this folder yet). |
| `faire_probe.dg`, `faire_order_detail.dg` | throwaway diagnostic functions | Dump raw Faire API responses / cross-check SKUs against Books catalogs. Not part of the production flow. |

## Bugs found and fixed

1. **`price_cents` sent raw instead of divided by 100** — fixed in the schedule version
   (`custom_faire_orders`); still present as dead code in `faire_to_books`.
2. **Faire line items have no reliable per-line-item mapping to a single SKU across
   variants** — some Faire SKUs repeat across genuinely different products
   (`WD2316OM` appeared on both "Linen Sophie Dress" and "Linen Felicia Dress").
   Accepted risk per user instruction: aggregate quantity by SKU, log it, move on.
3. **Faire orders arrived as freeform PO/SO line items** (no `item_id`), which broke
   the whole chain downstream (`sales_to_purchase` requires `item_id` to build a PO
   line; `po_to_so` requires `sku` to match a Texus catalog item). Fixed by having
   `custom_faire_orders` look up each aggregated SKU against the LL Books item
   catalog (`items?sku=`) and use a catalog line (`item_id`) when found, with a
   `sku_cache` to avoid re-querying the same SKU twice in one run.
4. **Some LL Books catalog items had no SKU set**, so the lookup in (3) failed for
   those products even with clean Faire data — a real Faire order (`bo_cvvnqus9pd`,
   3 tablecloth lines) surfaced 3 missing SKUs, added to the catalog by hand mid-session.
5. **Zoho Books workflow rules with Action Type "Created" do not fire for records
   created via a Deluge custom function / plain API POST** — confirmed against this
   org: neither `so_to_po` nor `po_to_so` fired on API-created Sales/Purchase Orders.
   Fixed for the SO leg by adding the header
   `X-ZOHO-Execute-CustomFunction: true` to the relevant `invokeurl` calls in
   `custom_faire_orders`, which lets the `so_to_po` rule fire and call
   `sales_to_purchase`.
6. **Double-trigger risk on the PO leg.** `sales_to_purchase` already called
   `po_to_so(...)` directly in-process; a `po_to_so` workflow rule also existed on
   "Purchase Order created, all POs". Decision: **keep the direct call, delete the
   rule** — the direct call is deterministic (runs in the same execution, has full
   context) and the rule would also fire on a PO created by hand in the UI with none
   of the required custom fields set.
7. **`cf_order_source` / `cf_region` custom fields didn't have a `Faire` /
   region value the code was writing** (error `120124: Illegal value specified for
   a Dropdown field`) — the dropdown choices had to be added by hand in LL Books,
   Texus Books, and GAD Inventory (Sales Order and Purchase Order modules in each,
   as applicable) before a Faire-sourced record could save.
8. **Customer person name and shipping address were being lost between hops.**
   Decision: don't add a separate "customer name" field at all — the name is already
   the first line of the shipping-address string, and Creator (GAD side) already
   parses it out of that string. So only the shipping address needs to propagate,
   as `cf_customer_person_address` (LL PO) → `cf_customer_shipping_address`
   (Texus SO, Texus PO, GAD SO). `cf_customer_person_name` is still written where
   it already existed in the code, just no longer treated as load-bearing.
9. **No "expected shipment date" propagated anywhere.** Faire's `expected_ship_date`
   (falls back to `ship_after`) is now carried as:
   - LL SO: standard field `shipment_date`
   - LL PO: custom field `cf_expected_shipment_date` (POs have no standard
     equivalent; a `delivery_date`-style field would have meant something different —
     "when the vendor delivers to us" — so a dedicated field was used instead)
   - Texus SO: standard field `shipment_date`
   - Texus PO: custom field `cf_expected_shipment_date`
   - GAD Inventory SO: standard field `shipment_date` (wired in `po_to_so`'s
     now-superseded inline GAD block; needs to be re-added to
     `create_so_in_gad_inventory` once that function is shared)

## Custom fields that had to exist before the code above would work

| Org | Module | Field (api_name) | Type |
|---|---|---|---|
| LL Books | Sales Order | `cf_order_source` (dropdown, incl. `Faire`), `cf_region` | existing |
| LL Books | Purchase Order | `cf_order_source` (dropdown, incl. `Faire`), `cf_region`, `cf_customer_person_name`, `cf_customer_person_address`, `cf_expected_shipment_date` (Date) | last one created this session |
| Texus Books | Sales Order | `cf_order_source` (dropdown, incl. `Faire`), `cf_region`, `cf_customer_shipping_address`, `cf_customer_person_name`, `cf_expected_shipment_date` (labelled "Expected Shipment Date" — mapped to `cf_expected_shipment_date`) — confirmed present via Fields screenshot | — |
| Texus Books | Purchase Order | same five fields | `cf_expected_shipment_date` created this session; others **to verify** |
| GAD Inventory | Sales Order | `cf_order_source` (dropdown, incl. `Faire`), `cf_region`, `cf_customer_person_name`, `cf_customer_shipping_address` | to verify |

## Open items / not yet done

- **`create_so_in_gad_inventory`** (called from `texus_sales_to_purchase.dg`) has not
  been shared into this repo yet — it's the function that actually needs the
  customer-address and ship-date fields wired onto the GAD Inventory Sales Order.
  The old inline "Edit C" block inside `po_to_so.dg` shows the shape (item SKU
  lookup, dup check by `reference_number`, OAuth token refresh) but is not
  necessarily still the live path — needs confirming against `create_so_in_gad_inventory`
  before deleting.
- **Decide and clean up `po_to_so.dg`**: once it's confirmed that Texus's own
  workflow rule (`texus_sales_to_purchase`) is the live Texus PO + GAD path, the
  STEP 8–12 + "Edit C" inline blocks inside `po_to_so.dg` (Texus PO build, GAD
  Inventory push, second OAuth token) are dead code and should be removed so there
  is exactly one place that does each step.
- **Verify the `X-ZOHO-Execute-CustomFunction` header actually works** on the Texus
  SO create inside `po_to_so.dg` — if the Texus workflow rule still isn't firing,
  the same direct-call pattern used for `so_to_po`/`sales_to_purchase` should be
  applied here too (call `texus_sales_to_purchase` directly instead of relying on
  the rule).
- **Faire order state filter** — `custom_faire_orders` only excludes
  `cancelled/canceled/refunded/returned`; every other Faire state (including
  `DELIVERED`, i.e. already-fulfilled historical orders) is treated as syncable.
  Never confirmed what Faire's "just placed" state actually is; worth checking
  against a fresh order before relying on the exclude-list approach long term.
- **`custom_faire_orders` schedule cadence** — was hourly with a 24h lookback
  window in testing; user's intent (from the original `custom_faire_orders`
  comments) was to move it to once-daily with a wider API-call budget. Not
  reconfirmed after the SKU/line-item rewrite.
- **Rate on Faire-sourced lines** — `custom_faire_orders` still writes the Faire
  retail price (`price_cents / 100`) as the line's `rate` on the LL SO; `sales_to_purchase`
  deliberately sends no rate on the LL PO (uses the item's own default purchase
  rate). Not revisited this session; flagged here in case it needs to change once
  real Faire volume goes through.
