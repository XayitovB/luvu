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
  const versionPillLanding = document.getElementById('version-pill-landing');
  const versionPillRoom = document.getElementById('version-pill-room');

  fetch('/api/version')
    .then((r) => r.json())
    .then(({ version, commit }) => {
      [versionPillLanding, versionPillRoom].forEach((el) => {
        el.textContent = `v${version}`;
        el.title = `Build: ${commit}`;
      });
    })
    .catch(() => {});

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

  // Fetched from the server so a TURN relay (needed when both people are behind
  // NAT/CGNAT, e.g. mobile carriers) can be added without hardcoding secrets here.
  const iceServersPromise = fetch('/api/ice-servers')
    .then((r) => r.json())
    .then((d) => d.iceServers)
    .catch(() => [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }]);

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

  let lastMessageTs = 0;

  function addChatMessage({ id, name, text, ts }) {
    lastMessageTs = Math.max(lastMessageTs, ts || Date.now());
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
    meta.textContent = `${mine ? 'You' : name} • ${hh}:${mm}`;

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
    let lastCheckWallTime = Date.now();
    seekWatcher = setInterval(() => {
      const now = Date.now();
      const elapsedSeconds = (now - lastCheckWallTime) / 1000;
      lastCheckWallTime = now;

      if (!ytPlayer || applyingRemoteVideoChange || typeof YT === 'undefined') return;
      if (typeof ytPlayer.getPlayerState !== 'function') return;
      if (ytPlayer.getPlayerState() !== YT.PlayerState.PLAYING) return;
      const t = ytPlayer.getCurrentTime();
      // Compare against actual wall-clock elapsed time, not a fixed 1s tick —
      // a backgrounded/throttled tab can delay this callback by many seconds,
      // which would otherwise look exactly like a manual seek and misfire.
      const expected = lastKnownTime + elapsedSeconds;
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
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (!localMediaPromise) {
        showToast('This browser doesn’t support camera/microphone — you can still use chat and video.');
        localMediaPromise = Promise.reject(new Error('getUserMedia unsupported'));
        localMediaPromise.catch(() => {}); // mark as handled so it never becomes an unhandled rejection
      }
      return localMediaPromise;
    }
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
          showToast('Camera or microphone access was denied.');
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
    empty.textContent = 'Connecting…';

    const label = document.createElement('span');
    label.className = 'cam-label';
    label.textContent = name || 'Guest';

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

  // Polls WebRTC stats to show a live quality dot per tile and, if the
  // connection is genuinely struggling, suggests switching to audio-only.
  function monitorConnectionQuality(pc, tile) {
    const dot = document.createElement('span');
    dot.className = 'quality-dot quality-good';
    dot.title = 'Connection quality';
    tile.appendChild(dot);

    let prevLost = 0;
    let prevReceived = 0;
    let badStreak = 0;
    let warnedOnce = false;

    const timer = setInterval(async () => {
      if (pc.connectionState === 'closed') {
        clearInterval(timer);
        return;
      }
      try {
        const stats = await pc.getStats();
        let lost = null;
        let received = null;
        stats.forEach((report) => {
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            lost = report.packetsLost || 0;
            received = report.packetsReceived || 0;
          }
        });
        if (lost === null) return; // no inbound video yet

        const deltaLost = Math.max(0, lost - prevLost);
        const deltaReceived = Math.max(0, received - prevReceived);
        prevLost = lost;
        prevReceived = received;

        const total = deltaLost + deltaReceived;
        const lossRatio = total > 0 ? deltaLost / total : 0;

        let level = 'good';
        if (lossRatio > 0.08) level = 'bad';
        else if (lossRatio > 0.03) level = 'warn';
        dot.className = 'quality-dot quality-' + level;

        if (level === 'bad') {
          badStreak++;
          if (badStreak >= 3 && !warnedOnce) {
            warnedOnce = true;
            showToast('Your connection looks slow — turning off your camera and switching to audio-only will improve quality 📶', 6500);
          }
        } else {
          badStreak = 0;
        }
      } catch (e) {
        // getStats can transiently fail during renegotiation; ignore
      }
    }, 4000);

    return timer;
  }

  const peerCreationPromises = new Map();

  // Async (fetches ICE servers incl. TURN) — guarded against concurrent calls
  // for the same peerId racing each other into creating duplicate connections.
  function getOrCreatePeer(peerId, name) {
    const existing = peers.get(peerId);
    if (existing) {
      if (name) existing.label.textContent = name;
      return Promise.resolve(existing);
    }
    if (peerCreationPromises.has(peerId)) return peerCreationPromises.get(peerId);

    const creation = createPeer(peerId, name).finally(() => peerCreationPromises.delete(peerId));
    peerCreationPromises.set(peerId, creation);
    return creation;
  }

  async function createPeer(peerId, name) {
    // Must finish before touching the connection: an 'ice' signal for a brand-new
    // peer can otherwise win the race and create it before media is ready,
    // permanently locking in a connection with no outgoing track.
    await ensureLocalMedia().catch(() => {});

    const { tile, video, empty, label } = createRemoteTile(peerId, name);
    const iceServers = await iceServersPromise;
    const pc = new RTCPeerConnection({ iceServers });

    if (localStream) {
      localStream.getTracks().forEach((track) => {
        const sender = pc.addTrack(track, localStream);
        if (track.kind === 'video') applyLowBandwidthVideoParams(sender);
      });
    }

    const entry = { pc, tile, video, empty, label, qualityTimer: null, isOfferer: false, restarting: false };

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
      // A transient network blip can drop an established call without the
      // socket itself disconnecting; without this it stays dead until someone
      // manually leaves and rejoins. Only the original offerer restarts —
      // the other side just answers the renegotiation like any other offer.
      if (pc.connectionState === 'failed' && entry.isOfferer && !entry.restarting) {
        entry.restarting = true;
        restartIce(entry, peerId)
          .catch(() => {})
          .finally(() => (entry.restarting = false));
      }
    };

    entry.qualityTimer = monitorConnectionQuality(pc, tile);
    peers.set(peerId, entry);
    return entry;
  }

  async function offerTo(peerId, name) {
    await ensureLocalMedia().catch(() => {});
    const entry = await getOrCreatePeer(peerId, name);
    entry.isOfferer = true;
    const offer = await entry.pc.createOffer();
    await entry.pc.setLocalDescription(offer);
    socket.emit('webrtc-signal', { to: peerId, signal: { type: 'offer', sdp: entry.pc.localDescription } });
  }

  async function restartIce(entry, peerId) {
    const offer = await entry.pc.createOffer({ iceRestart: true });
    await entry.pc.setLocalDescription(offer);
    socket.emit('webrtc-signal', { to: peerId, signal: { type: 'offer', sdp: entry.pc.localDescription } });
  }

  async function handleWebrtcSignal({ from, signal }) {
    if (!signal || !from) return;
    const entry = await getOrCreatePeer(from);
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
    if (entry.qualityTimer) clearInterval(entry.qualityTimer);
    entry.pc.close();
    entry.tile.remove();
    peers.delete(peerId);
  }

  function teardownAllPeers() {
    Array.from(peers.keys()).forEach(removePeer);
  }

  function updatePeopleStatus() {
    if (roomPeopleCount <= 1) {
      setPeerStatus(false, 'No one else here yet — share the link');
    } else {
      setPeerStatus(true, `${roomPeopleCount} people in the room 💚`);
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
    myName = document.getElementById('create-name').value.trim() || 'Guest';
    socket.emit('create-room', { name: myName, clientId: myClientId }, (res) => {
      if (!res.ok) {
        showLandingError(res.error || 'Couldn’t create the room.');
        return;
      }
      saveSession(res.code, myName);
      enterRoom(res.code, res.people, res.video, res.messages);
    });
  });

  formJoin.addEventListener('submit', (e) => {
    e.preventDefault();
    clearLandingError();
    myName = document.getElementById('join-name').value.trim() || 'Guest';
    const code = document.getElementById('join-code').value.trim().toUpperCase();
    socket.emit('join-room', { name: myName, code, clientId: myClientId }, (res) => {
      if (!res.ok) {
        showLandingError(res.error || 'Couldn’t join.');
        return;
      }
      saveSession(res.code, myName);
      enterRoom(res.code, res.people, res.video, res.messages);
    });
  });

  async function enterRoom(code, people, video, messages) {
    roomCode = code;
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
      myName = session.name || 'Guest';
      socket.emit('join-room', { name: myName, code: session.code, clientId: myClientId }, (res) => {
        if (!res.ok) {
          clearSession();
          viewLoading.classList.add('hidden');
          viewLanding.classList.remove('hidden');
          showLandingError('Your previous room has ended — open a new one or join another.');
          prefillJoinFromUrl();
          return;
        }
        enterRoom(res.code, res.people, res.video, res.messages);
        showToast('You’re back in your room 💕');
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
    const fail = () => showToast('Couldn’t copy. Copy it manually from here: ' + text, 6000);

    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok).catch(() => (legacyCopy(text) ? ok() : fail()));
    } else {
      legacyCopy(text) ? ok() : fail();
    }
  }

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
    copyToClipboard(link, 'Invite link copied 💌 — now send it to your partner');
  });

  linkModalCopyBtn.addEventListener('click', () => {
    linkModalInput.select();
    copyToClipboard(linkModalInput.value, 'Copied ✨');
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
    showToast('You arrived via an invite link — enter your name 💕');
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
      videoError.textContent = 'That link doesn’t look right. Check the YouTube URL.';
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
    addSystemMessage(`${name} joined the room`);
    offerTo(id, name);
  });

  socket.on('peer-left', ({ id }) => {
    const name = peers.get(id)?.label.textContent || 'Your partner';
    roomPeopleCount = Math.max(1, roomPeopleCount - 1);
    updatePeopleStatus();
    addSystemMessage(`${name} left the room`);
    removePeer(id);
  });

  socket.on('video-load', ({ videoId }) => {
    noVideoOverlay.classList.add('hidden');
    changeVideoBtn.classList.remove('hidden');
    createOrLoadPlayer(videoId);
  });

  socket.on('video-sync', applyRemoteVideoSync);

  socket.on('webrtc-signal', handleWebrtcSignal);

  // A dropped connection (common on mobile data) gets a new socket id on
  // reconnect, and the server has already forgotten the old membership —
  // without this, the room would look fine locally but be silently dead
  // (chat/video-sync/signaling all get dropped server-side because
  // currentRoomCode is null on the new connection).
  let hasConnectedOnce = false;
  socket.on('connect', () => {
    if (!hasConnectedOnce) {
      hasConnectedOnce = true;
      return;
    }
    if (!roomCode) return;

    socket.emit('join-room', { name: myName, code: roomCode, clientId: myClientId }, (res) => {
      if (!res.ok) {
        showToast('This room no longer exists — please refresh the page.');
        return;
      }
      teardownAllPeers(); // stale from before the drop; fresh 'peer-joined' events re-establish calls
      roomPeopleCount = (res.people && res.people.length) || 1;
      updatePeopleStatus();
      (res.messages || []).filter((m) => m.ts > lastMessageTs).forEach(addChatMessage);
      showToast('Reconnected 🔄');
    });
  });

  socket.on('connect_error', () => {
    showToast('There was a problem connecting to the server.');
  });
})();
