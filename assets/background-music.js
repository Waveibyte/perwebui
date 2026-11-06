(() => {
  "use strict";

  const audio = document.getElementById("background-music");
  const button = document.getElementById("music");
  if (!audio || !button) return;

  const baseVolume = 0.24;
  const fadeDuration = 320;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let intendedPlaying = true;
  let playbackAttempt = 0;
  let fadeFrame = 0;
  let gestureHandler = null;
  let resumeAfterVisibility = false;

  const renderState = (state) => {
    const states = {
      loading: { text: "♪ 音乐加载中", label: "背景音乐正在加载", pressed: false },
      playing: { text: "♪ 暂停音乐", label: "暂停背景音乐", pressed: true },
      paused: { text: "♪ 播放音乐", label: "播放背景音乐", pressed: false },
      unavailable: { text: "音乐不可用", label: "背景音乐加载失败", pressed: false }
    };
    const next = states[state] || states.paused;
    button.dataset.state = state;
    button.textContent = next.text;
    button.setAttribute("aria-label", next.label);
    button.setAttribute("aria-pressed", String(next.pressed));
    button.setAttribute("aria-busy", String(state === "loading"));
  };

  const fadeTo = (targetVolume, done) => {
    cancelAnimationFrame(fadeFrame);
    const startVolume = Number.isFinite(audio.volume) ? audio.volume : 0;
    const startTime = performance.now();

    if (reducedMotion.matches) {
      audio.volume = targetVolume;
      done?.();
      return;
    }

    const step = (now) => {
      const progress = Math.min((now - startTime) / fadeDuration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      audio.volume = startVolume + (targetVolume - startVolume) * eased;
      if (progress < 1) {
        fadeFrame = requestAnimationFrame(step);
      } else {
        done?.();
      }
    };

    fadeFrame = requestAnimationFrame(step);
  };

  const removeGestureFallback = () => {
    if (!gestureHandler) return;
    document.removeEventListener("click", gestureHandler);
    document.removeEventListener("keydown", gestureHandler);
    document.removeEventListener("touchend", gestureHandler);
    gestureHandler = null;
  };

  const armGestureFallback = () => {
    if (gestureHandler) return;
    gestureHandler = (event) => {
      if (event.type === "keydown" && ["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
      if (event.target instanceof Element && event.target.closest("#music")) return;
      removeGestureFallback();
      void playMusic();
    };
    document.addEventListener("click", gestureHandler);
    document.addEventListener("keydown", gestureHandler);
    document.addEventListener("touchend", gestureHandler);
  };

  const playMusic = async () => {
    if (!intendedPlaying) return;
    const attempt = ++playbackAttempt;
    renderState("loading");

    try {
      audio.volume = 0;
      await audio.play();
      if (attempt !== playbackAttempt || !intendedPlaying) {
        audio.pause();
        return;
      }
      removeGestureFallback();
      fadeTo(baseVolume);
      renderState("playing");
    } catch (error) {
      if (attempt !== playbackAttempt || !intendedPlaying) return;
      if (error?.name === "NotAllowedError") {
        renderState("paused");
        armGestureFallback();
        return;
      }
      if (error?.name === "AbortError") return;
      renderState("unavailable");
    }
  };

  const pauseMusic = () => {
    intendedPlaying = false;
    resumeAfterVisibility = false;
    playbackAttempt += 1;
    removeGestureFallback();
    renderState("paused");
    fadeTo(0, () => {
      if (!intendedPlaying) audio.pause();
    });
  };

  button.addEventListener("click", () => {
    if (!audio.paused && button.dataset.state === "playing") {
      pauseMusic();
      return;
    }
    if (intendedPlaying && button.dataset.state === "loading") {
      pauseMusic();
      return;
    }
    intendedPlaying = true;
    void playMusic();
  });

  audio.addEventListener("error", () => {
    playbackAttempt += 1;
    removeGestureFallback();
    renderState("unavailable");
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (intendedPlaying && !audio.paused) {
        resumeAfterVisibility = true;
        audio.pause();
        renderState("paused");
      }
      return;
    }
    if (resumeAfterVisibility) {
      resumeAfterVisibility = false;
      void playMusic();
    }
  });

  audio.volume = 0;
  void playMusic();
})();
