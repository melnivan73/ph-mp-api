// Backend API для загрузки номеров из Google Sheets
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
const RANGE = `${SHEET_NAME}!D2:E`;

const API_KEY = process.env.GOOGLE_API_KEY;

// Кэш курса TON
let tonRateCache = {
    rate: 64,
    lastUpdate: 0
};
const CACHE_DURATION = 60 * 60 * 1000; // 60 минут

// ========================================
// ФУНКЦИЯ ПОЛУЧЕНИЯ КУРСА TON
// ========================================

async function getTonRate() {
  const now = Date.now();
  if (now - tonRateCache.lastUpdate < CACHE_DURATION) {
    return tonRateCache.rate;
  }

  try {
    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=uah'
    );
    
    if (response.ok) {
      const data = await response.json();
      if (data['the-open-network'] && data['the-open-network'].uah) {
        const rate = data['the-open-network'].uah;
        
        tonRateCache = {
          rate: rate,
          lastUpdate: now
        };
        
        console.log(`Курс TON обновлён: ${rate} UAH`);
        return rate;
      }
    }
    
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

    const phones = rows.map((row, index) => {
      if (!row[0] || !row[1]) {
        return null;
      }

      const rawNumber = row[0].toString().trim();
      const formattedNumber = formatPhoneNumber(rawNumber);
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
    }).filter(phone => phone !== null);

    return phones;
  } catch (error) {
    console.error('Ошибка при получении данных из Google Sheets:', error);
    throw error;
  }
}

// ========================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ========================================

function formatPhoneNumber(number) {
  const digits = number.replace(/\D/g, '');
  
  if (digits.startsWith('380')) {
    const code = digits.substr(3, 2);
    const part1 = digits.substr(5, 3);
    const part2 = digits.substr(8, 2);
    const part3 = digits.substr(10, 2);
    return `+380 (${code}) ${part1}-${part2}-${part3}`;
  }
  
  if (digits.startsWith('0')) {
    const code = digits.substr(1, 2);
    const part1 = digits.substr(3, 3);
    const part2 = digits.substr(6, 2);
    const part3 = digits.substr(8, 2);
    return `+380 (${code}) ${part1}-${part2}-${part3}`;
  }
  
  return number;
}

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

function getCategoryByPrice(price) {
  if (price >= 15000) return 'vip';
  if (price >= 8000) return 'gold';
  if (price >= 3000) return 'silver';
  return 'bronze';
}

function generateDescription(number, price) {
  const digits = number.replace(/\D/g, '');
  const lastDigits = digits.slice(-7);
  
  if (/(\d)\1{3,}/.test(lastDigits)) {
    return 'Красивий номер з повторюваними цифрами';
  }
  
  if (hasSequence(lastDigits)) {
    return 'Номер з послідовністю цифр';
  }
  
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
  
  return features.slice(0, 3);
}

// ========================================
// API ENDPOINTS
// ========================================

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
      rate: tonRateCache.rate
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'API працює',
    timestamp: new Date().toISOString()
  });
});

// Отправка заказа через Telegram Bot
app.post('/api/order', async (req, res) => {
  try {
    const { phones, username, userId } = req.body;
    
    if (!phones || phones.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Немає номерів для замовлення'
      });
    }

    const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID;

    if (!TELEGRAM_BOT_TOKEN) {
      throw new Error('TELEGRAM_BOT_TOKEN не налаштовано');
    }

    // Получаем актуальный курс TON
    const tonRate = await getTonRate();
    
    // Расчёт суммы
    const totalUah = phones.reduce((sum, p) => sum + p.price, 0);
    const totalTonWithDiscount = Math.round((totalUah * 0.95) / tonRate); // -5% скидка
    const totalUahWithDiscount = Math.round(totalUah * 0.95);
    const totalTon = Math.round(totalUah / tonRate);

    // Форматирование списка номеров
    const phonesList = phones.map(p => 
      `${p.number} - ${p.price.toLocaleString('uk-UA')} грн.`
    ).join('\n');

    // Сообщение клиенту
    const clientMessage = `🛒 Ваше замовлення

📱 Номери:
${phonesList}

💰 Загальна сума: ${totalUah.toLocaleString('uk-UA')} грн.
або
💎 з додатковою знижкою (-5%) у TON: ${totalTonWithDiscount} TON (приблизно ${totalUahWithDiscount.toLocaleString('uk-UA')} грн.)

👤 Замовник: @${username || 'невідомий'}

Зачекайте, будь ласка, відповіді менеджера,
перевіряємо наявність номерів на ваше замовлення...`;

    // Сообщение администратору
    const adminMessage = `🛒 Новий замовлення!

📱 Номери:
${phonesList}

💰 Загальна сума: ${totalUah.toLocaleString('uk-UA')} грн.
💎 У TON: ${totalTon} TON

👤 Замовник: @${username || 'невідомий'} (ID: ${userId})`;

    // Отправка сообщения клиенту
    if (userId) {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: userId,
          text: clientMessage,
          parse_mode: 'HTML'
        })
      });
    }

    // Отправка сообщения администратору
    if (ADMIN_TELEGRAM_ID) {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: ADMIN_TELEGRAM_ID,
          text: adminMessage,
          parse_mode: 'HTML'
        })
      });
    }

    res.json({
      success: true,
      message: 'Замовлення відправлено'
    });

  } catch (error) {
    console.error('Помилка при відправці замовлення:', error);
    res.status(500).json({
      success: false,
      error: 'Помилка при відправці замовлення',
      message: error.message
    });
  }
});

app.get('/', (req, res) => {
  res.json({
    message: 'Phone Marketplace API',
    version: '1.0.0',
    endpoints: {
      'GET /api/phones': 'Отримати всі номери',
      'GET /api/phones/:id': 'Отримати номер за ID',
      'GET /api/ton-rate': 'Отримати курс TON',
      'POST /api/order': 'Відправити замовлення',
      'GET /api/health': 'Перевірка роботи'
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущено на порту ${PORT}`);
});

module.exports = app;
