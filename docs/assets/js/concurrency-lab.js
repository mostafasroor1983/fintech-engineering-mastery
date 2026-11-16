/* ============================================================
   ENGINEERING MASTERY — Concurrency & Failure Lab
   Interactive experiments: reproduce, understand, and fix
   concurrency and financial system failures.
   ============================================================ */

window.EM = window.EM || {};

EM.ConcurrencyLab = (function () {
  'use strict';

  /* ----------------------------------------------------------
     State
  ---------------------------------------------------------- */
  var _data        = null;   // cached { experiments: [...] }
  var _loadPromise = null;   // singleton fetch promise

  /* Simulation state — one active experiment at a time */
  var _simState = {
    expId:       null,
    currentStep: 0,
    totalSteps:  0,
    playing:     false,
    playTimer:   null,
    showSafe:    false,
    steps:       []
  };

  /* ----------------------------------------------------------
     Cleanup on navigation
  ---------------------------------------------------------- */
  window.addEventListener('hashchange', function () {
    if (_simState.playTimer) {
      clearInterval(_simState.playTimer);
      _simState.playTimer = null;
      _simState.playing   = false;
    }
  });

  /* ----------------------------------------------------------
     Data Loading
  ---------------------------------------------------------- */
  function _loadData() {
    if (_loadPromise) return _loadPromise;
    _loadPromise = fetch('data/concurrency-lab.json')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (json) {
        _data = json;
        return json;
      });
    return _loadPromise;
  }

  function _findExperiment(id) {
    if (!_data) return null;
    var list = _data.experiments || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  /* ----------------------------------------------------------
     Utilities
  ---------------------------------------------------------- */
  function _esc(str) {
    return EM.esc ? EM.esc(str) : String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _categoryColor(cat) {
    var c = (cat || '').toLowerCase();
    if (c.indexOf('java') !== -1)      return 'indigo';
    if (c.indexOf('async') !== -1)     return 'purple';
    if (c.indexOf('financial') !== -1) return 'green';
    return 'indigo';
  }

  function _categoryLabel(cat) {
    var c = (cat || '').toLowerCase();
    if (c.indexOf('java') !== -1)      return 'Java Concurrency';
    if (c.indexOf('async') !== -1)     return 'Async & Reactive';
    if (c.indexOf('financial') !== -1) return 'Financial Systems';
    return cat;
  }

  function _tagsHtml(tags) {
    if (!tags || !tags.length) return '';
    return '<div class="clab-card-tags">' +
      tags.map(function (t) {
        return '<span class="clab-tag">' + _esc(t) + '</span>';
      }).join('') +
    '</div>';
  }

  /* ----------------------------------------------------------
     =====================  INDEX PAGE  ======================
  ---------------------------------------------------------- */
  function renderIndex() {
    return _loadData().then(function (json) {
      var experiments = json.experiments || [];
      return _buildIndexHtml(experiments);
    });
  }

  function _buildIndexHtml(experiments) {
    var categories = ['ALL', 'JAVA CONCURRENCY', 'ASYNC & REACTIVE', 'FINANCIAL SYSTEMS'];

    var filterTabs = '<div class="clab-filter-tabs" role="tablist">' +
      categories.map(function (cat, i) {
        return '<button class="clab-filter-tab' + (i === 0 ? ' active' : '') + '" ' +
          'data-filter="' + _esc(cat) + '" ' +
          'role="tab" aria-selected="' + (i === 0 ? 'true' : 'false') + '" ' +
          'onclick="EM.ConcurrencyLab._filterCards(this)">' +
          _esc(cat) +
        '</button>';
      }).join('') +
    '</div>';

    var cards = experiments.map(function (exp) {
      var color = _categoryColor(exp.category);
      return '<div class="clab-card" data-category="' + _esc(_categoryLabel(exp.category).toUpperCase()) + '">' +
        '<div class="clab-card-header">' +
          '<span class="clab-card-category clab-cat-' + _esc(color) + '">' +
            _esc(_categoryLabel(exp.category)) +
          '</span>' +
        '</div>' +
        '<div class="clab-card-body">' +
          '<h3 class="clab-card-title">' + _esc(exp.title) + '</h3>' +
          '<p class="clab-card-subtitle">' + _esc(exp.subtitle || '') + '</p>' +
          _tagsHtml(exp.tags) +
        '</div>' +
        '<div class="clab-card-footer">' +
          '<button class="clab-card-btn" onclick="EM.Router.navigate(\'/concurrency-lab/' + _esc(exp.id) + '\')">' +
            'Start Experiment &rarr;' +
          '</button>' +
        '</div>' +
      '</div>';
    }).join('');

    return '<div class="clab-index">' +
      '<div class="clab-index-header">' +
        '<div class="clab-index-icon-wrap">' + (EM.Icons.lab || '') + '</div>' +
        '<div>' +
          '<h1 class="page-title">Concurrency &amp; Failure Lab</h1>' +
          '<p class="clab-index-subtitle">Interactive experiments: reproduce, understand, and fix concurrency and financial system failures</p>' +
        '</div>' +
      '</div>' +
      filterTabs +
      '<div class="clab-cards-grid" id="clab-cards-grid">' + cards + '</div>' +
    '</div>';
  }

  /* ----------------------------------------------------------
     ==================  EXPERIMENT DETAIL  ==================
  ---------------------------------------------------------- */
  function renderExperiment(id) {
    return _loadData().then(function () {
      var exp = _findExperiment(id);
      if (!exp) {
        return '<div class="clab-experiment"><p class="clab-error">Experiment &ldquo;' + _esc(id) + '&rdquo; not found.</p></div>';
      }
      return _buildExperimentHtml(exp);
    });
  }

  function _buildExperimentHtml(exp) {
    var color = _categoryColor(exp.category);

    /* ---- Breadcrumb ---- */
    var breadcrumb =
      '<nav class="clab-breadcrumb">' +
        '<a href="#" onclick="EM.Router.navigate(\'/concurrency-lab\');return false;">Concurrency Lab</a>' +
        '<span class="clab-bc-sep">&rsaquo;</span>' +
        '<span class="clab-bc-cat">' + _esc(_categoryLabel(exp.category)) + '</span>' +
        '<span class="clab-bc-sep">&rsaquo;</span>' +
        '<span class="clab-bc-current">' + _esc(exp.title) + '</span>' +
      '</nav>';

    /* ---- Header ---- */
    var diffBadge = exp.difficulty
      ? '<span class="badge badge-' + _esc(exp.difficulty) + '">' + _esc(exp.difficulty) + '</span>'
      : '';
    var mins = exp.estimatedMinutes || exp.estimatedTime;
    var timeBadge = mins
      ? '<span class="clab-time-badge">' + (EM.Icons.clock || '&#128336;') + ' ' + _esc(String(mins)) + ' min</span>'
      : '';

    var header =
      '<div class="clab-exp-header clab-accent-' + _esc(color) + '">' +
        '<div class="clab-exp-meta-top">' +
          '<span class="clab-card-category clab-cat-' + _esc(color) + '">' + _esc(_categoryLabel(exp.category)) + '</span>' +
          diffBadge + timeBadge +
        '</div>' +
        '<h1 class="clab-exp-title">' + _esc(exp.title) + '</h1>' +
        '<p class="clab-exp-subtitle">' + _esc(exp.subtitle || '') + '</p>' +
        _tagsHtml(exp.tags) +
      '</div>';

    /* ---- Tab bar ---- */
    var TABS = [
      { id: 'scenario',      label: 'Scenario'    },
      { id: 'bad-code',      label: 'Bad Code'    },
      { id: 'why-fails',     label: 'Why it Fails'},
      { id: 'simulation',    label: 'Simulation'  },
      { id: 'fix',           label: 'Fix'         },
      { id: 'alternatives',  label: 'Alternatives'},
      { id: 'tests',         label: 'Tests'       },
      { id: 'monitoring',    label: 'Monitoring'  },
      { id: 'production',    label: 'Production'  },
      { id: 'assessment',    label: 'Assessment'  }
    ];

    var tabBar =
      '<div class="clab-tabs" role="tablist">' +
        TABS.map(function (t, i) {
          return '<button class="clab-tab' + (i === 0 ? ' active' : '') + '" ' +
            'role="tab" data-panel="clab-panel-' + _esc(t.id) + '" ' +
            'aria-selected="' + (i === 0 ? 'true' : 'false') + '" ' +
            'onclick="EM.ConcurrencyLab._switchTab(this)">' +
            _esc(t.label) +
          '</button>';
        }).join('') +
      '</div>';

    /* ---- Panels ---- */
    var panels =
      '<div class="clab-panels">' +
        _panelScenario(exp) +
        _panelBadCode(exp) +
        _panelWhyFails(exp) +
        _panelSimulation(exp) +
        _panelFix(exp) +
        _panelAlternatives(exp) +
        _panelTests(exp) +
        _panelMonitoring(exp) +
        _panelProduction(exp) +
        _panelAssessment(exp) +
      '</div>';

    var html =
      '<div class="clab-experiment" data-exp-id="' + _esc(exp.id) + '">' +
        breadcrumb + header + tabBar + panels +
      '</div>';

    /* Schedule Prism highlight after injection */
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var container = document.querySelector('.clab-experiment');
        if (!container) return;
        container.querySelectorAll('pre code').forEach(function (el) {
          if (typeof Prism !== 'undefined') Prism.highlightElement(el);
        });
        /* Init production checklist */
        _initChecklist(exp.id);
      });
    });

    return html;
  }

  /* ----------------------------------------------------------
     Panel: Scenario
  ---------------------------------------------------------- */
  function _panelScenario(exp) {
    /* scenario is a plain string in the JSON */
    var scenarioText = (typeof exp.scenario === 'string') ? exp.scenario : (exp.scenario && exp.scenario.description) || exp.description || '';
    var impact       = exp.impact || (exp.scenario && exp.scenario.impact) || '';

    var lessons = '';
    if (exp.relatedLessons && exp.relatedLessons.length) {
      lessons = '<div class="clab-related-lessons">' +
        '<h4>Related Lessons</h4><ul>' +
        exp.relatedLessons.map(function (l) {
          /* relatedLessons is an array of lesson-id strings like "track-06-lesson-02" */
          if (typeof l === 'string') {
            var parts  = l.split('-');
            var trackN = parts[1] || '';
            var lessonN = parts[3] || '';
            var label  = 'Track ' + trackN + ' · Lesson ' + lessonN;
            /* Build a path: /tracks/:trackId/lessons/:lessonId */
            var trackId  = l.replace(/(lesson-\d+)$/, '').replace(/-$/, '');
            var route    = '/tracks/' + trackId + '/lessons/' + l;
            return '<li><a href="#" onclick="EM.Router.navigate(\'' + _esc(route) + '\');return false;">' + _esc(label) + '</a></li>';
          }
          return '<li><a href="#" onclick="EM.Router.navigate(\'' + _esc(l.path || '/') + '\');return false;">' + _esc(l.title || l) + '</a></li>';
        }).join('') +
        '</ul></div>';
    }

    return _wrapPanel('scenario', true,
      '<div class="clab-scenario-text">' + _esc(scenarioText) + '</div>' +
      (impact ? '<div class="clab-callout clab-callout-warn"><strong>&#9888; Impact:</strong> ' + _esc(impact) + '</div>' : '') +
      lessons
    );
  }

  /* ----------------------------------------------------------
     Panel: Bad Code
  ---------------------------------------------------------- */
  function _panelBadCode(exp) {
    /* incorrectCode is an array of strings in the JSON */
    var codeLines = exp.incorrectCode || (exp.badCode && exp.badCode.code ? [exp.badCode.code] : []);
    var code = Array.isArray(codeLines) ? codeLines.join('\n') : String(codeLines || '');
    var lang = (exp.badCode && exp.badCode.language) || 'java';

    /* incorrectAnnotations: [{line, note}] */
    var annotArr = exp.incorrectAnnotations || (exp.badCode && exp.badCode.annotations) || [];
    var annotations = '';
    if (annotArr.length) {
      annotations = '<div class="clab-annotations">' +
        annotArr.map(function (a) {
          return '<div class="clab-annotation"><span class="clab-ann-line">Line ' + _esc(String(a.line)) + '</span> ' + _esc(a.note || a.text || '') + '</div>';
        }).join('') +
      '</div>';
    }

    return _wrapPanel('bad-code', false,
      '<div class="clab-code-wrap">' +
        '<pre><code class="language-' + _esc(lang) + '">' + _esc(code) + '</code></pre>' +
      '</div>' +
      annotations
    );
  }

  /* ----------------------------------------------------------
     Panel: Why it Fails
  ---------------------------------------------------------- */
  function _panelWhyFails(exp) {
    var wf = exp.whyItFails || {};
    var body =
      '<div class="clab-why-text">' + _esc(wf.explanation || exp.failureExplanation || '') + '</div>';
    if (wf.jmmNote || exp.jmmNote) {
      body += '<div class="clab-callout clab-callout-info"><strong>JMM Note:</strong> ' + _esc(wf.jmmNote || exp.jmmNote) + '</div>';
    }
    return _wrapPanel('why-fails', false, body);
  }

  /* ----------------------------------------------------------
     Panel: Simulation
  ---------------------------------------------------------- */
  function _panelSimulation(exp) {
    var sim = exp.simulation || {};
    var buggySteps = sim.buggySteps || sim.steps || [];
    var safeSteps  = sim.safeSteps  || [];
    var totalSteps = buggySteps.length;

    var disclaimer =
      '<div class="clab-callout clab-callout-info clab-sim-disclaimer">' +
        '<strong>Note:</strong> This is a <em>conceptual</em> execution trace, not a live execution. ' +
        'Race conditions are non-deterministic and may not reproduce the same way on every JVM or machine.' +
      '</div>';

    var controls =
      '<div class="clab-sim-controls">' +
        '<button class="clab-sim-btn" title="Reset" onclick="EM.ConcurrencyLab._simReset()">&#9612;&#9612; Reset</button>' +
        '<button class="clab-sim-btn" title="Prev" onclick="EM.ConcurrencyLab._simPrev()">&#9664; Prev</button>' +
        '<button class="clab-sim-btn clab-sim-play-btn" id="clab-play-btn" title="Play/Pause" onclick="EM.ConcurrencyLab._simPlay()">&#9654; Play</button>' +
        '<button class="clab-sim-btn" title="Next" onclick="EM.ConcurrencyLab._simNext()">Next &#9654;</button>' +
        '<span class="clab-sim-step-info" id="clab-step-info">Step 0 of ' + _esc(String(totalSteps)) + '</span>' +
      '</div>';

    var toggle = safeSteps.length
      ? '<label class="clab-sim-toggle">' +
          '<input type="checkbox" onchange="EM.ConcurrencyLab._simToggleSafe(this.checked)" id="clab-safe-toggle"> ' +
          'Show Fixed Execution' +
        '</label>'
      : '';

    var vizHtml = _buildSimViz(sim, buggySteps);

    return _wrapPanel('simulation', false,
      disclaimer +
      '<div class="clab-sim-container" id="clab-sim-container">' +
        controls + toggle + vizHtml +
        '<div class="clab-sim-annotation" id="clab-sim-annotation"></div>' +
      '</div>'
    );
  }

  function _buildSimViz(sim, steps) {
    var type = sim.type || 'thread-timeline';
    if (type === 'thread-timeline') return _buildThreadTimeline(sim, steps);
    if (type === 'lock-graph')      return _buildLockGraph(sim, steps);
    if (type === 'sequence')        return _buildSequenceDiagram(sim, steps);
    return _buildThreadTimeline(sim, steps);
  }

  /* ---- Thread Timeline ---- */
  function _buildThreadTimeline(sim, steps) {
    var threads = sim.threads || [];
    var totalSteps = steps.length;
    if (!totalSteps) return '<p class="clab-muted">No simulation steps defined.</p>';

    /* Column template: [thread-name, step1, step2, ...] */
    var colTemplate = 'auto repeat(' + totalSteps + ', 1fr)';

    var headerCells = '<div class="clab-tl-header clab-tl-corner"></div>';
    for (var s = 0; s < totalSteps; s++) {
      headerCells += '<div class="clab-tl-header" data-step-col="' + s + '">S' + (s + 1) + '</div>';
    }

    var threadRows = '';
    threads.forEach(function (thread, ti) {
      var threadName = (typeof thread === 'object') ? (thread.name || 'T' + (ti + 1)) : String(thread);
      threadRows += '<div class="clab-tl-thread">' + _esc(threadName) + '</div>';
      for (var s = 0; s < totalSteps; s++) {
        var step = steps[s];
        var isBug  = step.highlight ? ' clab-tl-cell-bug'  : '';
        var isSafe = step.safe      ? ' clab-tl-cell-safe' : '';
        var matchThread = (step.thread === ti);
        /* Cell label: op + var/value abbreviated */
        var cellLabel = '';
        if (matchThread) {
          var op  = step.op || step.operation || step.action || '';
          var varPart = step['var'] ? ' ' + step['var'] : '';
          var valPart = (step.value !== undefined && step.value !== null) ? '=' + step.value : '';
          cellLabel = op + varPart + valPart;
          if (!cellLabel) cellLabel = step.note || '';
          /* Truncate long labels */
          if (cellLabel.length > 20) cellLabel = cellLabel.substring(0, 18) + '…';
        }
        var cellClass = 'clab-tl-cell' + isBug + isSafe + (matchThread ? '' : ' clab-tl-cell-empty');
        threadRows += '<div class="' + cellClass + '" data-step-cell="' + s + '" data-thread="' + ti + '" title="' + _esc(step.note || '') + '">' + _esc(cellLabel) + '</div>';
      }
    });

    /* Shared state display — shared can be array [{name,value}] or object */
    var stateDisplay = '<div class="clab-sim-state" id="clab-sim-state">';
    var sharedArr = sim.sharedVars || sim.shared || [];
    var sharedVarsNorm = {};
    if (Array.isArray(sharedArr)) {
      sharedArr.forEach(function (sv) { sharedVarsNorm[sv.name] = sv.value; });
    } else if (typeof sharedArr === 'object') {
      sharedVarsNorm = sharedArr;
    }
    Object.keys(sharedVarsNorm).forEach(function (k) {
      stateDisplay += '<span class="clab-state-var" id="clab-state-' + _esc(k) + '">' +
        '<span class="clab-state-name">' + _esc(k) + ':</span> ' +
        '<span class="clab-state-val">' + _esc(String(sharedVarsNorm[k])) + '</span>' +
      '</span>';
    });
    stateDisplay += '</div>';

    return '<div class="clab-timeline-wrap">' +
      '<div class="clab-timeline-grid" id="clab-timeline-grid" style="grid-template-columns:' + colTemplate + '">' +
        headerCells + threadRows +
      '</div>' +
    '</div>' + stateDisplay;
  }

  /* ---- Lock Graph ---- */
  function _buildLockGraph(sim, steps) {
    var threads = sim.threads || [];
    var locks   = sim.locks   || [];
    var W = 500, H = 280;
    var threadY = 60,  lockY = 200;

    function threadX(i) { return threads.length > 1 ? 60 + i * ((W - 120) / (threads.length - 1)) : W / 2; }
    function lockX(i)   { return locks.length   > 1 ? 60 + i * ((W - 120) / (locks.length   - 1)) : W / 2; }

    var defs = '<defs>' +
      '<marker id="ah-g" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">' +
        '<polygon points="0 0, 8 3, 0 6" fill="#3fb950"/>' +
      '</marker>' +
      '<marker id="ah-r" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">' +
        '<polygon points="0 0, 8 3, 0 6" fill="#f85149"/>' +
      '</marker>' +
    '</defs>';

    var threadCircles = threads.map(function (t, i) {
      var x = threadX(i);
      return '<circle cx="' + x + '" cy="' + threadY + '" r="22" class="clab-lg-thread"/>' +
        '<text x="' + x + '" y="' + (threadY + 5) + '" text-anchor="middle" class="clab-lg-label">' + _esc(t.name || t) + '</text>';
    }).join('');

    var lockRects = locks.map(function (l, i) {
      var x = lockX(i) - 24;
      return '<rect x="' + x + '" y="' + (lockY - 14) + '" width="48" height="28" rx="4" class="clab-lg-lock"/>' +
        '<text x="' + (lockX(i)) + '" y="' + (lockY + 5) + '" text-anchor="middle" class="clab-lg-label">' + _esc(l.name || l) + '</text>';
    }).join('');

    var placeholder = '<g id="clab-lg-edges"></g>';

    return '<svg class="clab-lock-graph" id="clab-lock-graph" viewBox="0 0 ' + W + ' ' + H + '" width="100%">' +
      defs + placeholder + threadCircles + lockRects +
    '</svg>';
  }

  /* ---- Sequence Diagram ---- */
  function _buildSequenceDiagram(sim, steps) {
    var participants = sim.participants || [];
    if (!participants.length) return '<p class="clab-muted">No participants defined.</p>';
    var colW = Math.max(120, Math.floor(600 / participants.length));
    var W    = colW * participants.length;

    var headers = '<div class="clab-seq-participants">' +
      participants.map(function (p) {
        return '<div class="clab-seq-participant" style="width:' + colW + 'px">' + _esc(p.name || p) + '</div>';
      }).join('') +
    '</div>';

    /* Build participant name lookup */
    var pNames = {};
    participants.forEach(function (p) {
      var id = (typeof p === 'object') ? p.id : p;
      var nm = (typeof p === 'object') ? (p.name || String(p.id)) : String(p);
      pNames[id] = nm;
    });

    var stepsHtml = '<div class="clab-seq-steps" id="clab-seq-steps">';
    steps.forEach(function (step, si) {
      var isBug = step.highlight ? ' clab-seq-bug' : '';
      var fromName = (step.from !== undefined && pNames[step.from] !== undefined) ? pNames[step.from] : '';
      var toName   = (step.to   !== undefined && pNames[step.to]   !== undefined) ? pNames[step.to]   : '';
      var arrow    = (fromName && toName && fromName !== toName) ? (fromName + ' → ' + toName + ': ') : '';
      var label    = step.message || step.label || step.operation || '';
      var noteStr  = step.note ? ' — ' + step.note : '';
      stepsHtml += '<div class="clab-seq-step' + isBug + '" data-seq-step="' + si + '" style="display:none">' +
        '<span class="clab-seq-step-num">S' + (si + 1) + '</span> ' +
        '<span>' + _esc(arrow + label) + '</span>' +
        (noteStr ? '<span style="color:var(--text-muted);font-style:italic">' + _esc(noteStr) + '</span>' : '') +
      '</div>';
    });
    stepsHtml += '</div>';

    return '<div class="clab-seq-diagram" id="clab-seq-diagram">' +
      headers + stepsHtml +
    '</div>';
  }

  /* ----------------------------------------------------------
     Panel: Fix
  ---------------------------------------------------------- */
  function _panelFix(exp) {
    /* correctCode is an array of strings in the JSON */
    var codeLines = exp.correctCode || (exp.fix && exp.fix.code ? [exp.fix.code] : []);
    var code = Array.isArray(codeLines) ? codeLines.join('\n') : String(codeLines || '');
    var lang = (exp.fix && exp.fix.language) || 'java';
    var explanation = exp.correctExplanation || (exp.fix && exp.fix.explanation) || '';
    var keyChanges  = (exp.fix && exp.fix.keyChanges) || [];

    var changes = '';
    if (keyChanges.length) {
      changes = '<div class="clab-key-changes"><h4>Key Changes</h4><ul>' +
        keyChanges.map(function (c) { return '<li>' + _esc(c) + '</li>'; }).join('') +
      '</ul></div>';
    }

    return _wrapPanel('fix', false,
      '<div class="clab-code-wrap">' +
        '<pre><code class="language-' + _esc(lang) + '">' + _esc(code) + '</code></pre>' +
      '</div>' +
      (explanation ? '<p class="clab-fix-explanation">' + _esc(explanation) + '</p>' : '') +
      changes
    );
  }

  /* ----------------------------------------------------------
     Panel: Alternatives
  ---------------------------------------------------------- */
  function _panelAlternatives(exp) {
    var alts = exp.alternatives || [];
    if (!alts.length) return _wrapPanel('alternatives', false, '<p class="clab-muted">No alternatives documented.</p>');

    var body = alts.map(function (alt) {
      var lang = alt.language || 'java';
      var pros = alt.pros && alt.pros.length
        ? '<ul class="clab-pros">' + alt.pros.map(function (p) { return '<li>&#10003; ' + _esc(p) + '</li>'; }).join('') + '</ul>'
        : '';
      var cons = alt.cons && alt.cons.length
        ? '<ul class="clab-cons">' + alt.cons.map(function (c) { return '<li>&#10007; ' + _esc(c) + '</li>'; }).join('') + '</ul>'
        : '';
      var altCodeStr = Array.isArray(alt.code) ? alt.code.join('\n') : (alt.code || '');
      return '<div class="clab-alt-block">' +
        '<h3 class="clab-alt-title">' + _esc(alt.name) + '</h3>' +
        (altCodeStr ? '<div class="clab-code-wrap"><pre><code class="language-' + _esc(lang) + '">' + _esc(altCodeStr) + '</code></pre></div>' : '') +
        '<div class="clab-pros-cons">' + pros + cons + '</div>' +
        (alt.whenToUse ? '<p class="clab-when-to-use"><strong>When to use:</strong> ' + _esc(alt.whenToUse) + '</p>' : '') +
      '</div>';
    }).join('');

    return _wrapPanel('alternatives', false, body);
  }

  /* ----------------------------------------------------------
     Panel: Tests
  ---------------------------------------------------------- */
  function _panelTests(exp) {
    var tests = exp.tests || [];
    if (!tests.length) return _wrapPanel('tests', false, '<p class="clab-muted">No tests documented.</p>');

    var disclaimer =
      '<div class="clab-test-disclaimer clab-callout clab-callout-warn">' +
        '&#9888; Race conditions are non-deterministic. Tests that rely on Thread.sleep() or timing ' +
        'may not reliably reproduce the failure on all machines/JVM implementations.' +
      '</div>';

    var body = tests.map(function (test) {
      var fw   = (test.framework || 'junit').toLowerCase();
      var lang = test.language   || 'java';
      return '<div class="clab-test-block">' +
        '<div class="clab-test-header">' +
          '<span class="clab-framework-badge clab-fw-' + _esc(fw) + '">' + _esc(test.framework || fw) + '</span>' +
          (test.name ? '<span class="clab-test-name">' + _esc(test.name) + '</span>' : '') +
        '</div>' +
        (test.code ? '<div class="clab-code-wrap"><pre><code class="language-' + _esc(lang) + '">' + _esc(Array.isArray(test.code) ? test.code.join('\n') : test.code) + '</code></pre></div>' : '') +
        (test.explanation ? '<p class="clab-test-explanation">' + _esc(test.explanation) + '</p>' : '') +
        (test.limitations ? '<div class="clab-callout clab-callout-warn">&#9888; ' + _esc(test.limitations) + '</div>' : '') +
      '</div>';
    }).join('');

    return _wrapPanel('tests', false, disclaimer + body);
  }

  /* ----------------------------------------------------------
     Panel: Monitoring
  ---------------------------------------------------------- */
  function _panelMonitoring(exp) {
    var mon = exp.monitoring || {};
    var symptoms = mon.symptoms || exp.monitoringSymptoms || [];
    var tips     = mon.debugTips || exp.debugTips || [];

    var symptomsHtml = symptoms.length
      ? '<h4>Symptoms</h4><ul class="clab-symptom-list">' +
          symptoms.map(function (s) { return '<li>' + _esc(s) + '</li>'; }).join('') +
        '</ul>'
      : '';

    var tipsHtml = tips.length
      ? '<h4>Debug Commands</h4>' +
          tips.map(function (t) {
            if (typeof t === 'string' && t.includes('\n')) {
              return '<pre class="clab-debug-cmd"><code>' + _esc(t) + '</code></pre>';
            }
            return '<div class="clab-debug-tip">&#8226; ' + _esc(String(t)) + '</div>';
          }).join('')
      : '';

    return _wrapPanel('monitoring', false, symptomsHtml + tipsHtml);
  }

  /* ----------------------------------------------------------
     Panel: Production
  ---------------------------------------------------------- */
  function _panelProduction(exp) {
    var prod = exp.production || {};
    var recs  = prod.recommendations || exp.productionRecommendations || [];
    var notes = prod.performanceNotes || exp.performanceNotes || '';
    var table = prod.performanceTable || exp.performanceTable || [];

    var checklistHtml = '';
    if (recs.length) {
      checklistHtml = '<h4>Recommendations</h4><div class="clab-checklist" id="clab-checklist-' + _esc(exp.id) + '">' +
        recs.map(function (rec, i) {
          var key = 'clab-check-' + exp.id + '-' + i;
          return '<label class="clab-checklist-item">' +
            '<input type="checkbox" id="' + _esc(key) + '" onchange="EM.ConcurrencyLab._saveChecklist(\'' + _esc(exp.id) + '\')">' +
            '<span>' + _esc(rec) + '</span>' +
          '</label>';
        }).join('') +
      '</div>';
    }

    var notesHtml = notes ? '<p class="clab-perf-notes">' + _esc(notes) + '</p>' : '';

    var tableHtml = '';
    if (table.length) {
      var cols = Object.keys(table[0]);
      tableHtml = '<table class="clab-perf-table"><thead><tr>' +
        cols.map(function (c) { return '<th>' + _esc(c) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
        table.map(function (row) {
          return '<tr>' + cols.map(function (c) { return '<td>' + _esc(String(row[c] || '')) + '</td>'; }).join('') + '</tr>';
        }).join('') +
      '</tbody></table>';
    }

    return _wrapPanel('production', false, checklistHtml + notesHtml + tableHtml);
  }

  /* ----------------------------------------------------------
     Panel: Assessment
  ---------------------------------------------------------- */
  function _panelAssessment(exp) {
    var qs = exp.assessment || exp.quiz || [];
    if (!qs.length) return _wrapPanel('assessment', false, '<p class="clab-muted">No assessment questions available.</p>');

    var body = '<div class="clab-quiz" id="clab-quiz-' + _esc(exp.id) + '">' +
      qs.map(function (q, qi) {
        return '<div class="clab-quiz-question" data-qi="' + qi + '" data-answered="false">' +
          '<p class="clab-quiz-q-text"><strong>Q' + (qi + 1) + '.</strong> ' + _esc(q.text || q.question || '') + '</p>' +
          '<div class="clab-quiz-options">' +
            (q.options || []).map(function (opt, oi) {
              return '<button class="clab-quiz-option" ' +
                'onclick="EM.ConcurrencyLab._answerQuiz(\'' + _esc(exp.id) + '\',' + qi + ',' + oi + ')" ' +
                'data-oi="' + oi + '">' + _esc(opt) + '</button>';
            }).join('') +
          '</div>' +
          '<div class="clab-quiz-explanation hidden" id="clab-qexpl-' + _esc(exp.id) + '-' + qi + '">' +
            _esc(q.explanation || '') +
          '</div>' +
        '</div>';
      }).join('') +
      '<div class="clab-quiz-score hidden" id="clab-quiz-score-' + _esc(exp.id) + '"></div>' +
    '</div>';

    return _wrapPanel('assessment', false, body);
  }

  /* ----------------------------------------------------------
     Panel wrapper helper
  ---------------------------------------------------------- */
  function _wrapPanel(id, active, body) {
    var cls = 'clab-panel' + (active ? ' active' : ' hidden');
    return '<div class="' + cls + '" id="clab-panel-' + _esc(id) + '" role="tabpanel">' + body + '</div>';
  }

  /* ----------------------------------------------------------
     Tab Switching (global — called from inline onclick)
  ---------------------------------------------------------- */
  function _switchTab(btn) {
    var tabBar = btn.closest('.clab-tabs');
    if (!tabBar) return;
    var panelsWrap = tabBar.nextElementSibling;
    if (!panelsWrap) return;

    /* Update tab active state */
    tabBar.querySelectorAll('.clab-tab').forEach(function (t) {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');

    /* Show/hide panels */
    var targetId = btn.getAttribute('data-panel');
    panelsWrap.querySelectorAll('.clab-panel').forEach(function (p) {
      if (p.id === targetId) {
        p.classList.remove('hidden');
        p.classList.add('active');
      } else {
        p.classList.add('hidden');
        p.classList.remove('active');
      }
    });

    /* If switching to simulation, init state if needed */
    if (targetId === 'clab-panel-simulation') {
      var expEl = btn.closest('.clab-experiment');
      if (expEl) {
        var expId = expEl.getAttribute('data-exp-id');
        var exp   = _findExperiment(expId);
        if (exp) _initSimState(exp);
      }
    }
  }

  /* ----------------------------------------------------------
     Card Filter (global)
  ---------------------------------------------------------- */
  function _filterCards(btn) {
    var bar = btn.closest('.clab-filter-tabs');
    if (bar) {
      bar.querySelectorAll('.clab-filter-tab').forEach(function (t) {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
    }

    var filter = (btn.getAttribute('data-filter') || 'ALL').toUpperCase();
    var grid   = document.getElementById('clab-cards-grid');
    if (!grid) return;

    grid.querySelectorAll('.clab-card').forEach(function (card) {
      if (filter === 'ALL') {
        card.style.display = '';
      } else {
        var cat = (card.getAttribute('data-category') || '').toUpperCase();
        card.style.display = (cat === filter) ? '' : 'none';
      }
    });
  }

  /* ----------------------------------------------------------
     Simulation State Initialisation
  ---------------------------------------------------------- */
  function _initSimState(exp) {
    if (_simState.expId === exp.id) return; /* already initialised */
    var sim      = exp.simulation || {};
    var buggy    = sim.buggySteps || sim.steps || [];
    _simState.expId       = exp.id;
    _simState.showSafe    = false;
    _simState.steps       = buggy;
    _simState.totalSteps  = buggy.length;
    _simState.currentStep = 0;
    _simState.playing     = false;
    if (_simState.playTimer) { clearInterval(_simState.playTimer); _simState.playTimer = null; }
    _renderSimulationState(exp);
  }

  /* ----------------------------------------------------------
     Simulation Controls (local named functions, exposed in return)
  ---------------------------------------------------------- */
  function _simReset() {
    if (_simState.playTimer) { clearInterval(_simState.playTimer); _simState.playTimer = null; }
    _simState.playing     = false;
    _simState.currentStep = 0;
    _renderSimulationState();
  }

  function _simPrev() {
    if (_simState.playTimer) { clearInterval(_simState.playTimer); _simState.playTimer = null; }
    _simState.playing = false;
    if (_simState.currentStep > 0) _simState.currentStep--;
    _renderSimulationState();
  }

  function _simNext() {
    if (_simState.playing) return; /* don't interfere with auto-play */
    if (_simState.currentStep < _simState.totalSteps) _simState.currentStep++;
    _renderSimulationState();
  }

  function _simPlay() {
    if (_simState.playing) {
      clearInterval(_simState.playTimer);
      _simState.playTimer = null;
      _simState.playing   = false;
      _renderSimulationState();
      return;
    }
    /* Reset to start if at end */
    if (_simState.currentStep >= _simState.totalSteps) _simState.currentStep = 0;
    _simState.playing   = true;
    _renderSimulationState();
    _simState.playTimer = setInterval(function () {
      _simState.currentStep++;
      if (_simState.currentStep >= _simState.totalSteps) {
        clearInterval(_simState.playTimer);
        _simState.playTimer = null;
        _simState.playing   = false;
      }
      _renderSimulationState();
    }, 1200);
  }

  function _simToggleSafe(checked) {
    var exp = _findExperiment(_simState.expId);
    if (!exp) return;
    var sim = exp.simulation || {};
    _simState.showSafe    = checked;
    _simState.steps       = checked ? (sim.safeSteps || []) : (sim.buggySteps || sim.steps || []);
    _simState.totalSteps  = _simState.steps.length;
    _simState.currentStep = 0;
    if (_simState.playTimer) { clearInterval(_simState.playTimer); _simState.playTimer = null; }
    _simState.playing = false;
    /* Rebuild viz */
    var exp2 = _findExperiment(_simState.expId);
    if (exp2) {
      var sim2 = exp2.simulation || {};
      var container = document.getElementById('clab-sim-container');
      if (container) {
        /* Re-render the visualization portion */
        var oldViz = container.querySelector('.clab-timeline-wrap, .clab-lock-graph, .clab-seq-diagram');
        if (!oldViz) oldViz = container.querySelector('.clab-timeline-grid');
        if (oldViz) {
          var newVizHtml = _buildSimViz(sim2, _simState.steps);
          var tmp = document.createElement('div');
          tmp.innerHTML = newVizHtml;
          oldViz.parentNode.replaceChild(tmp.firstChild, oldViz);
        }
        /* Also rebuild state display */
        var oldState = container.querySelector('.clab-sim-state');
        if (oldState) {
          var sharedRaw2 = sim2.sharedVars || sim2.shared || [];
          var sharedNorm2 = {};
          if (Array.isArray(sharedRaw2)) {
            sharedRaw2.forEach(function (sv) { sharedNorm2[sv.name] = sv.value; });
          } else if (typeof sharedRaw2 === 'object') {
            sharedNorm2 = sharedRaw2;
          }
          var newState = document.createElement('div');
          newState.className = 'clab-sim-state';
          newState.id = 'clab-sim-state';
          Object.keys(sharedNorm2).forEach(function (k) {
            var span = document.createElement('span');
            span.className = 'clab-state-var';
            span.id = 'clab-state-' + k;
            span.innerHTML = '<span class="clab-state-name">' + _esc(k) + ':</span> <span class="clab-state-val">' + _esc(String(sharedNorm2[k])) + '</span>';
            newState.appendChild(span);
          });
          oldState.parentNode.replaceChild(newState, oldState);
        }
      }
    }
    _renderSimulationState();
  }

  /* ----------------------------------------------------------
     Render Simulation State (DOM updates)
  ---------------------------------------------------------- */
  function _renderSimulationState(exp) {
    var step      = _simState.currentStep;
    var total     = _simState.totalSteps;
    var steps     = _simState.steps;
    var curStep   = step > 0 && step <= steps.length ? steps[step - 1] : null;

    /* Step info label */
    var info = document.getElementById('clab-step-info');
    if (info) {
      var note = curStep && curStep.note ? ': ' + curStep.note : '';
      info.textContent = 'Step ' + step + ' of ' + total + note;
    }

    /* Play button icon */
    var playBtn = document.getElementById('clab-play-btn');
    if (playBtn) {
      playBtn.innerHTML = _simState.playing ? '&#9646;&#9646; Pause' : '&#9654; Play';
    }

    /* Annotation */
    var annEl = document.getElementById('clab-sim-annotation');
    if (annEl) {
      annEl.textContent = curStep && curStep.annotation ? curStep.annotation : '';
    }

    /* Highlight timeline columns */
    var grid = document.getElementById('clab-timeline-grid');
    if (grid) {
      grid.querySelectorAll('[data-step-col]').forEach(function (el) {
        var colIdx = parseInt(el.getAttribute('data-step-col'), 10);
        el.classList.toggle('clab-tl-header-active', colIdx === step - 1);
      });
      grid.querySelectorAll('[data-step-cell]').forEach(function (el) {
        var colIdx = parseInt(el.getAttribute('data-step-cell'), 10);
        var isActive = (colIdx === step - 1);
        el.classList.toggle('clab-tl-cell-active', isActive);
        /* Show only cells up to current step */
        if (colIdx < step) {
          el.style.opacity = '1';
        } else {
          el.style.opacity = '0.25';
        }
      });
    }

    /* Update shared state values */
    var stateEl = document.getElementById('clab-sim-state');
    if (stateEl && _simState.expId) {
      var currentExp = exp || _findExperiment(_simState.expId);
      if (currentExp) {
        var sim = currentExp.simulation || {};
        /* Normalise shared to object: handles [{name,value}] array or plain object */
        var sharedRaw = sim.sharedVars || sim.shared || [];
        var initial = {};
        if (Array.isArray(sharedRaw)) {
          sharedRaw.forEach(function (sv) { initial[sv.name] = sv.value; });
        } else {
          initial = sharedRaw;
        }
        /* Apply WRITE/CAS ops and legacy stateChanges from steps 0..step-1 */
        var state = {};
        Object.keys(initial).forEach(function (k) { state[k] = initial[k]; });
        for (var i = 0; i < step; i++) {
          var s = steps[i];
          if (!s) continue;
          var sop = (s.op || '').toUpperCase();
          if ((sop === 'WRITE' || sop === 'CAS') && s['var'] !== undefined) {
            state[s['var']] = s.value;
          }
          if (s.stateChanges) {
            Object.keys(s.stateChanges).forEach(function (k) { state[k] = s.stateChanges[k]; });
          }
        }
        Object.keys(state).forEach(function (k) {
          var el = document.getElementById('clab-state-' + k);
          if (el) {
            var valEl = el.querySelector('.clab-state-val');
            if (valEl) {
              var newVal = String(state[k]);
              var changed = valEl.textContent !== newVal;
              valEl.textContent = newVal;
              if (changed) {
                el.classList.add('clab-state-change');
                setTimeout(function (captured) {
                  return function () { captured.classList.remove('clab-state-change'); };
                }(el), 800);
              }
            }
          }
        });
      }
    }

    /* Show bugAnnotation / safeAnnotation when all steps are revealed */
    var annEl2 = document.getElementById('clab-sim-annotation');
    if (annEl2 && _simState.expId) {
      var annExp = exp || _findExperiment(_simState.expId);
      if (annExp) {
        var annSim = annExp.simulation || {};
        if (step >= total && total > 0) {
          var endNote = _simState.showSafe
            ? (annSim.safeAnnotation  || '')
            : (annSim.bugAnnotation   || '');
          if (endNote) annEl2.textContent = endNote;
        }
      }
    }

    /* Sequence diagram: reveal steps */
    var seqSteps = document.getElementById('clab-seq-steps');
    if (seqSteps) {
      seqSteps.querySelectorAll('[data-seq-step]').forEach(function (el) {
        var idx = parseInt(el.getAttribute('data-seq-step'), 10);
        el.style.display = idx < step ? '' : 'none';
        el.style.opacity = idx < step ? '1' : '0.3';
      });
    }

    /* Lock graph edges */
    var lgSvg = document.getElementById('clab-lock-graph');
    if (lgSvg && _simState.expId) {
      var currentExp2 = exp || _findExperiment(_simState.expId);
      if (currentExp2) _updateLockGraph(lgSvg, currentExp2.simulation || {}, step, steps);
    }
  }

  /* ---- Lock graph edge update ---- */
  function _updateLockGraph(svg, sim, currentStep, steps) {
    var threads = sim.threads || [];
    var locks   = sim.locks   || [];
    var W = 500, H = 280, threadY = 60, lockY = 200;

    function threadX(i) { return threads.length > 1 ? 60 + i * ((W - 120) / (threads.length - 1)) : W / 2; }
    function lockX(i)   { return locks.length   > 1 ? 60 + i * ((W - 120) / (locks.length   - 1)) : W / 2; }

    var edgesGroup = svg.getElementById ? svg.getElementById('clab-lg-edges') : svg.querySelector('#clab-lg-edges');
    if (!edgesGroup) return;

    /* Collect holds/waits from steps 0..currentStep-1
       Steps use: {thread: threadIdx, op: 'ACQUIRE'|'WAIT'|'RELEASE', lock: lockIdx} */
    var holds = {}, waits = {};
    for (var i = 0; i < currentStep; i++) {
      var s = steps[i];
      if (!s) continue;
      var op = (s.op || '').toUpperCase();
      var ti = s.thread;
      var li = s.lock;
      var key = ti + '->' + li;
      if (op === 'ACQUIRE' || op === 'LOCK') {
        holds[key] = { ti: ti, li: li };
        delete waits[key];
      } else if (op === 'WAIT') {
        waits[key] = { ti: ti, li: li };
      } else if (op === 'RELEASE' || op === 'UNLOCK') {
        delete holds[key];
        delete waits[key];
      }
      /* Legacy format: s.holds / s.waits / s.releases arrays */
      if (s.holds) { s.holds.forEach(function (h) { holds[h.thread + '->' + h.lock] = { ti: threads.findIndex ? threads.findIndex(function(t){return (t.id||t)===h.thread;}) : h.thread, li: h.lock }; }); }
      if (s.waits) { s.waits.forEach(function (w) { waits[w.thread + '->' + w.lock] = { ti: threads.findIndex ? threads.findIndex(function(t){return (t.id||t)===w.thread;}) : w.thread, li: w.lock }; }); }
      if (s.releases) { s.releases.forEach(function (r) { delete holds[r.thread + '->' + r.lock]; }); }
    }

    var edgesHtml = '';
    Object.keys(holds).forEach(function (key) {
      var h = holds[key];
      if (h.ti < 0 || h.ti >= threads.length || h.li < 0 || h.li >= locks.length) return;
      edgesHtml += '<line x1="' + threadX(h.ti) + '" y1="' + (threadY + 22) + '" x2="' + lockX(h.li) + '" y2="' + (lockY - 14) + '" class="clab-lg-holds" marker-end="url(#ah-g)"/>';
    });
    Object.keys(waits).forEach(function (key) {
      var w = waits[key];
      if (w.ti < 0 || w.ti >= threads.length || w.li < 0 || w.li >= locks.length) return;
      edgesHtml += '<line x1="' + lockX(w.li) + '" y1="' + (lockY - 14) + '" x2="' + threadX(w.ti) + '" y2="' + (threadY + 22) + '" class="clab-lg-waits" stroke-dasharray="6,3" marker-end="url(#ah-r)"/>';
    });

    edgesGroup.innerHTML = edgesHtml;
  }

  /* ----------------------------------------------------------
     Production Checklist Helpers
  ---------------------------------------------------------- */
  function _initChecklist(expId) {
    var saved = _loadChecklistState(expId);
    if (!saved) return;
    var checklist = document.getElementById('clab-checklist-' + expId);
    if (!checklist) return;
    checklist.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
      var key = cb.id;
      if (saved[key]) cb.checked = true;
    });
  }

  function _loadChecklistState(expId) {
    try {
      var raw = localStorage.getItem('clab-checklist-' + expId);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }

  function _saveChecklist(expId) {
    var checklist = document.getElementById('clab-checklist-' + expId);
    if (!checklist) return;
    var state = {};
    checklist.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
      state[cb.id] = cb.checked;
    });
    try { localStorage.setItem('clab-checklist-' + expId, JSON.stringify(state)); } catch (e) {}
  }

  /* ----------------------------------------------------------
     Quiz Handler
  ---------------------------------------------------------- */
  function _answerQuiz(expId, qi, oi) {
    var exp = _findExperiment(expId);
    if (!exp) return;
    var qs = exp.assessment || exp.quiz || [];
    var q  = qs[qi];
    if (!q) return;

    var qEl = document.querySelector('.clab-quiz-question[data-qi="' + qi + '"]');
    if (!qEl || qEl.getAttribute('data-answered') === 'true') return;

    qEl.setAttribute('data-answered', 'true');
    var correct = q.correct != null ? q.correct : q.correctIndex;

    qEl.querySelectorAll('.clab-quiz-option').forEach(function (btn) {
      var idx = parseInt(btn.getAttribute('data-oi'), 10);
      btn.disabled = true;
      if (idx === correct)      btn.classList.add('correct');
      else if (idx === oi)      btn.classList.add('incorrect');
    });

    var explEl = document.getElementById('clab-qexpl-' + expId + '-' + qi);
    if (explEl) explEl.classList.remove('hidden');

    /* Check if all answered */
    var quizEl  = document.getElementById('clab-quiz-' + expId);
    var allQs   = quizEl.querySelectorAll('.clab-quiz-question');
    var answered = quizEl.querySelectorAll('.clab-quiz-question[data-answered="true"]');
    if (answered.length === allQs.length) {
      var score = 0;
      answered.forEach(function (qElem) {
        var idx2 = parseInt(qElem.getAttribute('data-qi'), 10);
        var q2   = qs[idx2];
        var cor  = q2.correct != null ? q2.correct : q2.correctIndex;
        var chosen = qElem.querySelector('.clab-quiz-option.correct, .clab-quiz-option.incorrect.correct');
        /* Check the correct option was chosen by looking for correct class without incorrect */
        var correctBtn = qElem.querySelector('.clab-quiz-option.correct:not(.incorrect)');
        /* We need to check if user picked the right one */
        var pickedCorrect = qElem.querySelector('.clab-quiz-option.correct') &&
                            !qElem.querySelector('.clab-quiz-option.incorrect');
        /* simpler: scan options */
        var userPicked = -1;
        qElem.querySelectorAll('.clab-quiz-option').forEach(function (b) {
          if (b.classList.contains('incorrect') || (b.classList.contains('correct') && !b.classList.contains('incorrect'))) {
            /* the button the user clicked gets both classes if wrong, or just correct if right */
            if (b.classList.contains('correct') && !b.classList.contains('incorrect')) {
              /* could be highlighted as the right answer even though user picked wrong */
            }
          }
        });
        /* Simplest approach: if the option at index cor has class correct and NOT incorrect, user got it right */
        var corBtn = qElem.querySelector('.clab-quiz-option[data-oi="' + cor + '"]');
        if (corBtn && corBtn.classList.contains('correct') && !corBtn.classList.contains('incorrect')) {
          /* But we need to know if user clicked this button, not if it was just highlighted */
          /* Distinguish: incorrect buttons also get .correct class? No — only the picked wrong gets .incorrect,
             and the actual correct answer always gets .correct added. So if user picked wrong, correct has .correct,
             their pick has .incorrect. If user picked right, their pick has .correct (and nothing else). */
          /* So: score++ if no .incorrect button is present */
          if (!qElem.querySelector('.clab-quiz-option.incorrect')) score++;
        }
      });
      var scoreEl = document.getElementById('clab-quiz-score-' + expId);
      if (scoreEl) {
        scoreEl.classList.remove('hidden');
        scoreEl.innerHTML = '<strong>Score: ' + score + ' / ' + allQs.length + '</strong>' +
          (score === allQs.length ? ' &mdash; Perfect! 🎉' : score >= allQs.length * 0.6 ? ' &mdash; Good work!' : ' &mdash; Keep studying!');
      }
    }
  }

  /* ----------------------------------------------------------
     Public API
     All functions also written to window.EM.ConcurrencyLab
     so that inline onclick="EM.ConcurrencyLab._simXxx()" works
     after the IIFE return overwrites the namespace.
  ---------------------------------------------------------- */
  return {
    renderIndex:      renderIndex,
    renderExperiment: renderExperiment,

    /* Expose sim controls and helpers */
    _sim:             _simState,
    _switchTab:       _switchTab,
    _filterCards:     _filterCards,
    _simReset:        _simReset,
    _simPrev:         _simPrev,
    _simNext:         _simNext,
    _simPlay:         _simPlay,
    _simToggleSafe:   _simToggleSafe,
    _saveChecklist:   _saveChecklist,
    _answerQuiz:      _answerQuiz
  };
}());
