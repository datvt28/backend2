// ==== KHAI BÁO THƯ VIỆN ====
const fastify = require('fastify')({ logger: true });
const path = require('path');
const fs = require('fs');
const { nanoid } = require('nanoid');
const fastifyStatic = require('@fastify/static');
const fastifyCookie = require('@fastify/cookie');
const fastifyFormbody = require('@fastify/formbody');
const fastifyMultipart = require('@fastify/multipart');
const pump = require('util').promisify(require('stream').pipeline);
const pointOfView = require('@fastify/view');
const fastifyCaching = require('@fastify/caching');
const { MongoClient, ObjectId } = require('mongodb');

// ==== CẤU HÌNH ==== 
const uploadDir = path.join(__dirname, 'public/uploads');
const logFile = path.join(__dirname, 'activity.log');
const mongoUrl = 'mongodb://localhost:27017';
const dbName = 'note_app';
let db;

// ==== KẾT NỐI MONGODB ====
MongoClient.connect(mongoUrl)
  .then(client => {
    db = client.db(dbName);
    fastify.log.info('✅ Kết nối MongoDB thành công');
  })
  .catch(err => {
    console.error('❌ Lỗi kết nối MongoDB:', err);
    process.exit(1);
  });

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
function writeLog(msg) {
  const log = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(logFile, log);
}

// ==== CÀI ĐẶT PLUGIN ====
fastify.register(fastifyStatic, { root: path.join(__dirname, 'public'), prefix: '/' });
fastify.register(fastifyCookie, { secret: 'my-secret-key' });
fastify.register(fastifyFormbody);
fastify.register(fastifyMultipart, { addToBody: true });
fastify.register(pointOfView, { engine: { pug: require('pug') }, root: path.join(__dirname, 'views') });
fastify.register(fastifyCaching);

// ==== MIDDLEWARE KIỂM TRA ĐĂNG NHẬP ====
const publicRoutes = ['/login', '/register'];

fastify.addHook('preHandler', async (req, reply) => {
  const path = req.routerPath || req.raw.url.split('?')[0];
  if (!publicRoutes.includes(path)) {
    const { token } = req.cookies;
    const user = await db.collection('users').findOne({ username: token });
    if (!user) {
      return reply.redirect('/login');
    }
  }
});

// ==== TRANG CHÍNH ====
fastify.get('/', async (req, reply) => {
  const username = req.cookies.token;
  const page = parseInt(req.query.page) || 1;
  const perPage = 5;

  const filter = username === 'admin' ? {} : { username };
  const notes = await db.collection('notes')
    .find(filter)
    .sort({ pinned: -1 })
    .skip((page - 1) * perPage)
    .limit(perPage)
    .toArray();

  const total = await db.collection('notes').countDocuments(filter);

  reply.header('Cache-Control', 'public, max-age=60');
  return reply.view('index', {
    title: 'Ghi chú cá nhân',
    notes,
    page,
    totalPages: Math.ceil(total / perPage),
    username
  });
});

// ==== THÊM GHI CHÚ ====
fastify.post('/submit', async (req, reply) => {
  const username = req.cookies.token;
  const parts = req.parts();
  let title = '', text = '', pinned = false, imageFileName = '';

  for await (const part of parts) {
    if (part.file) {
      const ext = path.extname(part.filename);
      const filename = nanoid() + ext;
      await pump(part.file, fs.createWriteStream(path.join(uploadDir, filename)));
      imageFileName = '/uploads/' + filename;
    } else if (part.fieldname === 'title') title = part.value.trim();
    else if (part.fieldname === 'note') text = part.value.trim();
    else if (part.fieldname === 'pinned') pinned = true;
  }

  if (!text) {
    return reply.view('index', {
      title: 'Ghi chú cá nhân',
      notes: await db.collection('notes').find({ username }).toArray(),
      message: '⚠️ Nội dung không được trống!',
      page: 1,
      totalPages: 1,
      username
    });
  }

  await db.collection('notes').insertOne({ username, title, text, image: imageFileName, pinned });
  writeLog(`${username} thêm ghi chú`);
  return reply.redirect('/');
});

// ==== XOÁ GHI CHÚ ====
fastify.get('/delete/:id', async (req, reply) => {
  const username = req.cookies.token;
  const id = req.params.id;
  const note = await db.collection('notes').findOne({ _id: new ObjectId(id) });

  if (note && (username === 'admin' || note.username === username)) {
    if (note.image) {
      const imgPath = path.join(__dirname, 'public', note.image);
      if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
    }
    await db.collection('notes').deleteOne({ _id: new ObjectId(id) });
    writeLog(`${username} xoá ghi chú ${id}`);
  }
  return reply.redirect('/');
});

// ==== TRANG SỬA GHI CHÚ ====
fastify.get('/edit/:id', async (req, reply) => {
  const username = req.cookies.token;
  const id = req.params.id;
  const note = await db.collection('notes').findOne({ _id: new ObjectId(id) });

  if (!note || (username !== 'admin' && note.username !== username)) return reply.redirect('/');
  return reply.view('edit', { title: 'Sửa ghi chú', note });
});

// ==== CẬP NHẬT GHI CHÚ ====
fastify.post('/edit/:id', async (req, reply) => {
  const username = req.cookies.token;
  const id = req.params.id;
  const { title, text, pinned } = req.body;
  const note = await db.collection('notes').findOne({ _id: new ObjectId(id) });

  if (note && (username === 'admin' || note.username === username)) {
    await db.collection('notes').updateOne(
      { _id: new ObjectId(id) },
      { $set: { title, text, pinned: pinned === 'on' } }
    );
    writeLog(`${username} sửa ghi chú ${id}`);
  }
  return reply.redirect('/');
});

// ==== TÌM KIẾM GHI CHÚ ====
fastify.get('/search', async (req, reply) => {
  const username = req.cookies.token;
  const keyword = (req.query.q || '').toLowerCase();
  const query = {
    $or: [
      { title: { $regex: keyword, $options: 'i' } },
      { text: { $regex: keyword, $options: 'i' } }
    ],
    ...(username === 'admin' ? {} : { username })
  };
  const results = await db.collection('notes').find(query).toArray();

  return reply.view('index', {
    title: 'Kết quả tìm kiếm',
    notes: results,
    message: `🔍 Kết quả cho từ khoá "${keyword}"`,
    page: 1,
    totalPages: 1,
    username
  });
});

// ==== QUẢN LÝ NGƯỜI DÙNG (ADMIN) ====
fastify.get('/users', async (req, reply) => {
  if (req.cookies.token !== 'admin') return reply.redirect('/');
  const users = await db.collection('users').find().toArray();
  return reply.view('users', { users });
});

fastify.get('/reset/:username', async (req, reply) => {
  if (req.cookies.token === 'admin') {
    await db.collection('users').updateOne({ username: req.params.username }, { $set: { password: '123' } });
    writeLog(`Admin reset mật khẩu cho ${req.params.username}`);
  }
  return reply.redirect('/users');
});

fastify.get('/remove/:username', async (req, reply) => {
  if (req.cookies.token === 'admin') {
    await db.collection('users').deleteOne({ username: req.params.username });
    await db.collection('notes').deleteMany({ username: req.params.username });
    writeLog(`Admin xoá người dùng ${req.params.username}`);
  }
  return reply.redirect('/users');
});

// ==== ĐĂNG NHẬP / ĐĂNG KÝ / ĐĂNG XUẤT ====
fastify.get('/login', (req, reply) => {
  return reply.view('login', { title: 'Đăng nhập', message: null });
});

fastify.post('/login', async (req, reply) => {
  const { username, password } = req.body;
  const user = await db.collection('users').findOne({ username, password });
  if (user) {
    reply.setCookie('token', username, { path: '/', httpOnly: true });
    return reply.redirect('/');
  } else {
    return reply.view('login', { title: 'Đăng nhập', message: '⚠️ Sai tên đăng nhập hoặc mật khẩu' });
  }
});

fastify.get('/register', (req, reply) => {
  return reply.view('register', { title: 'Đăng ký', message: null });
});

fastify.post('/register', async (req, reply) => {
  const { username, password, confirmPassword } = req.body;
  if (!username || !password || !confirmPassword) {
    return reply.view('register', { title: 'Đăng ký', message: '⚠️ Vui lòng nhập đầy đủ thông tin' });
  }
  if (password !== confirmPassword) {
    return reply.view('register', { title: 'Đăng ký', message: '⚠️ Mật khẩu không khớp' });
  }
  const exists = await db.collection('users').findOne({ username });
  if (exists) {
    return reply.view('register', { title: 'Đăng ký', message: '⚠️ Tên đăng nhập đã tồn tại' });
  }
  await db.collection('users').insertOne({ username, password });
  writeLog(`Người dùng mới: ${username}`);
  return reply.redirect('/login');
});

fastify.get('/logout', (req, reply) => {
  reply.clearCookie('token', { path: '/' });
  return reply.redirect('/login');
});

// ==== KHỞI CHẠY SERVER ====
fastify.listen({ port: 3000 }, err => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info('🚀 Server chạy tại http://localhost:3000');
});
