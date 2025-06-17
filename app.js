const path = require('path')
const fastify = require('fastify')({ logger: true })
const fastifyFormbody = require('@fastify/formbody')
const fastifyView = require('@fastify/view')
const fastifyStatic = require('@fastify/static')
const fastifyCookie = require('@fastify/cookie')
const fastifySession = require('@fastify/session')
const fastifyMultipart = require('@fastify/multipart')
const fs = require('fs')
const util = require('util')

const writeFile = util.promisify(fs.writeFile)

const notes = []
const users = []

// Cấu hình static + multipart
fastify.register(fastifyStatic, {
    root: path.join(__dirname, 'public'),
    prefix: '/public/',
})

fastify.register(fastifyMultipart)
fastify.register(fastifyFormbody)
fastify.register(fastifyCookie)
fastify.register(fastifySession, {
    secret: 'a secret with minimum length of 32 characters',
    cookie: { secure: false },
})

fastify.register(fastifyView, {
    engine: { pug: require('pug') },
    root: path.join(__dirname, 'views'),
})

// Middleware để lấy user
fastify.addHook('preHandler', (req, reply, done) => {
    reply.locals = { user: req.session.user || null }
    done()
})

// Trang chủ
fastify.get('/', async (req, reply) => {
    const user = req.session.user
    const visibleNotes = user?.role === 'admin' ? notes : notes.filter(n => n.username === user?.username)
    return reply.view('index.pug', { notes: visibleNotes, user })
})

// Đăng ký
fastify.get('/register', (req, reply) => {
    reply.view('register.pug')
})

fastify.post('/register', (req, reply) => {
    const { username, password } = req.body
    const exists = users.find(u => u.username === username)
    if (exists) return reply.send('User already exists.')
    users.push({ username, password, role: 'user' })
    reply.redirect('/login')
})

// Đăng nhập
fastify.get('/login', (req, reply) => {
    reply.view('login.pug')
})

fastify.post('/login', (req, reply) => {
    const { username, password } = req.body
    const user = users.find(u => u.username === username && u.password === password)
    if (!user) return reply.send('Invalid credentials')
    req.session.user = user
    reply.redirect('/')
})

// Đăng xuất
fastify.get('/logout', (req, reply) => {
    req.destroySession(() => {
        reply.redirect('/')
    })
})

// Trang thêm ghi chú
fastify.get('/add', (req, reply) => {
    reply.view('add.pug', { user: req.session.user })
})

// Xử lý thêm ghi chú
fastify.post('/add', async (req, reply) => {
    const data = await req.file()
    const { title, content } = data.fields
    let imagePath = null

    if (data && data.filename) {
        const uploadPath = path.join(__dirname, 'public/uploads', data.filename)
        await writeFile(uploadPath, await data.toBuffer())
        imagePath = `/public/uploads/${data.filename}`
    }

    notes.push({
        id: Date.now(),
        title,
        content,
        image: imagePath,
        username: req.session.user.username,
    })

    reply.redirect('/')
})

// Trang admin quản lý user
fastify.get('/users', (req, reply) => {
    const user = req.session.user
    if (!user || user.role !== 'admin') return reply.code(403).send('Forbidden')
    reply.view('users.pug', { users, user })
})

// Start server
const start = async () => {
    try {
        await fastify.listen({ port: 3000 })
        console.log('Server đang chạy tại http://localhost:3000')
    } catch (err) {
        fastify.log.error(err)
        process.exit(1)
    }
}

start()
