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
const fastifyPlugin = require('fastify-plugin');

const notesFile = path.join(__dirname, 'notes.json');
const usersFile = path.join(__dirname, 'data.json');
const uploadDir = path.join(__dirname, 'public/uploads');
const logFile = path.join(__dirname, 'activity.log');

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

let notes = [];
try {
    const data = fs.readFileSync(notesFile, 'utf8');
    notes = JSON.parse(data);
} catch {
    notes = [];
}

let users = [];
try {
    const data = fs.readFileSync(usersFile, 'utf8');
    users = JSON.parse(data);
} catch {
    users = [];
}

function saveNotes() {
    fs.writeFileSync(notesFile, JSON.stringify(notes, null, 2));
}

function saveUsers() {
    fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
}

function writeLog(message) {
    const log = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(logFile, log);
}

fastify.register(fastifyStatic, {
    root: path.join(__dirname, 'public'),
    prefix: '/',
});

fastify.register(fastifyCookie, {
    secret: 'my-secret-cookie-key',
    parseOptions: {},
});

fastify.register(fastifyFormbody);
fastify.register(fastifyMultipart, { addToBody: true });
fastify.register(pointOfView, {
    engine: { pug: require('pug') },
    root: path.join(__dirname, 'views'),
});

function checkAuth(request, reply, done) {
    const { token } = request.cookies;
    if (token && users.some(u => u.username === token)) {
        done();
    } else {
        reply.redirect('/login');
    }
}

const publicRoutes = ['/login', '/register'];
fastify.addHook('preHandler', (request, reply, done) => {
    const urlPath = request.routerPath || request.raw.url.split('?')[0];
    if (publicRoutes.includes(urlPath)) {
        done();
    } else {
        checkAuth(request, reply, done);
    }
});

fastify.get('/', async (request, reply) => {
    const username = request.cookies.token;
    const page = parseInt(request.query.page) || 1;
    const pageSize = 5;

    const userNotes = username === 'admin' ? notes : notes.filter(note => note.username === username);
    const totalNotes = userNotes.length;
    const totalPages = Math.ceil(totalNotes / pageSize);
    const paginatedNotes = userNotes.slice((page - 1) * pageSize, page * pageSize);

    return reply.view('index', {
        title: 'Ghi chú cá nhân',
        notes: paginatedNotes,
        message: null,
        page,
        totalPages,
        username,
    });
});

fastify.post('/submit', async (request, reply) => {
    const username = request.cookies.token;
    const parts = request.parts();
    let text = '', imageFileName = '', pinned = false;

    for await (const part of parts) {
        if (part.file) {
            const ext = path.extname(part.filename);
            const fileName = nanoid() + ext;
            const filePath = path.join(uploadDir, fileName);
            await pump(part.file, fs.createWriteStream(filePath));
            imageFileName = '/uploads/' + fileName;
        } else if (part.fieldname === 'note') {
            text = part.value.trim();
        } else if (part.fieldname === 'pinned') {
            pinned = true;
        }
    }

    if (!text) {
        const userNotes = notes.filter(note => note.username === username);
        return reply.view('index', { title: 'Ghi chú cá nhân', notes: userNotes, message: 'Nội dung ghi chú không được để trống', page: 1, totalPages: 1, username });
    }

    notes.push({ id: nanoid(), username, text, image: imageFileName, pinned });
    saveNotes();
    writeLog(`${username} đã thêm ghi chú`);

    return reply.redirect('/');
});

fastify.get('/delete/:id', async (request, reply) => {
    const username = request.cookies.token;
    const id = request.params.id;
    const index = notes.findIndex(n => n.id === id && (username === 'admin' || n.username === username));
    if (index !== -1) {
        if (notes[index].image) {
            const imgPath = path.join(__dirname, 'public', notes[index].image);
            if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
        }
        notes.splice(index, 1);
        saveNotes();
        writeLog(`${username} đã xóa ghi chú ${id}`);
    }
    return reply.redirect('/');
});

fastify.get('/edit/:id', async (request, reply) => {
    const username = request.cookies.token;
    const id = request.params.id;
    const note = notes.find(n => n.id === id && (username === 'admin' || n.username === username));
    if (!note) return reply.redirect('/');
    return reply.view('edit', { title: 'Sửa ghi chú', note });
});

fastify.post('/edit/:id', async (request, reply) => {
    const username = request.cookies.token;
    const id = request.params.id;
    const { text, pinned } = request.body;
    const note = notes.find(n => n.id === id && (username === 'admin' || n.username === username));
    if (note) {
        note.text = text;
        note.pinned = pinned === 'on';
        saveNotes();
        writeLog(`${username} đã sửa ghi chú ${id}`);
    }
    return reply.redirect('/');
});

fastify.get('/search', async (request, reply) => {
    const username = request.cookies.token;
    const keyword = (request.query.q || '').toLowerCase();
    const filteredNotes = notes.filter(n => (username === 'admin' || n.username === username) && n.text.toLowerCase().includes(keyword));
    return reply.view('index', {
        title: 'Kết quả tìm kiếm',
        notes: filteredNotes,
        message: `Kết quả cho "${keyword}"`,
        page: 1,
        totalPages: 1,
        username
    });
});

fastify.get('/users', async (request, reply) => {
    const username = request.cookies.token;
    if (username !== 'admin') return reply.redirect('/');
    return reply.view('users', { users });
});

fastify.get('/reset/:username', async (request, reply) => {
    const admin = request.cookies.token;
    const target = request.params.username;
    if (admin === 'admin') {
        const user = users.find(u => u.username === target);
        if (user) {
            user.password = '123';
            saveUsers();
            writeLog(`Admin reset mật khẩu cho ${target}`);
        }
    }
    return reply.redirect('/users');
});

fastify.get('/remove/:username', async (request, reply) => {
    const admin = request.cookies.token;
    const target = request.params.username;
    if (admin === 'admin') {
        users = users.filter(u => u.username !== target);
        notes = notes.filter(n => n.username !== target);
        saveUsers();
        saveNotes();
        writeLog(`Admin xóa người dùng ${target}`);
    }
    return reply.redirect('/users');
});

fastify.get('/login', async (request, reply) => {
    return reply.view('login', { title: 'Đăng nhập', message: null });
});

fastify.post('/login', async (request, reply) => {
    const { username, password } = request.body;
    const user = users.find(u => u.username === username && u.password === password);
    if (user) {
        reply.setCookie('token', username, { path: '/', httpOnly: true, maxAge: 3600 });
        return reply.redirect('/');
    } else {
        return reply.view('login', { title: 'Đăng nhập', message: 'Sai tên đăng nhập hoặc mật khẩu' });
    }
});

fastify.get('/register', async (request, reply) => {
    return reply.view('register', { title: 'Đăng ký', message: null });
});

fastify.post('/register', async (request, reply) => {
    const { username, password, confirmPassword } = request.body;
    if (!username || !password || !confirmPassword) {
        return reply.view('register', { title: 'Đăng ký', message: 'Vui lòng nhập đầy đủ thông tin' });
    }
    if (password !== confirmPassword) {
        return reply.view('register', { title: 'Đăng ký', message: 'Mật khẩu không khớp' });
    }
    if (users.some(user => user.username === username)) {
        return reply.view('register', { title: 'Đăng ký', message: 'Tên đăng nhập đã được sử dụng' });
    }
    users.push({ username, password });
    saveUsers();
    writeLog(`Người dùng mới: ${username}`);
    return reply.redirect('/login');
});

fastify.get('/logout', async (request, reply) => {
    reply.clearCookie('token', { path: '/' });
    return reply.redirect('/login');
});

const start = async () => {
    try {
        await fastify.listen({ port: 3000 });
        fastify.log.info(`Server chạy tại http://localhost:3000`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();
