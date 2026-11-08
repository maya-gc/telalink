// =============================================================================
//  host.js — painel de quem transmite.
//  Caminho rapido: "Minha tela" -> escolher -> convite ja copiado (3 cliques).
//  Tudo o mais (qualidade, audio, conexao) fica em Configuracoes.
// =============================================================================
import { $, show, openSocket, describeTransport, turnBytesSent, TRANSPORT_LABEL, supportsWebCodecs, caps, newAudioContext } from './common.js';
import { generateSessionKey, deriveKeys, toB64url, SecureChannel } from './crypto.js';
import { BlackScreenDetector, QUALITY, qualityPreset, captureConstraints, senderEncoding, inviteText,
  maxKbpsFor, degradationFor, withBitrateHints, orderCodecs, qualityText } from './media-util.js';
import { RelaySender } from './relay.js';
import { Output, loadImageFiles } from './output.js';
import { drawQr } from './qr.js';

// ------------------------------------------------------------ estado
let tunnel = { status: 'off', url: null, error: null };
let conexao = null;
let prefs = { quality: 'auto', fps: 30, hint: 'motion', audio: true, volume: 100, bitrate: 0, notify: true, priority: 'desempenho', maxDirect: 2, extraAudio: '', extraVolume: 100 };
let policy = 'auto';
let ws, roomId, pin, sessionKey, keys;
let iceServers = [];
let relay = null;
let locked = false;
let output = null;
let usageTimer = null;
const viewers = new Map(); // viewerId -> { channel, pc, transport, turnReported, joinedAt }
const relayViewers = new Set();

window.__telalink = {
  get viewers() { return [...viewers.entries()].map(([id, v]) => ({ id, transport: v.transport })); },
  get relay() { return relay ? { ...relay.stats } : null; },
  // Parametros de envio aplicados a cada espectador (altura efetiva e banda).
  async sending() {
    const out = [];
    for (const v of viewers.values()) {
      for (const s of v.pc?.getSenders() || []) {
        if (s.track?.kind !== 'video') continue;
        const e = s.getParameters().encodings?.[0] || {};
        const h = s.track.getSettings().height || 0;
        out.push({ trackHeight: h, scale: e.scaleResolutionDownBy || 1, height: Math.round(h / (e.scaleResolutionDownBy || 1)), maxBitrate: e.maxBitrate || null, degradation: s.getParameters().degradationPreference || null });
      }
    }
    return out;
  },
  // Qualidade realmente enviada a cada pessoa (resolucao, quadros, banda, codec).
  measure: () => measureSending(),
  relayCodec: () => relay?.codec?.label || null,
  refreshInfo: () => loadInfo(),
  get state() {
    return output ? { source: output.source, paused: output.paused, muted: output.muted, volume: output.volume,
      quality: prefs.quality, fps: prefs.fps, bitrate: prefs.bitrate, locked, policy } : null;
  },
};

// ------------------------------------------------------------ inicio
const PROVIDER_LABEL = { none: 'Nenhum (usa a retransmissão pelo link)', cloudflare: 'Cloudflare TURN', coturn: 'TURN próprio (coturn)', static: 'Usuário e senha fixos' };
const qualityOptions = (sel, value) => {
  sel.textContent = '';
  for (const [k, q] of Object.entries(QUALITY)) {
    const o = document.createElement('option'); o.value = k; o.textContent = q.label; sel.appendChild(o);
  }
  sel.value = value;
};

function renderSummary() {
  const q = qualityPreset(prefs.quality).label.toLowerCase();
  $('summary').textContent = `Qualidade ${q} · ${prefs.fps} quadros/s · Som ${prefs.audio ? 'ligado' : 'desligado'} · ` +
    `${policy === 'relay' ? 'Máxima segurança' : 'Segurança padrão'} — ajuste em ⚙ Configurações`;
}

function renderTunnel() {
  const el = $('tunnelStatus');
  if (tunnel.status === 'on') { el.className = 'pill on'; el.textContent = '● Link externo pronto'; el.title = tunnel.providerName ? `via ${tunnel.providerName}` : ''; }
  else if (tunnel.status === 'starting') { el.className = 'pill wait'; el.textContent = '◌ Preparando link…'; }
  else { el.className = 'pill off'; el.textContent = '○ Só neste computador'; el.title = tunnel.error || ''; }
  if (roomId) {
    const link = linkFor();
    // O servico gratuito de link (localhost.run) troca o endereco de tempos em tempos.
    if (lastTunnelUrl && tunnel.url && tunnel.url !== lastTunnelUrl) {
      show($('linkAlert'), 'warn', '⚠ O endereço do link mudou (o serviço gratuito de link troca o endereço de tempos em tempos). ' +
        'Envie o convite de novo para quem for entrar — use "Copiar convite".');
      document.title = '⚠ Link mudou — TelaLink';
    }
    if (tunnel.url) lastTunnelUrl = tunnel.url;
    $('shareLink').value = link;
    if (!$('qrBox').classList.contains('hidden')) drawQr($('qrCanvas'), link);
  }
  const t = $('sumTunnel');
  if (t) t.textContent = tunnel.status === 'on' ? `Pronto via ${tunnel.providerName || 'túnel'}` : tunnel.status === 'starting' ? 'Preparando…' : (tunnel.error || 'Desligado');
}

function renderConn() {
  if (!conexao) return;
  $('sumMode').textContent = conexao.defaultMode === 'relay' ? 'Máxima segurança' : 'Padrão';
  $('sumTurn').textContent = PROVIDER_LABEL[conexao.provider] + (conexao.turnError ? ` — erro: ${conexao.turnError}` : '');
  $('sumUsage').textContent = conexao.provider === 'none' ? '—'
    : `${conexao.usageGB} GB${conexao.capGB ? ` de ${conexao.capGB} GB` : ' (sem limite)'}${conexao.overCap ? ' — limite atingido, TURN pausado' : ''}`;
}

let firstInfo = true;
async function pollInfo() {
  await loadInfo();
  setTimeout(pollInfo, tunnel.status === 'on' ? 10000 : 2000);
}
async function loadInfo() {
  try {
    const info = await (await fetch('/api/info')).json();
    tunnel = info.tunnel;
    conexao = info.conexao;
    if (firstInfo) {
      firstInfo = false;
      if (info.prefs) prefs = { ...prefs, ...info.prefs };
      policy = info.defaultMode || 'auto';
      renderSummary();
    }
  } catch {}
  renderTunnel();
  renderConn();
}
pollInfo();
renderSummary();
renderBrowserNotes();

// Avisos do que este navegador faz (o resto funciona igual em todos).
function renderBrowserNotes() {
  if (!caps.screenShare) {
    $('btnScreen').disabled = true;
    $('btnScreen').querySelector('.tile-desc').textContent = caps.mobile
      ? 'Celulares e tablets não compartilham a tela pelo navegador. Use um computador (ou envie Imagens).'
      : 'Este navegador não compartilha a tela. Use Chrome, Edge, Brave, Firefox ou Safari atualizados.';
  } else if (!caps.screenAudio) {
    show($('browserNote'), 'warn', `No ${caps.name}, o som do computador não vai junto (limitação do navegador; a imagem funciona normalmente). Para transmitir com som, use Chrome, Edge ou Brave.`);
  }
}

// ------------------------------------------------------------ configuracoes
function openSettings() {
  qualityOptions($('optQuality'), prefs.quality);
  $('optFps').value = String(prefs.fps);
  $('optBitrate').value = String(prefs.bitrate || 0);
  document.querySelector(`input[name=hint][value=${prefs.hint}]`).checked = true;
  document.querySelector(`input[name=priority][value=${prefs.priority || 'desempenho'}]`).checked = true;
  $('optMaxDirect').value = String(prefs.maxDirect ?? 2);
  $('optAudio').checked = prefs.audio;
  ensureExtraOption(prefs.extraAudio);
  $('optExtra').value = prefs.extraAudio || '';
  $('optExtraVolume').value = prefs.extraVolume ?? 100; $('optExtraVolumeTxt').textContent = `${prefs.extraVolume ?? 100}%`;
  $('optNotify').checked = prefs.notify !== false;
  $('optVolume').value = prefs.volume; $('optVolumeTxt').textContent = `${prefs.volume}%`;
  document.querySelector(`input[name=policy][value=${policy}]`).checked = true;
  $('optTunnel').value = conexao?.tunnel || 'auto';
  $('settingsMsg').textContent = '';
  renderTunnel(); renderConn();
  $('settings').showModal();
}
const closeSettings = () => $('settings').close();
$('btnSettings').onclick = openSettings;
$('btnCloseSettings').onclick = closeSettings;
$('btnCancelSettings').onclick = closeSettings;
$('optVolume').oninput = () => { $('optVolumeTxt').textContent = `${$('optVolume').value}%`; };

$('btnSaveSettings').onclick = async () => {
  const next = {
    quality: $('optQuality').value, fps: Number($('optFps').value),
    hint: document.querySelector('input[name=hint]:checked').value,
    audio: $('optAudio').checked, volume: Number($('optVolume').value),
    bitrate: Number($('optBitrate').value),
    notify: $('optNotify').checked,
    priority: document.querySelector('input[name=priority]:checked').value,
    extraAudio: $('optExtra').value, extraVolume: Number($('optExtraVolume').value),
    maxDirect: Number($('optMaxDirect').value),
  };
  const nextPolicy = document.querySelector('input[name=policy]:checked').value;
  const nextTunnel = $('optTunnel').value;
  const live = !!(output && roomId);
  const before = { ...prefs }, beforePolicy = policy;
  // Vale na hora para esta sessao, SEM interromper a transmissao...
  prefs = next; policy = nextPolicy;
  renderSummary();
  closeSettings();                     // fecha na hora; o resto segue em segundo plano
  // Trocar o tipo de link durante a transmissao mudaria o endereco e derrubaria
  // quem assiste pelo link: vale a partir da proxima transmissao.
  const tunnelChanged = nextTunnel !== (conexao?.tunnel || 'auto');
  if (live && tunnelChanged) pendingTunnel = nextTunnel;
  // Salva neste PC (em paralelo) e aplica na transmissao em andamento.
  const body = { prefs: next, defaultMode: nextPolicy, ...(live && tunnelChanged ? {} : { tunnel: nextTunnel }) };
  const saving = fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => {
      if (r.ok) { const s = await r.json(); conexao = { ...(conexao || {}), tunnel: s.tunnel, defaultMode: s.defaultMode }; }
      else if (r.status !== 404) toast('Não foi possível salvar as configurações neste computador.');
    }).catch(() => {});
  if (live) await applyLive(before, beforePolicy);
  await saving;
};

// ------------------------------------------------------------ som
// Sem som na captura: explica o que fazer conforme o que foi escolhido.
function warnNoAudio(stream) {
  if (!prefs.audio || stream.getAudioTracks().length) return show($('shareMsg'), '', '');
  if (prefs.extraAudio) return;                                  // vai o som somado
  const surface = stream.getVideoTracks()[0]?.getSettings().displaySurface;
  const msg = !caps.screenAudio
    ? `O ${caps.name} não captura o som da tela. Para levar som, em ⚙ Configurações → Áudio escolha “Somar também” (microfone ou um dispositivo de som).`
    : surface === 'window'
      ? 'Esta janela veio sem som. Para levar só o som deste programa, use Chrome ou Edge 141+ e deixe marcado “Compartilhar o áudio” ao escolher a janela (🔄 Trocar). Ou escolha “Tela inteira” para levar o som de todo o computador.'
      : 'Sem som: na janela de escolha, deixe marcado “Compartilhar áudio” (em “Aba” ou “Tela inteira”).';
  show($('shareMsg'), 'warn', msg);
}
// Microfone ou dispositivo somado ao som da transmissao.
async function applyExtraAudio() {
  if (!output) return;
  const want = prefs.extraAudio || '';
  if (want === (output.extraKey || '') && (!want || output.extra)) { output.setExtraVolume(prefs.extraVolume ?? 100); return renderLive(); }
  output.extraKey = want;
  if (!want) { output.setExtraAudio(null); return renderLive(); }
  try {
    const isMic = want === 'mic';
    // Microfone: com reducao de eco/ruido. Dispositivo (cabo virtual, mixagem): som puro.
    const audio = isMic ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      : { deviceId: { exact: want.slice(4) }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 };
    const s = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    output.setExtraAudio(s, prefs.extraVolume ?? 100);
    if (roomId) toast(isMic ? '🎙 Microfone somado à transmissão.' : '🔊 Dispositivo de som somado à transmissão.');
  } catch (err) {
    output.extraKey = '';
    show($('shareMsg'), 'warn', `Não foi possível usar ${want === 'mic' ? 'o microfone' : 'o dispositivo de som'}: ${err?.name === 'NotAllowedError' ? 'permissão negada no navegador' : 'dispositivo indisponível'}.`);
  }
  renderLive();
}
function ensureExtraOption(value) {
  if (!value?.startsWith('dev:') || [...$('optExtra').options].some((o) => o.value === value)) return;
  const o = document.createElement('option'); o.value = value; o.textContent = 'Dispositivo escolhido antes'; $('optExtra').appendChild(o);
}
$('btnListDevices').onclick = async () => {
  try {
    // Os nomes dos dispositivos so aparecem depois de uma permissao de microfone.
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    tmp?.getTracks().forEach((t) => t.stop());
    const sel = $('optExtra'), cur = sel.value;
    for (const o of [...sel.options]) if (o.value.startsWith('dev:')) o.remove();
    devs.forEach((d, i) => { const o = document.createElement('option'); o.value = `dev:${d.deviceId}`; o.textContent = d.label || `Dispositivo de som ${i + 1}`; sel.appendChild(o); });
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : sel.value;
    $('settingsMsg').textContent = devs.length ? `${devs.length} dispositivo(s) encontrado(s).` : 'Nenhum outro dispositivo encontrado.';
  } catch { $('settingsMsg').textContent = 'Não foi possível listar os dispositivos de som.'; }
};
$('optExtraVolume').oninput = () => { $('optExtraVolumeTxt').textContent = `${$('optExtraVolume').value}%`; };
$('btnExtra').onclick = () => output?.setExtraMuted(!output.extra?.muted);

// Aplica as configuracoes na transmissao em andamento, nos DOIS lados:
// quem transmite (captura/envio) e quem assiste (recebe aviso; muda de caminho
// se a seguranca mudou). Nada e reiniciado.
let pendingTunnel = null;
async function applyLive(before, beforePolicy) {
  try { if (output.screenTrack) output.screenTrack.contentHint = prefs.hint; } catch {}
  await applyQuality();
  if (prefs.volume !== before.volume) output.setVolume(prefs.volume);
  if (prefs.extraAudio !== before.extraAudio || prefs.extraVolume !== before.extraVolume) await applyExtraAudio();
  if (prefs.audio !== before.audio) {
    if (!prefs.audio) output.setMuted(true);
    else if (output.hasSourceAudio) output.setMuted(false);
    else show($('shareMsg'), 'warn', 'Para incluir o som agora, clique em “Trocar” → “Outra tela/janela” e marque “Compartilhar áudio”.');
  }
  const q = qualityPreset(prefs.quality);
  const text = `${q.label} · ${prefs.fps} qps${prefs.bitrate ? ` · até ${prefs.bitrate} Mbps` : ''}`;
  for (const id of viewers.keys()) {
    sendSig(id, { kind: 'settings', text }).catch(() => {});
    if (policy !== beforePolicy) sendSig(id, { kind: 'policy', policy }).catch(() => {});
  }
  const extra = pendingTunnel ? ' O novo tipo de link vale na próxima transmissão.' : '';
  toast(`✅ Aplicado sem interromper: ${text}.${policy !== beforePolicy ? (policy === 'relay' ? ' Quem assiste passou para a Máxima segurança.' : ' Segurança padrão.') : ''}${extra}`);
}

// ------------------------------------------------------------ comecar (2o clique)
// A tela e capturada JA na resolucao maxima (ate 4K): mudar a qualidade depois
// so ajusta o ENVIO (instantaneo e seguro). Pedir ao navegador para recapturar
// em resolucao maior durante a transmissao congela ou encerra a captura em
// alguns computadores.
// Altura NATIVA da tela (tamanho x escala do Windows), ate 4K: pedir mais que
// isso faz alguns capturadores ampliarem a imagem a toa (gasta processador).
const NATIVE_H = Math.min(2160, Math.max(720, Math.round((globalThis.screen?.height || 1080) * (globalThis.devicePixelRatio || 1))));
// Desempenho: captura SO a resolucao que a qualidade escolhida usa (ex.: monitor
// 4K com qualidade 1080p captura em 1080p: 4x menos pixels para processar).
let captureH = NATIVE_H;
let captureFps = 30;                     // teto de quadros/s pedido na captura atual
const wantedH = () => Math.min(NATIVE_H, qualityPreset(prefs.quality).maxH);
function captureOptions() {
  captureFps = prefs.fps > 30 ? 60 : 30;
  captureH = wantedH();
  return {
    video: { height: { max: captureH }, frameRate: { ideal: prefs.fps, max: captureFps } },
    // restrictOwnAudio: tira da captura os sons do proprio TelaLink (ex.: o aviso de entrada).
    audio: prefs.audio && caps.screenAudio ? { suppressLocalAudioPlayback: false, restrictOwnAudio: true } : false,
    systemAudio: prefs.audio ? 'include' : 'exclude',
    // Chrome/Edge 141+: ao escolher uma JANELA, oferece o som SO daquele programa.
    windowAudio: prefs.audio ? 'window' : 'exclude',
    surfaceSwitching: 'include',
    selfBrowserSurface: 'exclude',
    monitorTypeSurfaces: 'include',
  };
}

async function pickScreen() {
  let stream;
  try { stream = await navigator.mediaDevices.getDisplayMedia(captureOptions()); }
  catch (err) {
    // Navegadores mais antigos recusam alguma opcao: tenta o pedido mais simples.
    if (err?.name !== 'TypeError' && err?.name !== 'OverconstrainedError' && err?.name !== 'NotSupportedError') throw err;
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  }
  const v = stream.getVideoTracks()[0];
  try { v.contentHint = prefs.hint; } catch {}
  v.addEventListener('ended', () => { if (output?.screen === stream) onCaptureEnded(); });
  return stream;
}
// A captura parou (botao "Parar de compartilhar" do navegador, janela fechada...):
// a transmissao NAO fecha. Quem assiste ve "pausada"; quem transmite escolhe de novo ou encerra.
function onCaptureEnded() {
  if (!output || !roomId) return;
  output.setPaused(true);
  $('captureEnded').classList.remove('hidden');
  toast('⏸ O compartilhamento da tela parou. Quem assiste vê “Transmissão pausada”.');
}
$('btnRepick').onclick = async () => {
  try {
    const s = await pickScreen();
    output.useScreen(s);
    output.setPaused(false);
    $('captureEnded').classList.add('hidden');
    await applyQuality();
  } catch { toast('Escolha cancelada: a transmissão continua pausada.'); }
};
$('btnEndNow').onclick = () => { $('captureEnded').classList.add('hidden'); stopAll(); };

$('btnScreen').onclick = async () => {
  if (!checkPolicy()) return;
  ensureOutput();
  let stream;
  try { stream = await pickScreen(); }
  catch { return show($('homeMsg'), 'err', 'Captura cancelada ou não permitida pelo navegador.'); }
  output.useScreen(stream);
  warnNoAudio(stream);
  await goLive();
};

$('btnImages').onclick = () => { if (!checkPolicy()) return; ensureOutput(); $('fileImages').click(); };
$('fileImages').onchange = async () => {
  const imgs = await loadImageFiles($('fileImages').files);
  $('fileImages').value = '';
  if (!imgs.length) return show(roomId ? $('shareMsg') : $('homeMsg'), 'err', 'Nenhuma imagem válida escolhida.');
  ensureOutput();
  if (output.source === 'images' && $('fileImages').dataset.mode === 'add') output.addImages(imgs);
  else output.useImages(imgs);
  $('fileImages').dataset.mode = '';
  if (!roomId) await goLive();
};

function checkPolicy() {
  if (policy === 'relay' && !supportsWebCodecs()) {
    show($('homeMsg'), 'err', `O ${caps.name} desta versão não suporta o modo Máxima segurança. Atualize o navegador ou use Chrome, Edge, Brave, Firefox (130+) ou Safari (16.4+).`);
    return false;
  }
  return true;
}

function ensureOutput() {
  if (output) return;
  output = new Output({ onVideoTrack: (track) => onVideoTrackChanged(track), onChange: renderLive });
  output.init();
  output.setVolume(prefs.volume);
}

// ------------------------------------------------------------ ao vivo
let lastTunnelUrl = null;
let liveSince = 0;
const shareBase = () => tunnel.url || location.origin;
const linkFor = () => `${shareBase()}/view?room=${roomId}#k=${toB64url(sessionKey)}`;

async function goLive() {
  const res = await fetch('/api/create-room', { method: 'POST' });
  ({ roomId, pin } = await res.json());
  sessionKey = generateSessionKey();
  keys = await deriveKeys(sessionKey, roomId);

  $('pinView').textContent = pin;
  $('preview').srcObject = output.stream;
  // Quando a resolucao real da fonte muda (troca de tela, janela redimensionada), recalcula o envio.
  $('preview').onresize = () => { for (const v of viewers.values()) setSenderQuality(v.pc); };
  qualityOptions($('liveQuality'), prefs.quality);
  $('home').classList.add('hidden');
  $('live').classList.remove('hidden');
  renderTunnel();
  renderLive();
  connect();
  watchBlackScreen();
  usageTimer = setInterval(reportTurnUsage, 30_000);
  liveSince = Date.now();
  clockTimer = setInterval(renderClock, 1000);
  // 3o clique ja foi o da janela de escolha: o convite vai sozinho para a area de transferencia.
  copyInvite(true);
  applyExtraAudio();                     // microfone/dispositivo somado, se escolhido
}

// ------------------------------------------------------------ relogio, titulo, avisos
let clockTimer = null;
const fmtTime = (ms) => {
  const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
};
function renderClock() {
  if (!output || !liveSince) return;
  const watching = [...viewers.values()].filter((v) => v.transport !== 'conectando').length;
  $('liveTxt').textContent = `${output.paused ? 'Pausado' : 'Ao vivo'} · ${fmtTime(Date.now() - liveSince)}`;
  if (!document.title.startsWith('⚠')) document.title = `${output.paused ? '❚❚ Pausado' : '● Ao vivo'}${watching ? ` (${watching})` : ''} — TelaLink`;
}
// Aviso sonoro curto e discreto (so neste computador).
let chimeCtx = null;
function chime(up = true) {
  if (prefs.notify === false) return;
  try {
    chimeCtx ||= newAudioContext();
    const t = chimeCtx.currentTime, o = chimeCtx.createOscillator(), g = chimeCtx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(up ? 660 : 520, t);
    o.frequency.setValueAtTime(up ? 880 : 390, t + 0.09);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.connect(g).connect(chimeCtx.destination);
    o.start(t); o.stop(t + 0.3);
  } catch {}
}
// Painel em segundo plano (ex.: jogando): pausa a pre-visualizacao e o detector
// de tela preta. A transmissao continua (no Chrome/Edge/Brave ela le a propria
// trilha de video, nao a pre-visualizacao).
document.addEventListener('visibilitychange', () => {
  const v = $('preview');
  if (!v?.srcObject || !caps.chromium) return;
  if (document.hidden) v.pause(); else v.play().catch(() => {});
});

// Fechar a aba sem querer encerraria a transmissao: o navegador pergunta antes.
window.addEventListener('beforeunload', (e) => { if (output && roomId) { e.preventDefault(); e.returnValue = ''; } });

$('btnQr').onclick = () => {
  const box = $('qrBox');
  const open = box.classList.toggle('hidden') === false;
  $('btnQr').setAttribute('aria-expanded', String(open));
  if (open) drawQr($('qrCanvas'), linkFor());
};
$('btnNewPin').onclick = () => ws?.json({ type: 'new-pin' });

async function copyInvite(auto = false) {
  try {
    await navigator.clipboard.writeText(inviteText($('shareLink').value, pin));
    toast(auto ? '✅ Convite copiado! Cole no WhatsApp ou e-mail.' : '✅ Convite copiado!');
  } catch {
    if (!auto) toast('Não foi possível copiar automaticamente. Selecione o link e copie.');
  }
}
function toast(text) {
  const t = $('toast');
  t.textContent = text; t.classList.remove('hidden');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.add('hidden'), 4000);
}
$('btnCopyInvite').onclick = () => copyInvite();
$('btnCopyLink').onclick = async () => { try { await navigator.clipboard.writeText($('shareLink').value); toast('✅ Link copiado!'); } catch {} };

function renderLive() {
  if (!output || !roomId) return;
  $('btnPause').textContent = output.paused ? '▶ Retomar' : '⏸ Pausar';
  $('btnPause').classList.toggle('active', output.paused);
  $('btnMute').textContent = output.muted ? '🔇 Sem som' : '🔊 Som ligado';
  $('btnMute').classList.toggle('active', output.muted);
  $('volume').value = output.volume;
  $('volumeTxt').textContent = `${output.volume}%`;
  renderClock();
  $('liveDot').classList.toggle('live', !output.paused);
  $('btnLock').textContent = locked ? '🔒 Sala trancada' : '🔓 Sala aberta';
  $('btnLock').setAttribute('aria-pressed', String(locked));
  $('btnLock').classList.toggle('active', locked);
  $('btnExtra').classList.toggle('hidden', !output.extra);
  if (output.extra) {
    const mic = output.extraKey === 'mic';
    $('btnExtra').textContent = `${mic ? '🎙 Microfone' : '🔈 Som somado'} ${output.extra.muted ? 'desligado' : 'ligado'}`;
    $('btnExtra').classList.toggle('active', output.extra.muted);
  }
  const img = output.source === 'images';
  $('imgControls').classList.toggle('hidden', !img);
  if (img) $('imgPos').textContent = `${output.imageIndex + 1} de ${output.images.length}`;
}

$('btnPause').onclick = () => output.setPaused(!output.paused);
$('btnMute').onclick = () => output.setMuted(!output.muted);
$('volume').oninput = () => output.setVolume(Number($('volume').value));
$('liveQuality').onchange = () => { prefs.quality = $('liveQuality').value; applyQuality(); renderSummary(); };
$('btnLock').onclick = () => ws.json({ type: 'lock', locked: !locked });
$('btnSwitch').onclick = () => $('switchMenu').classList.toggle('hidden');
$('swScreen').onclick = async () => {
  $('switchMenu').classList.add('hidden');
  try { const s = await pickScreen(); output.useScreen(s); warnNoAudio(s); applyQuality(); }
  catch { show($('shareMsg'), 'warn', 'Troca cancelada: continua mostrando o mesmo conteúdo.'); }
};
$('swImages').onclick = () => { $('switchMenu').classList.add('hidden'); $('fileImages').dataset.mode = ''; $('fileImages').click(); };
$('imgPrev').onclick = () => output.showImage(-1);
$('imgNext').onclick = () => output.showImage(1);
$('imgAdd').onclick = () => { $('fileImages').dataset.mode = 'add'; $('fileImages').click(); };
document.addEventListener('keydown', (e) => {
  if (output?.source !== 'images' || $('settings').open || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'ArrowRight') output.showImage(1);
  if (e.key === 'ArrowLeft') output.showImage(-1);
});

// Aplica qualidade/quadros em todos os caminhos (captura, WebRTC, retransmissao).
async function applyQuality() {
  if (!output) return;
  // 1) A captura so muda para AUMENTAR os quadros/s (30 -> 60), com verificacao:
  //    se a imagem parar, o ajuste e desfeito. Resolucao e reducoes ficam com o envio.
  const track = output.screenTrack;
  //    Subir a resolucao (ate a nativa) tambem passa por aqui, com a mesma verificacao.
  const needH = Math.max(captureH, wantedH()), needFps = Math.max(captureFps, prefs.fps > 30 ? 60 : 30);
  if (track && (needH > captureH || needFps > captureFps)) {
    const ok = await safeApply(track, { height: { max: needH }, frameRate: { ideal: prefs.fps, max: needFps } },
      { height: { max: captureH }, frameRate: { ideal: captureFps, max: captureFps } });
    if (ok) { captureH = needH; captureFps = needFps; }
    else toast(`A tela não aceitou ${needH > captureH ? `${needH}p` : `${prefs.fps} quadros/s`} agora. Para isso, use 🔄 Trocar e escolha a tela de novo.`);
  }
  // 2) ajusta o envio de cada pessoa (resolucao, banda, quadros/s)
  for (const v of viewers.values()) await setSenderQuality(v.pc);
  relay?.setQuality(relayQuality());
  relay?.setPriority?.(prefs.priority);
}
// Altura real dos quadros da tela (o <video> de pre-visualizacao mostra os
// quadros de verdade; getSettings() as vezes informa o valor pedido, nao o real).
function sourceHeight() {
  if (output?.source === 'screen' && !output.paused) return $('preview').videoHeight || output.sourceHeight;
  return output?.sourceHeight || 0;
}
// Aplica restricoes na captura e confere que a imagem continua chegando;
// se parar (ou falhar), volta ao que estava.
const framesNow = () => { try { return $('preview').getVideoPlaybackQuality?.().totalVideoFrames ?? Math.round($('preview').currentTime * 1000); } catch { return 0; } };
async function safeApply(track, constraints, previous) {
  const start = framesNow();
  try { await track.applyConstraints(constraints); } catch { return false; }
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (track.readyState !== 'live') return false;
    if (framesNow() > start + 1) return true;
  }
  try { await track.applyConstraints(previous); } catch {}
  return false;
}
function relayQuality() {
  const q = qualityPreset(prefs.quality);
  return { maxH: q.maxH, bitrate: maxKbpsFor(prefs.quality, { fps: prefs.fps, limitMbps: prefs.bitrate }) * 1000, fps: prefs.fps, autoRes: prefs.quality === 'auto' };
}
async function setSenderQuality(pc) {
  if (!pc) return;
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== 'video') continue;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    const enc = senderEncoding(prefs.quality, prefs.fps, sourceHeight(), { limitMbps: prefs.bitrate });
    Object.assign(params.encodings[0], enc);
    params.degradationPreference = degradationFor(prefs.quality, prefs.hint);
    await sender.setParameters(params).catch((e) => console.warn('[telalink qualidade]', e));
  }
}

// Fonte de video mudou (tela/imagem/pausa): troca em quem ja esta assistindo.
function onVideoTrackChanged(track) {
  for (const v of viewers.values()) {
    if (v.pc && v.videoSender) v.videoSender.replaceTrack(track).then(() => setSenderQuality(v.pc)).catch(() => {});
  }
  relay?.replaceVideoTrack(track);
}

// ------------------------------------------------------------ sinalizacao
function connect() {
  ws = openSocket({
    onJson: async (m) => {
      if (m.type === 'host-ready') { iceServers = m.iceServers || []; probeDirect(); }
      else if (m.type === 'viewer-joined') await onViewerJoined(m.viewerId);
      else if (m.type === 'signal' && m.from === 'viewer') await onViewerSignal(m.viewerId, m.data);
      else if (m.type === 'viewer-left') onViewerLeft(m.viewerId);
      else if (m.type === 'relay-want') onRelayWant(m.viewerId);
      else if (m.type === 'relay-keyframe') relay?.requestKeyframe();
      else if (m.type === 'pin') {
        pin = m.pin; $('pinView').textContent = pin; show($('pinAlert'), '', '');
        await copyInvite(true);
        toast(`🔑 Novo PIN: ${pin} — convite copiado de novo. Quem já assiste continua.`);
      } else if (m.type === 'pin-failures') {
        const pausa = m.lockedUntil > Date.now() ? ' Novas entradas estão em pausa por alguns minutos.' : '';
        show($('pinAlert'), 'warn', `⚠ ${m.count} tentativa${m.count > 1 ? 's' : ''} de PIN errada${m.count > 1 ? 's' : ''}.${pausa} Se não for alguém que você convidou, clique em "↻ Novo PIN".`);
      }
      else if (m.type === 'locked') { locked = m.locked; renderLive(); toast(locked ? '🔒 Sala trancada: ninguém novo entra.' : '🔓 Sala aberta para novas pessoas.'); }
      else if (m.type === 'error') show($('shareMsg'), 'err', 'Erro na sala: ' + m.reason);
      renderViewers();
    },
    onClose: () => { if (output) show($('shareMsg'), 'err', 'Conexão com o servidor caiu. Recarregue para reabrir a sala.'); },
  });
  ws.opened.then(() => ws.json({ type: 'host-join', roomId }));
}

async function sendSig(viewerId, payload) {
  const v = viewers.get(viewerId);
  if (!v) return;
  ws.json({ type: 'signal', viewerId, data: await v.channel.seal('h2v', payload) });
}

async function onViewerJoined(viewerId) {
  toast(`👋 Alguém entrou na transmissão (${viewers.size + 1} ${viewers.size ? 'pessoas' : 'pessoa'}).`);
  chime(true);
  viewers.set(viewerId, { channel: new SecureChannel(keys.sig, `${roomId}|${viewerId}`), pc: null, transport: 'conectando', turnReported: 0, joinedAt: Date.now() });
  // Acima do limite de conexoes diretas, a pessoa recebe pela retransmissao,
  // que usa UMA codificacao para todos (o processador nao cresce por pessoa).
  const direct = [...viewers.values()].filter((v) => v.pc).length;
  const shared = policy === 'auto' && ((prefs.maxDirect > 0 && direct >= prefs.maxDirect) || directBlocked === true);
  viewers.get(viewerId).shared = shared;
  await sendSig(viewerId, { kind: 'hello', policy: shared ? 'relay' : policy });
  if (policy === 'auto' && !shared) await createOffer(viewerId);
}

async function onViewerSignal(viewerId, envelope) {
  const v = viewers.get(viewerId);
  if (!v) return;
  let p;
  try { p = await v.channel.open('v2h', envelope); }
  catch { console.warn('[telalink] mensagem nao autenticada descartada'); return; }
  if (p.kind === 'sdp' && v.pc) {
    // Comeca com banda alta (o padrao do navegador e ~0,3 Mbps = 360p por varios segundos).
    const max = maxKbpsFor(prefs.quality, { fps: prefs.fps, limitMbps: prefs.bitrate });
    const start = Math.min(qualityPreset(prefs.quality).startKbps, max);
    // Se um navegador futuro recusar o ajuste (parametros nao padronizados),
    // segue sem ele: so a subida de banda fica mais lenta.
    try { await v.pc.setRemoteDescription({ type: p.sdp.type, sdp: withBitrateHints(p.sdp.sdp, { startKbps: start, maxKbps: max }) }); }
    catch (err) { console.warn('[telalink] ajuste de banda recusado; seguindo sem ele', err); await v.pc.setRemoteDescription(p.sdp); }
  }
  else if (p.kind === 'ice' && v.pc) await v.pc.addIceCandidate(p.candidate).catch(() => {});
  else if (p.kind === 'transport') {
    v.transport = p.mode;
    // Saiu da retransmissao para a conexao direta (ex.: voltou a Seguranca padrao).
    if (p.mode !== 'retransmissao' && relayViewers.delete(viewerId) && relayViewers.size === 0) { relay?.stop(); relay = null; }
  }
  else if (p.kind === 'bye-p2p') { v.pc?.close(); v.pc = null; }
  else if (p.kind === 'want-p2p' && policy === 'auto' && !v.pc) await createOffer(viewerId);
  else if (p.kind === 'relay-caps') { v.relayCodecs = Array.isArray(p.codecs) ? p.codecs.slice(0, 10) : null; updateRelayCodecs(); }
}

// Codecs que este PC codifica por hardware (menos processador = imagem mais estavel).
let hwCodecsPromise = null;
function hwCodecs() {
  hwCodecsPromise ||= (async () => {
    const set = new Set();
    if (!navigator.mediaCapabilities?.encodingInfo) return set;
    for (const t of ['video/VP9', 'video/H264', 'video/AV1']) {
      try {
        const r = await navigator.mediaCapabilities.encodingInfo({ type: 'webrtc', video: { contentType: t, width: 1920, height: 1080, bitrate: 8_000_000, framerate: 30 } });
        if (r.supported && r.powerEfficient) set.add(t.toLowerCase());
      } catch {}
    }
    return set;
  })();
  return hwCodecsPromise;
}
async function preferCodecs(pc) {
  const caps = globalThis.RTCRtpSender?.getCapabilities?.('video');
  if (!caps) return;
  const order = orderCodecs(caps.codecs, await hwCodecs(), prefs.priority);
  for (const t of pc.getTransceivers()) {
    if (t.sender.track?.kind === 'video' && t.setCodecPreferences) try { t.setCodecPreferences(order); } catch {}
  }
}

// ------------------------------------------------------------ conexao direta possivel?
// Alguns navegadores bloqueiam a conexao direta (ex.: Brave com protecao contra
// fingerprinting = "Desativar UDP sem proxy"; VPNs/extensoes). Sem testar, quem
// assiste esperava ~12 s sem explicacao ate a retransmissao. Agora: testa uma vez
// e, se nao der, todos ja entram pela retransmissao.
let directBlocked = null;               // null = ainda testando
async function probeDirect() {
  if (typeof RTCPeerConnection !== 'function') { directBlocked = true; return renderDirectNote(); }
  const pc = new RTCPeerConnection({ iceServers });
  let n = 0;
  pc.onicecandidate = (e) => { if (e.candidate && e.candidate.candidate) n++; };
  try {
    pc.createDataChannel('teste');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((r) => { const t = setTimeout(r, 3000); pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); r(); } }; });
  } catch {}
  pc.close();
  directBlocked = n === 0;
  renderDirectNote();
}
function renderDirectNote() {
  if (!directBlocked) return show($('directNote'), '', '');
  show($('directNote'), 'warn', `Seu navegador (${caps.name}) está bloqueando a conexão direta${caps.name === 'Brave' ? ' — no Brave, isso acontece com a proteção contra fingerprinting dos Escudos' : ''}. ` +
    'Sem problema: quem assistir recebe pela retransmissão pelo link (um pouco mais de atraso). ' +
    (caps.name === 'Brave' ? 'Para a conexão direta: clique no ícone do leão (Escudos) na barra de endereço deste painel e desative "Bloquear fingerprinting", ou use o Chrome/Edge.' : 'Para a conexão direta, desative a extensão/VPN que bloqueia o WebRTC ou use outro navegador.'));
}

async function createOffer(viewerId) {
  const v = viewers.get(viewerId);
  const pc = new RTCPeerConnection({ iceServers });
  v.pc = pc;
  for (const track of output.stream.getTracks()) {
    const sender = pc.addTrack(track, output.stream);
    if (track.kind === 'video') v.videoSender = sender;
  }
  await preferCodecs(pc);
  await setSenderQuality(pc);
  let sentCandidates = 0;
  pc.onicecandidate = (e) => { if (e.candidate) { sentCandidates++; sendSig(viewerId, { kind: 'ice', candidate: e.candidate.toJSON() }); } };
  pc.onicegatheringstatechange = () => {
    // Nenhum caminho deste lado: avisa quem assiste para trocar ja para a retransmissao.
    if (pc.iceGatheringState === 'complete' && sentCandidates === 0) sendSig(viewerId, { kind: 'no-direct' }).catch(() => {});
  };
  pc.onconnectionstatechange = async () => {
    if (pc.connectionState === 'connected') { v.transport = await describeTransport(pc); await setSenderQuality(pc); renderViewers(); }
    else if (pc.connectionState === 'failed') { pc.close(); if (v.pc === pc) v.pc = null; }
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await sendSig(viewerId, { kind: 'sdp', sdp: pc.localDescription.toJSON() });
}

// Codecs da retransmissao que TODOS os espectadores conseguem decodificar.
function updateRelayCodecs() {
  const lists = [...relayViewers].map((id) => viewers.get(id)?.relayCodecs).filter(Boolean);
  relay?.setAllowedCodecs(lists.length ? lists.reduce((a, b) => a.filter((c) => b.includes(c))) : null);
}

function onRelayWant(viewerId) {
  const v = viewers.get(viewerId);
  if (v) { v.transport = 'retransmissao'; v.pc?.close(); v.pc = null; }
  relayViewers.add(viewerId);
  if (!relay) {
    relay = new RelaySender({
      stream: output.stream, mediaKey: keys.media, ws, previewVideo: $('preview'),
      audioContext: output.ctx,            // Firefox/Safari: som da retransmissao via AudioWorklet
      priority: prefs.priority,
      ...relayQuality(),
      onError: (e) => console.warn('[telalink relay]', e),
    });
  }
  relay.start();
  updateRelayCodecs();
  relay.requestKeyframe();
}

// Espectador saiu do servidor. Se a conexao direta dele ainda funciona (ex.: o
// link externo caiu ou mudou de endereco), a imagem continua ate ela cair.
// Quem foi REMOVIDO pelo host perde a imagem na hora.
const kicking = new Set();
function onViewerLeft(viewerId) {
  const v = viewers.get(viewerId);
  if (v?.pc && v.pc.connectionState === 'connected' && !kicking.has(viewerId)) {
    v.detached = true;
    const pc = v.pc;
    const check = () => { if (pc.connectionState !== 'connected' && viewers.get(viewerId)?.pc === pc) { closeViewer(viewerId); renderViewers(); } };
    pc.addEventListener('connectionstatechange', check);
    return;
  }
  kicking.delete(viewerId);
  closeViewer(viewerId);
}

function closeViewer(viewerId, quiet = false) {
  const v = viewers.get(viewerId);
  if (v && !quiet) { toast('Uma pessoa saiu da transmissão.'); chime(false); }
  v?.pc?.close();
  viewers.delete(viewerId);
  relayViewers.delete(viewerId);
  if (relay && relayViewers.size === 0) { relay.stop(); relay = null; }
}

function renderViewers() {
  const list = $('viewerList');
  list.textContent = '';
  let n = 0;
  if (!viewers.size) {
    const li = document.createElement('li'); li.className = 'hint'; li.textContent = 'Ninguém ainda. Envie o convite.';
    list.appendChild(li);
  }
  let i = 0;
  for (const [id, v] of viewers) {
    i++;
    if (v.transport !== 'conectando') n++;
    const li = document.createElement('li');
    const name = document.createElement('span'); name.textContent = `Pessoa ${i}`;
    const right = document.createElement('span'); right.className = 'row';
    const secs = Math.round((Date.now() - v.joinedAt) / 1000);
    const stuck = v.transport === 'conectando' && secs >= 15;
    const how = document.createElement('span'); how.className = stuck ? 'stat warn-txt' : 'stat'; how.textContent = v.transport === 'conectando'
      ? (stuck ? `⚠ conectando há ${secs} s — peça para a pessoa tocar em “Copiar diagnóstico” e te enviar` : `conectando… ${secs} s`) : (TRANSPORT_LABEL[v.transport] || v.transport) + (v.detached ? ' (sem contato com o servidor)' : '') + (v.shared && v.transport === 'retransmissao' ? ' · codificação compartilhada' : '');
    const kick = document.createElement('button'); kick.className = 'ghost small'; kick.textContent = 'Remover';
    kick.dataset.viewer = id;
    kick.onclick = () => { kicking.add(id); if (v.detached) { closeViewer(id); renderViewers(); } else ws.json({ type: 'kick', viewerId: id }); };
    const qual = document.createElement('span'); qual.className = 'stat q'; qual.dataset.q = id; qual.textContent = v.qtext || '';
    right.append(qual, how, kick);
    li.append(name, right);
    list.appendChild(li);
  }
  $('viewerCount').textContent = n;
}

// ------------------------------------------------------------ qualidade enviada
const LIMIT_TXT = { bandwidth: 'limitado pela internet', cpu: 'limitado pelo processador' };
async function measureSending() {
  const out = [];
  for (const [id, v] of viewers) {
    let q = null;
    if (v.transport === 'retransmissao' && relay) q = relay.quality();
    else if (v.pc) {
      try {
        const st = await v.pc.getStats();
        st.forEach((r) => {
          if (r.type !== 'outbound-rtp' || r.kind !== 'video') return;
          const now = r.timestamp, bytes = r.bytesSent;
          const bps = v.lastOut ? ((bytes - v.lastOut.bytes) * 8 * 1000) / Math.max(1, now - v.lastOut.t) : 0;
          v.lastOut = { bytes, t: now };
          const codec = st.get(r.codecId)?.mimeType?.split('/')[1];
          // powerEfficientEncoder: o navegador diz se a codificacao e pela placa de video.
          q = { height: r.frameHeight, width: r.frameWidth, fps: r.framesPerSecond, bps, codec, limit: r.qualityLimitationReason,
            hw: typeof r.powerEfficientEncoder === 'boolean' ? r.powerEfficientEncoder : null };
        });
      } catch {}
    }
    v.quality = q;
    const enc = q?.hw === true ? 'placa de vídeo' : q?.hw === false ? 'processador' : null;
    v.qtext = q ? [qualityText(q), q.codec && (enc ? `${q.codec} (${enc})` : q.codec), LIMIT_TXT[q.limit]].filter(Boolean).join(' · ') : '';
    const el = document.querySelector(`#viewerList [data-q="${id}"]`);
    if (el) el.textContent = v.qtext;
    out.push({ id, transport: v.transport, ...(q || {}) });
  }
  return out;
}
setInterval(() => {
  if (!viewers.size) return;
  measureSending();
  if ([...viewers.values()].some((v) => v.transport === 'conectando')) renderViewers();   // atualiza o tempo de espera
}, 2000);

// ------------------------------------------------------------ consumo TURN
async function reportTurnUsage() {
  let delta = 0;
  for (const v of viewers.values()) {
    if (!v.pc) continue;
    const total = await turnBytesSent(v.pc);
    if (total > v.turnReported) { delta += total - v.turnReported; v.turnReported = total; }
  }
  if (delta > 0) ws.json({ type: 'turn-usage', bytes: delta * 2 }); // x2: estimativa conservadora
}

// ------------------------------------------------------------ tela preta
function watchBlackScreen() {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 36;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const det = new BlackScreenDetector({ samples: 4 });
  const timer = setInterval(() => {
    if (!output) return clearInterval(timer);
    const video = $('preview');
    if (document.hidden) return;                       // painel escondido: nao gasta nada
    if (output.source !== 'screen' || output.paused || video.readyState < 2) { det.count = 0; $('blackWarning').classList.add('hidden'); return; }
    ctx.drawImage(video, 0, 0, 64, 36);
    const change = det.push(ctx.getImageData(0, 0, 64, 36).data);
    if (change === true) {
      const surface = output.screenTrack?.getSettings().displaySurface;
      const tip = surface === 'browser'
        ? 'A aba compartilhada está preta. Se for um filme pago/protegido (DRM), o próprio site bloqueia a captura e isso não pode ser contornado.'
        : 'A imagem está saindo preta. Vídeos (YouTube etc.) numa “Janela” podem sair pretos por causa da aceleração de hardware: use 🔄 Trocar e escolha a “Aba” do vídeo, ou desligue “Usar aceleração de hardware” no navegador. Filmes protegidos (DRM) sempre saem pretos.';
      $('blackWarning').textContent = '⚠️ ' + tip;
      $('blackWarning').classList.remove('hidden');
    } else if (change === false) {
      $('blackWarning').classList.add('hidden');
    }
  }, 1000);
}

// ------------------------------------------------------------ fim
function stopAll() {
  for (const id of [...viewers.keys()]) closeViewer(id, true);
  relay?.stop(); relay = null;
  clearInterval(usageTimer); clearInterval(clockTimer);
  if (pendingTunnel) {
    fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tunnel: pendingTunnel }) }).catch(() => {});
    pendingTunnel = null;
  }
  document.title = 'TelaLink';
  output?.stop(); output = null;
  ws?.close();
  $('liveDot').classList.remove('live');
  $('liveTxt').textContent = 'Encerrado';
  for (const id of ['btnPause', 'btnMute', 'volume', 'liveQuality', 'btnSwitch', 'btnLock', 'btnStop']) $(id).disabled = true;
  show($('shareMsg'), 'ok', 'Transmissão encerrada. Recarregue a página para começar de novo.');
}
$('btnStop').onclick = stopAll;
