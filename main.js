require('dotenv').config(); // читаємо змінні середовища
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const crypto = require('crypto');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./swagger.json');
// === ПОТРІБНО ВСТАНОВИТИ: npm install pg ===
const { Client } = require('pg'); 

// Отримуємо налаштування з .env або ставимо дефолтні значення
const host = process.env.HOST || '0.0.0.0';
const port = process.env.PORT || 3000;
const cacheDir = path.resolve(process.env.CACHE_DIR || './cache');

// Конфігурація підключення до БД
const dbConfig = {
    host: process.env.DB_HOST,      // Ім'я сервісу з compose.yml (postgres-db)
    port: process.env.DB_PORT,      // 5432
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
};

const app = express();
// Глобальна змінна для клієнта БД
let dbClient; 

// Створюємо директорію кешу, якщо її немає
if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
}

// Налаштування multer для завантаження файлів
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, cacheDir),
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Функція для підключення до БД
async function connectToDatabase() {
    console.log('Спроба підключення до PostgreSQL...');
    dbClient = new Client(dbConfig);
    try {
        await dbClient.connect();
        console.log('Успішно підключено до PostgreSQL!');
    } catch (err) {
        console.error('Помилка підключення до PostgreSQL:', err.message);
        // Виходимо, якщо не вдалося підключитися
        process.exit(1); 
    }
}

// Ендпоінти (Тепер асинхронні)
app.post('/register', upload.single('photo'), async (req, res) => {
    if (!req.body.inventory_name) return res.status(400).send('"inventory_name" is required');

    const id = crypto.randomUUID();
    const name = req.body.inventory_name;
    const description = req.body.description || '';
    const photoPath = req.file ? req.file.path : null;
    const photoUrl = req.file ? `/inventory/${id}/photo` : null;

    try {
        const query = `
            INSERT INTO inventory (id, name, description, photo_path, photo_url)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, name, description, photo_url;
        `;
        const values = [id, name, description, photoPath, photoUrl];
        const result = await dbClient.query(query, values);
        
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Помилка при реєстрації:', error);
        res.status(500).send('Помилка сервера при роботі з БД');
    }
});

app.post('/search', async (req, res) => {
    const itemId = req.body.id;
    if (!itemId) return res.status(400).send('"id" is required');
    
    try {
        const query = 'SELECT id, name, description, photo_url FROM inventory WHERE id = $1';
        const result = await dbClient.query(query, [itemId]);
        const item = result.rows[0];

        if (!item) return res.status(404).send('Not Found');

        let resultItem = { ...item };
        if (req.body.has_photo === 'true' && resultItem.photo_url) {
            resultItem.description = `${resultItem.description} (Фото: ${resultItem.photo_url})`;
        }
        res.status(200).json(resultItem);
    } catch (error) {
        console.error('Помилка при пошуку:', error);
        res.status(500).send('Помилка сервера при роботі з БД');
    }
});

app.get('/inventory', async (req, res) => {
    try {
        const result = await dbClient.query('SELECT id, name, description, photo_url FROM inventory ORDER BY name');
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Помилка при отриманні списку:', error);
        res.status(500).send('Помилка сервера при роботі з БД');
    }
});

app.route('/inventory/:id')
    .get(async (req, res) => {
        try {
            const result = await dbClient.query('SELECT * FROM inventory WHERE id = $1', [req.params.id]);
            const item = result.rows[0];
            return item ? res.status(200).json(item) : res.status(404).send('Not Found');
        } catch (error) {
            console.error('Помилка GET /inventory/:id:', error);
            res.status(500).send('Помилка сервера при роботі з БД');
        }
    })
    .put(async (req, res) => {
        const { name, description } = req.body;
        if (!name && !description) return res.status(400).send('Name or description required for update');

        let setClauses = [];
        let values = [];
        let paramIndex = 1;
        
        if (name) {
            setClauses.push(`name = $${paramIndex++}`);
            values.push(name);
        }
        if (description) {
            setClauses.push(`description = $${paramIndex++}`);
            values.push(description);
        }
        
        values.push(req.params.id); // $N - останній параметр для WHERE

        try {
            const query = `
                UPDATE inventory 
                SET ${setClauses.join(', ')} 
                WHERE id = $${paramIndex}
                RETURNING id, name, description, photo_url;
            `;
            const result = await dbClient.query(query, values);

            if (result.rowCount === 0) return res.status(404).send('Not Found');
            res.status(200).json(result.rows[0]);
        } catch (error) {
            console.error('Помилка PUT /inventory/:id:', error);
            res.status(500).send('Помилка сервера при роботі з БД');
        }
    })
    .delete(async (req, res) => {
        try {
            // Отримуємо photo_path для видалення файлу
            const selectResult = await dbClient.query('SELECT photo_path FROM inventory WHERE id = $1', [req.params.id]);
            const item = selectResult.rows[0];

            if (!item) return res.status(404).send('Not Found');

            // Видалення запису з БД
            const deleteResult = await dbClient.query('DELETE FROM inventory WHERE id = $1', [req.params.id]);

            // Видалення файлу
            if (item.photo_path && fs.existsSync(item.photo_path)) {
                 try { fs.unlinkSync(item.photo_path); } catch(e) { console.error('Помилка видалення файлу:', e); }
            }
            
            res.status(200).send('Deleted');
        } catch (error) {
            console.error('Помилка DELETE /inventory/:id:', error);
            res.status(500).send('Помилка сервера при роботі з БД');
        }
    })
    .all((req, res) => res.status(405).send('Method Not Allowed'));

app.route('/inventory/:id/photo')
    .get(async (req, res) => {
        try {
            const result = await dbClient.query('SELECT photo_path FROM inventory WHERE id = $1', [req.params.id]);
            const item = result.rows[0];

            if (!item || !item.photo_path || !fs.existsSync(item.photo_path)) return res.status(404).send('Photo Not Found');
            
            res.setHeader('Content-Type', 'image/jpeg');
            res.sendFile(item.photo_path);
        } catch (error) {
            console.error('Помилка GET /photo:', error);
            res.status(500).send('Помилка сервера');
        }
    })
    .put(upload.single('photo'), async (req, res) => {
        if (!req.file) return res.status(400).send('File not uploaded');

        try {
            // 1. Отримуємо існуючий запис для видалення старого файлу
            const selectResult = await dbClient.query('SELECT photo_path FROM inventory WHERE id = $1', [req.params.id]);
            const item = selectResult.rows[0];
            
            if (!item) {
                // Якщо елемент не знайдено, видаляємо щойно завантажений файл
                fs.unlinkSync(req.file.path); 
                return res.status(404).send('Not Found');
            }
            
            // 2. Видаляємо старий файл
            if (item.photo_path && fs.existsSync(item.photo_path)) {
                try { fs.unlinkSync(item.photo_path); } catch(e) { console.error('Помилка видалення старого файлу:', e); }
            }

            // 3. Оновлюємо посилання в БД на новий файл
            const newPhotoPath = req.file.path;
            const newPhotoUrl = `/inventory/${req.params.id}/photo`;

            const updateQuery = `
                UPDATE inventory 
                SET photo_path = $1, photo_url = $2
                WHERE id = $3
                RETURNING id, name, description, photo_url;
            `;
            const updateResult = await dbClient.query(updateQuery, [newPhotoPath, newPhotoUrl, req.params.id]);
            
            res.status(200).json(updateResult.rows[0]);
        } catch (error) {
            console.error('Помилка PUT /photo:', error);
            // Якщо сталася помилка БД, видаляємо щойно завантажений файл, щоб не засмічувати кеш
            fs.unlinkSync(req.file.path); 
            res.status(500).send('Помилка сервера при оновленні фото');
        }
    })
    .all((req, res) => res.status(405).send('Method Not Allowed'));

// 404 для невідомих ендпоінтів
app.use((req, res) => res.status(404).send('404 - Endpoint Not Found'));

// Головна функція запуску
async function startServer() {
    await connectToDatabase();
    
    // Старт сервера
    app.listen(port, host, () => {
        console.log(`Сервер запущено: http://${host}:${port}`);
        console.log(`Документація Swagger: http://${host}:${port}/docs`);
        console.log(`Директорія кешу: ${cacheDir}`);
    });
}

// Запускаємо головну функцію
startServer();