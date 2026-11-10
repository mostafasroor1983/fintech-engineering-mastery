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
  function _load() {
    if (_loadPromise) return _loadPromise;
    _loadPromise = fetch('data/capstone-projects.json')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        _projects = data.projects || [];
        return _projects;
      });
    return _loadPromise;
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
      (diff === 'principal' ? 'Principal' : 'Advanced') +
    '</span>';
  }

  function _statusPill(status) {
    var map = {
      'not-started': { cls: 'cs-pill-idle',        label: 'Not Started'  },
      'in-progress': { cls: 'cs-pill-in-progress',  label: 'In Progress'  },
      'completed':   { cls: 'cs-pill-completed',    label: 'Completed'    }
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
      return '<span class="cs-tech-pill">' + EM.esc(t) + '</span>';
    }).join('');

    var objectives = (project.objectives || []).slice(0, 3).map(function (o) {
      return '<li>' + EM.esc(o) + '</li>';
    }).join('');

    return '<a class="cs-card" ' +
      'style="--cs-color:' + project.color + ';--cs-muted:' + project.colorMuted + '" ' +
      'href="#/capstone/' + project.slug + '" ' +
      'onclick="EM.Router.navigate(\'/capstone/' + project.slug + '\');return false;">' +

      '<div class="cs-card-header">' +
        '<div class="cs-card-label">PROJECT ' + num + '</div>' +
        '<div class="cs-card-title">' + EM.esc(project.title) + '</div>' +
        '<div class="cs-card-badges">' +
          _diffBadge(project.difficulty) +
          _statusPill(status) +
        '</div>' +
      '</div>' +

      '<p class="cs-card-desc">' + EM.esc(project.description) + '</p>' +

      '<ul class="cs-card-objectives">' + objectives + '</ul>' +

      '<div class="cs-card-footer">' +
        '<div class="cs-tech-pills">' + techPills + '</div>' +
        '<span class="cs-hours">' + EM.esc(String(project.estimatedHours)) + 'h estimated</span>' +
      '</div>' +

    '</a>';
  }

  /* ----------------------------------------------------------
     Index Page
  ---------------------------------------------------------- */
  function renderIndex() {
    var main = document.getElementById('main-content');
    main.innerHTML =
      '<div class="page">' +
        '<div class="page-header">' +
          '<h1 class="page-title">Capstone Projects</h1>' +
          '<p class="page-subtitle">' +
            'Six principal-level enterprise projects that integrate knowledge across all 14 tracks. ' +
            'Each project simulates a real production system with requirements, architecture, full implementation, testing, and ADRs.' +
          '</p>' +
        '</div>' +
        '<div class="cs-stats-row">' +
          '<div class="cs-stat"><span class="cs-stat-val">6</span><span class="cs-stat-lbl">Projects</span></div>' +
          '<div class="cs-stat"><span class="cs-stat-val">104h</span><span class="cs-stat-lbl">Total Hours</span></div>' +
          '<div class="cs-stat"><span class="cs-stat-val">Principal</span><span class="cs-stat-lbl">Level</span></div>' +
        '</div>' +
        '<div class="loading-wrap"><div class="spinner"></div></div>' +
      '</div>';

    _load().then(function (projects) {
      var grid = projects.map(_projectCard).join('');

      var pageEl = main.querySelector('.page');
      var loadEl = pageEl.querySelector('.loading-wrap');
      if (loadEl) loadEl.remove();

      var gridEl = document.createElement('div');
      gridEl.className = 'cs-grid';
      gridEl.innerHTML = grid;
      pageEl.appendChild(gridEl);

      EM.Router.setActiveNav('/capstone');
    }).catch(function (err) {
      main.innerHTML = '<div class="page"><p class="error-text">Failed to load capstone projects: ' + EM.esc(String(err)) + '</p></div>';
    });

    return main.innerHTML;
  }

  /* ----------------------------------------------------------
     Project Page — load and render markdown
  ---------------------------------------------------------- */
  function renderProject(projectId) {
    var main = document.getElementById('main-content');
    main.innerHTML =
      '<div class="page">' +
        '<div class="loading-wrap"><div class="spinner"></div>' +
          '<span style="color:var(--text-muted);font-size:var(--text-sm)">Loading project&hellip;</span>' +
        '</div>' +
      '</div>';

    _load().then(function () {
      var project = _findProject(projectId);
      if (!project) {
        main.innerHTML = '<div class="page"><p class="error-text">Project not found: ' + EM.esc(projectId) + '</p></div>';
        return;
      }

      return fetch(project.path)
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        })
        .then(function (mdRaw) {
          _renderProjectPage(project, mdRaw);
        });
    }).catch(function (err) {
      main.innerHTML = '<div class="page"><p class="error-text">Error: ' + EM.esc(String(err)) + '</p></div>';
    });

    return main.innerHTML;
  }

  /* ----------------------------------------------------------
     Internal: build the project page from markdown
  ---------------------------------------------------------- */
  function _renderProjectPage(project, mdRaw) {
    // Strip YAML frontmatter
    var md = mdRaw.replace(/^---[\s\S]*?---\n?/, '');

    // Delegate to EM.Renderer helpers for consistent rendering
    var html = EM.Renderer.convertMd(md);

    var status    = _getProjectStatus(project.id);
    var num       = String(project.sequence).padStart(2, '0');

    var techPills = (project.techStack || []).map(function (t) {
      return '<span class="cs-tech-pill">' + EM.esc(t) + '</span>';
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
      '<div class="lesson-page">' +

        '<div class="lesson-breadcrumb">' +
          '<button onclick="EM.Router.navigate(\'/capstone\')" class="breadcrumb-link">Capstone Projects</button>' +
          '<span class="breadcrumb-sep">›</span>' +
          '<span class="breadcrumb-current">Project ' + num + '</span>' +
        '</div>' +

        '<header class="lesson-header" style="--tc:' + project.color + ';--tc-muted:' + project.colorMuted + '">' +
          '<div class="lesson-header-top">' +
            '<span class="lesson-track-label">PROJECT ' + num + '</span>' +
            _diffBadge(project.difficulty) +
            _statusPill(status) +
          '</div>' +
          '<h1 class="lesson-title">' + EM.esc(project.title) + '</h1>' +
          '<p class="lesson-subtitle">' + EM.esc(project.description) + '</p>' +
          '<div class="lesson-meta">' +
            '<span>' + EM.Icons.clock + ' ' + project.estimatedHours + ' hours</span>' +
          '</div>' +
          '<div class="cs-tech-pills" style="margin-top:0.75rem">' + techPills + '</div>' +
        '</header>' +

        '<div class="cs-tracks-row">' +
          '<span class="cs-tracks-label">Integrates:</span>' +
          trackLinks +
        '</div>' +

        '<div class="lesson-content" id="project-content">' +
          html +
        '</div>' +

        '<div class="cs-status-panel" id="cs-status-panel">' +
          '<div class="cs-status-title">Project Progress</div>' +
          statusActions +
        '</div>' +

        '<div class="lesson-nav">' +
          '<button class="lesson-nav-btn" onclick="EM.Router.navigate(\'/capstone\')">' +
            '← All Projects' +
          '</button>' +
        '</div>' +

      '</div>';

    // Post-render: syntax highlighting, Mermaid, KaTeX
    EM.Renderer.postProcess(document.getElementById('project-content'));

    EM.Router.setActiveNav('/capstone');
    document.dispatchEvent(new CustomEvent('em:page-rendered', { detail: { type: 'capstone', id: project.id } }));
  }

  function _buildStatusActions(projectId, currentStatus) {
    var btns = [
      { status: 'not-started', label: 'Not Started' },
      { status: 'in-progress', label: 'Mark In Progress' },
      { status: 'completed',   label: 'Mark Completed'   }
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
        '<div class="cs-status-title">Project Progress</div>' +
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
