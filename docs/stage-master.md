# Production stage master

Production stages used to be typed as dropdown choices in three places. They now live in one
form, `Production_Stage`, and those three places look it up. The client adds a stage once and
it appears everywhere.

| Where a stage is picked | Old field (dropdown) | New field (lookup → `Production_Stage`) |
|---|---|---|
| `BOM.Production_Stages` (subform) | `Operation` | `Stage` |
| `Third_Party` | `Applicable_Stages` (multi) | `Stages` (multi) |
| `Operator_Assignment` | `Stage` | `Assigned_Stage` |

## What did not change, and why

**Production history still stores the stage NAME as text.** `Stage_Log.Phase_Name`,
`Stage_Assignment.Phase_Name` and `Alteration_Stage.Stage_Name` are snapshots of what the stage
was called on the day. About fifteen functions compare stages by that name and none of them
were touched. Each function that reads one of the three lookups turns the id back into the name
at that point, so nothing downstream, widgets included, knows the master exists.

Moving history onto ids instead is a much larger change across 15+ functions, and it is not
needed for anything the client asked for.

## The three rules the client needs to know

1. **"Remove a stage" means untick Active, not delete.** An inactive stage drops out of every
   picker. BOMs that already carry it keep working. Deleting a stage that a lookup points at
   would blank that BOM row, so `preventProductionStageDelete` refuses any delete while
   something uses the stage.
2. **A stage's name cannot be changed once saved.** The supervisor screen finds a stage's log
   by comparing names. Rename "Stitching" while an item is mid-production and its finished
   Stitching log stops matching, so the stage shows as not started and can be started twice.
   To rename, set the old stage inactive, create the new one, and change the BOMs. To fix a
   typo on a stage nothing uses yet, delete it and create it again.
3. **Keep a stage called exactly `Cutting`.** The supervisor screen offers the waste prompt
   only on that name (`isCuttingStage`, `app/supervisor/js/production.js`). The name lock and
   the case-insensitive duplicate check protect it. A "this is the cutting stage" flag on the
   master would remove the dependency later.

## Creator setup — do these by hand, in this order

### 1. New form `Production_Stage`

| Field | Type | Settings |
|---|---|---|
| `Stage_Name` | Single Line | Mandatory, **No duplicate values** |
| `Is_Active` | Decision Box | Default **ticked** |

The form has no order field on purpose. The order of stages is per product and stays on the
BOM (`Sequence_No`).

### 2. Workflows on `Production_Stage`

| Script | Record Event | Form Event |
|---|---|---|
| `deluge/validateProductionStage.dg` | Created or Edited | On form submission → Validations on form submission |
| `deluge/lockProductionStageName.dg` | Edited | Before form submission → Load of the form |
| `deluge/preventProductionStageDelete.dg` | Deleted | Validations on record deletion |

### 3. New lookup fields (leave the old dropdowns in place for now)

- `BOM` → subform `Production_Stages` → add **`Stage`**: Lookup → `Production_Stage`, display
  `Stage_Name`, filter `Is_Active is true`.
- `Third_Party` → add **`Stages`**: Lookup, **multi select**, → `Production_Stage`, display
  `Stage_Name`, filter `Is_Active is true`.
- `Operator_Assignment` → add **`Assigned_Stage`**: Lookup → `Production_Stage`, display
  `Stage_Name`, filter `Is_Active is true`.

> **Test once before relying on it:** open a BOM whose row carries a stage that has since been
> made inactive, press Update, and check that the row still holds the stage. With the
> `ui.add`-narrowed Operators field, a saved value outside the allowed choices was dropped on
> save (`filterOperatorLookup.dg`). If a field-level lookup filter does the same, the safe
> practice is to take a stage off the BOMs before deactivating it.

### 4. Paste the changed functions

Each one reads the lookup and falls back to the old dropdown when the lookup is empty, so they
are safe to paste before the migration runs. **No Custom API argument lists change.**

- `getProductionWidgetData`: BOM stages, third-party stages and operator assignments
- `sendToThirdParty`: BOM stages
- `saveItemCheck`: BOM stages (alteration stage picker)
- `getCheckingQueue`: BOM stages
- `preventDuplicateStageAssignment`: the `Operator_Assignment` workflow, now tests `Assigned_Stage`

No widget files change.

### 5. Run the migration

`migrateProductionStages(dryRun, pageNo)`, a new function run from **Execute**, not a Custom API.

1. `("true", 1)` is a dry run. Read the report: `stagesCreated` lists the names it will add;
   `unmatched` should be empty.
2. `("false", 1)`, then `("false", 2)` and so on, until the report says `"morePages":false`.
   BOMs are done 30 at a time because the statement limit cannot be caught. Re-running a page
   does nothing; filled lookups are skipped.
3. Dropdown **choices that no record uses** are invisible to Deluge and are not created. Add
   those in the `Production_Stage` form by hand.

### 6. Switch the forms over

- Hide `BOM.Production_Stages.Operation`, `Third_Party.Applicable_Stages` and
  `Operator_Assignment.Stage` on their forms. **Do not delete them yet.**
- Make `BOM.Production_Stages.Stage` and `Operator_Assignment.Assigned_Stage` mandatory.

### 7. Later: delete the old fields

First remove the fallback branches (every read of `.Operation`, `.Applicable_Stages`, and
`oa.Stage` / `input.Stage` in the five functions above) and repaste. Only then delete the three
dropdowns. Creator will refuse to delete a field a script still reads, which is the reminder.

**`migrateProductionStages` reads all three old fields too.** Once every page has run, delete
that function from Creator, or it blocks every one of these deletes. The file stays in the repo.

**All fallbacks are removed from the code.** The five functions read only the lookups, so an
empty lookup now means "no stage". `Operation`, `Applicable_Stages` and `Operator_Assignment.Stage`
can be deleted once the repasted functions are saved and `migrateProductionStages` is deleted
from Creator.

`bom_deluge_script.dg` (the one-off BOM seed) still writes `Operation`. If it is ever run again,
it should set `Stage` instead.

## Can stage order be changed on a BOM while items are in production?

**Partly, and today nothing stops the unsafe part.** How it works:

- `Plan_Item.BOM` is a lookup to the **shared** BOM for that product. Remakes copy the same
  lookup. Editing a BOM therefore changes the stages of **every open item of that product, on
  every order, immediately**. The supervisor screen re-reads the BOM on every load.
- The screen's current stage is the **first stage, in BOM order, with no finished log**. A
  stage's input is the **output of the stage before it in BOM order**.

| Change made on the BOM | Result |
|---|---|
| Reorder, add or remove stages **nobody has started yet** on any open item of that product | **Works.** The screen follows the new order on the next refresh. |
| Move a stage that is **in progress or finished** | **Breaks.** Example: Cutting done, Stitching in progress, Embroidery next. Swap Stitching and Embroidery and the screen makes Embroidery current, feeds it Cutting's output, and turns the in-progress Stitching card into a look-ahead card with End stage disabled. The operators on Stitching cannot finish until Embroidery closes. |
| Remove a stage that has a log | The log is orphaned. Its pieces and output drop out of the chain. |
| Change a stage while a **third party** holds part of it | The return (`receiveFromThirdParty`) compares the block's saved sequence numbers with the BOM's last stage. Renumbering can stop the return from closing the item. |
| Any change | Applies to every other open order of that product too, whatever stage those items are at. |

There is **no per-item stage list** for ordinary production. Alteration batches have one
(`Alteration_Stage`), and nothing else does. "Fix the order for this one item only" is not
possible today.

**Recommended guard (not built):** a BOM workflow, *Edited → Validations on form submission*,
that refuses a change to a stage row's position when that stage has a `Stage_Log` on any open
`Plan_Item` of this BOM, and allows everything else. That lets the client correct upcoming
stages mid-production, which is the case they asked about, and blocks the cases above. It is
bounded by work in progress (open items of one BOM), not by history.
