/* ============================================================
   ENGINEERING MASTERY — Hash Router (ADR-002)
   ============================================================ */

window.EM = window.EM || {};

EM.Router = (function () {
  'use strict';

  var _routes = [];

  /* ----------------------------------------------------------
     Register a route handler
     pattern: '/curriculum/track/:trackId'
     handler: function(params) { return htmlString; }
  ---------------------------------------------------------- */
  function register(pattern, handler) {
    var keys  = [];
    var src   = '^' + pattern.replace(/:([^/]+)/g, function (_, key) {
      keys.push(key);
      return '([^/]+)';
    }) + '$';
    _routes.push({ pattern: pattern, regex: new RegExp(src), keys: keys, handler: handler });
  }

  /* ----------------------------------------------------------
     Navigate to a path (updates the hash)
  ---------------------------------------------------------- */
  function navigate(path) {
    window.location.hash = '#' + path;
  }

  /* ----------------------------------------------------------
     Inject HTML into main content
  ---------------------------------------------------------- */
  function _inject(html) {
    var main = document.getElementById('main-content');
    if (!main) return;
    main.innerHTML = '<div class="page-enter">' + html + '</div>';
    main.scrollTop = 0;
    main.dispatchEvent(new CustomEvent('em:page-rendered'));
  }

  /* ----------------------------------------------------------
     Update active sidebar item
  ---------------------------------------------------------- */
  function _updateActiveNav(path) {
    // Lesson routes (/tracks/:trackId/lessons/:lessonId) map to their
    // parent track for sidebar highlighting (/curriculum/track/:trackId)
    var canonicalPath = path;
    var lessonMatch = path.match(/^\/tracks\/([^/]+)\/lessons\//);
    if (lessonMatch) {
      canonicalPath = '/curriculum/track/' + lessonMatch[1];
    }

    // Top-level nav items
    var items = document.querySelectorAll('.nav-item[data-route]');
    for (var i = 0; i < items.length; i++) {
      var item  = items[i];
      var route = item.getAttribute('data-route');
      item.classList.remove('active');
      if (route === '/') {
        if (path === '/') item.classList.add('active');
      } else if (path === route || path.indexOf(route + '/') === 0 ||
                 canonicalPath === route || canonicalPath.indexOf(route + '/') === 0) {
        item.classList.add('active');
      }
    }
    // Sidebar track items
    var trackItems = document.querySelectorAll('.sidebar-track-item[data-route]');
    for (var j = 0; j < trackItems.length; j++) {
      var ti     = trackItems[j];
      var troute = ti.getAttribute('data-route');
      ti.classList.remove('active');
      if (path === troute || path.indexOf(troute + '/') === 0 ||
          canonicalPath === troute || canonicalPath.indexOf(troute + '/') === 0) {
        ti.classList.add('active');
      }
    }
  }

  /* ----------------------------------------------------------
     Handle the current hash
  ---------------------------------------------------------- */
  function handle() {
    var raw  = window.location.hash || '';
    var hash = raw.slice(1);           // remove leading #
    var path = hash.split('?')[0] || '/';

    for (var i = 0; i < _routes.length; i++) {
      var route = _routes[i];
      var match = path.match(route.regex);
      if (match) {
        var params = {};
        for (var j = 0; j < route.keys.length; j++) {
          params[route.keys[j]] = decodeURIComponent(match[j + 1]);
        }

        _updateActiveNav(path);

        var result = route.handler(params);
        if (result && typeof result.then === 'function') {
          _inject('<div class="loading-wrap"><div class="spinner"></div></div>');
          result.then(function (html) { _inject(html); })
                .catch(function (err) {
                  console.error('[EM.Router] Handler error:', err);
                  _inject(_errorPage('Failed to load page. See console for details.'));
                });
        } else {
          _inject(result || '');
        }
        return;
      }
    }

    // No match — 404
    _updateActiveNav(path);
    _inject(_notFoundPage(path));
  }

  /* ----------------------------------------------------------
     Start the router
  ---------------------------------------------------------- */
  function init() {
    window.addEventListener('hashchange', handle);
    handle(); // render initial route
  }

  /* ----------------------------------------------------------
     Current path
  ---------------------------------------------------------- */
  function currentPath() {
    return (window.location.hash.slice(1).split('?')[0]) || '/';
  }

  /* ----------------------------------------------------------
     Built-in error pages
  ---------------------------------------------------------- */
  function _notFoundPage(path) {
    return '<div class="coming-soon">' +
      '<div class="coming-soon-icon">' + EM.Icons.search + '</div>' +
      '<h1 class="coming-soon-title">Page Not Found</h1>' +
      '<p class="coming-soon-desc">No route matched <code>' + _esc(path) + '</code>.</p>' +
      '<button class="btn btn-secondary" onclick="EM.Router.navigate(\'/\')">Go to Dashboard</button>' +
    '</div>';
  }

  function _errorPage(msg) {
    return '<div class="error-wrap">' +
      '<div class="error-icon">&#9888;</div>' +
      '<h2 class="error-title">Something went wrong</h2>' +
      '<p class="error-msg">' + _esc(msg) + '</p>' +
    '</div>';
  }

  function _esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ----------------------------------------------------------
     Public API
  ---------------------------------------------------------- */
  return {
    register:     register,
    navigate:     navigate,
    handle:       handle,
    init:         init,
    currentPath:  currentPath,
    setActiveNav: _updateActiveNav   // public — called by async page modules after render
  };
}());
