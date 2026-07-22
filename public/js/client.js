(() => {
  'use strict';

  const socket = io();

  // ---------- DOM refs ----------
  const viewLanding = document.getElementById('view-landing');
  const viewRoom = document.getElementById('view-room');
  const landingError = document.getElementById('landing-error');

  const formCreate = document.getElementById('form-create');
  const formJoin = document.getElementById('form-join');

  const roomCodeBtn = document.getElementById('room-code-btn');
  const roomCodeValue = document.getElementById('room-code-value');
  const roomLinkBtn = document.getElementById('room-link-btn');
  const peerStatusEl = document.getElementById('peer-status');
  const leaveBtn = document.getElementById('leave-btn');

  const playerWrap = document.getElementById('player-wrap');
  const noVideoOverlay = document.getElementById('no-video-overlay');
  const formVideo = document.getElementById('form-video');
  const videoUrlInput = document.getElementById('video-url');
  const videoError = document.getElementById('video-error');
  const changeVideoBtn = document.getElementById('change-video-btn');

  const localVideo = document.getElementById('local-video');
  const remoteVideo = document.getElementById('remote-video');
  const remoteEmpty = document.getElementById('remote-empty');
  const remoteLabel = document.getElementById('remote-label');
  const toggleMicBtn = document.getElementById('toggle-mic');
  const toggleCamBtn = document.getElementById('toggle-cam');

  const chatMessages = document.getElementById('chat-messages');
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');

  const toastEl = document.getElementById('toast');

  // ---------- State ----------
  let myName = '';
  let roomCode = null;
  let ytPlayer = null;
  let ytApiReady = false;
  let pendingVideoId = null;
  let applyingRemoteVideoChange = false;
  let lastKnownTime = 0;
  let seekWatcher = null;

  let localStream = null;
  let pc = null;
  let micOn = true;
  let camOn = true;

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

  // ---------- WebRTC (camera call) ----------
  async function initLocalMedia() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
      createPeerConnection();
    } catch (err) {
      showToast('Kamera yoki mikrofonga ruxsat berilmadi.');
    }
  }

  function createPeerConnection() {
    if (pc) return;
    pc = new RTCPeerConnection(RTC_CONFIG);

    if (localStream) {
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    }

    pc.ontrack = (event) => {
      remoteVideo.srcObject = event.streams[0];
      remoteEmpty.classList.add('hidden');
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc-signal', { signal: { type: 'ice', candidate: event.candidate } });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')) {
        remoteEmpty.classList.remove('hidden');
      }
    };
  }

  async function startOffer() {
    if (!pc) createPeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-signal', { signal: { type: 'offer', sdp: pc.localDescription } });
  }

  async function handleWebrtcSignal({ signal }) {
    if (!signal) return;
    if (!pc) createPeerConnection();
    try {
      if (signal.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc-signal', { signal: { type: 'answer', sdp: pc.localDescription } });
      } else if (signal.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      } else if (signal.type === 'ice') {
        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      }
    } catch (err) {
      // ignore transient negotiation races between two peers
    }
  }

  function teardownCall() {
    if (pc) {
      pc.close();
      pc = null;
    }
    remoteVideo.srcObject = null;
    remoteEmpty.classList.remove('hidden');
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

  // ---------- Room entry ----------
  formCreate.addEventListener('submit', (e) => {
    e.preventDefault();
    clearLandingError();
    myName = document.getElementById('create-name').value.trim() || 'Mehmon';
    socket.emit('create-room', { name: myName }, (res) => {
      if (!res.ok) {
        showLandingError(res.error || 'Xona yaratib bo‘lmadi.');
        return;
      }
      enterRoom(res.code, res.people);
    });
  });

  formJoin.addEventListener('submit', (e) => {
    e.preventDefault();
    clearLandingError();
    myName = document.getElementById('join-name').value.trim() || 'Mehmon';
    const code = document.getElementById('join-code').value.trim().toUpperCase();
    socket.emit('join-room', { name: myName, code }, (res) => {
      if (!res.ok) {
        showLandingError(res.error || 'Qo‘shilib bo‘lmadi.');
        return;
      }
      enterRoom(res.code, res.people, res.video);
    });
  });

  async function enterRoom(code, people, video) {
    roomCode = code;
    roomCodeValue.textContent = code;
    switchToRoomView();
    await initLocalMedia();

    const hasPeer = people && people.length > 1;
    if (hasPeer) {
      const other = people.find((p) => p.id !== socket.id);
      setPeerStatus(true, `${other ? other.name : 'Sherigingiz'} ulandi 💚`);
      remoteLabel.textContent = other ? other.name : 'Sherigingiz';
    } else {
      setPeerStatus(false, 'Sherigingiz kutilmoqda…');
    }

    if (video && video.url) {
      noVideoOverlay.classList.add('hidden');
      changeVideoBtn.classList.remove('hidden');
      createOrLoadPlayer(video.url, video.currentTime || 0);
    }
  }

  function copyToClipboard(text, doneMsg) {
    const done = () => showToast(doneMsg);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(done);
    } else {
      done();
    }
  }

  roomCodeBtn.addEventListener('click', () => {
    if (!roomCode) return;
    copyToClipboard(roomCode, 'Xona kodi nusxalandi ✨');
  });

  roomLinkBtn.addEventListener('click', () => {
    if (!roomCode) return;
    const link = `${location.origin}/?room=${roomCode}`;
    copyToClipboard(link, 'Taklif havolasi nusxalandi 💌 — endi qizingizga yuboring');
  });

  // If opened via an invite link (?room=CODE), prefill the join form.
  function prefillJoinFromUrl() {
    const params = new URLSearchParams(location.search);
    const code = params.get('room');
    if (!code) return;
    document.getElementById('join-code').value = code.trim().toUpperCase();
    document.getElementById('join-name').focus();
    showToast('Taklif havolasi orqali keldingiz — ismingizni kiriting 💕');
    history.replaceState({}, '', location.pathname);
  }
  prefillJoinFromUrl();

  leaveBtn.addEventListener('click', () => leaveRoom());

  function leaveRoom() {
    socket.emit('leave-room');
    teardownCall();
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    if (seekWatcher) clearInterval(seekWatcher);
    ytPlayer = null;
    roomCode = null;
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
    setPeerStatus(true, `${name} ulandi 💚`);
    remoteLabel.textContent = name;
    addSystemMessage(`${name} xonaga qo‘shildi`);
    if (localStream) startOffer();
  });

  socket.on('peer-left', () => {
    setPeerStatus(false, 'Sherigingiz chiqib ketdi');
    remoteLabel.textContent = 'Sherigingiz';
    addSystemMessage('Sherigingiz xonadan chiqib ketdi');
    teardownCall();
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
