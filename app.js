import express from 'express';
import routes from './src/routes/index.js';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const PORT = process.env.PORT || 3000;
const API_URL = process.env.API_URL || 'no url';

const app = express();

app.use(cors()); // Para permitir peticiones desde cualquier origen

app.use(express.json()); // para interpretar los datos que vienen en el body de las peticiones
app.use(express.urlencoded({ extended: true })); // Para interpretar datos de formularios (x-www-form-urlencoded)

// Servir archivos subidos (imágenes, etc.)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use('/api', routes);


app.listen(PORT, () => {
    console.log(`Server is online in url ${API_URL}/api`);
});