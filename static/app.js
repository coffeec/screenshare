'use strict';

const $ = (id) => document.getElementById(id);

let ws = null;
let pc = null;
let localStream = null;
let selfId = null;
let peers = [];
let joined = null;          // {room, name, token}
let reconnectDelay = 1000;
let statsTimer = null;
let pingTimer = null;
let wasSharing = false;

// ---------- empty state observer ----------
const gridEl = $('grid');
const emptyStateEl = $('empty-state');
new MutationObserver(() => {
  emptyStateEl.hidden = gridEl.children.length > 0;
}).observe(gridEl, { childList: true });

// ---------- join ----------

const params = new URLSearchParams(location.search);
if (params.get('room')) $('room-input').value = params.get('room');

$('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const room = $('room-input').value.trim();
  const name = $('name-input').value.trim();
  $('join-error').hidden = true;
  try {
    const res = await fetch('/auth');
    if (!res.ok) throw new Error('服务器拒绝访问');
  } catch (err) {
    $('join-error').textContent = err.message || '无法连接服务器';
    $('join-error').hidden = false;
    return;
  }
  joined = { room, name };
  history.replaceState(null, '', `?room=${encodeURIComponent(room)}`);
  $('join-panel').hidden = true;
  $('room-panel').hidden = false;
  $('room-label').textContent = `房间 ${room} · ${name}`;
  connect();
});

// ---------- signaling ----------

function connect() {
  const { room, name } = joined;
  const codecSel = $('codec-select');
  const codec = codecSel ? codecSel.value : 'h264';
  ws = new WebSocket(`wss://${location.host}/ws?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}&codec=${codec}`);

  ws.onopen = () => {
    reconnectDelay = 1000;
    setBanner(null);
    // App-level keepalive: some proxies/tunnels drop idle-looking TCP even
    // with protocol pings; a tiny JSON frame every 15s keeps the path warm.
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ type: 'ping' }), 15000);
  };

  // Serialize async message handling: a 'candidate' must not race past an
  // 'offer' that is still awaiting setRemoteDescription.
  let chain = Promise.resolve();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    chain = chain.then(() => handleSignal(m)).catch((err) => console.warn('signal', err));
  };

  ws.onclose = () => {
    clearInterval(pingTimer);
    pingTimer = null;
    wasSharing = !!localStream;
    teardownPC(false);
    if (!joined) return;
    setBanner(`连接断开,${Math.round(reconnectDelay / 1000)} 秒后重连…`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };
}

let pendingCandidates = [];

async function handleSignal(m) {
  switch (m.type) {
    case 'welcome':
      selfId = m.selfId;
      peers = m.peers || [];
      newPeerConnection();
      renderLabels();
      if (wasSharing && localStream) {
        setBanner('网络断开，正在自动恢复共享...');
        publishLocalStream(localStream).then(() => {
          setTimeout(() => setBanner(null), 2000);
          wasSharing = false;
        });
      }
      break;
    case 'peers':
      peers = m.peers || [];
      renderLabels();
      pruneTiles();
      break;
    case 'offer':
      if (!pc) return;
      await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      for (const c of pendingCandidates.splice(0)) {
        try { await pc.addIceCandidate(c); } catch (err) { console.warn('addIceCandidate(queued)', err); }
      }
      await pc.setLocalDescription(await pc.createAnswer());
      send({ type: 'answer', sdp: pc.localDescription.sdp });
      break;
    case 'candidate':
      if (!pc) return;
      if (!pc.remoteDescription) { pendingCandidates.push(m.candidate); return; }
      try { await pc.addIceCandidate(m.candidate); } catch (err) { console.warn('addIceCandidate', err); }
      break;
    case 'error':
      setBanner(`服务器错误: ${m.message}`);
      break;
  }
}

function send(m) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

// ---------- peer connection ----------

function newPeerConnection() {
  teardownPC(false);
  pendingCandidates = [];
  pc = new RTCPeerConnection({});
  pc.onicecandidate = (e) => { if (e.candidate) send({ type: 'candidate', candidate: e.candidate.toJSON() }); };
  pc.ontrack = (e) => {
    const stream = e.streams[0];
    if (!stream) return;
    attachRemote(stream);
  };
}

function teardownPC(clearShare = true) {
  if (pc) { pc.close(); pc = null; }
  document.querySelectorAll('.tile.remote').forEach((t) => t.remove());
  if (clearShare && localStream) {
    wasSharing = true;
    stopLocalCapture();
  }
}

// ---------- tiles ----------

function attachRemote(stream) {
  // stream.id is the owner's peer ID (set server-side).
  let tile = document.querySelector(`.tile[data-owner="${CSS.escape(stream.id)}"]`);
  if (!tile) {
    tile = makeTile(stream.id, false);
    $('grid').appendChild(tile);
  }
  const video = tile.querySelector('video');
  if (video.srcObject !== stream) {
    video.srcObject = stream;
    video.play().catch(() => {});
  }
  stream.onremovetrack = () => {
    if (stream.getTracks().length === 0) tile.remove();
  };
  renderLabels();
}

function makeTile(ownerId, isLocal) {
  const tile = document.createElement('div');
  tile.className = `tile ${isLocal ? 'local' : 'remote'}`;
  tile.dataset.owner = ownerId;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  tile.appendChild(video);
  video.addEventListener('dblclick', () => goFullscreen(video));

  const overlay = document.createElement('div');
  overlay.className = 'tile-overlay';
  
  const label = document.createElement('span');
  label.className = 'label';
  overlay.appendChild(label);

  const controls = document.createElement('div');
  controls.className = 'tile-controls';

  const iconFullscreen = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path></svg>`;
  const iconVolHigh = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;
  const iconVolLow = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;
  const iconMuted = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`;

  if (!isLocal) {
    const audioCtl = document.createElement('div');
    audioCtl.className = 'audio-ctl';

    const unmute = document.createElement('button');
    unmute.className = 'icon-btn unmute';
    unmute.innerHTML = iconMuted;
    unmute.title = '静音/取消静音';
    unmute.onclick = () => {
      video.muted = !video.muted;
      syncAudioUI();
    };

    const vol = document.createElement('input');
    vol.type = 'range';
    vol.className = 'volume';
    vol.min = '0';
    vol.max = '100';
    vol.value = '100';
    vol.title = '音量';
    vol.oninput = () => {
      video.volume = Number(vol.value) / 100;
      if (video.muted && Number(vol.value) > 0) video.muted = false;
      if (Number(vol.value) === 0) video.muted = true;
      syncAudioUI();
    };

    function syncAudioUI() {
      const v = video.muted ? 0 : video.volume;
      unmute.innerHTML = v === 0 ? iconMuted : v < 0.5 ? iconVolLow : iconVolHigh;
    }
    video.addEventListener('volumechange', syncAudioUI);

    audioCtl.appendChild(unmute);
    audioCtl.appendChild(vol);
    controls.appendChild(audioCtl);
  }

  const fs = document.createElement('button');
  fs.className = 'icon-btn fullscreen';
  fs.title = '全屏(或双击画面)';
  fs.innerHTML = iconFullscreen;
  fs.onclick = () => goFullscreen(video);
  controls.appendChild(fs);

  overlay.appendChild(controls);
  tile.appendChild(overlay);

  const stats = document.createElement('pre');
  stats.className = 'stats';
  stats.hidden = true;
  tile.appendChild(stats);
  return tile;
}

function goFullscreen(video) {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
    return;
  }
  const req = video.requestFullscreen || video.webkitRequestFullscreen || video.webkitEnterFullscreen;
  if (req) req.call(video);
}

function renderLabels() {
  document.querySelectorAll('.tile').forEach((tile) => {
    const owner = tile.dataset.owner;
    const info = peers.find((p) => p.id === owner);
    const name = tile.classList.contains('local') ? `${joined.name} (我)` : (info ? info.name : '…');
    tile.querySelector('.label').textContent = name;
  });
}

function pruneTiles() {
  const ids = new Set(peers.map((p) => p.id));
  document.querySelectorAll('.tile.remote').forEach((tile) => {
    if (!ids.has(tile.dataset.owner)) tile.remove();
  });
}

// ---------- capture ----------

$('share-btn').addEventListener('click', () => {
  if (localStream) stopShare(); else startShare();
});

async function startShare() {
  if (!pc || !ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('startShare blocked: pc=', !!pc, 'ws=', ws && ws.readyState);
    setBanner('还没连上服务器,稍等一下再试…');
    return;
  }
  // We are the SDP answerer, so addTrack must reuse the server's pre-negotiated
  // publish m-line. Right after a stop-share that m-line is still 'sendonly'
  // until the server's re-offer lands; addTrack now would create an
  // un-negotiable transceiver that silently sends nothing.
  const pubVideo = pc.getTransceivers().find((t) => t.mid === '0');
  console.log('startShare: transceivers', pc.getTransceivers().map((t) => `${t.mid}:${t.currentDirection}`));
  if (pubVideo && (pubVideo.currentDirection === 'sendonly' || pubVideo.currentDirection === 'sendrecv')) {
    setBanner('正在释放上一次共享,请等一两秒再点…');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
      audio: true,
    });
  } catch (err) {
    console.warn('getDisplayMedia failed', err);
    if (err.name !== 'NotAllowedError') setBanner(`采集失败: ${err.name} ${err.message}`);
    return;
  }
  localStream = stream;
  wasSharing = false;
  setBanner(null);

  // Build the preview tile FIRST so the UI reflects reality even if the
  // quality knobs below throw on some browser.
  const tile = makeTile(selfId, true);
  tile.querySelector('video').srcObject = stream;
  $('grid').prepend(tile);
  renderLabels();
  $('share-btn').querySelector('.btn-text').textContent = '停止共享';
  $('share-btn').classList.add('sharing');

  const videoTrack = stream.getVideoTracks()[0];
  // motion 提示编码器优先保帧率（看视频/打游戏更流畅）
  // 2x2 bug 已经由 degradationPreference='maintain-resolution' 彻底防住
  try { videoTrack.contentHint = 'motion'; } catch (e) { console.warn('contentHint', e); }
  videoTrack.onended = stopShare;   // browser's own "stop sharing" bar

  await publishLocalStream(stream);
}

async function publishLocalStream(stream) {
  for (const track of stream.getTracks()) {
    const sender = pc.addTrack(track, stream);
    if (track.kind === 'video') {
      try { preferBestQuality(sender); } catch (e) { console.warn('setCodecPreferences', e); }
      try {
        const p = sender.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = Number($('bitrate-select').value) * 1e6;
        // 移除了 minBitrate，因为它会导致 NVENC 硬件编码器在某些场景下死锁卡死
        // 彻底禁止 Chrome 在任何情况下降级分辨率（防止出现 2x2 bug）
        p.degradationPreference = 'maintain-resolution';
        await sender.setParameters(p);
      } catch (e) { console.warn('setParameters', e); }
    }
  }
  send({ type: 'renegotiate' });
}

$('bitrate-select').addEventListener('change', async () => {
  if (!pc || !localStream) return;
  const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
  if (!sender) return;
  const p = sender.getParameters();
  p.encodings[0].maxBitrate = Number($('bitrate-select').value) * 1e6;
  await sender.setParameters(p).catch((err) => console.warn('setParameters', err));
});

// Codec order lives in the server's offer (we answer, so browser-side
// setCodecPreferences is moot) — switching requires a fresh connection.
$('codec-select').addEventListener('change', () => {
  if (!joined) return;
  const sharing = !!localStream;
  if (sharing) stopLocalCapture();
  if (ws) ws.close();  // onclose handler reconnects with the new codec param
  setBanner(sharing ? '已切换编码,请重新点击「共享屏幕」' : '已切换编码');
});

function preferBestQuality(sender) {
  if (!('setCodecPreferences' in RTCRtpTransceiver.prototype)) return;
  const transceiver = pc.getTransceivers().find((t) => t.sender === sender);
  if (!transceiver) return;
  const codecs = RTCRtpReceiver.getCapabilities('video')?.codecs;
  if (!codecs || !codecs.length) return;
  const codecSel = $('codec-select');
  const mode = codecSel ? codecSel.value : 'h264';
  // Game mode: H.264 first — hardware encoders (NVENC/QuickSync) barely
  // touch the CPU, which the game itself needs; libvpx VP9 is software
  // and collapses to ~10fps when a game saturates the CPU.
  // Quality mode: VP9 profile-2, sharper text per bit for static content.
  const rank = mode === 'vp9'
    ? (c) => {
        if (c.mimeType === 'video/VP9') return c.sdpFmtpLine === 'profile-id=2' ? 0 : 1;
        if (c.mimeType === 'video/H264') return 2;
        return 3;
      }
    : (c) => {
        if (c.mimeType === 'video/H264') return 0;
        if (c.mimeType === 'video/VP9') return 1;
        return 2;
      };
  transceiver.setCodecPreferences([...codecs].sort((a, b) => rank(a) - rank(b)));
}

function stopShare() {
  stopLocalCapture();
  wasSharing = false;
  if (pc) {
    pc.getSenders().forEach((s) => { if (s.track) pc.removeTrack(s); });
  }
  send({ type: 'stop-share' });
}

function stopLocalCapture() {
  if (!localStream) return;
  localStream.getTracks().forEach((t) => t.stop());
  localStream = null;
  const tile = document.querySelector('.tile.local');
  if (tile) tile.remove();
  $('share-btn').querySelector('.btn-text').textContent = '共享屏幕';
  $('share-btn').classList.remove('sharing');
}

// ---------- stats ----------

$('stats-btn').addEventListener('click', toggleStats);
document.addEventListener('keydown', (e) => {
  if (e.key === 's' && !e.target.matches('input, select')) toggleStats();
});

function toggleStats() {
  const showing = statsTimer !== null;
  if (showing) {
    clearInterval(statsTimer);
    statsTimer = null;
    document.querySelectorAll('.stats').forEach((s) => { s.hidden = true; });
  } else {
    statsTimer = setInterval(updateStats, 1000);
    document.querySelectorAll('.stats').forEach((s) => { s.hidden = false; });
  }
}

const lastBytes = new Map();

async function updateStats() {
  if (!pc) return;
  const report = await pc.getStats();
  const byStream = new Map();
  report.forEach((s) => {
    if (s.type === 'outbound-rtp' && s.kind === 'video') {
      byStream.set('local', formatStat(s, 'out'));
    } else if (s.type === 'inbound-rtp' && s.kind === 'video') {
      const mid = report.get(s.trackIdentifier) || {};
      byStream.set(s.trackIdentifier || s.id, formatStat(s, 'in'));
    }
  });

  document.querySelectorAll('.tile').forEach((tile) => {
    const el = tile.querySelector('.stats');
    if (el.hidden) return;
    if (tile.classList.contains('local')) {
      el.textContent = byStream.get('local') || '';
    } else {
      const video = tile.querySelector('video');
      const stream = video.srcObject;
      if (!stream) return;
      const vt = stream.getVideoTracks()[0];
      el.textContent = (vt && byStream.get(vt.id)) || '';
    }
  });
}

function formatStat(s, dir) {
  const key = s.id;
  const prev = lastBytes.get(key) || 0;
  const bytes = dir === 'out' ? s.bytesSent : s.bytesReceived;
  lastBytes.set(key, bytes);
  const mbps = ((bytes - prev) * 8 / 1e6).toFixed(1);
  const lines = [
    `${s.frameWidth || '?'}x${s.frameHeight || '?'} @ ${s.framesPerSecond || 0}fps`,
    `${mbps} Mbps`,
  ];
  if (dir === 'out') {
    lines.push(`limit: ${s.qualityLimitationReason || 'n/a'}`);
    if (s.encoderImplementation) lines.push(`enc: ${s.encoderImplementation}`);
  }
  return lines.join('\n');
}

// ---------- misc ----------

function setBanner(text) {
  const b = $('status-banner');
  if (!text) { b.hidden = true; return; }
  b.textContent = text;
  b.hidden = false;
}
