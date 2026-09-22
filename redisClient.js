const { createClient } = require('redis');

console.log('DEBUG - REDIS_URL value:', process.env.REDIS_URL);

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

const redisClient = createClient({
  url: redisUrl,
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));

redisClient.connect();

module.exports = redisClient;