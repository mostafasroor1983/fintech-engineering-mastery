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
  var _scenarios  = null;   // Loaded from decision-lab.json
  var _loadPromise = null;  // Singleton fetch promise

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
      case 'principal': return 'Principal Engineer';
      case 'senior':    return 'Senior Engineer';
      default:          return 'Needs Development';
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
    if (_loadPromise) return _loadPromise;
    _loadPromise = fetch('data/decision-lab.json')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        _scenarios = data.scenarios || [];
        return _scenarios;
      });
    return _loadPromise;
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
        '<div style="display:flex;gap:var(--sp-5);margin-top:var(--sp-5)">' +
          _statPill(scenarios.length + ' scenarios') +
          _statPill(totalCompleted + ' completed') +
          _statPill('Principal difficulty') +
        '</div>';

      return '<div class="page">' +
        '<div class="page-header lab-index-header">' +
          '<div class="lab-icon-wrap">' + EM.Icons.lab + '</div>' +
          '<h1 class="page-title" style="margin-top:var(--sp-3)">Decision Lab</h1>' +
          '<p class="page-subtitle" style="max-width:640px">' +
            'Real-world engineering scenarios drawn from production incidents in banking and FinTech. ' +
            'Each scenario presents a system under stress — analyse the constraints, choose your approach, ' +
            'and defend it. Scored against a Principal Engineer rubric.' +
          '</p>' +
          headerStats +
        '</div>' +
        '<div class="lab-scenarios-grid">' + cards + '</div>' +
      '</div>';
    });
  }

  function _statPill(label) {
    return '<span class="tag-chip" style="font-size:var(--text-xs)">' + _esc(label) + '</span>';
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
      return '<span class="tag-chip" style="font-size:11px">' + _esc(t) + '</span>';
    }).join('');

    // Status row
    var statusText, statusCls;
    if (completed) {
      statusText = _tierLabel(tier);
      statusCls  = 'status-completed';
    } else if (started) {
      statusText = 'In Progress — Stage ' + (answeredCount + 1) + ' of ' + scenario.stages.length;
      statusCls  = 'status-in-progress';
    } else {
      statusText = 'Not Started · ' + scenario.estimatedMinutes + ' min';
      statusCls  = 'status-not-started';
    }

    return '<button class="scenario-card" onclick="EM.Router.navigate(\'/decision-lab/' + scenario.id + '\')">' +
      '<div class="scenario-card-top">' +
        '<div style="flex:1">' +
          '<div class="scenario-num">SCENARIO ' + num + '</div>' +
          '<div class="scenario-card-title">' + _esc(scenario.title) + '</div>' +
          '<div class="scenario-card-subtitle">' + _esc(scenario.subtitle) + '</div>' +
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
          '<h1 class="page-title">Scenario Not Found</h1>' +
          '<p class="page-subtitle">Scenario ID: ' + _esc(scenarioId) + '</p>' +
          '<button class="btn btn-secondary" onclick="EM.Router.navigate(\'/decision-lab\')">&larr; Decision Lab</button>' +
        '</div></div>';
      }

      var state     = _getState(scenarioId);
      var stateStr  = state.scenarioState || 'IDLE';
      var completed = stateStr === 'COMPLETED';

      // Breadcrumb
      var breadcrumb =
        '<div class="scenario-breadcrumb">' +
          '<button onclick="EM.Router.navigate(\'/decision-lab\')">' + EM.Icons.arrow + ' Decision Lab</button>' +
          '<span class="scenario-breadcrumb-sep">/</span>' +
          '<span>' + _esc(scenario.title) + '</span>' +
        '</div>';

      // Context panel
      var contextHtml = _renderContextPanel(scenario);

      var bodyHtml;
      if (stateStr === 'IDLE') {
        bodyHtml = _renderStartPanel(scenario) + contextHtml;
      } else if (completed) {
        bodyHtml = _renderStageProgress(scenario, state) +
                   contextHtml +
                   _renderCompletedStages(scenario, state) +
                   _renderDebrief(scenario, state);
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
      '<div class="scenario-context-label">Scenario Context</div>' +
      '<div class="scenario-context-text">' + _esc(scenario.context) + '</div>' +
      (constraints
        ? '<div class="scenario-constraints">' +
            '<div class="scenario-constraints-label">System Constraints</div>' +
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
        'SCENARIO ' + num +
      '</div>' +
      '<div class="scenario-start-title">' + _esc(scenario.title) + '</div>' +
      '<div class="scenario-start-subtitle">' +
        _esc(scenario.subtitle) + ' — ' +
        'You will face ' + scenario.stages.length + ' decision stages. ' +
        'Read the context carefully. Each stage is scored; maximum ' + maxSc + ' points.' +
      '</div>' +
      '<div class="scenario-start-meta">' +
        '<div class="scenario-start-meta-item">' +
          EM.Icons.clock + '<span>' + scenario.estimatedMinutes + ' min</span>' +
        '</div>' +
        '<div class="scenario-start-meta-item">' +
          EM.Icons.build + '<span>' + scenario.stages.length + ' stages</span>' +
        '</div>' +
        '<div class="scenario-start-meta-item">' +
          EM.Icons.check + '<span>' + maxSc + ' pts max</span>' +
        '</div>' +
      '</div>' +
      '<button class="btn btn-primary" ' +
        'onclick="EM.Lab._startScenario(\'' + scenario.id + '\')">' +
        'Begin Scenario' +
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
        '<span class="stage-step-label ' + labelCls + '">Stage ' + (idx + 1) + '</span>' +
        connector +
      '</div>';
    }).join('');

    var totalSc = _totalScore(scenario, state);
    var maxSc   = _maxScore(scenario);

    return '<div class="stage-progress">' +
      '<div class="stage-progress-steps">' + steps + '</div>' +
      (answeredCount > 0 || completed
        ? '<div style="font-family:var(--font-mono);font-size:var(--text-sm);color:var(--text-muted);flex-shrink:0">' +
            '<strong style="color:var(--text-primary)">' + totalSc + '</strong>/' + maxSc + ' pts' +
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

      return '<div class="stage-panel" style="opacity:0.85">' +
        '<div class="stage-label">' +
          'Stage ' + (idx + 1) + ' &mdash; Completed' +
          '<span class="stage-label-score">' + earned + '/' + stage.maxScore + ' pts</span>' +
        '</div>' +
        '<div class="stage-question">' + _esc(stage.question) + '</div>' +
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
          'Stage ' + (stageIdx + 1) + ' of ' + scenario.stages.length +
          '<span class="stage-label-score">' + stage.maxScore + ' pts available</span>' +
        '</div>' +
        '<div class="stage-question">' + _esc(stage.question) + '</div>' +
        _renderRevealedOptions(stage, chosenId, true) +
        _renderStageScoreDisplay(earned, stage.maxScore) +
        '<div class="stage-next-btn visible">' +
          (isLast
            ? '<button class="btn btn-primary" onclick="EM.Lab._completeScenario(\'' + scenario.id + '\')">' +
                'View Full Debrief &amp; Score' +
              '</button>'
            : '<button class="btn btn-primary" onclick="EM.Lab._advanceStage(\'' + scenario.id + '\', ' + (stageIdx + 1) + ')">' +
                'Next Stage &rarr;' +
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
        '<span>' + _esc(opt.text) + '</span>' +
      '</button>';
    }).join('');

    return '<div class="stage-panel" id="active-stage-panel">' +
      '<div class="stage-label">' +
        'Stage ' + (stageIdx + 1) + ' of ' + scenario.stages.length +
        '<span class="stage-label-score">' + stage.maxScore + ' pts available</span>' +
      '</div>' +
      '<div class="stage-question">' + _esc(stage.question) + '</div>' +
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
          ? '<div class="option-feedback visible">' + _esc(opt.feedback) + '</div>'
          : '';

        return '<button class="option-card ' + cls + '" disabled>' +
          '<span class="option-label">' + _esc(opt.label) + '</span>' +
          '<div><span>' + _esc(opt.text) + '</span>' + feedbackHtml + '</div>' +
        '</button>';
      }).join('') +
    '</div>';
  }

  function _renderStageScoreDisplay(earned, max) {
    var pct  = max > 0 ? Math.round((earned / max) * 100) : 0;
    var tier = pct >= 90 ? 'full' : (pct >= 60 ? 'partial' : 'low');
    var label = pct === 100 ? 'Perfect' : (pct >= 60 ? 'Partial credit' : 'Incorrect');

    return '<div class="stage-score-display visible">' +
      '<div>' +
        '<div class="stage-score-points">' + earned + '</div>' +
        '<div class="stage-score-of">/ ' + max + ' pts</div>' +
      '</div>' +
      '<div class="stage-score-tier tier-' + tier + '">' + label + '</div>' +
    '</div>';
  }

  function _renderDebrief(scenario, state) {
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
            '<span class="debrief-answer-label">Your answer:</span>' +
            '<span class="debrief-answer-text">' + _esc(chosen.label) + '. ' + _esc(chosen.text) + '</span>' +
          '</div>'
        : '';

      var bestRow = !isCorrect && best
        ? '<div class="debrief-answer-row debrief-best-answer">' +
            '<span class="debrief-answer-label">Best answer:</span>' +
            '<span class="debrief-answer-text">' + _esc(best.label) + '. ' + _esc(best.text) + '</span>' +
          '</div>'
        : '';

      return '<div class="debrief-stage">' +
        '<div class="debrief-stage-header">' +
          '<div class="debrief-stage-num">Stage ' + (idx + 1) + '</div>' +
          '<div class="debrief-stage-score ' + (isCorrect ? 'score-principal' : (earned > 0 ? 'score-senior' : 'score-developing')) + '">' +
            earned + '/' + stage.maxScore + ' pts' +
          '</div>' +
        '</div>' +
        '<div class="debrief-stage-question">' + _esc(stage.question) + '</div>' +
        chosenRow +
        bestRow +
        (stage.principalRationale
          ? '<div class="debrief-rationale">' +
              '<strong style="color:var(--accent)">Principal perspective: </strong>' +
              _esc(stage.principalRationale) +
            '</div>'
          : '') +
      '</div>';
    }).join('');

    var takeaways = (scenario.debrief.keyTakeaways || []).map(function (t) {
      return '<li>' + _esc(t) + '</li>';
    }).join('');

    var reading = (scenario.debrief.furtherReading || []).map(function (r) {
      return '<li>' + _esc(r) + '</li>';
    }).join('');

    return '<div class="debrief-panel">' +
      '<div class="debrief-header">' +
        '<div>' +
          '<div style="font-family:var(--font-mono);font-size:11px;font-weight:700;' +
            'letter-spacing:0.08em;color:var(--text-muted);text-transform:uppercase;margin-bottom:var(--sp-2)">' +
            'Principal Engineer Debrief' +
          '</div>' +
          '<div class="debrief-title">' + _esc(scenario.title) + '</div>' +
        '</div>' +
        '<div class="final-score-display">' +
          '<div class="final-score-value ' + _tierCssClass(tier) + '">' + totalSc + '</div>' +
          '<div class="final-score-100">/ ' + maxSc + '</div>' +
          '<div class="final-score-tier ' + _tierCssClass(tier) + '">' + _tierLabel(tier) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="debrief-body">' +
        '<div class="debrief-summary">' + _esc(scenario.debrief.summary) + '</div>' +
        '<div class="debrief-stages">' + stageBreakdowns + '</div>' +
        (takeaways
          ? '<div class="debrief-takeaways"><h4>Key Takeaways</h4><ul>' + takeaways + '</ul></div>'
          : '') +
        (reading
          ? '<div class="debrief-reading"><h4>Further Reading</h4><ul>' + reading + '</ul></div>'
          : '') +
        '<div class="debrief-actions">' +
          '<button class="btn btn-secondary" onclick="EM.Lab._resetScenario(\'' + scenario.id + '\')">' +
            'Retry Scenario' +
          '</button>' +
          '<button class="btn btn-ghost" onclick="EM.Router.navigate(\'/decision-lab\')">' +
            '&larr; All Scenarios' +
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
        feedbackDiv.textContent = opt.feedback;
        btn.querySelector('span:last-child').appendChild(feedbackDiv);
      }
    });

    // Show principal rationale
    var rationaleDiv = document.getElementById('stage-rationale-' + stageId);
    if (rationaleDiv && stage.principalRationale) {
      rationaleDiv.className = 'stage-rationale visible';
      rationaleDiv.innerHTML =
        '<div class="stage-rationale-label">Principal Engineer Perspective</div>' +
        _esc(stage.principalRationale);
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
          'View Full Debrief &amp; Score' +
        '</button>';
    } else {
      nextDiv.innerHTML =
        '<button class="btn btn-primary" onclick="EM.Lab._advanceStage(\'' + scenarioId + '\', ' + (stageIdx + 1) + ')">' +
          'Next Stage &rarr;' +
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
