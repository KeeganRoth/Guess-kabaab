// movement.js
// Handles: swipe, tap, tilt (DeviceOrientationEvent) + tilt permission button.
// Expects you to pass in State + callbacks it should call (advance/endRound/etc).

export function createMovementController({
  State,
  elements,
  advance,
  endRound,
  saveSettings,
}) {
  const {
    gameStage,
    tapLeft,
    tapRight,
    nextBtn,
    endBtn,
    tiltStatus,
    motionPermBtn,
    tiltEnabledInput,
  } = elements;

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

  function attachSwipe() {
    gameStage.addEventListener(
      'touchstart',
      (e) => {
        if (!e.touches || e.touches.length !== 1) return;
        const t = e.touches[0];
        swipeStart(t.clientX, t.clientY);
      },
      { passive: true }
    );

    gameStage.addEventListener(
      'touchend',
      (e) => {
        const t = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0] : null;
        if (!t) return;
        swipeEnd(t.clientX, t.clientY);
      },
      { passive: true }
    );

    gameStage.addEventListener('pointerdown', (e) => swipeStart(e.clientX, e.clientY));
    gameStage.addEventListener('pointerup', (e) => swipeEnd(e.clientX, e.clientY));

    // Prevent scroll during game
    document.addEventListener(
      'touchmove',
      (e) => {
        if (State.mode === 'running') e.preventDefault();
      },
      { passive: false }
    );

    // Prevent double-tap zoom (best effort)
    let lastTouchEnd = 0;
    document.addEventListener(
      'touchend',
      (e) => {
        if (State.mode !== 'running') return;
        const now = Date.now();
        if (now - lastTouchEnd <= 300) e.preventDefault();
        lastTouchEnd = now;
      },
      { passive: false }
    );
  }

  // -----------------------------
  // Tap fallback
  // -----------------------------
  function attachTap() {
    tapLeft.addEventListener('click', () => advance('pass'));
    tapRight.addEventListener('click', () => advance('got'));
    nextBtn.addEventListener('click', () => advance('next'));
    endBtn.addEventListener('click', () => endRound('Ended early'));
  }

  // -----------------------------
  // Tilt controls (DeviceOrientationEvent)
  // -----------------------------
  const TILT = {
    forwardTriggerDelta: 18,    // forward/down => GOT IT
    backwardTriggerDelta: -18,  // backward/up => PASS
    neutralZoneAbs: 10,         // return within this to re-arm
    minIntervalMs: 700,         // debounce
    baselineSmoothing: 0.12     // baseline adjustment near neutral
  };

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

  function attachTiltPermissionButton() {
    motionPermBtn.addEventListener('click', async () => {
      const ok = await requestMotionPermission();
      if (!ok) {
        alert(
          'Motion permission was not granted. Tilt controls will stay off unless enabled in iOS settings for this site.'
        );
        State.tiltEnabled = false;
        tiltEnabledInput.checked = false;
        saveSettings?.({ tiltEnabled: false });
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
  }

  // Expose small lifecycle helpers for app.js
  function onGameScreenEntered() {
    // keep status in sync when game starts
    if (tiltStatus) {
      tiltStatus.textContent = tiltStatusText(State.tiltEnabled ? 'Ready' : 'Off');
    }
  }

  function onRoundStartResetTiltState() {
    State.tiltLastActionAt = 0;
    State.tiltArmed = true;
    State.tiltHasBaseline = false;
  }

  // Wire everything once
  function initMovement() {
    attachSwipe();
    attachTap();
    attachTiltPermissionButton();
  }

  return {
    initMovement,
    maybeEnableTiltDuringGame,
    disableTiltListener,
    isIOSNeedsMotionPermission,
    onGameScreenEntered,
    onRoundStartResetTiltState,
    setTiltStatus,
  };
}