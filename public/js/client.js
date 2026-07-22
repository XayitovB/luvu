(() => {
  'use strict';

  const socket = io();

  // ---------- DOM refs ----------
  const viewLanding = document.getElementById('view-landing');
  const viewRoom = document.getElementById('view-room');
  const viewLoading = document.getElementById('view-loading');
  const landingError = document.getElementById('landing-error');

  const formCreate = document.getElementById('form-create');
  const formJoin = document.getElementById('form-join');

  const roomCodeBtn = document.getElementById('room-code-btn');
  const roomCodeValue = document.getElementById('room-code-value');
  const roomLinkBtn = document.getElementById('room-link-btn');
  const linkModal = document.getElementById('link-modal');
  const linkModalInput = document.getElementById('link-modal-input');
  const linkModalCopyBtn = document.getElementById('link-modal-copy');
  const linkModalCloseBtn = document.getElementById('link-modal-close');
  const peerStatusEl = document.getElementById('peer-status');
  const leaveBtn = document.getElementById('leave-btn');

  const playerWrap = document.getElementById('player-wrap');
  const noVideoOverlay = document.getElementById('no-video-overlay');
  const formVideo = document.getElementById('form-video');
  const videoUrlInput = document.getElementById('video-url');
  const videoError = document.getElementById('video-error');
  const changeVideoBtn = document.getElementById('change-video-btn');

  const cameraDock = document.getElementById('camera-dock');
  const localVideo = document.getElementById('local-video');
  const toggleMicBtn = document.getElementById('toggle-mic');
  const toggleCamBtn = document.getElementById('toggle-cam');

  const chatMessages = document.getElementById('chat-messages');
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');

  const toastEl = document.getElementById('toast');

  // ---------- State ----------
  let myName = '';
  let roomCode = null;
  let roomPeopleCount = 1;
  let ytPlayer = null;
  let ytApiReady = false;
  let pendingVideoId = null;
  let applyingRemoteVideoChange = false;
  let lastKnownTime = 0;
  let seekWatcher = null;

  let localStream = null;
  let localMediaPromise = null;
  const peers = new Map(); // peerId -> { pc, tile, video, empty, label }
  let micOn = true;
  let camOn = true;

  function getClientId() {
    let id;
    try {
      id = localStorage.getItem('luvu_client_id');
    } catch (e) {}
    if (!id) {
      id = 'c_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      try { localStorage.setItem('luvu_client_id', id); } catch (e) {}
    }
    return id;
  }
  const myClientId = getClientId();

  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  };

  // ---------- Helpers ----------
  function showToast(msg, ms = 2600) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.add('hidden'), ms);
  }

  function showLandingError(msg) {
    landingError.textContent = msg;
    landingError.classList.remove('hidden');
  }

  function clearLandingError() {
    landingError.classList.add('hidden');
    landingError.textContent = '';
  }

  function switchToRoomView() {
    viewLanding.classList.add('hidden');
    viewRoom.classList.remove('hidden');
  }

  function switchToLandingView() {
    viewRoom.classList.add('hidden');
    viewLanding.classList.remove('hidden');
    formCreate.reset();
    formJoin.reset();
    formJoin.classList.add('hidden');
    document.getElementById('landing-cards').classList.add('single');
  }

  function setPeerStatus(online, label) {
    peerStatusEl.classList.toggle('online', online);
    peerStatusEl.classList.toggle('offline', !online);
    peerStatusEl.textContent = label;
  }

  function addSystemMessage(text) {
    const el = document.createElement('div');
    el.className = 'msg system';
    el.textContent = text;
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  const URL_REGEX = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;

  // Builds message content from plain-text nodes + <a> nodes only (never innerHTML),
  // so pasted URLs become clickable while staying safe from XSS.
  function renderMessageText(container, text) {
    let lastIndex = 0;
    let m;
    URL_REGEX.lastIndex = 0;
    while ((m = URL_REGEX.exec(text)) !== null) {
      if (m.index > lastIndex) {
        container.appendChild(document.createTextNode(text.slice(lastIndex, m.index)));
      }
      const raw = m[0].replace(/[.,!?)>\]]+$/, ''); // trim trailing punctuation
      const href = raw.startsWith('http') ? raw : 'https://' + raw;
      const a = document.createElement('a');
      a.href = href;
      a.textContent = raw;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'chat-link';
      container.appendChild(a);
      lastIndex = m.index + raw.length;
      if (lastIndex > text.length) lastIndex = text.length;
    }
    if (lastIndex < text.length) {
      container.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  function addChatMessage({ id, name, text, ts }) {
    const mine = id === socket.id;
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (mine ? 'mine' : 'theirs');

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    renderMessageText(bubble, text); // builds text nodes + <a> only -> safe from XSS

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const time = new Date(ts || Date.now());
    const hh = String(time.getHours()).padStart(2, '0');
    const mm = String(time.getMinutes()).padStart(2, '0');
    meta.textContent = `${mine ? 'Siz' : name} • ${hh}:${mm}`;

    wrap.appendChild(bubble);
    wrap.appendChild(meta);
    chatMessages.appendChild(wrap);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function extractYouTubeId(raw) {
    if (!raw) return null;
    const input = raw.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
    try {
      const url = new URL(input);
      const host = url.hostname.replace(/^www\./, '');
      if (host === 'youtu.be') {
        const id = url.pathname.slice(1, 12);
        return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
      }
      if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
        if (url.pathname === '/watch') {
          const id = url.searchParams.get('v');
          return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
        }
        if (url.pathname.startsWith('/embed/')) {
          const id = url.pathname.split('/embed/')[1]?.slice(0, 11);
          return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
        }
        if (url.pathname.startsWith('/shorts/')) {
          const id = url.pathname.split('/shorts/')[1]?.slice(0, 11);
          return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
        }
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  // ---------- YouTube player ----------
  window.onYouTubeIframeAPIReady = function () {
    ytApiReady = true;
    if (pendingVideoId) {
      createOrLoadPlayer(pendingVideoId);
      pendingVideoId = null;
    }
  };

  function createOrLoadPlayer(videoId, startSeconds) {
    if (!ytApiReady) {
      pendingVideoId = videoId;
      return;
    }
    if (ytPlayer) {
      applyingRemoteVideoChange = true;
      ytPlayer.loadVideoById({ videoId, startSeconds: startSeconds || 0 });
      setTimeout(() => (applyingRemoteVideoChange = false), 800);
      return;
    }
    ytPlayer = new YT.Player('yt-player', {
      videoId,
      playerVars: { rel: 0, playsinline: 1, start: Math.floor(startSeconds || 0) },
      events: {
        onReady: () => startSeekWatcher(),
        onStateChange: onPlayerStateChange,
      },
    });
  }

  function onPlayerStateChange(e) {
    if (applyingRemoteVideoChange || !roomCode) return;
    if (typeof YT === 'undefined') return;
    const t = ytPlayer.getCurrentTime();
    if (e.data === YT.PlayerState.PLAYING) {
      lastKnownTime = t;
      socket.emit('video-sync', { type: 'play', currentTime: t });
    } else if (e.data === YT.PlayerState.PAUSED) {
      lastKnownTime = t;
      socket.emit('video-sync', { type: 'pause', currentTime: t });
    }
  }

  function startSeekWatcher() {
    if (seekWatcher) clearInterval(seekWatcher);
    seekWatcher = setInterval(() => {
      if (!ytPlayer || applyingRemoteVideoChange || typeof YT === 'undefined') return;
      if (typeof ytPlayer.getPlayerState !== 'function') return;
      if (ytPlayer.getPlayerState() !== YT.PlayerState.PLAYING) return;
      const t = ytPlayer.getCurrentTime();
      const expected = lastKnownTime + 1;
      if (Math.abs(t - expected) > 1.5) {
        socket.emit('video-sync', { type: 'seek', currentTime: t });
      }
      lastKnownTime = t;
    }, 1000);
  }

  function applyRemoteVideoSync({ type, currentTime }) {
    if (!ytPlayer) return;
    applyingRemoteVideoChange = true;
    if (type === 'play') {
      ytPlayer.seekTo(currentTime, true);
      ytPlayer.playVideo();
    } else if (type === 'pause') {
      ytPlayer.seekTo(currentTime, true);
      ytPlayer.pauseVideo();
    } else if (type === 'seek') {
      ytPlayer.seekTo(currentTime, true);
    }
    lastKnownTime = currentTime;
    setTimeout(() => (applyingRemoteVideoChange = false), 700);
  }

  // ---------- WebRTC (mesh camera call: one RTCPeerConnection per remote person) ----------
  // Modest capture resolution: keeps the initial bitrate/CPU load low on a slow
  // connection instead of asking for (then having to downscale from) full HD.
  const VIDEO_CONSTRAINTS = {
    width: { ideal: 640, max: 1280 },
    height: { ideal: 480, max: 720 },
    frameRate: { ideal: 24, max: 30 },
  };
  const MAX_VIDEO_BITRATE = 800_000; // ~800kbps ceiling, plenty for the resolution above

  function ensureLocalMedia() {
    if (!localMediaPromise) {
      localMediaPromise = navigator.mediaDevices
        .getUserMedia({
          video: VIDEO_CONSTRAINTS,
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        })
        .then((stream) => {
          localStream = stream;
          localVideo.srcObject = stream;
          return stream;
        })
        .catch((err) => {
          showToast('Kamera yoki mikrofonga ruxsat berilmadi.');
          throw err;
        });
    }
    return localMediaPromise;
  }

  function createRemoteTile(peerId, name) {
    const tile = document.createElement('div');
    tile.className = 'cam-tile';
    tile.dataset.peerId = peerId;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;

    const empty = document.createElement('div');
    empty.className = 'cam-empty';
    empty.textContent = 'Ulanmoqda…';

    const label = document.createElement('span');
    label.className = 'cam-label';
    label.textContent = name || 'Mehmon';

    tile.appendChild(video);
    tile.appendChild(empty);
    tile.appendChild(label);
    cameraDock.appendChild(tile);

    return { tile, video, empty, label };
  }

  // Cap the outgoing video bitrate and prefer dropping resolution (not framerate)
  // when bandwidth gets tight, so a slow connection stays smooth instead of choppy.
  function applyLowBandwidthVideoParams(sender) {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].maxBitrate = MAX_VIDEO_BITRATE;
    params.degradationPreference = 'maintain-framerate';
    sender.setParameters(params).catch(() => {});
  }

  function getOrCreatePeer(peerId, name) {
    let entry = peers.get(peerId);
    if (entry) {
      if (name) entry.label.textContent = name;
      return entry;
    }

    const { tile, video, empty, label } = createRemoteTile(peerId, name);
    const pc = new RTCPeerConnection(RTC_CONFIG);

    if (localStream) {
      localStream.getTracks().forEach((track) => {
        const sender = pc.addTrack(track, localStream);
        if (track.kind === 'video') applyLowBandwidthVideoParams(sender);
      });
    }

    pc.ontrack = (event) => {
      video.srcObject = event.streams[0];
      empty.classList.add('hidden');
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc-signal', { to: peerId, signal: { type: 'ice', candidate: event.candidate } });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        empty.classList.remove('hidden');
      }
    };

    entry = { pc, tile, video, empty, label };
    peers.set(peerId, entry);
    return entry;
  }

  async function offerTo(peerId, name) {
    await ensureLocalMedia().catch(() => {});
    const entry = getOrCreatePeer(peerId, name);
    const offer = await entry.pc.createOffer();
    await entry.pc.setLocalDescription(offer);
    socket.emit('webrtc-signal', { to: peerId, signal: { type: 'offer', sdp: entry.pc.localDescription } });
  }

  async function handleWebrtcSignal({ from, signal }) {
    if (!signal || !from) return;
    if (signal.type === 'offer') await ensureLocalMedia().catch(() => {});
    const entry = getOrCreatePeer(from);
    try {
      if (signal.type === 'offer') {
        await entry.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);
        socket.emit('webrtc-signal', { to: from, signal: { type: 'answer', sdp: entry.pc.localDescription } });
      } else if (signal.type === 'answer') {
        await entry.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      } else if (signal.type === 'ice') {
        await entry.pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      }
    } catch (err) {
      // ignore transient negotiation races between peers
    }
  }

  function removePeer(peerId) {
    const entry = peers.get(peerId);
    if (!entry) return;
    entry.pc.close();
    entry.tile.remove();
    peers.delete(peerId);
  }

  function teardownAllPeers() {
    Array.from(peers.keys()).forEach(removePeer);
  }

  function updatePeopleStatus() {
    if (roomPeopleCount <= 1) {
      setPeerStatus(false, 'Boshqa hech kim yo‘q — havolani ulashing');
    } else {
      setPeerStatus(true, `${roomPeopleCount} kishi xonada 💚`);
    }
  }

  toggleMicBtn.addEventListener('click', () => {
    if (!localStream) return;
    micOn = !micOn;
    localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
    toggleMicBtn.classList.toggle('off', !micOn);
    toggleMicBtn.textContent = micOn ? '🎤' : '🔇';
  });

  toggleCamBtn.addEventListener('click', () => {
    if (!localStream) return;
    camOn = !camOn;
    localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
    toggleCamBtn.classList.toggle('off', !camOn);
    toggleCamBtn.textContent = camOn ? '📷' : '🚫';
  });

  // ---------- Session persistence (survive an F5 refresh) ----------
  const SESSION_KEY = 'luvu_session';

  function saveSession(code, name) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ code, name })); } catch (e) {}
  }
  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  }
  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  // ---------- Room entry ----------
  formCreate.addEventListener('submit', (e) => {
    e.preventDefault();
    clearLandingError();
    myName = document.getElementById('create-name').value.trim() || 'Mehmon';
    socket.emit('create-room', { name: myName, clientId: myClientId }, (res) => {
      if (!res.ok) {
        showLandingError(res.error || 'Xona yaratib bo‘lmadi.');
        return;
      }
      saveSession(res.code, myName);
      enterRoom(res.code, res.people, res.video, res.messages);
    });
  });

  formJoin.addEventListener('submit', (e) => {
    e.preventDefault();
    clearLandingError();
    myName = document.getElementById('join-name').value.trim() || 'Mehmon';
    const code = document.getElementById('join-code').value.trim().toUpperCase();
    socket.emit('join-room', { name: myName, code, clientId: myClientId }, (res) => {
      if (!res.ok) {
        showLandingError(res.error || 'Qo‘shilib bo‘lmadi.');
        return;
      }
      saveSession(res.code, myName);
      enterRoom(res.code, res.people, res.video, res.messages);
    });
  });

  async function enterRoom(code, people, video, messages) {
    roomCode = code;
    roomCodeValue.textContent = code;
    switchToRoomView();
    viewLoading.classList.add('hidden');
    await ensureLocalMedia().catch(() => {});

    chatMessages.innerHTML = '';
    (messages || []).forEach(addChatMessage);

    roomPeopleCount = (people && people.length) || 1;
    updatePeopleStatus();

    if (video && video.url) {
      noVideoOverlay.classList.add('hidden');
      changeVideoBtn.classList.remove('hidden');
      createOrLoadPlayer(video.url, video.currentTime || 0);
    }
  }

  // Auto-rejoin after a page refresh, or prefill the join form from an invite link.
  function bootstrap() {
    const session = loadSession();
    if (session && session.code) {
      viewLanding.classList.add('hidden');
      viewLoading.classList.remove('hidden');
      myName = session.name || 'Mehmon';
      socket.emit('join-room', { name: myName, code: session.code, clientId: myClientId }, (res) => {
        if (!res.ok) {
          clearSession();
          viewLoading.classList.add('hidden');
          viewLanding.classList.remove('hidden');
          showLandingError('Avvalgi xonangiz tugagan — yangi xona oching yoki qo‘shiling.');
          prefillJoinFromUrl();
          return;
        }
        enterRoom(res.code, res.people, res.video, res.messages);
        showToast('Xonangizga qaytdingiz 💕');
      });
      return;
    }
    prefillJoinFromUrl();
  }

  function legacyCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const success = document.execCommand('copy');
      document.body.removeChild(ta);
      return success;
    } catch (e) {
      return false;
    }
  }

  function copyToClipboard(text, doneMsg) {
    const ok = () => showToast(doneMsg);
    const fail = () => showToast('Nusxalab bo‘lmadi. Bu yerdan qo‘lda nusxalang: ' + text, 6000);

    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok).catch(() => (legacyCopy(text) ? ok() : fail()));
    } else {
      legacyCopy(text) ? ok() : fail();
    }
  }

  roomCodeBtn.addEventListener('click', () => {
    if (!roomCode) return;
    copyToClipboard(roomCode, 'Xona kodi nusxalandi ✨');
  });

  function showLinkModal(link) {
    linkModalInput.value = link;
    linkModal.classList.remove('hidden');
    linkModalInput.focus();
    linkModalInput.select();
  }

  function hideLinkModal() {
    linkModal.classList.add('hidden');
  }

  // Always show the link itself (not just a silent clipboard write) so joining
  // still works even if the browser blocks/ignores clipboard access entirely.
  roomLinkBtn.addEventListener('click', () => {
    const link = `${location.origin}/?room=${roomCode || ''}`;
    showLinkModal(link);
    copyToClipboard(link, 'Taklif havolasi nusxalandi 💌 — endi qizingizga yuboring');
  });

  linkModalCopyBtn.addEventListener('click', () => {
    linkModalInput.select();
    copyToClipboard(linkModalInput.value, 'Nusxalandi ✨');
  });

  linkModalCloseBtn.addEventListener('click', hideLinkModal);
  linkModal.addEventListener('click', (e) => {
    if (e.target === linkModal) hideLinkModal();
  });

  // Joining is only possible via an invite link (?room=CODE) — there's no
  // manual code entry, so the join card stays hidden until a link supplies one.
  function prefillJoinFromUrl() {
    const params = new URLSearchParams(location.search);
    const code = params.get('room');
    if (!code) return;
    document.getElementById('join-code').value = code.trim().toUpperCase();
    document.getElementById('form-join').classList.remove('hidden');
    document.getElementById('landing-cards').classList.remove('single');
    document.getElementById('join-name').focus();
    showToast('Taklif havolasi orqali keldingiz — ismingizni kiriting 💕');
    history.replaceState({}, '', location.pathname);
  }
  bootstrap();

  leaveBtn.addEventListener('click', () => leaveRoom());

  function leaveRoom() {
    socket.emit('leave-room');
    clearSession();
    teardownAllPeers();
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    localMediaPromise = null;
    if (seekWatcher) clearInterval(seekWatcher);
    ytPlayer = null;
    roomCode = null;
    roomPeopleCount = 1;
    chatMessages.innerHTML = '';
    noVideoOverlay.classList.remove('hidden');
    changeVideoBtn.classList.add('hidden');
    document.getElementById('yt-player').innerHTML = '';
    switchToLandingView();
  }

  window.addEventListener('beforeunload', () => {
    if (roomCode) socket.emit('leave-room');
  });

  // ---------- Video load form ----------
  formVideo.addEventListener('submit', (e) => {
    e.preventDefault();
    videoError.classList.add('hidden');
    const id = extractYouTubeId(videoUrlInput.value);
    if (!id) {
      videoError.textContent = 'Havola noto‘g‘ri ko‘rinadi. YouTube havolasini tekshiring.';
      videoError.classList.remove('hidden');
      return;
    }
    socket.emit('video-load', { videoId: id });
    createOrLoadPlayer(id);
    noVideoOverlay.classList.add('hidden');
    changeVideoBtn.classList.remove('hidden');
    videoUrlInput.value = '';
  });

  changeVideoBtn.addEventListener('click', () => {
    noVideoOverlay.classList.remove('hidden');
  });

  // ---------- Chat ----------
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    socket.emit('chat-message', { text });
    chatInput.value = '';
  });

  // ---------- Socket events ----------
  socket.on('chat-message', addChatMessage);

  socket.on('peer-joined', ({ id, name }) => {
    roomPeopleCount++;
    updatePeopleStatus();
    addSystemMessage(`${name} xonaga qo‘shildi`);
    offerTo(id, name);
  });

  socket.on('peer-left', ({ id }) => {
    const name = peers.get(id)?.label.textContent || 'Sherigingiz';
    roomPeopleCount = Math.max(1, roomPeopleCount - 1);
    updatePeopleStatus();
    addSystemMessage(`${name} xonadan chiqib ketdi`);
    removePeer(id);
  });

  socket.on('video-load', ({ videoId }) => {
    noVideoOverlay.classList.add('hidden');
    changeVideoBtn.classList.remove('hidden');
    createOrLoadPlayer(videoId);
  });

  socket.on('video-sync', applyRemoteVideoSync);

  socket.on('webrtc-signal', handleWebrtcSignal);

  socket.on('connect_error', () => {
    showToast('Serverga ulanishda muammo yuz berdi.');
  });
})();
