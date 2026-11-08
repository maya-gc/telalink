// =============================================================================
//  viewer.js — pagina de quem assiste.
//  Ordem de tentativa: conexao direta (WebRTC) -> TURN (se configurado) ->
//  retransmissao pelo link. Tudo cifrado com a chave do "#" do link.
// =============================================================================
import { $, show, openSocket, describeTransport, TRANSPORT_LABEL, caps, newAudioContext, enterFullscreen, exitFullscreen, isFullscreen } from './common.js';
import { keyFromHash, deriveKeys, SecureChannel } from './crypto.js';
import { RelayReceiver, decodableCodecs } from './relay.js';
import { qualityText } from './media-util.js';

const P2P_TIMEOUT_MS = 12_000;   // limite absoluto para a conexao direta/TURN
const PRFLX_GRACE_MS = 2_500;   // quem transmite sem caminhos: espera a direta sair pelos caminhos daqui
const NO_REMOTE_MS = 4_000;      // quem transmite nao mandou NENHUM caminho de rede: retransmissao ja
const STEP_TIMEOUT_MS = 8_000;   // cada etapa: se travar, explica o que fazer
const NO_RESPONSE_MS = 4_000;    // sem NENHUMA resposta nesse tempo = rede bloqueando
const roomId = new URLSearchParams(location.search).get('room');
const sessionKey = keyFromHash(location.hash);

let ws, pc, channel, keys, viewerId, receiver, audioCtx, p2pTimer;
// Reconexao automatica: se a conexao cair, tenta voltar sozinho (mesmo PIN).
let upgrading = false;
let fallingBack = false;   // passando da retransmissao para a conexao direta
let joinedPin = null, ended = false, retry = 0, retryTimer = null, offline = false;
const RETRY_DELAYS = [1, 2, 3, 5, 8, 10, 10, 10, 10, 10];   // segundos (~70 s no total)
let iceServers = [];
let transport = 'conectando';

// Diagnostico de conexao (sem segredos): tipos de candidatos e estados.
const diag = { local: [], remote: [], states: [], pairs: null };
window.__telalink = {
  get transport() { return transport; },
  get reconnecting() { return retry > 0; },
  get stats() { return receiver ? { ...receiver.stats } : null; },
  get diag() { return diag; },
  quality: () => measureQuality(),
  // Quadros recebidos (decodificados) ate agora, em qualquer navegador.
  async framesReceived() {
    if (transport === 'retransmissao') return receiver?.stats.framesDecoded || 0;
    let n = 0;
    try { (await pc?.getStats())?.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') n = r.framesDecoded || 0; }); } catch {}
    return n;
  },
};
const candType = (c) => (/ typ (\w+)/.exec(c?.candidate || '') || [])[1] || '?';

// Resumo dos pares de candidatos testados (para entender por que nao conectou).
async function snapshotPairs(conn) {
  try {
    const st = await conn.getStats();
    const out = [];
    st.forEach((s) => {
      if (s.type !== 'candidate-pair') return;
      const l = st.get(s.localCandidateId); const r = st.get(s.remoteCandidateId);
      out.push(`${l?.candidateType}->${r?.candidateType} ${s.state} req=${s.requestsSent ?? 0} resp=${s.responsesReceived ?? 0}`);
    });
    diag.pairs = out;
  } catch {}
}

if (!roomId) fatal('Link inválido: falta o identificador da sala.');
else if (!sessionKey) fatal('Link incompleto: falta a chave de segurança (a parte depois do “#”). Peça o link completo para quem está transmitindo.');

function fatal(msg) { show($('gateMsg'), 'err', msg); $('btnJoin').disabled = true; }

const pinEl = $('pin');
pinEl.addEventListener('input', () => { pinEl.value = pinEl.value.replace(/\D/g, '').slice(0, 6); });
pinEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
$('btnJoin').onclick = join;

// Qualidade recebida agora: resolucao, quadros por segundo e banda.
let lastIn = null, lastFrames = null;
async function measureQuality() {
  if (transport === 'retransmissao' && receiver) {
    const now = performance.now(), f = receiver.stats.framesDecoded, b = receiver.stats.bytes || 0;
    const q = { height: $('relayCanvas').height, width: $('relayCanvas').width, fps: 0, bps: 0 };
    if (lastFrames) { const dt = (now - lastFrames.t) / 1000; q.fps = (f - lastFrames.f) / dt; q.bps = ((b - lastFrames.b) * 8) / dt; }
    lastFrames = { t: now, f, b };
    return q;
  }
  if (!pc) return null;
  let q = null;
  try {
    (await pc.getStats()).forEach((r) => {
      if (r.type !== 'inbound-rtp' || r.kind !== 'video') return;
      const bps = lastIn ? ((r.bytesReceived - lastIn.bytes) * 8 * 1000) / Math.max(1, r.timestamp - lastIn.t) : 0;
      lastIn = { bytes: r.bytesReceived, t: r.timestamp };
      q = { height: r.frameHeight, width: r.frameWidth, fps: r.framesPerSecond, bps };
    });
  } catch {}
  return q;
}
setInterval(async () => {
  // Primeira imagem de verdade chegou: etapa concluida (e some o aviso, se havia).
  if (stepState.image === 'pending' && (await window.__telalink.framesReceived()) > 0) {
    step('image', 'ok'); if ($('stageMsg').textContent === STUCK.image) stageMsg('');
  }
  const q = await measureQuality();
  $('qualityTxt').textContent = q?.height ? ` · ${qualityText(q)}` : '';
}, 2000);

function setTransport(t) {
  transport = t;
  $('transportTxt').textContent = TRANSPORT_LABEL[t] || t;
}

async function join() {
  const pin = pinEl.value;
  if (pin.length !== 6) return show($('gateMsg'), 'err', 'Digite os 6 dígitos do PIN.');
  $('btnJoin').disabled = true;
  show($('gateMsg'), '', '');
  // AudioContext precisa nascer de um clique (regra dos navegadores).
  audioCtx = newAudioContext({ latencyHint: 'interactive' });
  keys = await deriveKeys(sessionKey, roomId);
  joinedPin = pin;
  await openAndJoin();
}

// ------------------------------------------------------------ etapas visiveis
// Mostra em que ponto a conexao esta e, se travar, o que fazer. Os tempos vao
// para o diagnostico (sem PIN, chave ou endereco da sala).
const STEPS = [
  ['link', 'Conectar ao link'], ['pin', 'Conferir o PIN'], ['host', 'Falar com quem transmite'], ['image', 'Receber a imagem'],
];
const stepState = {}, stepTime = {};
let t0 = 0, stepTimer = null;
function step(name, state, hint = '') {
  stepState[name] = state; if (state !== 'pending') stepTime[name] = Math.round(performance.now() - t0);
  const ol = $('steps'); ol.classList.remove('hidden'); ol.textContent = '';
  for (const [k, label] of STEPS) {
    const li = document.createElement('li');
    const st = stepState[k];
    li.className = st || 'todo';
    li.textContent = `${st === 'ok' ? '✓' : st === 'err' ? '✕' : st === 'pending' ? '…' : '○'} ${label}${k === name && hint ? ` — ${hint}` : ''}`;
    ol.appendChild(li);
  }
  clearTimeout(stepTimer);
  if (state === 'pending') stepTimer = setTimeout(() => stuck(name), STEP_TIMEOUT_MS);
}
const STUCK = {
  link: 'Não foi possível conectar ao link. Ele pode estar desatualizado (peça o convite de novo), ou uma extensão/bloqueador ou a rede está impedindo. Tente outro navegador ou os dados móveis.',
  pin: 'O servidor não respondeu ao PIN. Recarregue a página e tente de novo.',
  host: 'Quem transmite não respondeu. Peça para conferir se o painel do TelaLink continua aberto e transmitindo, e se este é o link mais recente.',
  image: 'A imagem ainda não chegou. Aguarde mais alguns segundos; se continuar, toque em “Copiar diagnóstico” e envie para quem transmite.',
};
function stuck(name) {
  if (stepState[name] !== 'pending') return;
  show($('gateMsg'), 'warn', STUCK[name]);
  $('btnDiag').classList.remove('hidden');
  if (name === 'image' && $('stage').classList.contains('on')) stageMsg(STUCK.image);
}
function diagnostic() {
  return JSON.stringify({
    telalink: 'diagnostico', navegador: caps.name, celular: caps.mobile, transporte: transport, etapas: stepTime, situacao: stepState,
    recursos: { webrtc: caps.webrtc, retransmissao: caps.relayDecode, somRetransmissao: caps.relayAudio },
    rede: { local: diag.local, remoto: diag.remote, estados: diag.states, pares: diag.pairs },
    quadros: receiver?.stats?.framesDecoded ?? null, quando: new Date().toISOString(),
  });
}
$('btnDiag').onclick = async () => {
  const text = diagnostic();
  try { await navigator.clipboard.writeText(text); show($('gateMsg'), 'ok', 'Diagnóstico copiado. Cole numa mensagem para quem transmite.'); }
  catch { prompt('Copie o diagnóstico:', text); }
};

async function openAndJoin() {
  if (!t0) t0 = performance.now();
  step('link', 'pending');
  const sock = openSocket({
    onJson: onMessage,
    onBinary: (bytes) => receiver?.handle(bytes),
    onClose: () => onSocketClosed(sock),
  });
  ws = sock;
  try { await sock.opened; } catch { step('link', 'err'); return stuck('link'); }
  step('link', 'ok'); step('pin', 'pending');
  sock.json({ type: 'viewer-join', roomId, pin: joinedPin });
}

function stageMsg(text) {
  const el = $('stageMsg');
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
}

function onSocketClosed(sock) {
  if (sock !== ws || ended) return;
  if (!viewerId && !retry) { $('btnJoin').disabled = false; return; }      // nem chegou a entrar
  // Imagem direta ainda chegando: continua assistindo; reconecta so se ela cair.
  if (pc && pc.connectionState === 'connected') {
    offline = true;
    stageMsg('Sem contato com o servidor — a imagem continua pela conexão direta.');
    return;
  }
  scheduleReconnect();
}

function scheduleReconnect() {
  if (ended) return;
  cleanup(); viewerId = null; offline = false;
  if (retry >= RETRY_DELAYS.length) {
    stageMsg('');
    $('stage').classList.remove('on');
    $('gate').style.display = '';
    $('btnJoin').disabled = false;
    retry = 0;
    return show($('gateMsg'), 'err', 'A conexão caiu e não voltou. Se quem transmite enviou um link novo, abra o novo link; senão, clique em Entrar para tentar de novo.');
  }
  const d = RETRY_DELAYS[retry++];
  stageMsg(`Conexão perdida — reconectando em ${d} s… (tentativa ${retry} de ${RETRY_DELAYS.length})`);
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => openAndJoin().catch(() => scheduleReconnect()), d * 1000);
}

async function onMessage(m) {
  if (m.type === 'error') {
    if (retry && m.reason !== 'sala-inexistente') { ws.close?.(); return; }   // reconectando: tenta de novo
    ended = m.reason === 'sala-inexistente' && retry > 0;
    retry = 0; stageMsg('');
    if (ended) { $('stage').classList.remove('on'); $('gate').style.display = ''; }
    $('btnJoin').disabled = false;
    const txt = { 'pin-invalido': 'PIN incorreto.', 'sala-inexistente': 'Transmissão não encontrada ou já encerrada.',
      bloqueado: 'Tentativas demais. Peça um novo link a quem está transmitindo.', 'sala-cheia': 'A transmissão atingiu o limite de espectadores.',
      'sala-trancada': 'A sala foi trancada por quem está transmitindo: novas pessoas não podem entrar agora.' }[m.reason];
    return show($('gateMsg'), 'err', txt || 'Não foi possível entrar.');
  }
  if (m.type === 'viewer-accepted') {
    step('pin', 'ok'); step('host', 'pending');
    if (retry) { retry = 0; stageMsg(''); }
    viewerId = m.viewerId;
    iceServers = m.iceServers || [];
    channel = new SecureChannel(keys.sig, `${roomId}|${viewerId}`);
    return show($('gateMsg'), 'ok', 'Conectando à transmissão...');
  }
  if (m.type === 'signal' && m.from === 'host') {
    let p;
    try { p = await channel.open('h2v', m.data); }
    catch { return show($('gateMsg'), 'err', 'Não foi possível validar a transmissão: confira se o link está completo (com a parte depois do “#”).'); }
    return onHostSignal(p);
  }
  if (m.type === 'kicked') {
    ended = true;
    cleanup();
    $('stage').classList.remove('on');
    $('gate').style.display = '';
    $('btnJoin').disabled = true;
    return show($('gateMsg'), 'err', 'Você foi removido da transmissão por quem está transmitindo.');
  }
  if (m.type === 'host-left') {
    ended = true;
    cleanup();
    $('stage').classList.remove('on');
    $('gate').style.display = '';
    $('btnJoin').disabled = true;
    show($('gateMsg'), 'err', 'A transmissão foi encerrada.');
  }
}

const sendSig = async (payload) => ws.json({ type: 'signal', data: await channel.seal('v2h', payload) });

async function onHostSignal(p) {
  if (p.kind === 'hello') {
    step('host', 'ok');
    if (p.policy === 'relay' || typeof RTCPeerConnection !== 'function') { step('image', 'pending', 'pela retransmissão'); return startRelay(); }
    step('image', 'pending', 'tentando a conexão direta');
    p2pTimer = setTimeout(() => { if (transport === 'conectando') fallbackToRelay(); }, P2P_TIMEOUT_MS);
    watchNoResponse(Date.now());
    // Quem transmite nao mandou nenhum caminho de rede (ex.: Brave protegido): nao adianta esperar.
    setTimeout(() => { if (transport === 'conectando' && !upgrading && diag.remote.length === 0) { diag.states.push('sem-caminho-remoto'); fallbackToRelay(); } }, NO_REMOTE_MS);
    return;
  }
  if (p.kind === 'no-direct') {                     // quem transmite nao tem conexao direta
    // Zero caminhos do outro lado nem sempre e bloqueio: no macOS o Chromium pode
    // esconder os enderecos (mDNS) e a conexao direta ainda sai pelos caminhos
    // DESTE lado (peer-reflexive). Da um instante para ela; senao, retransmissao.
    diag.states.push('transmissor-sem-caminhos');
    setTimeout(() => { if (transport === 'conectando' && !upgrading) { diag.states.push('transmissor-sem-conexao-direta'); fallbackToRelay(); } }, PRFLX_GRACE_MS);
    return;
  }
  if (p.kind === 'settings') {
    // Quem transmite mudou a configuracao: avisa aqui tambem (a imagem ja se ajusta sozinha).
    stageMsg(`Quem transmite ajustou: ${String(p.text || '').slice(0, 120)}`);
    clearTimeout(onHostSignal.t); onHostSignal.t = setTimeout(() => { if (!retry && !offline) stageMsg(''); }, 4000);
    return;
  }
  if (p.kind === 'policy') {
    if (p.policy === 'relay' && transport !== 'retransmissao') return fallbackToRelay();       // Maxima seguranca: ja
    if (p.policy === 'auto' && transport === 'retransmissao' && typeof RTCPeerConnection === 'function') {
      upgrading = true; createPeer();
      // Se a conexao direta nao sair em 15 s, continua so na retransmissao.
      setTimeout(() => { if (upgrading) { upgrading = false; pc?.close(); pc = null; } }, 15_000);
      return sendSig({ kind: 'want-p2p' });                                                    // tenta a conexao direta
    }
    return;
  }
  if (p.kind === 'sdp') {
    if (transport === 'retransmissao' && !upgrading) return;
    if (!pc) createPeer();
    // Limite de tempo: se o navegador travar aqui, a fila de mensagens segue
    // e a troca automatica para a retransmissao continua funcionando.
    const steps = (async () => {
      await pc.setRemoteDescription(p.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      return sendSig({ kind: 'sdp', sdp: pc.localDescription.toJSON() });
    })();
    return Promise.race([steps, new Promise((r) => setTimeout(r, 5000))]).catch((e) => { diag.states.push('sdp-erro:' + e.name); fallbackToRelay(); });
  }
  if (p.kind === 'ice' && pc) { diag.remote.push(candType(p.candidate)); await pc.addIceCandidate(p.candidate).catch((e) => diag.states.push('addIce-erro:' + e.name)); }
}

function createPeer() {
  pc = new RTCPeerConnection({ iceServers });
  let localCandidates = 0;
  pc.ontrack = (e) => {
    const v = $('remote');
    if (v.srcObject !== e.streams[0]) v.srcObject = e.streams[0];
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) { localCandidates++; diag.local.push(candType(e.candidate)); sendSig({ kind: 'ice', candidate: e.candidate.toJSON() }); }
  };
  // Nenhum caminho de rede disponivel (VPN/extensao que desliga WebRTC):
  // nao adianta esperar o tempo-limite, troca ja para a retransmissao.
  pc.onicegatheringstatechange = () => {
    if (pc?.iceGatheringState !== 'complete' || localCandidates !== 0) return;
    // Sem endereco proprio divulgado (ex.: Brave em "so a interface publica"), a
    // conexao ainda pode sair por um caminho descoberto na hora: espera 1,5 s.
    const conn = pc;
    setTimeout(() => {
      if (pc !== conn || ['connected', 'completed'].includes(conn.iceConnectionState) || conn.connectionState === 'connected') return;
      diag.states.push('sem-caminho-local'); fallbackToRelay();
    }, 1500);
  };
  pc.oniceconnectionstatechange = () => diag.states.push(`ice:${pc?.iceConnectionState}`);
  pc.onconnectionstatechange = async () => {
    diag.states.push(`pc:${pc?.connectionState}`);
    if (pc.connectionState === 'connected') {
      clearTimeout(p2pTimer);
      if (upgrading) {                     // deixa a retransmissao e fica so na conexao direta
        upgrading = false;
        receiver?.close(); receiver = null;
        ws.json({ type: 'relay-unsubscribe' });
      }
      setTransport(await describeTransport(pc));
      sendSig({ kind: 'transport', mode: transport });
      showStage('video');
    } else if (pc.connectionState === 'failed' || (offline && pc.connectionState === 'disconnected')) {
      if (offline) return scheduleReconnect();
      if (upgrading) { upgrading = false; pc.close(); pc = null; return; }     // continua na retransmissao
      fallbackToRelay();
    }
  };
}

// Se as tentativas de conexao direta nao recebem NENHUMA resposta (firewall de
// empresa, NAT de operadora), troca cedo em vez de esperar o limite inteiro.
function watchNoResponse(start) {
  const tick = async () => {
    if (transport !== 'conectando') return;
    if (pc && Date.now() - start >= NO_RESPONSE_MS) {
      let sent = 0, answered = 0;
      try {
        (await pc.getStats()).forEach((s) => {
          if (s.type === 'candidate-pair') { sent += s.requestsSent || 0; answered += (s.responsesReceived || 0) + (s.requestsReceived || 0); }
        });
      } catch {}
      if (sent > 0 && answered === 0) { diag.states.push('sem-resposta'); return fallbackToRelay(); }
    }
    setTimeout(tick, 1000);
  };
  setTimeout(tick, 1000);
}

async function fallbackToRelay() {
  if (transport === 'retransmissao' || fallingBack) return;
  fallingBack = true;
  if (stepState.image === 'pending') step('image', 'pending', 'pela retransmissão');
  diag.states.push('troca-para-retransmissao');
  clearTimeout(p2pTimer);
  if (pc) {
    // Alguns navegadores (Safari) podem nao responder getStats numa conexao
    // que falhou: espera no maximo 1 s pelo diagnostico.
    await Promise.race([snapshotPairs(pc), new Promise((r) => setTimeout(r, 1000))]);
    try { pc.close(); } catch {}
    pc = null;
  }
  sendSig({ kind: 'bye-p2p' }).catch(() => {});
  startRelay();
}

async function startRelay() {
  if (!caps.relayDecode) {
    return show($('gateMsg'), 'err', `Sua rede bloqueia a conexão direta e este ${caps.name} não suporta a retransmissão. Atualize o navegador (Chrome, Edge, Brave, Firefox 130+ ou Safari 16.4+).`);
  }
  // Conta a quem transmite quais codecs este navegador decodifica (ex.: Safari).
  decodableCodecs().then((codecs) => sendSig({ kind: 'relay-caps', codecs })).catch(() => {});
  if (!caps.relayAudio) setTimeout(() => stageMsg(`Neste ${caps.name}, a retransmissão chega sem som. Para ouvir, atualize o navegador ou use Chrome, Edge, Brave ou Firefox.`), 1500);
  receiver = new RelayReceiver({ mediaKey: keys.media, canvas: $('relayCanvas'), ws, audioCtx, volume: view.muted ? 0 : view.volume / 100, onError: (e) => console.warn('[telalink relay]', e) });
  setTransport('retransmissao');
  ws.json({ type: 'relay-subscribe' });
  sendSig({ kind: 'transport', mode: 'retransmissao' });
  showStage('canvas');
}

function showStage(kind) {
  $('gate').style.display = 'none';
  $('stage').classList.add('on');
  $('remote').classList.toggle('hidden', kind !== 'video');
  $('relayCanvas').classList.toggle('hidden', kind !== 'canvas');
  $('btnPip').classList.toggle('hidden', kind !== 'video' || !document.pictureInPictureEnabled);
  flashBar();
  if (!showStage.hinted) { showStage.hinted = true; showTapHint(); }
  applyVolume();
  if (kind === 'video') {
    // Navegadores bloqueiam som automatico sem clique: comeca mudo e avisa.
    $('remote').play().catch(() => {
      // Safari/iPhone e outros bloqueiam som automatico: comeca mudo e pede um toque.
      view.muted = true; applyVolume(); $('remote').play().catch(() => {}); flashBar(8000);
      needTap = true; stageMsg('🔇 Toque ou clique na imagem para ativar o som');
    });
  }
}

function cleanup() {
  clearTimeout(p2pTimer);
  fallingBack = false;
  pc?.close(); pc = null;
  receiver?.close(); receiver = null;
  setTransport('conectando');
}

// ------------------------------------------------------------ controles
const store = { get(k, d) { try { const v = localStorage.getItem('telalink.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('telalink.' + k, JSON.stringify(v)); } catch {} } };
const FITS = [['contain', '⤢', ' Caber'], ['cover', '⤡', ' Preencher'], ['real', '1:1', ' Tamanho real']];
const view = { volume: store.get('volume', 100), muted: false, fit: store.get('fit', 'contain') };
window.__telalink.view = view;

function applyVolume() {
  const v = view.muted ? 0 : view.volume / 100;
  $('remote').muted = view.muted || view.volume === 0;
  $('remote').volume = Math.min(1, view.volume / 100);
  receiver?.setVolume(v);
  if (audioCtx?.state === 'suspended' && !view.muted) audioCtx.resume().catch(() => {});
  $('btnMute').textContent = view.muted || view.volume === 0 ? '🔇' : '🔊';
  $('volume').value = view.volume;
}
function applyFit() {
  $('stage').classList.toggle('fit-cover', view.fit === 'cover');
  $('stage').classList.toggle('fit-real', view.fit === 'real');
  const [, icon, label] = FITS.find((f) => f[0] === view.fit);
  $('btnFit').textContent = icon;
  const span = document.createElement('span'); span.className = 'lbl'; span.textContent = label; $('btnFit').appendChild(span);
}
// Celular/tablet: um toque mostra os controles, outro toque esconde (e eles
// tambem somem sozinhos depois de alguns segundos). Dois toques = tela cheia.
const touchUI = matchMedia('(pointer: coarse)').matches;
let barPinned = false;
function setBar(show, autoHideMs = 6000) {
  barPinned = show;
  $('bar').classList.toggle('show', show);
  $('bar').classList.toggle('hide-force', !show && touchUI);
  clearTimeout(flashBar.t);
  if (show && autoHideMs) flashBar.t = setTimeout(() => setBar(false), autoHideMs);
}
let lastTap = 0, tapTimer = null;
$('stage').addEventListener('pointerup', (e) => {
  if (e.pointerType !== 'touch' || e.target.closest('.bar')) return;   // toques nos botoes nao contam
  const now = Date.now();
  if (now - lastTap < 300) {                       // dois toques: tela cheia
    clearTimeout(tapTimer); lastTap = 0;
    return $('btnFull').click();
  }
  lastTap = now;
  tapTimer = setTimeout(() => setBar(!barPinned), 250);
});
function showTapHint() {
  if (!touchUI) return;
  $('tapHint').classList.remove('off');
  setTimeout(() => $('tapHint').classList.add('off'), 3500);
}
window.__telalink.bar = () => ({ visible: $('bar').classList.contains('show'), touch: touchUI });

function flashBar(ms = 3000) {
  if (touchUI) return setBar(true, Math.max(ms, 4000));
  $('bar').classList.add('show');
  clearTimeout(flashBar.t); flashBar.t = setTimeout(() => $('bar').classList.remove('show'), ms);
}

$('btnMute').onclick = () => { view.muted = !(view.muted || view.volume === 0); if (!view.muted && view.volume === 0) view.volume = 50; applyVolume(); };
$('volume').oninput = () => { view.volume = Number($('volume').value); view.muted = false; store.set('volume', view.volume); applyVolume(); };
$('btnFit').onclick = () => {
  const i = FITS.findIndex((f) => f[0] === view.fit);
  view.fit = FITS[(i + 1) % FITS.length][0];
  store.set('fit', view.fit);
  applyFit();
};
$('btnPip').onclick = async () => {
  try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await $('remote').requestPictureInPicture(); } catch {}
};
$('btnFull').onclick = () => {
  if (!isFullscreen($('stage'))) enterFullscreen($('stage'), $('remote'));
  else exitFullscreen($('stage'));
};
// Primeiro toque/clique ativa o som se o navegador o bloqueou.
let needTap = false;
$('stage').addEventListener('click', () => {
  if (!needTap) return;
  needTap = false; view.muted = false; applyVolume();
  $('remote').play().catch(() => {}); audioCtx?.resume?.().catch?.(() => {});
  stageMsg('');
});
// Mouse mexendo mostra os controles (no celular, o toque cuida disso).
$('stage').addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') flashBar(); });
$('stage').addEventListener('dblclick', () => { if (!touchUI) $('btnFull').click(); });
document.addEventListener('keydown', (e) => {
  if (!$('stage').classList.contains('on') || e.target.tagName === 'INPUT') return;
  if (e.key === 'f' || e.key === 'F') $('btnFull').click();
  else if (e.key === 'm' || e.key === 'M') $('btnMute').click();
  else if (e.key === 'a' || e.key === 'A') $('btnFit').click();
});
applyFit();
