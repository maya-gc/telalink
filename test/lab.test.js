// Testes das pecas do laboratorio de redes que nao precisam de root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { bindingResponse } from '../lab/stun-server.js';
import { evaluate, EXPECTED } from '../lab/resumo.js';

test('STUN do laboratorio: responde com o endereco de quem perguntou (XOR-MAPPED-ADDRESS)', async (t) => {
  const server = dgram.createSocket('udp4');
  server.on('message', (m, r) => { const res = bindingResponse(m, r); if (res) server.send(res, r.port, r.address); });
  await new Promise((r) => server.bind(0, '127.0.0.1', r));
  const client = dgram.createSocket('udp4');
  await new Promise((r) => client.bind(0, '127.0.0.1', r));
  t.after(() => { server.close(); client.close(); });

  const tid = randomBytes(12);
  const req = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42]), tid]);
  const res = await new Promise((resolve) => { client.once('message', resolve); client.send(req, server.address().port, '127.0.0.1'); });

  assert.equal(res.readUInt16BE(0), 0x0101, 'Binding Success');
  assert.deepEqual(res.subarray(8, 20), tid, 'mesmo transaction ID');
  assert.equal(res.readUInt16BE(20), 0x0020, 'XOR-MAPPED-ADDRESS');
  const port = res.readUInt16BE(26) ^ 0x2112;
  const ip = (res.readUInt32BE(28) ^ 0x2112a442) >>> 0;
  assert.equal(port, client.address().port);
  assert.equal([ip >>> 24, (ip >> 16) & 255, (ip >> 8) & 255, ip & 255].join('.'), '127.0.0.1');
});

test('STUN do laboratorio: ignora pacotes que nao sao Binding Request', () => {
  const r = { address: '1.2.3.4', port: 5 };
  assert.equal(bindingResponse(Buffer.alloc(10), r), null);
  assert.equal(bindingResponse(Buffer.alloc(20), r), null, 'sem magic cookie');
});

test('avaliacao do laboratorio: aprova so o caminho esperado para cada rede', () => {
  const ok = Object.fromEntries(Object.keys(EXPECTED).map((k) => [k, { ok: true, transport: EXPECTED[k].aceita[0] }]));
  assert.ok(evaluate(ok).every((r) => r.pass));
  const bad = { ...ok, empresa: { ok: true, transport: 'direta' } };   // impossivel com UDP bloqueado
  assert.equal(evaluate(bad).find((r) => r.name === 'empresa').pass, false);
  const missing = { ...ok }; delete missing.vpn;
  assert.equal(evaluate(missing).find((r) => r.name === 'vpn').pass, false);
});
