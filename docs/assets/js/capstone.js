/* ============================================================
   ENGINEERING MASTERY — Capstone Projects Module
   Six principal-level enterprise engineering projects
   ============================================================ */

window.EM = window.EM || {};

EM.Capstone = (function () {
  'use strict';

  /* ----------------------------------------------------------
     State
  ---------------------------------------------------------- */
  var _projects    = null;
  var _loadPromise = null;

  /* ----------------------------------------------------------
     Progress helpers
  ---------------------------------------------------------- */
  var PROGRESS_KEY = 'em_capstone_progress';

  function _getProgress() {
    try {
      return JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }

  function _setProjectStatus(projectId, status) {
    var p = _getProgress();
    p[projectId] = { status: status, updatedAt: Date.now() };
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
  }

  function _getProjectStatus(projectId) {
    var p = _getProgress();
    return (p[projectId] && p[projectId].status) || 'not-started';
  }

  /* ----------------------------------------------------------
     Data Loading
  ---------------------------------------------------------- */
  var _loadPromises = {};
  var _fallback = {};

  EM.I18n.add({
    en: {
      'cs.title': 'Capstone Projects',
      'cs.subtitle': '{n} hands-on projects that bring several tracks together. Each one is a runnable Spring Boot service with requirements, architecture, implementation, tests and decision records.',
      'cs.projects': 'Projects', 'cs.totalHours': 'Total Hours', 'cs.level': 'Level', 'cs.hoursShort': '{n}h',
      'cs.project': 'PROJECT {n}', 'cs.projectShort': 'Project {n}', 'cs.estimated': '{n}h estimated', 'cs.hours': '{n} hours',
      'cs.notStarted': 'Not Started', 'cs.inProgress': 'In Progress', 'cs.completed': 'Completed',
      'cs.markInProgress': 'Mark In Progress', 'cs.markCompleted': 'Mark Completed',
      'cs.integrates': 'Integrates:', 'cs.progress': 'Project Progress', 'cs.all': '← All Projects',
      'cs.loading': 'Loading project…', 'cs.loadFailed': 'Failed to load capstone projects: {e}',
      'cs.notFound': 'Project not found: {id}', 'cs.error': 'Error: {e}'
    },
    ar: {
      'cs.title': 'المشاريع التطبيقية',
      'cs.subtitle': '{n} مشاريع عملية تجمع بين عدة مسارات. كل مشروع خدمة Spring Boot قابلة للتشغيل، مع المتطلبات والبنية المعمارية والتنفيذ والاختبارات وسجلات القرارات.',
      'cs.projects': 'مشاريع', 'cs.totalHours': 'إجمالي الساعات', 'cs.level': 'المستوى', 'cs.hoursShort': '{n} ساعة',
      'cs.project': 'المشروع {n}', 'cs.projectShort': 'المشروع {n}', 'cs.estimated': 'نحو {n} ساعة', 'cs.hours': '{n} ساعة',
      'cs.notStarted': 'لم يبدأ', 'cs.inProgress': 'قيد التنفيذ', 'cs.completed': 'مكتمل',
      'cs.markInProgress': 'قيد التنفيذ', 'cs.markCompleted': 'تم الإنجاز',
      'cs.integrates': 'يجمع بين:', 'cs.progress': 'تقدّم المشروع', 'cs.all': '→ كل المشاريع',
      'cs.loading': 'جارٍ تحميل المشروع…', 'cs.loadFailed': 'تعذّر تحميل المشاريع: {e}',
      'cs.notFound': 'المشروع غير موجود: {id}', 'cs.error': 'خطأ: {e}'
    }
  });

  function _cdir() { return _fallback[EM.I18n.lang()] ? ' dir="ltr"' : ''; }

  function _load() {
    var lang = EM.I18n.lang();
    if (!_loadPromises[lang]) {
      _loadPromises[lang] = EM.I18n.fetchJSON('data/capstone-projects.json')
        .then(function (res) { _fallback[lang] = res.fallback; return res.body.projects || []; })
        .catch(function (err) { delete _loadPromises[lang]; throw err; });
    }
    return _loadPromises[lang].then(function (list) { _projects = list; return list; });
  }

  function _findProject(projectId) {
    if (!_projects) return null;
    for (var i = 0; i < _projects.length; i++) {
      if (_projects[i].id === projectId ||
          _projects[i].slug === projectId) {
        return _projects[i];
      }
    }
    return null;
  }

  /* ----------------------------------------------------------
     Difficulty Badge
  ---------------------------------------------------------- */
  function _diffBadge(diff) {
    return '<span class="badge badge-' + EM.esc(diff) + '">' +
      EM.t(diff === 'principal' ? 'badge.principal' : 'badge.advanced') +
    '</span>';
  }

  function _statusPill(status) {
    var map = {
      'not-started': { cls: 'cs-pill-idle',        label: EM.t('cs.notStarted') },
      'in-progress': { cls: 'cs-pill-in-progress',  label: EM.t('cs.inProgress') },
      'completed':   { cls: 'cs-pill-completed',    label: EM.t('cs.completed')  }
    };
    var s = map[status] || map['not-started'];
    return '<span class="cs-pill ' + s.cls + '">' + s.label + '</span>';
  }

  /* ----------------------------------------------------------
     Project Card (index page)
  ---------------------------------------------------------- */
  function _projectCard(project) {
    var status = _getProjectStatus(project.id);
    var num    = String(project.sequence).padStart(2, '0');

    var techPills = (project.techStack || []).slice(0, 5).map(function (t) {
      return '<span class="cs-tech-pill" dir="ltr">' + EM.esc(t) + '</span>';
    }).join('');

    var objectives = (project.objectives || []).slice(0, 3).map(function (o) {
      return '<li>' + EM.esc(o) + '</li>';
    }).join('');

    return '<a class="cs-card" ' +
      'style="--cs-color:' + project.color + ';--cs-muted:' + project.colorMuted + '" ' +
      'href="#/capstone/' + project.slug + '" ' +
      'onclick="EM.Router.navigate(\'/capstone/' + project.slug + '\');return false;">' +

      '<div class="cs-card-header">' +
        '<div class="cs-card-label">' + EM.t('cs.project', { n: num }) + '</div>' +
        '<div class="cs-card-title"' + _cdir() + '>' + EM.esc(project.title) + '</div>' +
        '<div class="cs-card-badges">' +
          _diffBadge(project.difficulty) +
          _statusPill(status) +
        '</div>' +
      '</div>' +

      '<p class="cs-card-desc"' + _cdir() + '>' + EM.esc(project.description) + '</p>' +

      '<ul class="cs-card-objectives"' + _cdir() + '>' + objectives + '</ul>' +

      '<div class="cs-card-footer">' +
        '<div class="cs-tech-pills">' + techPills + '</div>' +
        '<span class="cs-hours">' + EM.esc(EM.t('cs.estimated', { n: project.estimatedHours })) + '</span>' +
      '</div>' +

    '</a>';
  }

  /* ----------------------------------------------------------
     Index Page
  ---------------------------------------------------------- */
  function renderIndex() {
    var main = document.getElementById('main-content');
    return _load().then(function (projects) {
      var hours = projects.reduce(function (sum, p) { return sum + (p.estimatedHours || 0); }, 0);
      var levels = projects.map(function (p) { return p.difficulty; });
      var level  = levels.indexOf('principal') !== -1 && levels.every(function (l) { return l === 'principal'; })
        ? EM.t('badge.principal') : EM.t('badge.advanced');

      return '<div class="page">' +
        '<div class="page-header">' +
          '<h1 class="page-title">' + EM.t('cs.title') + '</h1>' +
          '<p class="page-subtitle">' + EM.esc(EM.t('cs.subtitle', { n: projects.length })) + '</p>' +
        '</div>' +
        (_fallback[EM.I18n.lang()] ? EM.I18n.fallbackNote() : '') +
        '<div class="cs-stats-row">' +
          '<div class="cs-stat"><span class="cs-stat-val">' + projects.length + '</span><span class="cs-stat-lbl">' + EM.t('cs.projects') + '</span></div>' +
          '<div class="cs-stat"><span class="cs-stat-val">' + EM.esc(EM.t('cs.hoursShort', { n: hours })) + '</span><span class="cs-stat-lbl">' + EM.t('cs.totalHours') + '</span></div>' +
          '<div class="cs-stat"><span class="cs-stat-val">' + EM.esc(level) + '</span><span class="cs-stat-lbl">' + EM.t('cs.level') + '</span></div>' +
        '</div>' +
        '<div class="cs-grid">' + projects.map(_projectCard).join('') + '</div>' +
      '</div>';
    }).catch(function (err) {
      return '<div class="page"><p class="error-text">' + EM.esc(EM.t('cs.loadFailed', { e: String(err) })) + '</p></div>';
    });
  }

  /* ----------------------------------------------------------
     Project Page — load and render markdown
  ---------------------------------------------------------- */
  function renderProject(projectId) {
    var main = document.getElementById('main-content');
    main.innerHTML =
      '<div class="page">' +
        '<div class="loading-wrap"><div class="spinner"></div>' +
          '<span style="color:var(--text-muted);font-size:var(--text-sm)">' + EM.esc(EM.t('cs.loading')) + '</span>' +
        '</div>' +
      '</div>';

    _load().then(function () {
      var project = _findProject(projectId);
      if (!project) {
        main.innerHTML = '<div class="page"><p class="error-text">' + EM.esc(EM.t('cs.notFound', { id: projectId })) + '</p></div>';
        return;
      }

      return EM.I18n.fetchText(project.path)
        .then(function (res) {
          _renderProjectPage(project, res.body, res.fallback);
        });
    }).catch(function (err) {
      main.innerHTML = '<div class="page"><p class="error-text">' + EM.esc(EM.t('cs.error', { e: String(err) })) + '</p></div>';
    });

    return main.innerHTML;
  }

  /* ----------------------------------------------------------
     Internal: build the project page from markdown
  ---------------------------------------------------------- */
  function _renderProjectPage(project, mdRaw, mdFallback) {
    // Strip YAML frontmatter
    var md = mdRaw.replace(/^---[\s\S]*?---\n?/, '');

    // Delegate to EM.Renderer helpers for consistent rendering
    var html = EM.Renderer.convertMd(md);

    var status    = _getProjectStatus(project.id);
    var num       = String(project.sequence).padStart(2, '0');

    var techPills = (project.techStack || []).map(function (t) {
      return '<span class="cs-tech-pill" dir="ltr">' + EM.esc(t) + '</span>';
    }).join('');

    var trackLinks = (project.tracks || []).map(function (tid) {
      var t = null;
      for (var i = 0; i < EM.App.tracks.length; i++) {
        if (EM.App.tracks[i].id === tid) { t = EM.App.tracks[i]; break; }
      }
      if (!t) return '';
      return '<button class="cs-track-link" ' +
        'style="--tc:' + t.color + '" ' +
        'onclick="EM.Router.navigate(\'/curriculum/track/' + t.id + '\')">' +
        '<span class="track-dot" style="background:' + t.color + '"></span>' +
        EM.esc(t.shortTitle) +
      '</button>';
    }).join('');

    var statusActions = _buildStatusActions(project.id, status);

    var main = document.getElementById('main-content');
    main.innerHTML =
      '<div class="lesson-wrap cs-project-page"><div class="lesson-main">' +

        '<nav class="lesson-breadcrumb" aria-label="Breadcrumb">' +
          '<button onclick="EM.Router.navigate(\'/capstone\')">' + EM.t('cs.title') + '</button>' +
          '<span class="lesson-breadcrumb-sep rtl-flip">›</span>' +
          '<span>' + EM.t('cs.projectShort', { n: num }) + '</span>' +
        '</nav>' +

        '<header class="lesson-header" style="--tc:' + project.color + ';--tc-muted:' + project.colorMuted + '">' +
          '<div class="lesson-header-top">' +
            '<span class="lesson-track-label">' + EM.t('cs.project', { n: num }) + '</span>' +
            _diffBadge(project.difficulty) +
            _statusPill(status) +
          '</div>' +
          '<h1 class="lesson-title"' + _cdir() + '>' + EM.esc(project.title) + '</h1>' +
          '<p class="lesson-subtitle"' + _cdir() + '>' + EM.esc(project.description) + '</p>' +
          '<div class="lesson-meta-row">' +
            '<span class="lesson-meta-item">' + EM.Icons.clock + ' ' + EM.esc(EM.t('cs.hours', { n: project.estimatedHours })) + '</span>' +
          '</div>' +
          '<div class="cs-tech-pills" style="margin-top:0.75rem">' + techPills + '</div>' +
        '</header>' +

        '<div class="cs-tracks-row">' +
          '<span class="cs-tracks-label">' + EM.t('cs.integrates') + '</span>' +
          trackLinks +
        '</div>' +

        (mdFallback && EM.I18n.lang() !== 'en' ? EM.I18n.fallbackNote() : '') +
        '<div class="lesson-body" id="project-content"' + (mdFallback && EM.I18n.lang() !== 'en' ? ' dir="ltr"' : '') + '>' +
          html +
        '</div>' +

        '<div class="cs-status-panel" id="cs-status-panel">' +
          '<div class="cs-status-title">' + EM.t('cs.progress') + '</div>' +
          statusActions +
        '</div>' +

        '<div class="lesson-nav">' +
          '<button class="lesson-nav-btn" onclick="EM.Router.navigate(\'/capstone\')">' +
            EM.esc(EM.t('cs.all')) +
          '</button>' +
        '</div>' +

      '</div></div>';

    // Post-render: syntax highlighting, Mermaid
    EM.Renderer.postProcess(document.getElementById('project-content'));

    EM.Router.setActiveNav('/capstone');
    document.dispatchEvent(new CustomEvent('em:page-rendered', { detail: { type: 'capstone', id: project.id } }));
  }

  function _buildStatusActions(projectId, currentStatus) {
    var btns = [
      { status: 'not-started', label: EM.t('cs.notStarted') },
      { status: 'in-progress', label: EM.t('cs.markInProgress') },
      { status: 'completed',   label: EM.t('cs.markCompleted')  }
    ].map(function (opt) {
      var active = currentStatus === opt.status ? ' cs-status-btn-active' : '';
      return '<button class="cs-status-btn' + active + '" ' +
        'onclick="EM.Capstone.setStatus(\'' + EM.esc(projectId) + '\',\'' + opt.status + '\')">' +
        EM.esc(opt.label) +
      '</button>';
    }).join('');

    return '<div class="cs-status-btns">' + btns + '</div>';
  }

  /* ----------------------------------------------------------
     Public: set project status (called from inline onclick)
  ---------------------------------------------------------- */
  function setStatus(projectId, status) {
    _setProjectStatus(projectId, status);

    // Refresh the status panel in-place
    var panel = document.getElementById('cs-status-panel');
    if (panel) {
      panel.innerHTML =
        '<div class="cs-status-title">' + EM.t('cs.progress') + '</div>' +
        _buildStatusActions(projectId, status);
    }

    // Refresh status pill in header
    var pills = document.querySelectorAll('.cs-pill');
    for (var i = 0; i < pills.length; i++) {
      pills[i].outerHTML = _statusPill(status);
    }
  }

  /* ----------------------------------------------------------
     Public API
  ---------------------------------------------------------- */
  return {
    renderIndex:  renderIndex,
    renderProject: renderProject,
    setStatus:    setStatus
  };

}());
