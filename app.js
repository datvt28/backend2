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

// Đảm bảo thư mục upload tồn tại
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Đọc ghi chú từ file
let notes = [];
try {
    const data = fs.readFileSync(notesFile, 'utf8');
    notes = JSON.parse(data);
} catch {
    notes = [];
}

// Đọc users từ file
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

// Đăng ký các plugin Fastify
fastify.register(fastifyStatic, {
    root: path.join(__dirname, 'public'),
    prefix: '/',
});

fastify.register(fastifyCookie, {
    secret: 'my-secret-cookie-key',
    parseOptions: {},
});

fastify.register(fastifyFormbody);

fastify.register(fastifyMultipart, {
    addToBody: true,
});

fastify.register(pointOfView, {
    engine: {
        pug: require('pug'),
    },
    root: path.join(__dirname, 'views'),
});

// Middleware kiểm tra đăng nhập
function checkAuth(request, reply, done) {
    const { token } = request.cookies;
    if (token === 'valid-token') {
        done();
    } else {
        reply.redirect('/login');
    }
}

// Bảo vệ route (ngoại trừ /login, /register)
fastify.addHook('preHandler', (request, reply, done) => {
    const publicRoutes = ['/login', '/register'];
    if (publicRoutes.includes(request.routerPath)) {
        return done();
    }
    checkAuth(request, reply, done);
});

// Trang chủ - danh sách ghi chú
fastify.get('/', async (request, reply) => {
    return reply.view('index', { title: 'Ghi chú cá nhân', notes, message: null });
});

// Thêm ghi chú mới kèm upload ảnh
fastify.post('/submit', async (request, reply) => {
    const parts = request.parts();

    let text = '';
    let imageFileName = '';

    for await (const part of parts) {
        if (part.file) {
            const ext = path.extname(part.filename);
            const fileName = nanoid() + ext;
            const filePath = path.join(uploadDir, fileName);

            await pump(part.file, fs.createWriteStream(filePath));
            imageFileName = '/uploads/' + fileName;
        } else if (part.fieldname === 'note') {
            text = part.value.trim();
        }
    }

    if (!text) {
        return reply.view('index', { title: 'Ghi chú cá nhân', notes, message: 'Nội dung ghi chú không được để trống' });
    }

    notes.push({ id: nanoid(), text, image: imageFileName });
    saveNotes();

    return reply.redirect('/');
});

// Xóa ghi chú
fastify.get('/delete/:id', async (request, reply) => {
    const id = request.params.id;
    const index = notes.findIndex(n => n.id === id);
    if (index !== -1) {
        if (notes[index].image) {
            const imgPath = path.join(__dirname, 'public', notes[index].image);
            if (fs.existsSync(imgPath)) {
                fs.unlinkSync(imgPath);
            }
        }
        notes.splice(index, 1);
        saveNotes();
    }
    return reply.redirect('/');
});

// Hiển thị form đăng nhập
fastify.get('/login', async (request, reply) => {
    return reply.view('login', { title: 'Đăng nhập', message: null });
});

// Xử lý đăng nhập
fastify.post('/login', async (request, reply) => {
    const { username, password } = request.body;

    const user = users.find(u => u.username === username && u.password === password);
    if (user) {
        reply.setCookie('token', 'valid-token', {
            path: '/',
            httpOnly: true,
            maxAge: 3600,
        });
        return reply.redirect('/');
    } else {
        return reply.view('login', { title: 'Đăng nhập', message: 'Sai tên đăng nhập hoặc mật khẩu' });
    }
});

// Hiển thị form đăng ký
fastify.get('/register', async (request, reply) => {
    return reply.view('register', { title: 'Đăng ký', message: null });
});

// Xử lý đăng ký
fastify.post('/register', async (request, reply) => {
    const { username, password, confirmPassword } = request.body;

    if (!username || !password || !confirmPassword) {
        return reply.view('register', { title: 'Đăng ký', message: 'Vui lòng nhập đầy đủ thông tin' });
    }

    if (password !== confirmPassword) {
        return reply.view('register', { title: 'Đăng ký', message: 'Mật khẩu không khớp' });
    }

    const userExists = users.some(user => user.username === username);
    if (userExists) {
        return reply.view('register', { title: 'Đăng ký', message: 'Tên đăng nhập đã được sử dụng' });
    }

    users.push({ username, password });
    saveUsers();
    return reply.redirect('/login');
});

// Đăng xuất
fastify.get('/logout', async (request, reply) => {
    reply.clearCookie('token', { path: '/' });
    return reply.redirect('/login');
});

// Khởi chạy server
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
