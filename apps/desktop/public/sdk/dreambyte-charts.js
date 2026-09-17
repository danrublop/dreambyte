/**
 * Dreambyte Charts — Animated chart library for Dreambyte D3 scenes.
 *
 * Provides pre-built chart renderers with optional anime.js timeline animation.
 * Each chart type has a static mode (draws immediately) and an animated mode
 * (adds a cinematic reveal sequence to an anime.js timeline, times in seconds).
 *
 * Usage:
 *   // Static — draws the final chart immediately
 *   DreambyteCharts.bar('#chart', data, config);
 *
 *   // Animated — draws everything invisible, then reveals via the timeline
 *   DreambyteCharts.bar('#chart', data, config).animate(window.__tl);
 *
 * Requires: D3 v7 loaded as global `d3`.
 * Optional: anime.js loaded as global `anime` (for .animate()).
 */
(function (global) {
  'use strict';

  // ── Defaults ────────────────────────────────────────────────────────────────

  var DEFAULT_PALETTE = [
    '#4C9BE8', '#E86B4C', '#4CE8A0', '#E8C84C',
    '#9B4CE8', '#4CE8D4', '#E84C7A', '#85E84C'
  ];

  var DARK_THEME = {
    text: '#e8e4dc',
    textMuted: '#8a8a9a',
    axis: '#444455',
    grid: 'rgba(255,255,255,0.07)',
    bg: '#181818',
  };

  var LIGHT_THEME = {
    text: '#1a1a2e',
    textMuted: '#6b6b7a',
    axis: '#cccccc',
    grid: 'rgba(0,0,0,0.07)',
    bg: '#ffffff',
  };

  // ── Utility Functions ───────────────────────────────────────────────────────

  function resolveConfig(cfg) {
    cfg = cfg || {};
    var baseTheme = cfg.theme === 'light' ? LIGHT_THEME : DARK_THEME;
    var useSceneAxis = cfg.useSceneAxisColors !== false;
    var axisFromScene =
      useSceneAxis && typeof AXIS_COLOR !== 'undefined' && AXIS_COLOR ? String(AXIS_COLOR) : null;
    var gridFromScene =
      useSceneAxis && typeof GRID_COLOR !== 'undefined' && GRID_COLOR ? String(GRID_COLOR) : null;
    var theme = {
      text: cfg.textColor || baseTheme.text,
      textMuted: cfg.tickLabelColor || cfg.textMutedColor || baseTheme.textMuted,
      axis: cfg.axisColor || axisFromScene || baseTheme.axis,
      grid: cfg.gridColor || gridFromScene || baseTheme.grid,
      bg: baseTheme.bg,
    };
    var colors = cfg.colors || (typeof PALETTE !== 'undefined' ? PALETTE : DEFAULT_PALETTE);
    var font = cfg.fontFamily || cfg.font || (typeof FONT !== 'undefined' ? FONT : 'sans-serif');
    var w = cfg.width || (typeof WIDTH !== 'undefined' ? WIDTH : 1920);
    var h = cfg.height || (typeof HEIGHT !== 'undefined' ? HEIGHT : 1080);
    var m = Object.assign({ top: 100, right: 80, bottom: 100, left: 100 }, cfg.margin || {});
    var plotBg = cfg.plotBackground;
    if (plotBg === '' || plotBg === undefined || plotBg === null) plotBg = null;
    else if (typeof plotBg === 'string' && plotBg.toLowerCase() === 'transparent') plotBg = null;
    var barStroke = typeof cfg.barStroke === 'string' && cfg.barStroke.trim() ? cfg.barStroke.trim() : null;
    var barStrokeWidth =
      typeof cfg.barStrokeWidth === 'number' && cfg.barStrokeWidth > 0 ? cfg.barStrokeWidth : 0;
    return {
      width: w,
      height: h,
      margin: m,
      plotBackground: plotBg,
      innerWidth: w - m.left - m.right,
      innerHeight: h - m.top - m.bottom,
      title: cfg.title || null,
      subtitle: cfg.subtitle || null,
      xLabel: cfg.xLabel || null,
      yLabel: cfg.yLabel || null,
      valueFormat: cfg.valueFormat || ',.0f',
      valuePrefix: cfg.valuePrefix || '',
      valueSuffix: cfg.valueSuffix || '',
      showValues: cfg.showValues !== false,
      showGrid: cfg.showGrid !== false,
      showLegend: cfg.showLegend || false,
      colors: colors,
      theme: theme,
      useSceneAxisColors: useSceneAxis,
      titleColor: cfg.titleColor || null,
      subtitleColor: cfg.subtitleColor || null,
      axisLabelColor: cfg.axisLabelColor || null,
      legendTextColor: cfg.legendTextColor || null,
      valueLabelColor: cfg.valueLabelColor || null,
      barStroke: barStroke,
      barStrokeWidth: barStrokeWidth,
      font: font,
      fontSize: Math.max(20, cfg.fontSize || 22),
      titleSize: Math.max(56, cfg.titleSize || 64),
      subtitleSize: Math.max(24, cfg.subtitleSize || 28),
      axisLabelSize: Math.max(28, cfg.axisLabelSize || 32),
      axisTickSize: Math.max(22, cfg.axisTickSize || 24),
      dataLabelSize: Math.max(22, cfg.dataLabelSize || 24),
      animationDuration: cfg.animationDuration || 1.2,
      staggerDelay: cfg.staggerDelay || 0.08,
      countDuration: cfg.countDuration || 1.0,
      legendLabels: cfg.legendLabels || null,
    };
  }

  function colorAt(colors, i) {
    return colors[i % colors.length];
  }

  function fmtValue(val, c) {
    var s = d3.format(c.valueFormat)(val);
    return c.valuePrefix + s + c.valueSuffix;
  }

  // ── SVG + Header Helpers ────────────────────────────────────────────────────

  function createSVG(container, c) {
    var svg = d3.select(container)
      .append('svg')
      .attr('viewBox', '0 0 ' + c.width + ' ' + c.height)
      .attr('width', '100%')
      .attr('height', '100%')
      .style('font-family', c.font);
    if (c.plotBackground) {
      svg.append('rect')
        .attr('class', 'dreambyte-plot-bg')
        .attr('x', 0)
        .attr('y', 0)
        .attr('width', c.width)
        .attr('height', c.height)
        .attr('fill', c.plotBackground);
    }
    return svg;
  }

  function addTitle(svg, c) {
    var els = [];
    if (c.title) {
      els.push(
        svg.append('text')
          .attr('x', c.width / 2)
          .attr('y', c.margin.top / 2)
          .attr('text-anchor', 'middle')
          .attr('font-size', c.titleSize)
          .attr('font-weight', 700)
          .attr('fill', c.titleColor || c.theme.text)
          .text(c.title)
      );
    }
    if (c.subtitle) {
      els.push(
        svg.append('text')
          .attr('x', c.width / 2)
          .attr('y', c.margin.top / 2 + 36)
          .attr('text-anchor', 'middle')
          .attr('font-size', c.subtitleSize)
          .attr('fill', c.subtitleColor || c.theme.textMuted)
          .text(c.subtitle)
      );
    }
    return els;
  }

  function addAxisLabels(svg, c) {
    var els = [];
    if (c.xLabel) {
      els.push(
        svg.append('text')
          .attr('x', c.margin.left + c.innerWidth / 2)
          .attr('y', c.height - 20)
          .attr('text-anchor', 'middle')
          .attr('font-size', c.axisLabelSize)
          .attr('fill', c.axisLabelColor || c.theme.textMuted)
          .text(c.xLabel)
      );
    }
    if (c.yLabel) {
      els.push(
        svg.append('text')
          .attr('x', 24)
          .attr('y', c.margin.top + c.innerHeight / 2)
          .attr('text-anchor', 'middle')
          .attr('font-size', c.axisLabelSize)
          .attr('fill', c.axisLabelColor || c.theme.textMuted)
          .attr('transform', 'rotate(-90, 24, ' + (c.margin.top + c.innerHeight / 2) + ')')
          .text(c.yLabel)
      );
    }
    return els;
  }

  // ── Animation Engine ────────────────────────────────────────────────────────

  /**
   * Build an Animatable wrapper. Collects all DOM elements and their animation
   * descriptors. In static mode, everything is visible. When .animate(tl) is
   * called, elements are hidden and tweens are added to the timeline.
   */
  function Animatable(elements, c) {
    this._elements = elements; // Array of { el, type, data }
    this._config = c;
  }

  Animatable.prototype.animate = function (tl) {
    if (!tl || typeof anime === 'undefined') return this;
    var c = this._config;
    var t = 0; // running time offset

    for (var i = 0; i < this._elements.length; i++) {
      var entry = this._elements[i];
      var el = entry.el;
      var type = entry.type;
      var data = entry.data || {};

      switch (type) {
        case 'title':
        case 'subtitle':
        case 'axis-label':
          _hideEl(el);
          tl.add(el.node(), { opacity: 1, duration: 0.4, ease: 'outCubic' }, t);
          t += 0.15;
          break;

        case 'axis':
          _hideAxis(el);
          tl.add(el.node(), { opacity: 1, duration: 0.5, ease: 'outCubic' }, t);
          break;

        case 'grid':
          _hideEl(el);
          tl.add(el.node(), { opacity: 1, duration: 0.4, ease: 'outCubic' }, t);
          t += 0.2;
          break;

        case 'bar':
          _animateBars(tl, el, data, c, t);
          t += Math.max(0.3, data.count * c.staggerDelay);
          break;

        case 'h-bar':
          _animateHBars(tl, el, data, c, t);
          t += Math.max(0.3, data.count * c.staggerDelay);
          break;

        case 'line-path':
          _animateLineDraw(tl, el, c, t);
          t += c.animationDuration * 0.7;
          break;

        case 'dots':
          _animateDots(tl, el, data, c, t);
          t += Math.max(0.3, data.count * c.staggerDelay);
          break;

        case 'area-fill':
          _hideEl(el);
          tl.add(el.node(), { opacity: 1, duration: c.animationDuration * 0.4, ease: 'outCubic' }, t);
          break;

        case 'pie-slices':
          _animatePieSlices(tl, el, data, c, t);
          t += c.animationDuration;
          break;

        case 'value-labels':
          _animateValueLabels(tl, el, data, c, t);
          t += 0.3;
          break;

        case 'pie-labels':
          _animatePieLabels(tl, el, data, c, t);
          t += 0.3;
          break;

        case 'center-label':
          _animateCenterNumber(tl, el, data, c, t);
          t += 0.4;
          break;

        case 'kpi-number':
          _animateKPINumber(tl, el, data, c, t);
          t += c.countDuration;
          break;

        case 'kpi-label':
          _hideEl(el);
          tl.add(el.node(), { opacity: 1, duration: 0.4, ease: 'outCubic' }, t);
          t += 0.2;
          break;

        case 'legend':
          _hideEl(el);
          tl.add(el.node(), { opacity: 1, duration: 0.4, ease: 'outCubic' }, t);
          break;

        case 'scatter-dots':
          _animateScatterDots(tl, el, data, c, t);
          t += Math.max(0.4, data.count * c.staggerDelay * 0.5);
          break;

        case 'gauge-arc':
          _animateGaugeArc(tl, el, data, c, t);
          t += c.animationDuration;
          break;

        case 'gauge-needle':
          _animateGaugeNeedle(tl, el, data, c, t);
          t += 0.4;
          break;

        case 'stacked-bars':
          _animateStackedBars(tl, el, data, c, t);
          t += Math.max(0.4, data.groupCount * c.staggerDelay);
          break;

        case 'grouped-bars':
          _animateGroupedBars(tl, el, data, c, t);
          t += Math.max(0.4, data.groupCount * c.staggerDelay * 1.5);
          break;

        default:
          break;
      }
    }

    return this;
  };

  // ── Animation Primitives ────────────────────────────────────────────────────

  function _hideEl(sel) {
    sel.style('opacity', 0);
  }

  function _hideAxis(sel) {
    sel.style('opacity', 0);
  }

  function _animateBars(tl, barsSelection, data, c, startTime) {
    var bars = barsSelection.selectAll('rect').nodes();
    bars.forEach(function (node, i) {
      var targetH = parseFloat(node.getAttribute('data-target-h'));
      var targetY = parseFloat(node.getAttribute('data-target-y'));
      var baseY = parseFloat(node.getAttribute('data-base-y'));
      anime.set(node, { y: baseY, height: 0, opacity: 0 });
      tl.add(node, {
        opacity: 1,
        duration: 0.05,
        ease: 'linear',
      }, startTime + i * c.staggerDelay);
      tl.add(node, {
        y: targetY, height: targetH,
        duration: c.animationDuration,
        ease: 'outCubic',
      }, startTime + i * c.staggerDelay);
    });
  }

  function _animateHBars(tl, barsSelection, data, c, startTime) {
    var bars = barsSelection.selectAll('rect').nodes();
    bars.forEach(function (node, i) {
      var targetW = parseFloat(node.getAttribute('data-target-w'));
      anime.set(node, { width: 0, opacity: 0 });
      tl.add(node, { opacity: 1, duration: 0.05, ease: 'linear' }, startTime + i * c.staggerDelay);
      tl.add(node, {
        width: targetW,
        duration: c.animationDuration,
        ease: 'outCubic',
      }, startTime + i * c.staggerDelay);
    });
  }

  function _animateLineDraw(tl, pathSel, c, startTime) {
    var node = pathSel.node();
    var length = node.getTotalLength();
    anime.set(node, { strokeDasharray: length, strokeDashoffset: length });
    tl.add(node, {
      strokeDashoffset: [length, 0],
      duration: c.animationDuration,
      ease: 'inOutCubic',
    }, startTime);
  }

  function _animateDots(tl, dotsSelection, data, c, startTime) {
    var dots = dotsSelection.selectAll('circle').nodes();
    dots.forEach(function (node, i) {
      anime.set(node, { r: 0, opacity: 0 });
      var targetR = parseFloat(node.getAttribute('data-target-r')) || 5;
      tl.add(node, {
        opacity: 1,
        r: targetR,
        duration: 0.3,
        ease: 'outBack(2)',
      }, startTime + i * c.staggerDelay * 1.5);
    });
  }

  function _animateScatterDots(tl, dotsSelection, data, c, startTime) {
    var dots = dotsSelection.selectAll('circle').nodes();
    dots.forEach(function (node, i) {
      var targetR = parseFloat(node.getAttribute('data-target-r')) || 6;
      anime.set(node, { r: 0, opacity: 0 });
      tl.add(node, {
        opacity: 1,
        r: targetR,
        duration: 0.35,
        ease: 'outElastic(1, .5)',
      }, startTime + i * c.staggerDelay * 0.6);
    });
  }

  function _animatePieSlices(tl, slicesGroup, data, c, startTime) {
    var paths = slicesGroup.selectAll('path').nodes();
    var arcFn = data.arcFn;
    var arcs = data.arcs;
    paths.forEach(function (node, i) {
      var arcData = arcs[i];
      var startAngle = arcData.startAngle;
      var endAngle = arcData.endAngle;
      var proxy = { t: 0 };
      anime.set(node, { opacity: 1 });
      // Start with zero-angle arc
      node.setAttribute('d', arcFn({ startAngle: startAngle, endAngle: startAngle, innerRadius: arcData.innerRadius || 0, outerRadius: arcData.outerRadius || data.outerRadius }));
      tl.add(proxy, {
        t: 1,
        duration: c.animationDuration * 0.8,
        ease: 'outCubic',
        onUpdate: function () {
          var currentEnd = startAngle + (endAngle - startAngle) * proxy.t;
          node.setAttribute('d', arcFn({
            startAngle: startAngle,
            endAngle: currentEnd,
            innerRadius: arcData.innerRadius || 0,
            outerRadius: arcData.outerRadius || data.outerRadius
          }));
        },
      }, startTime + i * c.staggerDelay * 2);
    });
  }

  function _animatePieLabels(tl, labelsGroup, data, c, startTime) {
    var labels = labelsGroup.selectAll('text').nodes();
    labels.forEach(function (node, i) {
      anime.set(node, { opacity: 0 });
      tl.add(node, { opacity: 1, duration: 0.3, ease: 'outCubic' }, startTime + i * c.staggerDelay * 2);
    });
  }

  function _animateCenterNumber(tl, textSel, data, c, startTime) {
    var node = textSel.node();
    anime.set(node, { opacity: 0 });
    tl.add(node, { opacity: 1, duration: 0.3, ease: 'outCubic' }, startTime);
    if (data.targetValue != null) {
      var proxy = { val: 0 };
      tl.add(proxy, {
        val: data.targetValue,
        duration: c.countDuration,
        ease: 'outCubic',
        modifier: anime.utils.snap(1),
        onUpdate: function () {
          node.textContent = fmtValue(proxy.val, c);
        },
      }, startTime + 0.1);
    }
  }

  function _animateKPINumber(tl, textSel, data, c, startTime) {
    var node = textSel.node();
    anime.set(node, { opacity: 0 });
    tl.add(node, { opacity: 1, duration: 0.2, ease: 'outCubic' }, startTime);
    var proxy = { val: 0 };
    tl.add(proxy, {
      val: data.targetValue,
      duration: c.countDuration,
      ease: 'outQuart',
      modifier: anime.utils.snap(data.snap || 1),
      onUpdate: function () {
        node.textContent = fmtValue(proxy.val, c);
      },
    }, startTime + 0.1);
  }

  function _animateValueLabels(tl, labelsGroup, data, c, startTime) {
    var labels = labelsGroup.selectAll('text').nodes();
    labels.forEach(function (node, i) {
      var targetVal = parseFloat(node.getAttribute('data-value'));
      anime.set(node, { opacity: 0 });
      tl.add(node, { opacity: 1, duration: 0.15, ease: 'outCubic' }, startTime + i * c.staggerDelay);
      if (!isNaN(targetVal) && c.showValues) {
        var proxy = { val: 0 };
        tl.add(proxy, {
          val: targetVal,
          duration: c.countDuration * 0.6,
          ease: 'outCubic',
          modifier: anime.utils.snap(targetVal % 1 === 0 ? 1 : 0.1),
          onUpdate: function () {
            node.textContent = fmtValue(proxy.val, c);
          },
        }, startTime + i * c.staggerDelay);
      }
    });
  }

  function _animateGaugeArc(tl, arcSel, data, c, startTime) {
    var node = arcSel.node();
    var arcFn = data.arcFn;
    var startAngle = data.startAngle;
    var endAngle = data.endAngle;
    var proxy = { t: 0 };
    node.setAttribute('d', arcFn({ startAngle: startAngle, endAngle: startAngle }));
    tl.add(proxy, {
      t: 1,
      duration: c.animationDuration,
      ease: 'outCubic',
      onUpdate: function () {
        var cur = startAngle + (endAngle - startAngle) * proxy.t;
        node.setAttribute('d', arcFn({ startAngle: startAngle, endAngle: cur }));
      },
    }, startTime);
  }

  function _animateGaugeNeedle(tl, needleSel, data, c, startTime) {
    var node = needleSel.node();
    node.style.transformBox = 'fill-box';
    anime.set(node, { rotate: data.startDeg, transformOrigin: '50% 100%' });
    tl.add(node, {
      rotate: data.endDeg,
      duration: c.animationDuration * 0.8,
      ease: 'outQuart',
    }, startTime);
  }

  function _animateStackedBars(tl, barsGroup, data, c, startTime) {
    var groups = barsGroup.selectAll('g.stack-group').nodes();
    groups.forEach(function (groupNode, gi) {
      var rects = d3.select(groupNode).selectAll('rect').nodes();
      rects.forEach(function (node, si) {
        var targetH = parseFloat(node.getAttribute('data-target-h'));
        var targetY = parseFloat(node.getAttribute('data-target-y'));
        var baseY = parseFloat(node.getAttribute('data-base-y'));
        anime.set(node, { y: baseY, height: 0, opacity: 0 });
        var delay = startTime + gi * c.staggerDelay + si * c.staggerDelay * 0.5;
        tl.add(node, { opacity: 1, duration: 0.05, ease: 'linear' }, delay);
        tl.add(node, {
          y: targetY, height: targetH,
          duration: c.animationDuration * 0.8,
          ease: 'outCubic',
        }, delay);
      });
    });
  }

  function _animateGroupedBars(tl, barsGroup, data, c, startTime) {
    var groups = barsGroup.selectAll('g.group-cluster').nodes();
    groups.forEach(function (groupNode, gi) {
      var rects = d3.select(groupNode).selectAll('rect').nodes();
      rects.forEach(function (node, si) {
        var targetH = parseFloat(node.getAttribute('data-target-h'));
        var targetY = parseFloat(node.getAttribute('data-target-y'));
        var baseY = parseFloat(node.getAttribute('data-base-y'));
        anime.set(node, { y: baseY, height: 0, opacity: 0 });
        var delay = startTime + gi * c.staggerDelay * 1.5 + si * c.staggerDelay;
        tl.add(node, { opacity: 1, duration: 0.05, ease: 'linear' }, delay);
        tl.add(node, {
          y: targetY, height: targetH,
          duration: c.animationDuration,
          ease: 'outCubic',
        }, delay);
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // CHART RENDERERS
  // ══════════════════════════════════════════════════════════════════════════════

  // ── Bar Chart ───────────────────────────────────────────────────────────────

  function barChart(container, data, cfg) {
    var c = resolveConfig(cfg);
    var svg = createSVG(container, c);
    var g = svg.append('g').attr('transform', 'translate(' + c.margin.left + ',' + c.margin.top + ')');
    var elements = [];

    var titles = addTitle(svg, c);
    titles.forEach(function (el, idx) {
      elements.push({ el: el, type: idx === 0 ? 'title' : 'subtitle' });
    });

    // Scales
    var x = d3.scaleBand()
      .domain(data.map(function (d) { return d.label; }))
      .range([0, c.innerWidth])
      .padding(0.25);

    var yMax = d3.max(data, function (d) { return d.value; }) * 1.15;
    var y = d3.scaleLinear()
      .domain([0, yMax])
      .range([c.innerHeight, 0])
      .nice();

    // Grid
    if (c.showGrid) {
      var gridG = g.append('g').attr('class', 'grid');
      gridG.call(
        d3.axisLeft(y).tickSize(-c.innerWidth).tickFormat('')
      );
      gridG.selectAll('line').attr('stroke', c.theme.grid).attr('stroke-width', 1);
      gridG.select('.domain').remove();
      elements.push({ el: gridG, type: 'grid' });
    }

    // Axes
    var xAxisG = g.append('g')
      .attr('transform', 'translate(0,' + c.innerHeight + ')')
      .call(d3.axisBottom(x).tickSize(0));
    xAxisG.select('.domain').attr('stroke', c.theme.axis);
    xAxisG.selectAll('text').attr('fill', c.theme.textMuted).attr('font-size', c.axisTickSize);
    elements.push({ el: xAxisG, type: 'axis' });

    var yAxisG = g.append('g')
      .call(d3.axisLeft(y).ticks(6));
    yAxisG.select('.domain').attr('stroke', c.theme.axis);
    yAxisG.selectAll('text').attr('fill', c.theme.textMuted).attr('font-size', c.axisTickSize);
    yAxisG.selectAll('line').attr('stroke', c.theme.axis);
    elements.push({ el: yAxisG, type: 'axis' });

    // Axis labels
    addAxisLabels(svg, c).forEach(function (el) {
      elements.push({ el: el, type: 'axis-label' });
    });

    // Bars
    var barsG = g.append('g').attr('class', 'bars');
    var barRects = barsG.selectAll('rect')
      .data(data)
      .enter().append('rect')
      .attr('x', function (d) { return x(d.label); })
      .attr('y', function (d) { return y(d.value); })
      .attr('width', x.bandwidth())
      .attr('height', function (d) { return c.innerHeight - y(d.value); })
      .attr('fill', function (d, i) { return d.color || colorAt(c.colors, i); })
      .attr('rx', 3)
      .attr('data-target-h', function (d) { return c.innerHeight - y(d.value); })
      .attr('data-target-y', function (d) { return y(d.value); })
      .attr('data-base-y', c.innerHeight);
    if (c.barStroke && c.barStrokeWidth > 0) {
      barRects.attr('stroke', c.barStroke).attr('stroke-width', c.barStrokeWidth);
    }
    elements.push({ el: barsG, type: 'bar', data: { count: data.length } });

    // Value labels
    if (c.showValues) {
      var valG = g.append('g').attr('class', 'value-labels');
      valG.selectAll('text')
        .data(data)
        .enter().append('text')
        .attr('x', function (d) { return x(d.label) + x.bandwidth() / 2; })
        .attr('y', function (d) { return y(d.value) - 12; })
        .attr('text-anchor', 'middle')
        .attr('font-size', c.dataLabelSize)
        .attr('font-weight', 600)
        .attr('fill', c.valueLabelColor || c.theme.text)
        .attr('data-value', function (d) { return d.value; })
        .text(function (d) { return fmtValue(d.value, c); });
      elements.push({ el: valG, type: 'value-labels', data: { count: data.length } });
    }

    // Legend
    if (c.showLegend) {
      var legendG = _buildLegend(svg, data, c);
      elements.push({ el: legendG, type: 'legend' });
    }

    return new Animatable(elements, c);
  }

  // ── Horizontal Bar Chart ────────────────────────────────────────────────────

  function horizontalBarChart(container, data, cfg) {
    var c = resolveConfig(cfg);
    var svg = createSVG(container, c);
    var g = svg.append('g').attr('transform', 'translate(' + c.margin.left + ',' + c.margin.top + ')');
    var elements = [];

    var titles = addTitle(svg, c);
    titles.forEach(function (el, idx) {
      elements.push({ el: el, type: idx === 0 ? 'title' : 'subtitle' });
    });

    var y = d3.scaleBand()
      .domain(data.map(function (d) { return d.label; }))
      .range([0, c.innerHeight])
      .padding(0.25);

    var xMax = d3.max(data, function (d) { return d.value; }) * 1.15;
    var x = d3.scaleLinear()
      .domain([0, xMax])
      .range([0, c.innerWidth])
      .nice();

    // Grid
    if (c.showGrid) {
      var gridG = g.append('g').attr('class', 'grid');
      gridG.call(d3.axisBottom(x).tickSize(c.innerHeight).tickFormat(''));
      gridG.selectAll('line').attr('stroke', c.theme.grid).attr('stroke-width', 1);
      gridG.select('.domain').remove();
      elements.push({ el: gridG, type: 'grid' });
    }

    // Axes
    var yAxisG = g.append('g')
      .call(d3.axisLeft(y).tickSize(0));
    yAxisG.select('.domain').attr('stroke', c.theme.axis);
    yAxisG.selectAll('text').attr('fill', c.theme.textMuted).attr('font-size', c.axisTickSize);
    elements.push({ el: yAxisG, type: 'axis' });

    var xAxisG = g.append('g')
      .attr('transform', 'translate(0,' + c.innerHeight + ')')
      .call(d3.axisBottom(x).ticks(6));
    xAxisG.select('.domain').attr('stroke', c.theme.axis);
    xAxisG.selectAll('text').attr('fill', c.theme.textMuted).attr('font-size', c.axisTickSize);
    xAxisG.selectAll('line').attr('stroke', c.theme.axis);
    elements.push({ el: xAxisG, type: 'axis' });

    addAxisLabels(svg, c).forEach(function (el) {
      elements.push({ el: el, type: 'axis-label' });
    });

    // Bars
    var barsG = g.append('g').attr('class', 'h-bars');
    var hBarRects = barsG.selectAll('rect')
      .data(data)
      .enter().append('rect')
      .attr('x', 0)
      .attr('y', function (d) { return y(d.label); })
      .attr('width', function (d) { return x(d.value); })
      .attr('height', y.bandwidth())
      .attr('fill', function (d, i) { return d.color || colorAt(c.colors, i); })
      .attr('rx', 3)
      .attr('data-target-w', function (d) { return x(d.value); });
    if (c.barStroke && c.barStrokeWidth > 0) {
      hBarRects.attr('stroke', c.barStroke).attr('stroke-width', c.barStrokeWidth);
    }
    elements.push({ el: barsG, type: 'h-bar', data: { count: data.length } });

    // Value labels
    if (c.showValues) {
      var valG = g.append('g').attr('class', 'value-labels');
      valG.selectAll('text')
        .data(data)
        .enter().append('text')
        .attr('x', function (d) { return x(d.value) + 12; })
        .attr('y', function (d) { return y(d.label) + y.bandwidth() / 2 + 5; })
        .attr('font-size', c.dataLabelSize)
        .attr('font-weight', 600)
        .attr('fill', c.valueLabelColor || c.theme.text)
        .attr('data-value', function (d) { return d.value; })
        .text(function (d) { return fmtValue(d.value, c); });
      elements.push({ el: valG, type: 'value-labels', data: { count: data.length } });
    }

    return new Animatable(elements, c);
  }

  // ── Line Chart ──────────────────────────────────────────────────────────────

  function lineChart(container, data, cfg) {
    var c = resolveConfig(cfg);
    var svg = createSVG(container, c);
    var g = svg.append('g').attr('transform', 'translate(' + c.margin.left + ',' + c.margin.top + ')');
    var elements = [];

    var titles = addTitle(svg, c);
    titles.forEach(function (el, idx) {
      elements.push({ el: el, type: idx === 0 ? 'title' : 'subtitle' });
    });

    // Determine if multi-series
    var isMulti = Array.isArray(data[0] && data[0].values);
    var seriesData;
    if (isMulti) {
      seriesData = data; // [{label, values: [{x, y}]}]
    } else {
      seriesData = [{ label: 'default', values: data }]; // [{label, value}] → single series
    }

    // Flatten for scales
    var allPoints = [];
    seriesData.forEach(function (s) {
      s.values.forEach(function (v) { allPoints.push(v); });
    });

    var x = d3.scalePoint()
      .domain(allPoints.map(function (d) { return d.label || d.x; }).filter(function (v, i, a) { return a.indexOf(v) === i; }))
      .range([0, c.innerWidth])
      .padding(0.5);

    var yMax = d3.max(allPoints, function (d) { return d.value || d.y; }) * 1.15;
    var y = d3.scaleLinear()
      .domain([0, yMax])
      .range([c.innerHeight, 0])
      .nice();

    // Grid
    if (c.showGrid) {
      var gridG = g.append('g').attr('class', 'grid');
      gridG.call(d3.axisLeft(y).tickSize(-c.innerWidth).tickFormat(''));
      gridG.selectAll('line').attr('stroke', c.theme.grid).attr('stroke-width', 1);
      gridG.select('.domain').remove();
      elements.push({ el: gridG, type: 'grid' });
    }

    // Axes
    var xAxisG = g.append('g')
      .attr('transform', 'translate(0,' + c.innerHeight + ')')
      .call(d3.axisBottom(x).tickSize(0));
    xAxisG.select('.domain').attr('stroke', c.theme.axis);
    xAxisG.selectAll('text').attr('fill', c.theme.textMuted).attr('font-size', c.axisTickSize);
    elements.push({ el: xAxisG, type: 'axis' });

    var yAxisG = g.append('g')
      .call(d3.axisLeft(y).ticks(6));
    yAxisG.select('.domain').attr('stroke', c.theme.axis);
    yAxisG.selectAll('text').attr('fill', c.theme.textMuted).attr('font-size', c.axisTickSize);
    yAxisG.selectAll('line').attr('stroke', c.theme.axis);
    elements.push({ el: yAxisG, type: 'axis' });

    addAxisLabels(svg, c).forEach(function (el) {
      elements.push({ el: el, type: 'axis-label' });
    });

    // Line paths + dots per series
    seriesData.forEach(function (series, si) {
      var color = colorAt(c.colors, si);

      var lineFn = d3.line()
        .x(function (d) { return x(d.label || d.x); })
        .y(function (d) { return y(d.value || d.y); })
        .curve(d3.curveMonotoneX);

      var path = g.append('path')
        .datum(series.values)
        .attr('fill', 'linear')
        .attr('stroke', color)
        .attr('stroke-width', 3)
        .attr('d', lineFn);

      elements.push({ el: path, type: 'line-path' });

      // Dots
      var dotsG = g.append('g').attr('class', 'dots-' + si);
      dotsG.selectAll('circle')
        .data(series.values)
        .enter().append('circle')
        .attr('cx', function (d) { return x(d.label || d.x); })
        .attr('cy', function (d) { return y(d.value || d.y); })
        .attr('r', 5)
        .attr('data-target-r', 5)
        .attr('fill', color)
        .attr('stroke', c.theme.bg === '#181818' ? '#181818' : '#ffffff')
        .attr('stroke-width', 2);
      elements.push({ el: dotsG, type: 'dots', data: { count: series.values.length } });
    });

    // Value labels (single series only for clarity)
    if (c.showValues && !isMulti) {
      var valG = g.append('g').attr('class', 'value-labels');
      valG.selectAll('text')
        .data(data)
        .enter().append('text')
        .attr('x', function (d) { return x(d.label || d.x); })
        .attr('y', function (d) { return y(d.value || d.y) - 14; })
        .attr('text-anchor', 'middle')
        .attr('font-size', c.dataLabelSize)
        .attr('font-weight', 600)
        .attr('fill', c.theme.text)
        .attr('data-value', function (d) { return d.value || d.y; })
        .text(function (d) { return fmtValue(d.value || d.y, c); });
      elements.push({ el: valG, type: 'value-labels', data: { count: data.length } });
    }

    // Legend for multi-series
    if (isMulti && c.showLegend !== false) {
      var legendData = seriesData.map(function (s, i) {
        return { label: s.label, color: colorAt(c.colors, i) };
      });
      var legendG = _buildLegend(svg, legendData, c);
      elements.push({ el: legendG, type: 'legend' });
    }

    return new Animatable(elements, c);
  }

  // ── Area Chart ──────────────────────────────────────────────────────────────

  function areaChart(container, data, cfg) {
    var c = resolveConfig(cfg);
    var svg = createSVG(container, c);
    var g = svg.append('g').attr('transform', 'translate(' + c.margin.left + ',' + c.margin.top + ')');
    var elements = [];

    var titles = addTitle(svg, c);
    titles.forEach(function (el, idx) {
      elements.push({ el: el, type: idx === 0 ? 'title' : 'subtitle' });
    });

    var x = d3.scalePoint()
      .domain(data.map(function (d) { return d.label; }))
      .range([0, c.innerWidth])
      .padding(0.5);

    var yMax = d3.max(data, function (d) { return d.value; }) * 1.15;
    var y = d3.scaleLinear()
      .domain([0, yMax])
      .range([c.innerHeight, 0])
      .nice();

    // Grid
    if (c.showGrid) {
      var gridG = g.append('g').attr('class', 'grid');
      gridG.call(d3.axisLeft(y).tickSize(-c.innerWidth).tickFormat(''));
      gridG.selectAll('line').attr('stroke', c.theme.grid).attr('stroke-width', 1);
      gridG.select('.domain').remove();
      elements.push({ el: gridG, type: 'grid' });
    }

    // Axes
    var xAxisG = g.append('g')
      .attr('transform', 'translate(0,' + c.innerHeight + ')')
      .call(d3.axisBottom(x).tickSize(0));
    xAxisG.select('.domain').attr('stroke', c.theme.axis);
    xAxisG.selectAll('text').attr('fill', c.theme.textMuted).attr('font-size', c.axisTickSize);
    elements.push({ el: xAxisG, type: 'axis' });

    var yAxisG = g.append('g').call(d3.axisLeft(y).ticks(6));
    yAxisG.select('.domain').attr('stroke', c.theme.axis);
    yAxisG.selectAll('text').attr('fill', c.theme.textMuted).attr('font-size', c.axisTickSize);
    yAxisG.selectAll('line').attr('stroke', c.theme.axis);
    elements.push({ el: yAxisG, type: 'axis' });

    addAxisLabels(svg, c).forEach(function (el) {
      elements.push({ el: el, type: 'axis-label' });
    });

    var color = colorAt(c.colors, 0);

    // Area fill
    var areaFn = d3.area()
      .x(function (d) { return x(d.label); })
      .y0(c.innerHeight)
      .y1(function (d) { return y(d.value); })
      .curve(d3.curveMonotoneX);

    var areaPath = g.append('path')
      .datum(data)
      .attr('fill', color)
      .attr('fill-opacity', 0.2)
      .attr('d', areaFn);
    elements.push({ el: areaPath, type: 'area-fill' });

    // Line
    var lineFn = d3.line()
      .x(function (d) { return x(d.label); })
      .y(function (d) { return y(d.value); })
      .curve(d3.curveMonotoneX);

    var linePath = g.append('path')
      .datum(data)
      .attr('fill', 'linear')
      .attr('stroke', color)
      .attr('stroke-width', 3)
      .attr('d', lineFn);
    elements.push({ el: linePath, type: 'line-path' });

    // Dots
    var dotsG = g.append('g').attr('class', 'dots');
    dotsG.selectAll('circle')
      .data(data)
      .enter().append('circle')
      .attr('cx', function (d) { return x(d.label); })
      .attr('cy', function (d) { return y(d.value); })
      .attr('r', 5)
      .attr('data-target-r', 5)
      .attr('fill', color)
      .attr('stroke', c.theme.bg === '#181818' ? '#181818' : '#ffffff')
      .attr('stroke-width', 2);
    elements.push({ el: dotsG, type: 'dots', data: { count: data.length } });

    return new Animatable(elements, c);
  }

  // ── Pie Chart ───────────────────────────────────────────────────────────────

  function pieChart(container, data, cfg) {
    return _buildPieDonut(container, data, cfg, 0);
  }

  // ── Donut Chart ─────────────────────────────────────────────────────────────

  function donutChart(container, data, cfg) {
    return _buildPieDonut(container, data, cfg, 0.55);
  }

  function _buildPieDonut(container, data, cfg, innerRadiusRatio) {
    var c = resolveConfig(cfg);
    var svg = createSVG(container, c);
    var elements = [];

    var titles = addTitle(svg, c);
    titles.forEach(function (el, idx) {
      elements.push({ el: el, type: idx === 0 ? 'title' : 'subtitle' });
    });

    var radius = Math.min(c.innerWidth, c.innerHeight) / 2 * 0.85;
    var innerRadius = radius * innerRadiusRatio;
    var cx = c.width / 2;
    var cy = c.margin.top + c.innerHeight / 2 + 10;

    var pieFn = d3.pie()
      .value(function (d) { return d.value; })
      .sort(null)
      .padAngle(0.02);

    var arcFn = d3.arc()
      .innerRadius(innerRadius)
      .outerRadius(radius);

    var labelArcFn = d3.arc()
      .innerRadius(radius * 0.7)
      .outerRadius(radius * 0.7);

    var arcs = pieFn(data);

    var pieG = svg.append('g')
      .attr('transform', 'translate(' + cx + ',' + cy + ')');

    // Slices
    var slicesG = pieG.append('g').attr('class', 'slices');
    slicesG.selectAll('path')
      .data(arcs)
      .enter().append('path')
      .attr('d', arcFn)
      .attr('fill', function (d, i) { return d.data.color || colorAt(c.colors, i); })
      .attr('stroke', c.theme.bg === '#181818' ? '#181818' : '#ffffff')
      .attr('stroke-width', 2);

    var arcData = arcs.map(function (d) {
      return {
        startAngle: d.startAngle,
        endAngle: d.endAngle,
        innerRadius: innerRadius,
        outerRadius: radius,
      };
    });
    elements.push({ el: slicesG, type: 'pie-slices', data: { arcFn: arcFn, arcs: arcData, outerRadius: radius } });

    // Labels
    var labelsG = pieG.append('g').attr('class', 'pie-labels');
    labelsG.selectAll('text')
      .data(arcs)
      .enter().append('text')
      .attr('transform', function (d) {
        var pos = labelArcFn.centroid(d);
        // Push labels outside for small slices
        var midAngle = (d.startAngle + d.endAngle) / 2;
        if (innerRadiusRatio > 0) {
          var outerPos = d3.arc().innerRadius(radius * 1.15).outerRadius(radius * 1.15).centroid(d);
          return 'translate(' + outerPos + ')';
        }
        return 'translate(' + pos + ')';
      })
      .attr('text-anchor', 'middle')
      .attr('font-size', c.dataLabelSize)
      .attr('font-weight', 600)
      .attr('fill', c.theme.text)
      .text(function (d) {
        var pct = ((d.endAngle - d.startAngle) / (2 * Math.PI) * 100).toFixed(0);
        return d.data.label + ' ' + pct + '%';
      });
    elements.push({ el: labelsG, type: 'pie-labels', data: { count: data.length } });

    // Center label for donut
    if (innerRadiusRatio > 0) {
      var total = d3.sum(data, function (d) { return d.value; });
      var centerText = pieG.append('text')
        .attr('text-anchor', 'middle')
        .attr('dy', '0.1em')
        .attr('font-size', c.titleSize)
        .attr('font-weight', 700)
        .attr('fill', c.theme.text)
        .text(fmtValue(total, c));
      elements.push({ el: centerText, type: 'center-label', data: { targetValue: total } });

      if (c.title) {
        // Small label below the number
        pieG.append('text')
          .attr('text-anchor', 'middle')
          .attr('dy', '2.2em')
          .attr('font-size', c.dataLabelSize)
          .attr('fill', c.theme.textMuted)
          .text('Total');
      }
    }

    return new Animatable(elements, c);
  }

  // ── Funnel Chart ─────────────────────────────────────────────────────────────

  function funnelChart(container, data, cfg) {
    var c = resolveConfig(cfg);
    var svg = createSVG(container, c);
    var g = svg.append('g').attr('transform', 'translate(' + c.margin.left + ',' + c.margin.top + ')');
    var elements = [];

    var titles = addTitle(svg, c);
    titles.forEach(function (el, idx) {
      elements.push({ el: el, type: idx === 0 ? 'title' : 'subtitle' });
    });

    var sorted = data.slice().sort(function (a, b) { return b.value - a.value; });
    var maxV = d3.max(sorted, function (d) { return d.value; }) || 1;
    var n = sorted.length;
    var gap = 8;
    var rowH = n > 0 ? Math.max(18, (c.innerHeight - gap * Math.max(0, n - 1)) / n) : 0;

    var funnelG = g.append('g').attr('class', 'funnel');
    var funnelRects = funnelG.selectAll('rect')
      .data(sorted)
      .enter().append('rect')
      .attr('y', function (d, i) { return i * (rowH + gap); })
      .attr('x', function (d) {
        var w = (d.value / maxV) * c.innerWidth;
        return (c.innerWidth - w) / 2;
      })
      .attr('width', function (d) { return (d.value / maxV) * c.innerWidth; })
      .attr('height', rowH)
      .attr('rx', 4)
      .attr('fill', function (d, i) { return d.color || colorAt(c.colors, i); })
      .attr('data-target-h', function () { return rowH; })
      .attr('data-target-y', function (d, i) { return i * (rowH + gap); })
      .attr('data-base-y', function (d, i) { return i * (rowH + gap) + rowH; });
    if (c.barStroke && c.barStrokeWidth > 0) {
      funnelRects.attr('stroke', c.barStroke).attr('stroke-width', c.barStrokeWidth);
    }
    elements.push({ el: funnelG, type: 'bar', data: { count: n } });

    var labG = g.append('g').attr('class', 'funnel-labels');
    labG.selectAll('text')
      .data(sorted)
      .enter().append('text')
      .attr('x', 8)
      .attr('y', function (d, i) { return i * (rowH + gap) + rowH / 2 + 6; })
      .attr('font-size', c.dataLabelSize)
      .attr('font-weight', 600)
      .attr('fill', c.valueLabelColor || c.theme.text)
      .text(function (d) { return d.label + ' — ' + fmtValue(d.value, c); });
    elements.push({ el: labG, type: 'value-labels', data: { count: n } });

    return new Animatable(elements, c);
  }

  // ── Scatter Plot ────────────────────────────────────────────────────────────

  function scatterChart(container, data, cfg) {
    var c = resolveConfig(cfg);
    var svg = createSVG(container, c);
    var g = svg.append('g').attr('transform', 'translate(' + c.margin.left + ',' + c.margin.top + ')');
    var elements = [];

    var titles = addTitle(svg, c);
    titles.forEach(function (el, idx) {
      elements.push({ el: el, type: idx === 0 ? 'title' : 'subtitle' });
    });

    // For scatter, data is [{label, value, x?, size?}] or [{x, y, size?, color?}]
    var useXY = data[0] && data[0].x != null && data[0].y != null;

    var xDomain, yDomain;
    if (useXY) {
      xDomain = [d3.min(data, function (d) { return d.x; }) * 0.9, d3.max(data, function (d) { return d.x; }) * 1.1];
      yDomain = [0, d3.max(data, function (d) { return d.y; }) * 1.15];
    } else {
      xDomain = data.map(function (d) { return d.label; });
      yDomain = [0, d3.max(data, function (d) { return d.value; }) * 1.15];
    }

    var x = useXY
      ? d3.scaleLinear().domain(xDomain).range([0, c.innerWidth]).nice()
      : d3.scalePoint().domain(xDomain).range([0, c.innerWidth]).padding(0.5);

    var y = d3.scaleLinear().domain(yDomain).range([c.innerHeight, 0]).nice();

    // Grid
    if (c.showGrid) {
      var gridG = g.append('g').attr('class', 'grid');
      gridG.call(d3.axisLeft(y).tickSize(-c.innerWidth).tickFormat(''));
      gridG.selectAll('line').attr('stroke', c.theme.grid);
      gridG.select('.domain').remove();
      elements.push({ el: gridG, type: 'grid' });
    }

    // Axes
    var xAxisG = g.append('g')
      .attr('transform', 'translate(0,' + c.innerHeight + ')')
      .call(useXY ? d3.axisBottom(x).ticks(8) : d3.axisBottom(x).tickSize(0));
    xAxisG.select('.domain').attr('stroke', c.theme.axis);
    xAxisG.selectAll('text').attr('fill', c.theme.textMuted).attr('font-size', c.axisTickSize);
    elements.push({ el: xAxisG, type: 'axis' });

    var yAxisG = g.append('g').call(d3.axisLeft(y).ticks(6));
    yAxisG.select('.domain').attr('stroke', c.theme.axis);
    yAxisG.selectAll('text').attr('fill', c.theme.textMuted).attr('font-size', c.axisTickSize);
    yAxisG.selectAll('line').attr('stroke', c.theme.axis);
    elements.push({ el: yAxisG, type: 'axis' });

    addAxisLabels(svg, c).forEach(function (el) {
      elements.push({ el: el, type: 'axis-label' });
    });

    // Dots
    var dotsG = g.append('g').attr('class', 'scatter-dots');
    dotsG.selectAll('circle')
      .data(data)
      .enter().append('circle')
      .attr('cx', function (d) { return x(useXY ? d.x : d.label); })
      .attr('cy', function (d) { return y(useXY ? d.y : d.value); })
      .attr('r', function (d) { return d.size || 6; })
      .attr('data-target-r', function (d) { return d.size || 6; })
      .attr('fill', function (d, i) { return d.color || colorAt(c.colors, i % c.colors.length); })
      .attr('fill-opacity', 0.75)
      .attr('stroke', function (d, i) { return d.color || colorAt(c.colors, i % c.colors.length); })
      .attr('stroke-width', 1.5)
      .attr('stroke-opacity', 1);
    elements.push({ el: dotsG, type: 'scatter-dots', data: { count: data.length } });

    return new Animatable(elements, c);
  }

  // ── Number / KPI Display ────────────────────────────────────────────────────

  function numberChart(container, data, cfg) {
    var c = resolveConfig(cfg);
    var svg = createSVG(container, c);
    var elements = [];

    var val = typeof data === 'object' && !Array.isArray(data) ? data.value : data;
    var label = typeof data === 'object' && !Array.isArray(data) ? data.label : (c.title || '');

    // Big number in center
    var numText = svg.append('text')
      .attr('x', c.width / 2)
      .attr('y', c.height / 2 + 20)
      .attr('text-anchor', 'middle')
      .attr('font-size', 140)
      .attr('font-weight', 700)
      .attr('fill', colorAt(c.colors, 0))
      .text(fmtValue(val, c));

    var snap = 1;
    if (val > 10000) snap = 100;
    else if (val > 1000) snap = 10;
    else if (val < 1) snap = 0.01;

    elements.push({ el: numText, type: 'kpi-number', data: { targetValue: val, snap: snap } });

    // Label below
    if (label) {
      var labelText = svg.append('text')
        .attr('x', c.width / 2)
        .attr('y', c.height / 2 + 100)
        .attr('text-anchor', 'middle')
        .attr('font-size', Math.max(c.axisLabelSize + 4, 36))
        .attr('fill', c.theme.textMuted)
        .text(label);
      elements.push({ el: labelText, type: 'kpi-label' });
    }

    // Subtitle above
    if (c.subtitle) {
      var subText = svg.append('text')
        .attr('x', c.width / 2)
        .attr('y', c.height / 2 - 80)
        .attr('text-anchor', 'middle')
        .attr('font-size', c.axisLabelSize)
        .attr('fill', c.theme.textMuted)
        .text(c.subtitle);
      elements.push({ el: subText, type: 'kpi-label' });
    }

    return new Animatable(elements, c);
  }

  // ── Gauge Chart ─────────────────────────────────────────────────────────────

  function gaugeChart(container, data, cfg) {
    var c = resolveConfig(cfg);
    var svg = createSVG(container, c);
    var elements = [];

    var titles = addTitle(svg, c);
    titles.forEach(function (el, idx) {
      elements.push({ el: el, type: idx === 0 ? 'title' : 'subtitle' });
    });

    var val = typeof data === 'object' && !Array.isArray(data) ? data.value : data;
    var maxVal = (typeof data === 'object' && data.max) || cfg.max || 100;
    var ratio = Math.min(1, Math.max(0, val / maxVal));

    var cx = c.width / 2;
    var cy = c.margin.top + c.innerHeight * 0.6;
    var radius = Math.min(c.innerWidth, c.innerHeight) * 0.4;

    var startAngle = -Math.PI * 0.75;
    var endAngle = Math.PI * 0.75;
    var valueAngle = startAngle + (endAngle - startAngle) * ratio;

    var arcFnBg = d3.arc()
      .innerRadius(radius * 0.7)
      .outerRadius(radius)
      .startAngle(startAngle)
      .endAngle(endAngle)
      .cornerRadius(6);

    var arcFnVal = d3.arc()
      .innerRadius(radius * 0.7)
      .outerRadius(radius)
      .cornerRadius(6);

    var gaugeG = svg.append('g').attr('transform', 'translate(' + cx + ',' + cy + ')');

    // Background arc
    gaugeG.append('path')
      .attr('d', arcFnBg())
      .attr('fill', c.theme.grid);

    // Value arc
    var valArc = gaugeG.append('path')
      .attr('d', arcFnVal({ startAngle: startAngle, endAngle: valueAngle }))
      .attr('fill', colorAt(c.colors, 0));
    elements.push({
      el: valArc, type: 'gauge-arc',
      data: { arcFn: arcFnVal, startAngle: startAngle, endAngle: valueAngle }
    });

    // Center number
    var numText = gaugeG.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '0.1em')
      .attr('font-size', Math.max(c.titleSize, 64))
      .attr('font-weight', 700)
      .attr('fill', c.theme.text)
      .text(fmtValue(val, c));
    elements.push({ el: numText, type: 'center-label', data: { targetValue: val } });

    // Min / Max labels
    var minPos = d3.arc().innerRadius(radius * 1.15).outerRadius(radius * 1.15)
      .startAngle(startAngle).endAngle(startAngle).centroid();
    var maxPos = d3.arc().innerRadius(radius * 1.15).outerRadius(radius * 1.15)
      .startAngle(endAngle).endAngle(endAngle).centroid();

    gaugeG.append('text')
      .attr('x', minPos[0]).attr('y', minPos[1])
      .attr('text-anchor', 'middle')
      .attr('font-size', c.axisLabelSize).attr('fill', c.theme.textMuted)
      .text('0');
    gaugeG.append('text')
      .attr('x', maxPos[0]).attr('y', maxPos[1])
      .attr('text-anchor', 'middle')
      .attr('font-size', c.axisLabelSize).attr('fill', c.theme.textMuted)
      .text(fmtValue(maxVal, c));

    return new Animatable(elements, c);
  }

  // ── Stacked Bar Chart ───────────────────────────────────────────────────────

  function stackedBarChart(container, data, cfg) {
    var c = resolveConfig(cfg);
    var svg = createSVG(container, c);
    var g = svg.append('g').attr('transform', 'translate(' + c.margin.left + ',' + c.margin.top + ')');
    var elements = [];

    var titles = addTitle(svg, c);
    titles.forEach(function (el, idx) {
      elements.push({ el: el, type: idx === 0 ? 'title' : 'subtitle' });
    });

    // Get keys from first item's values object
    var keys = Object.keys(data[0].values);

    var x = d3.scaleBand()
      .domain(data.map(function (d) { return d.label; }))
      .range([0, c.innerWidth])
      .padding(0.25);

    // Compute stack totals for y domain
    var maxTotal = d3.max(data, function (d) {
      return d3.sum(keys, function (k) { return d.values[k] || 0; });
    }) * 1.15;

    var y = d3.scaleLinear().domain([0, maxTotal]).range([c.innerHeight, 0]).nice();

    // Grid
    if (c.showGrid) {
      var gridG = g.append('g').attr('class', 'grid');
      gridG.call(d3.axisLeft(y).tickSize(-c.innerWidth).tickFormat(''));
      gridG.selectAll('line').attr('stroke', c.theme.grid);
      gridG.select('.domain').remove();
      elements.push({ el: gridG, type: 'grid' });
    }

    // Axes
    var xAxisG = g.append('g')
      .attr('transform', 'translate(0,' + c.innerHeight + ')')
      .call(d3.axisBottom(x).tickSize(0));
    xAxisG.select('.domain').attr('stroke', c.theme.axis);
    xAxisG.selectAll('text').attr('fill', c.theme.textMuted).attr('font-size', c.axisTickSize);
    elements.push({ el: xAxisG, type: 'axis' });

    var yAxisG = g.append('g').call(d3.axisLeft(y).ticks(6));
    yAxisG.select('.domain').attr('stroke', c.theme.axis);
    yAxisG.selectAll('text').attr('fill', c.theme.textMuted).attr('font-size', c.axisTickSize);
    yAxisG.selectAll('line').attr('stroke', c.theme.axis);
    elements.push({ el: yAxisG, type: 'axis' });

    addAxisLabels(svg, c).forEach(function (el) {
      elements.push({ el: el, type: 'axis-label' });
    });

    // Stacked bars
    var barsG = g.append('g').attr('class', 'stacked-bars');

    data.forEach(function (d, gi) {
      var groupG = barsG.append('g').attr('class', 'stack-group');
      var cumulative = 0;
      keys.forEach(function (key, ki) {
        var val = d.values[key] || 0;
        var barY = y(cumulative + val);
        var barH = c.innerHeight - y(val);
        var baseY = y(cumulative);

        groupG.append('rect')
          .attr('x', x(d.label))
          .attr('y', barY)
          .attr('width', x.bandwidth())
          .attr('height', barH)
          .attr('fill', colorAt(c.colors, ki))
          .attr('data-target-h', barH)
          .attr('data-target-y', barY)
          .attr('data-base-y', baseY);

        cumulative += val;
      });
    });

    elements.push({ el: barsG, type: 'stacked-bars', data: { groupCount: data.length, keyCount: keys.length } });

    // Legend
    if (c.showLegend !== false) {
      var legendData = keys.map(function (k, i) {
        return { label: c.legendLabels ? (c.legendLabels[k] || k) : k, color: colorAt(c.colors, i) };
      });
      var legendG = _buildLegend(svg, legendData, c);
      elements.push({ el: legendG, type: 'legend' });
    }

    return new Animatable(elements, c);
  }

  // ── Grouped Bar Chart ───────────────────────────────────────────────────────

  function groupedBarChart(container, data, cfg) {
    var c = resolveConfig(cfg);
    var svg = createSVG(container, c);
    var g = svg.append('g').attr('transform', 'translate(' + c.margin.left + ',' + c.margin.top + ')');
    var elements = [];

    var titles = addTitle(svg, c);
    titles.forEach(function (el, idx) {
      elements.push({ el: el, type: idx === 0 ? 'title' : 'subtitle' });
    });

    var keys = Object.keys(data[0].values);

    var x0 = d3.scaleBand()
      .domain(data.map(function (d) { return d.label; }))
      .range([0, c.innerWidth])
      .padding(0.2);

    var x1 = d3.scaleBand()
      .domain(keys)
      .range([0, x0.bandwidth()])
      .padding(0.05);

    var yMax = d3.max(data, function (d) {
      return d3.max(keys, function (k) { return d.values[k] || 0; });
    }) * 1.15;

    var y = d3.scaleLinear().domain([0, yMax]).range([c.innerHeight, 0]).nice();

    // Grid
    if (c.showGrid) {
      var gridG = g.append('g').attr('class', 'grid');
      gridG.call(d3.axisLeft(y).tickSize(-c.innerWidth).tickFormat(''));
      gridG.selectAll('line').attr('stroke', c.theme.grid);
      gridG.select('.domain').remove();
      elements.push({ el: gridG, type: 'grid' });
    }

    // Axes
    var xAxisG = g.append('g')
      .attr('transform', 'translate(0,' + c.innerHeight + ')')
      .call(d3.axisBottom(x0).tickSize(0));
    xAxisG.select('.domain').attr('stroke', c.theme.axis);
    xAxisG.selectAll('text').attr('fill', c.theme.textMuted).attr('font-size', c.axisTickSize);
    elements.push({ el: xAxisG, type: 'axis' });

    var yAxisG = g.append('g').call(d3.axisLeft(y).ticks(6));
    yAxisG.select('.domain').attr('stroke', c.theme.axis);
    yAxisG.selectAll('text').attr('fill', c.theme.textMuted).attr('font-size', c.axisTickSize);
    yAxisG.selectAll('line').attr('stroke', c.theme.axis);
    elements.push({ el: yAxisG, type: 'axis' });

    addAxisLabels(svg, c).forEach(function (el) {
      elements.push({ el: el, type: 'axis-label' });
    });

    // Grouped bars
    var barsG = g.append('g').attr('class', 'grouped-bars');

    data.forEach(function (d) {
      var groupG = barsG.append('g')
        .attr('class', 'group-cluster')
        .attr('transform', 'translate(' + x0(d.label) + ', 0)');

      keys.forEach(function (key, ki) {
        var val = d.values[key] || 0;
        groupG.append('rect')
          .attr('x', x1(key))
          .attr('y', y(val))
          .attr('width', x1.bandwidth())
          .attr('height', c.innerHeight - y(val))
          .attr('fill', colorAt(c.colors, ki))
          .attr('rx', 2)
          .attr('data-target-h', c.innerHeight - y(val))
          .attr('data-target-y', y(val))
          .attr('data-base-y', c.innerHeight);
      });
    });

    elements.push({ el: barsG, type: 'grouped-bars', data: { groupCount: data.length, keyCount: keys.length } });

    // Legend
    if (c.showLegend !== false) {
      var legendData = keys.map(function (k, i) {
        return { label: c.legendLabels ? (c.legendLabels[k] || k) : k, color: colorAt(c.colors, i) };
      });
      var legendG = _buildLegend(svg, legendData, c);
      elements.push({ el: legendG, type: 'legend' });
    }

    return new Animatable(elements, c);
  }

  // ── Legend Builder ───────────────────────────────────────────────────────────

  function _buildLegend(svg, items, c) {
    var legendG = svg.append('g')
      .attr('class', 'legend')
      .attr('transform', 'translate(' + (c.width / 2) + ',' + (c.height - 30) + ')');

    var totalWidth = items.length * 120;
    var startX = -totalWidth / 2;

    items.forEach(function (item, i) {
      var lg = legendG.append('g')
        .attr('transform', 'translate(' + (startX + i * 120) + ', 0)');
      lg.append('rect')
        .attr('width', 14).attr('height', 14)
        .attr('rx', 3)
        .attr('fill', item.color || colorAt(c.colors, i));
      lg.append('text')
        .attr('x', 20).attr('y', 12)
        .attr('font-size', c.dataLabelSize)
        .attr('fill', c.legendTextColor || c.theme.textMuted)
        .text(item.label);
    });

    return legendG;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════════════════════════════════════════

  global.DreambyteCharts = {
    bar: barChart,
    horizontalBar: horizontalBarChart,
    line: lineChart,
    area: areaChart,
    pie: pieChart,
    donut: donutChart,
    funnel: funnelChart,
    scatter: scatterChart,
    number: numberChart,
    gauge: gaugeChart,
    stackedBar: stackedBarChart,
    groupedBar: groupedBarChart,
  };

})(typeof window !== 'undefined' ? window : this);
