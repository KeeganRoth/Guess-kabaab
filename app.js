// Guess the Phrase — static Heads Up–style game
// Adds: service worker registration for offline caching.

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  // Screens
  const screenSetup = $('#screenSetup');
  const screenGame = $('#screenGame');
  const screenResults = $('#screenResults');

  // Setup elements
  const phrasesInput = $('#phrasesInput');
  const fileInput = $('#fileInput');
  const timerSecondsInput = $('#timerSeconds');
  const shuffleOnStartInput = $('#shuffleOnStart');
  const loopWhenFinishedInput = $('#loopWhenFinished');
  const vibrateOnActionInput = $('#vibrateOnAction');
  const tiltEnabledInput = $('#tiltEnabled');
  const motionPermBtn = $('#motionPermBtn');

  const startBtn = $('#startBtn');
  const clearBtn = $('#clearBtn');
  const useSampleBtn = $('#useSampleBtn');
  const phraseCountMeta = $('#phraseCountMeta');

  // Game elements
  const timeLeftEl = $('#timeLeft');
  const progressEl = $('#progress');
  const remainingEl = $('#remaining');
  const phraseEl = $('#phrase');
  const feedbackEl = $('#feedback');
  const gameStage = $('#gameStage');
  const tapLeft = $('#tapLeft');
  const tapRight = $('#tapRight');
  const nextBtn = $('#nextBtn');
  const endBtn = $('#endBtn');
  const tiltStatus = $('#tiltStatus');

  // Results elements
  const statTotal = $('#statTotal');
  const statGot = $('#statGot');
  const statPass = $('#statPass');
  const roundDetails = $('#roundDetails');
  const playAgainBtn = $('#playAgainBtn');
  const editListBtn = $('#editListBtn');

  // Fullscreen
  const fullscreenBtn = $('#fullscreenBtn');

  // LocalStorage
  const LS_KEY = 'gtp.v1.settings';

  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function saveSettings(partial) {
    const current = loadSettings() || {};
    const next = { ...current, ...partial };
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }

  // Phrase parsing rules
  // Supports either:
  //   Phrase
  //   Phrase :: description/background
  // Lines starting with # are ignored.
  function parsePhrases(text) {
    return text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .filter((l) => !l.startsWith('#'))
      .map((line) => {
        const parts = line.split('::');
        const phrase = (parts[0] ?? '').trim();
        // allow extra :: inside description by joining remainder back
        const hint = parts.slice(1).join('::').trim();
        return { phrase, hint };
      })
      .filter((o) => o.phrase.length > 0);
  }

  // Fisher–Yates shuffle
  function fisherYatesShuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // App state
  const State = {
    mode: 'setup', // 'setup' | 'running' | 'finished'

    // phrases are objects: { phrase: string, hint: string }
    phrasesOriginal: [],
    deck: [],
    index: 0,
    shown: 0,
    got: 0,
    pass: 0,

    timerSeconds: 60,
    timeLeft: 60,
    timerId: null,

    shuffleOnStart: true,
    loopWhenFinished: false,
    vibrateOnAction: true,

    // Tilt
    tiltEnabled: false,
    tiltPermissionGranted: false,
    tiltListenerAttached: false,
    tiltLastActionAt: 0,
    tiltArmed: true,
    tiltNeutralBeta: 0,
    tiltHasBaseline: false,

    // Wake Lock
    wakeLock: null
  };

  // Tilt tuning knobs
  const TILT = {
    forwardTriggerDelta: 18,    // forward/down => GOT IT
    backwardTriggerDelta: -18,  // backward/up => PASS
    neutralZoneAbs: 10,         // return within this to re-arm
    minIntervalMs: 700,         // debounce
    baselineSmoothing: 0.12     // baseline adjustment near neutral
  };

  // -----------------------------
  // UI helpers
  // -----------------------------
  function setScreen(mode) {
    State.mode = mode;
    const isSetup = mode === 'setup';
    const isGame = mode === 'running';
    const isResults = mode === 'finished';

    screenSetup.classList.toggle('screen-active', isSetup);
    screenGame.classList.toggle('screen-active', isGame);
    screenResults.classList.toggle('screen-active', isResults);

    screenSetup.setAttribute('aria-hidden', String(!isSetup));
    screenGame.setAttribute('aria-hidden', String(!isGame));
    screenResults.setAttribute('aria-hidden', String(!isResults));

    document.body.classList.toggle('game-mode', isGame);

    if (tiltStatus) {
      tiltStatus.textContent = isGame ? tiltStatusText(State.tiltEnabled ? 'Ready' : 'Off') : '';
    }
  }

  function updatePhraseCountMeta() {
    const list = parsePhrases(phrasesInput.value);
    phraseCountMeta.textContent = list.length
      ? `${list.length} phrase${list.length === 1 ? '' : 's'} ready`
      : 'Paste or load a list to start';
  }

  function updateHUD() {
    timeLeftEl.textContent = String(State.timeLeft);
    progressEl.textContent = `${State.shown} / ${State.deck.length}`;
    remainingEl.textContent = String(Math.max(0, State.deck.length - State.shown));
  }

  function showFeedback(kind, text) {
    feedbackEl.classList.remove('got', 'pass', 'end', 'show');
    if (kind) feedbackEl.classList.add(kind);
    feedbackEl.textContent = text || '';
    // force reflow for reliable transition
    // eslint-disable-next-line no-unused-expressions
    feedbackEl.offsetHeight;
    feedbackEl.classList.add('show');
  }

  function hideFeedback() {
    feedbackEl.classList.remove('show', 'got', 'pass', 'end');
    feedbackEl.textContent = '';
  }

  // -----------------------------
  // Gameplay
  // -----------------------------
  function buildDeck(phrases) {
    const deck = phrases.map((p) => ({ ...p })); // copy objects
    if (State.shuffleOnStart) fisherYatesShuffle(deck);
    return deck;
  }

  function renderCurrentPhrase() {
    const item = State.deck[State.index];
    phraseEl.textContent = item?.phrase ?? 'Done!';
  }

  function maybeVibrate(action) {
    if (!State.vibrateOnAction) return;
    if (!('vibrate' in navigator)) return;
    try {
      if (action === 'got') navigator.vibrate(20);
      else if (action === 'pass') navigator.vibrate([12, 30, 12]);
    } catch {
      // ignore
    }
  }

  function advance(action /* 'got' | 'pass' | 'next' */) {
    if (State.mode !== 'running') return;

    const current = State.deck[State.index];
    if (!current) {
      if (State.loopWhenFinished && State.deck.length > 0) {
        State.index = 0;
        renderCurrentPhrase();
        return;
      }
      endRound('Reached the end of the list');
      return;
    }

    State.shown += 1;
    if (action === 'got') State.got += 1;
    if (action === 'pass') State.pass += 1;

    if (action === 'got') showFeedback('got', 'Got it!');
    else if (action === 'pass') showFeedback('pass', 'Pass!');
    else showFeedback('', 'Next');

    maybeVibrate(action);

    State.index += 1;
    updateHUD();

    const atEnd = State.index >= State.deck.length;
    const delay = 420;

    setTimeout(() => {
      hideFeedback();
      if (atEnd) {
        if (State.loopWhenFinished && State.deck.length > 0) {
          State.index = 0;
          renderCurrentPhrase();
          updateHUD();
        } else {
          endRound('Reached the end of the list');
        }
      } else {
        renderCurrentPhrase();
      }
    }, delay);
  }

  function startRound() {
    const phrases = parsePhrases(phrasesInput.value);
    if (phrases.length === 0) {
      alert('Please add at least one phrase to start.');
      return;
    }

    saveSettings({
      phrasesText: phrasesInput.value,
      timerSeconds: State.timerSeconds,
      shuffleOnStart: State.shuffleOnStart,
      loopWhenFinished: State.loopWhenFinished,
      vibrateOnAction: State.vibrateOnAction,
      tiltEnabled: State.tiltEnabled
    });

    State.phrasesOriginal = phrases;
    State.deck = buildDeck(phrases);

    State.index = 0;
    State.shown = 0;
    State.got = 0;
    State.pass = 0;

    State.timeLeft = State.timerSeconds;

    // Reset tilt arming/baseline each round
    State.tiltLastActionAt = 0;
    State.tiltArmed = true;
    State.tiltHasBaseline = false;

    setScreen('running');
    hideFeedback();
    renderCurrentPhrase();
    updateHUD();

    tryLockOrientation();
    requestWakeLock();

    // Tilt: enable if possible (may require permission)
    maybeEnableTiltDuringGame();

    startTimer();
  }

  function renderResults(reason) {
    statTotal.textContent = String(State.shown);
    statGot.textContent = String(State.got);
    statPass.textContent = String(State.pass);

    const total = State.deck.length;
    const remaining = Math.max(0, total - State.shown);
    roundDetails.textContent =
      `${reason}. You saw ${State.shown} of ${total} phrase${total === 1 ? '' : 's'} (${remaining} remaining).`;
  }

  function endRound(reason = 'Time is up') {
    stopTimer();
    releaseWakeLock();
    disableTiltListener();

    showFeedback('end', 'Round ended');
    setTimeout(() => {
      setScreen('finished');
      renderResults(reason);
      hideFeedback();
    }, 250);
  }

  // -----------------------------
  // Timer
  // -----------------------------
  function startTimer() {
    stopTimer();
    const startedAt = Date.now();

    State.timerId = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      State.timeLeft = Math.max(0, State.timerSeconds - elapsed);
      updateHUD();

      if (State.timeLeft <= 0) {
        endRound('Time is up');
      }
    }, 250);
  }

  function stopTimer() {
    if (State.timerId) {
      clearInterval(State.timerId);
      State.timerId = null;
    }
  }

  // -----------------------------
  // Swipe detector (lightweight)
  // -----------------------------
  const Swipe = { active: false, startX: 0, startY: 0, startT: 0 };
  const SWIPE_THRESHOLD_PX = 42;
  const SWIPE_MAX_OFF_AXIS = 80;
  const SWIPE_MAX_MS = 800;

  function swipeStart(x, y) {
    if (State.mode !== 'running') return;
    Swipe.active = true;
    Swipe.startX = x;
    Swipe.startY = y;
    Swipe.startT = Date.now();
  }

  function swipeEnd(x, y) {
    if (!Swipe.active || State.mode !== 'running') return;
    Swipe.active = false;

    const dx = x - Swipe.startX;
    const dy = y - Swipe.startY;
    const dt = Date.now() - Swipe.startT;

    const absX = Math.abs(dx);
    const absY = Math.abs(dy);

    const isQuickEnough = dt <= SWIPE_MAX_MS;
    const isFarEnough = absX >= SWIPE_THRESHOLD_PX;
    const isMostlyHorizontal = absY <= SWIPE_MAX_OFF_AXIS;

    if (isQuickEnough && isFarEnough && isMostlyHorizontal) {
      if (dx > 0) advance('got'); // swipe right
      else advance('pass');       // swipe left
    }
  }

  gameStage.addEventListener('touchstart', (e) => {
    if (!e.touches || e.touches.length !== 1) return;
    const t = e.touches[0];
    swipeStart(t.clientX, t.clientY);
  }, { passive: true });

  gameStage.addEventListener('touchend', (e) => {
    const t = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0] : null;
    if (!t) return;
    swipeEnd(t.clientX, t.clientY);
  }, { passive: true });

  gameStage.addEventListener('pointerdown', (e) => swipeStart(e.clientX, e.clientY));
  gameStage.addEventListener('pointerup', (e) => swipeEnd(e.clientX, e.clientY));

  // Prevent scroll during game
  document.addEventListener('touchmove', (e) => {
    if (State.mode === 'running') e.preventDefault();
  }, { passive: false });

  // Prevent double-tap zoom (best effort)
  let lastTouchEnd = 0;
  document.addEventListener('touchend', (e) => {
    if (State.mode !== 'running') return;
    const now = Date.now();
    if (now - lastTouchEnd <= 300) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });

  // Tap fallback
  tapLeft.addEventListener('click', () => advance('pass'));
  tapRight.addEventListener('click', () => advance('got'));
  nextBtn.addEventListener('click', () => advance('next'));
  endBtn.addEventListener('click', () => endRound('Ended early'));

  // -----------------------------
  // Fullscreen (button)
  // -----------------------------
  function canFullscreen() {
    const el = document.documentElement;
    return !!(el.requestFullscreen || el.webkitRequestFullscreen);
  }

  function requestFullscreen() {
    const el = document.documentElement;
    const fn = el.requestFullscreen || el.webkitRequestFullscreen;
    if (fn) return fn.call(el);
    return Promise.reject(new Error('Fullscreen not supported'));
  }

  function exitFullscreen() {
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (fn) return fn.call(document);
    return Promise.resolve();
  }

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  fullscreenBtn.addEventListener('click', async () => {
    try {
      if (!canFullscreen()) {
        alert('Fullscreen is not supported on this device/browser.');
        return;
      }
      if (isFullscreen()) await exitFullscreen();
      else await requestFullscreen();
    } catch {
      // ignore
    }
  });

  // -----------------------------
  // Wake Lock (best-effort)
  // -----------------------------
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      State.wakeLock = await navigator.wakeLock.request('screen');
      document.addEventListener('visibilitychange', onVisibilityChange, { once: true });
    } catch {
      State.wakeLock = null;
    }
  }

  async function releaseWakeLock() {
    try {
      if (State.wakeLock) await State.wakeLock.release();
    } catch {
      // ignore
    } finally {
      State.wakeLock = null;
    }
  }

  async function onVisibilityChange() {
    if (document.visibilityState === 'visible' && State.mode === 'running') {
      await requestWakeLock();
    } else {
      await releaseWakeLock();
    }
  }

  // -----------------------------
  // Orientation lock (best-effort)
  // -----------------------------
  async function tryLockOrientation() {
    const orientation = screen.orientation;
    if (!orientation || !orientation.lock) return;
    try {
      await orientation.lock('landscape');
    } catch {
      // ignore
    }
  }

  // -----------------------------
  // Tilt controls (DeviceOrientationEvent)
  // -----------------------------
  function isIOSNeedsMotionPermission() {
    return (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function'
    );
  }

  async function requestMotionPermission() {
    if (!isIOSNeedsMotionPermission()) {
      State.tiltPermissionGranted = true;
      return true;
    }
    try {
      const res = await DeviceOrientationEvent.requestPermission();
      State.tiltPermissionGranted = (res === 'granted');
      return State.tiltPermissionGranted;
    } catch {
      State.tiltPermissionGranted = false;
      return false;
    }
  }

  function tiltStatusText(extra = '') {
    const base = State.tiltEnabled ? 'Tilt: On' : 'Tilt: Off';
    return extra ? `${base} · ${extra}` : base;
  }

  function setTiltStatus(extra = '') {
    if (!tiltStatus) return;
    if (State.mode !== 'running') return;
    tiltStatus.textContent = tiltStatusText(extra);
  }

  function shouldListenTilt() {
    return State.tiltEnabled && State.mode === 'running';
  }

  function attachTiltListener() {
    if (State.tiltListenerAttached) return;
    window.addEventListener('deviceorientation', onDeviceOrientation, { passive: true });
    State.tiltListenerAttached = true;
  }

  function disableTiltListener() {
    if (!State.tiltListenerAttached) return;
    window.removeEventListener('deviceorientation', onDeviceOrientation);
    State.tiltListenerAttached = false;
  }

  function maybeEnableTiltDuringGame() {
    if (!State.tiltEnabled) {
      motionPermBtn.hidden = true;
      disableTiltListener();
      setTiltStatus('Off');
      return;
    }

    if (isIOSNeedsMotionPermission() && !State.tiltPermissionGranted) {
      motionPermBtn.hidden = false;
      setTiltStatus('Needs permission');
      return;
    }

    motionPermBtn.hidden = true;
    attachTiltListener();
    setTiltStatus('Ready');
  }

  function calibrateBaseline(beta) {
    if (!State.tiltHasBaseline) {
      State.tiltNeutralBeta = beta;
      State.tiltHasBaseline = true;
      return;
    }
    const delta = beta - State.tiltNeutralBeta;
    if (Math.abs(delta) <= TILT.neutralZoneAbs + 4) {
      State.tiltNeutralBeta = State.tiltNeutralBeta + delta * TILT.baselineSmoothing;
    }
  }

  function onDeviceOrientation(e) {
    if (!shouldListenTilt()) return;

    const beta = (typeof e.beta === 'number') ? e.beta : null;
    if (beta == null) return;

    calibrateBaseline(beta);
    const delta = beta - State.tiltNeutralBeta;

    if (!State.tiltArmed) {
      if (Math.abs(delta) <= TILT.neutralZoneAbs) {
        State.tiltArmed = true;
        setTiltStatus('Neutral');
      } else {
        setTiltStatus(delta > 0 ? 'Forward…' : 'Backward…');
      }
      return;
    }

    const now = Date.now();
    if (now - State.tiltLastActionAt < TILT.minIntervalMs) return;

    if (delta >= TILT.forwardTriggerDelta) {
      State.tiltArmed = false;
      State.tiltLastActionAt = now;
      setTiltStatus('Got it');
      advance('got');
      return;
    }

    if (delta <= TILT.backwardTriggerDelta) {
      State.tiltArmed = false;
      State.tiltLastActionAt = now;
      setTiltStatus('Pass');
      advance('pass');
      return;
    }

    if (Math.abs(delta) <= TILT.neutralZoneAbs) setTiltStatus('Neutral');
    else setTiltStatus(delta > 0 ? 'Forward' : 'Backward');
  }

  motionPermBtn.addEventListener('click', async () => {
    const ok = await requestMotionPermission();
    if (!ok) {
      alert('Motion permission was not granted. Tilt controls will stay off unless enabled in iOS settings for this site.');
      State.tiltEnabled = false;
      tiltEnabledInput.checked = false;
      saveSettings({ tiltEnabled: false });
      motionPermBtn.hidden = true;
      return;
    }

    motionPermBtn.hidden = true;
    if (State.mode === 'running') {
      maybeEnableTiltDuringGame();
    } else {
      setTiltStatus('Ready');
    }
  });

  // -----------------------------
  // Setup option syncing
  // -----------------------------
  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function syncOptionsFromUI() {
    const timer = Number(timerSecondsInput.value);
    State.timerSeconds = Number.isFinite(timer) ? clamp(timer, 10, 600) : 60;
    timerSecondsInput.value = String(State.timerSeconds);

    State.shuffleOnStart = !!shuffleOnStartInput.checked;
    State.loopWhenFinished = !!loopWhenFinishedInput.checked;
    State.vibrateOnAction = !!vibrateOnActionInput.checked;
    State.tiltEnabled = !!tiltEnabledInput.checked;
  }

  function applySettingsToUI(settings) {
    if (!settings) return;
    if (typeof settings.phrasesText === 'string') phrasesInput.value = settings.phrasesText;
    if (typeof settings.timerSeconds === 'number') timerSecondsInput.value = String(settings.timerSeconds);
    if (typeof settings.shuffleOnStart === 'boolean') shuffleOnStartInput.checked = settings.shuffleOnStart;
    if (typeof settings.loopWhenFinished === 'boolean') loopWhenFinishedInput.checked = settings.loopWhenFinished;
    if (typeof settings.vibrateOnAction === 'boolean') vibrateOnActionInput.checked = settings.vibrateOnAction;
    if (typeof settings.tiltEnabled === 'boolean') tiltEnabledInput.checked = settings.tiltEnabled;
  }

  // Setup listeners
  phrasesInput.addEventListener('input', () => {
    updatePhraseCountMeta();
    saveSettings({ phrasesText: phrasesInput.value });
  });

  timerSecondsInput.addEventListener('change', () => {
    syncOptionsFromUI();
    saveSettings({ timerSeconds: State.timerSeconds });
    updatePhraseCountMeta();
  });

  shuffleOnStartInput.addEventListener('change', () => {
    syncOptionsFromUI();
    saveSettings({ shuffleOnStart: State.shuffleOnStart });
  });

  loopWhenFinishedInput.addEventListener('change', () => {
    syncOptionsFromUI();
    saveSettings({ loopWhenFinished: State.loopWhenFinished });
  });

  vibrateOnActionInput.addEventListener('change', () => {
    syncOptionsFromUI();
    saveSettings({ vibrateOnAction: State.vibrateOnAction });
  });

  tiltEnabledInput.addEventListener('change', () => {
    syncOptionsFromUI();
    saveSettings({ tiltEnabled: State.tiltEnabled });

    if (State.tiltEnabled && isIOSNeedsMotionPermission() && !State.tiltPermissionGranted) {
      motionPermBtn.hidden = false;
    } else {
      motionPermBtn.hidden = true;
    }
  });

  startBtn.addEventListener('click', () => {
    syncOptionsFromUI();
    if (State.tiltEnabled && isIOSNeedsMotionPermission() && !State.tiltPermissionGranted) {
      motionPermBtn.hidden = false; // tilt activates after grant
    }
    startRound();
  });

  clearBtn.addEventListener('click', () => {
    phrasesInput.value = '';
    saveSettings({ phrasesText: '' });
    updatePhraseCountMeta();
  });

  useSampleBtn.addEventListener('click', () => {
    const sample = [
      '# Sample family-friendly list (supports "phrase :: background")',
      'Popcorn :: Snack you eat at the movies',
      'A sneaky cat :: Quiet little troublemaker',
      'Snow day :: No school, lots of fun',
      'Dance party :: Music + silly moves',
      'The moon :: Bright thing in the night sky',
      'Pizza night :: Cheesy dinner everyone loves',
      'A superhero :: Saves the day with powers',
      'Hide and seek :: One person counts, others hide',
      'A dinosaur :: Big ancient reptile',
      'Spaghetti :: Long noodles with sauce',
      'A sleepy dragon :: Big mythical creature who needs a nap',
      'Banana peel :: Slippery yellow skin',
      'Camping trip :: Sleeping outside in a tent',
      'Magic wand :: Used to cast spells',
      'Rainbow :: Colorful arc after rain',
      'A giant sandwich :: Too big to bite'
    ].join('\n');
    phrasesInput.value = sample;
    saveSettings({ phrasesText: sample });
    updatePhraseCountMeta();
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      phrasesInput.value = text;
      saveSettings({ phrasesText: text });
      updatePhraseCountMeta();
    } catch {
      alert('Could not read that file. Try a plain .txt file.');
    } finally {
      fileInput.value = '';
    }
  });

  playAgainBtn.addEventListener('click', () => {
    // Force reshuffle for play again (without permanently changing preference)
    const prevShuffle = State.shuffleOnStart;
    State.shuffleOnStart = true;
    shuffleOnStartInput.checked = true;

    startRound();

    State.shuffleOnStart = prevShuffle;
    shuffleOnStartInput.checked = prevShuffle;
    saveSettings({ shuffleOnStart: prevShuffle });
  });

  editListBtn.addEventListener('click', () => {
    stopTimer();
    releaseWakeLock();
    disableTiltListener();
    setScreen('setup');
    updatePhraseCountMeta();
  });

  // Clean up if navigating away
  window.addEventListener('pagehide', () => {
    stopTimer();
    releaseWakeLock();
    disableTiltListener();
  });

  // -----------------------------
  // Service worker registration (offline caching)
  // -----------------------------
  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    try {
      // Works on GitHub Pages (HTTPS). Scope defaults to the folder this file is served from.
      const reg = await navigator.serviceWorker.register('./sw.js');

      // If a new SW is waiting, activate it ASAP (no UI prompt here).
      // User will get the new version on next load.
      if (reg.waiting) {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      }

      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            // New version installed (will control on next navigation)
            // Keep silent/minimal. If you want a toast, add it here.
          }
        });
      });
    } catch {
      // ignore (still runs fine without SW)
    }
  }

  // -----------------------------
  // Boot
  // -----------------------------
  function init() {
    const settings = loadSettings();
    applySettingsToUI(settings);
    syncOptionsFromUI();
    updatePhraseCountMeta();
    setScreen('setup');

    if (State.tiltEnabled && isIOSNeedsMotionPermission() && !State.tiltPermissionGranted) {
      motionPermBtn.hidden = false;
    } else {
      motionPermBtn.hidden = true;
    }

    registerServiceWorker();
  }

  init();
})();