// Backend API для загрузки номеров из Google Sheets
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');

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

// Telegram Bot (без polling для Vercel)
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;
const bot = new TelegramBot(BOT_TOKEN);

// Хранилище заказов (в продакшене использовать БД)
const activeOrders = new Map();

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

      return {
        id: index + 1,
        number: formattedNumber,
        rawNumber: rawNumber,
        operator: getOperatorByNumber(rawNumber),
        price: price
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
    '67': 'Kyivstar',
    '68': 'Kyivstar',
    '96': 'Kyivstar',
    '97': 'Kyivstar',
    '98': 'Kyivstar',
    '77': 'Kyivstar',
    '50': 'Vodafone',
    '66': 'Vodafone',
    '95': 'Vodafone',
    '99': 'Vodafone',
    '75': 'Vodafone',
    '63': 'lifecell',
    '73': 'lifecell',
    '93': 'lifecell'
  };
  
  return operators[code] || 'Інший оператор';
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

// ========================================
// СИСТЕМА ЗАКАЗОВ
// ========================================

app.post('/api/order', async (req, res) => {
  try {
    const { phones, username, userId } = req.body;
    
    if (!phones || phones.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Немає номерів для замовлення'
      });
    }

    // Получаем актуальный курс TON
    const tonRate = await getTonRate();
    
    // Расчёт суммы
    const totalUah = phones.reduce((sum, p) => sum + p.price, 0);
    const totalTonWithDiscount = Math.round((totalUah * 0.95) / tonRate);
    const totalUahWithDiscount = Math.round(totalUah * 0.95);

    // Генерируем уникальный ID заказа
    const orderId = crypto.randomBytes(8).toString('hex');

    // Сохраняем заказ
    activeOrders.set(orderId, {
      orderId,
      phones,
      totalUah,
      totalTonWithDiscount,
      totalUahWithDiscount,
      tonRate,
      username: username || 'невідомий',
      userId
    });

    // Форматирование списка номеров
    const phonesList = phones.map(p => 
      `${p.number} - ${p.price.toLocaleString('uk-UA')} грн.`
    ).join('\n');

    // Сообщение клиенту
    const clientMessage = `🛒 Ваше замовлення

📱 Номер:
${phonesList}

💰 Загальна сума: ${totalUah.toLocaleString('uk-UA')} грн.
або
💎 з додатковою знижкою (-5%) у TON: ${totalTonWithDiscount} TON (приблизно ${totalUahWithDiscount.toLocaleString('uk-UA')} грн.)

👤 Замовник: @${username || 'невідомий'}

Зачекайте, будь ласка, відповіді менеджера,
перевіряємо наявність номерів на ваше замовлення...`;

    // Сообщение админу с кнопками
    const adminMessage = `🛒 Нове замовлення!

📱 Номер:
${phonesList}

💰 Загальна сума: ${totalUah.toLocaleString('uk-UA')} грн.
💎 У TON: ${totalTonWithDiscount} TON

👤 Замовник: @${username || 'невідомий'} (ID: ${userId})`;

    // Отправка клиенту
    await bot.sendMessage(userId, clientMessage);

    // Отправка админу с кнопками
    await bot.sendMessage(ADMIN_ID, adminMessage, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ В наявності', callback_data: `available_${orderId}` },
            { text: '❌ Номера немає', callback_data: `unavailable_${orderId}` }
          ]
        ]
      }
    });

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

// ========================================
// NOVA POSHTA API INTEGRATION
// ========================================

const NP_API_KEY = process.env.NOVAPOSHTA_API_KEY;
const NP_API_URL = 'https://api.novaposhta.ua/v2.0/json/';

// Поиск городов
app.post('/api/np-cities', async (req, res) => {
  try {
    const { query } = req.body;
    
    if (!query || query.length < 2) {
      return res.json({
        success: true,
        data: []
      });
    }

    const response = await fetch(NP_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        apiKey: NP_API_KEY,
        modelName: 'Address',
        calledMethod: 'searchSettlements',
        methodProperties: {
          CityName: query,
          Limit: 10
        }
      })
    });

    const result = await response.json();

    if (result.success && result.data && result.data[0]) {
      const cities = result.data[0].Addresses || [];
      
      const formattedCities = cities.map(city => ({
        ref: city.DeliveryCity || city.Ref,
        mainDescription: city.MainDescription || '',
        area: city.Area || '',
        region: city.Region || '',
        presentName: city.Present || city.MainDescription || ''
      }));

      res.json({
        success: true,
        data: formattedCities
      });
    } else {
      res.json({
        success: true,
        data: []
      });
    }

  } catch (error) {
    console.error('Nova Poshta cities error:', error);
    res.status(500).json({
      success: false,
      error: 'Помилка отримання міст',
      message: error.message
    });
  }
});

// Получить склады по городу
app.post('/api/np-warehouses', async (req, res) => {
  try {
    const { cityRef } = req.body;
    
    if (!cityRef) {
      return res.status(400).json({
        success: false,
        error: 'cityRef не вказано'
      });
    }

    const response = await fetch(NP_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        apiKey: NP_API_KEY,
        modelName: 'Address',
        calledMethod: 'getWarehouses',
        methodProperties: {
          CityRef: cityRef,
          Limit: 500
        }
      })
    });

    const result = await response.json();

    if (result.success && result.data) {
      const warehouses = result.data.map(wh => ({
        ref: wh.Ref,
        description: wh.Description,
        number: wh.Number || '',
        shortAddress: wh.ShortAddress || ''
      }));

      res.json({
        success: true,
        data: warehouses
      });
    } else {
      res.json({
        success: true,
        data: []
      });
    }

  } catch (error) {
    console.error('Nova Poshta warehouses error:', error);
    res.status(500).json({
      success: false,
      error: 'Помилка отримання відділень',
      message: error.message
    });
  }
});

// ========================================
// ПРИЕМ ДАННЫХ ДОСТАВКИ ИЗ ФОРМЫ
// ========================================

app.post('/api/delivery-data', async (req, res) => {
  try {
    const { orderId, phone, lastName, firstName, city, region, district, warehouse } = req.body;
    
    if (!orderId) {
      return res.status(400).json({
        success: false,
        error: 'ID замовлення не вказано'
      });
    }

    const order = activeOrders.get(orderId);
    
    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Замовлення не знайдено'
      });
    }

    // Сохраняем данные доставки
    const deliveryData = {
      'Телефон': phone,
      'Прізвище': lastName,
      'Ім\'я': firstName,
      'Місто': city,
      'Область': region,
      'Район': district || '-',
      'Склад НП №': warehouse
    };

    order.deliveryData = deliveryData;
    activeOrders.set(orderId, order);

    // Отправляем клиенту кнопки выбора оплаты
    const phonesList = order.phones.map(p => p.number).join(', ');

    const paymentMessage = `✅ Дані збережено!

📱 Номер: ${phonesList}
💰 Сума: ${order.totalUah.toLocaleString('uk-UA')} грн.

Виберіть спосіб оплати:`;

    await bot.sendMessage(order.userId, paymentMessage, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '💵 Оплата при отриманні', callback_data: `payment_${orderId}_cash` }
          ],
          [
            { text: `💎 Оплатити в TON -5% (${order.totalTonWithDiscount} TON)`, callback_data: `payment_${orderId}_ton` }
          ]
        ]
      }
    });

    res.json({
      success: true,
      message: 'Дані збережено'
    });

  } catch (error) {
    console.error('Помилка збереження даних:', error);
    res.status(500).json({
      success: false,
      error: 'Помилка збереження даних',
      message: error.message
    });
  }
});

// ========================================
// ОБРАБОТКА CALLBACK ОТ TELEGRAM
// ========================================

app.post('/api/telegram-webhook', async (req, res) => {
  try {
    const update = req.body;

    // Обработка callback кнопок
    if (update.callback_query) {
      const callbackQuery = update.callback_query;
      const data = callbackQuery.data;
      const [action, orderId] = data.split('_');
      const order = activeOrders.get(orderId);

      if (!order) {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: 'Замовлення не знайдено',
          show_alert: true
        });
        return res.json({ ok: true });
      }

      // АДМИН НАЖАЛ "В НАЯВНОСТІ"
      if (action === 'available') {
        // Убираем кнопки у админа
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
          chat_id: ADMIN_ID,
          message_id: callbackQuery.message.message_id
        });

        await bot.sendMessage(ADMIN_ID, '✅ Відправлено запит клієнту');

        // Отправляем клиенту кнопку с формой
        const phonesList = order.phones.map(p => p.number).join(', ');
        
        const formMessage = `✅ Номер ${phonesList} в наявності!

Повідомте, будь ласка, дані для відправки Новою поштою.
Натисніть кнопку нижче для заповнення форми:`;

        await bot.sendMessage(order.userId, formMessage, {
          reply_markup: {
            inline_keyboard: [
              [{ 
                text: '📝 Заповнити дані', 
                web_app: { url: `https://ph-mp.vercel.app/delivery-form.html?orderId=${orderId}` }
              }]
            ]
          }
        });

        await bot.answerCallbackQuery(callbackQuery.id);
      }
      
      // АДМИН НАЖАЛ "НОМЕРА НЕМАЄ"
      else if (action === 'unavailable') {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
          chat_id: ADMIN_ID,
          message_id: callbackQuery.message.message_id
        });

        await bot.sendMessage(ADMIN_ID, '❌ Відправлено повідомлення клієнту');

        await bot.sendMessage(order.userId, 
          '❌ Номер зараз недоступний, з вами зв\'яжеться менеджер для уточнення інформації'
        );

        activeOrders.delete(orderId);
        await bot.answerCallbackQuery(callbackQuery.id);
      }

      // КЛИЕНТ ПОДТВЕРДИЛ ОПЛАТУ TON
      else if (action === 'ton' && data.split('_')[1] === 'confirm') {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
          chat_id: order.userId,
          message_id: callbackQuery.message.message_id
        });

        const deliveryData = order.deliveryData || {};
        const phonesList = order.phones.map(p => p.number).join(', ');

        // Сообщение клиенту
        await bot.sendMessage(order.userId, 
          '✅ Дякуємо!\n\n' +
          'Наш менеджер перевірить надходження платежу та зв\'яжеться з вами для підтвердження замовлення.\n\n' +
          '⏱ Зазвичай це займає 5-15 хвилин.'
        );

        // Подробное сообщение админу для проверки
        const adminConfirmMessage = `💎 Клієнт підтвердив оплату TON!

📱 Номер: ${phonesList}
💰 Сума: ${order.totalUah.toLocaleString('uk-UA')} грн.
💎 Має бути сплачено: ${order.totalTonWithDiscount} TON

👤 Замовник: @${order.username} (ID: ${order.userId})

📮 Дані для відправки:
${Object.entries(deliveryData).map(([key, value]) => `${key}: ${value}`).join('\n')}

⚠️ ПЕРЕВІРТЕ НАДХОДЖЕННЯ ПЛАТЕЖУ НА ГАМАНЕЦЬ:
UQA3soK4ABEWcsjblRdxW2bBd8Wgfli4WjURqr4p3s-eHpx5

Після підтвердження оплати зв'яжіться з клієнтом.`;

        await bot.sendMessage(ADMIN_ID, adminConfirmMessage);

        activeOrders.delete(orderId);
        await bot.answerCallbackQuery(callbackQuery.id);
      }

      // КЛИЕНТ ОТМЕНИЛ ОПЛАТУ TON
      else if (action === 'ton' && data.split('_')[1] === 'cancel') {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
          chat_id: order.userId,
          message_id: callbackQuery.message.message_id
        });

        await bot.sendMessage(order.userId, 
          '❌ Замовлення скасовано.\n\n' +
          'Якщо у вас виникли питання - зв\'яжіться з нашим менеджером.'
        );

        await bot.sendMessage(ADMIN_ID, 
          `❌ Клієнт @${order.username} (ID: ${order.userId}) скасував замовлення на оплату TON`
        );

        activeOrders.delete(orderId);
        await bot.answerCallbackQuery(callbackQuery.id);
      }

      // КЛИЕНТ ВЫБРАЛ СПОСОБ ОПЛАТЫ
      else if (action === 'payment') {
        const paymentType = data.split('_')[2];

        if (paymentType === 'cash') {
          await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
            chat_id: order.userId,
            message_id: callbackQuery.message.message_id
          });

          const deliveryData = order.deliveryData || {};
          const phonesList = order.phones.map(p => p.number).join(', ');
          
          const adminMessage = `📦 Замовлення підтверджено (Оплата при отриманні)

📱 Номер: ${phonesList}
💰 Сума: ${order.totalUah.toLocaleString('uk-UA')} грн.

👤 Замовник: @${order.username} (ID: ${order.userId})

📮 Дані для відправки:
${Object.entries(deliveryData).map(([key, value]) => `${key}: ${value}`).join('\n')}`;

          await bot.sendMessage(ADMIN_ID, adminMessage);

          await bot.sendMessage(order.userId, 
            '✅ Ваше замовлення прийняте.\n\n' +
            'З вами можуть додатково зв\'язатися для уточнення даних, що відсутні (невірні)'
          );

          activeOrders.delete(orderId);
        } 
        else if (paymentType === 'ton') {
          await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
            chat_id: order.userId,
            message_id: callbackQuery.message.message_id
          });

          const TON_WALLET = 'UQA3soK4ABEWcsjblRdxW2bBd8Wgfli4WjURqr4p3s-eHpx5';
          const phonesList = order.phones.map(p => p.number).join(', ');
          
          // Формируем сообщение с реквизитами для оплаты
          const tonPaymentMessage = `💎 Оплата в TON

📱 Номер: ${phonesList}
💰 Сума: ${order.totalUah.toLocaleString('uk-UA')} грн.
💎 До сплати зі знижкою -5%: ${order.totalTonWithDiscount} TON
(приблизно ${order.totalUahWithDiscount.toLocaleString('uk-UA')} грн.)

📌 Курс TON: ${order.tonRate.toFixed(2)} UAH

🔹 Гаманець для оплати:
\`${TON_WALLET}\`

⚠️ Важливо:
1. Відправте точно ${order.totalTonWithDiscount} TON на вказаний гаманець
2. Після оплати натисніть кнопку "Оплату завершено"
3. Наш менеджер перевірить платіж та підтвердить замовлення`;

          await bot.sendMessage(order.userId, tonPaymentMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Оплату завершено', callback_data: `ton_confirm_${orderId}` }
                ],
                [
                  { text: '❌ Скасувати замовлення', callback_data: `ton_cancel_${orderId}` }
                ]
              ]
            }
          });

          // Уведомляем админа о выборе TON
          const adminNotification = `💎 Клієнт обрав оплату TON

👤 Замовник: @${order.username} (ID: ${order.userId})
📱 Номер: ${phonesList}
💰 Сума: ${order.totalUah.toLocaleString('uk-UA')} грн.
💎 До оплати: ${order.totalTonWithDiscount} TON

Очікується оплата на гаманець:
${TON_WALLET}`;

          await bot.sendMessage(ADMIN_ID, adminNotification);
          
          // НЕ удаляем заказ! Он нужен для ton_confirm/ton_cancel
        }

        await bot.answerCallbackQuery(callbackQuery.id);
      }
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.json({ ok: true });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'API працює',
    timestamp: new Date().toISOString()
  });
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
      'POST /api/telegram-webhook': 'Telegram webhook',
      'GET /api/health': 'Перевірка роботи'
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущено на порту ${PORT}`);
});

module.exports = app;
