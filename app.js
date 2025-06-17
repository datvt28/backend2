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

const notesFile = path.join(__dirname, 'notes.json');
const usersFile = path.join(__dirname, 'data.json');
const uploadDir = path.join(__dirname, 'public/uploads');
const logFile = path.join(__dirname, 'activity.log');

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

let notes = [];
try {
    notes = JSON.parse(fs.readFileSync(notesFile, 'utf8'));
} catch {
    notes = [];
}

let users = [];
try {
    users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
} catch {
    users = [];
}

function saveNotes() {
    fs.writeFileSync(notesFile, JSON.stringify(notes, null, 2));
}

function saveUsers() {
    fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
}

function writeLog(msg) {
    const log = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(logFile, log);
}

// Plugin và cấu hình view + static
fastify.register(fastifyStatic, {
    root: path.join(__dirname, 'public'),
    prefix: '/',
});
fastify.register(fastifyCookie, { secret: 'my-secret-key' });
fastify.register(fastifyFormbody);
fastify.register(fastifyMultipart, { addToBody: true });
fastify.register(pointOfView, {
    engine: { pug: require('pug') },
    root: path.join(__dirname, 'views'),
});

// Middleware xác thực
function checkAuth(req, reply, done) {
    const { token } = req.cookies;
    if (token && users.find(u => u.username === token)) {
        done();
    } else {
        reply.redirect('/login');
    }
}
const publicRoutes = ['/login', '/register'];
fastify.addHook('preHandler', (req, reply, done) => {
    const path = req.routerPath || req.raw.url.split('?')[0];
    if (publicRoutes.includes(path)) {
        done();
    } else {
        checkAuth(req, reply, done);
    }
});

// Trang chính
fastify.get('/', (req, reply) => {
    const username = req.cookies.token;
    const page = parseInt(req.query.page) || 1;
    const perPage = 5;

    const userNotes = username === 'admin'
        ? notes
        : notes.filter(n => n.username === username);
    const sortedNotes = [...userNotes].sort((a, b) => b.pinned - a.pinned);
    const paginated = sortedNotes.slice((page - 1) * perPage, page * perPage);

    return reply.view('index', {
        title: 'Ghi chú cá nhân',
        notes: paginated,
        page,
        totalPages: Math.ceil(userNotes.length / perPage),
        username
    });
});

// Thêm ghi chú
fastify.post('/submit', async (req, reply) => {
    const username = req.cookies.token;
    const parts = req.parts();
    let text = '', pinned = false, imageFileName = '';

    for await (const part of parts) {
        if (part.file) {
            const ext = path.extname(part.filename);
            const filename = nanoid() + ext;
            await pump(part.file, fs.createWriteStream(path.join(uploadDir, filename)));
            imageFileName = '/uploads/' + filename;
        } else if (part.fieldname === 'note') {
            text = part.value.trim();
        } else if (part.fieldname === 'pinned') {
            pinned = true;
        }
    }

    if (!text) {
        return reply.view('index', {
            title: 'Ghi chú cá nhân',
            notes: notes.filter(n => n.username === username),
            message: '⚠️ Nội dung không được trống!',
            page: 1,
            totalPages: 1,
            username
        });
    }

    notes.push({ id: nanoid(), username, text, image: imageFileName, pinned });
    saveNotes();
    writeLog(`${username} thêm ghi chú`);

    reply.redirect('/');
});

// Xoá ghi chú
fastify.get('/delete/:id', (req, reply) => {
    const username = req.cookies.token;
    const id = req.params.id;

    const index = notes.findIndex(n => n.id === id && (username === 'admin' || n.username === username));
    if (index !== -1) {
        const note = notes[index];
        if (note.image) {
            const imgPath = path.join(__dirname, 'public', note.image);
            if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
        }
        notes.splice(index, 1);
        saveNotes();
        writeLog(`${username} xoá ghi chú ${id}`);
    }

    reply.redirect('/');
});

// Trang sửa ghi chú
fastify.get('/edit/:id', (req, reply) => {
    const username = req.cookies.token;
    const id = req.params.id;
    const note = notes.find(n => n.id === id && (username === 'admin' || n.username === username));

    if (!note) return reply.redirect('/');
    return reply.view('edit', { title: 'Sửa ghi chú', note });
});

// Cập nhật ghi chú
fastify.post('/edit/:id', (req, reply) => {
    const username = req.cookies.token;
    const id = req.params.id;
    const { text, pinned } = req.body;

    const note = notes.find(n => n.id === id && (username === 'admin' || n.username === username));
    if (note) {
        note.text = text;
        note.pinned = pinned === 'on';
        saveNotes();
        writeLog(`${username} sửa ghi chú ${id}`);
    }

    reply.redirect('/');
});

// Tìm kiếm ghi chú
fastify.get('/search', (req, reply) => {
    const username = req.cookies.token;
    const keyword = (req.query.q || '').toLowerCase();
    const results = notes.filter(n =>
        (username === 'admin' || n.username === username) &&
        n.text.toLowerCase().includes(keyword)
    );

    reply.view('index', {
        title: 'Kết quả tìm kiếm',
        notes: results,
        message: `🔍 Kết quả cho từ khoá "${keyword}"`,
        page: 1,
        totalPages: 1,
        username
    });
});

// Quản lý người dùng (admin)
fastify.get('/users', (req, reply) => {
    if (req.cookies.token !== 'admin') return reply.redirect('/');
    return reply.view('users', { users });
});

fastify.get('/reset/:username', (req, reply) => {
    if (req.cookies.token === 'admin') {
        const user = users.find(u => u.username === req.params.username);
        if (user) {
            user.password = '123';
            saveUsers();
            writeLog(`Admin reset mật khẩu cho ${user.username}`);
        }
    }
    reply.redirect('/users');
});

fastify.get('/remove/:username', (req, reply) => {
    if (req.cookies.token === 'admin') {
        users = users.filter(u => u.username !== req.params.username);
        notes = notes.filter(n => n.username !== req.params.username);
        saveUsers();
        saveNotes();
        writeLog(`Admin xoá người dùng ${req.params.username}`);
    }
    reply.redirect('/users');
});

// Đăng nhập
fastify.get('/login', (req, reply) => {
    reply.view('login', { title: 'Đăng nhập', message: null });
});

fastify.post('/login', (req, reply) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username && u.password === password);

    if (user) {
        reply.setCookie('token', username, { path: '/', httpOnly: true });
        reply.redirect('/');
    } else {
        reply.view('login', { title: 'Đăng nhập', message: '⚠️ Sai tên đăng nhập hoặc mật khẩu' });
    }
});

// Đăng ký
fastify.get('/register', (req, reply) => {
    reply.view('register', { title: 'Đăng ký', message: null });
});

fastify.post('/register', (req, reply) => {
    const { username, password, confirmPassword } = req.body;

    if (!username || !password || !confirmPassword) {
        return reply.view('register', { title: 'Đăng ký', message: '⚠️ Vui lòng nhập đầy đủ thông tin' });
    }

    if (password !== confirmPassword) {
        return reply.view('register', { title: 'Đăng ký', message: '⚠️ Mật khẩu không khớp' });
    }

    if (users.find(u => u.username === username)) {
        return reply.view('register', { title: 'Đăng ký', message: '⚠️ Tên đăng nhập đã tồn tại' });
    }

    users.push({ username, password });
    saveUsers();
    writeLog(`Người dùng mới: ${username}`);
    reply.redirect('/login');
});

// Đăng xuất
fastify.get('/logout', (req, reply) => {
    reply.clearCookie('token', { path: '/' });
    reply.redirect('/login');
});

// Khởi chạy server
fastify.listen({ port: 3000 }, err => {
    if (err) {
        fastify.log.error(err);
        process.exit(1);
    }
    fastify.log.info('🚀 Server chạy tại http://localhost:3000');
});
