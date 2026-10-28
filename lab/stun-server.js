// Servidor STUN minimo (RFC 5389, so "Binding") para o laboratorio.
// Responde a cada pedido com o endereco publico de quem perguntou
// (XOR-MAPPED-ADDRESS) — e assim que cada PC descobre como e visto "de fora".
import dgram from 'node:dgram';

const MAGIC = 0x2112a442;

export function bindingResponse(req, rinfo) {
  if (req.length < 20 || req.readUInt16BE(0) !== 0x0001 || req.readUInt32BE(4) !== MAGIC) return null;
  const res = Buffer.alloc(32);
  res.writeUInt16BE(0x0101, 0);          // Binding Success Response
  res.writeUInt16BE(12, 2);              // tamanho dos atributos
  res.writeUInt32BE(MAGIC, 4);
  req.copy(res, 8, 8, 20);               // transaction ID
  res.writeUInt16BE(0x0020, 20);         // XOR-MAPPED-ADDRESS
  res.writeUInt16BE(8, 22);
  res.writeUInt8(0, 24);
  res.writeUInt8(0x01, 25);              // IPv4
  res.writeUInt16BE(rinfo.port ^ (MAGIC >>> 16), 26);
  const ip = rinfo.address.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
  res.writeUInt32BE((ip ^ MAGIC) >>> 0, 28);
  return res;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.STUN_PORT || 3478);
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    const res = bindingResponse(msg, rinfo);
    if (res) sock.send(res, rinfo.port, rinfo.address);
  });
  sock.bind(port, () => console.log(`STUN ouvindo em udp/${port}`));
}
