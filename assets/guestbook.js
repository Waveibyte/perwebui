(() => {
  const config = window.WAVE_GUESTBOOK;
  const openButton = document.querySelector("[data-guestbook-open]");
  const dialog = document.getElementById("guestbook-dialog");
  const detailDialog = document.getElementById("guestbook-detail");
  const form = document.getElementById("guestbook-form");
  const nicknameInput = document.getElementById("guestbook-nickname");
  const messageInput = document.getElementById("guestbook-message");
  const messageCount = document.getElementById("guestbook-count");
  const submitButton = document.getElementById("guestbook-submit");
  const status = document.getElementById("guestbook-status");
  const closeButton = document.getElementById("guestbook-close");
  const detailClose = document.getElementById("guestbook-detail-close");
  const detailBody = document.getElementById("guestbook-detail-body");
  const danmakuZone = document.getElementById("danmaku-zone");
  const danmakuState = document.getElementById("danmaku-state");
  const readableList = document.getElementById("guestbook-readable-list");
  const toast = document.getElementById("guestbook-toast");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  if (!config || !window.supabase || !openButton || !dialog || !form || !danmakuZone) {
    if (danmakuState) danmakuState.textContent = "留言板正在配置中";
    return;
  }

  const client = window.supabase.createClient(config.supabaseUrl, config.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

  const state = {
    session: null,
    messages: [],
    laneCount: 5,
    activeLanes: new Map(),
    queueCursor: 0,
    spawning: false,
    cooldownTimer: 0,
  };

  const byId = (id) => state.messages.find((item) => item.id === id);
  const countCharacters = (value) => [...value].length;
  const locationLabel = (item) => {
    const country = item.country_name || "未知国家";
    const region = item.region_name || "未知地区";
    if (country === region || region === "未知地区") return `来自 ${country}`;
    return `来自 ${country} · ${region}`;
  };
  const formatTime = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "时间未知";
    return new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  };
  const setStatus = (text, kind = "") => {
    status.textContent = text;
    status.dataset.kind = kind;
  };
  const showToast = (text) => {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
      toast.hidden = true;
    }, 2800);
  };

  const updateMessageCount = () => {
    const length = countCharacters(messageInput.value);
    messageCount.textContent = `${length} / 80`;
    messageCount.dataset.limit = length >= 80 ? "true" : "false";
  };

  const getLaneCount = () => (matchMedia("(max-width: 800px)").matches ? 3 : 5);

  const renderReadableList = () => {
    readableList.replaceChildren();
    for (const item of state.messages.slice(0, config.maxMessages)) {
      const row = document.createElement("li");
      row.textContent = `${item.nickname}，${locationLabel(item)}，${formatTime(item.created_at)}：${item.message}`;
      readableList.append(row);
    }
  };

  const syncEmptyState = () => {
    const isEmpty = state.messages.length === 0;
    danmakuState.hidden = !isEmpty;
    danmakuState.textContent = isEmpty ? "还没有留言，写下星球上的第一句话吧" : "";
  };

  const openDetail = (item) => {
    detailBody.replaceChildren();
    const heading = document.createElement("h3");
    heading.textContent = item.nickname;
    const location = document.createElement("p");
    location.className = "guestbook-detail-meta";
    location.textContent = `${locationLabel(item)} · ${formatTime(item.created_at)}`;
    const body = document.createElement("p");
    body.className = "guestbook-detail-message";
    body.textContent = item.message;
    detailBody.append(heading, location, body);
    if (typeof detailDialog.showModal === "function") detailDialog.showModal();
  };

  const createDanmaku = (item, lane, duration) => {
    const bubble = document.createElement("button");
    bubble.type = "button";
    bubble.className = "danmaku-item";
    bubble.style.setProperty("--lane", lane);
    bubble.style.setProperty("--duration", `${duration}s`);
    bubble.dataset.messageId = item.id;
    bubble.setAttribute("aria-hidden", "true");
    bubble.tabIndex = -1;

    const name = document.createElement("strong");
    name.textContent = item.nickname;
    const copy = document.createElement("span");
    copy.textContent = item.message;
    const place = document.createElement("small");
    place.textContent = locationLabel(item);
    bubble.append(name, copy, place);

    bubble.addEventListener("click", () => {
      bubble.style.animationPlayState = "paused";
      openDetail(item);
    });
    bubble.addEventListener("animationend", () => {
      state.activeLanes.delete(lane);
      bubble.remove();
      window.setTimeout(spawnNext, 500);
    });
    return bubble;
  };

  const renderStaticMessages = () => {
    danmakuZone.replaceChildren();
    const placeholder = document.createElement("p");
    placeholder.className = "danmaku-empty";
    placeholder.textContent = state.messages.length
      ? "留言已静止显示，点击可阅读全文"
      : "还没有留言，写下星球上的第一句话吧";
    danmakuZone.append(placeholder);

    for (const item of state.messages.slice(0, 5)) {
      const bubble = createDanmaku(item, 0, 0);
      bubble.classList.add("danmaku-static");
      bubble.removeAttribute("aria-hidden");
      bubble.tabIndex = 0;
      danmakuZone.append(bubble);
    }
  };

  function spawnNext() {
    if (reducedMotion.matches || document.body.classList.contains("motion-paused")) return;
    state.laneCount = getLaneCount();
    let lane = -1;
    for (let index = 0; index < state.laneCount; index += 1) {
      if (!state.activeLanes.has(index)) {
        lane = index;
        break;
      }
    }
    if (lane === -1 || state.messages.length === 0) return;

    const total = state.messages.length;
    const activeIds = new Set(
      [...state.activeLanes.values()].map((bubble) => bubble.dataset.messageId),
    );
    let item;
    for (let attempt = 0; attempt < total; attempt += 1) {
      const candidate = state.messages[state.queueCursor % total];
      state.queueCursor += 1;
      if (candidate && !activeIds.has(candidate.id)) {
        item = candidate;
        break;
      }
    }
    if (!item) return;

    const bubble = createDanmaku(item, lane, 20 + (lane * 2) + (state.queueCursor % 4));
    state.activeLanes.set(lane, bubble);
    danmakuZone.append(bubble);
  }

  const fillLanes = () => {
    state.activeLanes.forEach((bubble) => bubble.remove());
    state.activeLanes.clear();
    danmakuZone.querySelectorAll(".danmaku-item").forEach((bubble) => bubble.remove());
    if (reducedMotion.matches) {
      danmakuState.hidden = true;
      danmakuZone.replaceChildren();
      renderStaticMessages();
      return;
    }
    syncEmptyState();
    for (let index = state.activeLanes.size; index < getLaneCount(); index += 1) {
      window.setTimeout(spawnNext, index * 260);
    }
  };

  const sortMessages = () => {
    state.messages.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  };

  const addMessage = (row, { prioritize = false } = {}) => {
    if (!row?.id || !row?.message) return;
    const existing = byId(row.id);
    if (existing) state.messages[state.messages.indexOf(existing)] = row;
    else state.messages.unshift(row);
    sortMessages();
    if (state.messages.length > config.maxMessages) state.messages.length = config.maxMessages;
    renderReadableList();
    if (reducedMotion.matches) {
      renderStaticMessages();
      return;
    }
    syncEmptyState();
    if (!prioritize || document.body.classList.contains("motion-paused")) return;

    let lane = -1;
    for (let index = 0; index < getLaneCount(); index += 1) {
      if (!state.activeLanes.has(index)) {
        lane = index;
        break;
      }
    }
    if (lane === -1) {
      const oldest = state.activeLanes.entries().next().value;
      if (oldest) {
        const [oldLane, bubble] = oldest;
        bubble.remove();
        state.activeLanes.delete(oldLane);
        lane = oldLane;
      }
    }
    if (lane !== -1) {
      const bubble = createDanmaku(row, lane, 18);
      state.activeLanes.set(lane, bubble);
      danmakuZone.append(bubble);
    }
  };

  const removeMessage = (id) => {
    state.messages = state.messages.filter((item) => item.id !== id);
    for (const [lane, bubble] of state.activeLanes.entries()) {
      if (bubble.dataset.messageId === id) {
        bubble.remove();
        state.activeLanes.delete(lane);
      }
    }
    renderReadableList();
    syncEmptyState();
    if (reducedMotion.matches) renderStaticMessages();
  };

  const ensureSession = async () => {
    const { data: current } = await client.auth.getSession();
    if (current.session) {
      state.session = current.session;
      return state.session;
    }
    const { data, error } = await client.auth.signInAnonymously();
    if (error) throw error;
    state.session = data.session;
    return data.session;
  };

  const loadMessages = async () => {
    const { data, error } = await client
      .from("guestbook_messages")
      .select("id,nickname,message,country_name,region_name,created_at")
      .order("created_at", { ascending: false })
      .limit(config.maxMessages);
    if (error) throw error;
    state.messages = data ?? [];
    renderReadableList();
    fillLanes();
  };

  const subscribe = () => {
    client
      .channel("guestbook-live")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "guestbook_messages" },
        (event) => addMessage(event.new),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "guestbook_messages" },
        (event) => {
          if (event.new?.is_visible === false) removeMessage(event.new.id);
          else if (event.new?.id) addMessage(event.new);
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "guestbook_messages" },
        (event) => removeMessage(event.old?.id),
      )
      .subscribe();
  };

  const setCooldown = () => {
    const until = Date.now() + 60_000;
    localStorage.setItem("wave-guestbook-cooldown", String(until));
    startCooldown(until);
  };

  function startCooldown(until) {
    clearInterval(state.cooldownTimer);
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      if (remaining > 0) {
        submitButton.disabled = true;
        submitButton.textContent = `请等待 ${remaining} 秒`;
      } else {
        clearInterval(state.cooldownTimer);
        submitButton.disabled = false;
        submitButton.textContent = "让留言起飞";
        localStorage.removeItem("wave-guestbook-cooldown");
      }
    };
    tick();
    state.cooldownTimer = setInterval(tick, 1000);
  }

  const showDialog = async () => {
    bodyPauseForDialog(true);
    setStatus("正在连接 wave 星球…");
    nicknameInput.value = localStorage.getItem("wave-guestbook-nickname") || "";
    updateMessageCount();
    dialog.showModal();
    nicknameInput.focus();
    try {
      await ensureSession();
      setStatus("留言会立即公开，位置只显示国家与省份。", "info");
      const savedUntil = Number(localStorage.getItem("wave-guestbook-cooldown") || 0);
      if (savedUntil > Date.now()) startCooldown(savedUntil);
    } catch (error) {
      setStatus("留言板暂时不可用，请稍后再试或使用邮箱联系。", "error");
      submitButton.disabled = true;
      console.error(error);
    }
  };

  const bodyPauseForDialog = (paused) => {
    document.body.classList.toggle("guestbook-dialog-open", paused);
  };

  openButton.addEventListener("click", showDialog);
  closeButton.addEventListener("click", () => dialog.close());
  detailClose.addEventListener("click", () => detailDialog.close());
  detailDialog.addEventListener("close", () => {
    for (const bubble of danmakuZone.querySelectorAll(".danmaku-item")) {
      bubble.style.removeProperty("animation-play-state");
    }
  });
  dialog.addEventListener("close", () => bodyPauseForDialog(false));
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  detailDialog.addEventListener("click", (event) => {
    if (event.target === detailDialog) detailDialog.close();
  });

  messageInput.addEventListener("input", updateMessageCount);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const nickname = nicknameInput.value.trim();
    const message = messageInput.value.trim();
    const website = form.elements.website.value;

    if (!nickname || countCharacters(nickname) > 20) {
      setStatus("昵称需要 1–20 个字符", "error");
      nicknameInput.focus();
      return;
    }
    if (!message || countCharacters(message) > 80) {
      setStatus("留言需要 1–80 个字符", "error");
      messageInput.focus();
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = "正在发送…";
    setStatus("正在把留言送上轨道…");

    try {
      const session = await ensureSession();
      const response = await fetch(`${config.supabaseUrl}/functions/v1/${config.functionName}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
          apikey: config.publishableKey,
        },
        body: JSON.stringify({ nickname, message, website }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 429 || result.code === "rate_limited") {
          setCooldown();
          throw new Error("留言太快了，请稍后再试");
        }
        throw new Error(result.error || "留言暂未保存，请稍后重试");
      }

      addMessage(result.message, { prioritize: true });
      localStorage.setItem("wave-guestbook-nickname", nickname);
      form.reset();
      updateMessageCount();
      setCooldown();
      setStatus("你的留言已经进入星球轨道。", "success");
      showToast("留言已公开");
      setTimeout(() => {
        if (dialog.open) dialog.close();
      }, 650);
    } catch (error) {
      setStatus(error.message || "留言板暂时无法连接，请稍后重试", "error");
      submitButton.disabled = false;
      submitButton.textContent = "让留言起飞";
    }
  });

  reducedMotion.addEventListener?.("change", () => {
    state.activeLanes.forEach((bubble) => bubble.remove());
    state.activeLanes.clear();
    fillLanes();
  });

  window.addEventListener("resize", () => {
    if (reducedMotion.matches) renderStaticMessages();
  });

  loadMessages()
    .then(async () => {
      await ensureSession();
      subscribe();
    })
    .catch((error) => {
      console.error(error);
      danmakuState.hidden = false;
      danmakuState.textContent = "留言板暂时离线，仍可写信联系";
    });
})();
