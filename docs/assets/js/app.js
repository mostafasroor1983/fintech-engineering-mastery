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
  build:      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6"/><path d="M9 12h6"/><path d="M9 15h4"/></svg>'
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
    'advanced':  { cls: 'badge-advanced',  label: 'Advanced'  },
    'principal': { cls: 'badge-principal', label: 'Principal' },
    'intermediate': { cls: 'badge-high',   label: 'Intermediate' }
  };
  var d = map[difficulty] || map['advanced'];
  return '<span class="badge ' + d.cls + '">' + d.label + '</span>';
};

EM.statusBadge = function (status, priority) {
  if (status === 'in-development') {
    return '<span class="badge badge-in-development">In Development</span>';
  }
  if (priority === 'critical') {
    return '<span class="badge badge-critical">Critical Priority</span>';
  }
  if (priority === 'high') {
    return '<span class="badge badge-high">High Priority</span>';
  }
  return '<span class="badge badge-planned">Planned</span>';
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
    this._renderTopBar();
    this._renderSidebar();
    this._registerRoutes();
    EM.Router.init();
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
      var resp = await fetch('data/tracks.json');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      this.tracks = await resp.json();
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
      '<button id="menu-btn" class="topbar-btn" onclick="EM.App.toggleMobile()" aria-label="Toggle menu">' +
        EM.Icons.menu +
      '</button>' +
      '<button id="sidebar-toggle-btn" class="topbar-btn sidebar-toggle-btn" onclick="EM.App.toggleSidebar()" ' +
        'aria-label="' + (isCollapsed ? 'Expand sidebar' : 'Collapse sidebar') + '" ' +
        'title="' + (isCollapsed ? 'Expand sidebar' : 'Collapse sidebar') + '">' +
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>' +
      '</button>' +
      '<a class="topbar-logo" href="#/" onclick="EM.Router.navigate(\'/\');return false;">' +
        '<div class="logo-mark">EM</div>' +
        '<div class="logo-text">' +
          '<span class="logo-name">Engineering Mastery</span>' +
          '<span class="logo-tagline">Principal Engineer Program</span>' +
        '</div>' +
      '</a>' +
      '<div class="topbar-spacer"></div>' +
      '<div class="topbar-actions">' +
        '<button class="topbar-btn" onclick="EM.Router.navigate(\'/search\')" aria-label="Search" title="Search (press / or Ctrl+K)">' +
          EM.Icons.search +
        '</button>' +
        '<button id="theme-btn" class="topbar-btn" onclick="EM.App.toggleTheme()" aria-label="Toggle theme" title="Toggle theme">' +
          themeIc +
        '</button>' +
      '</div>';
  },

  /* ----------------------------------------------------------
     Sidebar
  ---------------------------------------------------------- */
  _renderSidebar: function () {
    var nav = [
      { route: '/',             icon: EM.Icons.dashboard,  label: 'Dashboard'       },
      { route: '/curriculum',   icon: EM.Icons.curriculum, label: 'Curriculum'      },
      { route: '/decision-lab', icon: EM.Icons.lab,        label: 'Decision Lab'    },
      { route: '/capstone',     icon: EM.Icons.capstone,   label: 'Capstone Projects' },
      { route: '/search',       icon: EM.Icons.search,     label: 'Search'          },
      { route: '/about',        icon: EM.Icons.about,      label: 'About'           }
    ];

    var navHtml = nav.map(function (item) {
      return '<button class="nav-item" data-route="' + item.route + '" ' +
        'onclick="EM.Router.navigate(\'' + item.route + '\')" ' +
        'aria-label="' + item.label + '">' +
        item.icon + item.label +
      '</button>';
    }).join('');

    // Track list
    var trackHtml = '';
    if (EM.App.tracks.length) {
      trackHtml = '<div class="sidebar-section">' +
        '<div class="sidebar-label">Tracks</div>' +
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
        '<div class="sidebar-label">Navigation</div>' +
        navHtml +
      '</div>' +
      trackHtml +
      '<button class="sidebar-collapse-btn" id="sidebar-collapse-btn" ' +
        'onclick="EM.App.toggleSidebar()" ' +
        'title="Collapse sidebar" aria-label="Collapse sidebar">' +
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>' +
      '</button>';

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

    if (isOpen) {
      sidebar.classList.remove('open');
      var overlay = document.getElementById('sidebar-overlay');
      if (overlay) overlay.remove();
    } else {
      sidebar.classList.add('open');
      var ov = document.createElement('div');
      ov.id        = 'sidebar-overlay';
      ov.className = 'sidebar-overlay';
      ov.onclick   = function () { EM.App.toggleMobile(); };
      document.getElementById('app-body').appendChild(ov);
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
      var label = isCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
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
    EM.Router.register('/capstone',                     function ()         { return EM.Capstone.renderIndex(); });
    EM.Router.register('/capstone/:projectId',          function (p)        { return EM.Capstone.renderProject(p.projectId); });
    EM.Router.register('/tracks/:trackId/lessons/:lessonId', function (p)   { return EM.Renderer.renderLesson(p.trackId, p.lessonId); });
    EM.Router.register('/search',                       function ()         { return EM.Search.renderPage(); });
    EM.Router.register('/about',                        function ()         { return EM.Pages.about(); });

    // Close mobile sidebar on any navigation
    window.addEventListener('hashchange', function () { EM.App._closeMobile(); });

    // Global keyboard shortcut: '/' or Ctrl+K → focus search
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
        '<h1 class="dashboard-title">Engineering<br><span>Mastery</span></h1>' +
        '<p class="dashboard-subtitle">' +
          'Principal Software Engineer development program for Staff and Principal roles ' +
          'in international banks and FinTech companies.' +
        '</p>' +
        '<div class="dashboard-stack">' +
          ['Java 17', 'Java 21', 'Spring Boot 4.x', 'Spring Framework 7.x',
           'Apache Kafka', 'PostgreSQL', 'Redis', 'Kubernetes', 'JMH', 'jcstress', 'Testcontainers']
          .map(function (t) { return '<span class="stack-pill">' + t + '</span>'; })
          .join('') +
        '</div>' +
      '</div>' +
      '<div class="dashboard-stats">' +
        _statCard(String(tracks.length), 'Learning Tracks') +
        _statCard(_totalLessons(tracks), 'Total Lessons') +
        _statCard(stats.overallPct + '%', 'Completed') +
      '</div>' +
    '</div>' +
    '</div>';

  // Progress bar
  var progressBar =
    '<div class="progress-overview">' +
      '<div>' +
        '<div class="progress-overview-label">Overall Progress</div>' +
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
        '<div class="priority-label"><span>Critical Priority</span><div class="priority-label-line"></div></div>' +
        '<div class="tracks-grid">' +
          critical.map(_trackCard).join('') +
        '</div>' +
      '</div>' +
      '<div class="priority-section">' +
        '<div class="priority-label"><span>All Tracks</span><div class="priority-label-line"></div></div>' +
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
  var hours  = track.estimatedHours + 'h';

  return '<a class="track-card" ' +
    'style="--tc:' + track.color + '" ' +
    'href="#/curriculum/track/' + track.id + '" ' +
    'onclick="EM.Router.navigate(\'/curriculum/track/' + track.id + '\');return false;">' +
    '<div class="track-card-top">' +
      '<div class="track-card-meta">' +
        '<div class="track-num">TRACK ' + num + '</div>' +
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
      '<span class="track-lessons">' + track.lessonCount + ' lessons · ' + hours + '</span>' +
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
      '<span class="curriculum-row-num">TRACK ' + num + '</span>' +
      '<div class="curriculum-row-info">' +
        '<div class="curriculum-row-title">' + EM.esc(t.title) + '</div>' +
        '<div class="curriculum-row-desc">' + EM.esc(t.description) + '</div>' +
      '</div>' +
      '<div class="curriculum-row-tags">' + tags + '</div>' +
      '<div class="curriculum-row-actions">' +
        '<span class="curriculum-row-lessons">' + t.lessonCount + ' lessons</span>' +
        '<div class="curriculum-progress-bar">' +
          '<div class="curriculum-progress-fill" style="width:' + pct + '%"></div>' +
        '</div>' +
        EM.statusBadge(t.status, t.priority) +
      '</div>' +
    '</a>';
  }).join('');

  return '<div class="page">' +
    '<div class="page-header">' +
      '<h1 class="page-title">Curriculum</h1>' +
      '<p class="page-subtitle">' +
        total + ' lessons across 14 learning tracks &mdash; ' + hours + ' estimated hours. ' +
        'From Advanced Architecture to Staff &amp; Principal Engineering Leadership.' +
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
      '<h1 class="page-title">Track Not Found</h1>' +
      '<p class="page-subtitle">Track ID: ' + EM.esc(trackId) + '</p>' +
    '</div></div>';
  }

  var num  = String(appTrack.sequence).padStart(2, '0');
  var tags = (appTrack.tags || []).map(function (tag) {
    return '<span class="tag-chip" style="font-size:var(--text-xs)">' + EM.esc(tag) + '</span>';
  }).join('');

  // Try to load the _track.json for this track
  var trackData = null;
  try {
    var resp = await fetch('content/tracks/' + appTrack.id + '-' + appTrack.slug + '/_track.json');
    if (resp.ok) trackData = await resp.json();
  } catch (e) { /* will fall through to coming-soon */ }

  var lessonListHtml = trackData && trackData.lessons && trackData.lessons.length
    ? _renderLessonList(trackData.lessons, appTrack)
    : _comingSoonSection(appTrack);

  return '<div class="page">' +
    '<div class="page-header">' +
      '<div style="margin-bottom:var(--sp-3)">' +
        '<button class="btn btn-ghost" onclick="EM.Router.navigate(\'/curriculum\')" ' +
          'style="font-size:var(--text-sm);padding:4px var(--sp-3)">' +
          '&larr; Curriculum' +
        '</button>' +
      '</div>' +
      '<div style="display:flex;align-items:flex-start;gap:var(--sp-5)">' +
        '<div style="flex:1">' +
          '<div style="font-size:11px;font-family:var(--font-mono);font-weight:600;' +
            'letter-spacing:0.08em;color:var(--text-muted);margin-bottom:var(--sp-2)">' +
            'TRACK ' + num +
          '</div>' +
          '<h1 class="page-title" style="color:' + appTrack.color + '">' + EM.esc(appTrack.title) + '</h1>' +
          '<p class="page-subtitle">' + EM.esc(appTrack.description) + '</p>' +
          '<div style="display:flex;flex-wrap:wrap;gap:var(--sp-2);margin-top:var(--sp-4)">' +
            EM.difficultyBadge(appTrack.difficulty) +
            EM.statusBadge(appTrack.status, appTrack.priority) +
            '<span class="badge badge-planned">' + appTrack.lessonCount + ' lessons</span>' +
            '<span class="badge badge-planned">' + appTrack.estimatedHours + 'h</span>' +
          '</div>' +
        '</div>' +
        '<div>' + EM.progressRing(EM.Progress.getTrackProgress(appTrack.id, appTrack.lessonCount), appTrack.color) + '</div>' +
      '</div>' +
    '</div>' +
    '<div style="margin-bottom:var(--sp-6)">' +
      '<div style="font-size:var(--text-xs);font-weight:600;color:var(--text-muted);text-transform:uppercase;' +
        'letter-spacing:0.06em;margin-bottom:var(--sp-3)">Topics Covered</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:var(--sp-2)">' + tags + '</div>' +
    '</div>' +
    lessonListHtml +
  '</div>';
};

function _renderLessonList(lessons, appTrack) {
  var items = lessons.map(function (lesson, idx) {
    var status = EM.Progress.getLessonStatus(lesson.id);
    var num    = String(lesson.sequence || idx + 1).padStart(2, '0');
    var mins   = lesson.estimatedMinutes ? lesson.estimatedMinutes + ' min' : '';

    var statusDot = status === 'completed'
      ? '<span style="color:var(--green);font-size:1rem" title="Completed">✓</span>'
      : status === 'in-progress'
        ? '<span style="color:var(--blue);font-size:0.75rem;border:2px solid var(--blue);' +
            'border-radius:50%;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center" title="In Progress"></span>'
        : '<span style="width:14px;height:14px;border:2px solid var(--border);border-radius:50%;display:inline-block" title="Not Started"></span>';

    return '<button class="curriculum-row" ' +
      'style="--tc:' + appTrack.color + '" ' +
      'onclick="EM.Router.navigate(\'/tracks/' + appTrack.id + '/lessons/' + lesson.id + '\')">' +
      '<span class="curriculum-row-num">LESSON ' + num + '</span>' +
      '<div class="curriculum-row-info">' +
        '<div class="curriculum-row-title">' + EM.esc(lesson.title) + '</div>' +
        '<div style="font-size:var(--text-xs);color:var(--text-muted);margin-top:2px">' +
          EM.difficultyBadge(lesson.difficulty) +
          (mins ? '<span style="margin-left:8px">' + mins + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:var(--sp-3);flex-shrink:0">' +
        statusDot +
      '</div>' +
    '</button>';
  }).join('');

  return '<div>' +
    '<div style="font-size:var(--text-xs);font-weight:600;color:var(--text-muted);text-transform:uppercase;' +
      'letter-spacing:0.06em;margin-bottom:var(--sp-4)">Lessons (' + lessons.length + ')</div>' +
    '<div class="curriculum-grid">' + items + '</div>' +
  '</div>';
}

function _comingSoonSection(track) {
  var messages = {
    'in-development': 'This track is being developed. Lessons will appear here as they are published.',
    'planned':        'This track is on the roadmap. Priority tracks (Track 03, 05, 06) are developed first.'
  };
  var msg = messages[track.status] || messages['planned'];

  return '<div style="background:var(--bg-surface);border:1px solid var(--border);' +
    'border-radius:var(--r-xl);padding:var(--sp-8);text-align:center;' +
    'border-top:3px solid ' + track.color + '">' +
    '<div style="font-size:2rem;margin-bottom:var(--sp-4)">🏗</div>' +
    '<h2 style="font-size:var(--text-xl);font-weight:600;color:var(--text-primary);margin-bottom:var(--sp-3)">' +
      'Lessons Coming Soon' +
    '</h2>' +
    '<p style="font-size:var(--text-base);color:var(--text-secondary);max-width:480px;margin:0 auto var(--sp-5)">' +
      EM.esc(msg) +
    '</p>' +
    '<button class="btn btn-secondary" onclick="EM.Router.navigate(\'/curriculum\')">' +
      '&larr; Back to Curriculum' +
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
    'capstone': ['Project A: High-Throughput Payment Platform',
                 'Project B: Concurrent Double-Entry Ledger Engine',
                 'Project C: Distributed AML & Sanctions Platform'],
    'search':   ['Full-text search across all lesson content',
                 'Filter by track, difficulty, and tags',
                 'Instant results powered by lunr.js']
  };

  var items = roadmap[iconKey] || [
    'Full content in development',
    'Available in an upcoming phase'
  ];

  var roadmapHtml = '<div class="coming-soon-roadmap">' +
    '<h4>What\'s Coming</h4>' +
    items.map(function (item) {
      return '<div class="roadmap-item">' + EM.Icons.check + EM.esc(item) + '</div>';
    }).join('') +
  '</div>';

  return '<div class="coming-soon">' +
    '<div class="coming-soon-icon">' + icon + '</div>' +
    '<h1 class="coming-soon-title">' + EM.esc(title) + '</h1>' +
    '<p class="coming-soon-desc">' +
      'This section is on the development roadmap and will be released in an upcoming phase.' +
    '</p>' +
    roadmapHtml +
    '<button class="btn btn-secondary" onclick="EM.Router.navigate(\'/\')">' +
      '&larr; Back to Dashboard' +
    '</button>' +
  '</div>';
};

/* ----------------------------------------------------------
   About
---------------------------------------------------------- */
EM.Pages.about = function () {
  var techStack = [
    { name: 'Java 17 / 21',     role: 'Primary runtime' },
    { name: 'Spring Boot 4.x',  role: 'Application framework' },
    { name: 'Spring Framework 7.x', role: 'Core framework' },
    { name: 'Maven',            role: 'Build & dependency management' },
    { name: 'PostgreSQL',       role: 'Primary database' },
    { name: 'Apache Kafka',     role: 'Messaging & streaming' },
    { name: 'Redis',            role: 'Caching & distributed locks' },
    { name: 'JUnit 5',          role: 'Unit & integration testing' },
    { name: 'Testcontainers',   role: 'Infrastructure testing' },
    { name: 'JMH',              role: 'Microbenchmarking' },
    { name: 'jcstress',         role: 'Concurrency stress testing' },
    { name: 'Docker',           role: 'Containerization' },
    { name: 'Kubernetes',       role: 'Orchestration' }
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
      '<div class="tech-item-name">' + EM.esc(t.name) + '</div>' +
      '<div class="tech-item-role">' + EM.esc(t.role) + '</div>' +
    '</div>';
  }).join('');

  var orgHtml = orgs.map(function (o) {
    return '<li>' + EM.esc(o) + '</li>';
  }).join('');

  var refHtml = refs.map(function (r) {
    return '<div class="ref-item">' + EM.esc(r) + '</div>';
  }).join('');

  return '<div class="about-page">' +

    '<div class="about-section">' +
      '<h2>Engineering Mastery</h2>' +
      '<p><strong>Engineering Mastery</strong> is a personal, advanced-level learning environment ' +
        'designed to develop the engineering knowledge, practical skills, architectural judgment, ' +
        'and technical leadership expected from <strong>Staff and Principal Software Engineers</strong> ' +
        'in major banks and FinTech companies.</p>' +
      '<p>The program emphasizes real-world engineering challenges rather than introductory programming. ' +
        'Content is written for experienced engineers with deep existing knowledge of Java, Spring Boot, ' +
        'microservices, banking applications, and distributed systems.</p>' +
      '<p><strong>Special emphasis:</strong> Concurrency, asynchronous processing, thread safety, ' +
        'race conditions, financial data integrity, distributed transactions, and production failures.</p>' +
    '</div>' +

    '<div class="about-section">' +
      '<h2>Technical Learning Stack</h2>' +
      '<div class="tech-grid">' + techHtml + '</div>' +
    '</div>' +

    '<div class="about-section">' +
      '<h2>Target Organizations</h2>' +
      '<p>The curriculum reflects the technical requirements of large-scale financial institutions. ' +
        'The program prepares engineers for Staff and Principal roles at:</p>' +
      '<ul class="org-list">' + orgHtml + '</ul>' +
    '</div>' +

    '<div class="about-section">' +
      '<h2>Curriculum Structure</h2>' +
      '<p>The program contains <strong>14 learning tracks</strong>, <strong>6 capstone projects</strong>, ' +
        'and an interactive <strong>Principal Engineer Decision Lab</strong> with 20+ architecture scenarios.</p>' +
      '<p>Every lesson follows a structured 27-section format covering: Overview, Learning Objectives, ' +
        'Prerequisites, Business Context, Deep Technical Explanation, Java 17 &amp; 21 implementations, ' +
        'Spring Boot implementation, Failure Scenarios, Performance Analysis, Security Analysis, ' +
        'Trade-offs, and Principal Engineer Perspective.</p>' +
    '</div>' +

    '<div class="about-section">' +
      '<h2>Authoritative References</h2>' +
      '<div class="ref-list">' + refHtml + '</div>' +
    '</div>' +

    '<div class="about-section">' +
      '<h2>Website Architecture</h2>' +
      '<p>This is a <strong>static website</strong> built with HTML5, CSS3, and Vanilla JavaScript. ' +
        'No React, Next.js, authentication, or backend services. ' +
        'Hosted on GitHub Pages. Progress is stored in your browser\'s LocalStorage.</p>' +
      '<p>Lesson content is Markdown-based and rendered at runtime using marked.js. ' +
        'Architecture diagrams use Mermaid.js. Code examples use Prism.js for syntax highlighting. ' +
        'Mathematical notation uses KaTeX where needed.</p>' +
    '</div>' +

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
        '<h2 class="error-title">Failed to initialize</h2>' +
        '<p class="error-msg">Could not load application data. ' +
        'Please ensure you are serving this site via HTTP (not file://).</p>' +
      '</div>';
  });
});
