/* ============================================================
   ENGINEERING MASTERY — Lesson Renderer
   Fetch → parse frontmatter → render markdown → post-process
   ============================================================ */

window.EM = window.EM || {};

EM.Renderer = (function () {
  'use strict';

  /* ----------------------------------------------------------
     State
  ---------------------------------------------------------- */
  var _trackCache    = {};
  var _markedReady   = false;
  var _mermaidReady  = false;

  /* ----------------------------------------------------------
     Utilities
  ---------------------------------------------------------- */
  function _esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _slugify(text) {
    return text.toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
  }

  /* ----------------------------------------------------------
     Frontmatter Parser
     Splits '---\nYAML\n---\nBody' using js-yaml
  ---------------------------------------------------------- */
  function _parseFrontmatter(raw) {
    var match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) return { meta: {}, body: raw };
    var meta = {};
    try {
      if (typeof jsyaml !== 'undefined') {
        meta = jsyaml.load(match[1]) || {};
      } else {
        // Minimal fallback: parse key: value pairs
        match[1].split('\n').forEach(function (line) {
          var kv = line.match(/^([^:]+):\s*(.+)$/);
          if (kv) meta[kv[1].trim()] = kv[2].trim();
        });
      }
    } catch (e) {
      console.warn('[EM.Renderer] Frontmatter parse error:', e);
    }
    return { meta: meta, body: match[2] };
  }

  /* ----------------------------------------------------------
     Configure marked.js
  ---------------------------------------------------------- */
  function _configureMarked() {
    if (_markedReady || typeof marked === 'undefined') return;

    marked.use({
      gfm: true,
      breaks: false,
      renderer: {
        /* Custom heading: add id for anchor linking */
        heading: function (token) {
          var text  = token.text;
          var depth = token.depth;
          var id    = _slugify(text.replace(/<[^>]*>/g, ''));
          return '<h' + depth + ' id="' + _esc(id) + '">' + text + '</h' + depth + '>\n';
        },

        /* Custom code block: handle mermaid + java17/21 */
        code: function (token) {
          var code = token.text;
          var lang = (token.lang || '').trim().toLowerCase();

          if (lang === 'mermaid') {
            return '<div class="mermaid-block"><pre class="mermaid">' + _esc(code) + '</pre></div>\n';
          }

          var version = '';
          var hlLang  = lang;
          if (lang === 'java17') { version = 'java17'; hlLang = 'java'; }
          if (lang === 'java21') { version = 'java21'; hlLang = 'java'; }

          var langClass    = hlLang ? 'language-' + hlLang : '';
          var versionAttr  = version ? ' data-version="' + version + '"' : '';
          var versionClass = version ? ' code-version' : '';

          return '<pre class="code-block ' + langClass + versionClass + '"' + versionAttr + '>' +
            '<code class="' + langClass + '">' + _esc(code) + '</code>' +
          '</pre>\n';
        }
      }
    });

    _markedReady = true;
  }

  /* ----------------------------------------------------------
     Load Track Data
  ---------------------------------------------------------- */
  async function _loadTrack(trackId) {
    if (_trackCache[trackId]) return _trackCache[trackId];

    var appTrack = null;
    for (var i = 0; i < EM.App.tracks.length; i++) {
      if (EM.App.tracks[i].id === trackId) { appTrack = EM.App.tracks[i]; break; }
    }
    if (!appTrack) return null;

    var path = 'content/tracks/' + trackId + '-' + appTrack.slug + '/_track.json';
    try {
      var resp = await fetch(path);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();
      _trackCache[trackId] = data;
      return data;
    } catch (e) {
      console.error('[EM.Renderer] Failed to load track data for', trackId, e);
      return null;
    }
  }

  /* ----------------------------------------------------------
     Main Entry Point: render a lesson
  ---------------------------------------------------------- */
  async function renderLesson(trackId, lessonId) {
    // 1. Track data
    var trackData = await _loadTrack(trackId);
    if (!trackData) return _errorHtml('Track not found: ' + _esc(trackId));

    // 2. Find lesson in track
    var lesson = null;
    var lessonIdx = -1;
    for (var i = 0; i < trackData.lessons.length; i++) {
      if (trackData.lessons[i].id === lessonId) { lesson = trackData.lessons[i]; lessonIdx = i; break; }
    }
    if (!lesson) return _errorHtml('Lesson not found: ' + _esc(lessonId));

    // 3. Fetch markdown — 404 means lesson not yet written (show coming soon)
    var mdResp;
    try {
      mdResp = await fetch(lesson.path);
    } catch (e) {
      return _errorHtml('Network error loading lesson: ' + _esc(lesson.path));
    }
    if (mdResp.status === 404) {
      var appTrackForSoon = null;
      for (var k = 0; k < EM.App.tracks.length; k++) {
        if (EM.App.tracks[k].id === trackId) { appTrackForSoon = EM.App.tracks[k]; break; }
      }
      var prevL = lessonIdx > 0 ? trackData.lessons[lessonIdx - 1] : null;
      var nextL = lessonIdx < trackData.lessons.length - 1 ? trackData.lessons[lessonIdx + 1] : null;
      return _lessonComingSoon(lesson, appTrackForSoon, trackData, prevL, nextL);
    }
    if (!mdResp.ok) {
      return _errorHtml('Could not load lesson content from: ' + _esc(lesson.path));
    }
    var raw = await mdResp.text();

    // 4. Parse frontmatter
    var parsed = _parseFrontmatter(raw);

    // 5. Configure + render markdown
    _configureMarked();
    var bodyHtml = typeof marked !== 'undefined'
      ? marked.parse(parsed.body)
      : '<pre>' + _esc(parsed.body) + '</pre>';

    // 6. Prev / next
    var prevLesson = lessonIdx > 0 ? trackData.lessons[lessonIdx - 1] : null;
    var nextLesson = lessonIdx < trackData.lessons.length - 1 ? trackData.lessons[lessonIdx + 1] : null;

    // 7. App track (for color)
    var appTrack = null;
    for (var j = 0; j < EM.App.tracks.length; j++) {
      if (EM.App.tracks[j].id === trackId) { appTrack = EM.App.tracks[j]; break; }
    }

    // 8. Update progress: in-progress
    EM.Progress.setLessonStatus(lessonId, 'in-progress');

    // 9. Assemble page HTML
    return _buildPageHtml(parsed.meta, bodyHtml, appTrack, trackData, lesson, prevLesson, nextLesson);
  }

  /* ----------------------------------------------------------
     Build Lesson Page HTML
  ---------------------------------------------------------- */
  function _buildPageHtml(meta, bodyHtml, appTrack, trackData, lesson, prevLesson, nextLesson) {
    var color  = (appTrack && appTrack.color) || '#f97316';
    var num    = trackData ? String(trackData.sequence || '').padStart(2, '0') : '00';
    var status = EM.Progress.getLessonStatus(lesson.id);

    // Breadcrumb
    var breadcrumb =
      '<nav class="lesson-breadcrumb" aria-label="Breadcrumb">' +
        '<button onclick="EM.Router.navigate(\'/\')">Dashboard</button>' +
        '<span class="lesson-breadcrumb-sep">›</span>' +
        '<button onclick="EM.Router.navigate(\'/curriculum\')">Curriculum</button>' +
        '<span class="lesson-breadcrumb-sep">›</span>' +
        '<button onclick="EM.Router.navigate(\'/curriculum/track/' + (appTrack ? appTrack.id : '') + '\')">' +
          _esc(trackData ? trackData.title : '') +
        '</button>' +
        '<span class="lesson-breadcrumb-sep">›</span>' +
        '<span>' + _esc(meta.title || lesson.title) + '</span>' +
      '</nav>';

    // Header
    var mins   = meta['estimated-minutes'] || lesson.estimatedMinutes || '?';
    var prereqs = '';
    if (meta.prerequisites && meta.prerequisites.length) {
      prereqs = '<div class="lesson-prereqs">' +
        '<span class="lesson-prereqs-label">Prerequisites:</span>' +
        meta.prerequisites.map(function (p) {
          return '<button class="prereq-link" onclick="EM.Router.navigate(\'/tracks/' +
            (appTrack ? appTrack.id : '') + '/lessons/' + _esc(p) + '\')">' + _esc(p) + '</button>';
        }).join('<span style="color:var(--text-muted)"> · </span>') +
      '</div>';
    }

    var javaVersions = '';
    if (meta['java-versions'] && meta['java-versions'].length) {
      javaVersions = meta['java-versions'].map(function (v) {
        return '<span class="badge badge-planned">Java ' + v + '</span>';
      }).join('');
    }

    var header =
      '<div class="lesson-header">' +
        '<div class="lesson-track-label">' +
          '<span class="lesson-track-dot" style="background:' + color + '"></span>' +
          'TRACK ' + num + ' — ' + _esc(trackData ? trackData.title : '') +
        '</div>' +
        '<h1 class="lesson-title">' + _esc(meta.title || lesson.title) + '</h1>' +
        '<div class="lesson-meta-row">' +
          EM.difficultyBadge(meta.difficulty || lesson.difficulty) +
          javaVersions +
          '<span class="lesson-meta-item">' +
            EM.Icons.clock +
            '<span>' + mins + ' min</span>' +
          '</span>' +
        '</div>' +
        prereqs +
      '</div>';

    // Complete button
    var completedClass = status === 'completed' ? ' completed' : '';
    var completedText  = status === 'completed' ? 'Completed' : 'Mark as Complete';
    var completeBtn =
      '<div class="lesson-complete-wrap">' +
        '<button class="lesson-complete-btn' + completedClass + '" ' +
          'id="lesson-complete-btn" ' +
          'onclick="EM.Renderer.toggleComplete(\'' + lesson.id + '\')">' +
          EM.Icons.check +
          '<span id="lesson-complete-label">' + completedText + '</span>' +
        '</button>' +
      '</div>';

    // Prev/Next nav
    var prevHtml = prevLesson
      ? '<button class="lesson-nav-btn prev" ' +
          'onclick="EM.Router.navigate(\'/tracks/' + (appTrack ? appTrack.id : '') +
          '/lessons/' + prevLesson.id + '\')">' +
          '<span class="lesson-nav-label">← Previous</span>' +
          '<span class="lesson-nav-title">' + _esc(prevLesson.title) + '</span>' +
        '</button>'
      : '<div></div>';

    var nextHtml = nextLesson
      ? '<button class="lesson-nav-btn next" ' +
          'onclick="EM.Router.navigate(\'/tracks/' + (appTrack ? appTrack.id : '') +
          '/lessons/' + nextLesson.id + '\')">' +
          '<span class="lesson-nav-label">Next →</span>' +
          '<span class="lesson-nav-title">' + _esc(nextLesson.title) + '</span>' +
        '</button>'
      : '<div></div>';

    var footerNav =
      '<div class="lesson-nav" role="navigation" aria-label="Lesson navigation">' +
        prevHtml + nextHtml +
      '</div>';

    return '<div class="lesson-wrap">' +
      '<div class="lesson-main">' +
        breadcrumb +
        header +
        '<div class="lesson-body" id="lesson-body">' +
          bodyHtml +
        '</div>' +
        completeBtn +
        footerNav +
      '</div>' +
    '</div>';
  }

  /* ----------------------------------------------------------
     Toggle Lesson Complete
  ---------------------------------------------------------- */
  function toggleComplete(lessonId) {
    var status  = EM.Progress.getLessonStatus(lessonId);
    var next    = status === 'completed' ? 'in-progress' : 'completed';
    EM.Progress.setLessonStatus(lessonId, next);
    var btn     = document.getElementById('lesson-complete-btn');
    var label   = document.getElementById('lesson-complete-label');
    if (btn && label) {
      if (next === 'completed') {
        btn.classList.add('completed');
        label.textContent = 'Completed';
      } else {
        btn.classList.remove('completed');
        label.textContent = 'Mark as Complete';
      }
    }
  }

  /* ----------------------------------------------------------
     Post-Processing: runs after HTML is injected into DOM
  ---------------------------------------------------------- */
  function initComponents(container) {
    var body = container.querySelector('#lesson-body');
    if (!body) return;

    _transformCallouts(body);
    _buildCodeTabs(body);
    _addCopyButtons(body);
    _initMermaid(body);
    _initPrism(body);
    _initKnowledgeCheck(body);
    _initPracticalChallenge(body, container);
  }

  /* ----------------------------------------------------------
     Transform Callout Blockquotes
     Converts: <blockquote><p>[!NOTE]\ncontent</p></blockquote>
     To: <div class="callout callout-note">...</div>
  ---------------------------------------------------------- */
  var CALLOUT_TYPES = {
    'NOTE':      { cls: 'callout-note',      icon: 'ℹ️',  label: 'Note'      },
    'TIP':       { cls: 'callout-tip',       icon: '💡', label: 'Tip'       },
    'IMPORTANT': { cls: 'callout-important', icon: '⚡',  label: 'Important' },
    'WARNING':   { cls: 'callout-warning',   icon: '⚠️',  label: 'Warning'   },
    'DANGER':    { cls: 'callout-danger',    icon: '🚨', label: 'Danger'    }
  };

  function _transformCallouts(body) {
    var blockquotes = body.querySelectorAll('blockquote');
    blockquotes.forEach(function (bq) {
      var firstP = bq.querySelector('p');
      if (!firstP) return;
      var text = firstP.textContent || '';
      var match = text.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|DANGER)\]\s*/i);
      if (!match) return;
      var type = match[1].toUpperCase();
      var def  = CALLOUT_TYPES[type];
      if (!def) return;

      // Remove the [!TYPE] marker from text
      firstP.innerHTML = firstP.innerHTML.replace(/^\[!(NOTE|TIP|IMPORTANT|WARNING|DANGER)\]\s*/i, '');

      // Build callout div
      var div = document.createElement('div');
      div.className = 'callout ' + def.cls;
      div.setAttribute('role', 'note');
      div.innerHTML =
        '<div class="callout-icon">' + def.icon + '</div>' +
        '<div class="callout-body">' +
          '<div class="callout-title">' + def.label + '</div>' +
          bq.innerHTML +
        '</div>';

      bq.parentNode.replaceChild(div, bq);
    });
  }

  /* ----------------------------------------------------------
     Build Java 17/21 Code Tab Groups
     Finds adjacent java17 + java21 pre elements and wraps them
  ---------------------------------------------------------- */
  function _buildCodeTabs(body) {
    var allPre = body.querySelectorAll('pre.code-version');
    var i = 0;

    while (i < allPre.length) {
      var pre17 = allPre[i];
      var ver17 = pre17.getAttribute('data-version');

      if (ver17 === 'java17') {
        // Look for adjacent java21 sibling (skipping text nodes)
        var next = pre17.nextSibling;
        while (next && next.nodeType === Node.TEXT_NODE) next = next.nextSibling;

        if (next && next.nodeType === Node.ELEMENT_NODE &&
            next.classList.contains('code-version') &&
            next.getAttribute('data-version') === 'java21') {
          var pre21 = next;
          _wrapTabGroup(pre17, pre21);
          i += 2;
          continue;
        }
        // Standalone java17
        _wrapSingleVersion(pre17, 'java17');
      } else if (ver17 === 'java21') {
        _wrapSingleVersion(pre17, 'java21');
      }
      i++;
    }
  }

  function _wrapTabGroup(pre17, pre21) {
    var group = document.createElement('div');
    group.className = 'code-tab-group';

    var nav = document.createElement('div');
    nav.className = 'code-tab-nav';
    nav.innerHTML =
      '<button class="code-tab-btn active" data-ver="java17" data-pane="pane-17">' +
        'Java 17 <span class="tab-ver-badge">LTS</span>' +
      '</button>' +
      '<button class="code-tab-btn" data-ver="java21" data-pane="pane-21">' +
        'Java 21 <span class="tab-ver-badge">LTS</span>' +
      '</button>';

    var pane17 = document.createElement('div');
    pane17.className = 'code-tab-pane active';
    pane17.id = 'pane-17-' + Math.random().toString(36).slice(2, 7);
    pane17.appendChild(pre17.cloneNode(true));

    var pane21 = document.createElement('div');
    pane21.className = 'code-tab-pane';
    pane21.id = 'pane-21-' + Math.random().toString(36).slice(2, 7);
    pane21.appendChild(pre21.cloneNode(true));

    // Fix pane IDs in nav buttons
    nav.querySelectorAll('.code-tab-btn').forEach(function (btn, idx) {
      btn.setAttribute('data-pane', idx === 0 ? pane17.id : pane21.id);
    });

    group.appendChild(nav);
    group.appendChild(pane17);
    group.appendChild(pane21);

    pre17.parentNode.insertBefore(group, pre17);
    pre17.parentNode.removeChild(pre17);
    if (pre21.parentNode) pre21.parentNode.removeChild(pre21);

    // Wire up tab clicks
    nav.querySelectorAll('.code-tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var paneId = btn.getAttribute('data-pane');
        nav.querySelectorAll('.code-tab-btn').forEach(function (b) { b.classList.remove('active'); });
        group.querySelectorAll('.code-tab-pane').forEach(function (p) { p.classList.remove('active'); });
        btn.classList.add('active');
        document.getElementById(paneId).classList.add('active');
      });
    });
  }

  function _wrapSingleVersion(pre, version) {
    var label = version === 'java17' ? 'Java 17' : 'Java 21';
    var wrap  = document.createElement('div');
    wrap.className = 'code-tab-group';

    var nav = document.createElement('div');
    nav.className = 'code-tab-nav';
    nav.innerHTML = '<button class="code-tab-btn active" data-ver="' + version + '">' +
      label + ' <span class="tab-ver-badge">LTS</span>' +
    '</button>';

    var pane = document.createElement('div');
    pane.className = 'code-tab-pane active';
    pane.appendChild(pre.cloneNode(true));

    wrap.appendChild(nav);
    wrap.appendChild(pane);
    pre.parentNode.insertBefore(wrap, pre);
    pre.parentNode.removeChild(pre);
  }

  /* ----------------------------------------------------------
     Inject Copy Buttons
  ---------------------------------------------------------- */
  function _addCopyButtons(body) {
    body.querySelectorAll('pre.code-block, pre[class*="language-"]').forEach(function (pre) {
      if (pre.querySelector('.code-copy-btn')) return;
      pre.style.position = 'relative';
      var btn = document.createElement('button');
      btn.className  = 'code-copy-btn';
      btn.textContent = 'Copy';
      btn.setAttribute('aria-label', 'Copy code');
      btn.addEventListener('click', function () {
        var code = pre.querySelector('code');
        var text = code ? code.textContent : pre.textContent;
        navigator.clipboard.writeText(text).then(function () {
          btn.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(function () {
            btn.textContent = 'Copy';
            btn.classList.remove('copied');
          }, 2000);
        }).catch(function () {
          btn.textContent = 'Error';
        });
      });
      pre.appendChild(btn);
    });
  }

  /* ----------------------------------------------------------
     Initialize Mermaid
  ---------------------------------------------------------- */
  function _initMermaid(body) {
    if (typeof mermaid === 'undefined') return;
    var elements = body.querySelectorAll('.mermaid');
    if (!elements.length) return;

    var theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default';

    if (!_mermaidReady) {
      mermaid.initialize({
        startOnLoad: false,
        theme:       theme,
        fontFamily:  'Inter, system-ui, sans-serif',
        fontSize:    14,
        flowchart:   { htmlLabels: true, curve: 'basis' },
        sequence:    { actorMargin: 50, messageMargin: 40 },
        themeVariables: theme === 'dark' ? {
          primaryColor:      '#1c2128',
          primaryTextColor:  '#e6edf3',
          primaryBorderColor:'#30363d',
          lineColor:         '#8b949e',
          secondaryColor:    '#21262d',
          tertiaryColor:     '#161b22'
        } : {}
      });
      _mermaidReady = true;
    }

    mermaid.run({ nodes: Array.from(elements) }).catch(function (err) {
      console.warn('[EM.Renderer] Mermaid render error:', err);
    });
  }

  /* ----------------------------------------------------------
     Initialize Prism
  ---------------------------------------------------------- */
  function _initPrism(body) {
    if (typeof Prism === 'undefined') return;
    Prism.highlightAllUnder(body);
  }

  /* ----------------------------------------------------------
     Initialize KaTeX
  ---------------------------------------------------------- */
  function _initKatex(body) {
    if (typeof renderMathInElement === 'undefined') return;
    renderMathInElement(body, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$',  right: '$',  display: false }
      ],
      throwOnError: false
    });
  }

  /* ----------------------------------------------------------
     Initialize Knowledge Check
     Finds <!-- KNOWLEDGE-CHECK [...] --> comments in DOM
  ---------------------------------------------------------- */
  function _initKnowledgeCheck(body) {
    var comments = _findComments(body, 'KNOWLEDGE-CHECK');
    comments.forEach(function (node) {
      var raw = node.nodeValue.replace(/^\s*KNOWLEDGE-CHECK\s*/, '').trim();
      var questions;
      try { questions = JSON.parse(raw); } catch (e) { return; }
      var el = _renderKnowledgeCheck(questions);
      node.parentNode.replaceChild(el, node);
    });
  }

  function _renderKnowledgeCheck(questions) {
    var wrap = document.createElement('div');
    wrap.className = 'knowledge-check';

    var header = document.createElement('div');
    header.className = 'knowledge-check-header';
    header.innerHTML =
      '<div class="knowledge-check-icon">🧠</div>' +
      '<div>' +
        '<div class="knowledge-check-title">Knowledge Check</div>' +
        '<div class="knowledge-check-subtitle">' + questions.length + ' question' +
          (questions.length !== 1 ? 's' : '') + ' — click an option to answer</div>' +
      '</div>';
    wrap.appendChild(header);

    var answered = 0;

    questions.forEach(function (q, qi) {
      var letters = ['A', 'B', 'C', 'D', 'E'];
      var qDiv = document.createElement('div');
      qDiv.className = 'kc-question';

      var num = document.createElement('div');
      num.className = 'kc-question-num';
      num.textContent = 'Question ' + (qi + 1) + ' of ' + questions.length;

      var text = document.createElement('div');
      text.className = 'kc-question-text';
      text.textContent = q.q || q.text || '';

      var opts = document.createElement('div');
      opts.className = 'kc-options';

      var explanation = document.createElement('div');
      explanation.className = 'kc-explanation';
      explanation.textContent = q.explanation || '';

      q.options.forEach(function (opt, oi) {
        var btn = document.createElement('button');
        btn.className = 'kc-option';
        btn.innerHTML =
          '<span class="kc-option-letter">' + letters[oi] + '</span>' +
          '<span>' + _esc(opt) + '</span>';
        btn.addEventListener('click', function () {
          if (btn.disabled) return;
          // Disable all options for this question
          opts.querySelectorAll('.kc-option').forEach(function (b) {
            b.disabled = true;
            var correctIdx = (q.answer !== undefined) ? q.answer : (q.correct !== undefined ? q.correct : -1);
            if (parseInt(b.getAttribute('data-index')) === correctIdx) {
              b.classList.add('revealed-correct');
            }
          });
          if (oi === correctIdx) {
            btn.classList.add('correct');
          } else {
            btn.classList.add('incorrect');
          }
          explanation.classList.add('visible');
          answered++;
          if (answered === questions.length) {
            var score = wrap.querySelectorAll('.kc-option.correct').length;
            var scoreEl = wrap.querySelector('.kc-score');
            if (scoreEl) {
              scoreEl.classList.add('visible');
              scoreEl.innerHTML = '✅ Score: ' + score + ' / ' + questions.length;
            }
          }
        });
        btn.setAttribute('data-index', oi);
        opts.appendChild(btn);
      });

      qDiv.appendChild(num);
      qDiv.appendChild(text);
      qDiv.appendChild(opts);
      qDiv.appendChild(explanation);
      wrap.appendChild(qDiv);
    });

    var score = document.createElement('div');
    score.className = 'kc-score';
    wrap.appendChild(score);

    return wrap;
  }

  /* ----------------------------------------------------------
     Initialize Practical Challenge
     Finds <!-- PRACTICAL-CHALLENGE {...} --> comments in DOM
  ---------------------------------------------------------- */
  function _initPracticalChallenge(body, container) {
    var lessonId = null;
    var lessonBody = container.querySelector('#lesson-body');
    // Try to infer lessonId from the complete button
    var completeBtn = container.querySelector('#lesson-complete-btn');
    if (completeBtn) {
      var onclick = completeBtn.getAttribute('onclick') || '';
      var m = onclick.match(/toggleComplete\('([^']+)'\)/);
      if (m) lessonId = m[1];
    }

    var comments = _findComments(body, 'PRACTICAL-CHALLENGE');
    comments.forEach(function (node) {
      var raw = node.nodeValue.replace(/^\s*PRACTICAL-CHALLENGE\s*/, '').trim();
      var config;
      try { config = JSON.parse(raw); } catch (e) { return; }
      var el = _renderPracticalChallenge(config, lessonId);
      node.parentNode.replaceChild(el, node);
    });
  }

  function _renderPracticalChallenge(config, lessonId) {
    var wrap = document.createElement('div');
    wrap.className = 'practical-challenge';

    var header = document.createElement('div');
    header.className = 'practical-challenge-header';
    header.innerHTML =
      '<div class="practical-challenge-icon">⚡</div>' +
      '<div>' +
        '<div class="practical-challenge-label">Practical Challenge</div>' +
        '<div class="practical-challenge-title">' + _esc(config.title || '') + '</div>' +
      '</div>';
    wrap.appendChild(header);

    if (config.description) {
      var desc = document.createElement('p');
      desc.className = 'practical-challenge-desc';
      desc.textContent = config.description;
      wrap.appendChild(desc);
    }

    var tasks = document.createElement('div');
    tasks.className = 'challenge-tasks';

    (config.tasks || []).forEach(function (task, ti) {
      var itemId = 'task-' + ti;
      var savedItems = lessonId ? (EM.Progress.load().lessons[lessonId] || {}).practicalItems || {} : {};
      var isDone = savedItems[itemId] || false;

      var div = document.createElement('div');
      div.className = 'challenge-task' + (isDone ? ' done' : '');

      var check = document.createElement('div');
      check.className = 'challenge-task-check';
      check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="20 6 9 17 4 12"/></svg>';

      var text = document.createElement('div');
      text.className = 'challenge-task-text';
      text.textContent = typeof task === 'string' ? task : (task.description || task.text || task.title || '');

      div.appendChild(check);
      div.appendChild(text);

      div.addEventListener('click', function () {
        var done = div.classList.toggle('done');
        if (lessonId) EM.Progress.savePracticalItem(lessonId, itemId, done);
      });

      tasks.appendChild(div);
    });

    wrap.appendChild(tasks);
    return wrap;
  }

  /* ----------------------------------------------------------
     Find HTML Comments by prefix
  ---------------------------------------------------------- */
  function _findComments(container, prefix) {
    var results  = [];
    var iterator = document.createNodeIterator(container, NodeFilter.SHOW_COMMENT);
    var node;
    while ((node = iterator.nextNode())) {
      if (node.nodeValue.trimStart().startsWith(prefix)) {
        results.push(node);
      }
    }
    return results;
  }

  /* ----------------------------------------------------------
     Lesson Coming Soon (file not yet written)
  ---------------------------------------------------------- */
  function _lessonComingSoon(lesson, appTrack, trackData, prevLesson, nextLesson) {
    var color  = (appTrack && appTrack.color) || '#f97316';
    var num    = trackData ? String(trackData.sequence || '').padStart(2, '0') : '00';
    var lNum   = String(lesson.sequence || '').padStart(2, '0');
    var mins   = lesson.estimatedMinutes ? lesson.estimatedMinutes + ' min' : '';
    var tags   = (lesson.tags || []).map(function (t) {
      return '<span class="tag-chip">' + _esc(t) + '</span>';
    }).join('');

    var prevHtml = prevLesson
      ? '<button class="lesson-nav-btn prev" ' +
          'onclick="EM.Router.navigate(\'/tracks/' + (appTrack ? appTrack.id : '') +
          '/lessons/' + prevLesson.id + '\')">' +
          '<span class="lesson-nav-label">← Previous</span>' +
          '<span class="lesson-nav-title">' + _esc(prevLesson.title) + '</span>' +
        '</button>'
      : '<div></div>';

    var nextHtml = nextLesson
      ? '<button class="lesson-nav-btn next" ' +
          'onclick="EM.Router.navigate(\'/tracks/' + (appTrack ? appTrack.id : '') +
          '/lessons/' + nextLesson.id + '\')">' +
          '<span class="lesson-nav-label">Next →</span>' +
          '<span class="lesson-nav-title">' + _esc(nextLesson.title) + '</span>' +
        '</button>'
      : '<div></div>';

    return '<div class="lesson-wrap"><div class="lesson-main">' +
      '<nav class="lesson-breadcrumb">' +
        '<button onclick="EM.Router.navigate(\'/\')">Dashboard</button>' +
        '<span class="lesson-breadcrumb-sep">›</span>' +
        '<button onclick="EM.Router.navigate(\'/curriculum\')">Curriculum</button>' +
        '<span class="lesson-breadcrumb-sep">›</span>' +
        '<button onclick="EM.Router.navigate(\'/curriculum/track/' + (appTrack ? appTrack.id : '') + '\')">' +
          _esc(trackData ? trackData.title : '') +
        '</button>' +
        '<span class="lesson-breadcrumb-sep">›</span>' +
        '<span>' + _esc(lesson.title) + '</span>' +
      '</nav>' +
      '<div class="lesson-header">' +
        '<div class="lesson-track-label">' +
          '<span class="lesson-track-dot" style="background:' + color + '"></span>' +
          'TRACK ' + num + ' — LESSON ' + lNum +
        '</div>' +
        '<h1 class="lesson-title" style="color:var(--text-primary)">' + _esc(lesson.title) + '</h1>' +
        '<div class="lesson-meta-row">' +
          EM.difficultyBadge(lesson.difficulty) +
          (mins ? '<span class="lesson-meta-item">' + EM.Icons.clock + mins + '</span>' : '') +
          '<span class="badge badge-planned">Coming Soon</span>' +
        '</div>' +
        (tags ? '<div style="display:flex;flex-wrap:wrap;gap:var(--sp-1);margin-top:var(--sp-3)">' + tags + '</div>' : '') +
      '</div>' +
      '<div style="text-align:center;padding:var(--sp-10) var(--sp-8);background:var(--bg-surface);' +
        'border:1px solid var(--border);border-radius:var(--r-xl);border-top:3px solid ' + color + '">' +
        '<div style="font-size:2.5rem;margin-bottom:var(--sp-4)">🏗</div>' +
        '<h2 style="font-size:var(--text-xl);font-weight:600;color:var(--text-primary);margin-bottom:var(--sp-3)">Lesson In Development</h2>' +
        '<p style="color:var(--text-secondary);max-width:480px;margin:0 auto">' +
          'This lesson is part of the published curriculum and will be released in a future update. ' +
          'The lesson outline, prerequisites, and estimated completion time are shown above.' +
        '</p>' +
      '</div>' +
      '<div class="lesson-nav" style="margin-top:var(--sp-8)">' + prevHtml + nextHtml + '</div>' +
    '</div></div>';
  }

  /* ----------------------------------------------------------
     Error / Not Found HTML
  ---------------------------------------------------------- */
  function _errorHtml(msg) {
    return '<div class="error-wrap">' +
      '<div class="error-icon">⚠</div>' +
      '<h2 class="error-title">Could Not Load Lesson</h2>' +
      '<p class="error-msg">' + _esc(msg) + '</p>' +
      '<button class="btn btn-secondary" onclick="EM.Router.navigate(\'/curriculum\')" style="margin-top:16px">' +
        'Back to Curriculum' +
      '</button>' +
    '</div>';
  }

  /* ----------------------------------------------------------
     Global listener: run initComponents after each page render
  ---------------------------------------------------------- */
  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('main-content').addEventListener('em:page-rendered', function () {
      var container = document.getElementById('main-content');
      if (container && container.querySelector('.lesson-body')) {
        EM.Renderer.initComponents(container);
      }
    });
  });

  /* ----------------------------------------------------------
     Public API
  ---------------------------------------------------------- */
  /* ----------------------------------------------------------
     Public: convert a markdown string to HTML
     Used by capstone.js and any other module that needs
     consistent markdown rendering without a full lesson page.
  ---------------------------------------------------------- */
  function convertMd(md) {
    _configureMarked();
    if (typeof marked === 'undefined') {
      // Fallback: basic HTML escaping if marked hasn't loaded
      return '<p>' + _esc(md) + '</p>';
    }
    return marked.parse(md || '');
  }

  return {
    renderLesson:    renderLesson,
    initComponents:  initComponents,
    toggleComplete:  toggleComplete,
    convertMd:       convertMd
  };
}());
