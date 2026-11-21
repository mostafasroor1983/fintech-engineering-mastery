/* ============================================================
   ENGINEERING MASTERY — Decision Lab Module
   Multi-stage interactive decision engine with rubric scoring
   ============================================================ */

window.EM = window.EM || {};

EM.Lab = (function () {
  'use strict';

  /* ----------------------------------------------------------
     State
  ---------------------------------------------------------- */
  var _scenarios  = null;   // Loaded from decision-lab.json (current language)
  var _loadPromises = {};   // One fetch per language
  var _trackTitleCache = {}; // lang:trackId -> { lessonId: title }
  var _fallback = {};        // lang -> true when English data is shown in another UI language

  /* English content inside the Arabic UI must keep left-to-right order */
  function _cdir() { return _fallback[EM.I18n.lang()] ? ' dir="ltr"' : ''; }

  /* ----------------------------------------------------------
     Scoring Tiers
  ---------------------------------------------------------- */
  var TIER_THRESHOLDS = {
    PRINCIPAL: 80,
    SENIOR:    60
  };

  function _scoreTier(total, max) {
    var pct = max > 0 ? Math.round((total / max) * 100) : 0;
    if (pct >= TIER_THRESHOLDS.PRINCIPAL) return 'principal';
    if (pct >= TIER_THRESHOLDS.SENIOR)    return 'senior';
    return 'developing';
  }

  function _tierLabel(tier) {
    switch (tier) {
      case 'principal': return EM.t('lab.tierPrincipal');
      case 'senior':    return EM.t('lab.tierSenior');
      default:          return EM.t('lab.tierDeveloping');
    }
  }

  function _tierCssClass(tier) {
    switch (tier) {
      case 'principal': return 'score-principal';
      case 'senior':    return 'score-senior';
      default:          return 'score-developing';
    }
  }

  /* ----------------------------------------------------------
     Data Loading
  ---------------------------------------------------------- */
  function _loadScenarios() {
    var lang = EM.I18n.lang();
    if (!_loadPromises[lang]) {
      _loadPromises[lang] = EM.I18n.fetchJSON('data/decision-lab.json')
        .then(function (res) { _fallback[lang] = res.fallback; return res.body.scenarios || []; })
        .catch(function (err) { delete _loadPromises[lang]; throw err; });
    }
    return _loadPromises[lang].then(function (list) {
      _scenarios = list;
      return list;
    });
  }

  /* Resolve related lesson ids (e.g. "track-05-lesson-02") to titles + routes */
  function _loadRelatedLessons(ids) {
    ids = ids || [];
    var lang = EM.I18n.lang();
    var trackIds = [];
    ids.forEach(function (id) {
      var tid = id.split('-lesson-')[0];
      if (trackIds.indexOf(tid) === -1) trackIds.push(tid);
    });
    return Promise.all(trackIds.map(function (tid) {
      var key = lang + ':' + tid;
      if (_trackTitleCache[key]) return _trackTitleCache[key];
      var appTrack = (EM.App.tracks || []).filter(function (t) { return t.id === tid; })[0];
      if (!appTrack) return Promise.resolve({});
      _trackTitleCache[key] = EM.I18n.fetchJSON('content/tracks/' + tid + '-' + appTrack.slug + '/_track.json')
        .then(function (res) {
          var map = {};
          (res.body.lessons || []).forEach(function (l) { map[l.id] = l.title; });
          return map;
        })
        .catch(function () { return {}; });
      return _trackTitleCache[key];
    })).then(function (maps) {
      var all = {};
      maps.forEach(function (m) { Object.keys(m).forEach(function (k) { all[k] = m[k]; }); });
      return ids.filter(function (id) { return all[id]; }).map(function (id) {
        return { id: id, track: id.split('-lesson-')[0], title: all[id] };
      });
    });
  }

  function _findScenario(scenarioId) {
    if (!_scenarios) return null;
    for (var i = 0; i < _scenarios.length; i++) {
      if (_scenarios[i].id === scenarioId) return _scenarios[i];
    }
    return null;
  }

  /* ----------------------------------------------------------
     Progress helpers
  ---------------------------------------------------------- */
  function _getState(scenarioId) {
    return EM.Progress.getScenarioState(scenarioId);
  }

  function _saveState(scenarioId, patch) {
    EM.Progress.saveScenarioState(scenarioId, patch);
  }

  function _maxScore(scenario) {
    return scenario.stages.reduce(function (sum, s) { return sum + s.maxScore; }, 0);
  }

  function _totalScore(scenario, state) {
    var scores = state.scores || {};
    return scenario.stages.reduce(function (sum, s) {
      return sum + (scores[s.id] || 0);
    }, 0);
  }

  function _currentStageIndex(scenario, state) {
    if (!state || state.scenarioState === 'IDLE' || !state.answers) return 0;
    if (state.scenarioState === 'COMPLETED') return scenario.stages.length;
    var answered = Object.keys(state.answers || {}).length;
    return Math.min(answered, scenario.stages.length - 1);
  }

  /* ----------------------------------------------------------
     Escape helper
  ---------------------------------------------------------- */
  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* Escape text and turn `backticked` fragments into isolated LTR code spans */
  function _rt(s) {
    return _esc(s).replace(/`([^`]+)`/g, '<code class="lab-code" dir="ltr">$1</code>');
  }

  /* ----------------------------------------------------------
     Render: Index Page
  ---------------------------------------------------------- */
  function renderIndex() {
    return _loadScenarios().then(function (scenarios) {
      var totalCompleted = 0;
      var cards = scenarios.map(function (scenario) {
        var state     = _getState(scenario.id);
        var completed = state.scenarioState === 'COMPLETED';
        if (completed) totalCompleted++;
        return _renderScenarioCard(scenario, state);
      }).join('');

      var headerStats =
        '<div class="lab-stats">' +
          _statPill(EM.t('lab.statScenarios', { n: scenarios.length })) +
          _statPill(EM.t('lab.statCompleted', { n: totalCompleted })) +
          _statPill(EM.t('lab.statDifficulty')) +
        '</div>';

      var howItWorks =
        '<div class="lab-how">' +
          '<div class="lab-how-title">' + EM.t('lab.howTitle') + '</div>' +
          '<ol class="lab-how-list">' +
            '<li>' + EM.esc(EM.t('lab.how1')) + '</li>' +
            '<li>' + EM.esc(EM.t('lab.how2')) + '</li>' +
            '<li>' + EM.esc(EM.t('lab.how3')) + '</li>' +
          '</ol>' +
        '</div>';

      return '<div class="page">' +
        '<div class="page-header lab-index-header">' +
          '<div class="lab-title-row">' +
            '<div class="lab-icon-wrap">' + EM.Icons.lab + '</div>' +
            '<h1 class="page-title">' + EM.t('lab.title') + '</h1>' +
          '</div>' +
          '<p class="page-subtitle lab-subtitle">' + EM.esc(EM.t('lab.subtitle')) + '</p>' +
          headerStats +
        '</div>' +
        (_fallback[EM.I18n.lang()] ? EM.I18n.fallbackNote() : '') +
        howItWorks +
        '<div class="lab-scenarios-grid">' + cards + '</div>' +
      '</div>';
    });
  }

  function _statPill(label) {
    return '<span class="lab-stat-pill">' + _esc(label) + '</span>';
  }

  function _renderScenarioCard(scenario, state) {
    var stateStr  = state.scenarioState || 'IDLE';
    var completed = stateStr === 'COMPLETED';
    var started   = stateStr !== 'IDLE' && !completed;
    var num       = String(scenario.sequence).padStart(2, '0');

    var maxSc     = _maxScore(scenario);
    var totalSc   = completed ? _totalScore(scenario, state) : 0;
    var tier      = completed ? _scoreTier(totalSc, maxSc) : null;

    // Stage dots
    var answers      = state.answers || {};
    var answeredCount = Object.keys(answers).length;
    var stageDots = scenario.stages.map(function (s, idx) {
      var cls = idx < answeredCount ? 'done' : (idx === answeredCount && started ? 'current' : '');
      return '<span class="stage-dot ' + cls + '"></span>';
    }).join('');

    // Right side: score badge or stage dots
    var rightSide = completed
      ? '<div class="scenario-score-badge">' +
          '<div class="scenario-score-value ' + _tierCssClass(tier) + '">' + totalSc + '</div>' +
          '<div class="scenario-score-label">/ ' + maxSc + '</div>' +
        '</div>'
      : '<div class="stage-dots">' + stageDots + '</div>';

    // Tags
    var tags = (scenario.tags || []).slice(0, 3).map(function (t) {
      return '<span class="tag-chip" dir="ltr">' + _esc(t) + '</span>';
    }).join('');

    // Status row
    var statusText, statusCls;
    if (completed) {
      statusText = _tierLabel(tier);
      statusCls  = 'status-completed';
    } else if (started) {
      statusText = EM.t('lab.inProgress', { n: Math.min(answeredCount + 1, scenario.stages.length), total: scenario.stages.length });
      statusCls  = 'status-in-progress';
    } else {
      statusText = EM.t('lab.notStarted', { n: scenario.estimatedMinutes });
      statusCls  = 'status-not-started';
    }

    return '<button class="scenario-card" onclick="EM.Router.navigate(\'/decision-lab/' + scenario.id + '\')">' +
      '<div class="scenario-card-top">' +
        '<div class="scenario-card-main">' +
          '<div class="scenario-num">' + EM.t('lab.scenario', { n: num }) + '</div>' +
          '<div class="scenario-card-title"' + _cdir() + '>' + _esc(scenario.title) + '</div>' +
          '<div class="scenario-card-subtitle"' + _cdir() + '>' + _esc(scenario.subtitle) + '</div>' +
        '</div>' +
        rightSide +
      '</div>' +
      '<div class="scenario-tags">' + tags + '</div>' +
      '<div class="scenario-status-row ' + statusCls + '">' +
        EM.Icons.clock +
        '<span>' + _esc(statusText) + '</span>' +
      '</div>' +
    '</button>';
  }

  /* ----------------------------------------------------------
     Render: Scenario Detail Page
  ---------------------------------------------------------- */
  function renderScenario(scenarioId) {
    return _loadScenarios().then(function () {
      var scenario = _findScenario(scenarioId);
      if (!scenario) {
        return '<div class="page"><div class="page-header">' +
          '<h1 class="page-title">' + EM.t('lab.notFound') + '</h1>' +
          '<p class="page-subtitle">' + _esc(EM.t('lab.scenarioId', { id: scenarioId })) + '</p>' +
          '<button class="btn btn-secondary" onclick="EM.Router.navigate(\'/decision-lab\')">' + _esc(EM.t('lab.back')) + '</button>' +
        '</div></div>';
      }

      var state     = _getState(scenarioId);
      var stateStr  = state.scenarioState || 'IDLE';
      var completed = stateStr === 'COMPLETED';

      // Breadcrumb
      var breadcrumb =
        '<div class="scenario-breadcrumb">' +
          '<button onclick="EM.Router.navigate(\'/decision-lab\')">' + _esc(EM.t('lab.title')) + '</button>' +
          '<span class="scenario-breadcrumb-sep">/</span>' +
          '<span>' + _esc(scenario.title) + '</span>' +
        '</div>';

      // Context panel
      var contextHtml = _renderContextPanel(scenario);

      var bodyHtml;
      if (stateStr === 'IDLE') {
        bodyHtml = _renderStartPanel(scenario) + contextHtml;
      } else if (completed) {
        return _loadRelatedLessons(scenario.relatedLessons).then(function (related) {
          return '<div class="scenario-page">' + breadcrumb +
            _renderStageProgress(scenario, state) +
            contextHtml +
            _renderCompletedStages(scenario, state) +
            _renderDebrief(scenario, state, related) +
          '</div>';
        });
      } else {
        var stageIdx = _currentStageIndex(scenario, state);
        bodyHtml = _renderStageProgress(scenario, state) +
                   contextHtml +
                   _renderCompletedStages(scenario, state) +
                   _renderActiveStage(scenario, stageIdx, state);
      }

      return '<div class="scenario-page">' + breadcrumb + bodyHtml + '</div>';
    });
  }

  function _renderContextPanel(scenario) {
    var constraints = (scenario.systemConstraints || []).map(function (c) {
      return '<span class="constraint-chip">' + _esc(c) + '</span>';
    }).join('');

    return '<div class="scenario-context">' +
      '<div class="scenario-context-label">' + EM.t('lab.context') + '</div>' +
      '<div class="scenario-context-text"' + _cdir() + '>' + _rt(scenario.context) + '</div>' +
      (constraints
        ? '<div class="scenario-constraints">' +
            '<div class="scenario-constraints-label">' + EM.t('lab.constraints') + '</div>' +
            '<div class="constraints-list">' + constraints + '</div>' +
          '</div>'
        : '') +
    '</div>';
  }

  function _renderStartPanel(scenario) {
    var maxSc = _maxScore(scenario);
    var num   = String(scenario.sequence).padStart(2, '0');

    return '<div class="scenario-start-panel">' +
      '<div class="scenario-num" style="justify-content:center;display:flex;margin-bottom:var(--sp-3)">' +
        EM.t('lab.scenario', { n: num }) +
      '</div>' +
      '<div class="scenario-start-title"' + _cdir() + '>' + _esc(scenario.title) + '</div>' +
      '<div class="scenario-start-subtitle">' +
        '<strong>' + _esc(scenario.subtitle) + '</strong><br>' +
        _esc(EM.t('lab.startIntro', { n: scenario.stages.length, max: maxSc })) +
      '</div>' +
      '<div class="scenario-start-meta">' +
        '<div class="scenario-start-meta-item">' +
          EM.Icons.clock + '<span>' + EM.t('lab.metaMin', { n: scenario.estimatedMinutes }) + '</span>' +
        '</div>' +
        '<div class="scenario-start-meta-item">' +
          EM.Icons.build + '<span>' + EM.t('lab.metaStages', { n: scenario.stages.length }) + '</span>' +
        '</div>' +
        '<div class="scenario-start-meta-item">' +
          EM.Icons.check + '<span>' + EM.t('lab.metaPts', { n: maxSc }) + '</span>' +
        '</div>' +
      '</div>' +
      '<button class="btn btn-primary" ' +
        'onclick="EM.Lab._startScenario(\'' + scenario.id + '\')">' +
        EM.t('lab.begin') +
      '</button>' +
    '</div>';
  }

  function _renderStageProgress(scenario, state) {
    var answers      = state.answers || {};
    var answeredCount = Object.keys(answers).length;
    var completed    = state.scenarioState === 'COMPLETED';

    var steps = scenario.stages.map(function (stage, idx) {
      var isDone    = idx < answeredCount || completed;
      var isActive  = !completed && idx === answeredCount;
      var bubbleCls = isDone ? 'done' : (isActive ? 'active' : '');
      var labelCls  = isActive ? 'active-label' : '';

      var connector = idx < scenario.stages.length - 1
        ? '<div class="stage-connector' + (isDone ? ' done' : '') + '"></div>'
        : '';

      return '<div class="stage-step">' +
        '<div class="stage-step-bubble ' + bubbleCls + '">' +
          (isDone ? EM.Icons.check : (idx + 1)) +
        '</div>' +
        '<span class="stage-step-label ' + labelCls + '">' + EM.t('lab.stage', { n: idx + 1 }) + '</span>' +
        connector +
      '</div>';
    }).join('');

    var totalSc = _totalScore(scenario, state);
    var maxSc   = _maxScore(scenario);

    return '<div class="stage-progress">' +
      '<div class="stage-progress-steps">' + steps + '</div>' +
      (answeredCount > 0 || completed
        ? '<div class="stage-progress-score">' +
            EM.t('lab.pts', { a: '<strong>' + totalSc + '</strong>', b: maxSc }) +
          '</div>'
        : '') +
    '</div>';
  }

  function _renderCompletedStages(scenario, state) {
    var answers = state.answers || {};
    var scores  = state.scores  || {};

    return scenario.stages.map(function (stage, idx) {
      if (!answers[stage.id]) return '';

      var chosenId   = answers[stage.id];
      var earned     = scores[stage.id] || 0;
      var chosen     = stage.options.find(function (o) { return o.id === chosenId; });
      var isCorrect  = chosenId === stage.correctOptionId;

      return '<div class="stage-panel stage-panel-done">' +
        '<div class="stage-label">' +
          '<span>' + EM.t('lab.stageDone', { n: idx + 1 }) + '</span>' +
          '<span class="stage-label-score">' + EM.t('lab.pts', { a: earned, b: stage.maxScore }) + '</span>' +
        '</div>' +
        '<div class="stage-question"' + _cdir() + '>' + _rt(stage.question) + '</div>' +
        _renderRevealedOptions(stage, chosenId, true) +
        _renderStageScoreDisplay(earned, stage.maxScore) +
      '</div>';
    }).join('');
  }

  function _renderActiveStage(scenario, stageIdx, state) {
    var stage   = scenario.stages[stageIdx];
    var stateId = state.scenarioState;

    // Check if this stage was just answered (waiting for 'next' click)
    var answers = state.answers || {};
    if (answers[stage.id]) {
      // Already answered — show revealed state with next button
      var chosenId = answers[stage.id];
      var earned   = (state.scores || {})[stage.id] || 0;
      var isLast   = stageIdx === scenario.stages.length - 1;

      return '<div class="stage-panel" id="active-stage-panel">' +
        '<div class="stage-label">' +
          '<span>' + EM.t('lab.stageOf', { n: stageIdx + 1, total: scenario.stages.length }) + '</span>' +
          '<span class="stage-label-score">' + EM.t('lab.ptsAvailable', { n: stage.maxScore }) + '</span>' +
        '</div>' +
        '<div class="stage-question"' + _cdir() + '>' + _rt(stage.question) + '</div>' +
        _renderRevealedOptions(stage, chosenId, true) +
        _renderStageScoreDisplay(earned, stage.maxScore) +
        '<div class="stage-next-btn visible">' +
          (isLast
            ? '<button class="btn btn-primary" onclick="EM.Lab._completeScenario(\'' + scenario.id + '\')">' +
                _esc(EM.t('lab.viewDebrief')) +
              '</button>'
            : '<button class="btn btn-primary" onclick="EM.Lab._advanceStage(\'' + scenario.id + '\', ' + (stageIdx + 1) + ')">' +
                _esc(EM.t('lab.next')) +
              '</button>') +
        '</div>' +
      '</div>';
    }

    // Not yet answered — show interactive options
    var optionsHtml = stage.options.map(function (opt) {
      return '<button class="option-card" ' +
        'id="opt-' + _esc(opt.id) + '" ' +
        'onclick="EM.Lab._selectOption(\'' + _esc(scenario.id) + '\', \'' + _esc(stage.id) + '\', \'' + _esc(opt.id) + '\')">' +
        '<span class="option-label">' + _esc(opt.label) + '</span>' +
        '<div class="option-body"' + _cdir() + '><span class="option-text">' + _rt(opt.text) + '</span></div>' +
      '</button>';
    }).join('');

    return '<div class="stage-panel" id="active-stage-panel">' +
      '<div class="stage-label">' +
        '<span>' + EM.t('lab.stageOf', { n: stageIdx + 1, total: scenario.stages.length }) + '</span>' +
        '<span class="stage-label-score">' + EM.t('lab.ptsAvailable', { n: stage.maxScore }) + '</span>' +
      '</div>' +
      '<div class="stage-question"' + _cdir() + '>' + _rt(stage.question) + '</div>' +
      '<div class="options-grid" id="options-grid-' + _esc(stage.id) + '">' + optionsHtml + '</div>' +
      '<div id="stage-score-' + _esc(stage.id) + '" class="stage-score-display"></div>' +
      '<div id="stage-rationale-' + _esc(stage.id) + '" class="stage-rationale"></div>' +
      '<div id="stage-next-' + _esc(stage.id) + '" class="stage-next-btn"></div>' +
    '</div>';
  }

  function _renderRevealedOptions(stage, chosenId, showFeedback) {
    return '<div class="options-grid">' +
      stage.options.map(function (opt) {
        var isChosen  = opt.id === chosenId;
        var isCorrect = opt.id === stage.correctOptionId;
        var cls;
        if (isChosen && isCorrect)      cls = 'correct selected';
        else if (isChosen && !isCorrect) cls = 'incorrect selected';
        else if (isCorrect)              cls = 'correct';
        else                             cls = 'neutral-reveal';

        var feedbackHtml = (isChosen || isCorrect) && showFeedback
          ? '<div class="option-feedback visible">' + _rt(opt.feedback) + '</div>'
          : '';

        return '<button class="option-card ' + cls + '" disabled>' +
          '<span class="option-label">' + _esc(opt.label) + '</span>' +
          '<div class="option-body"' + _cdir() + '><span class="option-text">' + _rt(opt.text) + '</span>' + feedbackHtml + '</div>' +
        '</button>';
      }).join('') +
    '</div>';
  }

  function _renderStageScoreDisplay(earned, max) {
    var pct  = max > 0 ? Math.round((earned / max) * 100) : 0;
    var tier = pct >= 90 ? 'full' : (pct >= 60 ? 'partial' : 'low');
    var label = pct === 100 ? EM.t('lab.perfect') : (earned > 0 ? EM.t('lab.partial') : EM.t('lab.incorrect'));

    return '<div class="stage-score-display visible">' +
      '<div class="stage-score-num">' +
        '<div class="stage-score-points">' + earned + '</div>' +
        '<div class="stage-score-of">' + EM.t('lab.ofPts', { n: max }) + '</div>' +
      '</div>' +
      '<div class="stage-score-tier tier-' + tier + '">' + label + '</div>' +
    '</div>';
  }

  function _renderDebrief(scenario, state, related) {
    var maxSc   = _maxScore(scenario);
    var totalSc = _totalScore(scenario, state);
    var tier    = _scoreTier(totalSc, maxSc);
    var answers = state.answers || {};
    var scores  = state.scores  || {};

    var stageBreakdowns = scenario.stages.map(function (stage, idx) {
      var chosenId  = answers[stage.id];
      var earned    = scores[stage.id] || 0;
      var chosen    = stage.options.find(function (o) { return o.id === chosenId; });
      var best      = stage.options.find(function (o) { return o.id === stage.correctOptionId; });
      var isCorrect = chosenId === stage.correctOptionId;

      var chosenRow = chosen
        ? '<div class="debrief-answer-row ' + (isCorrect ? 'debrief-chosen-correct' : 'debrief-chosen-wrong') + '">' +
            '<span class="debrief-answer-label">' + EM.t('lab.yourAnswer') + '</span>' +
            '<span class="debrief-answer-text"' + _cdir() + '><span class="debrief-opt-label">' + _esc(chosen.label) + '</span>' + _rt(chosen.text) + '</span>' +
          '</div>'
        : '';

      var bestRow = !isCorrect && best
        ? '<div class="debrief-answer-row debrief-best-answer">' +
            '<span class="debrief-answer-label">' + EM.t('lab.bestAnswer') + '</span>' +
            '<span class="debrief-answer-text"' + _cdir() + '><span class="debrief-opt-label">' + _esc(best.label) + '</span>' + _rt(best.text) + '</span>' +
          '</div>'
        : '';

      return '<div class="debrief-stage">' +
        '<div class="debrief-stage-header">' +
          '<div class="debrief-stage-num">' + EM.t('lab.stage', { n: idx + 1 }) + '</div>' +
          '<div class="debrief-stage-score ' + (isCorrect ? 'score-principal' : (earned > 0 ? 'score-senior' : 'score-developing')) + '">' +
            EM.t('lab.pts', { a: earned, b: stage.maxScore }) +
          '</div>' +
        '</div>' +
        '<div class="debrief-stage-question"' + _cdir() + '>' + _rt(stage.question) + '</div>' +
        chosenRow +
        bestRow +
        (stage.principalRationale
          ? '<div class="debrief-rationale">' +
              '<strong style="color:var(--accent)">' + EM.t('lab.principalPersp') + '</strong>' +
              '<span' + _cdir() + '>' + _rt(stage.principalRationale) + '</span>' +
            '</div>'
          : '') +
      '</div>';
    }).join('');

    var takeaways = (scenario.debrief.keyTakeaways || []).map(function (t) {
      return '<li' + _cdir() + '>' + _rt(t) + '</li>';
    }).join('');

    var reading = (scenario.debrief.furtherReading || []).map(function (r) {
      return '<li dir="auto">' + _esc(r) + '</li>';
    }).join('');

    var relatedHtml = (related || []).map(function (l) {
      return '<li><a href="#/tracks/' + _esc(l.track) + '/lessons/' + _esc(l.id) + '">' +
        '<span class="debrief-related-num" dir="ltr">' + _esc(l.track.replace('track-', 'T')) + '</span>' +
        '<span>' + _esc(l.title) + '</span></a></li>';
    }).join('');

    return '<div class="debrief-panel">' +
      '<div class="debrief-header">' +
        '<div>' +
          '<div class="debrief-kicker">' +
            EM.t('lab.debrief') +
          '</div>' +
          '<div class="debrief-title"' + _cdir() + '>' + _esc(scenario.title) + '</div>' +
        '</div>' +
        '<div class="final-score-display">' +
          '<div class="final-score-value ' + _tierCssClass(tier) + '">' + totalSc + '</div>' +
          '<div class="final-score-100">' + EM.t('lab.ofPts', { n: maxSc }) + '</div>' +
          '<div class="final-score-tier ' + _tierCssClass(tier) + '">' + _tierLabel(tier) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="debrief-body">' +
        '<div class="debrief-summary"' + _cdir() + '>' + _rt(scenario.debrief.summary) + '</div>' +
        '<div class="debrief-stages">' + stageBreakdowns + '</div>' +
        (takeaways
          ? '<div class="debrief-takeaways"><h4>' + EM.t('lab.takeaways') + '</h4><ul>' + takeaways + '</ul></div>'
          : '') +
        (reading
          ? '<div class="debrief-reading"><h4>' + EM.t('lab.reading') + '</h4><ul>' + reading + '</ul></div>'
          : '') +
        (relatedHtml
          ? '<div class="debrief-related"><h4>' + EM.t('lab.related') + '</h4><ul>' + relatedHtml + '</ul></div>'
          : '') +
        '<div class="debrief-actions">' +
          '<button class="btn btn-secondary" onclick="EM.Lab._resetScenario(\'' + scenario.id + '\')">' +
            EM.t('lab.retry') +
          '</button>' +
          '<button class="btn btn-ghost" onclick="EM.Router.navigate(\'/decision-lab\')">' +
            _esc(EM.t('lab.all')) +
          '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  /* ----------------------------------------------------------
     Interaction Handlers (called from inline onclick)
  ---------------------------------------------------------- */

  /* Start scenario — transition IDLE → STAGE_1 */
  function _startScenario(scenarioId) {
    _saveState(scenarioId, {
      scenarioState: 'STAGE_1',
      answers:       {},
      scores:        {},
      startedAt:     new Date().toISOString()
    });
    EM.Router.navigate('/decision-lab/' + scenarioId);
  }

  /* Select an option — called on option card click */
  function _selectOption(scenarioId, stageId, optionId) {
    var scenario = _findScenario(scenarioId);
    if (!scenario) return;

    var stage = null;
    var stageIdx = 0;
    for (var i = 0; i < scenario.stages.length; i++) {
      if (scenario.stages[i].id === stageId) {
        stage = scenario.stages[i];
        stageIdx = i;
        break;
      }
    }
    if (!stage) return;

    // Find the chosen option
    var chosenOpt = null;
    for (var j = 0; j < stage.options.length; j++) {
      if (stage.options[j].id === optionId) { chosenOpt = stage.options[j]; break; }
    }
    if (!chosenOpt) return;

    var earned = chosenOpt.score;

    // Save to progress
    var state  = _getState(scenarioId);
    var answers = Object.assign({}, state.answers || {});
    var scores  = Object.assign({}, state.scores  || {});
    answers[stageId] = optionId;
    scores[stageId]  = earned;

    _saveState(scenarioId, {
      answers: answers,
      scores:  scores
    });

    // Reveal options in DOM (without full re-render for smooth UX)
    _revealOptions(stage, optionId, stageId);
    _showStageScore(stage, stageId, earned);
    _showStageNextButton(scenario, stageIdx, stageId, scenarioId);
  }

  function _revealOptions(stage, chosenId, stageId) {
    var grid = document.getElementById('options-grid-' + stageId);
    if (!grid) return;

    var buttons = grid.querySelectorAll('.option-card');
    buttons.forEach(function (btn, idx) {
      var opt       = stage.options[idx];
      var isChosen  = opt.id === chosenId;
      var isCorrect = opt.id === stage.correctOptionId;

      btn.disabled = true;
      btn.classList.remove('option-card');

      if (isChosen && isCorrect)       btn.className = 'option-card correct selected';
      else if (isChosen && !isCorrect) btn.className = 'option-card incorrect selected';
      else if (isCorrect)              btn.className = 'option-card correct';
      else                             btn.className = 'option-card neutral-reveal';

      // Show feedback for chosen and correct options
      if (isChosen || isCorrect) {
        var feedbackDiv = document.createElement('div');
        feedbackDiv.className = 'option-feedback visible';
        if (_cdir()) feedbackDiv.setAttribute('dir', 'ltr');
        feedbackDiv.innerHTML = _rt(opt.feedback);
        var body = btn.querySelector('.option-body') || btn;
        body.appendChild(feedbackDiv);
      }
    });

    // Show principal rationale
    var rationaleDiv = document.getElementById('stage-rationale-' + stageId);
    if (rationaleDiv && stage.principalRationale) {
      rationaleDiv.className = 'stage-rationale visible';
      rationaleDiv.innerHTML =
        '<div class="stage-rationale-label">' + EM.t('lab.perspective') + '</div>' +
        '<div' + _cdir() + '>' + _rt(stage.principalRationale) + '</div>';
    }
  }

  function _showStageScore(stage, stageId, earned) {
    var scoreDiv = document.getElementById('stage-score-' + stageId);
    if (!scoreDiv) return;
    scoreDiv.innerHTML = _renderStageScoreDisplay(earned, stage.maxScore);
    scoreDiv.className = 'stage-score-display visible';
  }

  function _showStageNextButton(scenario, stageIdx, stageId, scenarioId) {
    var nextDiv = document.getElementById('stage-next-' + stageId);
    if (!nextDiv) return;
    nextDiv.className = 'stage-next-btn visible';

    var isLast = stageIdx === scenario.stages.length - 1;

    if (isLast) {
      nextDiv.innerHTML =
        '<button class="btn btn-primary" onclick="EM.Lab._completeScenario(\'' + scenarioId + '\')">' +
          _esc(EM.t('lab.viewDebrief')) +
        '</button>';
    } else {
      nextDiv.innerHTML =
        '<button class="btn btn-primary" onclick="EM.Lab._advanceStage(\'' + scenarioId + '\', ' + (stageIdx + 1) + ')">' +
          _esc(EM.t('lab.next')) +
        '</button>';
    }
  }

  /* Advance to next stage */
  function _advanceStage(scenarioId, nextStageIdx) {
    var scenario = _findScenario(scenarioId);
    if (!scenario) return;

    var nextStage = scenario.stages[nextStageIdx];
    if (!nextStage) return;

    _saveState(scenarioId, {
      scenarioState: 'STAGE_' + (nextStageIdx + 1)
    });

    // Smooth scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // Re-render page
    EM.Router.navigate('/decision-lab/' + scenarioId);
  }

  /* Complete scenario — all stages answered */
  function _completeScenario(scenarioId) {
    var scenario = _findScenario(scenarioId);
    if (!scenario) return;

    _saveState(scenarioId, {
      scenarioState: 'COMPLETED',
      completedAt: new Date().toISOString()
    });

    window.scrollTo({ top: 0, behavior: 'smooth' });
    EM.Router.navigate('/decision-lab/' + scenarioId);
  }

  /* Reset a scenario */
  function _resetScenario(scenarioId) {
    EM.Progress.saveScenarioState(scenarioId, {
      scenarioState: 'IDLE',
      answers:       {},
      scores:        {},
      startedAt:     null,
      completedAt:   null
    });
    EM.Router.navigate('/decision-lab/' + scenarioId);
  }

  /* ----------------------------------------------------------
     Public API
  ---------------------------------------------------------- */
  return {
    renderIndex:       renderIndex,
    renderScenario:    renderScenario,
    _startScenario:    _startScenario,
    _selectOption:     _selectOption,
    _advanceStage:     _advanceStage,
    _completeScenario: _completeScenario,
    _resetScenario:    _resetScenario
  };
}());
