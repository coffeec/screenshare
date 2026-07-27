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
let subscribed = new Set();

// ---------- empty state observer ----------
const gridEl = $('grid');
const emptyStateEl = $('empty-state');
new MutationObserver(() => {
  emptyStateEl.hidden = gridEl.children.length > 0;
}).observe(gridEl, { childList: true });

// ---------- join ----------

const params = new URLSearchParams(location.search);
if (params.get('room')) {
  $('room-input').value = params.get('room');
  autoJoinIfRoom();
}

async function autoJoinIfRoom() {
  const btn = $('join-form').querySelector('button[type="submit"]');
  const span = btn.querySelector('span');
  span.textContent = '正在获取位置...';
  btn.disabled = true;

  const suffixes = [
    '的落地成盒专家', '的职业劝架人', '的被劝架受害者', '的泉水指挥官', '的0伤害捍卫者', '的红甲混子', '的白甲战神', '的瓦尔基里黑车', '的奥林匹斯坠崖者', '的跑毒马拉松选手', '的决赛圈演员', '的打背身被反杀', '的腰射大师', '的开镜必空', '的一生之敌门框', '的打药被打断', '的躺赢挂件', '的TS身法怪', '的蹬墙跳菜鸟', '的超级跳失误者', '的汗流浃背玩家', '的马枪大帝',
    '的和平捍卫者', '的克雷贝尔狙神', '的暴走小帮手', '的红点R-301', '的滋崩真君', '的敖犬一发9点', '的电能冲锋枪', '的猎兽五连发', '的转换者双持', '的哈沃克猛男', '的平行步枪压不住', '的专注轻机枪', '的复仇女神', '的莫桑比克Here', '的EVA-8描边大师', '的长弓刮痧师傅', '的哨兵充能一枪头', '的三重狙击步枪', '的电弧星忍者', '的铝热剂封路',
    '的红甲恶灵', '的扎针动力小子', '的白给幻象', '的扫描猎犬', '的胖子直布罗陀', '的毒气老头', '的罗芭黑店老板', '的密客无人机', '的电妹布防', '的烟妹人体描边', '的疯玛吉钻头', '的兰伯特塞拉', '的希尔透视', '的阿什传送门', '的地平线黑洞', '的万蒂奇小蝙蝠', '的导管充电宝', '的卡特莉斯黑墙', '的命脉不给奶',
    '的凤凰治疗包', '的绝招加速剂', '的移动重生信标', '的撤离塔升天', '的金背包', '的诸王峡谷老兵', '的世界边缘打工人', '的风暴点跑酷者', '的残月滑索人', '的空投砸脸',
    '的0.3辅助瞄准', '的0.3终极轮椅', '的近战一梭子融化', '的经典手柄老哥', '的站桩舔包受害者', '的近战轮椅战神', '的手柄一键锁头', '的帕金森抖枪术', '的超级跳身法怪', '的多动症舔包', '的键鼠手腕流', '的远距离点射大师', '的被手柄融化的键鼠'
  ];

  const customName = params.get('name');
  const customSuffix = params.get('suffix');

  let finalName = '';
  if (customName) {
    finalName = customName;
  } else {
    let loc = '神秘';
    try {
      const res = await fetch('https://api.ip.sb/geoip');
      if (res.ok) {
        const data = await res.json();
        const en2zh = {
          'Guangdong':'广东', 'Beijing':'北京', 'Shanghai':'上海', 'Zhejiang':'浙江',
          'Jiangsu':'江苏', 'Shandong':'山东', 'Sichuan':'四川', 'Hubei':'湖北',
          'Henan':'河南', 'Hunan':'湖南', 'Hebei':'河北', 'Fujian':'福建',
          'Anhui':'安徽', 'Liaoning':'辽宁', 'Shaanxi':'陕西', 'Jiangxi':'江西',
          'Chongqing':'重庆', 'Guangxi':'广西', 'Shanxi':'山西', 'Yunnan':'云南',
          'Heilongjiang':'黑龙江', 'Jilin':'吉林', 'Guizhou':'贵州', 'Xinjiang':'新疆',
          'Gansu':'甘肃', 'Inner Mongolia':'内蒙古', 'Hainan':'海南', 'Ningxia':'宁夏',
          'Qinghai':'青海', 'Tibet':'西藏', 'Tianjin':'天津', 'Macao':'澳门', 'Hong Kong':'香港', 'Taiwan':'台湾'
        };
        if (['CN', 'TW', 'HK', 'MO'].includes(data.country_code)) {
          loc = en2zh[data.region] || data.region || '神秘';
        }
      }
    } catch(e) {
      console.warn('IP Location fallback:', e);
    }
    const suffix = customSuffix || suffixes[Math.floor(Math.random() * suffixes.length)];
    finalName = loc + suffix;
  }

  $('name-input').value = finalName;

  span.textContent = '正在进入房间...';
  // 等待渲染，并确保后续 submit 监听器已经挂载
  setTimeout(() => {
    $('join-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  }, 100);
}
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
      subscribed.forEach(id => {
        const p = peers.find(peer => peer.id === id);
        if (!p || !p.sharing) subscribed.delete(id);
      });
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
  renderMembersList();
}

function renderMembersList() {
  const sharingList = $('sharing-list');
  const watchingList = $('watching-list');
  if (!sharingList || !watchingList) return;
  sharingList.innerHTML = '';
  watchingList.innerHTML = '';
  let sharingCount = 0;
  let watchingCount = 0;

  function makeMemberHTML(p, isSelf) {
    const isSharing = isSelf ? !!localStream : p.sharing;
    let html = `<div class="member-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg></div>
    <div class="member-info">
      <div class="member-name">${isSharing ? '<span class="live-badge">LIVE</span>' : ''}${p.name}${isSelf ? ' (你)' : ''}</div>`;
    
    if (isSharing && p.watchers && p.watchers.length > 0) {
      html += `<div class="watchers-text">👀 ${p.watchers.join(', ')} 正在观看</div>`;
    }
    html += `</div>`;
    
    if (!isSelf && isSharing) {
      if (subscribed.has(p.id)) {
        html += `<button class="watch-btn watching" onclick="unsubscribeFrom('${p.id}')">停止观看</button>`;
      } else {
        html += `<button class="watch-btn" onclick="subscribeTo('${p.id}')">点击观看</button>`;
      }
    }
    return html;
  }

  if (joined) {
    const li = document.createElement('li');
    li.className = 'is-self';
    const selfPeer = peers.find(p => p.id === selfId);
    li.innerHTML = makeMemberHTML({id: selfId, name: joined.name, sharing: !!localStream, watchers: selfPeer?.watchers}, true);
    if (!!localStream) { sharingList.appendChild(li); sharingCount++; }
    else { watchingList.appendChild(li); watchingCount++; }
  }

  peers.forEach(p => {
    if (p.id === selfId) return;
    const li = document.createElement('li');
    li.innerHTML = makeMemberHTML(p, false);
    if (p.sharing) { sharingList.appendChild(li); sharingCount++; }
    else { watchingList.appendChild(li); watchingCount++; }
  });

  if ($('sharing-count')) $('sharing-count').textContent = sharingCount;
  if ($('watching-count')) $('watching-count').textContent = watchingCount;

  const count = sharingCount + watchingCount;
  const countEl = $('members-count');
  if (countEl) countEl.textContent = count;
  const badgeEl = $('members-badge');
  if (badgeEl) {
    badgeEl.textContent = count;
    badgeEl.hidden = count === 0;
  }
}

window.subscribeTo = (id) => {
  subscribed.add(id);
  send({type: 'subscribe', targetId: id});
  renderMembersList();
  renderLobbyCards();
};
window.unsubscribeFrom = (id) => {
  subscribed.delete(id);
  send({type: 'unsubscribe', targetId: id});
  renderMembersList();
  renderLobbyCards();
};

function renderLobbyCards() {
  const grid = $('grid');
  document.querySelectorAll('.lobby-card').forEach(card => {
    const owner = card.dataset.owner;
    const p = peers.find(p => p.id === owner);
    if (!p || !p.sharing || subscribed.has(owner)) {
      card.remove();
    }
  });
  
  peers.forEach(p => {
    if (p.id !== selfId && p.sharing && !subscribed.has(p.id)) {
      if (!document.querySelector(`.lobby-card[data-owner="${p.id}"]`)) {
        const card = document.createElement('div');
        card.className = 'lobby-card';
        card.dataset.owner = p.id;
        card.innerHTML = `
          <h3>📺 ${p.name} 正在共享屏幕</h3>
          <p>点击右侧列表或下方按钮加入观看</p>
          <button class="btn-primary" onclick="subscribeTo('${p.id}')">加入观看</button>
        `;
        grid.appendChild(card);
      }
    }
  });
}

function pruneTiles() {
  const ids = new Set(peers.map((p) => p.id));
  document.querySelectorAll('.tile.remote').forEach((tile) => {
    if (!ids.has(tile.dataset.owner)) tile.remove();
  });
  renderLobbyCards();
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

// ---------- members panel toggling ----------

$('members-btn').addEventListener('click', () => {
  const panel = $('members-panel');
  if (panel) {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      renderMembersList();
    }
  }
});

$('close-members-btn').addEventListener('click', () => {
  const panel = $('members-panel');
  if (panel) panel.hidden = true;
});
