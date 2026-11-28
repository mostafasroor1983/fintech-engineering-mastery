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
  var _trackCache    = {};   // key: lang + ':' + trackId

  EM.I18n.add({
    en: {
      'les.prereqs': 'Prerequisites:', 'les.track': 'TRACK {n} — {t}', 'les.trackLesson': 'TRACK {n} — LESSON {l}',
      'les.complete': 'Mark as Complete', 'les.completed': 'Completed', 'les.prev': '← Previous', 'les.next': 'Next →',
      'les.soon': 'Coming Soon', 'les.inDev': 'Lesson In Development',
      'les.inDevMsg': 'This lesson is part of the published curriculum and will be released in a future update. The lesson outline, prerequisites, and estimated completion time are shown above.',
      'les.cantLoad': 'Could Not Load Lesson', 'les.backCur': 'Back to Curriculum',
      'les.trackNotFound': 'Track not found: {id}', 'les.lessonNotFound': 'Lesson not found: {id}',
      'les.netErr': 'Network error loading lesson: {p}', 'les.loadErr': 'Could not load lesson content from: {p}',
      'les.note': 'Note', 'les.tip': 'Tip', 'les.important': 'Important', 'les.warning': 'Warning', 'les.danger': 'Danger',
      'les.tableRegion': 'Table (scrolls sideways)',
      'les.copy': 'Copy', 'les.copyCode': 'Copy code', 'les.copied': 'Copied!', 'les.copyErr': 'Error',
      'les.question': 'Question {n} of {total}', 'les.score': 'Score: {a} / {b}',
      'les.zoomOut': 'Zoom out', 'les.zoomIn': 'Zoom in', 'les.zoomReset': 'Reset zoom', 'les.full': 'Fullscreen', 'les.close': 'Close',
      'les.kc': 'Knowledge Check', 'les.kcSub1': '1 question — click an option to answer',
      'les.kcSubN': '{n} questions — click an option to answer', 'les.challenge': 'Practical Challenge'
    },
    ar: {
      'les.tableRegion': 'جدول (يُمرَّر أفقيًا)', 'les.prereqs': 'المتطلبات السابقة:', 'les.track': 'المسار {n} — {t}', 'les.trackLesson': 'المسار {n} — الدرس {l}',
      'les.complete': 'تحديد كمكتمل', 'les.completed': 'مكتمل', 'les.prev': '→ السابق', 'les.next': 'التالي ←',
      'les.soon': 'قريبًا', 'les.inDev': 'الدرس قيد الإعداد',
      'les.inDevMsg': 'هذا الدرس جزء من المنهج المنشور وسيُضاف في تحديث قادم. المخطط والمتطلبات السابقة والوقت المتوقع معروضة في الأعلى.',
      'les.cantLoad': 'تعذّر تحميل الدرس', 'les.backCur': 'العودة إلى المنهج',
      'les.trackNotFound': 'المسار غير موجود: {id}', 'les.lessonNotFound': 'الدرس غير موجود: {id}',
      'les.netErr': 'خطأ في الشبكة أثناء تحميل الدرس: {p}', 'les.loadErr': 'تعذّر تحميل محتوى الدرس من: {p}',
      'les.note': 'ملاحظة', 'les.tip': 'نصيحة', 'les.important': 'مهم', 'les.warning': 'تحذير', 'les.danger': 'خطر',
      'les.copy': 'نسخ', 'les.copyCode': 'نسخ الشيفرة', 'les.copied': 'تم النسخ!', 'les.copyErr': 'خطأ',
      'les.question': 'السؤال {n} من {total}', 'les.score': 'النتيجة: {a} من {b}',
      'les.zoomOut': 'تصغير', 'les.zoomIn': 'تكبير', 'les.zoomReset': 'إعادة الحجم', 'les.full': 'ملء الشاشة', 'les.close': 'إغلاق',
      'les.kc': 'اختبر فهمك', 'les.kcSub1': 'سؤال واحد — اختر إجابة',
      'les.kcSubN': '{n} أسئلة — اختر إجابة لكل سؤال', 'les.challenge': 'تحدٍّ عملي'
    }
  });
  var _markedReady   = false;
  var _mermaidReady  = false;
  var _mermaidLoad   = null;   // Promise while mermaid.min.js is being fetched

  /* Mermaid is 2.5 MB, so it is fetched only when a page has a diagram (pinned + SRI) */
  var MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js';
  var MERMAID_SRI = 'sha384-rbtjAdnIQE/aQJGEgXrVUlMibdfTSa4PQju4HDhN3sR2PmaKFzhEafuePsl9H/9I';

  /* Prism's autoloader fetches languages from here; fence names Prism doesn't know map to a close one */
  var PRISM_COMPONENTS = 'https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/';
  // '' means plain text: no Prism language is requested
  var LANG_ALIASES = { spl: 'splunk-spl', logql: 'promql', jsonnet: 'javascript', jsonc: 'json', tsv: '' };

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
            // Lessons write line breaks in labels as a literal "\n", which current Mermaid prints as-is
            if (!/^\s*C4/.test(code)) code = code.replace(/\\n/g, '<br/>');
            return '<div class="mermaid-block"><pre class="mermaid">' + _esc(code) + '</pre></div>\n';
          }

          var version = '';
          var hlLang  = lang;
          if (lang === 'java17') { version = 'java17'; hlLang = 'java'; }
          if (lang === 'java21') { version = 'java21'; hlLang = 'java'; }
          if (Object.prototype.hasOwnProperty.call(LANG_ALIASES, hlLang)) hlLang = LANG_ALIASES[hlLang];

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
    var cacheKey = EM.I18n.lang() + ':' + trackId;
    if (_trackCache[cacheKey]) return _trackCache[cacheKey];

    var appTrack = null;
    for (var i = 0; i < EM.App.tracks.length; i++) {
      if (EM.App.tracks[i].id === trackId) { appTrack = EM.App.tracks[i]; break; }
    }
    if (!appTrack) return null;

    var path = 'content/tracks/' + trackId + '-' + appTrack.slug + '/_track.json';
    try {
      var res = await EM.I18n.fetchJSON(path);
      _trackCache[cacheKey] = res.body;
      return res.body;
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
    if (!trackData) return _errorHtml(EM.t('les.trackNotFound', { id: trackId }));

    // 2. Find lesson in track
    var lesson = null;
    var lessonIdx = -1;
    for (var i = 0; i < trackData.lessons.length; i++) {
      if (trackData.lessons[i].id === lessonId) { lesson = trackData.lessons[i]; lessonIdx = i; break; }
    }
    if (!lesson) return _errorHtml(EM.t('les.lessonNotFound', { id: lessonId }));

    // 3. Fetch markdown — 404 means lesson not yet written (show coming soon)
    var mdResp, mdFallback = false;
    try {
      var localPath = EM.I18n.localizedPath(lesson.path);
      if (localPath !== lesson.path) {
        mdResp = await fetch(localPath);
        if (!mdResp.ok) { mdResp = await fetch(lesson.path); mdFallback = true; }
      } else {
        mdResp = await fetch(lesson.path);
      }
    } catch (e) {
      return _errorHtml(EM.t('les.netErr', { p: lesson.path }));
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
      return _errorHtml(EM.t('les.loadErr', { p: lesson.path }));
    }
    var raw = await mdResp.text();

    // 4. Parse frontmatter
    var parsed = _parseFrontmatter(raw);

    // 5. Configure + render markdown
    _configureMarked();
    var bodyHtml = typeof marked !== 'undefined'
      ? marked.parse(parsed.body)
      : '<pre>' + _esc(parsed.body) + '</pre>';
    // The page header already shows the lesson title; drop the markdown's own leading H1
    bodyHtml = bodyHtml.replace(/^\s*<h1\b[^>]*>[\s\S]*?<\/h1>\s*/i, '');

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
    return _buildPageHtml(parsed.meta, bodyHtml, appTrack, trackData, lesson, prevLesson, nextLesson, mdFallback);
  }

  /* ----------------------------------------------------------
     Build Lesson Page HTML
  ---------------------------------------------------------- */
  function _buildPageHtml(meta, bodyHtml, appTrack, trackData, lesson, prevLesson, nextLesson, mdFallback) {
    // A translated lesson's frontmatter may still carry the English title; prefer the localised track listing
    var lessonTitle = EM.I18n.lang() !== 'en' ? (lesson.title || meta.title) : (meta.title || lesson.title);
    var contentDir  = mdFallback ? ' dir="ltr"' : '';
    var color  = (appTrack && appTrack.color) || '#f97316';
    var num    = trackData ? String(trackData.sequence || '').padStart(2, '0') : '00';
    var status = EM.Progress.getLessonStatus(lesson.id);

    // Breadcrumb
    var breadcrumb =
      '<nav class="lesson-breadcrumb" aria-label="Breadcrumb">' +
        '<button onclick="EM.Router.navigate(\'/\')">' + EM.t('nav.dashboard') + '</button>' +
        '<span class="lesson-breadcrumb-sep rtl-flip">›</span>' +
        '<button onclick="EM.Router.navigate(\'/curriculum\')">' + EM.t('nav.curriculum') + '</button>' +
        '<span class="lesson-breadcrumb-sep rtl-flip">›</span>' +
        '<button onclick="EM.Router.navigate(\'/curriculum/track/' + (appTrack ? appTrack.id : '') + '\')">' +
          _esc(trackData ? trackData.title : '') +
        '</button>' +
        '<span class="lesson-breadcrumb-sep rtl-flip">›</span>' +
        '<span>' + _esc(lessonTitle) + '</span>' +
      '</nav>';

    // Header
    var mins   = meta['estimated-minutes'] || lesson.estimatedMinutes || '?';
    var prereqs = '';
    if (meta.prerequisites && meta.prerequisites.length) {
      prereqs = '<div class="lesson-prereqs">' +
        '<span class="lesson-prereqs-label">' + EM.t('les.prereqs') + '</span>' +
        meta.prerequisites.map(function (p) {
          // Lesson ids carry their track (track-05-lesson-14), so cross-track prerequisites route correctly
          var m = /^(track-\d+)-lesson-\d+$/.exec(p);
          var pTrack = m ? m[1] : (appTrack ? appTrack.id : '');
          var label = p;
          (trackData && trackData.lessons || []).forEach(function (l) { if (l.id === p) label = l.title; });
          return '<button class="prereq-link" title="' + _esc(p) + '" onclick="EM.Router.navigate(\'/tracks/' +
            pTrack + '/lessons/' + _esc(p) + '\')">' + _esc(label) + '</button>';
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
          _esc(EM.t('les.track', { n: num, t: trackData ? trackData.title : '' })) +
        '</div>' +
        '<h1 class="lesson-title">' + _esc(lessonTitle) + '</h1>' +
        '<div class="lesson-meta-row">' +
          EM.difficultyBadge(meta.difficulty || lesson.difficulty) +
          javaVersions +
          '<span class="lesson-meta-item">' +
            EM.Icons.clock +
            '<span>' + EM.t('common.min', { n: mins }) + '</span>' +
          '</span>' +
        '</div>' +
        prereqs +
      '</div>';

    // Complete button
    var completedClass = status === 'completed' ? ' completed' : '';
    var completedText  = status === 'completed' ? EM.t('les.completed') : EM.t('les.complete');
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
          '<span class="lesson-nav-label">' + _esc(EM.t('les.prev')) + '</span>' +
          '<span class="lesson-nav-title">' + _esc(prevLesson.title) + '</span>' +
        '</button>'
      : '<div></div>';

    var nextHtml = nextLesson
      ? '<button class="lesson-nav-btn next" ' +
          'onclick="EM.Router.navigate(\'/tracks/' + (appTrack ? appTrack.id : '') +
          '/lessons/' + nextLesson.id + '\')">' +
          '<span class="lesson-nav-label">' + _esc(EM.t('les.next')) + '</span>' +
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
        (mdFallback ? EM.I18n.fallbackNote() : '') +
        '<div class="lesson-body" id="lesson-body"' + contentDir + '>' +
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
        label.textContent = EM.t('les.completed');
      } else {
        btn.classList.remove('completed');
        label.textContent = EM.t('les.complete');
      }
    }
  }

  /* ----------------------------------------------------------
     Post-Processing: runs after HTML is injected into DOM
  ---------------------------------------------------------- */
  function initComponents(container) {
    // #lesson-body on lessons; doc pages (study plan, glossary) use the class only
    var body = container.querySelector('#lesson-body') || container.querySelector('.lesson-body');
    if (!body) return;

    _wrapTables(body);
    _transformCallouts(body);
    _buildCodeTabs(body);
    _addCopyButtons(body);
    _initMermaid(body);
    _initPrism(body);
    _initKnowledgeCheck(body);
    _initPracticalChallenge(body, container);
  }

  /* ----------------------------------------------------------
     Wide tables scroll inside their own box instead of widening the page.
     The box is focusable and labelled so keyboard users can scroll it (WCAG 2.1.1).
  ---------------------------------------------------------- */
  function _wrapTables(body) {
    body.querySelectorAll('table').forEach(function (table) {
      if (table.parentElement && table.parentElement.classList.contains('table-scroll')) return;
      var box = document.createElement('div');
      box.className = 'table-scroll';
      box.setAttribute('role', 'region');
      box.setAttribute('tabindex', '0');
      box.setAttribute('aria-label', EM.t('les.tableRegion'));
      table.parentNode.insertBefore(box, table);
      box.appendChild(table);
    });
  }

  /* ----------------------------------------------------------
     Transform Callout Blockquotes
     Converts: <blockquote><p>[!NOTE]\ncontent</p></blockquote>
     To: <div class="callout callout-note">...</div>
  ---------------------------------------------------------- */
  var CALLOUT_TYPES = {
    'NOTE':      { cls: 'callout-note',      icon: 'ℹ️',  label: 'les.note'      },
    'TIP':       { cls: 'callout-tip',       icon: '💡', label: 'les.tip'       },
    'IMPORTANT': { cls: 'callout-important', icon: '⚡',  label: 'les.important' },
    'WARNING':   { cls: 'callout-warning',   icon: '⚠️',  label: 'les.warning'   },
    'DANGER':    { cls: 'callout-danger',    icon: '🚨', label: 'les.danger'    },
    'CAUTION':   { cls: 'callout-danger',    icon: '🚨', label: 'les.danger'    }
  };

  function _transformCallouts(body) {
    var blockquotes = body.querySelectorAll('blockquote');
    blockquotes.forEach(function (bq) {
      var firstP = bq.querySelector('p');
      if (!firstP) return;
      var text = firstP.textContent || '';
      var match = text.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|DANGER|CAUTION)\]\s*/i);
      if (!match) return;
      var type = match[1].toUpperCase();
      var def  = CALLOUT_TYPES[type];
      if (!def) return;

      // Remove the [!TYPE] marker from text
      firstP.innerHTML = firstP.innerHTML.replace(/^\[!(NOTE|TIP|IMPORTANT|WARNING|DANGER|CAUTION)\]\s*/i, '');

      // Build callout div
      var div = document.createElement('div');
      div.className = 'callout ' + def.cls;
      div.setAttribute('role', 'note');
      div.innerHTML =
        '<div class="callout-icon">' + def.icon + '</div>' +
        '<div class="callout-body">' +
          '<div class="callout-title">' + EM.t(def.label) + '</div>' +
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
      btn.textContent = EM.t('les.copy');
      btn.setAttribute('aria-label', EM.t('les.copyCode'));
      btn.addEventListener('click', function () {
        var code = pre.querySelector('code');
        var text = code ? code.textContent : pre.textContent;
        navigator.clipboard.writeText(text).then(function () {
          btn.textContent = EM.t('les.copied');
          btn.classList.add('copied');
          setTimeout(function () {
            btn.textContent = EM.t('les.copy');
            btn.classList.remove('copied');
          }, 2000);
        }).catch(function () {
          btn.textContent = EM.t('les.copyErr');
        });
      });
      pre.appendChild(btn);
    });
  }

  /* ----------------------------------------------------------
     Initialize Mermaid
  ---------------------------------------------------------- */
  function _loadMermaid() {
    if (typeof mermaid !== 'undefined') return Promise.resolve();
    if (!_mermaidLoad) {
      _mermaidLoad = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = MERMAID_URL;
        s.integrity = MERMAID_SRI;
        s.crossOrigin = 'anonymous';
        s.referrerPolicy = 'no-referrer';
        s.onload = resolve;
        s.onerror = function () { _mermaidLoad = null; reject(new Error('Could not load Mermaid')); };
        document.head.appendChild(s);
      });
    }
    return _mermaidLoad;
  }

  function _initMermaid(body) {
    var elements = body.querySelectorAll('.mermaid');
    if (!elements.length) return;
    if (typeof mermaid === 'undefined') {
      _loadMermaid().then(function () { _initMermaid(body); }, function (err) {
        console.warn('[EM.Renderer]', err.message); // diagrams stay as readable source text
      });
      return;
    }

    var theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default';

    if (!_mermaidReady) {
      mermaid.initialize({
        startOnLoad: false,
        theme:       theme,
        fontFamily:  "'Google Sans', system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif",
        fontSize:    16,
        flowchart:   { htmlLabels: true, curve: 'basis', nodeSpacing: 50, rankSpacing: 60 },
        sequence:    { actorMargin: 60, messageMargin: 50, fontSize: 14 },
        themeVariables: theme === 'dark' ? {
          primaryColor:      '#1c2128',
          primaryTextColor:  '#e6edf3',
          primaryBorderColor:'#30363d',
          lineColor:         '#8b949e',
          secondaryColor:    '#21262d',
          tertiaryColor:     '#161b22',
          fontSize:          '16px'
        } : {
          fontSize: '16px'
        }
      });
      _mermaidReady = true;
    }

    // Mermaid sizes boxes by measuring text, so wait for the web font or labels get clipped
    var fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
    fontsReady.then(function () {
      return mermaid.run({ nodes: Array.from(elements) });
    }).then(function () {
      _wrapDiagramsWithZoom(body);
    }).catch(function (err) {
      console.warn('[EM.Renderer] Mermaid render error:', err);
      _wrapDiagramsWithZoom(body);
    });
  }

  function _wrapDiagramsWithZoom(body) {
    body.querySelectorAll('.mermaid-block').forEach(function (block) {
      if (block.querySelector('.diagram-zoom-bar')) return; // already wrapped

      var scale  = 1;
      var minScale = 0.4;
      var maxScale = 4;
      var step   = 0.2;

      var svg = block.querySelector('svg');
      if (!svg) return;

      // Make SVG responsive
      svg.style.width  = '100%';
      svg.style.height = 'auto';
      svg.style.transition = 'transform 0.15s ease';
      svg.style.transformOrigin = 'top center';
      svg.style.display = 'block';

      // Zoom bar
      var bar = document.createElement('div');
      bar.className = 'diagram-zoom-bar';
      bar.innerHTML =
        '<button class="dz-btn dz-out" title="' + EM.t('les.zoomOut') + '">&#8722;</button>' +
        '<span class="dz-label">100%</span>' +
        '<button class="dz-btn dz-in" title="' + EM.t('les.zoomIn') + '">&#43;</button>' +
        '<button class="dz-btn dz-reset" title="' + EM.t('les.zoomReset') + '">&#8635;</button>' +
        '<button class="dz-btn dz-full" title="' + EM.t('les.full') + '">&#x26F6;</button>';

      var label = bar.querySelector('.dz-label');

      function applyScale() {
        svg.style.transform = 'scale(' + scale + ')';
        svg.style.marginBottom = scale > 1 ? ((scale - 1) * svg.getBoundingClientRect().height * 0.5) + 'px' : '0';
        label.textContent = Math.round(scale * 100) + '%';
        bar.querySelector('.dz-out').disabled   = scale <= minScale;
        bar.querySelector('.dz-in').disabled    = scale >= maxScale;
      }

      bar.querySelector('.dz-in').addEventListener('click', function () {
        if (scale < maxScale) { scale = Math.min(maxScale, parseFloat((scale + step).toFixed(1))); applyScale(); }
      });
      bar.querySelector('.dz-out').addEventListener('click', function () {
        if (scale > minScale) { scale = Math.max(minScale, parseFloat((scale - step).toFixed(1))); applyScale(); }
      });
      bar.querySelector('.dz-reset').addEventListener('click', function () {
        scale = 1; applyScale();
      });
      bar.querySelector('.dz-full').addEventListener('click', function () {
        _openDiagramModal(svg.cloneNode(true), block);
      });

      block.insertBefore(bar, block.firstChild);
    });
  }

  function _openDiagramModal(svgClone, sourceBlock) {
    var existing = document.getElementById('em-diagram-modal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'em-diagram-modal';
    modal.className = 'em-diagram-modal';
    modal.innerHTML =
      '<div class="em-diagram-modal-backdrop"></div>' +
      '<div class="em-diagram-modal-box">' +
        '<div class="em-diagram-modal-toolbar">' +
          '<button class="dz-btn dz-out" title="' + EM.t('les.zoomOut') + '">&#8722;</button>' +
          '<span class="dz-label">100%</span>' +
          '<button class="dz-btn dz-in" title="' + EM.t('les.zoomIn') + '">&#43;</button>' +
          '<button class="dz-btn dz-reset" title="' + EM.t('les.zoomReset') + '">&#8635;</button>' +
          '<button class="dz-btn dz-close" title="' + EM.t('les.close') + '">&#10005;</button>' +
        '</div>' +
        '<div class="em-diagram-modal-scroll"></div>' +
      '</div>';

    var scroll = modal.querySelector('.em-diagram-modal-scroll');
    svgClone.style.transform = 'none';
    svgClone.style.width  = 'auto';
    svgClone.style.maxWidth = 'none';
    svgClone.style.height = 'auto';
    svgClone.style.display = 'block';
    svgClone.style.margin  = '0 auto';
    svgClone.style.transition = 'transform 0.15s ease';
    svgClone.style.transformOrigin = 'top center';
    scroll.appendChild(svgClone);
    document.body.appendChild(modal);

    var mScale = 1;
    var mStep  = 0.25;
    var mMin   = 0.3;
    var mMax   = 5;
    var mLabel = modal.querySelector('.dz-label');

    function applyModal() {
      svgClone.style.transform = 'scale(' + mScale + ')';
      mLabel.textContent = Math.round(mScale * 100) + '%';
    }

    modal.querySelector('.dz-in').addEventListener('click', function () {
      if (mScale < mMax) { mScale = Math.min(mMax, parseFloat((mScale + mStep).toFixed(2))); applyModal(); }
    });
    modal.querySelector('.dz-out').addEventListener('click', function () {
      if (mScale > mMin) { mScale = Math.max(mMin, parseFloat((mScale - mStep).toFixed(2))); applyModal(); }
    });
    modal.querySelector('.dz-reset').addEventListener('click', function () { mScale = 1; applyModal(); });
    modal.querySelector('.dz-close').addEventListener('click', function () { modal.remove(); });
    modal.querySelector('.em-diagram-modal-backdrop').addEventListener('click', function () { modal.remove(); });

    document.addEventListener('keydown', function escHandler(e) {
      if (e.key === 'Escape') { modal.remove(); document.removeEventListener('keydown', escHandler); }
    });
  }

  /* ----------------------------------------------------------
     Initialize Prism
  ---------------------------------------------------------- */
  function _initPrism(body) {
    if (typeof Prism === 'undefined') return;
    if (Prism.plugins && Prism.plugins.autoloader) Prism.plugins.autoloader.languages_path = PRISM_COMPONENTS;
    Prism.highlightAllUnder(body);
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
      // Lessons use either a bare array or {"questions": [...]}.
      if (questions && !Array.isArray(questions)) questions = questions.questions;
      if (!Array.isArray(questions) || !questions.length) return;
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
        '<div class="knowledge-check-title">' + _esc(EM.t('les.kc')) + '</div>' +
        '<div class="knowledge-check-subtitle">' +
          _esc(EM.t(questions.length === 1 ? 'les.kcSub1' : 'les.kcSubN', { n: questions.length })) + '</div>' +
      '</div>';
    wrap.appendChild(header);

    var answered = 0;

    questions.forEach(function (q, qi) {
      var letters = ['A', 'B', 'C', 'D', 'E'];
      var qDiv = document.createElement('div');
      qDiv.className = 'kc-question';

      var num = document.createElement('div');
      num.className = 'kc-question-num';
      num.textContent = EM.t('les.question', { n: qi + 1, total: questions.length });

      var text = document.createElement('div');
      text.className = 'kc-question-text';
      text.textContent = q.q || q.text || q.question || '';

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
              scoreEl.innerHTML = '✅ ' + _esc(EM.t('les.score', { a: score, b: questions.length }));
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
        '<div class="practical-challenge-label">' + _esc(EM.t('les.challenge')) + '</div>' +
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
    var mins   = lesson.estimatedMinutes ? EM.t('common.min', { n: lesson.estimatedMinutes }) : '';
    var tags   = (lesson.tags || []).map(function (t) {
      return '<span class="tag-chip" dir="ltr">' + _esc(t) + '</span>';
    }).join('');

    var prevHtml = prevLesson
      ? '<button class="lesson-nav-btn prev" ' +
          'onclick="EM.Router.navigate(\'/tracks/' + (appTrack ? appTrack.id : '') +
          '/lessons/' + prevLesson.id + '\')">' +
          '<span class="lesson-nav-label">' + _esc(EM.t('les.prev')) + '</span>' +
          '<span class="lesson-nav-title">' + _esc(prevLesson.title) + '</span>' +
        '</button>'
      : '<div></div>';

    var nextHtml = nextLesson
      ? '<button class="lesson-nav-btn next" ' +
          'onclick="EM.Router.navigate(\'/tracks/' + (appTrack ? appTrack.id : '') +
          '/lessons/' + nextLesson.id + '\')">' +
          '<span class="lesson-nav-label">' + _esc(EM.t('les.next')) + '</span>' +
          '<span class="lesson-nav-title">' + _esc(nextLesson.title) + '</span>' +
        '</button>'
      : '<div></div>';

    return '<div class="lesson-wrap"><div class="lesson-main">' +
      '<nav class="lesson-breadcrumb">' +
        '<button onclick="EM.Router.navigate(\'/\')">' + EM.t('nav.dashboard') + '</button>' +
        '<span class="lesson-breadcrumb-sep rtl-flip">›</span>' +
        '<button onclick="EM.Router.navigate(\'/curriculum\')">' + EM.t('nav.curriculum') + '</button>' +
        '<span class="lesson-breadcrumb-sep rtl-flip">›</span>' +
        '<button onclick="EM.Router.navigate(\'/curriculum/track/' + (appTrack ? appTrack.id : '') + '\')">' +
          _esc(trackData ? trackData.title : '') +
        '</button>' +
        '<span class="lesson-breadcrumb-sep rtl-flip">›</span>' +
        '<span>' + _esc(lesson.title) + '</span>' +
      '</nav>' +
      '<div class="lesson-header">' +
        '<div class="lesson-track-label">' +
          '<span class="lesson-track-dot" style="background:' + color + '"></span>' +
          _esc(EM.t('les.trackLesson', { n: num, l: lNum })) +
        '</div>' +
        '<h1 class="lesson-title" style="color:var(--text-primary)">' + _esc(lesson.title) + '</h1>' +
        '<div class="lesson-meta-row">' +
          EM.difficultyBadge(lesson.difficulty) +
          (mins ? '<span class="lesson-meta-item">' + EM.Icons.clock + mins + '</span>' : '') +
          '<span class="badge badge-planned">' + EM.t('les.soon') + '</span>' +
        '</div>' +
        (tags ? '<div style="display:flex;flex-wrap:wrap;gap:var(--sp-1);margin-top:var(--sp-3)">' + tags + '</div>' : '') +
      '</div>' +
      '<div style="text-align:center;padding:var(--sp-10) var(--sp-8);background:var(--bg-surface);' +
        'border:1px solid var(--border);border-radius:var(--r-xl);border-top:3px solid ' + color + '">' +
        '<div style="font-size:2.5rem;margin-bottom:var(--sp-4)">🏗</div>' +
        '<h2 style="font-size:var(--text-xl);font-weight:600;color:var(--text-primary);margin-bottom:var(--sp-3)">' + EM.t('les.inDev') + '</h2>' +
        '<p style="color:var(--text-secondary);max-width:480px;margin:0 auto">' +
          _esc(EM.t('les.inDevMsg')) +
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
      '<h2 class="error-title">' + EM.t('les.cantLoad') + '</h2>' +
      '<p class="error-msg">' + _esc(msg) + '</p>' +
      '<button class="btn btn-secondary" onclick="EM.Router.navigate(\'/curriculum\')" style="margin-top:16px">' +
        EM.t('les.backCur') +
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

  /* Post-process rendered markdown outside a lesson page (used by capstone.js). */
  function postProcess(el) {
    if (!el) return;
    _wrapTables(el);
    _transformCallouts(el);
    _buildCodeTabs(el);
    _addCopyButtons(el);
    _initMermaid(el);
    _initPrism(el);
  }

  return {
    renderLesson:    renderLesson,
    initComponents:  initComponents,
    toggleComplete:  toggleComplete,
    convertMd:       convertMd,
    postProcess:     postProcess
  };
}());
