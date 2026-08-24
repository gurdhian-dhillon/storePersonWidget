#!/usr/bin/env bash
#
# Build the client ZIPs.
#
# Copies each widget's html/css/js out of app/ into its own ZET project under
# "live linen widgets", runs `zet pack` there, and gathers every zip into
# "live linen widgets/zipfiles" so the whole upload is one folder.
#
#   ./build-widgets.sh                    all seven
#   ./build-widgets.sh store supervisor   just those
#   ./build-widgets.sh --no-pack          copy only, skip zet
#   ./build-widgets.sh --list             show the mapping and exit
#
# Nothing is read back out of the target folders - they are treated as build
# output. Edit the widget in app/ and rebuild.

set -euo pipefail

SRC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_ROOT="/c/Users/gurdh/OneDrive/Desktop/live linen widgets"
ZIP_OUT="$DEST_ROOT/zipfiles"

# key | source dir under app/ | destination project folder
WIDGETS="
store|.|storePersonWidget
supervisor|supervisor|SupervisorWiget
checker|checker|CheckerWidget
finishing|finishing|FinishingWidget
packing|packing|PackingWidget
admin|admin|AdminOrderAuditWidget
adminsales|admin/anotherPage|AdminSalesAndStock
"

# A widget that lives in a subfolder of app/ can reach UP to a shared file
# during local development. Once it is packed on its own that path leads
# outside the zip, so the file is copied in beside it and the reference is
# rewritten. Each line: source-relative-to-app | destination-relative-to-app/ |
# sed expression applied to the copied widget.html.
extras_for() {
    case "$1" in
        finishing|packing)
            echo 'css/style.css|css/base.css|s#href="\.\./css/style\.css"#href="css/base.css"#g'
            ;;
        admin)
            echo 'js/lot-allocator.js|js/lot-allocator.js|s#src="\.\./js/lot-allocator\.js"#src="js/lot-allocator.js"#g'
            ;;
        adminsales)
            echo 'admin/css/style.css|css/base.css|s#href="\.\./css/style\.css"#href="css/base.css"#g'
            ;;
    esac
}

DO_PACK=1
SELECTED=""

for arg in "$@"; do
    case "$arg" in
        --no-pack) DO_PACK=0 ;;
        --list)
            printf '%-12s %-22s %s\n' KEY 'SOURCE (app/)' DESTINATION
            while IFS='|' read -r k s d; do
                [ -n "$k" ] || continue
                printf '%-12s %-22s %s\n' "$k" "$s" "$d"
            done <<< "$WIDGETS"
            exit 0
            ;;
        -*) echo "unknown option: $arg" >&2; exit 1 ;;
        *) SELECTED="$SELECTED $arg" ;;
    esac
done

[ -d "$DEST_ROOT" ] || { echo "destination root not found: $DEST_ROOT" >&2; exit 1; }

copy_dir() {   # copy_dir <src> <dest>  - files only, one level deep
    local src="$1" dest="$2" f n=0
    [ -d "$src" ] || { echo 0; return 0; }
    mkdir -p "$dest"
    for f in "$src"/*; do
        [ -f "$f" ] || continue
        cp "$f" "$dest/"
        n=$((n + 1))
    done
    echo "$n"
}

build_one() {
    local key="$1" rel="$2" folder="$3"
    local src="$SRC_ROOT/app/$rel" dest="$DEST_ROOT/$folder"

    echo "== $key"

    [ -f "$src/widget.html" ] || { echo "   ! no widget.html in app/$rel" >&2; return 1; }
    [ -d "$dest" ]            || { echo "   ! no project folder $folder" >&2; return 1; }

    # Wipe css/ and js/ so a file deleted in app/ cannot survive in the zip.
    # translations/ is left alone unless the source carries its own.
    rm -rf "$dest/app/css" "$dest/app/js"
    mkdir -p "$dest/app"

    cp "$src/widget.html" "$dest/app/widget.html"
    local ncss njs ntr
    ncss=$(copy_dir "$src/css" "$dest/app/css")
    njs=$(copy_dir "$src/js" "$dest/app/js")
    ntr=$(copy_dir "$src/translations" "$dest/app/translations")
    echo "   widget.html, ${ncss} css, ${njs} js, ${ntr} translations"

    # Shared files pulled in from above, plus the matching rewrite.
    local from to sedexpr
    while IFS='|' read -r from to sedexpr; do
        [ -n "${from:-}" ] || continue
        [ -f "$SRC_ROOT/app/$from" ] || { echo "   ! missing shared file app/$from" >&2; return 1; }
        mkdir -p "$(dirname "$dest/app/$to")"
        cp "$SRC_ROOT/app/$from" "$dest/app/$to"
        sed -i "$sedexpr" "$dest/app/widget.html"
        echo "   + app/$from -> app/$to (reference rewritten)"
    done <<< "$(extras_for "$key")"

    # Anything still pointing outside the project would 404 in Creator and the
    # page would render unstyled or dead. Fail here instead.
    if grep -nE '(src|href)="\.\./' "$dest/app/widget.html"; then
        echo "   ! widget.html still references a file outside the project (above)" >&2
        return 1
    fi

    if [ "$DO_PACK" -eq 1 ]; then
        ( cd "$dest" && zet pack >/dev/null 2>&1 ) || { echo "   ! zet pack failed in $folder" >&2; return 1; }
        local zip
        zip=$(ls -t "$dest/dist"/*.zip 2>/dev/null | head -1)
        [ -n "$zip" ] || { echo "   ! zet pack produced no zip" >&2; return 1; }

        # Every zip also lands in one folder so uploading is seven picks from
        # one place. Named after the project folder rather than kept as zet
        # named it - a renamed folder leaves its old name behind in dist/, and
        # picking the wrong one there is invisible until the client opens it.
        mkdir -p "$ZIP_OUT"
        cp "$zip" "$ZIP_OUT/$folder.zip"
        echo "   packed: ${zip#$DEST_ROOT/}  ->  zipfiles/$folder.zip"
        BUILT="$BUILT
  $folder -> zipfiles/$folder.zip"
    else
        BUILT="$BUILT
  $folder -> copied, not packed"
    fi
}

BUILT=""
FAILED=""

# A here-string, not a pipe: the loop has to run in this shell or BUILT and
# FAILED are lost with the subshell and the summary comes out empty.
while IFS='|' read -r key rel folder; do
    [ -n "$key" ] || continue
    if [ -n "$SELECTED" ]; then
        case " $SELECTED " in *" $key "*) ;; *) continue ;; esac
    fi
    if build_one "$key" "$rel" "$folder"; then :; else FAILED="$FAILED $key"; fi
done <<< "$WIDGETS"

echo
echo "built:${BUILT:-  nothing}"

# A zip here that no widget produced is a leftover - a renamed folder, a widget
# that was dropped. Nothing deletes it, because that is the user's call, but
# uploading it by mistake would be silent.
if [ "$DO_PACK" -eq 1 ] && [ -d "$ZIP_OUT" ]; then
    # `continue`, not `[ -n "$k" ] && echo`: the table's trailing blank line
    # would make the failed test the loop's exit status, and under `set -e`
    # that kills the script on the assignment itself.
    known=$(while IFS='|' read -r k r f; do
        [ -n "$k" ] || continue
        echo "$f.zip"
    done <<< "$WIDGETS")
    for z in "$ZIP_OUT"/*.zip; do
        [ -f "$z" ] || continue
        grep -qxF "$(basename "$z")" <<< "$known" || echo "note: zipfiles/$(basename "$z") is not built by this script"
    done
fi
if [ -n "$FAILED" ]; then
    echo "FAILED:$FAILED" >&2
    exit 1
fi
