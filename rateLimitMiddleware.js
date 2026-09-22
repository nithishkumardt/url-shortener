const redisClient = require('./redisClient');

const LIMIT = 10;         // max requests
const WINDOW_SECONDS = 60; // per this many seconds

async function rateLimitMiddleware(req, res, next) {
  const key = `ratelimit:${req.userId}`;

  try {
    const currentCount = await redisClient.incr(key);

    if (currentCount === 1) {
      await redisClient.expire(key, WINDOW_SECONDS);
    }

    if (currentCount > LIMIT) {
      return res.status(429).json({ error: 'Too many requests, please try again later' });
    }

    next();
  } catch (err) {
    console.error(err);
    next(); // fail open: if Redis has an issue, don't block legitimate users
  }
}

module.exports = rateLimitMiddleware;