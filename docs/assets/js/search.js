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
  var _index      = null;   // lunr.js index (current language)
  var _documents  = {};     // id → document map (current language)
  var _loadPromise = null;
  var _loadedLang  = null;

  EM.I18n.add({
    en: {
      'search.title': 'Search',
      'search.subtitle': 'Search across all lessons, tracks, Decision Lab scenarios, Concurrency Lab experiments and capstone projects.',
      'search.placeholder': 'Search lessons, tracks, scenarios, capstone projects…',
      'search.all': 'All', 'search.lessons': 'Lessons', 'search.tracks': 'Tracks', 'search.scenarios': 'Lab Scenarios',
      'search.experiments': 'Experiments', 'search.capstone': 'Capstone',
      'search.unavailable': 'Search index unavailable: {e}',
      'search.none': 'No results for “{q}”',
      'search.hint': 'Try different keywords or browse the {link}.',
      'search.count1': '1 result for “{q}”', 'search.count2': '2 results for “{q}”', 'search.countFew': '{n} results for “{q}”', 'search.countN': '{n} results for “{q}”',
      'search.tLesson': 'Lesson', 'search.tTrack': 'Track', 'search.tScenario': 'Lab Scenario',
      'search.tCapstone': 'Capstone', 'search.tExperiment': 'Experiment'
    },
    ar: {
      'search.title': 'بحث',
      'search.subtitle': 'ابحث في كل الدروس والمسارات وسيناريوهات مختبر القرارات وتجارب مختبر التزامن والمشاريع التطبيقية. يمكنك البحث بالعربية أو بالمصطلحات الإنجليزية.',
      'search.placeholder': 'ابحث في الدروس والمسارات والسيناريوهات والمشاريع…',
      'search.all': 'الكل', 'search.lessons': 'الدروس', 'search.tracks': 'المسارات', 'search.scenarios': 'سيناريوهات المختبر',
      'search.experiments': 'التجارب', 'search.capstone': 'المشاريع',
      'search.unavailable': 'فهرس البحث غير متاح: {e}',
      'search.none': 'لا توجد نتائج لـ “{q}”',
      'search.hint': 'جرّب كلمات أخرى أو تصفّح {link}.',
      'search.count1': 'نتيجة واحدة لـ “{q}”', 'search.count2': 'نتيجتان لـ “{q}”', 'search.countFew': '{n} نتائج لـ “{q}”', 'search.countN': '{n} نتيجة لـ “{q}”',
      'search.tLesson': 'درس', 'search.tTrack': 'مسار', 'search.tScenario': 'سيناريو',
      'search.tCapstone': 'مشروع', 'search.tExperiment': 'تجربة'
    }
  });

  /* lunr's default trimmer strips every non-ASCII character, which would erase
     Arabic words. This trimmer keeps letters and digits from any script. */
  // Arabic counted nouns: 1, 2, 3–10 and 11+ take different forms
  function _countKey(n) {
    if (n === 1) return 'search.count1';
    if (n === 2) return 'search.count2';
    if (n % 100 >= 3 && n % 100 <= 10) return 'search.countFew';
    return 'search.countN';
  }

  function _unicodeTrimmer(token) {
    return token.update(function (str) {
      return str.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
    });
  }

  /* ----------------------------------------------------------
     Load + build lunr index
  ---------------------------------------------------------- */
  function _init() {
    var lang = EM.I18n.lang();
    if (_loadPromise && _loadedLang === lang) return _loadPromise;
    _loadedLang = lang;
    _index = null;
    _documents = {};

    _loadPromise = EM.I18n.fetchJSON('data/search-index.json')
      .then(function (res) { return res.body; })
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
          if (lang !== 'en') {
            // Mixed Arabic/English text: no English stop words, Unicode-aware trimming
            lunr.Pipeline.registerFunction(_unicodeTrimmer, 'emUnicodeTrimmer');
            this.pipeline.reset();
            this.searchPipeline.reset();
            this.pipeline.add(_unicodeTrimmer);
            this.searchPipeline.add(_unicodeTrimmer);
          }

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
          'placeholder="' + _esc(EM.t('search.placeholder')) + '" ' +
          'autocomplete="off" ' +
          'spellcheck="false" ' +
          'value="' + _esc(initialQuery) + '" ' +
          'aria-label="' + _esc(EM.t('search.title')) + '" ' +
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
        [['all', 'search.all'], ['lesson', 'search.lessons'], ['track', 'search.tracks'],
         ['scenario', 'search.scenarios'], ['experiment', 'search.experiments'], ['capstone', 'search.capstone']]
          .map(function (f) {
            return '<button class="search-filter-btn' + (f[0] === _currentFilter ? ' active' : '') + '" data-filter="' + f[0] + '" ' +
              'onclick="EM.Search._setFilter(\'' + f[0] + '\')">' + EM.t(f[1]) + '</button>';
          }).join('') +
      '</div>';

    var page =
      '<div class="page">' +
        '<div class="page-header">' +
          '<h1 class="page-title">' + EM.t('search.title') + '</h1>' +
          '<p class="page-subtitle">' + _esc(EM.t('search.subtitle')) + '</p>' +
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
          '<p style="color:var(--text-muted)">' + _esc(EM.t('search.unavailable', { e: err.message })) + '</p>' +
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
        '<p class="search-empty-title">' + _esc(EM.t('search.none', { q: query })) + '</p>' +
        '<p class="search-empty-hint">' + _esc(EM.t('search.hint', { link: '\u0000' })).replace('\u0000',
          '<button class="btn-link" onclick="EM.Router.navigate(\'/curriculum\')">' + EM.t('nav.curriculum') + '</button>') + '</p>' +
      '</div>';
    }

    var countLine =
      '<div class="search-count">' +
        _esc(EM.t(_countKey(results.length), { n: results.length, q: '\u0000' }))
          .replace('\u0000', '<strong>' + _esc(query) + '</strong>') +
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
        typeLabel = EM.t('search.tLesson');
        typeCls   = 'result-type-lesson';
        break;
      case 'track':
        typeIcon  = EM.Icons.dashboard;
        typeLabel = EM.t('search.tTrack');
        typeCls   = 'result-type-track';
        break;
      case 'scenario':
        typeIcon  = EM.Icons.lab;
        typeLabel = EM.t('search.tScenario');
        typeCls   = 'result-type-scenario';
        break;
      case 'capstone':
        typeIcon  = EM.Icons.capstone;
        typeLabel = EM.t('search.tCapstone');
        typeCls   = 'result-type-capstone';
        break;
      case 'experiment':
        typeIcon  = EM.Icons.threads || EM.Icons.lab;
        typeLabel = EM.t('search.tExperiment');
        typeCls   = 'result-type-scenario';
        break;
      default:
        typeIcon  = EM.Icons.build;
        typeLabel = doc.type;
        typeCls   = '';
    }

    var tags = (doc.tags || []).slice(0, 4).map(function (t) {
      return '<span class="tag-chip" dir="ltr" style="font-size:11px">' + _esc(t) + '</span>';
    }).join('');

    var excerpt = _excerpt(doc.body, query, 180);

    var statusBadge = '';
    if (doc.status === 'in-development') {
      statusBadge = '<span class="badge badge-in-development" style="font-size:10px">' + EM.t('badge.inDev') + '</span>';
    }

    var metaLine =
      '<div class="result-meta">' +
        '<span class="result-track-dot" style="background:' + _esc(doc.trackColor || '#888') + '"></span>' +
        '<span class="result-track-name">' + _esc(doc.trackName) + '</span>' +
        (doc.estimatedMinutes
          ? '<span class="result-sep">·</span><span>' + EM.t('common.min', { n: doc.estimatedMinutes }) + '</span>'
          : '') +
        (doc.estimatedHours
          ? '<span class="result-sep">·</span><span>' + EM.t('common.hours', { n: doc.estimatedHours }) + '</span>'
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
      '<div class="result-title" dir="auto">' + _esc(doc.title) + '</div>' +
      (doc.subtitle ? '<div class="result-subtitle" dir="auto">' + _esc(doc.subtitle) + '</div>' : '') +
      metaLine +
      (excerpt ? '<div class="result-excerpt" dir="auto">' + excerpt + '</div>' : '') +
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
