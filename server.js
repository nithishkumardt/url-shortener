require('dotenv').config();
const UAParser = require('ua-parser-js');
const axios = require('axios');
const redisClient = require('./redisClient');
const rateLimitMiddleware = require('./rateLimitMiddleware');
const express = require('express');
const crypto = require('crypto');
const pool = require('./db');
const jwt = require('jsonwebtoken');
const authMiddleware = require('./authMiddleware');
const bcrypt = require('bcrypt');

const app = express();
app.use(express.json());

function generateShortCode() {
  return crypto.randomBytes(4).toString('hex');
}

app.post('/shorten', authMiddleware, rateLimitMiddleware, async (req, res) => {
  const { longUrl, customAlias } = req.body;

  if (!longUrl) {
    return res.status(400).json({ error: 'longUrl is required' });
  }

  if (customAlias && !/^[a-zA-Z0-9_-]{3,20}$/.test(customAlias)) {
    return res.status(400).json({
      error: 'customAlias must be 3-20 characters, letters/numbers/hyphens/underscores only'
    });
  }

  const shortCode = customAlias || generateShortCode();

  try {
    await pool.query(
      'INSERT INTO urls (short_code, long_url, user_id) VALUES ($1, $2, $3)',
      [shortCode, longUrl, req.userId]
    );
   const baseUrl = process.env.BASE_URL || `http://localhost:3000`;
res.json({ shortUrl: `${baseUrl}/${shortCode}` });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That alias is already taken' });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});
app.get('/analytics/:shortCode', authMiddleware, async (req, res) => {
  const { shortCode } = req.params;

  try {
    const urlResult = await pool.query(
      'SELECT id, user_id, long_url FROM urls WHERE short_code = $1',
      [shortCode]
    );

    if (urlResult.rows.length === 0) {
      return res.status(404).json({ error: 'Short URL not found' });
    }

    const url = urlResult.rows[0];

    if (url.user_id !== req.userId) {
      return res.status(403).json({ error: 'You do not have access to this URL' });
    }

    const totalClicksResult = await pool.query(
      'SELECT COUNT(*) FROM clicks WHERE url_id = $1',
      [url.id]
    );

    const byBrowserResult = await pool.query(
      `SELECT user_agent, COUNT(*) as count
       FROM clicks
       WHERE url_id = $1
       GROUP BY user_agent
       ORDER BY count DESC`,
      [url.id]
    );

    const byCountryResult = await pool.query(
      `SELECT country, COUNT(*) as count
       FROM clicks
       WHERE url_id = $1 AND country IS NOT NULL
       GROUP BY country
       ORDER BY count DESC`,
      [url.id]
    );

    res.json({
      shortCode,
      longUrl: url.long_url,
      totalClicks: parseInt(totalClicksResult.rows[0].count, 10),
      byBrowser: byBrowserResult.rows,
      byCountry: byCountryResult.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});
app.get('/:shortCode', async (req, res) => {
  const { shortCode } = req.params;

  try {
    const cachedUrl = await redisClient.get(shortCode);
    let longUrl = cachedUrl;

    if (cachedUrl) {
      console.log('Cache HIT for', shortCode);
    } else {
      console.log('Cache MISS for', shortCode);

      const result = await pool.query(
        'SELECT id, long_url FROM urls WHERE short_code = $1',
        [shortCode]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Short URL not found' });
      }

      longUrl = result.rows[0].long_url;
      await redisClient.set(shortCode, longUrl, { EX: 3600 });
    }

    logClick(shortCode, req).catch(err => console.error('Click logging failed:', err));

    res.redirect(longUrl);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

async function logClick(shortCode, req) {
  const urlResult = await pool.query(
    'SELECT id FROM urls WHERE short_code = $1',
    [shortCode]
  );

  if (urlResult.rows.length === 0) return;

  const urlId = urlResult.rows[0].id;
  const referrer = req.headers['referer'] || null;
  const userAgentString = req.headers['user-agent'] || '';

  const parser = new UAParser(userAgentString);
  const uaResult = parser.getResult();
  const deviceInfo = `${uaResult.browser.name || 'Unknown'} on ${uaResult.os.name || 'Unknown'}`;

  let ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  ipAddress = ipAddress.split(',')[0].trim();

  let country = null;
  let city = null;

  try {
    const geoResponse = await axios.get(`http://ip-api.com/json/${ipAddress}`);
    if (geoResponse.data.status === 'success') {
      country = geoResponse.data.country;
      city = geoResponse.data.city;
    }
  } catch (geoErr) {
    console.error('Geolocation lookup failed:', geoErr.message);
  }

  await pool.query(
    `INSERT INTO clicks (url_id, referrer, user_agent, ip_address, country, city)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [urlId, referrer, deviceInfo, ipAddress, country, city]
  );

  console.log(`Logged click: ${deviceInfo}, IP: ${ipAddress}, Location: ${city || 'N/A'}, ${country || 'N/A'}`);
}

app.post('/signup', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, passwordHash]
    );

    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already registered' });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const result = await pool.query(
      'SELECT id, email, password_hash FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];
    const passwordMatches = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatches) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});