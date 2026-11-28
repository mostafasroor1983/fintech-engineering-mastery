/* ============================================================
   ENGINEERING MASTERY — Application Bootstrap
   ============================================================ */

window.EM = window.EM || {};

/* ------------------------------------------------------------
   SVG Icon Library
------------------------------------------------------------ */
EM.Icons = {
  dashboard: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  curriculum:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  lab:        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2v6l3.5 7H6L9.5 8V2"/><path d="M9.5 2h5"/><path d="M5.5 15h13"/></svg>',
  capstone:   '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/><line x1="19" y1="12" x2="19" y2="12"/></svg>',
  search:     '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  about:      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  sun:        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>',
  moon:       '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  menu:       '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>',
  clock:      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  check:      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  arrow:      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>',
  build:      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6"/><path d="M9 12h6"/><path d="M9 15h4"/></svg>',
  globe:      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  calendar:   '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  book:       '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  threads:    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/><circle cx="18" cy="6" r="2"/><circle cx="18" cy="12" r="2"/><circle cx="21" cy="18" r="2"/></svg>'
};

/* ------------------------------------------------------------
   HTML Escaping Utility
------------------------------------------------------------ */
EM.esc = function (str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
};

/* ------------------------------------------------------------
   Progress Ring SVG
------------------------------------------------------------ */
EM.progressRing = function (pct, color) {
  pct = Math.min(100, Math.max(0, pct || 0));
  var r = 15.915;
  // circumference ≈ 100 when r ≈ 15.915 (2π × 15.915 ≈ 100)
  var filled  = pct;
  var empty   = 100 - pct;
  return [
    '<svg class="progress-ring" viewBox="0 0 36 36">',
      '<circle class="ring-bg"   cx="18" cy="18" r="' + r + '" />',
      '<circle class="ring-fill" cx="18" cy="18" r="' + r + '"',
        ' stroke="' + EM.esc(color) + '"',
        ' stroke-dasharray="' + filled + ' ' + empty + '"',
      '/>',
      '<text class="ring-label" x="18" y="20.5">' + pct + '%</text>',
    '</svg>'
  ].join('');
};

/* ------------------------------------------------------------
   Badge Helpers
------------------------------------------------------------ */
EM.difficultyBadge = function (difficulty) {
  var map = {
    'advanced':  { cls: 'badge-advanced',  label: EM.t('badge.advanced')  },
    'principal': { cls: 'badge-principal', label: EM.t('badge.principal') },
    'intermediate': { cls: 'badge-intermediate', label: EM.t('badge.intermediate') }
  };
  var d = map[difficulty] || map['advanced'];
  return '<span class="badge ' + d.cls + '">' + d.label + '</span>';
};

EM.statusBadge = function (status, priority) {
  if (status === 'in-development') {
    return '<span class="badge badge-in-development">' + EM.t('badge.inDev') + '</span>';
  }
  if (priority === 'critical') {
    return '<span class="badge badge-critical">' + EM.t('badge.critical') + '</span>';
  }
  if (priority === 'high') {
    return '<span class="badge badge-high">' + EM.t('badge.high') + '</span>';
  }
  return '<span class="badge badge-planned">' + EM.t('badge.planned') + '</span>';
};

/* ------------------------------------------------------------
   App State
------------------------------------------------------------ */
EM.App = {
  tracks: [],

  /* ----------------------------------------------------------
     Entry point
  ---------------------------------------------------------- */
  init: async function () {
    this._applyTheme();
    await this._loadData();
    this._renderShell();
    this._registerRoutes();
    EM.Router.init();

    // Language switch: reload translated track data, then redraw everything
    document.addEventListener('em:lang-changed', function () {
      EM.App._loadData().then(function () {
        EM.App._renderShell();
        EM.Router.handle();
      });
    });
  },

  _renderShell: function () {
    document.title = EM.t('app.name');
    var skip = document.querySelector('.skip-link');
    if (skip) skip.textContent = EM.t('app.skip');
    var sb = document.getElementById('sidebar');
    if (sb) sb.setAttribute('aria-label', EM.t('side.navigation'));
    this._renderTopBar();
    this._renderSidebar();
  },

  /* ----------------------------------------------------------
     Theme
  ---------------------------------------------------------- */
  _applyTheme: function () {
    var saved = localStorage.getItem('em_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
  },

  toggleTheme: function () {
    var current = document.documentElement.getAttribute('data-theme');
    var next    = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('em_theme', next);
    // Update icon
    var btn = document.getElementById('theme-btn');
    if (btn) btn.innerHTML = next === 'dark' ? EM.Icons.sun : EM.Icons.moon;
  },

  /* ----------------------------------------------------------
     Load Data
  ---------------------------------------------------------- */
  _loadData: async function () {
    try {
      var res = await EM.I18n.fetchJSON('data/tracks.json');
      this.tracks = res.body;
    } catch (e) {
      console.error('[EM.App] Failed to load tracks.json:', e);
      this.tracks = [];
    }
  },

  /* ----------------------------------------------------------
     Top Bar
  ---------------------------------------------------------- */
  _renderTopBar: function () {
    var theme   = document.documentElement.getAttribute('data-theme');
    var themeIc = theme === 'dark' ? EM.Icons.sun : EM.Icons.moon;

    var isCollapsed = localStorage.getItem('em_sidebar_collapsed') === '1';
    document.getElementById('top-bar').innerHTML =
      '<button id="menu-btn" class="topbar-btn" onclick="EM.App.toggleMobile()" aria-controls="sidebar" aria-expanded="false" aria-label="' + EM.t('top.menu') + '">' +
        EM.Icons.menu +
      '</button>' +
      '<button id="sidebar-toggle-btn" class="topbar-btn sidebar-toggle-btn" onclick="EM.App.toggleSidebar()" ' +
        'aria-label="' + EM.t(isCollapsed ? 'side.expand' : 'side.collapse') + '" ' +
        'title="' + EM.t(isCollapsed ? 'side.expand' : 'side.collapse') + '">' +
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>' +
      '</button>' +
      '<a class="topbar-logo" href="#/" onclick="EM.Router.navigate(\'/\');return false;">' +
        '<div class="logo-mark">EM</div>' +
        '<div class="logo-text">' +
          '<span class="logo-name">' + EM.t('app.name') + '</span>' +
          '<span class="logo-tagline">' + EM.t('app.tagline') + '</span>' +
        '</div>' +
      '</a>' +
      '<div class="topbar-spacer"></div>' +
      '<div class="topbar-actions">' +
        '<button class="topbar-btn" onclick="EM.Router.navigate(\'/search\')" aria-label="' + EM.t('top.search') + '" title="' + EM.t('top.searchTitle') + '">' +
          EM.Icons.search +
        '</button>' +
        '<button id="theme-btn" class="topbar-btn" onclick="EM.App.toggleTheme()" aria-label="' + EM.t('top.theme') + '" title="' + EM.t('top.theme') + '">' +
          themeIc +
        '</button>' +
        '<button id="lang-btn" class="lang-switch" onclick="EM.I18n.toggle()" ' +
          'lang="' + (EM.I18n.lang() === 'ar' ? 'en' : 'ar') + '" ' +
          'aria-label="' + EM.t('top.langTitle') + '" title="' + EM.t('top.langTitle') + '">' +
          EM.Icons.globe + '<span class="lang-switch-label">' + EM.t('top.lang') + '</span>' +
        '</button>' +
      '</div>';
  },

  /* ----------------------------------------------------------
     Sidebar
  ---------------------------------------------------------- */
  _renderSidebar: function () {
    var nav = [
      { route: '/',                icon: EM.Icons.dashboard,  label: EM.t('nav.dashboard')      },
      { route: '/curriculum',      icon: EM.Icons.curriculum, label: EM.t('nav.curriculum')     },
      { route: '/decision-lab',    icon: EM.Icons.lab,        label: EM.t('nav.decisionLab')    },
      { route: '/concurrency-lab', icon: EM.Icons.threads,    label: EM.t('nav.concurrencyLab') },
      { route: '/capstone',        icon: EM.Icons.capstone,   label: EM.t('nav.capstone')       },
      { route: '/study-plan',      icon: EM.Icons.calendar,   label: EM.t('nav.studyPlan')      },
      { route: '/glossary',        icon: EM.Icons.book,       label: EM.t('nav.glossary')       },
      { route: '/search',          icon: EM.Icons.search,     label: EM.t('nav.search')         },
      { route: '/about',           icon: EM.Icons.about,      label: EM.t('nav.about')          }
    ];

    var navHtml = nav.map(function (item) {
      return '<button class="nav-item" data-route="' + item.route + '" ' +
        'onclick="EM.Router.navigate(\'' + item.route + '\')" ' +
        'aria-label="' + item.label + '">' +
        item.icon + '<span class="nav-item-label">' + item.label + '</span>' +
      '</button>';
    }).join('');

    // Track list
    var trackHtml = '';
    if (EM.App.tracks.length) {
      trackHtml = '<div class="sidebar-section">' +
        '<div class="sidebar-label">' + EM.t('side.tracks') + '</div>' +
        '<div class="sidebar-tracks">' +
        EM.App.tracks.map(function (t) {
          var num = String(t.sequence).padStart(2, '0');
          return '<button class="sidebar-track-item" ' +
            'data-route="/curriculum/track/' + t.id + '" ' +
            'onclick="EM.Router.navigate(\'/curriculum/track/' + t.id + '\')" ' +
            'title="' + EM.esc(t.title) + '">' +
            '<span class="track-dot" style="background:' + t.color + '"></span>' +
            '<span class="sidebar-track-num">' + num + '</span>' +
            '<span class="sidebar-track-name">' + EM.esc(t.shortTitle) + '</span>' +
          '</button>';
        }).join('') +
        '</div></div>';
    }

    document.getElementById('sidebar').innerHTML =
      '<div class="sidebar-section">' +
        '<div class="sidebar-label">' + EM.t('side.navigation') + '</div>' +
        navHtml +
      '</div>' +
      trackHtml +
      '<button class="sidebar-collapse-btn" id="sidebar-collapse-btn" ' +
        'onclick="EM.App.toggleSidebar()" ' +
        'title="' + EM.t('side.collapse') + '" aria-label="' + EM.t('side.collapse') + '">' +
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>' +
      '</button>';

    // Re-apply the active highlight after a redraw
    if (EM.Router && EM.Router.setActiveNav) EM.Router.setActiveNav(EM.Router.currentPath());

    // Restore collapsed state
    if (localStorage.getItem('em_sidebar_collapsed') === '1') {
      document.getElementById('sidebar').classList.add('collapsed');
      document.body.classList.add('sidebar-collapsed');
    }
  },

  /* ----------------------------------------------------------
     Mobile sidebar
  ---------------------------------------------------------- */
  toggleMobile: function () {
    var sidebar  = document.getElementById('sidebar');
    var isOpen   = sidebar.classList.contains('open');

    var menuBtn  = document.getElementById('menu-btn');

    if (isOpen) {
      sidebar.classList.remove('open');
      var overlay = document.getElementById('sidebar-overlay');
      if (overlay) overlay.remove();
      if (menuBtn) {
        menuBtn.setAttribute('aria-expanded', 'false');
        // Return focus to the button only if it was inside the drawer (keyboard use)
        if (sidebar.contains(document.activeElement)) menuBtn.focus();
      }
    } else {
      sidebar.classList.add('open');
      var ov = document.createElement('div');
      ov.id        = 'sidebar-overlay';
      ov.className = 'sidebar-overlay';
      ov.onclick   = function () { EM.App.toggleMobile(); };
      document.getElementById('app-body').appendChild(ov);
      if (menuBtn) menuBtn.setAttribute('aria-expanded', 'true');
      // Move focus into the drawer so keyboard and screen-reader users land in it
      var first = sidebar.querySelector('.nav-item.active, .nav-item');
      if (first) setTimeout(function () { first.focus({ preventScroll: true }); }, 0);
    }
  },

  _closeMobile: function () {
    var sidebar = document.getElementById('sidebar');
    if (sidebar && sidebar.classList.contains('open')) {
      EM.App.toggleMobile();
    }
  },

  /* ----------------------------------------------------------
     Desktop sidebar collapse/expand
  ---------------------------------------------------------- */
  toggleSidebar: function () {
    var sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    var isCollapsed = sidebar.classList.toggle('collapsed');
    document.body.classList.toggle('sidebar-collapsed', isCollapsed);
    localStorage.setItem('em_sidebar_collapsed', isCollapsed ? '1' : '0');
    // Update topbar toggle button label to reflect new state
    var btn = document.getElementById('sidebar-toggle-btn');
    if (btn) {
      var label = EM.t(isCollapsed ? 'side.expand' : 'side.collapse');
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
    }
  },

  /* ----------------------------------------------------------
     Route Registration
  ---------------------------------------------------------- */
  _registerRoutes: function () {
    EM.Router.register('/',                             function ()         { return EM.Pages.dashboard(); });
    EM.Router.register('/curriculum',                   function ()         { return EM.Pages.curriculum(); });
    EM.Router.register('/curriculum/track/:trackId',    function (p)        { return EM.Pages.trackDetail(p.trackId); });
    EM.Router.register('/decision-lab',                 function ()         { return EM.Lab.renderIndex(); });
    EM.Router.register('/decision-lab/:scenarioId',     function (p)        { return EM.Lab.renderScenario(p.scenarioId); });
    EM.Router.register('/concurrency-lab',              function ()         { return EM.ConcurrencyLab.renderIndex(); });
    EM.Router.register('/concurrency-lab/:expId',       function (p)        { return EM.ConcurrencyLab.renderExperiment(p.expId); });
    EM.Router.register('/capstone',                     function ()         { return EM.Capstone.renderIndex(); });
    EM.Router.register('/capstone/:projectId',          function (p)        { return EM.Capstone.renderProject(p.projectId); });
    EM.Router.register('/tracks/:trackId/lessons/:lessonId', function (p)   { return EM.Renderer.renderLesson(p.trackId, p.lessonId); });
    EM.Router.register('/search',                       function ()         { return EM.Search.renderPage(); });
    EM.Router.register('/about',                        function ()         { return EM.Pages.about(); });
    EM.Router.register('/study-plan',                   function ()         { return EM.Pages.doc('content/study-plan.md'); });
    EM.Router.register('/glossary',                     function ()         { return EM.Pages.doc('content/glossary.md'); });

    // Close mobile sidebar on any navigation
    window.addEventListener('hashchange', function () { EM.App._closeMobile(); });

    // Global keyboard shortcut: '/' or Ctrl+K → focus search
    // Escape closes the mobile navigation drawer
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') EM.App._closeMobile();
    });

    document.addEventListener('keydown', function (e) {
      // Skip if focus is already in an input / textarea
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      var isSlash   = e.key === '/' && !e.ctrlKey && !e.metaKey;
      var isCtrlK   = (e.ctrlKey || e.metaKey) && e.key === 'k';

      if (isSlash || isCtrlK) {
        e.preventDefault();
        // If already on search page, focus the input directly
        var existingInput = document.getElementById('search-input');
        if (existingInput) {
          existingInput.focus();
          existingInput.select();
        } else {
          EM.Router.navigate('/search');
        }
      }
    });
  }
};

/* ------------------------------------------------------------
   Page Renderers
------------------------------------------------------------ */
EM.Pages = {};

/* ----------------------------------------------------------
   Dashboard
---------------------------------------------------------- */
EM.Pages.dashboard = function () {
  var tracks = EM.App.tracks;
  var stats  = EM.Progress.getOverallStats(tracks);

  // Hero
  var hero =
    '<div class="dashboard-hero">' +
    '<div class="dashboard-hero-inner">' +
      '<div>' +
        '<h1 class="dashboard-title">' + EM.t('dash.title1') + '<br><span>' + EM.t('dash.title2') + '</span></h1>' +
        '<p class="dashboard-subtitle">' + EM.t('dash.subtitle') + '</p>' +
        '<div class="dashboard-stack">' +
          ['Java 17', 'Java 21', 'Spring Boot 4.x', 'Spring Framework 7.x',
           'Apache Kafka', 'PostgreSQL', 'Redis', 'Kubernetes', 'JMH', 'jcstress', 'Testcontainers']
          .map(function (t) { return '<span class="stack-pill">' + t + '</span>'; })
          .join('') +
        '</div>' +
      '</div>' +
      '<div class="dashboard-stats">' +
        _statCard(String(tracks.length), EM.t('dash.tracks')) +
        _statCard(_totalLessons(tracks), EM.t('dash.lessons')) +
        _statCard(stats.overallPct + '%', EM.t('dash.completed')) +
      '</div>' +
    '</div>' +
    '</div>';

  // Progress bar
  var progressBar =
    '<div class="progress-overview">' +
      '<div>' +
        '<div class="progress-overview-label">' + EM.t('dash.overall') + '</div>' +
        '<div class="progress-overview-value">' + stats.completedLessons + ' / ' + stats.totalLessons + '</div>' +
      '</div>' +
      '<div class="progress-overview-bar">' +
        '<div class="progress-overview-fill" style="width:' + stats.overallPct + '%"></div>' +
      '</div>' +
      '<div class="progress-overview-pct">' + stats.overallPct + '%</div>' +
    '</div>';

  // Critical priority tracks
  var critical = tracks.filter(function (t) { return t.priority === 'critical'; });
  var rest      = tracks.filter(function (t) { return t.priority !== 'critical'; });

  var body =
    '<div class="dashboard-body">' +
      progressBar +
      '<div class="priority-section">' +
        '<div class="priority-label"><span>' + EM.t('dash.critical') + '</span><div class="priority-label-line"></div></div>' +
        '<div class="tracks-grid">' +
          critical.map(_trackCard).join('') +
        '</div>' +
      '</div>' +
      '<div class="priority-section">' +
        '<div class="priority-label"><span>' + EM.t('dash.allTracks') + '</span><div class="priority-label-line"></div></div>' +
        '<div class="tracks-grid">' +
          rest.map(_trackCard).join('') +
        '</div>' +
      '</div>' +
    '</div>';

  return hero + body;
};

function _statCard(value, label) {
  return '<div class="stat-card">' +
    '<div class="stat-value">' + EM.esc(value) + '</div>' +
    '<div class="stat-label">' + EM.esc(label) + '</div>' +
  '</div>';
}

function _totalLessons(tracks) {
  return tracks.reduce(function (sum, t) { return sum + (t.lessonCount || 0); }, 0).toString();
}

function _trackCard(track) {
  var pct    = EM.Progress.getTrackProgress(track.id, track.lessonCount);
  var num    = String(track.sequence).padStart(2, '0');

  return '<a class="track-card" ' +
    'style="--tc:' + track.color + '" ' +
    'href="#/curriculum/track/' + track.id + '" ' +
    'onclick="EM.Router.navigate(\'/curriculum/track/' + track.id + '\');return false;">' +
    '<div class="track-card-top">' +
      '<div class="track-card-meta">' +
        '<div class="track-num">' + EM.t('common.track', { n: num }) + '</div>' +
        '<div class="track-title">' + EM.esc(track.title) + '</div>' +
      '</div>' +
      '<div class="progress-ring-wrap">' +
        EM.progressRing(pct, track.color) +
      '</div>' +
    '</div>' +
    '<p class="track-desc">' + EM.esc(track.description) + '</p>' +
    '<div class="track-card-footer">' +
      '<div class="track-card-badges">' +
        EM.difficultyBadge(track.difficulty) +
        EM.statusBadge(track.status, track.priority) +
      '</div>' +
      '<span class="track-lessons">' + EM.t('common.lessonsHours', { n: track.lessonCount, h: track.estimatedHours }) + '</span>' +
    '</div>' +
  '</a>';
}

/* ----------------------------------------------------------
   Curriculum Overview
---------------------------------------------------------- */
EM.Pages.curriculum = function () {
  var tracks  = EM.App.tracks;
  var total   = tracks.reduce(function (s, t) { return s + t.lessonCount; }, 0);
  var hours   = tracks.reduce(function (s, t) { return s + t.estimatedHours; }, 0);

  var rows = tracks.map(function (t) {
    var num   = String(t.sequence).padStart(2, '0');
    var pct   = EM.Progress.getTrackProgress(t.id, t.lessonCount);
    var tags  = (t.tags || []).slice(0, 4).map(function (tag) {
      return '<span class="tag-chip">' + EM.esc(tag) + '</span>';
    }).join('');

    return '<a class="curriculum-row" ' +
      'style="--tc:' + t.color + '" ' +
      'href="#/curriculum/track/' + t.id + '" ' +
      'onclick="EM.Router.navigate(\'/curriculum/track/' + t.id + '\');return false;">' +
      '<span class="curriculum-row-num">' + EM.t('common.track', { n: num }) + '</span>' +
      '<div class="curriculum-row-info">' +
        '<div class="curriculum-row-title">' + EM.esc(t.title) + '</div>' +
        '<div class="curriculum-row-desc">' + EM.esc(t.description) + '</div>' +
      '</div>' +
      '<div class="curriculum-row-tags">' + tags + '</div>' +
      '<div class="curriculum-row-actions">' +
        '<span class="curriculum-row-lessons">' + EM.t('common.lessons', { n: t.lessonCount }) + '</span>' +
        '<div class="curriculum-progress-bar">' +
          '<div class="curriculum-progress-fill" style="width:' + pct + '%"></div>' +
        '</div>' +
        EM.statusBadge(t.status, t.priority) +
      '</div>' +
    '</a>';
  }).join('');

  return '<div class="page">' +
    '<div class="page-header">' +
      '<h1 class="page-title">' + EM.t('cur.title') + '</h1>' +
      '<p class="page-subtitle">' +
        EM.esc(EM.t('cur.subtitle', { lessons: total, tracks: tracks.length, hours: Math.round(hours) })) +
      '</p>' +
    '</div>' +
    '<div class="curriculum-grid">' + rows + '</div>' +
  '</div>';
};

/* ----------------------------------------------------------
   Track Detail — loads _track.json and renders lesson list
---------------------------------------------------------- */
EM.Pages.trackDetail = async function (trackId) {
  var appTrack = null;
  for (var i = 0; i < EM.App.tracks.length; i++) {
    if (EM.App.tracks[i].id === trackId) { appTrack = EM.App.tracks[i]; break; }
  }

  if (!appTrack) {
    return '<div class="page"><div class="page-header">' +
      '<h1 class="page-title">' + EM.t('cur.notFound') + '</h1>' +
      '<p class="page-subtitle">' + EM.esc(EM.t('cur.trackId', { id: trackId })) + '</p>' +
    '</div></div>';
  }

  var num  = String(appTrack.sequence).padStart(2, '0');
  var tags = (appTrack.tags || []).map(function (tag) {
    return '<span class="tag-chip" style="font-size:var(--text-xs)">' + EM.esc(tag) + '</span>';
  }).join('');

  // Try to load the _track.json for this track
  var trackData = null;
  try {
    var res = await EM.I18n.fetchJSON('content/tracks/' + appTrack.id + '-' + appTrack.slug + '/_track.json');
    trackData = res.body;
  } catch (e) { /* will fall through to coming-soon */ }

  var lessonListHtml = trackData && trackData.lessons && trackData.lessons.length
    ? _renderLessonList(trackData.lessons, appTrack)
    : _comingSoonSection(appTrack);

  return '<div class="page">' +
    '<div class="page-header">' +
      '<div style="margin-bottom:var(--sp-3)">' +
        '<button class="btn btn-ghost" onclick="EM.Router.navigate(\'/curriculum\')" ' +
          'style="font-size:var(--text-sm);padding:4px var(--sp-3)">' +
          EM.esc(EM.t('cur.back')) +
        '</button>' +
      '</div>' +
      '<div style="display:flex;align-items:flex-start;gap:var(--sp-5)">' +
        '<div style="flex:1">' +
          '<div style="font-size:0.75rem;font-family:var(--font-mono);font-weight:600;' +
            'letter-spacing:0.08em;color:var(--text-muted);margin-bottom:var(--sp-2)">' +
            EM.t('common.track', { n: num }) +
          '</div>' +
          '<h1 class="page-title" style="color:' + appTrack.color + '">' + EM.esc(appTrack.title) + '</h1>' +
          '<p class="page-subtitle">' + EM.esc(appTrack.description) + '</p>' +
          '<div style="display:flex;flex-wrap:wrap;gap:var(--sp-2);margin-top:var(--sp-4)">' +
            EM.difficultyBadge(appTrack.difficulty) +
            EM.statusBadge(appTrack.status, appTrack.priority) +
            '<span class="badge badge-planned">' + EM.t('common.lessons', { n: appTrack.lessonCount }) + '</span>' +
            '<span class="badge badge-planned">' + EM.t('common.hours', { n: appTrack.estimatedHours }) + '</span>' +
          '</div>' +
        '</div>' +
        '<div>' + EM.progressRing(EM.Progress.getTrackProgress(appTrack.id, appTrack.lessonCount), appTrack.color) + '</div>' +
      '</div>' +
    '</div>' +
    '<div style="margin-bottom:var(--sp-6)">' +
      '<div style="font-size:var(--text-xs);font-weight:600;color:var(--text-muted);text-transform:uppercase;' +
        'letter-spacing:0.06em;margin-bottom:var(--sp-3)">' + EM.t('cur.topics') + '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:var(--sp-2)">' + tags + '</div>' +
    '</div>' +
    lessonListHtml +
  '</div>';
};

function _renderLessonList(lessons, appTrack) {
  // Main path (core/supporting) first; lessons with tier "optional" are grouped below.
  var mainLessons     = lessons.filter(function (l) { return l.tier !== 'optional'; });
  var optionalLessons = lessons.filter(function (l) { return l.tier === 'optional'; });
  var heading = function (text) {
    return '<div style="font-size:var(--text-xs);font-weight:600;color:var(--text-muted);text-transform:uppercase;' +
      'letter-spacing:0.06em;margin:var(--sp-6) 0 var(--sp-4)">' + text + '</div>';
  };
  var rows = function (list) { return list.map(_lessonRow).join(''); };
  function _lessonRow(lesson, idx) {
    var status = EM.Progress.getLessonStatus(lesson.id);
    var num    = String(lesson.sequence || idx + 1).padStart(2, '0');
    var mins   = lesson.estimatedMinutes ? EM.t('common.min', { n: lesson.estimatedMinutes }) : '';

    var statusDot = status === 'completed'
      ? '<span style="color:var(--green);font-size:1rem" title="' + EM.t('cur.statusDone') + '">✓</span>'
      : status === 'in-progress'
        ? '<span style="color:var(--blue);font-size:0.75rem;border:2px solid var(--blue);' +
            'border-radius:50%;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center" title="' + EM.t('cur.statusProgress') + '"></span>'
        : '<span style="width:14px;height:14px;border:2px solid var(--border);border-radius:50%;display:inline-block" title="' + EM.t('cur.statusNone') + '"></span>';

    return '<button class="curriculum-row" ' +
      'style="--tc:' + appTrack.color + '" ' +
      'onclick="EM.Router.navigate(\'/tracks/' + appTrack.id + '/lessons/' + lesson.id + '\')">' +
      '<span class="curriculum-row-num">' + EM.t('common.lesson', { n: num }) + '</span>' +
      '<div class="curriculum-row-info">' +
        '<div class="curriculum-row-title">' + EM.esc(lesson.title) + '</div>' +
        '<div style="font-size:var(--text-xs);color:var(--text-muted);margin-top:2px">' +
          EM.difficultyBadge(lesson.difficulty) +
          (mins ? '<span style="margin-inline-start:8px">' + mins + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:var(--sp-3);flex-shrink:0">' +
        statusDot +
      '</div>' +
    '</button>';
  }

  return '<div>' +
    '<div style="font-size:var(--text-xs);font-weight:600;color:var(--text-muted);text-transform:uppercase;' +
      'letter-spacing:0.06em;margin-bottom:var(--sp-4)">' + EM.t('cur.lessons', { n: mainLessons.length }) + '</div>' +
    '<div class="curriculum-grid">' + rows(mainLessons) + '</div>' +
    (optionalLessons.length
      ? heading(EM.t('cur.optional', { n: optionalLessons.length })) +
        '<div class="curriculum-grid">' + rows(optionalLessons) + '</div>'
      : '') +
  '</div>';
}

function _comingSoonSection(track) {
  var messages = {
    'in-development': EM.t('cur.soonDev'),
    'planned':        EM.t('cur.soonPlanned')
  };
  var msg = messages[track.status] || messages['planned'];

  return '<div style="background:var(--bg-surface);border:1px solid var(--border);' +
    'border-radius:var(--r-xl);padding:var(--sp-8);text-align:center;' +
    'border-top:3px solid ' + track.color + '">' +
    '<div style="font-size:2rem;margin-bottom:var(--sp-4)">🏗</div>' +
    '<h2 style="font-size:var(--text-xl);font-weight:600;color:var(--text-primary);margin-bottom:var(--sp-3)">' +
      EM.t('cur.soonTitle') +
    '</h2>' +
    '<p style="font-size:var(--text-base);color:var(--text-secondary);max-width:480px;margin:0 auto var(--sp-5)">' +
      EM.esc(msg) +
    '</p>' +
    '<button class="btn btn-secondary" onclick="EM.Router.navigate(\'/curriculum\')">' +
      EM.esc(EM.t('cur.backToCur')) +
    '</button>' +
  '</div>';
}

/* ----------------------------------------------------------
   Coming Soon (generic)
---------------------------------------------------------- */
EM.Pages.comingSoon = function (title, iconKey) {
  iconKey = iconKey || 'build';
  var icon = EM.Icons[iconKey] || EM.Icons.build;

  var roadmap = {
    'lab':      ['20 scenarios live — covering concurrency, Kafka, GC, isolation levels, Sagas, AML, and more',
                 'Multi-stage decision engine with Principal Engineer rubric scoring',
                 'Scenarios span all 14 tracks: distributed systems, database, messaging, reliability, security'],
    'capstone': ['Project A: Payment Service with Idempotency, Outbox and Kafka',
                 'Project B: Multi-Currency Wallet on a Double-Entry Ledger',
                 'Project C: Card Authorisation and Clearing with Resilience'],
    'search':   ['Full-text search across all lesson content',
                 'Filter by track, difficulty, and tags',
                 'Instant results powered by lunr.js']
  };

  var items = roadmap[iconKey] || [
    'Full content in development',
    'Available in an upcoming phase'
  ];

  var roadmapHtml = '<div class="coming-soon-roadmap">' +
    '<h4>' + EM.esc(EM.t('soon.whatsComing')) + '</h4>' +
    items.map(function (item) {
      return '<div class="roadmap-item">' + EM.Icons.check + EM.esc(item) + '</div>';
    }).join('') +
  '</div>';

  return '<div class="coming-soon">' +
    '<div class="coming-soon-icon">' + icon + '</div>' +
    '<h1 class="coming-soon-title">' + EM.esc(title) + '</h1>' +
    '<p class="coming-soon-desc">' +
      EM.t('soon.desc') +
    '</p>' +
    roadmapHtml +
    '<button class="btn btn-secondary" onclick="EM.Router.navigate(\'/\')">' +
      EM.esc(EM.t('soon.back')) +
    '</button>' +
  '</div>';
};

/* ----------------------------------------------------------
   About
---------------------------------------------------------- */
/* ------------------------------------------------------------
   Markdown document pages (study plan, glossary).
   These files are also read on GitHub, so their links are repo file paths;
   here they are turned into site routes.
------------------------------------------------------------ */
EM.Pages._docHref = function (href) {
  var m;
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  if ((m = /(?:^|\/)tracks\/(track-\d+)-[^/]+\/lesson-(\d+)-[^/]+\/index(?:\.ar)?\.md$/.exec(href)))
    return '#/tracks/' + m[1] + '/lessons/' + m[1] + '-lesson-' + m[2];
  if ((m = /(?:^|\/)(interview|new-job)\/(\d+)-[^/]+\/index(?:\.ar)?\.md$/.exec(href))) {
    var t = m[1] === 'interview' ? 'track-15' : 'track-16';
    return '#/tracks/' + t + '/lessons/' + t + '-lesson-' + m[2];
  }
  if ((m = /(?:^|\/)capstone\/(project-[a-z])-[^/]+\/index(?:\.ar)?\.md$/.exec(href)))
    return '#/capstone/' + m[1];
  return null;  // repo-only file (review notes, examples): shown as plain text
};

EM.Pages.doc = async function (path) {
  var res;
  try {
    res = await EM.I18n.fetchText(path);
  } catch (e) {
    return '<div class="page"><p class="error-text">' + EM.esc(EM.t('err.failedPage')) + '</p></div>';
  }
  var md = res.body.replace(/^---[\s\S]*?---\n?/, '').replace(/<!--[\s\S]*?-->\n?/g, '');
  var box = document.createElement('div');
  box.innerHTML = EM.Renderer.convertMd(md);
  Array.prototype.forEach.call(box.querySelectorAll('a[href]'), function (a) {
    var target = EM.Pages._docHref(a.getAttribute('href'));
    if (target) { a.setAttribute('href', target); return; }
    a.replaceWith(document.createTextNode(a.textContent));
  });
  return '<div class="page">' +
    (res.fallback ? EM.I18n.fallbackNote() : '') +
    '<div class="lesson-body doc-page"' + (res.fallback ? ' dir="ltr"' : '') + '>' + box.innerHTML + '</div>' +
  '</div>';
};

EM.Pages.about = function () {
  var ar = EM.I18n.lang() === 'ar';

  var techStack = [
    { name: 'Java 17 / 21',         role: ar ? 'بيئة التشغيل الأساسية'            : 'Primary runtime' },
    { name: 'Spring Boot 4.x',      role: ar ? 'إطار بناء التطبيقات'              : 'Application framework' },
    { name: 'Spring Framework 7.x', role: ar ? 'الإطار الأساسي'                    : 'Core framework' },
    { name: 'Maven',                role: ar ? 'البناء وإدارة المكتبات'           : 'Build & dependency management' },
    { name: 'PostgreSQL',           role: ar ? 'قاعدة البيانات الأساسية'          : 'Primary database' },
    { name: 'Apache Kafka',         role: ar ? 'الرسائل وتدفق البيانات'           : 'Messaging & streaming' },
    { name: 'Redis',                role: ar ? 'التخزين المؤقت والأقفال الموزعة'  : 'Caching & distributed locks' },
    { name: 'JUnit 5',              role: ar ? 'اختبارات الوحدات والتكامل'        : 'Unit & integration testing' },
    { name: 'Testcontainers',       role: ar ? 'اختبار البنية التحتية الحقيقية'   : 'Infrastructure testing' },
    { name: 'JMH',                  role: ar ? 'قياس الأداء الدقيق'               : 'Microbenchmarking' },
    { name: 'jcstress',             role: ar ? 'اختبار ضغط التزامن'               : 'Concurrency stress testing' },
    { name: 'Docker',               role: ar ? 'الحاويات'                          : 'Containerization' },
    { name: 'Kubernetes',           role: ar ? 'تشغيل وإدارة الحاويات'            : 'Orchestration' }
  ];

  var orgs = [
    'JPMorgan Chase', 'Goldman Sachs', 'HSBC', 'Standard Chartered',
    'Emirates NBD', 'Revolut', 'Stripe', 'Adyen', 'Wise', 'Visa', 'Mastercard'
  ];

  var refs = [
    'Java Concurrency in Practice — Brian Goetz et al.',
    'Designing Data-Intensive Applications — Martin Kleppmann',
    'Release It! — Michael Nygard',
    'Database Internals — Alex Petrov',
    'Google SRE Book — Google',
    'Oracle Java Documentation & OpenJDK JEPs',
    'Spring Framework Official Documentation',
    'Apache Kafka Official Documentation',
    'PostgreSQL Official Documentation',
    'AWS Well-Architected Framework',
    'SWIFT Documentation & ISO 20022 Standard',
    'PCI Security Standards Council',
    'OWASP Top 10'
  ];

  var techHtml = techStack.map(function (t) {
    return '<div class="tech-item">' +
      '<div class="tech-item-name" dir="ltr">' + EM.esc(t.name) + '</div>' +
      '<div class="tech-item-role">' + EM.esc(t.role) + '</div>' +
    '</div>';
  }).join('');

  var orgHtml = orgs.map(function (o) { return '<li dir="ltr">' + EM.esc(o) + '</li>'; }).join('');
  var refHtml = refs.map(function (r) { return '<div class="ref-item" dir="ltr">' + EM.esc(r) + '</div>'; }).join('');

  var trackCount = EM.App.tracks.length;

  var T = ar ? {
    h1: 'إتقان الهندسة',
    p1: '<strong>إتقان الهندسة</strong> بيئة تعلّم متقدمة لبناء المعرفة الهندسية والمهارات العملية والحس المعماري والقيادة التقنية المتوقعة من <strong>مهندسي البرمجيات على مستوى Staff وPrincipal</strong> في البنوك الكبرى وشركات التقنية المالية.',
    p2: 'يركّز البرنامج على تحديات هندسية حقيقية وليس على أساسيات البرمجة. المحتوى موجّه لمهندسين لديهم خبرة جيدة في Java وSpring Boot والخدمات المصغّرة (Microservices) والأنظمة البنكية والأنظمة الموزعة.',
    p3: '<strong>تركيز خاص على:</strong> التزامن، والمعالجة غير المتزامنة، وأمان الخيوط (Thread Safety)، وحالات التسابق (Race Conditions)، وسلامة البيانات المالية، والمعاملات الموزعة، وأعطال بيئة الإنتاج.',
    h2: 'التقنيات المستخدمة',
    h3: 'الجهات المستهدفة',
    p4: 'يعكس المنهج المتطلبات التقنية للمؤسسات المالية الكبيرة، ويُعِدّ المهندسين لوظائف Staff وPrincipal في جهات مثل:',
    h4: 'هيكل المنهج',
    p5: 'يضم البرنامج <strong>' + trackCount + ' مسارًا تعليميًا</strong> و<strong>5 مشاريع تطبيقية</strong> و<strong>مختبر قرارات</strong> تفاعليًا فيه سيناريوهات معمارية واقعية، إضافة إلى <strong>مختبر التزامن والأعطال</strong>.',
    p6: 'يتبع كل درس بنية ثابتة تشمل: نظرة عامة، وأهداف التعلّم، والمتطلبات السابقة، وسياق العمل، وشرحًا تقنيًا معمّقًا، وأمثلة بـ Java 17 و21، وتطبيقًا بـ Spring Boot، وسيناريوهات الأعطال، وتحليل الأداء والأمان، والمفاضلات، ورأي المهندس الرئيسي.',
    h5: 'المراجع المعتمدة',
    h6: 'بنية الموقع',
    p7: 'هذا <strong>موقع ثابت</strong> مبني بـ HTML5 وCSS3 وJavaScript بدون أطر عمل، وبدون تسجيل دخول أو خوادم خلفية. يُستضاف على GitHub Pages، ويُحفظ تقدّمك في متصفحك (LocalStorage).',
    p8: 'محتوى الدروس مكتوب بصيغة Markdown ويُعرض باستخدام marked.js. المخططات بـ Mermaid.js (تُحمّل عند الحاجة فقط)، وتلوين الشيفرة بـ Prism.js.',
    h7: 'اللغة',
    p9: 'الموقع متاح بالعربية والإنجليزية. استخدم زر اللغة في أعلى الصفحة للتبديل. المصطلحات التقنية الشائعة (مثل Kafka وidempotency وSELECT FOR UPDATE) تبقى بالإنجليزية لأنها الصيغة المستخدمة في العمل والمقابلات. الصفحات التي لم تُترجم بعد تظهر بالإنجليزية مع تنبيه.'
  } : {
    h1: 'Engineering Mastery',
    p1: '<strong>Engineering Mastery</strong> is a personal, advanced-level learning environment designed to develop the engineering knowledge, practical skills, architectural judgment, and technical leadership expected from <strong>Staff and Principal Software Engineers</strong> in major banks and FinTech companies.',
    p2: 'The program emphasizes real-world engineering challenges rather than introductory programming. Content is written for experienced engineers with deep existing knowledge of Java, Spring Boot, microservices, banking applications, and distributed systems.',
    p3: '<strong>Special emphasis:</strong> Concurrency, asynchronous processing, thread safety, race conditions, financial data integrity, distributed transactions, and production failures.',
    h2: 'Technical Learning Stack',
    h3: 'Target Organizations',
    p4: 'The curriculum reflects the technical requirements of large-scale financial institutions. The program prepares engineers for Staff and Principal roles at:',
    h4: 'Curriculum Structure',
    p5: 'The program contains <strong>' + trackCount + ' learning tracks</strong>, <strong>5 capstone projects</strong>, an interactive <strong>Principal Engineer Decision Lab</strong> of real-world architecture scenarios, and the <strong>Concurrency &amp; Failure Lab</strong>.',
    p6: 'Every lesson follows a consistent structure covering: Overview, Learning Objectives, Prerequisites, Business Context, Deep Technical Explanation, Java 17 &amp; 21 implementations, Spring Boot implementation, Failure Scenarios, Performance Analysis, Security Analysis, Trade-offs, and Principal Engineer Perspective.',
    h5: 'Authoritative References',
    h6: 'Website Architecture',
    p7: 'This is a <strong>static website</strong> built with HTML5, CSS3, and Vanilla JavaScript. No React, Next.js, authentication, or backend services. Hosted on GitHub Pages. Progress is stored in your browser\'s LocalStorage.',
    p8: 'Lesson content is Markdown-based and rendered at runtime using marked.js. Architecture diagrams use Mermaid.js. Code examples use Prism.js for syntax highlighting. Mermaid is loaded only on pages that have a diagram.',
    h7: 'Language',
    p9: 'The site is available in English and Arabic. Use the language button in the top bar to switch. Pages that are not translated yet are shown in English with a short notice.'
  };

  return '<div class="about-page">' +
    '<div class="about-section"><h2>' + T.h1 + '</h2><p>' + T.p1 + '</p><p>' + T.p2 + '</p><p>' + T.p3 + '</p></div>' +
    '<div class="about-section"><h2>' + T.h2 + '</h2><div class="tech-grid">' + techHtml + '</div></div>' +
    '<div class="about-section"><h2>' + T.h3 + '</h2><p>' + T.p4 + '</p><ul class="org-list">' + orgHtml + '</ul></div>' +
    '<div class="about-section"><h2>' + T.h4 + '</h2><p>' + T.p5 + '</p><p>' + T.p6 + '</p></div>' +
    '<div class="about-section"><h2>' + T.h5 + '</h2><div class="ref-list">' + refHtml + '</div></div>' +
    '<div class="about-section"><h2>' + T.h6 + '</h2><p>' + T.p7 + '</p><p>' + T.p8 + '</p></div>' +
    '<div class="about-section"><h2>' + T.h7 + '</h2><p>' + T.p9 + '</p></div>' +
  '</div>';
};

/* ------------------------------------------------------------
   Bootstrap
------------------------------------------------------------ */
document.addEventListener('DOMContentLoaded', function () {
  EM.App.init().catch(function (err) {
    console.error('[EM.App] Initialization failed:', err);
    document.getElementById('main-content').innerHTML =
      '<div class="error-wrap">' +
        '<div class="error-icon">&#9888;</div>' +
        '<h2 class="error-title">' + EM.t('err.init') + '</h2>' +
        '<p class="error-msg">' + EM.t('err.initMsg') + '</p>' +
      '</div>';
  });
});
