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

async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) {
    const buffer = fs.readFileSync(DB_FILE);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT, email TEXT, accessToken TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS likes (
    userId TEXT, videoId TEXT, PRIMARY KEY (userId, videoId)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
    userId TEXT, channelId TEXT, PRIMARY KEY (userId, channelId)
  )`);
  saveDB();
  console.log('✅ База данных инициализирована!');
}

function saveDB() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_FILE, buffer);
}

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

const GOOGLE_CLIENT_ID = '868714438086-re0oegl4b4mjecs32lu5o7306impsgff.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = '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';
const YOUTUBE_API_KEY = 'AIzaSyCAyIWpuw5slN5k9XsynnH-VkToF1g_F-8';

passport.use(new GoogleStrategy({
  clientID: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  callbackURL: 'http://localhost:3000/auth/google/callback'
}, (accessToken, refreshToken, profile, done) => {
  const stmt = db.prepare(`INSERT OR REPLACE INTO users (id, name, email, accessToken) VALUES (?, ?, ?, ?)`);
  stmt.run([profile.id, profile.displayName, profile.emails[0].value, accessToken]);
  stmt.free();
  saveDB();
  return done(null, profile);
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

app.get('/auth/google', passport.authenticate('google', { 
  scope: ['profile', 'email', 'https://www.googleapis.com/auth/youtube.force-ssl'] 
}));
app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/' }), 
  (req, res) => res.redirect('/')
);

app.get('/user', (req, res) => {
  res.json(req.user ? { id: req.user.id, name: req.user.displayName } : null);
});

app.get('/search', async (req, res) => {
  try {
    const query = req.query.q;
    const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: { part: 'snippet', q: query, type: 'video', maxResults: 20, key: YOUTUBE_API_KEY }
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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

app.post('/subscribe', (req, res) => {
  const { channelId } = req.body;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Войдите в аккаунт' });
  const stmt = db.prepare(`INSERT OR REPLACE INTO subscriptions (userId, channelId) VALUES (?, ?)`);
  stmt.run([userId, channelId]);
  stmt.free();
  saveDB();
  res.json({ success: true });
});

app.delete('/subscribe', (req, res) => {
  const { channelId } = req.body;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Войдите в аккаунт' });
  db.run(`DELETE FROM subscriptions WHERE userId = ? AND channelId = ?`, [userId, channelId]);
  saveDB();
  res.json({ success: true });
});

app.get('/subscriptions/:channelId', (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.json({ subscribed: false });
  const result = db.exec(`SELECT * FROM subscriptions WHERE userId = ? AND channelId = ?`, [userId, req.params.channelId]);
  res.json({ subscribed: result.length > 0 });
});

initDB().then(() => {
  app.listen(3000, '0.0.0.0', () => {
    console.log('🚀 Сервер запущен!');
  });
});