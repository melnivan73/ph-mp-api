// Backend API для загрузки номеров из Google Sheets
// server.js

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// ========================================
// НАСТРОЙКИ GOOGLE SHEETS
// ========================================

const SPREADSHEET_ID = '1EsQmEX8U8uqr3r3AhE8XTmKmpY6bIGWEvzNxbuVThEo';
const SHEET_NAME = 'work';
const RANGE = `${SHEET_NAME}!D2:E`; // Колонки D и E, начиная со 2-й строки

// API ключ из переменных окружения (для безопасности)
const API_KEY = process.env.GOOGLE_API_KEY;

// Telegram Bot Token для получения курса TON
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Кэш курса TON
let tonRateCache = {
    rate: 180, // Курс по умолчанию
    lastUpdate: 0
};
const CACHE_DURATION = 60 * 60 * 1000; // 60 минут

// ========================================
// ФУНКЦИЯ ПОЛУЧЕНИЯ КУРСА TON
// ========================================

async function getTonRate() {
  // Проверяем кэш
  const now = Date.now();
  if (now - tonRateCache.lastUpdate < CACHE_DURATION) {
    return tonRateCache.rate;
  }

  try {
    // Используем внешний API для получения курса TON/UAH
    // CoinGecko API (бесплатный, без регистрации)
    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=uah'
    );
    
    if (response.ok) {
      const data = await response.json();
      if (data['the-open-network'] && data['the-open-network'].uah) {
        const rate = data['the-open-network'].uah;
        
        // Обновляем кэш
        tonRateCache = {
          rate: rate,
          lastUpdate: now
        };
        
        console.log(`Курс TON обновлён: ${rate} UAH`);
        return rate;
      }
    }
    
    // Если не удалось получить курс, возвращаем из кэша
    return tonRateCache.rate;
  } catch (error) {
    console.error('Ошибка при получении курса TON:', error);
    return tonRateCache.rate;
  }
}

// ========================================
// ФУНКЦИЯ ПОЛУЧЕНИЯ ДАННЫХ ИЗ GOOGLE SHEETS
// ========================================

async function getPhoneNumbers() {
  try {
    const sheets = google.sheets({
      version: 'v4',
      auth: API_KEY
    });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: RANGE,
    });

    const rows = response.data.values;
    
    if (!rows || rows.length === 0) {
      return [];
    }

    // Преобразуем строки в объекты
    const phones = rows.map((row, index) => {
      // Пропускаем пустые строки
      if (!row[0] || !row[1]) {
        return null;
      }

      // Форматируем номер телефона
      const rawNumber = row[0].toString().trim();
      const formattedNumber = formatPhoneNumber(rawNumber);

      // Определяем категорию по цене
      const price = parseInt(row[1]) || 0;
      const category = getCategoryByPrice(price);

      return {
        id: index + 1,
        number: formattedNumber,
        rawNumber: rawNumber,
        operator: getOperatorByNumber(rawNumber),
        category: category,
        price: price,
        description: generateDescription(rawNumber, price),
        features: generateFeatures(rawNumber, price)
      };
    }).filter(phone => phone !== null); // Удаляем null значения

    return phones;
  } catch (error) {
    console.error('Ошибка при получении данных из Google Sheets:', error);
    throw error;
  }
}

// ========================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ========================================

// Форматирование номера телефона
function formatPhoneNumber(number) {
  // Удаляем все нецифровые символы
  const digits = number.replace(/\D/g, '');
  
  // Если номер начинается с 380, форматируем как +380
  if (digits.startsWith('380')) {
    const code = digits.substr(3, 2);
    const part1 = digits.substr(5, 3);
    const part2 = digits.substr(8, 2);
    const part3 = digits.substr(10, 2);
    return `+380 (${code}) ${part1}-${part2}-${part3}`;
  }
  
  // Если номер начинается с 0, добавляем +380
  if (digits.startsWith('0')) {
    const code = digits.substr(1, 2);
    const part1 = digits.substr(3, 3);
    const part2 = digits.substr(6, 2);
    const part3 = digits.substr(8, 2);
    return `+380 (${code}) ${part1}-${part2}-${part3}`;
  }
  
  // Если формат неизвестен, возвращаем как есть
  return number;
}

// Определение оператора по коду
function getOperatorByNumber(number) {
  const digits = number.replace(/\D/g, '');
  const code = digits.startsWith('380') ? digits.substr(3, 2) : digits.substr(1, 2);
  
  const operators = {
    '39': 'Kyivstar',
    '67': 'Kyivstar',
    '68': 'Kyivstar',
    '96': 'Kyivstar',
    '97': 'Kyivstar',
    '98': 'Kyivstar',
    '50': 'Vodafone',
    '66': 'Vodafone',
    '95': 'Vodafone',
    '99': 'Vodafone',
    '63': 'lifecell',
    '73': 'lifecell',
    '93': 'lifecell',
    '91': 'Trimob',
    '92': 'Peoplenet'
  };
  
  return operators[code] || 'Інший оператор';
}

// Определение категории по цене
function getCategoryByPrice(price) {
  if (price >= 15000) return 'vip';
  if (price >= 8000) return 'gold';
  if (price >= 3000) return 'silver';
  return 'bronze';
}

// Генерация описания
function generateDescription(number, price) {
  const digits = number.replace(/\D/g, '');
  const lastDigits = digits.slice(-7);
  
  // Проверяем на повторяющиеся цифры
  if (/(\d)\1{3,}/.test(lastDigits)) {
    return 'Красивий номер з повторюваними цифрами';
  }
  
  // Проверяем на последовательность
  if (hasSequence(lastDigits)) {
    return 'Номер з послідовністю цифр';
  }
  
  // Проверяем на одинаковые последние цифры
  if (/(\d)\1{2}$/.test(lastDigits)) {
    return 'Номер з однаковими останніми цифрами';
  }
  
  if (price >= 15000) {
    return 'Ексклюзивний VIP номер';
  }
  
  if (price >= 8000) {
    return 'Преміум номер для бізнесу';
  }
  
  return 'Гарний номер телефону';
}

// Проверка на последовательность
function hasSequence(digits) {
  for (let i = 0; i < digits.length - 2; i++) {
    const a = parseInt(digits[i]);
    const b = parseInt(digits[i + 1]);
    const c = parseInt(digits[i + 2]);
    
    if (b === a + 1 && c === b + 1) return true;
    if (b === a - 1 && c === b - 1) return true;
  }
  return false;
}

// Генерация особенностей
function generateFeatures(number, price) {
  const features = [];
  const digits = number.replace(/\D/g, '');
  const lastDigits = digits.slice(-7);
  
  if (price >= 15000) features.push('VIP');
  if (price >= 8000) features.push('Преміум');
  if (/(\d)\1{3,}/.test(lastDigits)) features.push('Повторювані цифри');
  if (hasSequence(lastDigits)) features.push('Послідовність');
  if (/(\d)\1{2}$/.test(lastDigits)) features.push('Красива кінцівка');
  if (price < 3000) features.push('Доступна ціна');
  features.push('Легко запам\'ятати');
  
  return features.slice(0, 3); // Максимум 3 особенности
}

// ========================================
// API ENDPOINTS
// ========================================

// Получить все номера
app.get('/api/phones', async (req, res) => {
  try {
    const phones = await getPhoneNumbers();
    res.json({
      success: true,
      count: phones.length,
      data: phones
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Помилка при завантаженні даних',
      message: error.message
    });
  }
});

// Получить номер по ID
app.get('/api/phones/:id', async (req, res) => {
  try {
    const phones = await getPhoneNumbers();
    const phone = phones.find(p => p.id === parseInt(req.params.id));
    
    if (!phone) {
      return res.status(404).json({
        success: false,
        error: 'Номер не знайдено'
      });
    }

    res.json({
      success: true,
      data: phone
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Помилка при завантаженні даних',
      message: error.message
    });
  }
});

// Фильтрация по категории
app.get('/api/phones/category/:category', async (req, res) => {
  try {
    const phones = await getPhoneNumbers();
    const filtered = phones.filter(p => p.category === req.params.category);
    
    res.json({
      success: true,
      count: filtered.length,
      data: filtered
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Помилка при завантаженні даних',
      message: error.message
    });
  }
});

// Поиск номеров
app.get('/api/phones/search/:query', async (req, res) => {
  try {
    const phones = await getPhoneNumbers();
    const query = req.params.query.toLowerCase();
    
    const filtered = phones.filter(p => 
      p.number.toLowerCase().includes(query) ||
      p.rawNumber.includes(query) ||
      p.operator.toLowerCase().includes(query)
    );
    
    res.json({
      success: true,
      count: filtered.length,
      data: filtered
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Помилка при завантаженні даних',
      message: error.message
    });
  }
});

// Получить курс TON
app.get('/api/ton-rate', async (req, res) => {
  try {
    const rate = await getTonRate();
    res.json({
      success: true,
      rate: rate,
      lastUpdate: new Date(tonRateCache.lastUpdate).toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Помилка при завантаженні курсу TON',
      message: error.message,
      rate: tonRateCache.rate // Возвращаем кэшированное значение
    });
  }
});

// Healthcheck
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'API працює',
    timestamp: new Date().toISOString()
  });
});

// Главная страница
app.get('/', (req, res) => {
  res.json({
    message: 'Phone Marketplace API',
    version: '1.0.0',
    totalPhones: 'Дані завантажуються з Google Sheets',
    endpoints: {
      'GET /api/phones': 'Отримати всі номери',
      'GET /api/phones/:id': 'Отримати номер за ID',
      'GET /api/phones/category/:category': 'Фільтр за категорією',
      'GET /api/phones/search/:query': 'Пошук номерів',
      'GET /api/health': 'Перевірка роботи'
    }
  });
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущено на порту ${PORT}`);
  console.log(`📊 API доступний за адресою: http://localhost:${PORT}`);
});

// Экспорт для Vercel
module.exports = app;
