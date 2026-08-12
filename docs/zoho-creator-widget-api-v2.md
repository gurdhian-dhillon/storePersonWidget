# Zoho Creator widgets — JS API v2

A portable setup guide for calling Creator from a widget: how to read data, how to write
it, and the failure modes that cost the most time. Written to be dropped into any project
as AI context.

**Scope.** Creator widget SDK **v2** (`.../version/2.0/widgetsdk-min.js`). v2 does **not**
use `init()`. If you find a tutorial that opens with `ZOHO.CREATOR.init().then(...)`, it is
v1 and the rest of its API surface will not match.

**Confidence.** Sections marked ✅ are verified in a production app (three widgets, ~35 API
calls). Sections marked ⚠️ are from the SDK's documented surface but were not exercised in
that app — check the signature against your SDK build before relying on them.

---

## 1. The shape of a widget

A widget is a static bundle — HTML, CSS, JS — that Creator serves inside an iframe in your
app. It has no server of its own. Everything it knows, it asks Creator for through the SDK.

```
widget/
├── plugin-manifest.json     ← tells Creator this is a Creator widget
├── widget.html              ← entry point
├── css/style.css
└── js/main.js
```

**`plugin-manifest.json`** ✅

```json
{
  "service": "CREATOR",
  "cspDomains": {
    "connect-src": []
  },
  "config": []
}
```

`connect-src` is the allow-list for any **external** host your widget calls directly (an
image CDN, your own API). Calls to Creator itself need nothing here. Leave it empty unless
something is actually blocked — a CSP error in the console is what tells you.

**`widget.html`** ✅ — the SDK goes in **before** your own scripts, and it is the plain
`<script src>` below, not a module or a bundler import:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My widget</title>
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
  <div id="app"></div>

  <script src="https://static.zohocdn.com/creator/widgets/version/2.0/widgetsdk-min.js"></script>
  <script src="js/main.js"></script>
</body>
</html>
```

That is the whole bootstrap. **There is no `init()` call, no promise to wait on, and no
readiness event.** `ZOHO.CREATOR` is usable as soon as your script runs.

---

## 2. Two ways to talk to Creator, and which to pick

| | Custom API (Deluge function) | Record API |
|---|---|---|
| You write | a Deluge function + an API wrapper | nothing server-side |
| Round trips for a screen | **one** | one per form you need |
| Business logic lives | on the server, in one place | in the widget |
| Multi-record writes | atomic-ish, in one call | one call each |
| Good for | anything real | a quick list, a prototype |

**Default to the Custom API route.** The reason is not preference, it is round trips: a
screen that needs an order, its line items, its materials and its stage history is one
Custom API call, or four-plus record calls with the joining done in JavaScript. Creator
also enforces a **statement-execution limit** per Deluge script, and one function you
control is far easier to keep under it than a widget firing loops of record calls.

Use the record APIs when you genuinely just need rows out of one report and nothing has to
be computed.

---

## 3. Reading data — the Custom API route ✅

### 3a. The Deluge function

Plain function in your app, returning a **string**. Return JSON.

```deluge
string getDashboardData(string customerId)
{
    // Build the result in a variable. Deluge needs a return at the function's
    // TOP LEVEL, so you cannot only return from inside the try.
    res = "{\"errors\":[\"Nothing ran\"]}";

    try
    {
        cid = ifnull(customerId, "").toString().trim();

        rowsJson = "";
        for each rec in Orders[Customer == cid.toLong()]
        {
            if (rowsJson != "") { rowsJson = rowsJson + ","; }

            // IDs AS STRINGS. An 18-digit Creator id exceeds JavaScript's safe
            // integer range and JSON.parse silently rounds it — you get a
            // different id back than the one you sent.
            //
            // Free text ESCAPED. One double quote in a customer name breaks the
            // parse for the whole screen.
            rowsJson = rowsJson + "{\"id\":\"" + rec.ID + "\","
                + "\"name\":\"" + ifnull(rec.Name,"").toString().replaceAll("\"","'") + "\","
                + "\"qty\":" + ifnull(rec.Quantity, 0) + "}";
        }

        res = "{\"errors\":[],\"rows\":[" + rowsJson + "]}";
    }
    catch (e)
    {
        // Creator reports EVERY runtime failure to a widget as a generic
        // "code 9430" with no detail. Carry the real message in the payload or
        // you are debugging blind.
        res = "{\"errors\":[\"DELUGE: " + e.toString().replaceAll("\"","'") + "\"]}";
    }

    return res;
}
```

> **Build JSON by hand.** `Map.toString()` stops emitting valid JSON as soon as the
> structure nests (Map → List → Map), and `List.toString()` does not wrap in `[]`. This
> works right up until your deepest level stops being empty, then breaks everywhere at
> once.

### 3b. Wrap it as a Custom API

In Creator: **Settings → Custom API → Create**.

- Pick the function.
- Set the method (**POST** for everything; see below).
- **Declare every argument.** The argument list is Creator configuration, *not* something
  the code carries. Adding a parameter to the Deluge signature without adding it here makes
  every call fail.

> **The single most common deployment bug:** you change a function's signature, paste the
> new code, and every call starts failing. The API's argument list has to change too.

### 3c. Call it ✅

```javascript
ZOHO.CREATOR.DATA.invokeCustomApi({
    api_name: "getDashboardData",   // the API's link name
    http_method: "POST",
    payload: { customerId: "123456789" }
})
.then(function (response) {
    // response.result is a STRING. Always. Parse it yourself.
    var data = JSON.parse(response.result);

    if (data.errors && data.errors.length) {
        showError(data.errors.join("<br>"));
        return;
    }
    render(data.rows);
})
.catch(function (err) {
    // Network/transport level only. A Deluge failure does NOT land here —
    // it arrives as a resolved promise carrying an error payload.
    console.error(err);
    showError("Could not reach the server.");
});
```

**Three things that bite:**

1. **`response.result` is a string**, even though it holds JSON. `JSON.parse` it. Wrap that
   in its own `try/catch` — malformed JSON from the server otherwise surfaces as an
   unhandled rejection with no clue where it came from.
2. **`.catch()` is not your error handler.** A Deluge exception resolves the promise with an
   error payload. Your real error handling is the `data.errors` check inside `.then()`.
3. **Send everything as strings.** Numbers survive, but IDs must be strings both ways.

### 3d. Use POST even for reads

GET puts arguments in the URL, which caps their length, exposes them in logs, and gets
awkward the moment you pass JSON. Use POST for reads and writes alike, and keep one habit
instead of two.

---

## 4. Writing data — the Custom API route ✅

The pattern that scales: **one JSON string argument**, named `payloadJson`. The API keeps a
single declared argument for ever, and the shape of what you send becomes a code change
rather than a Creator configuration change.

**Widget:**

```javascript
var payload = {
    orderId: "123456789",
    lines: [
        { sku: "ABC", qty: 4 },
        { sku: "DEF", qty: 1 }
    ],
    remarks: elRemarks.value
};

btnSave.disabled = true;

ZOHO.CREATOR.DATA.invokeCustomApi({
    api_name: "saveOrderLines",
    http_method: "POST",
    payload: { payloadJson: JSON.stringify(payload) }
})
.then(function (response) {
    var data = JSON.parse(response.result);

    if (!data.success) {
        alert(data.error || "That could not be saved.");
        btnSave.disabled = false;
        return;
    }
    reloadEverything();   // see §7
})
.catch(function (err) {
    console.error(err);
    alert("Network error.");
    btnSave.disabled = false;
});
```

**Deluge:**

```deluge
string saveOrderLines(string payloadJson)
{
    res = "{\"success\":false,\"error\":\"Nothing was saved\"}";

    try
    {
        inp = payloadJson.toMap();                       // JSON string -> Map

        orderIdTxt = ifnull(inp.get("orderId"),"").toString().trim();
        if (orderIdTxt == "" || orderIdTxt.isNumber() == false)
        {
            return "{\"success\":false,\"error\":\"Missing orderId\"}";
        }

        lines = inp.get("lines");                        // -> List of Maps
        saved = 0;

        for each ln in lines
        {
            skuTxt = ifnull(ln.get("sku"),"").toString().trim();

            // A Creator field that was never written is EMPTY, not null.
            // ifnull() does not catch empty and toDecimal() throws on it.
            qtyTxt = ifnull(ln.get("qty"),"0").toString().trim();
            if (qtyTxt == "") { qtyTxt = "0"; }
            qty = qtyTxt.toDecimal();

            if (skuTxt != "" && qty > 0)
            {
                insert into Order_Line
                [
                    Order = orderIdTxt.toLong()
                    SKU = skuTxt
                    Quantity = qty
                    Added_User = zoho.loginuser
                ];
                saved = saved + 1;
            }
        }

        res = "{\"success\":true,\"saved\":" + saved + "}";
    }
    catch (e)
    {
        res = "{\"success\":false,\"error\":\"DELUGE: " + e.toString().replaceAll("\"","'") + "\"}";
    }

    return res;
}
```

**Validate on the server, not only in the widget.** A Custom API is callable from anywhere
with the right credentials — Postman, another widget, a script. Any rule that protects data
integrity has to be enforced in the Deluge, and the widget's copy of it is a courtesy to
the user, not a control.

---

## 5. The record APIs ⚠️

No Deluge required. Verify these signatures against your SDK build — they were not
exercised in the app this guide is drawn from.

```javascript
// READ a report
ZOHO.CREATOR.DATA.getRecords({
    reportName: "All_Orders",
    criteria: '(Status == "Open")',     // Deluge criteria syntax, as a string
    page: 1,
    pageSize: 200                        // 200 is the usual ceiling per page
}).then(function (res) {
    // res.code === 3000 on success; rows in res.data
    console.log(res.data);
});

// READ one record
ZOHO.CREATOR.DATA.getRecordById({
    reportName: "All_Orders",
    id: "123456789"
}).then(function (res) { console.log(res.data); });

// CREATE
ZOHO.CREATOR.DATA.addRecords({
    formName: "Orders",
    payload: { data: [ { Name: "Acme", Quantity: 4 } ] }
}).then(function (res) { console.log(res); });

// UPDATE
ZOHO.CREATOR.DATA.updateRecordById({
    reportName: "All_Orders",
    id: "123456789",
    payload: { data: { Quantity: 6 } }
}).then(function (res) { console.log(res); });

// DELETE
ZOHO.CREATOR.DATA.deleteRecordById({
    reportName: "All_Orders",
    id: "123456789"
});
```

Notes that apply regardless of exact signature:

- **Reports, not forms, for reading.** Reads go through a report link name; writes go
  through a form link name. Getting this backwards is the usual first error.
- **Link names, not display names.** "All Orders" is a label; `All_Orders` is what the API
  wants. Check the report's properties for the real one.
- **Pagination is on you.** There is a per-page ceiling; a widget that assumes one page
  silently truncates once the data grows.
- **These respect the logged-in user's permissions.** A Custom API runs as its owner
  instead — which is either exactly what you need, or a hole, depending on the screen.

Other namespaces worth knowing exist: `ZOHO.CREATOR.UTIL` (init params, navigation),
`ZOHO.CREATOR.FILE` (upload/download). ⚠️

---

## 6. Failure modes — read this before debugging

**`code 9430` means "a Deluge error happened" and nothing more.** ✅ No line number, no
message. This is why every function above wraps its body in `try/catch` and returns the
real message inside the payload. Without that you are guessing.

**A bare HTTP 500 with no error card usually means the statement-execution limit.** ✅ That
limit is **not catchable** — it kills the script, so your `try/catch` never runs and
nothing you wrote gets a chance to report. If a function that worked on small data dies on
big data with no message, this is almost always why. Fixes: filter queries by date or key,
hoist repeated lookups out of loops, cache resolved names in a `Map`, and never run a query
per row of a large list.

**Creator's own Execute is the real debugger.** ✅ The widget only ever sees 9430. Open the
function in Creator, press Execute with real arguments, and read the actual error.

**The reported line number is a hint, not a fact.** ✅ Deluge points at the statement that
*failed*, which is often not the statement that is *wrong*. A per-row `try/catch` that
names the record beats staring at the reported line.

**18-digit IDs.** ✅ Creator record ids exceed `Number.MAX_SAFE_INTEGER`. Emit them as JSON
strings from Deluge and keep them as strings in the widget. Compare with `String(a) ===
String(b)` — a stray `==` against a number will bite eventually.

**Empty is not null.** ✅ A Creator field never written is EMPTY. `ifnull()` does not catch
it and `.toDecimal()` throws on it. The safe idiom:

```deluge
s = ifnull(f, "0").toString().trim();
if (s == "") { s = "0"; }
n = s.toDecimal();
```

---

## 7. Patterns that hold up

**One boot call, then lazily load the rest.** Fetch what the first screen needs in a single
Custom API call. Load a tab's data the first time that tab is opened, not on boot.

**Refetch after every write.** Do not patch local state to match what you think the server
did. A write usually changes more than the thing you touched — totals, statuses, what
buttons are legal — and hand-patched state drifts. Save → refetch → re-render is boring and
it is always right.

```javascript
function save(payload) {
    return invoke("saveThing", { payloadJson: JSON.stringify(payload) })
        .then(function (data) {
            if (!data.success) { alert(data.error); return; }
            return loadEverything();      // one source of truth: the server
        });
}
```

**Do not build "router" APIs to save calls.** ✅ In the app this is drawn from, Custom API
calls **from a widget** were empirically found not to count against the daily API quota —
only external calls (Postman, integrations) did. One clear API per job beats a
`doAction(action, payload)` switch that nothing can validate. *Confirm this on your own
plan before relying on it.*

**Wrap the SDK once.** A three-line helper removes the parse-and-check boilerplate from
every call site:

```javascript
function invoke(apiName, payload) {
    return ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: apiName,
        http_method: "POST",
        payload: payload || {}
    }).then(function (response) {
        var data;
        try {
            data = JSON.parse(response.result);
        } catch (e) {
            throw new Error("Bad JSON from " + apiName + ": " + response.result);
        }
        if (data.errors && data.errors.length) {
            throw new Error(data.errors.join("; "));
        }
        return data;
    });
}
```

**Disable the button while a call is in flight**, and re-enable it on every exit path
including failure. Double-submits are the most common data bug in a widget.

---

## 8. Local development and release

```bash
npm install -g zoho-extension-toolkit
zet init            # choose Creator
zet run             # serves on https://127.0.0.1:5000
zet pack            # produces the zip you upload
```

- **The dev server must be HTTPS**, and you must visit `https://127.0.0.1:5000` once and
  accept the self-signed certificate, or the iframe silently loads nothing.
- Point the widget at the local URL in Creator while developing; upload the zip to release.
- **A widget cannot be tested outside Creator.** `ZOHO` only exists inside the iframe. To
  work on layout offline, render your HTML-building functions in Node with a stub DOM and
  check the output — that catches most markup and logic bugs without a deploy.

---

## 9. Checklist for a new widget

- [ ] `plugin-manifest.json` with `"service": "CREATOR"`
- [ ] v2 SDK `<script>` before your own scripts
- [ ] **No `init()`** anywhere
- [ ] One Deluge function per job, each wrapped in `try/catch` returning the real error
- [ ] JSON built by hand; ids stringified; free text escaped with `.replaceAll("\"","'")`
- [ ] A Custom API per function, POST, **argument list matching the signature**
- [ ] Widget parses `response.result` and checks `data.errors` / `data.success`
- [ ] Buttons disabled during flight, re-enabled on every exit path
- [ ] Refetch after write rather than patching local state
- [ ] Server-side validation for anything that protects data

---

## 10. Prompt for an AI working in this stack

> This is a Zoho Creator **widget using JS API v2**. There is no `init()` — the SDK is
> ready when the script loads. All server access goes through
> `ZOHO.CREATOR.DATA.invokeCustomApi({ api_name, http_method: "POST", payload })`.
> `response.result` is a **string** that must be `JSON.parse`d, and Deluge errors arrive as
> a resolved promise carrying an error payload, not as a rejection.
>
> Deluge rules: build JSON by hand (`Map.toString()` is not valid JSON once nested);
> stringify all record ids (18 digits break `JSON.parse`); escape free text; a field never
> written is EMPTY not null, so normalise through a string before `.toDecimal()`; wrap the
> body in `try/catch` and return the real message in the payload, because the widget
> otherwise only ever sees "code 9430".
>
> Nothing runs until it is pasted into Creator. When you change a function's arguments, say
> so explicitly — the Custom API's argument list is separate Creator configuration and must
> be changed by hand, or every call fails.
