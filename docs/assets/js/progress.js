/* ============================================================
   ENGINEERING MASTERY — Progress Manager
   LocalStorage-based progress tracking (ADR-004)
   ============================================================ */

window.EM = window.EM || {};

EM.Progress = (function () {
  'use strict';

  const STORAGE_KEY = 'em_progress';
  const VERSION = 2;

  let _cache = null;

  /* ----------------------------------------------------------
     Default Data Structure
  ---------------------------------------------------------- */
  function _defaults() {
    return {
      version:     VERSION,
      createdAt:   new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      lessons:     {},
      decisionLab: {},
      capstone:    {}
    };
  }

  /* ----------------------------------------------------------
     Load from LocalStorage
  ---------------------------------------------------------- */
  function load() {
    if (_cache) return _cache;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.version === VERSION) {
          _cache = parsed;
          return _cache;
        }
        // Version migration placeholder — just reset for now
      }
    } catch (e) {
      console.warn('[EM.Progress] Failed to load:', e);
    }
    _cache = _defaults();
    return _cache;
  }

  /* ----------------------------------------------------------
     Persist to LocalStorage
  ---------------------------------------------------------- */
  function _save() {
    try {
      _cache.lastUpdated = new Date().toISOString();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_cache));
    } catch (e) {
      console.warn('[EM.Progress] Failed to save:', e);
    }
  }

  /* ----------------------------------------------------------
     Lessons
  ---------------------------------------------------------- */
  function getLessonStatus(lessonId) {
    const data = load();
    return (data.lessons[lessonId] && data.lessons[lessonId].status) || 'not-started';
  }

  function setLessonStatus(lessonId, status) {
    const data = load();
    if (!data.lessons[lessonId]) data.lessons[lessonId] = {};
    data.lessons[lessonId].status = status;
    if (status === 'completed') {
      data.lessons[lessonId].completedAt = new Date().toISOString();
    } else if (status === 'in-progress' && !data.lessons[lessonId].startedAt) {
      data.lessons[lessonId].startedAt = new Date().toISOString();
    }
    _save();
  }

  function saveKnowledgeCheck(lessonId, score, total) {
    const data = load();
    if (!data.lessons[lessonId]) data.lessons[lessonId] = {};
    data.lessons[lessonId].knowledgeCheck = {
      attempted:   true,
      score:       score,
      total:       total,
      lastAttempt: new Date().toISOString()
    };
    _save();
  }

  function savePracticalItem(lessonId, itemId, done) {
    const data = load();
    if (!data.lessons[lessonId]) data.lessons[lessonId] = {};
    if (!data.lessons[lessonId].practicalItems) data.lessons[lessonId].practicalItems = {};
    data.lessons[lessonId].practicalItems[itemId] = done;
    _save();
  }

  /* ----------------------------------------------------------
     Track Progress
  ---------------------------------------------------------- */
  function getTrackProgress(trackId, totalLessons) {
    if (!totalLessons || totalLessons === 0) return 0;
    const data = load();
    var completed = 0;
    var keys = Object.keys(data.lessons);
    for (var i = 0; i < keys.length; i++) {
      var id = keys[i];
      if (id.indexOf(trackId) === 0 && data.lessons[id].status === 'completed') {
        completed++;
      }
    }
    return Math.round((completed / totalLessons) * 100);
  }

  function getCompletedCount(trackId) {
    const data = load();
    var count = 0;
    var keys = Object.keys(data.lessons);
    for (var i = 0; i < keys.length; i++) {
      var id = keys[i];
      if (id.indexOf(trackId) === 0 && data.lessons[id].status === 'completed') {
        count++;
      }
    }
    return count;
  }

  function getOverallStats(tracks) {
    const data = load();
    var totalLessons = 0;
    var completedLessons = 0;
    var inProgressLessons = 0;

    for (var i = 0; i < tracks.length; i++) {
      totalLessons += tracks[i].lessonCount || 0;
    }

    var lessonValues = Object.values(data.lessons);
    for (var j = 0; j < lessonValues.length; j++) {
      if (lessonValues[j].status === 'completed')   completedLessons++;
      if (lessonValues[j].status === 'in-progress') inProgressLessons++;
    }

    var pct = totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;

    return {
      totalLessons:     totalLessons,
      completedLessons: completedLessons,
      inProgressLessons:inProgressLessons,
      overallPct:       pct
    };
  }

  /* ----------------------------------------------------------
     Decision Lab
  ---------------------------------------------------------- */
  function getScenarioState(scenarioId) {
    const data = load();
    return data.decisionLab[scenarioId] || { state: 'IDLE' };
  }

  function saveScenarioState(scenarioId, stateObj) {
    const data = load();
    data.decisionLab[scenarioId] = Object.assign(
      data.decisionLab[scenarioId] || {},
      stateObj
    );
    _save();
  }

  /* ----------------------------------------------------------
     Capstone
  ---------------------------------------------------------- */
  function getCapstoneStatus(projectId) {
    const data = load();
    return data.capstone[projectId] || { status: 'not-started', checklistItems: {} };
  }

  function saveCapstoneItem(projectId, itemId, done) {
    const data = load();
    if (!data.capstone[projectId]) data.capstone[projectId] = { status: 'not-started', checklistItems: {} };
    data.capstone[projectId].checklistItems[itemId] = done;
    data.capstone[projectId].status = 'in-progress';
    _save();
  }

  /* ----------------------------------------------------------
     Export / Import
  ---------------------------------------------------------- */
  function exportJSON() {
    const data = load();
    var json = JSON.stringify(data, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href     = url;
    a.download = 'em-progress-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function importJSON(jsonString) {
    try {
      var parsed = JSON.parse(jsonString);
      if (parsed && parsed.version && parsed.lessons) {
        _cache = parsed;
        _save();
        return true;
      }
    } catch (e) {
      console.error('[EM.Progress] Import failed:', e);
    }
    return false;
  }

  function reset() {
    _cache = _defaults();
    _save();
  }

  /* ----------------------------------------------------------
     Public API
  ---------------------------------------------------------- */
  return {
    load:               load,
    getLessonStatus:    getLessonStatus,
    setLessonStatus:    setLessonStatus,
    saveKnowledgeCheck: saveKnowledgeCheck,
    savePracticalItem:  savePracticalItem,
    getTrackProgress:   getTrackProgress,
    getCompletedCount:  getCompletedCount,
    getOverallStats:    getOverallStats,
    getScenarioState:   getScenarioState,
    saveScenarioState:  saveScenarioState,
    getCapstoneStatus:  getCapstoneStatus,
    saveCapstoneItem:   saveCapstoneItem,
    exportJSON:         exportJSON,
    importJSON:         importJSON,
    reset:              reset
  };
}());
