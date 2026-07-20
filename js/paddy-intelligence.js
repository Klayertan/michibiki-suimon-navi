(function () {
  "use strict";

  const STATUS_LABELS = {
    boundary: "圃場境界",
    water: "水面",
    healthy: "健康な稲",
    weak: "弱い稲",
    missing: "欠株",
    weed: "雑草",
    pest: "害虫被害",
    disease: "病害",
    fertilizer: "肥料不足",
    bareSoil: "裸地",
    inlet: "取水口",
    outlet: "排水口",
    gate: "水門",
    drainage: "排水点",
    tree: "樹木",
    pole: "電柱",
    building: "建物",
    noFlyZone: "飛行禁止区域",
    drone: "ドローン経路",
    grid: "管理グリッド"
  };

  const STYLES = {
    boundary: { color: "#166534", fillColor: "#22c55e", fillOpacity: 0.08, weight: 3 },
    water: { color: "#0369a1", fillColor: "#38bdf8", fillOpacity: 0.28, weight: 2 },
    healthy: { color: "#15803d", fillColor: "#22c55e", fillOpacity: 0.22, weight: 2 },
    weak: { color: "#b45309", fillColor: "#facc15", fillOpacity: 0.28, weight: 2 },
    missing: { color: "#475569", fillColor: "#cbd5e1", fillOpacity: 0.34, weight: 2 },
    weed: { color: "#16a34a", fillColor: "#86efac", fillOpacity: 0.36, weight: 2 },
    pest: { color: "#ea580c", fillColor: "#fb923c", fillOpacity: 0.34, weight: 2 },
    disease: { color: "#b91c1c", fillColor: "#f87171", fillOpacity: 0.36, weight: 2 },
    fertilizer: { color: "#7c3aed", fillColor: "#c4b5fd", fillOpacity: 0.34, weight: 2 },
    bareSoil: { color: "#854d0e", fillColor: "#d97706", fillOpacity: 0.3, weight: 2 },
    noFlyZone: { color: "#991b1b", fillColor: "#ef4444", fillOpacity: 0.24, weight: 2, dashArray: "7 5" },
    obstacle: { color: "#334155", fillColor: "#64748b", fillOpacity: 0.26, weight: 2 },
    drone: { color: "#111827", weight: 1.8, opacity: 0.78, dashArray: "5 6" },
    droneWarning: { color: "#dc2626", weight: 3.5, opacity: 0.9 },
    grid: { color: "#64748b", weight: 0.7, opacity: 0.24, fillOpacity: 0 },
    drawing: { color: "#2563eb", fillColor: "#93c5fd", fillOpacity: 0.22, weight: 2, dashArray: "4 4" }
  };

  const PLANT_CATEGORIES = ["healthy", "weak", "missing"];
  const PROBLEM_CATEGORIES = ["weed", "pest", "disease", "fertilizer", "bareSoil"];
  const POLYGON_MODES = new Set(["water", "healthy", "weak", "missing", "weed", "pest", "disease", "fertilizer", "bareSoil", "noFlyZone"]);
  const MARKER_MODES = new Set(["inlet", "outlet", "gate", "drainage", "tree", "pole", "building"]);
  const EDITABLE_FEATURE_GROUPS = new Set(["water", "plant", "problem", "irrigation", "obstacle"]);
  const GRID_CELL_WARN_THRESHOLD = 2000;
  const GRID_CELL_HARD_LIMIT = 5000;

  const DEMO_ANALYSIS = {
    waterDepthCm: 5,
    gridSizeMeters: 5,
    fieldBoundary: [
      [34.65480, 135.82982],
      [34.65477, 135.83069],
      [34.65452, 135.83074],
      [34.65425, 135.83061],
      [34.65421, 135.82991],
      [34.65448, 135.82978]
    ],
    waterPolygons: [
      {
        id: "water-main",
        category: "water",
        note: "浅水管理中の水面",
        coordinates: [
          [34.65472, 135.82992],
          [34.65469, 135.83055],
          [34.65448, 135.83059],
          [34.65431, 135.83048],
          [34.65430, 135.82998],
          [34.65449, 135.82991]
        ]
      }
    ],
    plantPolygons: [
      {
        id: "rice-healthy-a",
        category: "healthy",
        note: "葉色と株密度が良好",
        coordinates: [
          [34.65467, 135.82994],
          [34.65464, 135.83025],
          [34.65446, 135.83025],
          [34.65446, 135.82996]
        ]
      },
      {
        id: "rice-weak-a",
        category: "weak",
        note: "北東側で生育が弱い",
        coordinates: [
          [34.65466, 135.83030],
          [34.65463, 135.83056],
          [34.65451, 135.83058],
          [34.65450, 135.83030]
        ]
      },
      {
        id: "rice-missing-a",
        category: "missing",
        note: "欠株・苗抜けの疑い",
        coordinates: [
          [34.65442, 135.83012],
          [34.65440, 135.83028],
          [34.65433, 135.83027],
          [34.65434, 135.83010]
        ]
      }
    ],
    problemZones: [
      {
        id: "weed-west",
        category: "weed",
        note: "畦際に雑草密度が高い",
        coordinates: [
          [34.65460, 135.82985],
          [34.65458, 135.82994],
          [34.65438, 135.82996],
          [34.65438, 135.82987]
        ]
      },
      {
        id: "pest-south",
        category: "pest",
        note: "食害パターン候補",
        coordinates: [
          [34.65436, 135.83034],
          [34.65435, 135.83048],
          [34.65427, 135.83046],
          [34.65428, 135.83032]
        ]
      },
      {
        id: "disease-center",
        category: "disease",
        note: "葉色異常の集中的な領域",
        coordinates: [
          [34.65454, 135.83012],
          [34.65453, 135.83022],
          [34.65445, 135.83021],
          [34.65446, 135.83011]
        ]
      },
      {
        id: "fertilizer-east",
        category: "fertilizer",
        note: "肥料むらの可能性",
        coordinates: [
          [34.65456, 135.83050],
          [34.65455, 135.83063],
          [34.65443, 135.83063],
          [34.65444, 135.83050]
        ]
      },
      {
        id: "bare-soil-southwest",
        category: "bareSoil",
        note: "裸地・水深不足確認",
        coordinates: [
          [34.65432, 135.82996],
          [34.65431, 135.83008],
          [34.65424, 135.83006],
          [34.65425, 135.82996]
        ]
      }
    ],
    irrigationMarkers: [
      { id: "inlet-1", type: "inlet", lat: 34.65476, lon: 135.83021, note: "北側用水路から入水" },
      { id: "outlet-1", type: "outlet", lat: 34.65424, lon: 135.83052, note: "南東側へ排水" },
      { id: "gate-1", type: "gate", lat: 34.65481, lon: 135.83022, note: "手動水門。将来自動制御候補" },
      { id: "drainage-1", type: "drainage", lat: 34.65425, lon: 135.82996, note: "大雨時の逃げ口" }
    ],
    obstacles: [
      { id: "tree-1", type: "tree", geometry: "point", lat: 34.65469, lon: 135.82984, note: "畦の外側の樹木" },
      {
        id: "no-fly-1",
        type: "noFlyZone",
        geometry: "polygon",
        note: "人の通行がある農道側",
        coordinates: [
          [34.65473, 135.83054],
          [34.65470, 135.83066],
          [34.65458, 135.83068],
          [34.65459, 135.83054]
        ]
      }
    ],
    gridCellData: {}
  };

  class PaddyFieldIntelligence {
    constructor({ map, getBoundary, getGnssPoints, onMetricsChange }) {
      if (!map || typeof L === "undefined") {
        throw new Error("PaddyFieldIntelligence requires a Leaflet map.");
      }
      this.map = map;
      this.getBaseBoundary = getBoundary;
      this.getGnssPoints = getGnssPoints || (() => []);
      this.onMetricsChange = onMetricsChange || (() => {});
      this.analysis = clone(DEMO_ANALYSIS);
      this.layers = Object.fromEntries(
        ["boundary", "water", "plant", "problem", "irrigation", "obstacle", "drone", "grid", "drawing"].map((key) => [key, L.layerGroup().addTo(map)])
      );
      this.metrics = {};
      this.gridCells = [];
      this.dronePlan = emptyDronePlan();
      this.gnssAssociations = [];
      this.gnssSummary = emptyGnssSummary();
      this.selected = null;
      this.drawing = null;
      this.warningMessages = [];
      this.elements = this.collectElements();
      this.bindEvents();
      this.renderLegend();
      this.updateDrawingUi();
      this.updateSelectionUi();
      this.loadDemoData({ fit: false });
    }

    collectElements() {
      const byId = (id) => document.getElementById(id);
      return {
        layers: {
          boundary: byId("showPaddyBoundaryLayer"),
          water: byId("showWaterLayer"),
          plant: byId("showPlantLayer"),
          problem: byId("showProblemLayer"),
          irrigation: byId("showIrrigationLayer"),
          obstacle: byId("showObstacleLayer"),
          drone: byId("showDroneLayer"),
          grid: byId("showGridLayer")
        },
        metrics: {
          area: byId("paddyAreaMetric"),
          water: byId("waterCoverageMetric"),
          plant: byId("plantCoverageMetric"),
          problem: byId("problemCoverageMetric"),
          waterVolume: byId("waterVolumeMetric"),
          flightSpacing: byId("flightSpacingMetric"),
          flightLines: byId("flightLineMetric"),
          flightLength: byId("flightLengthMetric"),
          flightTime: byId("flightTimeMetric"),
          photoCount: byId("flightPhotoMetric"),
          gridCells: byId("gridCellCountMetric")
        },
        inputs: {
          waterDepth: byId("targetWaterDepthInput"),
          altitude: byId("flightAltitudeInput"),
          swathWidth: byId("swathWidthInput"),
          overlap: byId("imageOverlapInput"),
          speed: byId("flightSpeedInput"),
          angle: byId("flightAngleInput"),
          safetyMargin: byId("flightSafetyMarginInput"),
          gridSize: byId("gridSizeSelect"),
          gnssThreshold: byId("gnssBoundaryThresholdInput"),
          annotationType: byId("annotationTypeSelect"),
          import: byId("paddyImportInput")
        },
        buttons: {
          loadDemo: byId("loadPaddyDemoButton"),
          resetDemo: byId("resetPaddyDemoButton"),
          clearAnalysis: byId("clearPaddyAnalysisButton"),
          recalculate: byId("recalculatePaddyButton"),
          finishPolygon: byId("finishPaddyPolygonButton"),
          cancelDrawing: byId("cancelPaddyDrawingButton"),
          export: byId("exportAnalysisButton"),
          recalculateGnss: byId("recalculateGnssAssociationButton"),
          saveNote: byId("saveSelectedNoteButton"),
          saveGrid: byId("saveGridCellButton")
        },
        tables: {
          problem: byId("problemAreaTable"),
          plant: byId("plantAreaTable")
        },
        selectedSummary: byId("selectedFeatureSummary"),
        selectedNote: byId("selectedFeatureNote"),
        warnings: byId("paddyWarnings"),
        droneWarnings: byId("droneWarnings"),
        gnss: {
          total: byId("gnssTotalMetric"),
          inside: byId("gnssInsideMetric"),
          outside: byId("gnssOutsideMetric"),
          nearBoundary: byId("gnssNearBoundaryMetric"),
          gridAssociation: byId("gnssGridAssociationMetric"),
          message: byId("gnssAssociationMessage")
        },
        drawingHint: byId("drawingHint"),
        drawingModeBadge: byId("drawingModeBadge"),
        drawingPointCount: byId("drawingPointCount"),
        legend: byId("paddyLegend"),
        gridDetail: byId("gridCellDetail"),
        gridEditor: byId("gridCellEditor"),
        gridWaterStatus: byId("gridWaterStatus"),
        gridPlantStatus: byId("gridPlantStatus"),
        gridWeedStatus: byId("gridWeedStatus"),
        gridPestDiseaseStatus: byId("gridPestDiseaseStatus"),
        gridNotes: byId("gridNotes")
      };
    }

    bindEvents() {
      Object.entries(this.elements.layers).forEach(([key, input]) => {
        input?.addEventListener("change", () => {
          if (key === "grid") {
            this.refresh();
            return;
          }
          this.syncLayerVisibility();
        });
      });
      this.elements.buttons.loadDemo?.addEventListener("click", () => this.loadDemoData());
      this.elements.buttons.resetDemo?.addEventListener("click", () => this.loadDemoData());
      this.elements.buttons.clearAnalysis?.addEventListener("click", () => this.clearAnalysis());
      this.elements.buttons.recalculate?.addEventListener("click", () => this.refresh());
      this.elements.buttons.finishPolygon?.addEventListener("click", () => this.finishPolygon());
      this.elements.buttons.cancelDrawing?.addEventListener("click", () => this.cancelDrawing({ resetMode: true }));
      this.elements.buttons.export?.addEventListener("click", () => this.downloadJson());
      this.elements.buttons.recalculateGnss?.addEventListener("click", () => this.refresh());
      this.elements.buttons.saveNote?.addEventListener("click", () => this.saveSelectedNote());
      this.elements.buttons.saveGrid?.addEventListener("click", () => this.saveSelectedGridCell());
      this.elements.inputs.import?.addEventListener("change", (event) => this.importJsonFromInput(event));
      this.elements.inputs.annotationType?.addEventListener("change", () => this.setAnnotationMode());
      [
        this.elements.inputs.waterDepth,
        this.elements.inputs.altitude,
        this.elements.inputs.swathWidth,
        this.elements.inputs.overlap,
        this.elements.inputs.speed,
        this.elements.inputs.angle,
        this.elements.inputs.safetyMargin,
        this.elements.inputs.gnssThreshold,
        this.elements.inputs.gridSize
      ].forEach((input) => input?.addEventListener("input", () => this.refresh()));
      this.elements.inputs.gridSize?.addEventListener("change", () => this.refresh());
      this.map.on("click", (event) => this.handleMapClick(event));
      this.map.on("dblclick", () => this.finishPolygon());
    }

    loadDemoData(options = {}) {
      this.analysis = clone(DEMO_ANALYSIS);
      this.setDefaultInputsFromAnalysis();
      this.clearSelection();
      this.cancelDrawing({ resetMode: true });
      this.refresh();
      if (options.fit !== false) {
        this.fitBoundary();
      }
    }

    clearAnalysis() {
      this.analysis = {
        waterDepthCm: numberFromInput(this.elements.inputs.waterDepth, 5),
        gridSizeMeters: numberFromInput(this.elements.inputs.gridSize, 5),
        fieldBoundary: [],
        waterPolygons: [],
        plantPolygons: [],
        problemZones: [],
        irrigationMarkers: [],
        obstacles: [],
        gridCellData: {}
      };
      this.clearSelection();
      this.cancelDrawing({ resetMode: true });
      this.refresh();
    }

    setDefaultInputsFromAnalysis() {
      if (this.elements.inputs.waterDepth) {
        this.elements.inputs.waterDepth.value = this.analysis.waterDepthCm ?? 5;
      }
      if (this.elements.inputs.gridSize) {
        this.elements.inputs.gridSize.value = String(this.analysis.gridSizeMeters ?? 5);
      }
    }

    getBoundaryPoints() {
      const baseBoundary = this.getBaseBoundary?.();
      if (Array.isArray(baseBoundary) && baseBoundary.length >= 3) {
        return baseBoundary;
      }
      if (Array.isArray(this.analysis.fieldBoundary) && this.analysis.fieldBoundary.length >= 3) {
        return this.analysis.fieldBoundary;
      }
      return [];
    }

    refresh() {
      this.warningMessages = [];
      Object.values(this.layers).forEach((layer) => layer.clearLayers());
      const boundary = this.getBoundaryPoints();
      if (boundary.length < 3) {
        this.addWarning("No field boundary loaded.");
      } else {
        this.renderBoundary(boundary);
      }

      this.renderPolygons(this.analysis.waterPolygons, "water", this.layers.water);
      this.renderPolygons(this.analysis.plantPolygons, "plant", this.layers.plant);
      this.renderPolygons(this.analysis.problemZones, "problem", this.layers.problem);
      this.renderMarkers(this.analysis.irrigationMarkers, this.layers.irrigation);
      this.renderObstacles();
      this.dronePlan = this.generateDronePath();
      this.renderDronePath();
      this.gridCells = this.generateGridCells();
      this.updateGnssAssociations();
      this.renderGridCells();
      this.updateMetrics();
      this.renderWarnings();
      this.syncLayerVisibility();
      this.updateDrawingUi();
      this.updateSelectionUi();
      this.onMetricsChange(this.metrics);
    }

    renderBoundary(boundary) {
      L.polygon(boundary, STYLES.boundary)
        .bindTooltip(STATUS_LABELS.boundary)
        .on("click", (event) => {
          event.originalEvent?.stopPropagation();
          this.selectFeature({
          id: "field-boundary",
          type: "polygon",
          category: "boundary",
          coordinates: boundary,
          note: "解析用の圃場境界"
          });
        })
        .addTo(this.layers.boundary);
    }

    renderPolygons(polygons, group, layer) {
      polygons.forEach((zone) => {
        const style = STYLES[zone.category] || STYLES.water;
        L.polygon(zone.coordinates, style)
          .bindTooltip(STATUS_LABELS[zone.category] || zone.category)
          .on("click", (event) => {
            event.originalEvent?.stopPropagation();
            this.selectFeature({ ...zone, type: "polygon", group });
          })
          .addTo(layer);
      });
    }

    renderMarkers(markers, layer) {
      markers.forEach((marker) => {
        L.circleMarker([marker.lat, marker.lon], this.markerStyle(marker.type))
          .bindTooltip(STATUS_LABELS[marker.type] || marker.type)
          .on("click", (event) => {
            event.originalEvent?.stopPropagation();
            this.selectFeature({ ...marker, geometry: "point", group: "irrigation" });
          })
          .addTo(layer);
      });
    }

    renderObstacles() {
      this.analysis.obstacles.forEach((item) => {
        if (item.geometry === "polygon") {
          const style = item.type === "noFlyZone" ? STYLES.noFlyZone : STYLES.obstacle;
          L.polygon(item.coordinates, style)
            .bindTooltip(STATUS_LABELS[item.type] || item.type)
            .on("click", (event) => {
              event.originalEvent?.stopPropagation();
              this.selectFeature({ ...item, group: "obstacle" });
            })
            .addTo(this.layers.obstacle);
          return;
        }
        L.circleMarker([item.lat, item.lon], this.markerStyle(item.type))
          .bindTooltip(STATUS_LABELS[item.type] || item.type)
          .on("click", (event) => {
            event.originalEvent?.stopPropagation();
            this.selectFeature({ ...item, geometry: "point", group: "obstacle" });
          })
          .addTo(this.layers.obstacle);
      });
    }

    markerStyle(type) {
      const fillColor = {
        inlet: "#0284c7",
        outlet: "#0f766e",
        gate: "#2563eb",
        drainage: "#0891b2",
        tree: "#166534",
        pole: "#475569",
        building: "#854d0e"
      }[type] || "#64748b";
      return {
        radius: type === "tree" || type === "building" ? 9 : 7,
        color: "#ffffff",
        fillColor,
        fillOpacity: 0.95,
        opacity: 1,
        weight: 2
      };
    }

    renderDronePath() {
      if (this.dronePlan.path.length >= 2) {
        L.polyline(this.dronePlan.path, STYLES.drone)
          .bindTooltip("ドローン概算飛行経路")
          .on("click", (event) => {
            event.originalEvent?.stopPropagation();
            this.selectFeature({
            id: "drone-path",
            type: "line",
            category: "drone",
            coordinates: this.dronePlan.path,
            note: `${this.dronePlan.lineCount} lines, ${formatMeters(this.dronePlan.pathLengthMeters)}`
            });
          })
          .addTo(this.layers.drone);
      }
      this.dronePlan.warningSegments.forEach((segment, index) => {
        L.polyline(segment, STYLES.droneWarning)
          .bindTooltip(`飛行禁止区域と交差 ${index + 1}`)
          .addTo(this.layers.drone);
      });
    }

    renderGridCells() {
      this.gridCells.forEach((cell) => {
        L.polygon(cell.coordinates, STYLES.grid)
          .bindTooltip(cell.id)
          .on("click", (event) => {
            event.originalEvent?.stopPropagation();
            this.selectGridCell(cell);
          })
          .addTo(this.layers.grid);
      });
    }

    updateGnssAssociations() {
      const points = this.getNormalizedGnssPoints();
      const boundary = this.getBoundaryPoints();
      const thresholdMeters = Math.max(0, numberFromInput(this.elements.inputs.gnssThreshold, 2));
      const gridEnabled = this.elements.layers.grid?.checked ?? false;
      const summary = emptyGnssSummary();
      summary.total = points.length;
      summary.nearThreshold_m = thresholdMeters;
      summary.gridEnabled = gridEnabled;

      this.gridCells.forEach((cell) => {
        cell.gnssPointCount = 0;
        cell.latestGnssTimestamp = "";
        cell.averageFixQuality = null;
        cell.gnssStatusCounts = {};
        cell.gnssFixQualitySum = 0;
        cell.gnssFixQualityCount = 0;
      });

      if (boundary.length < 3) {
        summary.message = "No field boundary loaded.";
        this.gnssSummary = summary;
        this.gnssAssociations = points.map((point, index) => this.buildGnssAssociation(point, index, "no-field-boundary", false, null));
        this.renderGnssSummary();
        return;
      }

      if (points.length === 0) {
        summary.message = "No QZ1/GNSS points loaded.";
        this.gnssSummary = summary;
        this.gnssAssociations = [];
        this.renderGnssSummary();
        return;
      }

      const projection = createLocalProjection(boundary);
      const boundaryXY = boundary.map(projection.toXY);
      this.gnssAssociations = points.map((point, index) => {
        const pointXY = projection.toXY([point.lat, point.lon]);
        const inside = pointInPolygonXY(pointXY, boundaryXY);
        const nearBoundary = distanceToPolygonMeters(pointXY, boundaryXY) <= thresholdMeters;
        const relation = nearBoundary ? "near-boundary" : inside ? "inside-field" : "outside-field";
        const gridCell = gridEnabled ? this.findGridCellForPoint(point) : null;

        if (inside) {
          summary.inside += 1;
        } else {
          summary.outside += 1;
        }
        if (nearBoundary) {
          summary.nearBoundary += 1;
        }
        if (gridCell) {
          summary.withGridCell += 1;
          this.addGnssPointToGridCell(gridCell, point);
        }

        return this.buildGnssAssociation(point, index, relation, nearBoundary, gridCell?.id || null);
      });

      this.gridCells.forEach((cell) => {
        if (cell.gnssFixQualityCount > 0) {
          cell.averageFixQuality = cell.gnssFixQualitySum / cell.gnssFixQualityCount;
        }
        delete cell.gnssFixQualitySum;
        delete cell.gnssFixQualityCount;
      });

      summary.message = gridEnabled
        ? `${summary.withGridCell.toLocaleString()} points associated with grid cells.`
        : "Grid association is off because the management grid layer is disabled.";
      this.gnssSummary = summary;
      this.renderGnssSummary();
    }

    getNormalizedGnssPoints() {
      return (this.getGnssPoints?.() || [])
        .map((point, index) => ({
          id: point.id || `gnss-${index}`,
          index,
          lat: Number(point.lat),
          lon: Number(point.lon),
          timestamp: point.timestamp || "",
          fixQuality: Number.isFinite(Number(point.fixQuality)) ? Number(point.fixQuality) : null,
          status: point.augmented ? "DGNSS (method unverified)" : Number.isFinite(Number(point.fixQuality)) ? `fix=${point.fixQuality}` : "unknown"
        }))
        .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));
    }

    buildGnssAssociation(point, index, relation, nearBoundary, gridCellId) {
      return {
        pointId: point.id || `gnss-${index}`,
        index,
        coordinates: [point.lat, point.lon],
        timestamp: point.timestamp || "",
        fixQuality: point.fixQuality,
        status: point.status || "unknown",
        fieldRelation: relation,
        nearBoundary,
        gridCellId
      };
    }

    findGridCellForPoint(point) {
      if (this.gridCells.length === 0) {
        return null;
      }

      const projection = createLocalProjection(this.getBoundaryPoints());
      const pointXY = projection.toXY([point.lat, point.lon]);
      const containingCell = this.gridCells.find((cell) => pointInPolygonXY(pointXY, cell.coordinates.map(projection.toXY)));
      if (containingCell) {
        return containingCell;
      }

      return this.gridCells.reduce((nearest, cell) => {
        const center = polygonCentroidXY(cell.coordinates.map(projection.toXY));
        const distance = Math.hypot(pointXY.x - center.x, pointXY.y - center.y);
        return !nearest || distance < nearest.distance ? { cell, distance } : nearest;
      }, null)?.cell || null;
    }

    addGnssPointToGridCell(cell, point) {
      cell.gnssPointCount += 1;
      if (point.timestamp) {
        cell.latestGnssTimestamp = latestTimestampLabel(cell.latestGnssTimestamp, point.timestamp);
      }
      const status = point.status || "unknown";
      cell.gnssStatusCounts[status] = (cell.gnssStatusCounts[status] || 0) + 1;
      if (Number.isFinite(point.fixQuality)) {
        cell.gnssFixQualitySum += point.fixQuality;
        cell.gnssFixQualityCount += 1;
      }
    }

    renderGnssSummary() {
      text(this.elements.gnss.total, this.gnssSummary.total.toLocaleString());
      text(this.elements.gnss.inside, this.gnssSummary.inside.toLocaleString());
      text(this.elements.gnss.outside, this.gnssSummary.outside.toLocaleString());
      text(this.elements.gnss.nearBoundary, this.gnssSummary.nearBoundary.toLocaleString());
      text(this.elements.gnss.gridAssociation, this.gnssSummary.gridEnabled ? `${this.gnssSummary.withGridCell.toLocaleString()} points` : "grid off");
      text(this.elements.gnss.message, this.gnssSummary.message);
    }

    updateMetrics() {
      const fieldArea = polygonAreaSqm(this.getBoundaryPoints());
      const waterArea = sumPolygonAreas(this.analysis.waterPolygons);
      const plantAreas = areaByCategory(this.analysis.plantPolygons, PLANT_CATEGORIES);
      const problemAreas = areaByCategory(this.analysis.problemZones, PROBLEM_CATEGORIES);
      const plantArea = Object.values(plantAreas).reduce((sum, area) => sum + area, 0);
      const problemArea = Object.values(problemAreas).reduce((sum, area) => sum + area, 0);
      const waterDepthCm = numberFromInput(this.elements.inputs.waterDepth, this.analysis.waterDepthCm ?? 5);
      const safeWaterDepthCm = Math.max(0, waterDepthCm);
      const waterDepthMeters = safeWaterDepthCm / 100;
      const waterVolume = fieldArea * waterDepthMeters;

      if (waterDepthCm < 0) {
        this.addWarning("Water depth is negative.");
      }

      this.metrics = {
        fieldArea,
        fieldAreaAre: fieldArea / 100,
        fieldAreaTan: fieldArea / 991.7,
        waterArea,
        plantArea,
        problemArea,
        plantAreas,
        problemAreas,
        waterCoveragePct: percent(waterArea, fieldArea),
        plantCoveragePct: percent(plantArea, fieldArea),
        problemCoveragePct: percent(problemArea, fieldArea),
        waterVolumeCubicMeters: waterVolume,
        waterVolumeLiters: waterVolume * 1000,
        waterDepthCm: safeWaterDepthCm
      };

      text(this.elements.metrics.area, formatAreaFull(fieldArea));
      text(this.elements.metrics.water, `${formatAreaShort(waterArea)} / ${formatPercent(this.metrics.waterCoveragePct)}`);
      text(this.elements.metrics.plant, `${formatAreaShort(plantArea)} / ${formatPercent(this.metrics.plantCoveragePct)}`);
      text(this.elements.metrics.problem, `${formatAreaShort(problemArea)} / ${formatPercent(this.metrics.problemCoveragePct)}`);
      text(this.elements.metrics.waterVolume, `${waterVolume.toFixed(1)} m³ / ${Math.round(waterVolume * 1000).toLocaleString()} L`);
      text(this.elements.metrics.flightSpacing, `${this.dronePlan.lineSpacingMeters.toFixed(1)} m`);
      text(this.elements.metrics.flightLines, `${this.dronePlan.lineCount.toLocaleString()} 本`);
      text(this.elements.metrics.flightLength, formatMeters(this.dronePlan.pathLengthMeters));
      text(this.elements.metrics.flightTime, `${this.dronePlan.estimatedMinutes.toFixed(1)} 分`);
      text(this.elements.metrics.photoCount, `${this.dronePlan.estimatedPhotoCount.toLocaleString()} 枚`);
      text(this.elements.metrics.gridCells, `${this.gridCells.length.toLocaleString()} セル`);
      this.renderAreaTables();
    }

    renderAreaTables() {
      if (this.elements.tables.problem) {
        this.elements.tables.problem.innerHTML = PROBLEM_CATEGORIES.map((category) => this.areaRow(category, this.metrics.problemAreas[category] || 0)).join("");
      }
      if (this.elements.tables.plant) {
        this.elements.tables.plant.innerHTML = PLANT_CATEGORIES.map((category) => this.areaRow(category, this.metrics.plantAreas[category] || 0)).join("");
      }
    }

    areaRow(category, area) {
      const style = STYLES[category] || STYLES.water;
      return `
        <tr>
          <td><span class="legend-swatch" style="background:${style.fillColor}"></span>${escapeHtml(STATUS_LABELS[category] || category)}</td>
          <td>${escapeHtml(formatAreaShort(area))}</td>
          <td>${escapeHtml(formatPercent(percent(area, this.metrics.fieldArea)))}</td>
        </tr>
      `;
    }

    generateDronePath() {
      const boundary = this.getBoundaryPoints();
      const plan = emptyDronePlan();
      if (boundary.length < 3) {
        this.addWarning("Drone path cannot be generated without a field boundary.");
        return plan;
      }

      const swathWidth = numberFromInput(this.elements.inputs.swathWidth, 10);
      const overlap = numberFromInput(this.elements.inputs.overlap, 70);
      const speed = numberFromInput(this.elements.inputs.speed, 4);
      const angle = numberFromInput(this.elements.inputs.angle, 0);
      const safetyMargin = numberFromInput(this.elements.inputs.safetyMargin, 0);
      const invalidSwathWidth = swathWidth <= 0;
      const invalidSpeed = speed <= 0;
      if (invalidSwathWidth) {
        this.addWarning("Swath width is zero or negative.");
      }
      if (invalidSpeed) {
        this.addWarning("Flight speed must be positive.");
      }
      if (overlap < 0 || overlap > 95) {
        this.addWarning("Overlap must be between 0 and 95%.");
      }
      if (safetyMargin < 0) {
        this.addWarning("Safety margin is negative; using 0 m.");
      }
      if (invalidSwathWidth || invalidSpeed) {
        return plan;
      }

      const clampedOverlap = Math.min(95, Math.max(0, overlap));
      const lineSpacing = Math.max(0.25, swathWidth * (1 - clampedOverlap / 100));
      const projection = createLocalProjection(boundary);
      const transformer = createRotatedTransformer(projection, angle);
      const boundaryXY = inwardOffsetPolygon(boundary.map(transformer.toScan), Math.max(0, safetyMargin));
      if (boundaryXY.length < 3 || Math.abs(polygonAreaXY(boundaryXY)) <= 1) {
        this.addWarning("Drone path cannot be generated after applying the safety margin.");
        return { ...plan, lineSpacingMeters: lineSpacing };
      }

      const noFlyPolygons = this.analysis.obstacles
        .filter((item) => item.geometry === "polygon" && item.type === "noFlyZone")
        .map((item) => item.coordinates.map(transformer.toScan));
      const yValues = boundaryXY.map((point) => point.y);
      const minY = Math.min(...yValues);
      const maxY = Math.max(...yValues);
      const path = [];
      const warningSegments = [];
      let lineCount = 0;
      let reverse = false;

      for (let y = minY + lineSpacing / 2; y <= maxY - lineSpacing / 4; y += lineSpacing) {
        const fieldIntervals = polygonIntersectionsAtY(boundaryXY, y);
        const blockedIntervals = noFlyPolygons.flatMap((polygon) => polygonIntersectionsAtY(polygon, y));
        const openIntervals = subtractIntervals(fieldIntervals, blockedIntervals);
        if (fieldIntervals.length > 0 && blockedIntervals.length > 0) {
          this.addWarning("Some drone path lines intersect no-fly zones; blocked spans were removed where possible.");
        }

        openIntervals.forEach((interval) => {
          const [startX, endX] = reverse ? [interval[1], interval[0]] : interval;
          const start = transformer.toLatLng({ x: startX, y });
          const end = transformer.toLatLng({ x: endX, y });
          const segment = [start, end];
          if (noFlyPolygons.some((polygon) => lineIntersectsPolygonXY({ x: startX, y }, { x: endX, y }, polygon))) {
            warningSegments.push(segment);
          }
          path.push(start, end);
          lineCount += 1;
          reverse = !reverse;
        });
      }

      if (path.length < 2) {
        this.addWarning("Drone path cannot be generated.");
      }
      if (warningSegments.length > 0) {
        this.addWarning("Some drone path segments still intersect no-fly zones.");
      }

      const pathLength = pathLengthMeters(path);
      const photoSpacing = lineSpacing;
      const estimatedPhotoCount = photoSpacing > 0 ? Math.ceil(pathLength / photoSpacing) : 0;
      return {
        settings: { swathWidthMeters: swathWidth, overlapPercent: overlap, speedMetersPerSecond: speed, angleDegrees: angle, safetyMarginMeters: safetyMargin },
        path,
        lineCount,
        lineSpacingMeters: lineSpacing,
        pathLengthMeters: pathLength,
        estimatedMinutes: pathLength / speed / 60,
        estimatedPhotoCount,
        warningSegments,
        warnings: [...this.warningMessages]
      };
    }

    generateGridCells() {
      const boundary = this.getBoundaryPoints();
      const size = numberFromInput(this.elements.inputs.gridSize, this.analysis.gridSizeMeters ?? 5);
      if (boundary.length < 3) {
        return [];
      }
      if (size <= 0) {
        this.addWarning("Grid size must be positive.");
        return [];
      }

      const projection = createLocalProjection(boundary);
      const boundaryXY = boundary.map(projection.toXY);
      const xs = boundaryXY.map((point) => point.x);
      const ys = boundaryXY.map((point) => point.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const estimatedCells = Math.ceil((maxX - minX) / size) * Math.ceil((maxY - minY) / size);
      if (estimatedCells > GRID_CELL_WARN_THRESHOLD) {
        this.addWarning(`Grid size is very small for this field (${estimatedCells.toLocaleString()} candidate cells).`);
      }
      if (estimatedCells > GRID_CELL_HARD_LIMIT) {
        this.addWarning(`Grid rendering skipped because it would exceed ${GRID_CELL_HARD_LIMIT.toLocaleString()} candidate cells.`);
        return [];
      }

      const cells = [];
      let index = 1;
      for (let y = minY; y < maxY; y += size) {
        for (let x = minX; x < maxX; x += size) {
          const center = { x: x + size / 2, y: y + size / 2 };
          if (!pointInPolygonXY(center, boundaryXY)) {
            continue;
          }

          const id = `G-${index}`;
          const existing = this.analysis.gridCellData[id] || {};
          const corners = [
            projection.toLatLng({ x, y }),
            projection.toLatLng({ x: Math.min(x + size, maxX), y }),
            projection.toLatLng({ x: Math.min(x + size, maxX), y: Math.min(y + size, maxY) }),
            projection.toLatLng({ x, y: Math.min(y + size, maxY) })
          ];
          cells.push({
            id,
            area_m2: polygonAreaSqm(corners),
            coordinates: corners,
            waterStatus: existing.waterStatus || "unknown",
            plantStatus: existing.plantStatus || "unknown",
            weedStatus: existing.weedStatus || "unknown",
            pestDiseaseStatus: existing.pestDiseaseStatus || "unknown",
            notes: existing.notes || ""
          });
          index += 1;
        }
      }
      return cells;
    }

    setAnnotationMode() {
      this.cancelDrawing();
      const mode = this.elements.inputs.annotationType?.value || "";
      if (!mode) {
        this.setDrawingHint("注釈タイプを選ぶと地図上で追加できます。");
        this.updateDrawingUi();
        return;
      }
      if (POLYGON_MODES.has(mode)) {
        this.drawing = { mode, points: [] };
        this.map.doubleClickZoom?.disable();
        this.setDrawingHint(`${STATUS_LABELS[mode] || mode}: 地図をクリックして頂点を追加。3点以上で「ポリゴンを確定」が使えます。`);
        this.updateDrawingUi();
        return;
      }
      if (MARKER_MODES.has(mode)) {
        this.drawing = { mode, points: [] };
        this.setDrawingHint(`${STATUS_LABELS[mode] || mode}: 地図を1回クリックするとマーカーを追加します。`);
        this.updateDrawingUi();
      }
    }

    handleMapClick(event) {
      if (!this.drawing) {
        return;
      }
      const mode = this.drawing.mode;
      const latLng = [event.latlng.lat, event.latlng.lng];
      if (MARKER_MODES.has(mode)) {
        this.addMarkerAnnotation(mode, latLng);
        return;
      }
      if (!POLYGON_MODES.has(mode)) {
        return;
      }
      this.drawing.points.push(latLng);
      this.renderDrawingPreview();
      this.updateDrawingUi();
    }

    renderDrawingPreview() {
      this.layers.drawing.clearLayers();
      if (!this.drawing || this.drawing.points.length === 0) {
        return;
      }
      L.polyline(this.drawing.points, STYLES.drawing).addTo(this.layers.drawing);
      this.drawing.points.forEach((point) => {
        L.circleMarker(point, { radius: 4, color: "#2563eb", fillColor: "#bfdbfe", fillOpacity: 1, weight: 2 }).addTo(this.layers.drawing);
      });
      if (this.drawing.points.length >= 3) {
        L.polygon(this.drawing.points, STYLES.drawing).addTo(this.layers.drawing);
      }
    }

    finishPolygon() {
      if (!this.drawing || !POLYGON_MODES.has(this.drawing.mode)) {
        return;
      }
      if (this.drawing.points.length < 3) {
        this.addWarning("Polygon annotation needs at least three points.");
        this.renderWarnings();
        this.updateDrawingUi();
        return;
      }
      const zone = {
        id: `${this.drawing.mode}-${Date.now()}`,
        category: this.drawing.mode,
        note: "",
        coordinates: this.drawing.points.map(([lat, lon]) => [roundCoord(lat), roundCoord(lon)])
      };
      if (this.drawing.mode === "water") {
        this.analysis.waterPolygons.push(zone);
      } else if (PLANT_CATEGORIES.includes(this.drawing.mode)) {
        this.analysis.plantPolygons.push(zone);
      } else if (this.drawing.mode === "noFlyZone") {
        this.analysis.obstacles.push({ ...zone, type: "noFlyZone", geometry: "polygon" });
      } else {
        this.analysis.problemZones.push(zone);
      }
      this.cancelDrawing({ resetMode: true });
      this.refresh();
      this.selectFeature({ ...zone, type: "polygon" });
    }

    addMarkerAnnotation(mode, latLng) {
      const marker = {
        id: `${mode}-${Date.now()}`,
        type: mode,
        lat: roundCoord(latLng[0]),
        lon: roundCoord(latLng[1]),
        note: ""
      };
      if (["tree", "pole", "building"].includes(mode)) {
        this.analysis.obstacles.push({ ...marker, geometry: "point" });
      } else {
        this.analysis.irrigationMarkers.push(marker);
      }
      this.cancelDrawing({ resetMode: true });
      if (this.elements.inputs.annotationType) {
        this.elements.inputs.annotationType.value = "";
      }
      this.refresh();
      this.selectFeature({ ...marker, geometry: "point" });
    }

    cancelDrawing({ resetMode = false } = {}) {
      this.layers.drawing.clearLayers();
      this.drawing = null;
      this.map.doubleClickZoom?.enable();
      if (resetMode && this.elements.inputs.annotationType) {
        this.elements.inputs.annotationType.value = "";
      }
      this.setDrawingHint("注釈タイプを選ぶと地図上で追加できます。");
      this.updateDrawingUi();
    }

    updateDrawingUi() {
      const mode = this.drawing?.mode || "";
      const pointCount = this.drawing?.points?.length || 0;
      const isPolygon = POLYGON_MODES.has(mode);
      const canFinish = isPolygon && pointCount >= 3;
      if (this.elements.drawingModeBadge) {
        this.elements.drawingModeBadge.textContent = mode ? `描画中: ${STATUS_LABELS[mode] || mode}` : "描画モードなし";
        this.elements.drawingModeBadge.classList.toggle("active", Boolean(mode));
      }
      text(this.elements.drawingPointCount, String(pointCount));
      if (this.elements.buttons.finishPolygon) {
        this.elements.buttons.finishPolygon.disabled = !canFinish;
      }
      if (this.elements.buttons.cancelDrawing) {
        this.elements.buttons.cancelDrawing.disabled = !mode && pointCount === 0;
      }
    }

    selectFeature(feature) {
      this.selected = { kind: "feature", feature };
      const area = feature.coordinates && (feature.type === "polygon" || feature.geometry === "polygon")
        ? polygonAreaSqm(feature.coordinates)
        : 0;
      const pct = this.metrics.fieldArea > 0 && area > 0 ? area / this.metrics.fieldArea * 100 : 0;
      const coordinateText = Number.isFinite(feature.lat) && Number.isFinite(feature.lon)
        ? `<span>座標</span><strong>${feature.lat.toFixed(6)}, ${feature.lon.toFixed(6)}</strong>`
        : "";
      if (!this.elements.selectedSummary || !this.elements.selectedNote) {
        return;
      }
      this.revealSelectedPanel();
      const editable = this.isFeatureEditable(feature);
      this.elements.selectedSummary.classList.remove("is-empty");
      this.elements.selectedSummary.innerHTML = `
        <div class="paddy-detail-grid">
          <span>Type</span><strong>${escapeHtml(feature.type || feature.geometry || "feature")}</strong>
          <span>カテゴリ</span><strong>${escapeHtml(STATUS_LABELS[feature.category || feature.type] || feature.category || feature.type || "不明")}</strong>
          ${area > 0 ? `<span>Area</span><strong>${escapeHtml(formatAreaShort(area))}</strong><span>Field %</span><strong>${escapeHtml(formatPercent(pct))}</strong>` : ""}
          ${coordinateText}
          <span>Notes</span><strong>${editable ? "editable" : "read-only"}</strong>
        </div>
      `;
      this.elements.selectedNote.value = feature.note || "";
      this.elements.selectedNote.disabled = !editable;
      if (this.elements.buttons.saveNote) {
        this.elements.buttons.saveNote.disabled = !editable;
      }
      if (this.elements.gridEditor) {
        this.elements.gridEditor.hidden = true;
      }
    }

    selectGridCell(cell) {
      this.selected = { kind: "grid", cell };
      this.onSelectionChanged?.(this.selected);
      if (this.elements.gridDetail) {
        this.elements.gridDetail.innerHTML = `
        <strong>${escapeHtml(cell.id)}</strong><br>
        面積: ${escapeHtml(formatAreaShort(cell.area_m2))}<br>
        水: ${escapeHtml(cell.waterStatus)} / 稲: ${escapeHtml(cell.plantStatus)}<br>
        雑草: ${escapeHtml(cell.weedStatus)} / 病害虫: ${escapeHtml(cell.pestDiseaseStatus)}<br>
        GNSS点: ${escapeHtml(cell.gnssPointCount || 0)} / 最新: ${escapeHtml(cell.latestGnssTimestamp || "—")}<br>
        状態: ${escapeHtml(formatStatusCounts(cell.gnssStatusCounts))}<br>
        ${escapeHtml(cell.notes || "")}
      `;
      }
      if (!this.elements.selectedSummary || !this.elements.selectedNote) {
        return;
      }
      this.revealSelectedPanel();
      this.elements.selectedSummary.classList.remove("is-empty");
      this.elements.selectedSummary.innerHTML = `
        <div class="paddy-detail-grid">
          <span>Type</span><strong>grid cell</strong>
          <span>Category</span><strong>${escapeHtml(cell.id)}</strong>
          <span>Area</span><strong>${escapeHtml(formatAreaShort(cell.area_m2))}</strong>
          <span>Water</span><strong>${escapeHtml(cell.waterStatus)}</strong>
          <span>Plant</span><strong>${escapeHtml(cell.plantStatus)}</strong>
          <span>GNSS points</span><strong>${escapeHtml(cell.gnssPointCount || 0)}</strong>
          <span>Latest GNSS</span><strong>${escapeHtml(cell.latestGnssTimestamp || "—")}</strong>
          <span>Avg fix</span><strong>${Number.isFinite(cell.averageFixQuality) ? cell.averageFixQuality.toFixed(1) : "—"}</strong>
          <span>Status</span><strong>${escapeHtml(formatStatusCounts(cell.gnssStatusCounts))}</strong>
        </div>
      `;
      this.elements.selectedNote.value = cell.notes || "";
      this.elements.selectedNote.disabled = false;
      if (this.elements.buttons.saveNote) {
        this.elements.buttons.saveNote.disabled = false;
      }
      if (this.elements.gridEditor) {
        this.elements.gridEditor.hidden = false;
      }
      setControlValue(this.elements.gridWaterStatus, cell.waterStatus);
      setControlValue(this.elements.gridPlantStatus, cell.plantStatus);
      setControlValue(this.elements.gridWeedStatus, cell.weedStatus);
      setControlValue(this.elements.gridPestDiseaseStatus, cell.pestDiseaseStatus);
      setControlValue(this.elements.gridNotes, cell.notes || "");
    }

    selectGnssPoint(point) {
      const normalized = this.getNormalizedGnssPoints().find((candidate) => candidate.id === point.id)
        || this.getNormalizedGnssPoints().find((candidate) => candidate.index === point.index)
        || {
          id: point.id || "gnss-point",
          index: point.index || 0,
          lat: Number(point.lat),
          lon: Number(point.lon),
          timestamp: point.timestamp || "",
          fixQuality: Number.isFinite(Number(point.fixQuality)) ? Number(point.fixQuality) : null,
          status: point.augmented ? "DGNSS (method unverified)" : Number.isFinite(Number(point.fixQuality)) ? `fix=${point.fixQuality}` : "unknown"
        };
      const association = this.gnssAssociations.find((item) => item.pointId === normalized.id)
        || this.analyzeSingleGnssPoint(normalized);
      this.selected = { kind: "gnss", point: normalized, association };

      if (!this.elements.selectedSummary || !this.elements.selectedNote) {
        return;
      }
      this.revealSelectedPanel();
      this.elements.selectedSummary.classList.remove("is-empty");
      this.elements.selectedSummary.innerHTML = `
        <div class="paddy-detail-grid">
          <span>Type</span><strong>QZ1/GNSS point</strong>
          <span>Latitude</span><strong>${normalized.lat.toFixed(6)}</strong>
          <span>Longitude</span><strong>${normalized.lon.toFixed(6)}</strong>
          <span>Timestamp</span><strong>${escapeHtml(normalized.timestamp || "—")}</strong>
          <span>Fix / 状態</span><strong>${escapeHtml(normalized.status || "不明")}</strong>
          <span>Field relation</span><strong>${escapeHtml(association.fieldRelation)}</strong>
          <span>Grid cell</span><strong>${escapeHtml(association.gridCellId || "—")}</strong>
        </div>
      `;
      this.elements.selectedNote.value = "";
      this.elements.selectedNote.disabled = true;
      if (this.elements.buttons.saveNote) {
        this.elements.buttons.saveNote.disabled = true;
      }
      if (this.elements.gridEditor) {
        this.elements.gridEditor.hidden = true;
      }
    }

    analyzeSingleGnssPoint(point) {
      const boundary = this.getBoundaryPoints();
      if (boundary.length < 3 || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
        return this.buildGnssAssociation(point, point.index || 0, "no-field-boundary", false, null);
      }

      const thresholdMeters = Math.max(0, numberFromInput(this.elements.inputs.gnssThreshold, 2));
      const projection = createLocalProjection(boundary);
      const pointXY = projection.toXY([point.lat, point.lon]);
      const boundaryXY = boundary.map(projection.toXY);
      const inside = pointInPolygonXY(pointXY, boundaryXY);
      const nearBoundary = distanceToPolygonMeters(pointXY, boundaryXY) <= thresholdMeters;
      const relation = nearBoundary ? "near-boundary" : inside ? "inside-field" : "outside-field";
      const gridCell = (this.elements.layers.grid?.checked ?? false) ? this.findGridCellForPoint(point) : null;
      return this.buildGnssAssociation(point, point.index || 0, relation, nearBoundary, gridCell?.id || null);
    }

    revealSelectedPanel() {
      const details = this.elements.selectedSummary?.closest("details");
      if (details) {
        details.open = true;
      }
    }

    clearSelection() {
      this.selected = null;
      this.updateSelectionUi();
    }

    updateSelectionUi() {
      if (this.selected) {
        return;
      }
      if (this.elements.selectedSummary) {
        this.elements.selectedSummary.classList.add("is-empty");
        this.elements.selectedSummary.textContent = "地図上の解析地物やグリッドセルをクリックすると、種類・カテゴリ・面積・座標・メモを表示します。";
      }
      if (this.elements.selectedNote) {
        this.elements.selectedNote.value = "";
        this.elements.selectedNote.disabled = true;
      }
      if (this.elements.buttons.saveNote) {
        this.elements.buttons.saveNote.disabled = true;
      }
      if (this.elements.gridEditor) {
        this.elements.gridEditor.hidden = true;
      }
    }

    isFeatureEditable(feature) {
      return Boolean(feature?.id && EDITABLE_FEATURE_GROUPS.has(feature.group || feature.type || feature.category));
    }

    saveSelectedNote() {
      if (!this.selected) {
        return;
      }
      if (this.selected.kind === "gnss") {
        return;
      }
      const note = this.elements.selectedNote.value.trim();
      if (this.selected.kind === "grid") {
        this.selected.cell.notes = note;
        this.analysis.gridCellData[this.selected.cell.id] = {
          ...this.analysis.gridCellData[this.selected.cell.id],
          notes: note
        };
        this.selectGridCell(this.selected.cell);
        return;
      }
      const target = this.findFeatureById(this.selected.feature.id);
      if (target) {
        target.note = note;
        this.selected.feature.note = note;
        this.refresh();
        this.selectFeature(this.selected.feature);
      }
    }

    saveSelectedGridCell() {
      if (!this.selected || this.selected.kind !== "grid") {
        return;
      }
      const cell = this.selected.cell;
      const data = {
        waterStatus: this.elements.gridWaterStatus.value,
        plantStatus: this.elements.gridPlantStatus.value,
        weedStatus: this.elements.gridWeedStatus.value,
        pestDiseaseStatus: this.elements.gridPestDiseaseStatus.value,
        notes: this.elements.gridNotes?.value.trim() || ""
      };
      Object.assign(cell, data);
      this.analysis.gridCellData[cell.id] = data;
      this.selectGridCell(cell);
    }

    findFeatureById(id) {
      return [
        this.analysis.waterPolygons,
        this.analysis.plantPolygons,
        this.analysis.problemZones,
        this.analysis.irrigationMarkers,
        this.analysis.obstacles
      ].flat().find((feature) => feature.id === id);
    }

    syncLayerVisibility() {
      Object.entries(this.layers).forEach(([key, layer]) => {
        if (key === "drawing") {
          if (!this.map.hasLayer(layer)) layer.addTo(this.map);
          return;
        }
        const input = this.elements.layers[key];
        const visible = input ? input.checked : true;
        if (visible && !this.map.hasLayer(layer)) {
          layer.addTo(this.map);
        }
        if (!visible && this.map.hasLayer(layer)) {
          this.map.removeLayer(layer);
        }
      });
    }

    fitBoundary() {
      const boundary = this.getBoundaryPoints();
      if (boundary.length >= 3) {
        this.map.fitBounds(L.latLngBounds(boundary), { padding: [48, 48], maxZoom: 17 });
      }
    }

    addWarning(message) {
      if (!this.warningMessages.includes(message)) {
        this.warningMessages.push(message);
      }
    }

    renderWarnings() {
      const droneWarnings = this.warningMessages.filter(isDroneWarning);
      const globalWarnings = this.warningMessages.filter((message) => !isDroneWarning(message));
      if (this.elements.warnings) {
        this.elements.warnings.innerHTML = globalWarnings.map((message) => `<div>${escapeHtml(message)}</div>`).join("");
      }
      if (this.elements.droneWarnings) {
        this.elements.droneWarnings.innerHTML = droneWarnings.map((message) => `<div>${escapeHtml(message)}</div>`).join("");
      }
    }

    setDrawingHint(message) {
      if (this.elements.drawingHint) {
        this.elements.drawingHint.textContent = message;
      }
    }

    renderLegend() {
      if (!this.elements.legend) {
        return;
      }
      const items = [
        ["boundary", "field boundary"],
        ["water", "water surface"],
        ["healthy", "healthy rice"],
        ["weak", "weak rice"],
        ["missing", "missing rice"],
        ["weed", "weed"],
        ["pest", "pest damage"],
        ["disease", "disease damage"],
        ["fertilizer", "fertilizer-deficient"],
        ["bareSoil", "bare soil"],
        ["inlet", "water inlet"],
        ["outlet", "water outlet"],
        ["gate", "water gate"],
        ["drainage", "drainage point"],
        ["tree", "tree"],
        ["pole", "pole"],
        ["building", "building"],
        ["noFlyZone", "no-fly zone"],
        ["drone", "drone flight path"],
        ["grid", "grid"]
      ];
      this.elements.legend.innerHTML = items.map(([key, label]) => {
        const style = STYLES[key] || STYLES.obstacle;
        const marker = MARKER_MODES.has(key) || ["tree", "pole", "building"].includes(key);
        const line = key === "drone" || key === "grid";
        const cssColor = line ? style.color : style.fillColor || style.color;
        const inline = line
          ? `style="border-top:3px ${key === "drone" ? "dashed" : "solid"} ${style.color}; color:${style.color}"`
          : `style="background:${cssColor}; color:${style.color || cssColor}"`;
        return `<span class="paddy-legend-item"><span class="paddy-legend-swatch${marker ? " marker" : ""}${line ? " line" : ""}" ${inline}></span>${escapeHtml(label)}</span>`;
      }).join("");
    }

    buildExportData() {
      const fieldArea = this.metrics.fieldArea || 0;
      const waterDepthCm = numberFromInput(this.elements.inputs.waterDepth, this.analysis.waterDepthCm ?? 5);
      const safeWaterDepthCm = Math.max(0, waterDepthCm);
      const problemAreaByCategory = areaByCategory(this.analysis.problemZones, PROBLEM_CATEGORIES);
      const plantAreaByCategory = areaByCategory(this.analysis.plantPolygons, PLANT_CATEGORIES);
      const vegetation = this.getVegetationExport?.() || {};
      const fieldAnnotation = this.getFieldAnnotationExport?.() || {};
      return {
        schemaVersion: "paddy-intelligence.v1",
        exportedAt: new Date().toISOString(),
        coordinateSystem: "WGS84 latitude/longitude; area and path calculations use a local planar approximation with Turf.js when available.",
        field: {
          boundary: this.getBoundaryPoints(),
          area_m2: fieldArea,
          area_are: fieldArea / 100,
          area_tan: fieldArea / 991.7
        },
        water: {
          polygons: this.analysis.waterPolygons,
          area_m2: this.metrics.waterArea || 0,
          coverage_percent: this.metrics.waterCoveragePct || 0,
          target_depth_cm: safeWaterDepthCm,
          volume_m3: this.metrics.waterVolumeCubicMeters || 0,
          volume_liters: this.metrics.waterVolumeLiters || 0
        },
        plants: {
          zonesByCategory: groupByCategory(this.analysis.plantPolygons),
          areaByCategory_m2: plantAreaByCategory,
          coveragePercent: Object.fromEntries(PLANT_CATEGORIES.map((category) => [category, percent(plantAreaByCategory[category] || 0, fieldArea)]))
        },
        problemZones: {
          zonesByCategory: groupByCategory(this.analysis.problemZones),
          areaByCategory_m2: problemAreaByCategory,
          percentageByCategory: Object.fromEntries(PROBLEM_CATEGORIES.map((category) => [category, percent(problemAreaByCategory[category] || 0, fieldArea)]))
        },
        irrigation: {
          markers: this.analysis.irrigationMarkers
        },
        obstacles: {
          points: this.analysis.obstacles.filter((item) => item.geometry === "point"),
          polygons: this.analysis.obstacles.filter((item) => item.geometry === "polygon" && item.type !== "noFlyZone"),
          noFlyZones: this.analysis.obstacles.filter((item) => item.geometry === "polygon" && item.type === "noFlyZone")
        },
        dronePath: {
          settings: {
            altitude_m: numberFromInput(this.elements.inputs.altitude, 30),
            swathWidth_m: numberFromInput(this.elements.inputs.swathWidth, 10),
            overlap_percent: numberFromInput(this.elements.inputs.overlap, 70),
            flightSpeed_mps: Math.max(0, numberFromInput(this.elements.inputs.speed, 4)),
            pathAngle_degrees: numberFromInput(this.elements.inputs.angle, 0),
            safetyMargin_m: numberFromInput(this.elements.inputs.safetyMargin, 0),
            effectiveLineSpacing_m: this.dronePlan.lineSpacingMeters
          },
          coordinates: this.dronePlan.path,
          lineCount: this.dronePlan.lineCount,
          pathLength_m: this.dronePlan.pathLengthMeters,
          estimatedFlightTime_min: this.dronePlan.estimatedMinutes,
          estimatedPhotoCount: this.dronePlan.estimatedPhotoCount,
          warnings: this.warningMessages.filter(isDroneWarning)
        },
        grid: {
          enabled: this.elements.layers.grid?.checked ?? true,
          gridSize_m: numberFromInput(this.elements.inputs.gridSize, this.analysis.gridSizeMeters ?? 5),
          cells: this.gridCells,
          cellData: this.analysis.gridCellData
        },
        gnssPointSummary: {
          totalPoints: this.gnssSummary.total,
          insideFieldCount: this.gnssSummary.inside,
          outsideFieldCount: this.gnssSummary.outside,
          nearBoundaryCount: this.gnssSummary.nearBoundary,
          nearBoundaryThreshold_m: this.gnssSummary.nearThreshold_m,
          gridEnabled: this.gnssSummary.gridEnabled,
          gridAssociatedPointCount: this.gnssSummary.withGridCell
        },
        gnssPointAssociations: this.gnssAssociations,
        notes: {
          featureNotes: this.collectFeatureNotes()
        },
        // Vegetation Intelligence data is provided by the vegetation
        // controller via an optional hook; older exports simply omit values.
        vegetationObservations: vegetation.vegetationObservations || [],
        vegetationSettings: vegetation.vegetationSettings || {},
        vegetationSummary: vegetation.vegetationSummary || {},
        // Field polygons / water-control points are provided by the field
        // annotation controller via an optional hook; older exports simply
        // omit these keys.
        fields: fieldAnnotation.fields || [],
        waterControlPoints: fieldAnnotation.waterControlPoints || [],
        measurements: fieldAnnotation.measurements || [],
        metadata: fieldAnnotation.metadata || {},
        projectMetadata: {
          projectName: "Suimon Navi Paddy Field Area Intelligence",
          source: "michibiki-suimon-navi browser viewer"
        }
      };
    }

    collectFeatureNotes() {
      return [
        ...this.analysis.waterPolygons,
        ...this.analysis.plantPolygons,
        ...this.analysis.problemZones,
        ...this.analysis.irrigationMarkers,
        ...this.analysis.obstacles,
        ...this.gridCells
      ]
        .filter((item) => item.note || item.notes)
        .map((item) => ({ id: item.id, note: item.note || item.notes }));
    }

    downloadJson() {
      this.refresh();
      const blob = new Blob([JSON.stringify(this.buildExportData(), null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `paddy-field-analysis-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    }

    async importJsonFromInput(event) {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }
      try {
        const data = JSON.parse(await file.text());
        this.importExportedJson(data);
      } catch (error) {
        window.alert(`解析JSONを読み込めませんでした: ${error.message}`);
      } finally {
        event.target.value = "";
      }
    }

    importExportedJson(data) {
      if (data.schemaVersion !== "paddy-intelligence.v1") {
        throw new Error("schemaVersion が paddy-intelligence.v1 ではありません。");
      }
      const obstacles = [
        ...(data.obstacles?.points || []),
        ...(data.obstacles?.polygons || []),
        ...(data.obstacles?.noFlyZones || [])
      ];
      this.analysis = {
        waterDepthCm: data.water?.target_depth_cm ?? 5,
        gridSizeMeters: data.grid?.gridSize_m ?? 5,
        fieldBoundary: data.field?.boundary || [],
        waterPolygons: data.water?.polygons || [],
        plantPolygons: Object.values(data.plants?.zonesByCategory || {}).flat(),
        problemZones: Object.values(data.problemZones?.zonesByCategory || {}).flat(),
        irrigationMarkers: data.irrigation?.markers || [],
        obstacles,
        gridCellData: data.grid?.cellData || {}
      };
      this.setDefaultInputsFromAnalysis();
      if (typeof data.grid?.enabled === "boolean" && this.elements.layers.grid) {
        this.elements.layers.grid.checked = data.grid.enabled;
      }
      setInputValue(this.elements.inputs.gnssThreshold, data.gnssPointSummary?.nearBoundaryThreshold_m);
      if (data.dronePath?.settings) {
        const settings = data.dronePath.settings;
        setInputValue(this.elements.inputs.altitude, settings.altitude_m);
        setInputValue(this.elements.inputs.swathWidth, settings.swathWidth_m);
        setInputValue(this.elements.inputs.overlap, settings.overlap_percent);
        setInputValue(this.elements.inputs.speed, settings.flightSpeed_mps);
        setInputValue(this.elements.inputs.angle, settings.pathAngle_degrees);
        setInputValue(this.elements.inputs.safetyMargin, settings.safetyMargin_m);
      }
      this.clearSelection();
      // Older exports have no vegetation/field-annotation keys; each hook
      // receives the raw data and applies safe defaults, so legacy files
      // still load unchanged.
      this.onVegetationImport?.(data);
      this.onFieldAnnotationImport?.(data);
      this.refresh();
      this.fitBoundary();
      this.addWarning("Imported analysis JSON. Review field boundary and grid cell IDs if it came from another field.");
      this.renderWarnings();
    }
  }

  function emptyDronePlan() {
    return {
      settings: {},
      path: [],
      lineCount: 0,
      lineSpacingMeters: 0,
      pathLengthMeters: 0,
      estimatedMinutes: 0,
      estimatedPhotoCount: 0,
      warningSegments: [],
      warnings: []
    };
  }

  function emptyGnssSummary() {
    return {
      total: 0,
      inside: 0,
      outside: 0,
      nearBoundary: 0,
      nearThreshold_m: 2,
      gridEnabled: false,
      withGridCell: 0,
      message: "QZ1/NMEAまたは測量JSONを読み込むと集計されます。"
    };
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function text(element, value) {
    if (element) {
      element.textContent = value;
    }
  }

  function setInputValue(input, value) {
    if (input && Number.isFinite(Number(value))) {
      input.value = value;
    }
  }

  function setControlValue(input, value) {
    if (input) {
      input.value = value ?? "";
    }
  }

  function numberFromInput(input, fallback) {
    const value = Number.parseFloat(input?.value);
    return Number.isFinite(value) ? value : fallback;
  }

  function roundCoord(value) {
    return Number(value.toFixed(7));
  }

  function polygonAreaSqm(points) {
    if (!Array.isArray(points) || points.length < 3) {
      return 0;
    }
    if (typeof globalThis.turf !== "undefined") {
      try {
        const ring = points.map(([lat, lon]) => [lon, lat]);
        ring.push(ring[0]);
        return turf.area(turf.polygon([ring]));
      } catch {}
    }
    const projection = createLocalProjection(points);
    return Math.abs(polygonAreaXY(points.map(projection.toXY)));
  }

  function polygonAreaXY(points) {
    let sum = 0;
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      sum += a.x * b.y - b.x * a.y;
    }
    return sum / 2;
  }

  function sumPolygonAreas(polygons) {
    return polygons.reduce((sum, zone) => sum + polygonAreaSqm(zone.coordinates), 0);
  }

  function areaByCategory(polygons, categories) {
    return Object.fromEntries(categories.map((category) => [
      category,
      sumPolygonAreas(polygons.filter((zone) => zone.category === category))
    ]));
  }

  function groupByCategory(items) {
    return items.reduce((groups, item) => {
      const category = item.category || item.type || "unknown";
      if (!groups[category]) {
        groups[category] = [];
      }
      groups[category].push(item);
      return groups;
    }, {});
  }

  function percent(part, whole) {
    return whole > 0 ? part / whole * 100 : 0;
  }

  function isDroneWarning(message) {
    return /drone|flight|fly|no-fly|swath|overlap|speed|safety margin|path/i.test(message);
  }

  function formatAreaFull(area) {
    if (!Number.isFinite(area) || area <= 0) {
      return "—";
    }
    return `${Math.round(area).toLocaleString()} m² / ${(area / 100).toFixed(2)} a / ${(area / 991.7).toFixed(2)} tan`;
  }

  function formatAreaShort(area) {
    if (!Number.isFinite(area) || area <= 0) {
      return "0 m²";
    }
    return `${Math.round(area).toLocaleString()} m²`;
  }

  function formatPercent(value) {
    if (!Number.isFinite(value)) {
      return "—";
    }
    return `${value.toFixed(1)}%`;
  }

  function formatMeters(value) {
    if (!Number.isFinite(value)) {
      return "N/A";
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} m`;
  }

  function formatStatusCounts(counts) {
    const entries = Object.entries(counts || {});
    if (entries.length === 0) {
      return "—";
    }
    return entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([status, count]) => `${status}: ${count}`)
      .join(", ");
  }

  function latestTimestampLabel(current, next) {
    if (!current) {
      return next;
    }
    if (!next) {
      return current;
    }
    const currentTime = Date.parse(current);
    const nextTime = Date.parse(next);
    if (Number.isFinite(currentTime) && Number.isFinite(nextTime)) {
      return nextTime >= currentTime ? next : current;
    }
    return String(next) >= String(current) ? next : current;
  }

  function createLocalProjection(points) {
    const origin = points[0] || [34.6545, 135.8302];
    const originLat = origin[0];
    const originLon = origin[1];
    const metersPerDegreeLat = 111320;
    const metersPerDegreeLon = 111320 * Math.cos(originLat * Math.PI / 180);
    return {
      toXY: ([lat, lon]) => ({
        x: (lon - originLon) * metersPerDegreeLon,
        y: (lat - originLat) * metersPerDegreeLat
      }),
      toLatLng: ({ x, y }) => [
        originLat + y / metersPerDegreeLat,
        originLon + x / metersPerDegreeLon
      ]
    };
  }

  function createRotatedTransformer(projection, angleDegrees) {
    const angle = -angleDegrees * Math.PI / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const inverseCos = Math.cos(-angle);
    const inverseSin = Math.sin(-angle);
    return {
      toScan(latLng) {
        const point = projection.toXY(latLng);
        return {
          x: point.x * cos - point.y * sin,
          y: point.x * sin + point.y * cos
        };
      },
      toLatLng(point) {
        return projection.toLatLng({
          x: point.x * inverseCos - point.y * inverseSin,
          y: point.x * inverseSin + point.y * inverseCos
        });
      }
    };
  }

  function inwardOffsetPolygon(points, margin) {
    if (margin <= 0) {
      return points;
    }
    const centroid = points.reduce((sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }), { x: 0, y: 0 });
    return points.map((point) => {
      const dx = point.x - centroid.x;
      const dy = point.y - centroid.y;
      const distance = Math.hypot(dx, dy);
      const nextDistance = Math.max(0, distance - margin);
      const scale = distance > 0 ? nextDistance / distance : 1;
      return { x: centroid.x + dx * scale, y: centroid.y + dy * scale };
    });
  }

  function polygonIntersectionsAtY(points, y) {
    const xs = [];
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
        const ratio = (y - a.y) / (b.y - a.y);
        xs.push(a.x + ratio * (b.x - a.x));
      }
    }
    xs.sort((a, b) => a - b);
    const intervals = [];
    for (let i = 0; i + 1 < xs.length; i += 2) {
      intervals.push([xs[i], xs[i + 1]]);
    }
    return intervals;
  }

  function subtractIntervals(sourceIntervals, blockedIntervals) {
    let open = sourceIntervals.map(([start, end]) => [start, end]);
    blockedIntervals.forEach(([blockedStart, blockedEnd]) => {
      open = open.flatMap(([start, end]) => {
        if (blockedEnd <= start || blockedStart >= end) {
          return [[start, end]];
        }
        const pieces = [];
        if (blockedStart > start) {
          pieces.push([start, Math.min(blockedStart, end)]);
        }
        if (blockedEnd < end) {
          pieces.push([Math.max(blockedEnd, start), end]);
        }
        return pieces;
      });
    });
    return open.filter(([start, end]) => end - start > 1);
  }

  function pointInPolygonXY(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
      const a = polygon[i];
      const b = polygon[j];
      const intersects = ((a.y > point.y) !== (b.y > point.y))
        && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x;
      if (intersects) {
        inside = !inside;
      }
    }
    return inside;
  }

  function distanceToPolygonMeters(point, polygon) {
    if (!Array.isArray(polygon) || polygon.length < 2) {
      return Infinity;
    }
    let shortest = Infinity;
    for (let i = 0; i < polygon.length; i += 1) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      shortest = Math.min(shortest, distancePointToSegmentMeters(point, a, b));
    }
    return shortest;
  }

  function distancePointToSegmentMeters(point, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) {
      return Math.hypot(point.x - a.x, point.y - a.y);
    }
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
    return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
  }

  function polygonCentroidXY(points) {
    if (!Array.isArray(points) || points.length === 0) {
      return { x: 0, y: 0 };
    }
    const total = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
    return { x: total.x / points.length, y: total.y / points.length };
  }

  function lineIntersectsPolygonXY(a, b, polygon) {
    if (pointInPolygonXY(a, polygon) || pointInPolygonXY(b, polygon)) {
      return true;
    }
    for (let i = 0; i < polygon.length; i += 1) {
      const c = polygon[i];
      const d = polygon[(i + 1) % polygon.length];
      if (segmentsIntersect(a, b, c, d)) {
        return true;
      }
    }
    return false;
  }

  function segmentsIntersect(a, b, c, d) {
    const ccw = (p1, p2, p3) => (p3.y - p1.y) * (p2.x - p1.x) > (p2.y - p1.y) * (p3.x - p1.x);
    return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
  }

  function pathLengthMeters(path) {
    let length = 0;
    for (let i = 1; i < path.length; i += 1) {
      length += distanceMeters(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
    }
    return length;
  }

  function distanceMeters(lat1, lon1, lat2, lon2) {
    const earthRadiusMeters = 6371000;
    const toRadians = (degrees) => degrees * Math.PI / 180;
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[char]));
  }

  window.PaddyFieldIntelligence = PaddyFieldIntelligence;
  window.PaddyFieldIntelligenceUtils = { polygonAreaSqm, formatAreaFull };
}());
