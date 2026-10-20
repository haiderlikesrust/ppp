import { config } from './config';
import { createApp } from './app';

const { app, services } = await createApp();
await app.listen({ port: config.API_PORT, host: config.HOST });
console.log(`Pullback server (${services.practice ? 'practice' : config.live ? 'mainnet' : 'read-only'}): http://${config.HOST}:${config.API_PORT}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
