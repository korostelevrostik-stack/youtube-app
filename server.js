const express = require('express');
const axios = require('axios');
const cors = require('cors');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const initSqlJs = require('sql.js');
const fs = require('fs');
const app = express();

let db;
const DB_FILE = './data.db';

// ===== БАЗА ДАННЫХ =====
async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) {
    const buffer = fs.readFileSync(DB_FILE);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, 
    name TEXT, 
    email TEXT, 
    accessToken TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS likes (
    userId TEXT, 
    videoId TEXT, 
    PRIMARY KEY (userId, videoId)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
    userId TEXT, 
    channelId TEXT, 
    PRIMARY KEY (userId, channelId)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS history (
    userId TEXT,
    videoId TEXT,
    watchedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (userId, videoId)
  )`);
  saveDB();
  console.log('✅ База данных инициализирована!');
}

function saveDB() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_FILE, buffer);
}

// ===== НАСТРОЙКИ =====
app.use(cors());
app.use(express.static('public'));
app.use(express.json());
app.use(session({
  secret: 'секретный_ключ_123',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));
app.use(passport.initialize());
app.use(passport.session());

// ===== ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ =====
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// ===== АВТОРИЗАЦИЯ GOOGLE =====
passport.use(new GoogleStrategy({
  clientID: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  callbackURL: 'https://youtube-app-5oyn.onrender.com/auth/google/callback'
}, (accessToken, refreshToken, profile, done) => {
  const stmt = db.prepare(`INSERT OR REPLACE INTO users (id, name, email, accessToken) VALUES (?, ?, ?, ?)`);
  stmt.run([profile.id, profile.displayName, profile.emails[0].value, accessToken]);
  stmt.free();
  saveDB();
  return done(null, profile);
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// ===== МАРШРУТЫ АВТОРИЗАЦИИ =====
app.get('/auth/google', passport.authenticate('google', {
  scope: ['profile', 'email', 'https://www.googleapis.com/auth/youtube.force-ssl']
}));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/' }),
  (req, res) => res.redirect('/')
);

app.get('/auth/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      console.error('Ошибка выхода:', err);
      return res.status(500).json({ error: 'Ошибка выхода' });
    }
    req.session.destroy((err) => {
      if (err) {
        console.error('Ошибка удаления сессии:', err);
      }
      res.redirect('/');
    });
  });
});

app.get('/user', (req, res) => {
  res.json(req.user ? { id: req.user.id, name: req.user.displayName } : null);
});

// ===== ПОИСК ВИДЕО =====
app.get('/search', async (req, res) => {
  try {
    const query = req.query.q;
    const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        q: query,
        type: 'video',
        maxResults: 20,
        key: YOUTUBE_API_KEY
      }
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== ТРЕНДЫ =====
app.get('/trending', async (req, res) => {
  try {
    const response = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: {
        part: 'snippet,statistics',
        chart: 'mostPopular',
        regionCode: 'RU',
        maxResults: 20,
        key: YOUTUBE_API_KEY
      }
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== РЕКОМЕНДАЦИИ =====
app.get('/recommendations', async (req, res) => {
  try {
    const userId = req.query.userId || req.user?.id;
    if (!userId) {
      const trending = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
        params: { part: 'snippet', chart: 'mostPopular', regionCode: 'RU', maxResults: 10, key: YOUTUBE_API_KEY }
      });
      return res.json(trending.data);
    }

    const historyResult = db.exec(`SELECT videoId FROM history WHERE userId = ? ORDER BY watchedAt DESC LIMIT 20`, [userId]);
    if (!historyResult.length || !historyResult[0].values.length) {
      const trending = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
        params: { part: 'snippet', chart: 'mostPopular', regionCode: 'RU', maxResults: 10, key: YOUTUBE_API_KEY }
      });
      return res.json(trending.data);
    }

    const videoIds = historyResult[0].values.map(row => row[0]).slice(0, 5).join(',');
    const videoDetails = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: { part: 'snippet', id: videoIds, key: YOUTUBE_API_KEY }
    });

    const stopWords = ['official', 'mv', 'hd', '4k', 'clip', 'video', 'music', 'song', 'remix', 'cover', 'live', 'ft', 'feat', 'prod', 'by', 'with', 'and', 'the', 'of', 'for', 'on', 'at', 'to', 'from', 'in'];
    let keywords = [];
    videoDetails.data.items.forEach(item => {
      const title = item.snippet.title.toLowerCase();
      const words = title.split(/[\s\-_|:;,.!?()\[\]{}"']+/);
      words.forEach(word => {
        if (word.length > 3 && !stopWords.includes(word) && !/^\d+$/.test(word)) {
          keywords.push(word);
        }
      });
    });

    const freq = {};
    keywords.forEach(word => freq[word] = (freq[word] || 0) + 1);
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    const topKeywords = sorted.slice(0, 3).map(([word]) => word);
    if (!topKeywords.length) {
      const trending = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
        params: { part: 'snippet', chart: 'mostPopular', regionCode: 'RU', maxResults: 10, key: YOUTUBE_API_KEY }
      });
      return res.json(trending.data);
    }

    const searchResult = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: { part: 'snippet', q: topKeywords.join(' '), type: 'video', maxResults: 15, key: YOUTUBE_API_KEY }
    });

    const watchedIds = historyResult[0].values.map(row => row[0]);
    const recommended = searchResult.data.items.filter(item => !watchedIds.includes(item.id.videoId));
    res.json({ items: recommended.slice(0, 10) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== СОХРАНЕНИЕ ИСТОРИИ =====
app.post('/history', (req, res) => {
  const { videoId, userId } = req.body;
  const uid = userId || req.user?.id;
  if (!uid) return res.status(401).json({ error: 'ID пользователя не передан' });
  const stmt = db.prepare(`INSERT OR REPLACE INTO history (userId, videoId, watchedAt) VALUES (?, ?, datetime('now'))`);
  stmt.run([uid, videoId]);
  stmt.free();
  saveDB();
  res.json({ success: true });
});

// ===== ЛАЙКИ =====
app.post('/like', (req, res) => {
  const { videoId } = req.body;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Войдите в аккаунт' });
  const stmt = db.prepare(`INSERT OR REPLACE INTO likes (userId, videoId) VALUES (?, ?)`);
  stmt.run([userId, videoId]);
  stmt.free();
  saveDB();
  res.json({ success: true });
});

app.delete('/like', (req, res) => {
  const { videoId } = req.body;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Войдите в аккаунт' });
  db.run(`DELETE FROM likes WHERE userId = ? AND videoId = ?`, [userId, videoId]);
  saveDB();
  res.json({ success: true });
});

app.get('/likes/:videoId', (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.json({ liked: false });
  const result = db.exec(`SELECT * FROM likes WHERE userId = ? AND videoId = ?`, [userId, req.params.videoId]);
  res.json({ liked: result.length > 0 });
});

// ===== ПОДПИСКИ (ЧЕРЕЗ TELEGRAM ID) =====
app.post('/subscribe', (req, res) => {
  const { userId, channelId } = req.body;
  if (!userId) return res.status(401).json({ error: 'ID пользователя не передан' });
  const stmt = db.prepare(`INSERT OR REPLACE INTO subscriptions (userId, channelId) VALUES (?, ?)`);
  stmt.run([userId, channelId]);
  stmt.free();
  saveDB();
  res.json({ success: true });
});

app.delete('/subscribe', (req, res) => {
  const { userId, channelId } = req.body;
  if (!userId) return res.status(401).json({ error: 'ID пользователя не передан' });
  db.run(`DELETE FROM subscriptions WHERE userId = ? AND channelId = ?`, [userId, channelId]);
  saveDB();
  res.json({ success: true });
});

app.get('/subscriptions/:channelId', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.json({ subscribed: false });
  const result = db.exec(`SELECT * FROM subscriptions WHERE userId = ? AND channelId = ?`, [userId, req.params.channelId]);
  res.json({ subscribed: result.length > 0 });
});

app.get('/subscriptions', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.json({ items: [] });
  const result = db.exec(`SELECT channelId FROM subscriptions WHERE userId = ?`, [userId]);
  if (!result.length || !result[0].values.length) {
    return res.json({ items: [] });
  }
  const channelIds = result[0].values.map(row => row[0]).filter(id => id).join(',');
  if (!channelIds) return res.json({ items: [] })
  
  // Ищем видео по каналам
  const searchResult = await axios.get('https://www.googleapis.com/youtube/v3/search', {
    params: {
      part: 'snippet',
      channelId: channelIds.split(',')[0],
      type: 'video',
      maxResults: 20,
      key: YOUTUBE_API_KEY
    }
  });
  res.json({ items: searchResult.data.items || [] });
});

// ===== ЗАПУСК =====
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
  });
});