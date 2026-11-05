import * as d3 from "d3";
import {icon} from '../../ui/icons.js';
// ============================================================================
// GRAPH RENDERER - D3.js visualization of reactions graph
// ============================================================================

import { CONFIG } from "../config/config.js";
import { UIHelper } from "../ui/UIHelper.js";
import {allowGraphGesture} from './viewport.js';
import { getSharedShortcutManager, formatCombo } from "../core/ShortcutManager.js";
import { getForcePreset, loadForcePresetId, saveForcePresetId, alphaDecayFor, clampSettleSeconds, loadSettleSeconds, saveSettleSeconds } from "./forcePresets.js";
import { getSnapGrid, loadSnapGridId, saveSnapGridId, loadSnapEnabled, saveSnapEnabled, loadSnapScale, saveSnapScale, clampScale, snapAll, nearestFreeCell, occupiedCells, forEachLatticePointInView, latticeTooDense } from "./gridSnap.js";

export class GraphRenderer {
  static DOUBLE_CLICK_DELAY = 300;

  // Node interactions go through a ShortcutManager (core/ShortcutManager.js); the app-wide one is
  // used when none is given. onQuickAddSet(materialId, role) enables the "add to a new set"
  // actions; without it those shortcuts do nothing (classic mode has no sets).
  constructor(dataRepo, state, graphDataBuilder, shortcutManager = null, onQuickAddSet = null) {
    this.dataRepo = dataRepo;
    this.state = state;
    this.graphDataBuilder = graphDataBuilder;
    this.shortcutManager = shortcutManager ?? getSharedShortcutManager();
    this.onQuickAddSet = onQuickAddSet;
    // onExcludeReactions(reactions) enables "Exclude" in reaction menus (advanced mode sets it).
    this.onExcludeReactions = null;
    this.forcePresetId = loadForcePresetId();
    this.settleSeconds = loadSettleSeconds();
    this.snapGridId = loadSnapGridId();
    this.snapEnabled = loadSnapEnabled();
    this.snapScale = loadSnapScale();
    this._snapTimer = null;
    this._pendingClick = null; // single-click action waiting to see if a double-click follows
    // Tag tooltips mention the menu shortcut: refresh them when it is rebound.
    this._unsubscribeShortcuts = this.shortcutManager.subscribe(() => this._nodeSelection?.filter((d) => d.type === "tag").each((d, i, els) => this._updateTagNode(d, d3.select(els[i]))));
    this.currentCleanup = null;

    // Persistent rendering state, kept alive across render() calls. Previously every render()
    // wiped the container and rebuilt the SVG/simulation from scratch, which made the whole
    // graph visibly "reload" (a fresh force-layout jump, and a reset zoom/pan) on every change,
    // even a trivial one like toggling a set's/group's "enabled" checkbox. Now, as long as the
    // same SVG is still mounted, render() reuses it: nodes/links that are still present just
    // keep their existing DOM element and simulated position (via D3's keyed .join()), and only
    // whatever actually entered or left the visible set is created or removed.
    this._svg = null;
    this._g = null;
    this._simulation = null;
    this._linkGroupSelection = null;
    this._nodeSelection = null;
    this._nodesById = new Map(); // id -> live simulation datum, carries x/y/vx/vy across renders
    this._selectedIds = new Set(); // multi-selection (rectangle on the background), by node id
    this._resizeHandler = null;
  }

  render(filteredReactions) {
    const container = document.getElementById("graphContainer");

    if (filteredReactions.length === 0 || filteredReactions.length >= CONFIG.graph.constraints.maxReactions) {
      this._teardown(container);
      container.innerHTML =
        filteredReactions.length === 0
          ? `<div style="text-align: center; padding: 2rem; color: ${CONFIG.graph.colors.textLight};">No reactions found with current filters</div>`
          : `<div style="text-align: center; padding: 2rem; color: ${CONFIG.graph.colors.textLight};">Too many reactions with current filters</div>`;
      return;
    }

    const width = container.clientWidth;
    const height = Math.max(1, container.clientHeight);

    const { nodes, links } = this.graphDataBuilder.buildGraphData(filteredReactions);
    const nodeArray = Array.from(nodes.values());
    const linkArray = links.map((link) => ({
      ...link,
      source: nodes.get(link.source),
      target: nodes.get(link.target),
    }));

    let visibleNodes = this.graphDataBuilder.filterVisibleNodes(nodeArray, this.state);

    // Add directly involved materials
    visibleNodes = nodeArray.filter((node) => {
      if (visibleNodes.includes(node)) return true;
      if (node.type === "material" && node.isTagMaterial) {
        return this._isMaterialDirectlyInvolved(node.id, linkArray);
      }
      return false;
    });

    const visibleLinks = this.graphDataBuilder.filterVisibleLinks(linkArray, visibleNodes);
    // Visible degree, read by the force presets (link strength, degree-scaled repulsion). Set
    // before the simulation sees the nodes, since d3 evaluates strengths when nodes are assigned.
    visibleNodes.forEach((node) => (node.degree = 0));
    visibleLinks.forEach(({ source, target }) => {
      source.degree += 1;
      target.degree += 1;
    });

    // Carry over position/velocity from whatever is already on screen, keyed by node id, so a
    // node that persists across this update does not jump; only genuinely new nodes get a fresh
    // starting position from the simulation.
    visibleNodes.forEach((node) => {
      const previous = this._nodesById.get(node.id);
      if (previous) {
        node.x = previous.x;
        node.y = previous.y;
        node.vx = previous.vx;
        node.vy = previous.vy;
        node.fx = previous.fx;
        node.fy = previous.fy;
        node.pinned = previous.pinned;
      }
    });
    const newCount = visibleNodes.filter((node) => !this._nodesById.has(node.id)).length;
    this._placeNewNodesNearNeighbors(visibleNodes, visibleLinks);
    this._nodesById = new Map(visibleNodes.map((node) => [node.id, node]));

    const isMounted = this._svg && container.contains(this._svg.node());
    if (!isMounted) {
      this._fullSetup(container, width, height, visibleNodes, visibleLinks, linkArray);
    } else {
      this._incrementalUpdate(visibleNodes, visibleLinks, linkArray, width, height, newCount);
    }
  }

  // A new node starts next to an already placed neighbor (a tag's materials around the tag, a
  // new reaction next to its reagents) instead of at d3's default spot around the origin, far from
  // everything: the layout then only has to settle it locally. Several passes, so chains of new
  // nodes (reaction -> new tag -> its new materials) are placed outward from what exists.
  _placeNewNodesNearNeighbors(visibleNodes, visibleLinks) {
    const neighbors = new Map(visibleNodes.map((node) => [node, []]));
    visibleLinks.forEach(({ source, target }) => {
      neighbors.get(source)?.push(target);
      neighbors.get(target)?.push(source);
    });
    const placed = new Set(visibleNodes.filter((node) => Number.isFinite(node.x)));
    if (placed.size === 0) return;
    const spread = getForcePreset(this.forcePresetId).linkDistance * 0.6;
    for (let pass = 0; pass < 4; pass++) {
      const placedThisPass = [];
      visibleNodes.forEach((node) => {
        if (placed.has(node)) return;
        const anchor = neighbors.get(node).find((n) => placed.has(n));
        if (!anchor) return;
        const angle = Math.random() * 2 * Math.PI;
        node.x = anchor.x + Math.cos(angle) * spread;
        node.y = anchor.y + Math.sin(angle) * spread;
        placedThisPass.push(node);
      });
      if (placedThisPass.length === 0) break;
      placedThisPass.forEach((node) => placed.add(node));
    }
  }

  // Runs fn() with the graph in its plain, un-highlighted look, then restores the current
  // highlight. Everything happens synchronously, so the intermediate state is never painted.
  withoutHighlight(fn) {
    const highlight = this._highlight;
    if (!highlight) return fn();
    this._resetHighlighting(highlight.allNodes);
    try {
      return fn();
    } finally {
      this._highlightConnections(highlight.node, highlight.allNodes, highlight.linkArray);
    }
  }

  // Stops listening to shortcut changes. Call when the renderer is discarded.
  dispose() {
    this._cancelPendingClick();
    this._unsubscribeShortcuts?.();
    this._unsubscribeShortcuts = null;
  }

  // Fully tears down any existing graph (used before showing an empty/too-many-reactions message,
  // and internally before a from-scratch setup).
  _teardown() {
    this._cancelPendingClick();
    this._highlight = null;
    if (this._resizeHandler) {
      window.removeEventListener("resize", this._resizeHandler);
      this._resizeHandler = null;
    }
    if (this.currentCleanup) {
      this.currentCleanup();
      this.currentCleanup = null;
    }
    this._svg = null;
    this._g = null;
    this._simulation = null;
    this._linkGroupSelection = null;
    this._nodeSelection = null;
    this._nodesById = new Map();
  }

  // Builds the SVG/simulation from scratch. Only needed on the very first render, or after
  // recovering from an empty/too-many-reactions state (which clears the container). Does NOT
  // touch this._nodesById - render() already set it to the correct value for this call right
  // before invoking this method; clearing it here would defeat position carry-over on the very
  // first incremental update right after a fresh setup.
  _fullSetup(container, width, height, visibleNodes, visibleLinks, linkArray) {
    if (this._resizeHandler) {
      window.removeEventListener("resize", this._resizeHandler);
      this._resizeHandler = null;
    }
    if (this.currentCleanup) {
      this.currentCleanup();
      this.currentCleanup = null;
    }
    this._svg = null;
    this._g = null;
    this._simulation = null;
    this._linkGroupSelection = null;
    this._nodeSelection = null;

    container.innerHTML = "";

    const { svg, g } = this._createSVG(container, width, height);
    this._createArrowMarkers(svg);
    this._svg = svg;
    this._g = g;

    this._simulation = this._createSimulation(visibleNodes, visibleLinks, width, height);
    this._linkGroupSelection = this._joinLinks(g, visibleLinks);
    this._nodeSelection = this._joinNodes(g, visibleNodes, linkArray);

    this._simulation.on("tick", () => this._onTick());
    // Snap once the layout has settled (initial layout, preset change, new nodes coming in): as
    // soon as it looks settled (CONFIG.graph.snapAlpha), or when d3 stops on its own.
    this._simulation.on("tick.snap", () => {
      if (this._snapGrid() && this._simulation.alpha() < CONFIG.graph.snapAlpha) {
        this._simulation.stop();
        this._snapToGrid();
      } else {
        this._setSnapGridSuspended(!!this._snapGrid());
      }
    });
    this._simulation.on("end.snap", () => this._snapToGrid());
    this._configureGridForce();
    this._drawSnapGrid();
    if (this._snapGrid()) this._relayout(1);
    // Force layout math (d3-force's timer) schedules its first tick asynchronously, so without
    // this, freshly joined elements would sit with no position at all for a brief moment. Paint
    // the current state immediately instead of waiting for that first async tick.
    this._onTick();

    this._resizeHandler = () => this._handleResize(container, this._svg, this._simulation);
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(this._resizeHandler) : null;
    resizeObserver?.observe(container);
    window.addEventListener("resize", this._resizeHandler);

    this.currentCleanup = () => {
      if (this._resizeHandler) window.removeEventListener("resize", this._resizeHandler);
      resizeObserver?.disconnect();
      this._simulation?.stop();
      this._stopSnapAnimation();
      if (this._selectionKeyHandler) document.removeEventListener("keydown", this._selectionKeyHandler);
    };
  }

  // Reuses the existing SVG/simulation: joins the new node/link data against what is already on
  // screen (keyed by id), so unaffected nodes/links are left completely untouched, and only the
  // difference is created or removed. A gentle reheat lets the simulation settle the change in
  // without a full, disruptive re-layout.
  _incrementalUpdate(visibleNodes, visibleLinks, linkArray, width, height, newCount = 0) {
    // The SVG's own size no longer gets recomputed for free on every render now that it isn't
    // rebuilt from scratch each time (previously any render implicitly refreshed it); the
    // container can resize for reasons other than a window resize event (e.g. the side panel
    // being hidden), so keep it in sync explicitly here too.
    this._svg.attr("width", width).attr("height", height).attr("viewBox", [0, 0, width, height]);
    this._drawSnapGrid();

    this._linkGroupSelection = this._joinLinks(this._g, visibleLinks);
    this._nodeSelection = this._joinNodes(this._g, visibleNodes, linkArray);

    const fresh = visibleNodes.filter((node) => !Number.isFinite(node.x));
    this._simulation.nodes(visibleNodes);
    if (this._noSettling()) this._centerFreshNodes(fresh, width, height);
    this._simulation.force("link").links(visibleLinks);
    this._setCenterForces(this._simulation, width, height);
    // A snap animation in flight would fight the new layout; _relayout() settles everything and,
    // with a grid, snaps it back.
    if (this._snapGrid()) this._stopSnapAnimation();
    // Mostly new nodes (e.g. a saved config loaded): a gentle reheat can't untangle that, so
    // lay it out from scratch, untangle phase included.
    if (newCount > visibleNodes.length / 2) {
      this._applyForcePreset(this._simulation, width, height);
      this._relayout(1);
    } else {
      this._relayout(0.4);
    }

    // Same reasoning as in _fullSetup: paint immediately with whatever positions are already
    // known (carried-over ones for persisting nodes, computed defaults for new ones) instead of
    // waiting for the simulation's next async tick, which is what made persisting links in
    // particular look like they were lagging a step behind their nodes.
    this._onTick();
  }

  _onTick() {
    this._linkGroupSelection
      .selectAll("line")
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);

    this._nodeSelection.attr("transform", (d) => `translate(${d.x},${d.y})`);
  }

  _isMaterialDirectlyInvolved(materialId, linkArray) {
    return linkArray.some(
      (link) =>
        (link.source.id === materialId && link.target.type === "reaction" && link.type === "input") ||
        (link.target.id === materialId && link.source.type === "reaction" && link.type === "output"),
    );
  }

  _createSVG(container, width, height) {
    const wrapper = document.createElement("div");
    wrapper.style.cssText = "width:100%;height:100%;overflow:hidden;position:relative;";
    container.appendChild(wrapper);

    // Grid snapping backdrop: a canvas under the SVG drawing every visible lattice point, from the
    // grid's own coordinates and the current zoom. (An SVG <pattern> drifted away from the real
    // lattice: browsers rasterize pattern tiles at rounded sizes, so the error piles up tile after
    // tile.) Outside the SVG, it is never part of an export.
    const gridCanvas = document.createElement("canvas");
    gridCanvas.className = "snap-grid";
    gridCanvas.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;";
    wrapper.appendChild(gridCanvas);
    this._gridCanvas = gridCanvas;
    this._gridContext = undefined; // fetched on first draw, per canvas
    this._zoomTransform = d3.zoomIdentity;

    const svg = d3
      .select(wrapper)
      .append("svg")
      .attr("width", width)
      .attr("height", height)
      .attr("viewBox", [0, 0, width, height])
      .attr("preserveAspectRatio", "none")
      .style("position", "absolute")
      .style("left", 0)
      .style("top", 0);

    const g = svg.append("g");

    const zoom = d3
      .zoom()
      .extent(() => [[0, 0], [Math.max(1, container.clientWidth), Math.max(1, container.clientHeight)]])
      .filter(event => allowGraphGesture(event, container))
      .scaleExtent([0.1, 4])
      .on("zoom", (event) => {
        g.attr("transform", event.transform);
        this._zoomTransform = event.transform;
        this._scheduleSnapGridDraw();
      });

    svg.call(zoom);
    this._zoom = zoom;
    svg.on("click", () => this._resetHighlighting(d3.selectAll(".node")));
    // Right button drags pan the view (see allowGraphGesture): no browser menu on the background.
    // Nodes keep theirs (or their own actions menu).
    svg.on("contextmenu.pan", (event) => {
      if (!event.target.closest?.(".node")) event.preventDefault();
    });
    this._setupSelectionRectangle(svg);

    return { svg, g };
  }

  _createArrowMarkers(svg) {
    const defs = svg.append("defs");

    [
      { id: "arrow-input", color: CONFIG.graph.colors.inputArrow },
      { id: "arrow-output", color: CONFIG.graph.colors.outputArrow },
    ].forEach(({ id, color }) => {
      defs
        .append("marker")
        .attr("id", id)
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", CONFIG.graph.sizes.materialRadius)
        .attr("refY", 0)
        .attr("markerWidth", 8)
        .attr("markerHeight", 8)
        .attr("orient", "auto")
        .append("path")
        .attr("d", "M0,-5L10,0L0,5")
        .attr("fill", color);
    });
  }

  // Uses a keyed .join(): links present in both the previous and new data keep their existing
  // DOM (nothing to update - a link's appearance is fully determined by its stable "type"), new
  // links are created, and links no longer present are removed.
  _joinLinks(g, visibleLinks) {
    let linksContainer = g.select(":scope > g.links");
    if (linksContainer.empty()) {
      linksContainer = g.append("g").attr("class", "links");
    }

    const linkKey = (d) => `${d.source.id}--${d.target.id}--${d.type}`;

    const linkGroups = linksContainer
      .selectAll(":scope > g.link-group")
      .data(visibleLinks, linkKey)
      .join(
        (enter) => {
          const entered = enter
            .append("g")
            .attr("class", (d) => `link-group ${d.type}-link`)
            .style("opacity", (d) =>
              d.type === "tag-association" ? CONFIG.graph.opacities.tagAssociation : CONFIG.graph.opacities.linkDefault,
            );

          entered
            .append("line")
            .attr("stroke", (d) => {
              if (d.type === "input") return CONFIG.graph.colors.inputArrow;
              if (d.type === "output") return CONFIG.graph.colors.outputArrow;
              if (d.type === "tag-association") return CONFIG.graph.colors.tagAssociation;
              return "#ccc";
            })
            .attr("stroke-width", (d) =>
              d.type === "tag-association" ? CONFIG.graph.sizes.strokeWidth - 1 : CONFIG.graph.sizes.strokeWidth,
            )
            .attr("stroke-dasharray", (d) => (d.type === "input" ? "5,5" : null))
            .attr("marker-end", (d) => {
              if (d.type === "input") return "url(#arrow-input)";
              if (d.type === "output") return "url(#arrow-output)";
              return null;
            });

          return entered;
        },
        (update) => update,
        (exit) => exit.remove(),
      );

    // The keyed join above correctly refreshes each <g>'s own bound datum (including a
    // persisting link's up-to-date source/target node references), but a child <line>'s
    // __data__ is captured once at creation time and does not automatically track later rebinds
    // of its parent. Left alone, a persisting link would keep reading its ORIGINAL source/target
    // object references forever - and since GraphDataBuilder builds fresh node objects on every
    // render, those original references are no longer the ones the simulation is actually
    // ticking, so the line visually freezes in place while its nodes keep moving. Explicitly
    // re-propagating the parent's current datum onto the <line> here (once per render, not per
    // tick) keeps _onTick's efficient batched selectAll("line") reading correct, live data.
    linkGroups.each(function (d) {
      d3.select(this).select("line").datum(d);
    });

    return linkGroups;
  }

  _createSimulation(visibleNodes, visibleLinks, width, height) {
    const fresh = visibleNodes.filter((node) => !Number.isFinite(node.x));
    const simulation = d3
      .forceSimulation(visibleNodes)
      .force("link", d3.forceLink(visibleLinks).id((d) => d.id))
      .force("charge", d3.forceManyBody())
      .force("collision", d3.forceCollide());
    this._applyForcePreset(simulation, width, height);
    if (this._noSettling()) {
      simulation.stop();
      this._centerFreshNodes(fresh, width, height);
    }
    return simulation;
  }

  // Settling time 0: the simulation never runs (see SETTLE_SECONDS).
  _noSettling() {
    return this.settleSeconds === 0;
  }

  // d3 seeds unpositioned nodes on a spiral around the origin (the top-left corner) and relies on
  // the simulation to bring them in; with no settling, put that spiral in the middle of the view.
  _centerFreshNodes(nodes, width, height) {
    nodes.forEach((node) => {
      node.x += width / 2;
      node.y += height / 2;
    });
  }

  // Wakes the simulation up to `alpha` - unless there is no settling, then only repaints.
  _reheat(alpha) {
    const simulation = this._simulation;
    if (!simulation) return;
    if (this._noSettling()) {
      simulation.stop();
      this._onTick();
      return;
    }
    simulation.alpha(Math.max(simulation.alpha(), alpha)).restart();
  }

  // Configures every force from the active preset (CONFIG.graph.forcePresets) and arms the
  // untangle -> compact phase switch. Only a fresh layout (initial render, preset change)
  // untangles; later reheats (incremental updates, drag, resize) keep the compact repulsion so
  // existing nodes don't get blown apart again.
  _applyForcePreset(simulation, width, height) {
    const f = getForcePreset(this.forcePresetId);
    const link = simulation.force("link").distance(f.linkDistance);
    // A null strength keeps d3's default: 1 / degree of the less connected end.
    link.strength((l) => {
      const strength = l.type === "tag-association" ? f.tagLinkStrength : f.linkStrength;
      return strength ?? 1 / Math.min(l.source.degree || 1, l.target.degree || 1);
    });
    const charge = (base) => (d) => base * (1 + (f.degreeCharge || 0) * (Math.sqrt(d.degree || 1) - 1));
    simulation.force("charge").strength(charge(f.untangleCharge)).distanceMax(f.chargeDistanceMax);
    simulation.force("collision").radius((d) => d.radius + f.collisionPadding);
    simulation.alphaDecay(alphaDecayFor(this.settleSeconds));
    this._setCenterForces(simulation, width, height);

    // Kept as a method (not only a tick listener) because _relayout() ticks by hand, and manual
    // simulation.tick() calls dispatch no "tick" event.
    let compact = !(f.compactAlpha > 0);
    if (compact) simulation.force("charge").strength(charge(f.compactCharge));
    this._checkLayoutPhase = () => {
      if (compact || simulation.alpha() >= f.compactAlpha) return;
      compact = true;
      simulation.force("charge").strength(charge(f.compactCharge));
    };
    simulation.on("tick.phase", () => this._checkLayoutPhase());
    if (simulation === this._simulation) this._configureGridForce();
  }

  // Reheats the layout to `alpha`. With a grid, nodes end up on it anyway, so watching them
  // settle frame by frame is only a wait: the settling is computed at once (no frames drawn) and
  // nodes glide straight from where they are to their cell.
  _relayout(alpha) {
    const simulation = this._simulation;
    if (this._noSettling()) {
      simulation.stop();
      if (this._snapGrid()) this._snapToGrid();
      else this._onTick();
      return;
    }
    simulation.alpha(alpha);
    if (!this._snapGrid()) {
      simulation.restart();
      return;
    }
    simulation.stop();
    const starts = new Map(simulation.nodes().map((node) => [node, { x: node.x, y: node.y }]));
    for (let i = 0; i < 1000 && simulation.alpha() >= CONFIG.graph.snapAlpha; i++) {
      simulation.tick();
      this._checkLayoutPhase();
    }
    this._snapToGrid(starts);
  }

  // Changes how long layouts take to settle (seconds, see SETTLE_SECONDS). Applies to the layout
  // in progress right away, and to every later one.
  setSettleSeconds(seconds) {
    const wasStatic = this._noSettling();
    this.settleSeconds = clampSettleSeconds(seconds);
    saveSettleSeconds(this.settleSeconds);
    if (!this._simulation) return;
    this._simulation.alphaDecay(alphaDecayFor(this.settleSeconds));
    if (this._noSettling()) this._simulation.stop();
    else if (wasStatic) this._relayout(0.5); // settling back on: let the layout balance itself
  }

  // Zooms/pans so the whole graph fits the view (labels included), centered: the "Recenter"
  // button. Never zooms in past 100%, so a small graph is centered rather than blown up.
  fitToView({ duration = 400, padding = 40 } = {}) {
    const nodes = this._simulation?.nodes() ?? [];
    if (!this._svg || !this._zoom || nodes.length === 0) return;
    const width = Number(this._svg.attr("width")) || 1;
    const height = Number(this._svg.attr("height")) || 1;
    const labelRoom = CONFIG.graph.layout.labelOffsetMaterial + 12; // label under the node
    const x0 = d3.min(nodes, (n) => n.x - n.radius), x1 = d3.max(nodes, (n) => n.x + n.radius);
    const y0 = d3.min(nodes, (n) => n.y - n.radius), y1 = d3.max(nodes, (n) => n.y + n.radius + labelRoom);
    const [minScale, maxScale] = this._zoom.scaleExtent();
    const fit = Math.min((width - 2 * padding) / Math.max(1, x1 - x0), (height - 2 * padding) / Math.max(1, y1 - y0));
    const k = Math.max(minScale, Math.min(1, maxScale, fit));
    const transform = d3.zoomIdentity.translate(width / 2 - k * (x0 + x1) / 2, height / 2 - k * (y0 + y1) / 2).scale(k);
    const target = duration > 0 ? this._svg.transition().duration(duration) : this._svg;
    target.call(this._zoom.transform, transform);
  }

  // Switches the force preset and lays the current graph out again with it.
  setForcePreset(id) {
    this.forcePresetId = id;
    saveForcePresetId(id);
    if (!this._simulation || !this._svg) return;
    this._stopSnapAnimation();
    this._releaseUnpinned(this._simulation.nodes());
    this._applyForcePreset(this._simulation, Number(this._svg.attr("width")), Number(this._svg.attr("height")));
    this._relayout(1);
  }

  // Switches the grid kind (a CONFIG.graph.snapGrids id); applied right away if snapping is on.
  setSnapGrid(id) {
    this.snapGridId = id;
    saveSnapGridId(id);
    this._applySnapChange();
  }

  // Grid snapping on/off (the grid kind is kept either way).
  setSnapEnabled(enabled) {
    this.snapEnabled = !!enabled;
    saveSnapEnabled(this.snapEnabled);
    this._applySnapChange();
  }

  // Snapping on (or a different grid): snap the current positions right away. Off: release every
  // node (but those pinned on purpose) to the simulation again.
  _applySnapChange() {
    this._drawSnapGrid();
    if (!this._simulation) return;
    this._stopSnapAnimation();
    this._releaseUnpinned(this._simulation.nodes());
    this._configureGridForce();
    if (this._snapGrid()) this._snapToGrid();
    else this._reheat(0.3);
  }

  // Grid force: pulls each free node toward its own cell, so the layout settles onto the grid
  // while gravity and links keep acting (a grid with no physics at all = settling time 0). Cells are re-assigned every few ticks from
  // current positions (one node per cell; pinned nodes hold theirs).
  _configureGridForce() {
    if (!this._simulation) return;
    const grid = this._snapGrid();
    if (!grid) {
      this._simulation.force("grid", null);
      return;
    }
    const strength = CONFIG.graph.snapPhysicsStrength;
    let nodes = [];
    let targets = null;
    let ticks = 0;
    const force = (alpha) => {
      if (!targets || ticks++ % 10 === 0) {
        targets = snapAll(nodes, grid, { keep: new Set(nodes.filter((node) => node.fx != null)) });
      }
      targets.forEach((target, node) => {
        if (node.fx != null) return;
        node.vx += (target.x - node.x) * strength * alpha;
        node.vy += (target.y - node.y) * strength * alpha;
      });
    };
    force.initialize = (simulationNodes) => {
      nodes = simulationNodes;
      targets = null;
    };
    this._simulation.force("grid", force);
  }

  // Changes the grid size (percentage of the configured spacing, see SNAP_SCALE) and re-snaps
  // every node onto the resized grid from where it is now.
  setSnapScale(scale) {
    this.snapScale = clampScale(scale);
    saveSnapScale(this.snapScale);
    this._drawSnapGrid();
    this._configureGridForce();
    if (!this._simulation || !this._snapGrid()) return;
    this._stopSnapAnimation();
    this._releaseUnpinned(this._simulation.nodes());
    this._snapToGrid();
  }

  _snapGrid() {
    return this.snapEnabled ? getSnapGrid(this.snapGridId, this.snapScale) : null;
  }

  // ---------------------------------------------------------------------
  // Multi-selection
  // ---------------------------------------------------------------------

  // Left-dragging the background draws a selection rectangle; on release the nodes inside become
  // the selection (Shift: added to it). A plain left click on the background (no drag) clears
  // it, as does Escape. Mouse events, so jsdom can drive it; touch keeps panning.
  _setupSelectionRectangle(svg) {
    let start = null;
    let rect = null;
    const point = (event) => d3.pointer(event, svg.node());
    const move = (event) => {
      if (!start) return;
      const [x, y] = point(event);
      if (!rect && Math.hypot(x - start.x, y - start.y) < 4) return;
      rect ??= svg.append("rect").attr("class", "selection-rectangle")
        .attr("fill", "rgba(255,255,0,0.08)").attr("stroke", CONFIG.graph.colors.selectedHighlight)
        .attr("stroke-dasharray", "4,3").style("pointer-events", "none");
      rect.attr("x", Math.min(x, start.x)).attr("y", Math.min(y, start.y))
        .attr("width", Math.abs(x - start.x)).attr("height", Math.abs(y - start.y));
    };
    const up = (event) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (!start) return;
      const [x, y] = point(event);
      const additive = start.additive;
      const dragged = !!rect;
      rect?.remove();
      rect = null;
      const box = { x0: Math.min(x, start.x), x1: Math.max(x, start.x), y0: Math.min(y, start.y), y1: Math.max(y, start.y) };
      start = null;
      if (!dragged) {
        if (!additive) this.clearSelection();
        return;
      }
      // The click that follows this release must not also reset the highlight / selection.
      this._suppressNextBackgroundClick = true;
      const t = this._zoomTransform ?? d3.zoomIdentity;
      const inside = (this._simulation?.nodes() ?? []).filter((node) => {
        const [sx, sy] = t.apply([node.x, node.y]);
        return sx >= box.x0 && sx <= box.x1 && sy >= box.y0 && sy <= box.y1;
      });
      this.setSelection([...(additive ? this._selectedIds : []), ...inside.map((node) => node.id)]);
    };
    svg.on("mousedown.select", (event) => {
      if (event.button !== 0 || event.target.closest?.(".node")) return;
      const [x, y] = point(event);
      start = { x, y, additive: event.shiftKey };
      event.preventDefault(); // no text selection while drawing
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
    svg.on("click.select", (event) => {
      if (!this._suppressNextBackgroundClick) return;
      this._suppressNextBackgroundClick = false;
      event.stopImmediatePropagation();
    }, true);
    this._selectionKeyHandler ??= (event) => {
      if (event.key === "Escape" && this._selectedIds.size && !this._activeContextMenu) this.clearSelection();
    };
    document.removeEventListener("keydown", this._selectionKeyHandler);
    document.addEventListener("keydown", this._selectionKeyHandler);
  }

  setSelection(ids) {
    const visible = new Set((this._simulation?.nodes() ?? []).map((node) => node.id));
    this._selectedIds = new Set([...ids].filter((id) => visible.has(id)));
    this._refreshSelection();
  }

  clearSelection() {
    if (!this._selectedIds.size) return;
    this._selectedIds.clear();
    this._refreshSelection();
  }

  selectedNodes() {
    return (this._simulation?.nodes() ?? []).filter((node) => this._selectedIds.has(node.id));
  }

  // Nodes moved together by dragging `node`: the whole selection if it is part of it, with each
  // node's offset from the dragged one.
  _dragGroup(node) {
    const nodes = this._selectedIds.has(node.id) ? this.selectedNodes() : [node];
    return nodes.map((n) => ({ node: n, dx: n.x - node.x, dy: n.y - node.y }));
  }

  // Dashed ring on selected nodes; drops ids of nodes no longer shown.
  _refreshSelection() {
    if (!this._nodeSelection) return;
    const shown = new Set();
    this._nodeSelection.each((d, i, els) => {
      shown.add(d.id);
      const selection = d3.select(els[i]);
      const ring = selection.select(":scope > .selection-ring");
      const selected = this._selectedIds.has(d.id);
      selection.classed("selected", selected);
      if (!selected) return ring.remove();
      if (!ring.empty()) return;
      selection.insert("circle", ":first-child").attr("class", "selection-ring").attr("r", d.radius + 9)
        .attr("fill", "none").attr("stroke", CONFIG.graph.colors.selectedHighlight).attr("stroke-width", 2)
        .attr("stroke-dasharray", "5,4").style("pointer-events", "none");
    });
    this._selectedIds.forEach((id) => {
      if (!shown.has(id)) this._selectedIds.delete(id);
    });
  }

  // Releases nodes to the simulation, except those pinned on purpose (node.pinned), which keep
  // their position (_snapToGrid() then moves them onto the closest cell of a new grid).
  _releaseUnpinned(nodes) {
    nodes.forEach((node) => {
      if (node.pinned) return;
      node.fx = null;
      node.fy = null;
    });
  }

  _setPinned(node, pinned) {
    const simulation = this._simulation;
    node.pinned = pinned;
    if (pinned) {
      const grid = this._snapGrid();
      const cell = grid ? nearestFreeCell(grid, node.x, node.y, occupiedCells(grid, simulation.nodes(), node)) : node;
      node.x = node.fx = cell.x;
      node.y = node.fy = cell.y;
      node.vx = node.vy = 0;
      this._onTick();
    } else {
      node.fx = null;
      node.fy = null;
      this._reheat(0.3);
    }
    this._refreshPinBadges();
  }

  // Small badge on nodes pinned on purpose.
  _refreshPinBadges() {
    this._nodeSelection?.each((d, i, els) => {
      const selection = d3.select(els[i]);
      const badge = selection.select(":scope > .pin-badge");
      if (!d.pinned) return badge.remove();
      if (!badge.empty()) return;
      const offset = d.radius * 0.72;
      selection.append("circle").attr("class", "pin-badge").attr("cx", offset).attr("cy", -offset).attr("r", 5)
        .attr("fill", "#ffffff").attr("stroke", "#1b1b1f").attr("stroke-width", 2).style("pointer-events", "none");
    });
  }

  // Moves every node to its own grid cell, animated (from `starts`, or where nodes are now), and
  // leaves it free: gravity and links act again on the next reheat, the grid force keeping it
  // near its cell. Nodes pinned on purpose keep their cell (the closest one) and stay pinned.
  _snapToGrid(starts = null) {
    const grid = this._snapGrid();
    if (!grid || !this._simulation) return;
    this._stopSnapAnimation();
    this._setSnapGridSuspended(false);
    const nodes = this._simulation.nodes();
    const keep = new Set(nodes.filter((node) => node.fx != null));
    const targets = snapAll(nodes, grid, { keep });
    starts ??= new Map(nodes.map((node) => [node, { x: node.x, y: node.y }]));
    targets.forEach((target, node) => {
      node.vx = 0;
      node.vy = 0;
      if (node.fx != null) {
        node.fx = target.x;
        node.fy = target.y;
      }
    });
    const duration = CONFIG.graph.snapAnimationMs;
    const step = (t) => {
      targets.forEach((target, node) => {
        const start = starts.get(node);
        // Exact target at the end: start + (target - start) * 1 can be off by a rounding error.
        node.x = t === 1 ? target.x : start.x + (target.x - start.x) * t;
        node.y = t === 1 ? target.y : start.y + (target.y - start.y) * t;
      });
      this._onTick();
    };
    if (!(duration > 0)) return step(1);
    this._snapTimer = d3.timer((elapsed) => {
      const t = Math.min(1, elapsed / duration);
      step(d3.easeCubicOut(t));
      if (t === 1) this._stopSnapAnimation();
    });
  }

  _stopSnapAnimation() {
    this._snapTimer?.stop();
    this._snapTimer = null;
  }

  // Dims the grid backdrop while a layout runs with snapping suspended.
  _setSnapGridSuspended(suspended) {
    if (this._gridCanvas) this._gridCanvas.style.opacity = suspended ? "0.35" : "";
  }

  // Zoom/pan fire many events per frame: draw at most once per frame.
  _scheduleSnapGridDraw() {
    if (typeof window.requestAnimationFrame !== "function") return this._drawSnapGrid();
    if (this._snapGridFrame) return;
    this._snapGridFrame = window.requestAnimationFrame(() => {
      this._snapGridFrame = null;
      this._drawSnapGrid();
    });
  }

  // Draws every lattice point in view (see forEachLatticePointInView), or nothing when snapping
  // is off or the points would be too dense on screen to tell apart (latticeTooDense).
  _drawSnapGrid() {
    const canvas = this._gridCanvas;
    if (!canvas || !this._svg) return;
    const grid = this._snapGrid();
    const width = Number(this._svg.attr("width")) || 0;
    const height = Number(this._svg.attr("height")) || 0;
    const ratio = window.devicePixelRatio || 1;
    canvas.style.display = grid ? "" : "none";
    if (!grid) return;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    // No 2D canvas support (e.g. jsdom in tests): snapping still works, only the backdrop is skipped.
    if (this._gridContext === undefined) {
      this._gridContext = typeof window.CanvasRenderingContext2D === "function" ? canvas.getContext("2d") : null;
    }
    const context = this._gridContext;
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const transform = this._zoomTransform ?? d3.zoomIdentity;
    if (latticeTooDense(grid, transform.k)) return;
    const spacing = Math.min(grid.dx, grid.dy) * transform.k;
    const size = Math.max(1, Math.min(3, spacing * 0.12));
    context.fillStyle = spacing < 8 ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.22)";
    forEachLatticePointInView(grid, transform, width, height, (x, y) => context.fillRect(x - size / 2, y - size / 2, size, size));
  }

  // forceCenter only translates the whole graph; the weak forceX/forceY gravity is what keeps
  // disconnected components from drifting apart.
  _setCenterForces(simulation, width, height) {
    const g = getForcePreset(this.forcePresetId).gravity;
    simulation
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("x", d3.forceX(width / 2).strength(g))
      .force("y", d3.forceY(height / 2).strength(g));
  }

  // Uses a keyed .join(): a node that persists between two renders keeps its existing DOM
  // element (base circle/image/label are never rebuilt), only a few attributes that depend on
  // the wider graph context - not on the node itself - are refreshed (material highlight ring,
  // reaction origin ring, tag visibility icon/border), since those can change without the node
  // entering or leaving the visible set. New nodes are fully constructed; removed nodes are
  // dropped from the DOM (and, since they are no longer in this._nodesById either, from the
  // simulation on the next render).
  _joinNodes(g, visibleNodes, linkArray) {
    const simulation = this._simulation;
    // A normal d3 drag (neighbors follow, gravity keeps working); with a grid the dragged node
    // moves cell to cell. Dragging a selected node moves the whole selection, offsets kept (each
    // node on its own cell with a grid). On release nodes are let go, unless pinned on purpose
    // ("Pin position" in the menu): those stay where they are dropped, physics never moving
    // them. With no settling (settling time 0) nothing ticks: nodes are moved by hand, stay put.
    // Nothing happens until the pointer actually moves: a plain click (d3 still sends start/end)
    // must neither move the node nor shake the layout.
    let group = [];
    let moved = false;
    const drag = d3
      .drag()
      .on("start", (event, d) => {
        group = this._dragGroup(d);
        moved = false;
      })
      .on("drag", (event) => {
        if (!moved) {
          moved = true;
          this._stopSnapAnimation();
          if (!this._noSettling()) simulation.alphaTarget(0.3).restart();
        }
        const grid = this._snapGrid();
        group.forEach(({ node, dx, dy }) => {
          const target = { x: event.x + dx, y: event.y + dy };
          const at = grid ? grid.nearest(target.x, target.y) : target;
          node.fx = at.x;
          node.fy = at.y;
          if (this._noSettling()) {
            node.x = at.x;
            node.y = at.y;
          }
        });
        if (this._noSettling()) this._onTick();
      })
      .on("end", (event) => {
        if (!moved) {
          group = [];
          return;
        }
        const grid = this._snapGrid();
        if (!this._noSettling() && !event.active) simulation.alphaTarget(0);
        // Where they land: with a grid, each on the closest free cell (no two nodes on one cell).
        const moving = new Set(group.map(({ node }) => node));
        const occupied = grid ? occupiedCells(grid, simulation.nodes().filter((n) => !moving.has(n))) : null;
        group.forEach(({ node }) => {
          if (grid && (node.pinned || this._noSettling())) {
            const cell = nearestFreeCell(grid, node.fx ?? node.x, node.fy ?? node.y, occupied);
            occupied.add(grid.key(cell.i, cell.j));
            node.fx = cell.x;
            node.fy = cell.y;
            if (this._noSettling()) {
              node.x = cell.x;
              node.y = cell.y;
            }
          }
          if (!node.pinned) {
            node.fx = null;
            node.fy = null;
          }
        });
        if (this._noSettling()) this._onTick();
        group = [];
      });

    let nodesContainer = g.select(":scope > g.nodes-root");
    if (nodesContainer.empty()) {
      nodesContainer = g.append("g").attr("class", "nodes-root");
    }

    const nodeSelection = nodesContainer
      .selectAll(":scope > g.node")
      .data(visibleNodes, (d) => d.id)
      .join(
        (enter) => {
          const entered = enter
            .append("g")
            .attr("class", (d) => `node ${d.type}-node`)
            .call(drag);

          entered
            .filter((d) => d.type === "material")
            .each((d, i, els) => this._createMaterialNode(d, d3.select(els[i]), linkArray));
          entered
            .filter((d) => d.type === "tag")
            .each((d, i, els) => this._createTagNode(d, d3.select(els[i])));
          entered
            .filter((d) => d.type === "reaction")
            .each((d, i, els) => this._createReactionNode(d, d3.select(els[i])));

          return entered;
        },
        (update) => {
          update
            .filter((d) => d.type === "material")
            .each((d, i, els) => this._updateMaterialHighlight(d, d3.select(els[i]), linkArray));
          update
            .filter((d) => d.type === "tag")
            .each((d, i, els) => this._updateTagNode(d, d3.select(els[i])));
          update
            .filter((d) => d.type === "reaction")
            .each((d, i, els) => this._updateReactionOriginRing(d, d3.select(els[i])));
          return update;
        },
        (exit) => exit.remove(),
      );

    // Re-applying the click handler to the merged (enter + update) selection each time is
    // harmless/idempotent for elements that already had it - D3 simply overwrites the same
    // listener - and correctly (re)binds it for brand new nodes too.
    nodeSelection.on("click contextmenu", (event, d) => this._handleNodeEvent(event, d, nodeSelection, linkArray));
    // Node double-clicks are shortcuts, not zoom-in requests (d3.zoom listens to dblclick on the svg).
    nodeSelection.on("dblclick", (event) => event.stopPropagation());
    this._nodeSelection = nodeSelection;
    this._refreshPinBadges();
    this._refreshSelection();

    return nodeSelection;
  }

  _createMaterialNode(node, selection, linkArray) {
    // Highlight (dynamic - refreshed independently via _updateMaterialHighlight so it can be
    // kept in sync without rebuilding the rest of the node)
    selection
      .append("circle")
      .attr("r", node.radius + 4)
      .attr("fill", "transparent")
      .attr("stroke-width", 2)
      .attr("class", "material-highlight");
    this._updateMaterialHighlight(node, selection, linkArray);

    // Background
    selection
      .append("circle")
      .attr("r", node.radius)
      .attr("fill", node.color)
      .attr("stroke", CONFIG.graph.colors.nodeStroke)
      .attr("stroke-width", CONFIG.graph.sizes.strokeWidth)
      .attr("class", "node-background");

    // Clip path and image
    selection.append("clipPath").attr("id", `clip-${node.id}`).append("circle").attr("r", node.radius);

    selection
      .append("g")
      .attr("clip-path", `url(#clip-${node.id})`)
      .append("image")
      .attr("href", node.imageUrl)
      .attr("x", -CONFIG.graph.layout.textureSize * CONFIG.graph.layout.imageScale / 2)
      .attr("y", -CONFIG.graph.layout.textureSize * CONFIG.graph.layout.imageScale / 2)
      .attr("width", CONFIG.graph.layout.textureSize * CONFIG.graph.layout.imageScale)
      .attr("height", CONFIG.graph.layout.textureSize * CONFIG.graph.layout.imageScale)
      .attr("preserveAspectRatio", "xMidYMid slice")
      .attr("class", "material-image")
      .on("error", function () {
        d3.select(this).style("display", "none");
      });

    // Label
    selection
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", node.radius + CONFIG.graph.layout.labelOffsetMaterial)
      .attr("font-size", CONFIG.graph.sizes.fontSizeSmall)
      .attr("fill", CONFIG.graph.colors.text)
      .attr("font-weight", "bold")
      .attr("class", "node-label")
      .text(UIHelper.truncateName(node.name || node.id));

    // Tooltip
    selection.append("title").text(`${node.name} (${node.id})`);
  }

  // Whether a material is "directly involved" (and thus highlighted) is derived from the wider
  // set of currently visible reactions, so it can change for a material that itself neither
  // entered nor left the graph - e.g. toggling off the one set/group that used it as a direct
  // reagent, while a different set still shows it only via a tag association. Called both right
  // after creating the node and, on every subsequent render, for nodes that persist.
  _updateMaterialHighlight(node, selection, linkArray) {
    const isDirectMaterial = this._isMaterialDirectlyInvolved(node.id, linkArray);
    const isSelected = this.state.selectedReagents.includes(node.id) || this.state.selectedProduct === node.id;

    selection
      .select(":scope > circle.material-highlight")
      .attr("stroke", () => {
        if (isSelected) return CONFIG.graph.colors.selectedHighlight;
        if (isDirectMaterial) return CONFIG.graph.colors.directMaterialHighlight;
        return "transparent";
      })
      .style("opacity", isSelected || isDirectMaterial ? 1 : 0);
  }

  _createTagNode(node, selection) {
    // Background
    selection
      .append("circle")
      .attr("r", node.radius)
      .attr("fill", node.color)
      .attr("stroke", CONFIG.graph.colors.nodeStroke)
      .attr("stroke-width", CONFIG.graph.sizes.strokeWidth)
      .attr("class", "node-background");

    // Icon is inserted (and swapped on visibility change) by _updateTagNode below.

    // Border
    selection
      .append("circle")
      .attr("r", node.radius + 2)
      .attr("fill", "transparent")
      .attr("stroke-width", 3)
      .attr("stroke-dasharray", "4,2")
      .attr("class", "tag-border");

    // Label
    selection
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", node.radius + CONFIG.graph.layout.labelOffsetReaction)
      .attr("font-size", CONFIG.graph.sizes.fontSizeSmall)
      .attr("fill", CONFIG.graph.colors.text)
      .attr("font-weight", "bold")
      .attr("class", "node-label")
      .text(UIHelper.truncateName(node.name || node.id));

    selection.append("title");

    this._updateTagNode(node, selection);
  }

  // Icon/border color and tooltip depend on this.state.visibleTagMaterials, which can change
  // (tag menu) independently of the tag node itself entering or leaving the visible set.
  _updateTagNode(node, selection) {
    const materialIds = this.dataRepo.resolveTag(node.id);
    const hasVisibleMaterials = materialIds.some((id) => this.state.visibleTagMaterials.has(id));

    selection.select(":scope > .tag-visibility-icon").remove();
    selection
      .insert(() => icon(hasVisibleMaterials ? 'eye' : 'eye-slash'), ":scope > circle.tag-border")
      .attr("width", node.radius).attr("height", node.radius)
      .attr("x", -node.radius / 2).attr("y", -node.radius / 2)
      .style("color", "var(--bg-body)")
      .classed("tag-visibility-icon", true);

    selection
      .select(":scope > circle.tag-border")
      .attr("stroke", hasVisibleMaterials ? CONFIG.graph.colors.tagVisible : CONFIG.graph.colors.tagHidden);

    const visibleCount = materialIds.filter((id) => this.state.visibleTagMaterials.has(id)).length;
    const totalCount = materialIds.length;
    const tagName = node.tag;

    let tooltipText;
    if (visibleCount === totalCount) {
      tooltipText = `Tag: [${tagName}]\nAll ${totalCount} materials visible`;
    } else if (visibleCount > 0) {
      tooltipText = `Tag: [${tagName}]\n${visibleCount} of ${totalCount} materials visible`;
    } else {
      tooltipText = `Tag: [${tagName}]\nAll ${totalCount} materials hidden`;
    }
    const toggleCombo = this.shortcutManager.getBinding("toggleTagMaterials");
    const menuCombo = this.shortcutManager.getBinding("openTagMenu");
    if (toggleCombo) tooltipText += `\n${formatCombo(toggleCombo)}: ${visibleCount === totalCount ? "hide" : "show"} them all`;
    if (menuCombo) tooltipText += `\n${formatCombo(menuCombo)}: actions menu`;

    selection.select(":scope > title").text(tooltipText);
  }

  _createReactionNode(node, selection) {
    // Circle
    selection
      .append("circle")
      .attr("r", node.radius)
      .attr("fill", node.color)
      .attr("stroke", CONFIG.graph.colors.nodeStroke)
      .attr("stroke-width", CONFIG.graph.sizes.strokeWidth)
      .attr("class", "reaction-circle");

    // Speed number
    selection
      .append("text")
      .text(node.reaction.reactionRate)
      .attr("text-anchor", "middle")
      .attr("dy", 5)
      .attr("font-size", CONFIG.graph.sizes.fontSizeMedium)
      .attr("fill", CONFIG.graph.colors.text)
      .attr("font-weight", "bold")
      .attr("class", "reaction-speed");

    selection.append("title");

    // Origin ring + tooltip: both depend on which reaction set(s) currently contribute this
    // reaction (node.setColors/setNames), which is refreshed independently on every render even
    // for a reaction node that itself persists - see _updateReactionOriginRing.
    this._updateReactionOriginRing(node, selection);
  }

  // Draws the origin ring (which reaction set(s) this reaction currently comes from - a single
  // contributing set draws a solid colored ring, several draw a pie of colored segments) and the
  // tooltip. Any previous ring is removed first so this is safe to call again for a persisting
  // node whose contributing set(s) changed (e.g. after enabling/disabling a sibling set that
  // also matched this same reaction).
  _updateReactionOriginRing(node, selection) {
    selection.selectAll(".reaction-origin-ring, .reaction-origin-ring-segment").remove();
    if (node.setColors && node.setColors.length > 0) {
      this._createReactionOriginRing(node, selection);
    }

    const inputs = [node.reaction.reagent1, node.reaction.reagent2, node.reaction.reagent3]
      .filter(Boolean)
      .map((id) => UIHelper.getMaterialName(id, this.dataRepo))
      .join(" + ");

    const outputs = [node.reaction.product1, node.reaction.product2, node.reaction.product3]
      .filter(Boolean)
      .map((id) => UIHelper.getMaterialName(id, this.dataRepo))
      .join(" + ");

    let tooltipText = `Reaction (Speed: ${node.reaction.reactionRate})\n${inputs} → ${outputs}`;
    if (node.setNames && node.setNames.length > 0) {
      tooltipText += `\nSets: ${node.setNames.join(", ")}`;
    }

    selection.select(":scope > title").text(tooltipText);
  }

  // Draws a ring of colored segments (one per contributing reaction set) around a reaction node.
  _createReactionOriginRing(node, selection) {
    const colors = node.setColors;
    const ringInner = node.radius + 3;
    const ringOuter = node.radius + 7;

    if (colors.length === 1) {
      selection
        .append("circle")
        .attr("r", (ringInner + ringOuter) / 2)
        .attr("fill", "none")
        .attr("stroke", colors[0])
        .attr("stroke-width", ringOuter - ringInner)
        .attr("class", "reaction-origin-ring");
      return;
    }

    const arcGenerator = d3.arc().innerRadius(ringInner).outerRadius(ringOuter);
    const sliceAngle = (2 * Math.PI) / colors.length;
    const gapAngle = 0.06;

    colors.forEach((color, i) => {
      selection
        .append("path")
        .attr(
          "d",
          arcGenerator({
            startAngle: i * sliceAngle + gapAngle / 2,
            endAngle: (i + 1) * sliceAngle - gapAngle / 2,
          }),
        )
        .attr("fill", color)
        .attr("class", "reaction-origin-ring-segment");
    });
  }

  // Action id -> handler(node). An action missing here (or whose handler returns false because
  // it is unavailable) behaves as if it were unbound.
  _actionHandler(actionId) {
    return {
      selectAsReagent: (node) => this._selectMaterialAsReagent(node),
      selectAsProduct: (node) => this._selectMaterialAsProduct(node),
      openMaterialWiki: (node) => this._openMaterialWiki(node),
      addReagentToNewSet: (node) => this.onQuickAddSet && this.onQuickAddSet(node.id, "reagent"),
      addProductToNewSet: (node) => this.onQuickAddSet && this.onQuickAddSet(node.id, "product"),
      openMaterialMenu: (node, event, ctx) => this._showNodeContextMenu(event, node, ctx),
      openTagMenu: (node, event, ctx) => this._showNodeContextMenu(event, node, ctx),
      openReactionMenu: (node, event, ctx) => this._showNodeContextMenu(event, node, ctx),
      toggleTagMaterials: (node) => this.state.toggleTagVisibility(node.id),
    }[actionId];
  }

  // Single entry point for click and contextmenu on a node. The node type is the shortcut scope.
  _handleNodeEvent(event, node, allNodes, linkArray) {
    const actionId = this.shortcutManager.resolve(node.type, event);
    const handler = actionId && this._actionHandler(actionId);

    if (event.type === "contextmenu") {
      if (!handler) return; // nothing bound: keep the browser's native menu
      event.preventDefault();
      event.stopPropagation();
      handler(node, event, { allNodes, linkArray });
      return;
    }

    event.stopPropagation();
    this._cancelPendingClick();

    if (!handler) {
      // A plain click (or an unbound combo) highlights. Skip the second click of a double-click
      // so it doesn't toggle the highlight back off.
      if (event.detail < 2) this._highlightConnections(node, allNodes, linkArray);
      return;
    }

    // A double-click with the same modifiers is bound too: wait before running this one.
    if (event.detail < 2 && this.shortcutManager.hasDoubleClickVariant(node.type, event)) {
      const { clientX, clientY } = event;
      this._pendingClick = setTimeout(() => {
        this._pendingClick = null;
        handler(node, { clientX, clientY }, { allNodes, linkArray });
      }, GraphRenderer.DOUBLE_CLICK_DELAY);
      return;
    }

    handler(node, event, { allNodes, linkArray });
  }

  _cancelPendingClick() {
    clearTimeout(this._pendingClick);
    this._pendingClick = null;
  }

  _openMaterialWiki(node) {
    const wikiUrl = node.material?.wikipage ? `${CONFIG.urls.wikiBase}${encodeURIComponent(node.material.wikipage)}` : "";
    if (wikiUrl) {
      window.open(wikiUrl, "_blank");
    } else {
      UIHelper.showNotification("No wiki page found for this material");
    }
  }

  _selectMaterialAsProduct(node) {
    if (this.state.selectProduct(node.id)) {
      this.state.eventBus.emit("stateChanged", this.state);
    } else {
      UIHelper.showNotification("No valid reactions with this product");
    }
  }

  _selectMaterialAsReagent(node) {
    if (this.state.selectReagent(node.id)) {
      this.state.eventBus.emit("stateChanged", this.state);
    } else {
      UIHelper.showNotification("No valid reactions with this reagent");
    }
  }

  // Menu entries for a node: every shortcut action of its scope (so the menu is a discoverable
  // alternative to the modifier+click shortcuts, with each shortcut shown next to its entry),
  // except the menu-opening action itself. Tags get explicit show/hide entries instead of the
  // toggle, whose effect depends on the current state. Entries that can't run here (no sets in
  // classic mode) are left out.
  _contextMenuEntries(node, ctx) {
    const entries = [];
    if (ctx) entries.push({ label: "Highlight connections", run: () => this._highlightConnections(node, ctx.allNodes, ctx.linkArray) });
    // Pin a node where it is (on its grid cell, if any) so physics leaves it alone - it can still
    // be dragged - or let it go again.
    const selected = this._selectedIds.has(node.id) && this._selectedIds.size > 1 ? this.selectedNodes() : null;
    if (this._simulation && selected) {
      entries.push({ label: `Pin selected (${selected.length})`, run: () => selected.forEach((n) => this._setPinned(n, true)) });
      if (selected.some((n) => n.pinned)) {
        entries.push({ label: `Unpin selected (${selected.length})`, run: () => selected.forEach((n) => n.pinned && this._setPinned(n, false)) });
      }
      entries.push({ label: "Clear selection", run: () => this.clearSelection() });
    } else if (this._simulation) {
      if (node.pinned) {
        entries.push({ label: "Unpin position", run: () => this._setPinned(node, false) });
      } else {
        entries.push({ label: "Pin position", run: () => this._setPinned(node, true) });
      }
    }
    if (node.type === "reaction" && ctx) {
      // The reaction and every material/tag it links to, as the selection: handy to move a whole
      // reaction around at once.
      entries.splice(1, 0, {
        label: "Select with its materials",
        run: () => {
          const ids = new Set([node.id]);
          ctx.linkArray.forEach(({ source, target }) => {
            if (source.id === node.id) ids.add(target.id);
            if (target.id === node.id) ids.add(source.id);
          });
          this.setSelection(ids);
        },
      });
    }
    // Excluding needs reaction sets (advanced mode): see onExcludeReactions.
    if (node.type === "reaction" && this.onExcludeReactions) {
      const reactions = (selected ?? [node]).filter((n) => n.type === "reaction").map((n) => n.reaction);
      const label = selected && reactions.length > 1 ? `Exclude selected reactions (${reactions.length})` : "Exclude this reaction";
      entries.push({ label, run: () => this.onExcludeReactions(selected && reactions.length > 1 ? reactions : [node.reaction]) });
    }
    if (node.type === "tag") {
      entries.push({ label: "Show all materials", run: () => this.state.showTagMaterials(node.id) });
      entries.push({ label: "Hide all materials", run: () => this.state.hideTagMaterials(node.id) });
      return entries;
    }
    const menuActions = new Set(["openMaterialMenu", "openTagMenu", "openReactionMenu"]);
    const needsSets = new Set(["addReagentToNewSet", "addProductToNewSet"]);
    this.shortcutManager.getActions(node.type).forEach((action) => {
      if (menuActions.has(action.id) || (needsSets.has(action.id) && !this.onQuickAddSet)) return;
      const handler = this._actionHandler(action.id);
      if (!handler) return;
      const combo = this.shortcutManager.getBinding(action.id);
      entries.push({ label: action.label, hint: combo ? formatCombo(combo) : "", run: () => handler(node) });
    });
    return entries;
  }

  // A small floating menu listing the node's actions (see _contextMenuEntries).
  _showNodeContextMenu(event, node, ctx = null) {
    this._closeContextMenu();

    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.style.cssText = [
      "position:fixed",
      `left:${event.clientX}px`,
      `top:${event.clientY}px`,
      "background:#1a1a1a",
      "border:1px solid #555",
      "border-radius:6px",
      "padding:4px",
      "z-index:10000",
      "box-shadow:0 4px 12px rgba(0,0,0,0.5)",
      "font-family:Arial, sans-serif",
      "font-size:12px",
      "min-width:180px",
    ].join(";");

    const title = document.createElement("div");
    title.textContent = node.type === "tag" ? `[${node.tag || node.id}]`
      : node.type === "reaction" ? UIHelper.reactionTitle(node.reaction, this.dataRepo) : node.name || node.id;
    title.style.cssText = "color:#999;padding:4px 8px;border-bottom:1px solid #444;margin-bottom:4px;";
    menu.appendChild(title);

    this._contextMenuEntries(node, ctx).forEach(({ label, hint, run }) => {
      const item = document.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.textContent = label;
      item.style.cssText =
        "display:flex;justify-content:space-between;gap:16px;width:100%;text-align:left;background:none;border:none;color:#fff;padding:6px 8px;cursor:pointer;border-radius:4px;";
      if (hint) {
        const hintEl = document.createElement("span");
        hintEl.className = "context-menu-shortcut";
        hintEl.textContent = hint;
        hintEl.style.cssText = "color:#888;";
        item.appendChild(hintEl);
      }
      item.addEventListener("mouseenter", () => (item.style.background = "#333"));
      item.addEventListener("mouseleave", () => (item.style.background = "none"));
      item.addEventListener("click", () => {
        this._closeContextMenu();
        run();
      });
      menu.appendChild(item);
    });

    UIHelper.overlayHost().appendChild(menu);
    this._activeContextMenu = menu;

    // Close on a press outside the menu, or on Escape. Listening to "pointerdown" rather than
    // "click" matters: on Linux the contextmenu event fires on mouse *down*, and some browsers
    // then dispatch a "click" to the document on release, which used to close the menu the very
    // moment it opened. The press that opened the menu has already happened, so no deferral is
    // needed; capture phase so nodes stopping propagation (d3 drag) can't swallow it.
    this._contextMenuOutsideHandler = (e) => {
      const close = e.type === "keydown" ? e.key === "Escape" : e.type === "fullscreenchange" || !menu.contains(e.target);
      if (close) this._closeContextMenu();
    };
    document.addEventListener("pointerdown", this._contextMenuOutsideHandler, true);
    document.addEventListener("keydown", this._contextMenuOutsideHandler, true);
    // Entering/leaving fullscreen changes which subtree is rendered: the menu would be stranded.
    document.addEventListener("fullscreenchange", this._contextMenuOutsideHandler);
    menu.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  _closeContextMenu() {
    if (this._activeContextMenu) {
      this._activeContextMenu.remove();
      this._activeContextMenu = null;
    }
    if (this._contextMenuOutsideHandler) {
      document.removeEventListener("pointerdown", this._contextMenuOutsideHandler, true);
      document.removeEventListener("keydown", this._contextMenuOutsideHandler, true);
      document.removeEventListener("fullscreenchange", this._contextMenuOutsideHandler);
      this._contextMenuOutsideHandler = null;
    }
  }

  _highlightConnections(node, allNodes, linkArray) {
    this._resetHighlighting(allNodes);
    this._highlight = { node, allNodes, linkArray };

    if (node.type === "material" || node.type === "tag") {
      allNodes
        .filter((n) => n.id === node.id)
        .select(".node-background")
        .attr("stroke", CONFIG.graph.colors.nodeStrokeHighlight)
        .attr("stroke-width", CONFIG.graph.sizes.strokeWidthHighlight);

      if (node.type === "tag") {
        const materialIds = this.dataRepo.resolveTag(node.id);
        materialIds.forEach((materialId) => {
          allNodes
            .filter((n) => n.id === materialId)
            .select(".node-background")
            .attr("stroke", CONFIG.graph.colors.tagVisible)
            .attr("stroke-width", CONFIG.graph.sizes.strokeWidthMedium);
        });
      }

      const connectedReactionIds = new Set();
      linkArray.forEach((link) => {
        if (link.source.id === node.id && link.target.type === "reaction") {
          connectedReactionIds.add(link.target.id);
        }
        if (link.target.id === node.id && link.source.type === "reaction") {
          connectedReactionIds.add(link.source.id);
        }
      });

      connectedReactionIds.forEach((reactionId) => {
        allNodes
          .filter((n) => n.id === reactionId)
          .select(".reaction-circle")
          .attr("stroke", CONFIG.graph.colors.nodeStrokeHighlight)
          .attr("stroke-width", CONFIG.graph.sizes.strokeWidthHighlight);

        linkArray.forEach((link) => {
          if (link.source.id === reactionId && (link.target.type === "material" || link.target.type === "tag")) {
            allNodes
              .filter((n) => n.id === link.target.id)
              .select(".node-background")
              .attr("stroke", CONFIG.graph.colors.outputHighlight)
              .attr("stroke-width", CONFIG.graph.sizes.strokeWidthMedium);
          }
          if (link.target.id === reactionId && (link.source.type === "material" || link.source.type === "tag")) {
            allNodes
              .filter((n) => n.id === link.source.id)
              .select(".node-background")
              .attr("stroke", CONFIG.graph.colors.inputHighlight)
              .attr("stroke-width", CONFIG.graph.sizes.strokeWidthMedium);
          }
        });
      });

      const allConnectedIds = this._getConnectedNodeIds(node.id, node.type, linkArray);

      allNodes.style("opacity", (n) =>
        allConnectedIds.has(n.id) ? CONFIG.graph.opacities.default : CONFIG.graph.opacities.dimmed,
      );

      d3.selectAll(".link-group").style("opacity", (l) =>
        allConnectedIds.has(l.source.id) && allConnectedIds.has(l.target.id)
          ? l.type === "tag-association"
            ? CONFIG.graph.opacities.tagAssociation
            : CONFIG.graph.opacities.default
          : CONFIG.graph.opacities.veryDimmed,
      );
    } else if (node.type === "reaction") {
      allNodes
        .filter((n) => n.id === node.id)
        .select(".reaction-circle")
        .attr("stroke", CONFIG.graph.colors.nodeStrokeHighlight)
        .attr("stroke-width", CONFIG.graph.sizes.strokeWidthHighlight);

      const connectedMaterialIds = new Set();
      linkArray.forEach((link) => {
        if (link.source.id === node.id && (link.target.type === "material" || link.target.type === "tag")) {
          connectedMaterialIds.add(link.target.id);
        }
        if (link.target.id === node.id && (link.source.type === "material" || link.source.type === "tag")) {
          connectedMaterialIds.add(link.source.id);
        }
      });

      connectedMaterialIds.forEach((materialId) => {
        allNodes
          .filter((n) => n.id === materialId)
          .select(".node-background")
          .attr("stroke", CONFIG.graph.colors.nodeStrokeHighlight)
          .attr("stroke-width", CONFIG.graph.sizes.strokeWidthMedium);
      });

      const allConnectedIds = new Set([node.id, ...connectedMaterialIds]);

      allNodes.style("opacity", (n) =>
        allConnectedIds.has(n.id) ? CONFIG.graph.opacities.default : CONFIG.graph.opacities.dimmed,
      );

      d3.selectAll(".link-group").style("opacity", (l) =>
        allConnectedIds.has(l.source.id) && allConnectedIds.has(l.target.id)
          ? l.type === "tag-association"
            ? CONFIG.graph.opacities.tagAssociation
            : CONFIG.graph.opacities.default
          : CONFIG.graph.opacities.veryDimmed,
      );
    }
  }

  _getConnectedNodeIds(nodeId, nodeType, linkArray) {
    const connected = new Set([nodeId]);

    if (nodeType === "material" || nodeType === "tag") {
      const connectedReactions = new Set();
      linkArray.forEach((link) => {
        if (link.source.id === nodeId && link.target.type === "reaction") {
          connectedReactions.add(link.target.id);
        }
        if (link.target.id === nodeId && link.source.type === "reaction") {
          connectedReactions.add(link.source.id);
        }
      });

      connectedReactions.forEach((id) => connected.add(id));

      connectedReactions.forEach((reactionId) => {
        linkArray.forEach((link) => {
          if (link.source.id === reactionId && (link.target.type === "material" || link.target.type === "tag")) {
            connected.add(link.target.id);
          }
          if (link.target.id === reactionId && (link.source.type === "material" || link.source.type === "tag")) {
            connected.add(link.source.id);
          }
        });
      });

      if (nodeType === "tag") {
        const materialIds = this.dataRepo.resolveTag(nodeId);
        materialIds.forEach((materialId) => connected.add(materialId));
      }
    }

    return connected;
  }

  _resetHighlighting(allNodes) {
    this._highlight = null;
    allNodes.style("opacity", CONFIG.graph.opacities.default);

    d3.selectAll(".link-group").style("opacity", (d) => {
      if (d.type === "tag-association") return CONFIG.graph.opacities.tagAssociation;
      return CONFIG.graph.opacities.linkDefault;
    });

    allNodes
      .select(".node-background, .reaction-circle")
      .attr("stroke", CONFIG.graph.colors.nodeStroke)
      .attr("stroke-width", CONFIG.graph.sizes.strokeWidth);
  }

  _handleResize(container, svg, simulation) {
    const width = container.clientWidth;
    const height = Math.max(1, container.clientHeight);
    const changed = Number(svg.attr('width')) !== width || Number(svg.attr('height')) !== height;
    svg.attr("width", width).attr("height", height).attr("viewBox", `0 0 ${width} ${height}`);
    if (changed) this._drawSnapGrid();
    if (changed && simulation) {
      simulation.force('center').x(width / 2).y(height / 2);
      simulation.force('x')?.x(width / 2);
      simulation.force('y')?.y(height / 2);
      this._reheat(0.1);
    }
  }
}
