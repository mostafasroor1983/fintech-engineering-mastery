/* ============================================================
   ENGINEERING MASTERY — Internationalisation (English / Arabic)

   - EM.I18n.t(key, vars)      → interface string in the current language
   - EM.I18n.fetchJSON(path)   → loads data/ar/... or *.ar.json when Arabic is
                                 active, falling back to English if missing
   - EM.I18n.fetchText(path)   → same for Markdown (index.md → index.ar.md)
   - EM.I18n.setLang('ar')     → switches language and re-renders the app

   Translated content lives next to the English files:
     data/tracks.json                → data/ar/tracks.json
     content/.../_track.json          → content/.../_track.ar.json
     content/.../index.md             → content/.../index.ar.md
   ============================================================ */

window.EM = window.EM || {};

EM.I18n = (function () {
  'use strict';

  var STORAGE_KEY = 'em_lang';
  var SUPPORTED   = ['en', 'ar'];
  var RTL         = { ar: true };

  function _readLang() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      if (SUPPORTED.indexOf(v) !== -1) return v;
    } catch (e) { /* storage blocked */ }
    return 'en';
  }

  var _lang = _readLang();

  /* ----------------------------------------------------------
     Interface strings
     Keep Arabic short and plain. Technical terms (Kafka, idempotency key,
     SELECT FOR UPDATE ...) stay in English where engineers use them that way.
  ---------------------------------------------------------- */
  var STR = {
    en: {
      /* Shell */
      'app.name':            'Engineering Mastery',
      'app.tagline':         'Principal Engineer Program',
      'app.loading':         'Loading Engineering Mastery…',
      'app.skip':            'Skip to main content',
      'top.menu':            'Toggle menu',
      'top.search':          'Search',
      'top.searchTitle':     'Search (press / or Ctrl+K)',
      'top.theme':           'Toggle theme',
      'top.lang':            'العربية',
      'top.langTitle':       'التبديل إلى العربية',
      'side.expand':         'Expand sidebar',
      'side.collapse':       'Collapse sidebar',
      'side.navigation':     'Navigation',
      'side.tracks':         'Tracks',
      'nav.dashboard':       'Dashboard',
      'nav.curriculum':      'Curriculum',
      'nav.decisionLab':     'Decision Lab',
      'nav.concurrencyLab':  'Concurrency Lab',
      'nav.capstone':        'Capstone Projects',
      'nav.search':          'Search',
      'nav.about':           'About',

      /* Router */
      'err.notFound':        'Page Not Found',
      'err.noRoute':         'No route matched {path}.',
      'err.toDashboard':     'Go to Dashboard',
      'err.wrong':           'Something went wrong',
      'err.failedPage':      'Failed to load page. See console for details.',
      'err.init':            'Failed to initialize',
      'err.initMsg':         'Could not load application data. Please ensure you are serving this site via HTTP (not file://).',

      /* Fallback notice */
      'i18n.fallback':       'This page is not translated yet, so it is shown in English.',

      /* Badges */
      'badge.advanced':      'Advanced',
      'badge.principal':     'Principal',
      'badge.intermediate':  'Intermediate',
      'badge.inDev':         'In Development',
      'badge.critical':      'Critical Priority',
      'badge.high':          'High Priority',
      'badge.planned':       'Planned',

      /* Dashboard */
      'dash.title1':         'Engineering',
      'dash.title2':         'Mastery',
      'dash.subtitle':       'Principal Software Engineer development program for Staff and Principal roles in international banks and FinTech companies.',
      'dash.tracks':         'Learning Tracks',
      'dash.lessons':        'Total Lessons',
      'dash.completed':      'Completed',
      'dash.overall':        'Overall Progress',
      'dash.critical':       'Critical Priority',
      'dash.allTracks':      'All Tracks',
      'common.track':        'TRACK {n}',
      'common.lesson':       'LESSON {n}',
      'common.lessonsHours': '{n} lessons · {h}h',
      'common.lessons':      '{n} lessons',
      'common.hours':        '{n}h',
      'common.min':          '{n} min',
      'common.back':         'Back',

      /* Curriculum */
      'cur.title':           'Curriculum',
      'cur.subtitle':        '{lessons} lessons across {tracks} learning tracks — {hours} estimated hours. From Advanced Architecture to Staff & Principal Engineering Leadership.',
      'cur.back':            '← Curriculum',
      'cur.notFound':        'Track Not Found',
      'cur.trackId':         'Track ID: {id}',
      'cur.topics':          'Topics Covered',
      'cur.lessons':         'Lessons ({n})',
      'cur.optional':        'Optional: read if time allows ({n})',
      'cur.statusDone':      'Completed',
      'cur.statusProgress':  'In Progress',
      'cur.statusNone':      'Not Started',
      'cur.soonTitle':       'Lessons Coming Soon',
      'cur.soonDev':         'This track is being developed. Lessons will appear here as they are published.',
      'cur.soonPlanned':     'This track is on the roadmap. Priority tracks (Track 03, 04, 05) are developed first.',
      'cur.backToCur':       '← Back to Curriculum',

      /* Coming soon */
      'soon.whatsComing':    "What's Coming",
      'soon.desc':           'This section is on the development roadmap and will be released in an upcoming phase.',
      'soon.back':           '← Back to Dashboard',

      /* Decision Lab */
      'lab.title':           'Decision Lab',
      'lab.subtitle':        'Real-world engineering scenarios drawn from production incidents in banking and FinTech. Each scenario presents a system under stress — analyse the constraints, choose your approach, and defend it. Scored against a Principal Engineer rubric.',
      'lab.howTitle':        'How it works',
      'lab.how1':            'Read the incident and the system constraints.',
      'lab.how2':            'Answer three decisions in order. Each answer is scored, and partial credit is possible.',
      'lab.how3':            'Read the debrief: why the best answer wins and which lessons to study next.',
      'lab.statScenarios':   '{n} scenarios',
      'lab.statCompleted':   '{n} completed',
      'lab.statDifficulty':  'Principal difficulty',
      'lab.scenario':        'SCENARIO {n}',
      'lab.tierPrincipal':   'Principal Engineer',
      'lab.tierSenior':      'Senior Engineer',
      'lab.tierDeveloping':  'Needs Development',
      'lab.inProgress':      'In Progress — Stage {n} of {total}',
      'lab.notStarted':      'Not Started · {n} min',
      'lab.notFound':        'Scenario Not Found',
      'lab.scenarioId':      'Scenario ID: {id}',
      'lab.back':            '← Decision Lab',
      'lab.context':         'Scenario Context',
      'lab.constraints':     'System Constraints',
      'lab.startIntro':      'You will face {n} decision stages. Read the context carefully. Each stage is scored; maximum {max} points.',
      'lab.metaMin':         '{n} min',
      'lab.metaStages':      '{n} stages',
      'lab.metaPts':         '{n} pts max',
      'lab.begin':           'Begin Scenario',
      'lab.stage':           'Stage {n}',
      'lab.stageOf':         'Stage {n} of {total}',
      'lab.stageDone':       'Stage {n} — Completed',
      'lab.ptsAvailable':    '{n} pts available',
      'lab.pts':             '{a}/{b} pts',
      'lab.ofPts':           '/ {n} pts',
      'lab.perfect':         'Perfect',
      'lab.partial':         'Partial credit',
      'lab.incorrect':       'Incorrect',
      'lab.viewDebrief':     'View Full Debrief & Score',
      'lab.next':            'Next Stage →',
      'lab.perspective':     'Principal Engineer Perspective',
      'lab.yourAnswer':      'Your answer:',
      'lab.bestAnswer':      'Best answer:',
      'lab.principalPersp':  'Principal perspective: ',
      'lab.debrief':         'Principal Engineer Debrief',
      'lab.takeaways':       'Key Takeaways',
      'lab.reading':         'Further Reading',
      'lab.related':         'Study Next: Related Lessons',
      'lab.retry':           'Retry Scenario',
      'lab.all':             '← All Scenarios'
    },

    ar: {
      /* Shell */
      'app.name':            'إتقان الهندسة',
      'app.tagline':         'برنامج المهندس الرئيسي',
      'app.loading':         'جارٍ التحميل…',
      'app.skip':            'انتقل إلى المحتوى',
      'top.menu':            'إظهار القائمة',
      'top.search':          'بحث',
      'top.searchTitle':     'بحث (اضغط / أو Ctrl+K)',
      'top.theme':           'تغيير المظهر',
      'top.lang':            'English',
      'top.langTitle':       'Switch to English',
      'side.expand':         'إظهار الشريط الجانبي',
      'side.collapse':       'إخفاء الشريط الجانبي',
      'side.navigation':     'التنقل',
      'side.tracks':         'المسارات',
      'nav.dashboard':       'الرئيسية',
      'nav.curriculum':      'المنهج',
      'nav.decisionLab':     'مختبر القرارات',
      'nav.concurrencyLab':  'مختبر التزامن',
      'nav.capstone':        'المشاريع التطبيقية',
      'nav.search':          'بحث',
      'nav.about':           'عن البرنامج',

      /* Router */
      'err.notFound':        'الصفحة غير موجودة',
      'err.noRoute':         'لا توجد صفحة بالعنوان {path}.',
      'err.toDashboard':     'العودة إلى الرئيسية',
      'err.wrong':           'حدث خطأ',
      'err.failedPage':      'تعذّر تحميل الصفحة. راجع وحدة التحكم (Console) للتفاصيل.',
      'err.init':            'تعذّر تشغيل الموقع',
      'err.initMsg':         'تعذّر تحميل بيانات الموقع. تأكد من فتح الموقع عبر HTTP وليس file://.',

      /* Fallback notice */
      'i18n.fallback':       'هذه الصفحة غير مترجمة بعد، لذلك تظهر باللغة الإنجليزية.',

      /* Badges */
      'badge.advanced':      'متقدم',
      'badge.principal':     'مستوى رئيسي',
      'badge.intermediate':  'متوسط',
      'badge.inDev':         'قيد الإعداد',
      'badge.critical':      'أولوية قصوى',
      'badge.high':          'أولوية عالية',
      'badge.planned':       'مخطط له',

      /* Dashboard */
      'dash.title1':         'إتقان',
      'dash.title2':         'الهندسة',
      'dash.subtitle':       'برنامج لتطوير مهندسي البرمجيات نحو وظائف Staff وPrincipal في البنوك الدولية وشركات التقنية المالية.',
      'dash.tracks':         'مسار تعليمي',
      'dash.lessons':        'إجمالي الدروس',
      'dash.completed':      'مكتمل',
      'dash.overall':        'التقدم العام',
      'dash.critical':       'أولوية قصوى',
      'dash.allTracks':      'كل المسارات',
      'common.track':        'المسار {n}',
      'common.lesson':       'الدرس {n}',
      'common.lessonsHours': '{n} درس · {h} ساعة',
      'common.lessons':      '{n} درس',
      'common.hours':        '{n} ساعة',
      'common.min':          '{n} دقيقة',
      'common.back':         'رجوع',

      /* Curriculum */
      'cur.title':           'المنهج',
      'cur.subtitle':        '{lessons} درسًا في {tracks} مسارًا تعليميًا — نحو {hours} ساعة دراسة. من البنية المعمارية المتقدمة إلى القيادة الهندسية على مستوى Staff وPrincipal.',
      'cur.back':            '→ المنهج',
      'cur.notFound':        'المسار غير موجود',
      'cur.trackId':         'معرّف المسار: {id}',
      'cur.topics':          'المواضيع',
      'cur.lessons':         'الدروس ({n})',
      'cur.optional':        'دروس اختيارية: اقرأها إن سمح الوقت ({n})',
      'cur.statusDone':      'مكتمل',
      'cur.statusProgress':  'قيد الدراسة',
      'cur.statusNone':      'لم يبدأ',
      'cur.soonTitle':       'الدروس قريبًا',
      'cur.soonDev':         'هذا المسار قيد الإعداد. ستظهر الدروس هنا عند نشرها.',
      'cur.soonPlanned':     'هذا المسار ضمن الخطة. يتم إعداد المسارات ذات الأولوية (03 و04 و05) أولًا.',
      'cur.backToCur':       '→ العودة إلى المنهج',

      /* Coming soon */
      'soon.whatsComing':    'ما القادم',
      'soon.desc':           'هذا القسم ضمن خطة التطوير وسيُنشر في مرحلة قادمة.',
      'soon.back':           '→ العودة إلى الرئيسية',

      /* Decision Lab */
      'lab.title':           'مختبر القرارات',
      'lab.subtitle':        'سيناريوهات هندسية واقعية مأخوذة من حوادث فعلية في أنظمة البنوك والتقنية المالية. في كل سيناريو نظام تحت ضغط: افهم القيود، واختر الحل، وكن مستعدًا للدفاع عنه. يتم التقييم وفق معايير المهندس الرئيسي (Principal Engineer).',
      'lab.howTitle':        'طريقة العمل',
      'lab.how1':            'اقرأ وصف الحادثة وقيود النظام.',
      'lab.how2':            'أجب عن ثلاثة قرارات بالترتيب. لكل إجابة درجة، وقد تحصل على درجة جزئية.',
      'lab.how3':            'اقرأ التحليل النهائي: لماذا كانت الإجابة الأفضل هي الأفضل، وما الدروس التي تدرسها بعد ذلك.',
      'lab.statScenarios':   '{n} سيناريو',
      'lab.statCompleted':   '{n} مكتمل',
      'lab.statDifficulty':  'مستوى صعوبة: Principal',
      'lab.scenario':        'السيناريو {n}',
      'lab.tierPrincipal':   'مستوى مهندس رئيسي',
      'lab.tierSenior':      'مستوى مهندس أول',
      'lab.tierDeveloping':  'يحتاج إلى تطوير',
      'lab.inProgress':      'قيد الحل — المرحلة {n} من {total}',
      'lab.notStarted':      'لم يبدأ · {n} دقيقة',
      'lab.notFound':        'السيناريو غير موجود',
      'lab.scenarioId':      'معرّف السيناريو: {id}',
      'lab.back':            '→ مختبر القرارات',
      'lab.context':         'وصف الحادثة',
      'lab.constraints':     'قيود النظام',
      'lab.startIntro':      'ستواجه {n} مراحل من القرارات. اقرأ الوصف بعناية. لكل مرحلة درجة، والحد الأقصى {max} نقطة.',
      'lab.metaMin':         '{n} دقيقة',
      'lab.metaStages':      '{n} مراحل',
      'lab.metaPts':         'حتى {n} نقطة',
      'lab.begin':           'ابدأ السيناريو',
      'lab.stage':           'المرحلة {n}',
      'lab.stageOf':         'المرحلة {n} من {total}',
      'lab.stageDone':       'المرحلة {n} — مكتملة',
      'lab.ptsAvailable':    '{n} نقطة متاحة',
      'lab.pts':             '{a}/{b} نقطة',
      'lab.ofPts':           'من {n} نقطة',
      'lab.perfect':         'إجابة كاملة',
      'lab.partial':         'درجة جزئية',
      'lab.incorrect':       'إجابة خاطئة',
      'lab.viewDebrief':     'عرض التحليل النهائي والنتيجة',
      'lab.next':            'المرحلة التالية ←',
      'lab.perspective':     'رأي المهندس الرئيسي',
      'lab.yourAnswer':      'إجابتك:',
      'lab.bestAnswer':      'الإجابة الأفضل:',
      'lab.principalPersp':  'رأي المهندس الرئيسي: ',
      'lab.debrief':         'التحليل النهائي',
      'lab.takeaways':       'أهم الدروس المستفادة',
      'lab.reading':         'قراءات إضافية',
      'lab.related':         'ادرس بعد ذلك: دروس ذات صلة',
      'lab.retry':           'أعد المحاولة',
      'lab.all':             '→ كل السيناريوهات'
    }
  };

  /* ----------------------------------------------------------
     Core API
  ---------------------------------------------------------- */
  function lang()  { return _lang; }
  function isRtl() { return !!RTL[_lang]; }

  function t(key, vars) {
    var table = STR[_lang] || STR.en;
    var s = Object.prototype.hasOwnProperty.call(table, key) ? table[key]
          : (Object.prototype.hasOwnProperty.call(STR.en, key) ? STR.en[key] : key);
    if (vars) {
      s = s.replace(/\{(\w+)\}/g, function (m, k) {
        return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m;
      });
    }
    return s;
  }

  /* Register extra strings from other modules: EM.I18n.add({en:{...}, ar:{...}}) */
  function add(tables) {
    Object.keys(tables || {}).forEach(function (l) {
      STR[l] = STR[l] || {};
      Object.keys(tables[l]).forEach(function (k) { STR[l][k] = tables[l][k]; });
    });
  }

  function apply() {
    var html = document.documentElement;
    html.setAttribute('lang', _lang);
    html.setAttribute('dir', isRtl() ? 'rtl' : 'ltr');
  }

  function setLang(next) {
    if (SUPPORTED.indexOf(next) === -1 || next === _lang) return;
    _lang = next;
    try { localStorage.setItem(STORAGE_KEY, next); } catch (e) { /* ignore */ }
    apply();
    document.dispatchEvent(new CustomEvent('em:lang-changed', { detail: { lang: next } }));
  }

  function toggle() { setLang(_lang === 'ar' ? 'en' : 'ar'); }

  /* ----------------------------------------------------------
     Localised content loading
  ---------------------------------------------------------- */
  function localizedPath(path, l) {
    l = l || _lang;
    if (l === 'en') return path;
    if (/^data\//.test(path)) return path.replace(/^data\//, 'data/' + l + '/');
    return path.replace(/\.(md|json)$/, '.' + l + '.$1');
  }

  var _missing = {};   // remember 404s so we do not ask again in this session

  function _fetchLocalized(path, kind) {
    function plain() {
      return fetch(path).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + path);
        return r[kind]().then(function (body) { return { body: body, fallback: _lang !== 'en' }; });
      });
    }
    if (_lang === 'en') {
      return plain().then(function (res) { res.fallback = false; return res; });
    }
    var lp = localizedPath(path);
    if (_missing[lp]) return plain();
    return fetch(lp).then(function (r) {
      if (!r.ok) { _missing[lp] = true; return plain(); }
      return r[kind]().then(function (body) { return { body: body, fallback: false }; });
    }, function () { _missing[lp] = true; return plain(); });
  }

  /* Resolves to { body, fallback } — fallback=true means English was used */
  function fetchJSON(path) { return _fetchLocalized(path, 'json'); }
  function fetchText(path) { return _fetchLocalized(path, 'text'); }

  /* Small notice used when English content is shown in the Arabic UI */
  function fallbackNote() {
    return '<div class="i18n-fallback-note" role="note">' +
      '<span aria-hidden="true">ⓘ</span><span>' + t('i18n.fallback') + '</span></div>';
  }

  apply();

  return {
    lang:          lang,
    isRtl:         isRtl,
    t:             t,
    add:           add,
    setLang:       setLang,
    toggle:        toggle,
    apply:         apply,
    localizedPath: localizedPath,
    fetchJSON:     fetchJSON,
    fetchText:     fetchText,
    fallbackNote:  fallbackNote
  };
}());

/* Short alias used throughout the templates */
EM.t = function (key, vars) { return EM.I18n.t(key, vars); };
