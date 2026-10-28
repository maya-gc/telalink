// Tela "Conexao e seguranca" (so abre no PC de quem transmite).
import { $, show } from './common.js';

let current = null;

const radio = (name) => document.querySelector(`input[name=${name}]:checked`)?.value;
const setRadio = (name, value) => { const r = document.querySelector(`input[name=${name}][value=${value}]`); if (r) r.checked = true; };

function renderFields() {
  const p = radio('provider');
  for (const id of ['cloudflare', 'coturn', 'static']) $(`f-${id}`).classList.toggle('hidden', p !== id);
}

function fill(s) {
  current = s;
  setRadio('defaultMode', s.defaultMode);
  setRadio('provider', s.turn.provider);
  $('cfKeyId').value = s.turn.cloudflare.keyId;
  $('cfTokenNow').textContent = s.turn.cloudflare.apiToken ? `(atual: ${s.turn.cloudflare.apiToken})` : '(não definido)';
  $('ctUrls').value = s.turn.coturn.urls.split(/[\s,]+/).filter(Boolean).join('\n');
  $('ctSecretNow').textContent = s.turn.coturn.secret ? `(atual: ${s.turn.coturn.secret})` : '(não definido)';
  $('stUrls').value = s.turn.static.urls.split(/[\s,]+/).filter(Boolean).join('\n');
  $('stUser').value = s.turn.static.username;
  $('stCredNow').textContent = s.turn.static.credential ? `(atual: ${s.turn.static.credential})` : '(não definida)';
  $('capGB').value = s.capGB ?? '';
  $('usage').textContent = s.usageGB;
  $('storageProt').textContent = s.storage.protection;
  $('storageDir').textContent = `Arquivo de configurações: ${s.storage.dir}`;
  for (const id of ['cfToken', 'ctSecret', 'stCred']) $(id).value = '';
  renderFields();
  if (s.overCap) show($('msg'), 'warn', 'A trava de consumo foi atingida: TURN pausado até o próximo mês.');
}

async function load() {
  const r = await fetch('/api/settings');
  if (!r.ok) return show($('msg'), 'err', 'Não foi possível carregar as configurações.');
  fill(await r.json());
}

function collect() {
  const cap = $('capGB').value.trim();
  return {
    defaultMode: radio('defaultMode'),
    capGB: cap === '' ? null : Number(cap),
    turn: {
      provider: radio('provider'),
      cloudflare: { keyId: $('cfKeyId').value.trim(), apiToken: $('cfToken').value.trim() },
      coturn: { urls: $('ctUrls').value.trim(), secret: $('ctSecret').value },
      static: { urls: $('stUrls').value.trim(), username: $('stUser').value.trim(), credential: $('stCred').value },
    },
  };
}

async function save() {
  $('btnSave').disabled = true;
  try {
    const r = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(collect()) });
    const body = await r.json();
    if (!r.ok) return show($('msg'), 'err', body.error || 'Não foi possível salvar.');
    fill(body);
    show($('msg'), 'ok', 'Salvo. Vale para as próximas pessoas que entrarem.');
  } finally { $('btnSave').disabled = false; }
}

// Testa de verdade: pede credenciais e tenta obter um candidato "relay" do TURN.
async function test() {
  $('btnTest').disabled = true;
  show($('msg'), 'ok', 'Testando...');
  try {
    const r = await (await fetch('/api/settings/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    if (!r.ok) return show($('msg'), 'err', 'Falhou: ' + r.message);
    if (!r.servers.length) return show($('msg'), 'ok', r.message);
    const pc = new RTCPeerConnection({ iceServers: r.servers, iceTransportPolicy: 'relay' });
    pc.createDataChannel('teste');
    const found = new Promise((resolve) => {
      pc.onicecandidate = (e) => { if (e.candidate && / typ relay /.test(e.candidate.candidate)) resolve(true); };
      setTimeout(() => resolve(false), 8000);
    });
    await pc.setLocalDescription(await pc.createOffer());
    const ok = await found;
    pc.close();
    show($('msg'), ok ? 'ok' : 'err', ok ? '✅ O servidor TURN respondeu e liberou um caminho de retransmissão.' : 'O servidor TURN não respondeu em 8 s. Confira endereços, credenciais e se o servidor está no ar.');
  } catch (err) {
    show($('msg'), 'err', 'Falhou: ' + err.message);
  } finally { $('btnTest').disabled = false; }
}

document.querySelectorAll('input[name=provider]').forEach((r) => r.addEventListener('change', renderFields));
$('btnSave').onclick = save;
$('btnTest').onclick = test;
load();
