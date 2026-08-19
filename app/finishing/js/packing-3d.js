// 3D Bin Packing Solver & Geometry Engine
// Supports axis-aligned rotation, stability check, boundary checks, and multi-bin optimization

var Packing3D = (function () {
    // Default Box Master configurations (fallback if Creator DB has no data)
    var DEFAULT_BOX_MASTER = [
        { id: "box_1", code: "I1", name: "Box 1 (O1/I1)", boxLevel: "BOTH", outer: { w: 35, l: 35, h: 10 }, inner: { w: 32.5, l: 32.5, h: 7.5 }, cost: 1.0 },
        { id: "box_2", code: "I2", name: "Box 2 (O2/I2)", boxLevel: "BOTH", outer: { w: 40, l: 40, h: 15 }, inner: { w: 37.5, l: 37.5, h: 13.5 }, cost: 1.5 },
        { id: "box_3", code: "I3", name: "Box 3 (O3/I3)", boxLevel: "BOTH", outer: { w: 35, l: 28, h: 5 }, inner: { w: 32.5, l: 26.5, h: 4 }, cost: 0.8 },
        { id: "box_4", code: "I4", name: "Box 4 (O4/I4)", boxLevel: "BOTH", outer: { w: 60, l: 40, h: 30 }, inner: { w: 57.5, l: 37.5, h: 27.5 }, cost: 3.0 },
        { id: "box_5", code: "I5", name: "Box 5 (O5/I5)", boxLevel: "BOTH", outer: { w: 30, l: 20, h: 4 }, inner: { w: 28, l: 18, h: 3 }, cost: 0.5 },
        { id: "box_6", code: "O6", name: "Box 6 (O6)", boxLevel: "OUTER", outer: { w: 58, l: 30, h: 22 }, inner: null, cost: 2.2 },
        { id: "box_7", code: "O7", name: "Box 7 (O7)", boxLevel: "OUTER", outer: { w: 42, l: 22, h: 20 }, inner: null, cost: 1.8 },
        { id: "box_8", code: "O8", name: "Box 8 (O8)", boxLevel: "OUTER", outer: { w: 55, l: 28, h: 19 }, inner: null, cost: 2.5 }
    ];

    // Helper: generate all unique orientations for a 3D box
    function getOrientations(w, l, h, allowRotation) {
        if (!allowRotation) {
            return [{ w: w, l: l, h: h }];
        }
        var orientations = [
            { w: w, l: l, h: h },
            { w: w, l: h, h: l },
            { w: l, l: w, h: h },
            { w: l, l: h, h: w },
            { w: h, l: w, h: l },
            { w: h, l: l, h: w }
        ];
        
        // Remove duplicates
        var unique = [];
        var seen = {};
        orientations.forEach(function (o) {
            var key = o.w + "x" + o.l + "x" + o.h;
            if (!seen[key]) {
                seen[key] = true;
                unique.push(o);
            }
        });
        return unique;
    }

    // Check if box A overlaps with box B in 3D space
    function isOverlap(a, b) {
        return (a.x < b.x + b.w && a.x + a.w > b.x &&
                a.y < b.y + b.l && a.y + a.l > b.y &&
                a.z < b.z + b.h && a.z + a.h > b.z);
    }

    // Helper: find all extreme/candidate placement points
    function getCandidatePoints(container, placedBoxes) {
        var points = [{ x: 0, y: 0, z: 0 }];
        placedBoxes.forEach(function (box) {
            points.push({ x: box.x + box.w, y: box.y, z: box.z });
            points.push({ x: box.x, y: box.y + box.l, z: box.z });
            points.push({ x: box.x, y: box.y, z: box.z + box.h });
        });

        // Filter unique points that are within container bounds
        var uniquePoints = [];
        var seen = {};
        points.forEach(function (pt) {
            if (pt.x >= container.w || pt.y >= container.l || pt.z >= container.h) return;
            var keyStr = pt.x + "," + pt.y + "," + pt.z;
            if (!seen[keyStr]) {
                seen[keyStr] = true;
                uniquePoints.push(pt);
            }
        });

        // Sort points: prefer lowest z (floor first), then closest to corner (x+y)
        uniquePoints.sort(function (a, b) {
            if (a.z !== b.z) return a.z - b.z;
            return (a.x + a.y) - (b.x + b.y);
        });

        return uniquePoints;
    }

    // Evaluates if a list of items fits into a single container of dimensions (cw, cl, ch)
    function fitItemsInContainer(containerDim, items, allowRotation) {
        var placed = [];
        // Sort items by volume descending (standard best-fit heuristic)
        var itemsToSort = items.map(function (item, idx) {
            return {
                index: idx,
                w: item.w,
                l: item.l,
                h: item.h,
                vol: item.w * item.l * item.h,
                allowRotation: item.allowRotation !== undefined ? item.allowRotation : allowRotation
            };
        });
        itemsToSort.sort(function (a, b) { return b.vol - a.vol; });

        for (var i = 0; i < itemsToSort.length; i++) {
            var item = itemsToSort[i];
            var placedOk = false;
            var candidates = getCandidatePoints(containerDim, placed);

            // Find first candidate point and rotation that fits
            for (var c = 0; c < candidates.length; c++) {
                var pt = candidates[c];
                var orientations = getOrientations(item.w, item.l, item.h, item.allowRotation);

                for (var o = 0; o < orientations.length; o++) {
                    var rot = orientations[o];
                    
                    // 1. Boundary check
                    if (pt.x + rot.w > containerDim.w ||
                        pt.y + rot.l > containerDim.l ||
                        pt.z + rot.h > containerDim.h) {
                        continue;
                    }

                    // 2. Overlap check
                    var testBox = { x: pt.x, y: pt.y, z: pt.z, w: rot.w, l: rot.l, h: rot.h };
                    var overlap = false;
                    for (var p = 0; p < placed.length; p++) {
                        if (isOverlap(testBox, placed[p])) {
                            overlap = true;
                            break;
                        }
                    }

                    if (!overlap) {
                        // 3. Stacking stability check: if z > 0, ensure it rests on at least one box top
                        if (pt.z > 0) {
                            var supported = false;
                            for (var p = 0; p < placed.length; p++) {
                                var pb = placed[p];
                                // Check if testBox bottom is resting on pb top
                                if (Math.abs(testBox.z - (pb.z + pb.h)) < 0.01) {
                                    // Check if their 2D footprints intersect
                                    var xOverlap = Math.max(0, Math.min(testBox.x + testBox.w, pb.x + pb.w) - Math.max(testBox.x, pb.x));
                                    var yOverlap = Math.max(0, Math.min(testBox.y + testBox.l, pb.y + pb.l) - Math.max(testBox.y, pb.y));
                                    if (xOverlap > 0 && yOverlap > 0) {
                                        supported = true;
                                        break;
                                    }
                                }
                            }
                            if (!supported) {
                                continue;
                            }
                        }

                        // Placed successfully!
                        placed.push({
                            x: pt.x,
                            y: pt.y,
                            z: pt.z,
                            w: rot.w,
                            l: rot.l,
                            h: rot.h,
                            originalIndex: item.index
                        });
                        placedOk = true;
                        break;
                    }
                }
                if (placedOk) break;
            }

            if (!placedOk) {
                // Fails to pack this item!
                return { fit: false, placements: [] };
            }
        }

        var totalVolumeUsed = placed.reduce(function (sum, box) { return sum + (box.w * box.l * box.h); }, 0);
        var containerVolume = containerDim.w * containerDim.l * containerDim.h;

        return {
            fit: true,
            placements: placed,
            volumeUsed: totalVolumeUsed,
            utilization: parseFloat(((totalVolumeUsed / containerVolume) * 100).toFixed(1))
        };
    }

    // LEVEL 1: Pack items into minimum/optimal inner boxes (one SKU per inner box)
    function packItemsIntoInnerBoxes(items, activeBoxes) {
        var innerCandidates = activeBoxes.filter(function (b) {
            return (b.boxLevel === "INNER" || b.boxLevel === "BOTH") && b.inner !== null && b.active;
        });

        if (innerCandidates.length === 0) {
            throw new Error("No active inner box configurations found.");
        }

        // Sort box candidates by cost ascending, then volume descending (prefer cheaper, larger capacity first)
        innerCandidates.sort(function (a, b) {
            if (a.cost !== b.cost) return a.cost - b.cost;
            var volA = a.inner.w * a.inner.l * a.inner.h;
            var volB = b.inner.w * b.inner.l * b.inner.h;
            return volB - volA;
        });

        var packedInnerBoxes = [];
        var innerBoxCounter = 1;

        // Grouping constraint: Pack each item (SKU) separately
        items.forEach(function (item) {
            var remainingForSKU = [];
            for (var q = 0; q < item.qty; q++) {
                remainingForSKU.push({
                    sku: item.sku,
                    itemName: item.itemName,
                    w: item.length || 10, // fallback
                    l: item.width || 10,
                    h: item.height || 2,
                    weight: item.weight || 0.1,
                    allowRotation: item.allowRotation !== undefined ? item.allowRotation : true
                });
            }

            // Verify if any individual item of this SKU is physically too large for ALL available inner boxes
            if (remainingForSKU.length > 0) {
                var singleItem = remainingForSKU[0];
                var canFitAny = false;
                innerCandidates.forEach(function (box) {
                    var orientations = getOrientations(singleItem.w, singleItem.l, singleItem.h, singleItem.allowRotation);
                    orientations.forEach(function (o) {
                        if (o.w <= box.inner.w && o.l <= box.inner.l && o.h <= box.inner.h) {
                            canFitAny = true;
                        }
                    });
                });
                if (!canFitAny) {
                    throw new Error("Item '" + singleItem.itemName + "' (" + singleItem.w + "x" + singleItem.l + "x" + singleItem.h + " cm) is too large to fit in any available inner box size.");
                }
            }

            while (remainingForSKU.length > 0) {
                var bestFit = null;
                var bestBoxConfig = null;
                var bestItemCount = 0;

                // Evaluate which box type fits the maximum number of remaining items of this SKU
                for (var b = 0; b < innerCandidates.length; b++) {
                    var boxCfg = innerCandidates[b];
                    var trialItems = [];
                    var tempPlaced = null;

                    for (var i = 0; i < remainingForSKU.length; i++) {
                        trialItems.push(remainingForSKU[i]);
                        var test = fitItemsInContainer(boxCfg.inner, trialItems, true);
                        if (test.fit) {
                            tempPlaced = test;
                        } else {
                            trialItems.pop(); // remove failing item
                        }
                    }

                    if (tempPlaced && trialItems.length > bestItemCount) {
                        bestItemCount = trialItems.length;
                        bestFit = tempPlaced;
                        bestBoxConfig = boxCfg;
                    }
                }

                if (bestItemCount === 0) {
                    throw new Error("Could not fit remaining items for SKU '" + item.sku + "' in any inner box configuration.");
                }

                // Remove packed items from remaining list
                var packedOriginalIndices = bestFit.placements.map(function (p) { return p.originalIndex; });
                packedOriginalIndices.sort(function (a, b) { return b - a; });

                var boxItems = [];
                packedOriginalIndices.forEach(function (idx) {
                    boxItems.push(remainingForSKU[idx]);
                    remainingForSKU.splice(idx, 1);
                });

                // Record this packed inner box (all items inside share the same SKU)
                packedInnerBoxes.push({
                    boxNo: "IB-" + String(innerBoxCounter++).padStart(3, '0'),
                    boxSize: bestBoxConfig.name,
                    boxCode: bestBoxConfig.code,
                    cost: bestBoxConfig.cost || 0,
                    sku: item.sku, // Store SKU of packed items
                    outerDim: {
                        w: bestBoxConfig.outer.w,
                        l: bestBoxConfig.outer.l,
                        h: bestBoxConfig.outer.h
                    },
                    items: boxItems.map(function (itm, idx) {
                        var placement = bestFit.placements.filter(function (p) { return p.originalIndex === idx; })[0];
                        return {
                            sku: itm.sku,
                            itemName: itm.itemName,
                            dimensions: { w: itm.w, l: itm.l, h: itm.h },
                            placement: {
                                x: placement.x,
                                y: placement.y,
                                z: placement.z,
                                w: placement.w,
                                l: placement.l,
                                h: placement.h
                            }
                        };
                    }),
                    utilization: bestFit.utilization
                });
            }
        });

        return packedInnerBoxes;
    }

    // LEVEL 2: Pack inner boxes into minimal/optimal outer boxes
    function packInnerBoxesIntoOuterBoxes(innerBoxes, activeBoxes) {
        var outerCandidates = activeBoxes.filter(function (b) {
            return (b.boxLevel === "OUTER" || b.boxLevel === "BOTH") && b.active;
        });

        if (outerCandidates.length === 0) {
            throw new Error("No active outer box configurations found.");
        }

        // Verify if any inner box is physically larger than ALL available outer boxes
        innerBoxes.forEach(function (ib) {
            var canFitAny = false;
            var innerSize = ib.innerDim ? ib.innerDim : ib.outerDim;
            outerCandidates.forEach(function (box) {
                var container = box.outer;
                var orientations = getOrientations(innerSize.w, innerSize.l, innerSize.h, true);
                orientations.forEach(function (o) {
                    if (o.w <= container.w && o.l <= container.l && o.h <= container.h) {
                        canFitAny = true;
                    }
                });
            });
            if (!canFitAny) {
                throw new Error("Inner box '" + ib.boxNo + "' (" + innerSize.w + "x" + innerSize.l + "x" + innerSize.h + " cm) cannot physically fit into any available outer box size.");
            }
        });

        // Sort outer boxes by cost ascending, then volume descending
        outerCandidates.sort(function (a, b) {
            if (a.cost !== b.cost) return a.cost - b.cost;
            var volA = a.outer.w * a.outer.l * a.outer.h;
            var volB = b.outer.w * b.outer.l * b.outer.h;
            return volB - volA;
        });

        var packedOuterBoxes = [];
        var remaining = innerBoxes.slice();
        var outerBoxCounter = 1;

        while (remaining.length > 0) {
            var bestFit = null;
            var bestBoxConfig = null;
            var bestBoxCount = 0;

            // Find best outer box type that fits the most inner boxes
            for (var b = 0; b < outerCandidates.length; b++) {
                var boxCfg = outerCandidates[b];
                
                var trialBoxes = [];
                var tempPlaced = null;

                for (var i = 0; i < remaining.length; i++) {
                    var ib = remaining[i];
                    var innerSize = ib.innerDim ? ib.innerDim : ib.outerDim;
                    trialBoxes.push({
                        w: innerSize.w,
                        l: innerSize.l,
                        h: innerSize.h
                    });
                    
                    var container = boxCfg.outer;
                    var test = fitItemsInContainer(container, trialBoxes, true);
                    if (test.fit) {
                        tempPlaced = test;
                    } else {
                        trialBoxes.pop();
                    }
                }

                if (tempPlaced && trialBoxes.length > bestBoxCount) {
                    bestBoxCount = trialBoxes.length;
                    bestFit = tempPlaced;
                    bestBoxConfig = boxCfg;
                }
            }

            if (bestBoxCount === 0) {
                throw new Error("Required inner boxes cannot be packed into the available outer boxes.");
            }

            // Slice out packed inner boxes
            var packedIndices = bestFit.placements.map(function (p) { return p.originalIndex; });
            packedIndices.sort(function (a, b) { return b - a; });

            var boxInners = [];
            packedIndices.forEach(function (idx) {
                boxInners.push(remaining[idx]);
                remaining.splice(idx, 1);
            });

            // Record packed outer box
            packedOuterBoxes.push({
                outerBoxNo: "OB-" + String(outerBoxCounter++).padStart(3, '0'),
                boxName: bestBoxConfig.name,
                boxCode: bestBoxConfig.code,
                cost: bestBoxConfig.cost || 0,
                dimensions: {
                    w: bestBoxConfig.outer.w,
                    l: bestBoxConfig.outer.l,
                    h: bestBoxConfig.outer.h
                },
                innerBoxes: boxInners.map(function (ib, idx) {
                    var placement = bestFit.placements.filter(function (p) { return p.originalIndex === idx; })[0];
                    return {
                        boxNo: ib.boxNo,
                        boxSize: ib.boxSize,
                        boxCode: ib.boxCode,
                        dimensions: { w: ib.outerDim.w, l: ib.outerDim.l, h: ib.outerDim.h },
                        qty: ib.items.reduce(function (sum, item) { return sum + 1; }, 0), // count items
                        placement: {
                            x: placement.x,
                            y: placement.y,
                            z: placement.z,
                            w: placement.w,
                            l: placement.l,
                            h: placement.h
                        }
                    };
                }),
                utilization: bestFit.utilization
            });
        }

        return packedOuterBoxes;
    }

    // Draws a 3D isometric representation of an outer box and its inner boxes onto an HTML5 canvas
    function draw3DIsometric(canvas, containerDim, placements, selectedIndex) {
        var ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Center point of the isometric view
        var centerX = canvas.width / 2;
        var centerY = canvas.height * 0.7;

        // Isometric projection scales
        var scale = Math.min(
            (canvas.width * 0.4) / containerDim.w,
            (canvas.width * 0.4) / containerDim.l,
            (canvas.height * 0.5) / containerDim.h
        );

        // Projection angles
        var angleX = 30 * Math.PI / 180; // 30 degrees
        var angleY = 30 * Math.PI / 180;

        function isoProject(x, y, z) {
            var isoX = centerX + (x - y) * Math.cos(angleX) * scale;
            var isoY = centerY - (z * scale) + (x + y) * Math.sin(angleY) * scale;
            return { x: isoX, y: isoY };
        }

        // Draw Container Bounds (Outer Wireframe)
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 2.5;
        ctx.setLineDash([5, 5]);

        var p000 = isoProject(0, 0, 0);
        var p100 = isoProject(containerDim.w, 0, 0);
        var p010 = isoProject(0, containerDim.l, 0);
        var p110 = isoProject(containerDim.w, containerDim.l, 0);
        var p001 = isoProject(0, 0, containerDim.h);
        var p101 = isoProject(containerDim.w, 0, containerDim.h);
        var p011 = isoProject(0, containerDim.l, containerDim.h);
        var p111 = isoProject(containerDim.w, containerDim.l, containerDim.h);

        // Draw bottom face
        ctx.beginPath();
        ctx.moveTo(p000.x, p000.y);
        ctx.lineTo(p100.x, p100.y);
        ctx.lineTo(p110.x, p110.y);
        ctx.lineTo(p010.x, p010.y);
        ctx.closePath();
        ctx.stroke();

        // Draw vertical columns
        ctx.beginPath();
        ctx.moveTo(p000.x, p000.y); ctx.lineTo(p001.x, p001.y);
        ctx.moveTo(p100.x, p100.y); ctx.lineTo(p101.x, p101.y);
        ctx.moveTo(p010.x, p010.y); ctx.lineTo(p011.x, p011.y);
        ctx.moveTo(p110.x, p110.y); ctx.lineTo(p111.x, p111.y);
        ctx.stroke();

        // Draw top face
        ctx.beginPath();
        ctx.moveTo(p001.x, p001.y);
        ctx.lineTo(p101.x, p101.y);
        ctx.lineTo(p111.x, p111.y);
        ctx.lineTo(p011.x, p011.y);
        ctx.closePath();
        ctx.stroke();

        ctx.setLineDash([]); // Reset line style

        // Sort placements back-to-front (depth sorting: x+y+z descending) for painter's algorithm
        var sortedPlacements = placements.map(function (p, i) {
            return {
                box: p,
                idx: i,
                depth: p.placement.x + p.placement.y + p.placement.z
            };
        });
        sortedPlacements.sort(function (a, b) { return a.depth - b.depth; });

        // Map box sizes to colors
        var colors = {
            "Box 1 (O1/I1)": { face: 'rgba(99, 102, 241, 0.7)', stroke: '#4f46e5' },
            "Box 2 (O2/I2)": { face: 'rgba(59, 130, 246, 0.7)', stroke: '#2563eb' },
            "Box 3 (O3/I3)": { face: 'rgba(139, 92, 246, 0.7)', stroke: '#7c3aed' },
            "Box 4 (O4/I4)": { face: 'rgba(249, 115, 22, 0.7)', stroke: '#ea580c' },
            "Box 5 (O5/I5)": { face: 'rgba(236, 72, 153, 0.7)', stroke: '#db2777' },
            "default": { face: 'rgba(100, 116, 139, 0.6)', stroke: '#475569' }
        };

        sortedPlacements.forEach(function (sp) {
            var b = sp.box;
            var isSelected = (selectedIndex === sp.idx);
            
            var cInfo = colors[b.boxSize] || colors["default"];
            if (isSelected) {
                cInfo = { face: 'rgba(16, 185, 129, 0.8)', stroke: '#059669' };
            }

            var x = b.placement.x;
            var y = b.placement.y;
            var z = b.placement.z;
            var w = b.placement.w;
            var l = b.placement.l;
            var h = b.placement.h;

            // Generate 8 isometric coordinates of this placed box
            var c000 = isoProject(x, y, z);
            var c100 = isoProject(x + w, y, z);
            var c010 = isoProject(x, y + l, z);
            var c110 = isoProject(x + w, y + l, z);
            var c001 = isoProject(x, y, z + h);
            var c101 = isoProject(x + w, y, z + h);
            var c011 = isoProject(x, y + l, z + h);
            var c111 = isoProject(x + w, y + l, z + h);

            // Draw left side face (towards left bottom)
            ctx.fillStyle = cInfo.face;
            ctx.beginPath();
            ctx.moveTo(c000.x, c000.y);
            ctx.lineTo(c010.x, c010.y);
            ctx.lineTo(c011.x, c011.y);
            ctx.lineTo(c001.x, c001.y);
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = cInfo.stroke;
            ctx.lineWidth = 1.5;
            ctx.stroke();

            // Draw right side face (towards right bottom)
            ctx.beginPath();
            ctx.moveTo(c000.x, c000.y);
            ctx.lineTo(c100.x, c100.y);
            ctx.lineTo(c101.x, c101.y);
            ctx.lineTo(c001.x, c001.y);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            // Draw top face
            ctx.beginPath();
            ctx.moveTo(c001.x, c001.y);
            ctx.lineTo(c101.x, c101.y);
            ctx.lineTo(c111.x, c111.y);
            ctx.lineTo(c011.x, c011.y);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            // Draw text identifier
            ctx.fillStyle = '#1e293b';
            ctx.font = 'bold 10px Inter, sans-serif';
            ctx.textAlign = 'center';
            var textPos = isoProject(x + w/2, y + l/2, z + h);
            ctx.fillText(b.boxNo, textPos.x, textPos.y - 2);
        });
    }

    return {
        DEFAULT_BOX_MASTER: DEFAULT_BOX_MASTER,
        getOrientations: getOrientations,
        fitItemsInContainer: fitItemsInContainer,
        packItemsIntoInnerBoxes: packItemsIntoInnerBoxes,
        packInnerBoxesIntoOuterBoxes: packInnerBoxesIntoOuterBoxes,
        draw3DIsometric: draw3DIsometric
    };
})();
