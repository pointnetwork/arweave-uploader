import { createSocket, Socket } from 'dgram';
import { Writable } from 'stream';

function createWritable(options: { address: string; port: number }) {
  const socket: Socket = createSocket('udp4');
  return new Writable({
    final: () => socket.close(),
    write: (data, _encoding, done) => {
      socket.send(data, 0, data.length, options.port, options.address, done);
    },
  });
}

export function createUdpStream(options: { address: string; port: number }) {
  let writable = createWritable(options);
  const erroHandler = () => {
    writable = createWritable(options);
    writable.on('error', erroHandler);
  };
  writable.on('error', erroHandler);
  return {
    write: (chunk, cb) => {
      // eslint-disable-next-line prefer-rest-params
      writable.write(chunk, cb);
    },
  };
}
