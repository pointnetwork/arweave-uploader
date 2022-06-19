import Fastify from 'fastify';
import { log } from './utils/logger';

const fastify = Fastify();

fastify.get('/health', function (request, reply) {
  reply.send({ health: 'ok' });
});

// Run the server!
fastify.listen({ port: 8080 }, function (err, address) {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  log.info(`Health Server is now listening on ${address}`);
});
