/* ============================================================
   ENGINEERING MASTERY — Search Module
   lunr.js full-text search over lessons, tracks, and scenarios
   ============================================================ */

window.EM = window.EM || {};

EM.Search = (function () {
  'use strict';

  /* ----------------------------------------------------------
     State
  ---------------------------------------------------------- */
  var _index      = null;   // lunr.js index
  var _documents  = {};     // id → document map
  var _loadPromise = null;

  /* ----------------------------------------------------------
     Load + build lunr index
  ---------------------------------------------------------- */
  function _init() {
    if (_loadPromise) return _loadPromise;

    _loadPromise = fetch('data/search-index.json')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        // Build document map
        (data.documents || []).forEach(function (doc) {
          _documents[doc.id] = doc;
        });

        // Build lunr index
        if (typeof lunr === 'undefined') {
          throw new Error('lunr.js not loaded');
        }

        _index = lunr(function () {
          this.ref('id');
          this.field('title',     { boost: 10 });
          this.field('tags',      { boost: 6  });
          this.field('trackName', { boost: 3  });
          this.field('subtitle',  { boost: 4  });
          this.field('body',      { boost: 1  });

          this.pipeline.remove(lunr.stemmer);  // exact prefix matching feels better for tech terms

          var self = this;
          (data.documents || []).forEach(function (doc) {
            self.add({
              id:        doc.id,
              title:     doc.title     || '',
              tags:      (doc.tags || []).join(' '),
              trackName: doc.trackName || '',
              subtitle:  doc.subtitle  || '',
              body:      doc.body      || ''
            });
          });
        });

        return _index;
      });

    return _loadPromise;
  }

  /* ----------------------------------------------------------
     Query
  ---------------------------------------------------------- */
  function _query(term) {
    if (!_index || !term || !term.trim()) return [];

    var sanitised = term.trim().replace(/[+\-^~*:]/g, '\\$&');

    try {
      // Wildcard suffix search on each token for prefix matching
      var tokens = sanitised.split(/\s+/).filter(Boolean);
      var query  = tokens.map(function (t) {
        // Try exact + wildcard: title:^term* tags:term*
        return t + '*';
      }).join(' ');

      return _index.search(query)
        .map(function (result) {
          return { score: result.score, doc: _documents[result.ref] };
        })
        .filter(function (r) { return !!r.doc; });
    } catch (e) {
      // lunr throws on malformed queries — fall back to simple search
      try {
        return _index.search(sanitised + '*')
          .map(function (result) {
            return { score: result.score, doc: _documents[result.ref] };
          })
          .filter(function (r) { return !!r.doc; });
      } catch (e2) {
        return [];
      }
    }
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
     Text excerpt with query term highlighted
  ---------------------------------------------------------- */
  function _excerpt(body, query, maxLen) {
    maxLen = maxLen || 180;
    if (!body) return '';

    var term = query.trim().split(/\s+/)[0].toLowerCase();
    var lower = body.toLowerCase();
    var idx   = term ? lower.indexOf(term) : -1;

    var start = 0;
    if (idx > 60) {
      start = idx - 60;
      // Don't start mid-word
      while (start > 0 && body[start] !== ' ') start--;
    }

    var excerpt = body.slice(start, start + maxLen);
    if (start > 0)        excerpt = '…' + excerpt;
    if (start + maxLen < body.length) excerpt += '…';

    // Highlight all terms
    if (term) {
      var re = new RegExp('(' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      excerpt = _esc(excerpt).replace(re, '<mark>$1</mark>');
    } else {
      excerpt = _esc(excerpt);
    }

    return excerpt;
  }

  /* ----------------------------------------------------------
     Render: Search Page
  ---------------------------------------------------------- */
  function renderPage(initialQuery) {
    initialQuery = initialQuery || _getQueryParam() || '';

    var inputHtml =
      '<div class="search-input-wrap">' +
        EM.Icons.search +
        '<input ' +
          'type="search" ' +
          'id="search-input" ' +
          'class="search-input" ' +
          'placeholder="Search lessons, tracks, scenarios, capstone projects…" ' +
          'autocomplete="off" ' +
          'spellcheck="false" ' +
          'value="' + _esc(initialQuery) + '" ' +
          'aria-label="Search" ' +
        '/>' +
        '<div id="search-loading" class="search-loading" style="display:none">' +
          '<div class="spinner" style="width:16px;height:16px;border-width:2px"></div>' +
        '</div>' +
        '<kbd class="search-kbd" id="search-clear" style="display:none;cursor:pointer" ' +
          'onclick="document.getElementById(\'search-input\').value=\'\';' +
          'document.getElementById(\'search-clear\').style.display=\'none\';' +
          'EM.Search._runSearch(\'\')">✕</kbd>' +
      '</div>';

    var filterHtml =
      '<div class="search-filters" id="search-filters">' +
        '<button class="search-filter-btn active" data-filter="all"    onclick="EM.Search._setFilter(\'all\')">All</button>' +
        '<button class="search-filter-btn"         data-filter="lesson"   onclick="EM.Search._setFilter(\'lesson\')">Lessons</button>' +
        '<button class="search-filter-btn"         data-filter="track"    onclick="EM.Search._setFilter(\'track\')">Tracks</button>' +
        '<button class="search-filter-btn"         data-filter="scenario" onclick="EM.Search._setFilter(\'scenario\')">Lab Scenarios</button>' +
        '<button class="search-filter-btn"         data-filter="capstone" onclick="EM.Search._setFilter(\'capstone\')">Capstone</button>' +
      '</div>';

    var page =
      '<div class="page">' +
        '<div class="page-header">' +
          '<h1 class="page-title">Search</h1>' +
          '<p class="page-subtitle">Search across all lessons, tracks, Decision Lab scenarios, and capstone projects.</p>' +
        '</div>' +
        inputHtml +
        filterHtml +
        '<div id="search-results" class="search-results-wrap"></div>' +
      '</div>';

    // After DOM injection, wire up events and optionally run initial query
    document.addEventListener('em:page-rendered', function onRender() {
      document.removeEventListener('em:page-rendered', onRender);
      _attachInputHandler();
      if (initialQuery) {
        _runSearch(initialQuery);
      } else {
        _showDefault();
      }
    }, { once: true });

    return page;
  }

  /* ----------------------------------------------------------
     Wire input events
  ---------------------------------------------------------- */
  function _attachInputHandler() {
    var input = document.getElementById('search-input');
    if (!input) return;

    input.focus();

    var debounceTimer;
    input.addEventListener('input', function () {
      var val = input.value;
      var clearBtn = document.getElementById('search-clear');
      if (clearBtn) clearBtn.style.display = val ? 'inline-flex' : 'none';

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        _runSearch(val);
      }, 250);
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        input.value = '';
        var clearBtn = document.getElementById('search-clear');
        if (clearBtn) clearBtn.style.display = 'none';
        _runSearch('');
      }
    });

    // Show clear button if initial value
    if (input.value) {
      var clearBtn = document.getElementById('search-clear');
      if (clearBtn) clearBtn.style.display = 'inline-flex';
    }
  }

  /* ----------------------------------------------------------
     Current filter state
  ---------------------------------------------------------- */
  var _currentFilter = 'all';

  function _setFilter(filter) {
    _currentFilter = filter;

    var btns = document.querySelectorAll('.search-filter-btn');
    btns.forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.filter === filter);
    });

    var input = document.getElementById('search-input');
    var val   = input ? input.value : '';
    if (val.trim()) _runSearch(val);
  }

  /* ----------------------------------------------------------
     Run a search and render results
  ---------------------------------------------------------- */
  function _runSearch(term) {
    var resultsDiv = document.getElementById('search-results');
    if (!resultsDiv) return;

    if (!term || !term.trim()) {
      _showDefault();
      return;
    }

    // Show loading while index initialises
    var loadingDiv = document.getElementById('search-loading');
    if (loadingDiv) loadingDiv.style.display = 'flex';

    _init().then(function () {
      if (loadingDiv) loadingDiv.style.display = 'none';

      var results = _query(term);

      // Apply type filter
      if (_currentFilter !== 'all') {
        results = results.filter(function (r) { return r.doc.type === _currentFilter; });
      }

      resultsDiv.innerHTML = _renderResults(results, term);
    }).catch(function (err) {
      if (loadingDiv) loadingDiv.style.display = 'none';
      resultsDiv.innerHTML =
        '<div class="search-empty">' +
          '<p style="color:var(--text-muted)">Search index unavailable: ' + _esc(err.message) + '</p>' +
        '</div>';
    });
  }

  /* ----------------------------------------------------------
     Render result cards
  ---------------------------------------------------------- */
  function _renderResults(results, query) {
    if (!results.length) {
      return '<div class="search-empty">' +
        '<div class="search-empty-icon">' + EM.Icons.search + '</div>' +
        '<p class="search-empty-title">No results for &ldquo;' + _esc(query) + '&rdquo;</p>' +
        '<p class="search-empty-hint">Try different keywords or browse the <button class="btn-link" onclick="EM.Router.navigate(\'/curriculum\')">Curriculum</button>.</p>' +
      '</div>';
    }

    var countLine =
      '<div class="search-count">' +
        results.length + ' result' + (results.length === 1 ? '' : 's') +
        ' for &ldquo;<strong>' + _esc(query) + '</strong>&rdquo;' +
      '</div>';

    var cards = results.map(function (r) {
      return _renderResultCard(r.doc, query);
    }).join('');

    return countLine + '<div class="search-results-list">' + cards + '</div>';
  }

  function _renderResultCard(doc, query) {
    var typeIcon, typeLabel, typeCls;
    switch (doc.type) {
      case 'lesson':
        typeIcon  = EM.Icons.curriculum;
        typeLabel = 'Lesson';
        typeCls   = 'result-type-lesson';
        break;
      case 'track':
        typeIcon  = EM.Icons.dashboard;
        typeLabel = 'Track';
        typeCls   = 'result-type-track';
        break;
      case 'scenario':
        typeIcon  = EM.Icons.lab;
        typeLabel = 'Lab Scenario';
        typeCls   = 'result-type-scenario';
        break;
      case 'capstone':
        typeIcon  = EM.Icons.capstone;
        typeLabel = 'Capstone';
        typeCls   = 'result-type-capstone';
        break;
      default:
        typeIcon  = EM.Icons.build;
        typeLabel = doc.type;
        typeCls   = '';
    }

    var tags = (doc.tags || []).slice(0, 4).map(function (t) {
      return '<span class="tag-chip" style="font-size:11px">' + _esc(t) + '</span>';
    }).join('');

    var excerpt = _excerpt(doc.body, query, 180);

    var statusBadge = '';
    if (doc.status === 'in-development') {
      statusBadge = '<span class="badge badge-in-development" style="font-size:10px">In Development</span>';
    }

    var metaLine =
      '<div class="result-meta">' +
        '<span class="result-track-dot" style="background:' + _esc(doc.trackColor || '#888') + '"></span>' +
        '<span class="result-track-name">' + _esc(doc.trackName) + '</span>' +
        (doc.estimatedMinutes
          ? '<span class="result-sep">·</span><span>' + doc.estimatedMinutes + ' min</span>'
          : '') +
        (doc.estimatedHours
          ? '<span class="result-sep">·</span><span>' + doc.estimatedHours + 'h</span>'
          : '') +
        (doc.difficulty
          ? '<span class="result-sep">·</span>' + EM.difficultyBadge(doc.difficulty)
          : '') +
        statusBadge +
      '</div>';

    return '<button class="result-card" ' +
      'onclick="EM.Router.navigate(\'' + _esc(doc.url) + '\')">' +
      '<div class="result-card-top">' +
        '<div class="result-type-badge ' + typeCls + '">' + typeIcon + typeLabel + '</div>' +
      '</div>' +
      '<div class="result-title">' + _esc(doc.title) + '</div>' +
      (doc.subtitle ? '<div class="result-subtitle">' + _esc(doc.subtitle) + '</div>' : '') +
      metaLine +
      (excerpt ? '<div class="result-excerpt">' + excerpt + '</div>' : '') +
      (tags ? '<div class="result-tags">' + tags + '</div>' : '') +
    '</button>';
  }

  /* ----------------------------------------------------------
     Default state (empty query) — show featured content
  ---------------------------------------------------------- */
  function _showDefault() {
    var resultsDiv = document.getElementById('search-results');
    if (!resultsDiv) return;

    // Show top published content as suggestions
    _init().then(function () {
      var published = Object.values(_documents).filter(function (d) {
        return d.status === 'published' && d.type === 'lesson';
      }).slice(0, 6);

      var tracks = Object.values(_documents).filter(function (d) {
        return d.type === 'track' && (d.status === 'published' || true);
      }).slice(0, 4);

      if (!published.length && !tracks.length) {
        resultsDiv.innerHTML = '';
        return;
      }

      var html = '<div class="search-default">';

      if (published.length) {
        html += '<div class="search-default-section">' +
          '<div class="search-default-label">Published Lessons</div>' +
          '<div class="search-results-list">' +
            published.map(function (doc) {
              return _renderResultCard(doc, '');
            }).join('') +
          '</div>' +
        '</div>';
      }

      html += '</div>';
      resultsDiv.innerHTML = html;
    }).catch(function () {
      resultsDiv.innerHTML = '';
    });
  }

  /* ----------------------------------------------------------
     Read ?q= from hash URL: #/search?q=volatile
  ---------------------------------------------------------- */
  function _getQueryParam() {
    var hash = window.location.hash || '';
    var qIdx = hash.indexOf('?q=');
    if (qIdx === -1) return '';
    return decodeURIComponent(hash.slice(qIdx + 3).split('&')[0]);
  }

  /* ----------------------------------------------------------
     Public API
  ---------------------------------------------------------- */
  return {
    renderPage:  renderPage,
    _runSearch:  _runSearch,
    _setFilter:  _setFilter
  };
}());
