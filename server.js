const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Environment variables
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID;
const NOVAPOSHTA_API_KEY = process.env.NOVAPOSHTA_API_KEY;
const SPREADSHEET_ID = '1EsQmEX8U8uqr3r3AhE8XTmKmpY6bIGWEvzNxbuVThEo';
const SHEET_RANGE = 'work!D2:E';

// Google Sheets setup
const sheets = google.sheets({ 
    version: 'v4', 
    auth: GOOGLE_API_KEY 
});

// Временное хранилище заказов и данных доставки
const pendingOrders = new Map();
const deliveryData = new Map();

// Операторы
const OPERATORS = {
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

// ============ HELPER FUNCTIONS ============

// Определение оператора
function getOperator(phone) {
    const prefix = phone.replace(/\D/g, '').slice(3, 5);
    return OPERATORS[prefix] || 'Unknown';
}

// Форматирование номера телефона
function formatPhoneNumber(phone) {
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.startsWith('380')) {
        const number = cleaned.slice(3);
        return `+380 ${number.slice(0, 2)} ${number.slice(2, 5)} ${number.slice(5, 7)} ${number.slice(7, 9)}`;
    }
    return phone;
}

// Генерация уникального ID заказа
function generateOrderId() {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 1000);
    return `ORDER_${timestamp}_${random}`;
}

// ============ GOOGLE SHEETS API ============

// Получить все номера из Google Sheets
app.get('/api/phones', async (req, res) => {
    try {
        console.log('Fetching phones from Google Sheets...');
        
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: SHEET_RANGE
        });

        const rows = response.data.values || [];
        console.log(`Fetched ${rows.length} rows from Google Sheets`);

        const phones = rows
            .map((row, index) => {
                if (!row[0] || !row[1]) return null;
                
                const number = row[0].toString().trim();
                const price = parseFloat(row[1]);
                
                if (isNaN(price) || price <= 0) return null;
                
                return {
                    id: index + 1,
                    number: formatPhoneNumber(number),
                    price: price,
                    operator: getOperator(number)
                };
            })
            .filter(phone => phone !== null);

        console.log(`Processed ${phones.length} valid phones`);

        res.json({ 
            success: true, 
            phones, 
            total: phones.length,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error fetching phones:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            details: 'Failed to fetch phones from Google Sheets'
        });
    }
});

// Получить номер по ID
app.get('/api/phones/:id', async (req, res) => {
    try {
        const phoneId = parseInt(req.params.id);
        
        if (isNaN(phoneId) || phoneId < 1) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid phone ID' 
            });
        }

        console.log(`Fetching phone ID: ${phoneId}`);
        
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: SHEET_RANGE
        });

        const rows = response.data.values || [];
        
        if (phoneId > rows.length) {
            return res.status(404).json({ 
                success: false, 
                error: 'Phone not found' 
            });
        }

        const row = rows[phoneId - 1];
        
        if (!row[0] || !row[1]) {
            return res.status(404).json({ 
                success: false, 
                error: 'Invalid phone data' 
            });
        }

        const number = row[0].toString().trim();
        const price = parseFloat(row[1]);

        const phone = {
            id: phoneId,
            number: formatPhoneNumber(number),
            price: price,
            operator: getOperator(number)
        };

        console.log('Phone found:', phone);

        res.json({ 
            success: true, 
            phone 
        });

    } catch (error) {
        console.error('Error fetching phone:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Поиск номеров
app.post('/api/phones/search', async (req, res) => {
    try {
        const { query, minPrice, maxPrice, operator, sortBy } = req.body;
        
        console.log('Search params:', { query, minPrice, maxPrice, operator, sortBy });

        // Получаем все номера
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: SHEET_RANGE
        });

        const rows = response.data.values || [];
        
        let phones = rows
            .map((row, index) => {
                if (!row[0] || !row[1]) return null;
                
                const number = row[0].toString().trim();
                const price = parseFloat(row[1]);
                
                if (isNaN(price) || price <= 0) return null;
                
                return {
                    id: index + 1,
                    number: formatPhoneNumber(number),
                    price: price,
                    operator: getOperator(number)
                };
            })
            .filter(phone => phone !== null);

        // Фильтрация по поисковому запросу (wildcard поддержка)
        if (query && query.trim() !== '') {
            const searchQuery = query.trim().replace(/\*/g, '.*');
            const regex = new RegExp(searchQuery, 'i');
            
            phones = phones.filter(phone => {
                const cleanNumber = phone.number.replace(/\D/g, '');
                return regex.test(cleanNumber);
            });
        }

        // Фильтр по цене
        if (minPrice !== undefined && minPrice !== null) {
            phones = phones.filter(phone => phone.price >= minPrice);
        }
        
        if (maxPrice !== undefined && maxPrice !== null) {
            phones = phones.filter(phone => phone.price <= maxPrice);
        }

        // Фильтр по оператору
        if (operator && operator !== 'all') {
            phones = phones.filter(phone => phone.operator === operator);
        }

        // Сортировка
        if (sortBy === 'price_asc') {
            phones.sort((a, b) => a.price - b.price);
        } else if (sortBy === 'price_desc') {
            phones.sort((a, b) => b.price - a.price);
        }

        console.log(`Search results: ${phones.length} phones found`);

        res.json({ 
            success: true, 
            phones,
            total: phones.length,
            query: query || '',
            filters: { minPrice, maxPrice, operator, sortBy }
        });

    } catch (error) {
        console.error('Search error:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// ============ TON RATE API ============

app.get('/api/ton-rate', async (req, res) => {
    try {
        console.log('Fetching TON rate from CoinGecko...');
        
        const response = await axios.get(
            'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=uah',
            { timeout: 5000 }
        );
        
        const rate = response.data['the-open-network']?.uah;
        
        if (!rate) {
            throw new Error('TON rate not found in response');
        }

        console.log(`TON rate: ${rate} UAH`);

        res.json({ 
            success: true, 
            rate,
            currency: 'UAH',
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error fetching TON rate:', error.message);
        
        // Fallback значение
        const fallbackRate = 300;
        
        res.json({ 
            success: false, 
            error: error.message,
            rate: fallbackRate,
            fallback: true,
            currency: 'UAH',
            timestamp: new Date().toISOString()
        });
    }
});

// ============ NOVA POSHTA API ============

// Поиск городов
app.post('/api/np-cities', async (req, res) => {
    try {
        const { query } = req.body;
        
        if (!query || query.length < 2) {
            return res.json({ 
                success: false, 
                cities: [],
                message: 'Query too short (minimum 2 characters)' 
            });
        }

        console.log('Searching Nova Poshta cities:', query);

        const response = await axios.post(
            'https://api.novaposhta.ua/v2.0/json/',
            {
                apiKey: NOVAPOSHTA_API_KEY,
                modelName: 'Address',
                calledMethod: 'getCities',
                methodProperties: {
                    FindByString: query,
                    Limit: 20
                }
            },
            { timeout: 10000 }
        );

        if (response.data.success) {
            const cities = response.data.data.map(city => ({
                Ref: city.Ref,
                Description: city.Description,
                DescriptionRu: city.DescriptionRu,
                Present: city.Present,
                Area: city.Area,
                AreaDescription: city.AreaDescription,
                Region: city.Region,
                RegionDescription: city.RegionDescription
            }));

            console.log(`Found ${cities.length} cities`);

            res.json({ 
                success: true, 
                cities,
                total: cities.length
            });
        } else {
            console.error('Nova Poshta API error:', response.data.errors);
            res.json({ 
                success: false, 
                cities: [],
                errors: response.data.errors 
            });
        }

    } catch (error) {
        console.error('Error fetching cities:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            cities: []
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
                error: 'cityRef is required',
                warehouses: []
            });
        }

        console.log('Fetching warehouses for city:', cityRef);

        const response = await axios.post(
            'https://api.novaposhta.ua/v2.0/json/',
            {
                apiKey: NOVAPOSHTA_API_KEY,
                modelName: 'Address',
                calledMethod: 'getWarehouses',
                methodProperties: {
                    CityRef: cityRef,
                    Limit: 100
                }
            },
            { timeout: 10000 }
        );

        if (response.data.success) {
            const warehouses = response.data.data.map(w => ({
                Ref: w.Ref,
                Description: w.Description,
                DescriptionRu: w.DescriptionRu,
                Number: w.Number,
                CityRef: w.CityRef,
                TypeOfWarehouse: w.TypeOfWarehouse,
                Phone: w.Phone,
                Schedule: w.Schedule
            }));

            console.log(`Found ${warehouses.length} warehouses`);

            res.json({ 
                success: true, 
                warehouses,
                total: warehouses.length
            });
        } else {
            console.error('Nova Poshta API error:', response.data.errors);
            res.json({ 
                success: false, 
                warehouses: [],
                errors: response.data.errors 
            });
        }

    } catch (error) {
        console.error('Error fetching warehouses:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            warehouses: []
        });
    }
});

// ============ DELIVERY DATA API ============

app.post('/api/delivery-data', async (req, res) => {
    try {
        const { userId, deliveryData: data } = req.body;
        
        if (!userId) {
            return res.status(400).json({ 
                success: false, 
                error: 'userId is required' 
            });
        }

        console.log('Saving delivery data for user:', userId);

        deliveryData.set(userId, {
            ...data,
            timestamp: new Date().toISOString()
        });

        res.json({ 
            success: true,
            message: 'Delivery data saved successfully'
        });

    } catch (error) {
        console.error('Error saving delivery data:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.get('/api/delivery-data/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        const data = deliveryData.get(userId);
        
        if (!data) {
            return res.status(404).json({ 
                success: false, 
                error: 'Delivery data not found' 
            });
        }

        res.json({ 
            success: true, 
            deliveryData: data 
        });

    } catch (error) {
        console.error('Error fetching delivery data:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// ============ ORDER API ============

app.post('/api/order', async (req, res) => {
    try {
        const { 
            phoneId, 
            phoneNumber, 
            price, 
            customer, 
            delivery, 
            paymentMethod,
            tonTransaction,
            userId 
        } = req.body;

        console.log('Creating order:', { phoneId, phoneNumber, price, paymentMethod });

        // Валидация данных
        if (!phoneId || !phoneNumber || !price || !customer || !delivery || !paymentMethod) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing required fields' 
            });
        }

        // Генерация ID заказа
        const orderId = generateOrderId();
        
        // Расчет финальной цены
        let finalPrice = price;
        let discount = 0;
        let discountAmount = 0;
        
        if (paymentMethod === 'ton') {
            discount = 5;
            discountAmount = price * 0.05;
            finalPrice = price - discountAmount;
        }

        // Получение курса TON для отображения
        let tonRate = 300; // Fallback
        let priceTON = 0;
        
        try {
            const rateResponse = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=uah');
            tonRate = rateResponse.data['the-open-network']?.uah || 300;
            priceTON = (finalPrice / tonRate).toFixed(2);
        } catch (e) {
            console.error('Failed to fetch TON rate:', e.message);
        }

        // Сохранение заказа
        const orderData = {
            orderId,
            phoneId,
            phoneNumber,
            price,
            finalPrice,
            discount,
            discountAmount,
            customer,
            delivery,
            paymentMethod,
            tonTransaction: tonTransaction || null,
            tonRate: paymentMethod === 'ton' ? tonRate : null,
            priceTON: paymentMethod === 'ton' ? priceTON : null,
            userId: userId || null,
            status: 'pending',
            createdAt: new Date().toISOString()
        };

        pendingOrders.set(orderId, orderData);

        console.log('Order created:', orderId);

        // Формирование сообщения для админа
        let message = `🆕 <b>НОВЕ ЗАМОВЛЕННЯ!</b>\n\n`;
        message += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
        
        // Информация о номере
        message += `📱 <b>Номер телефону:</b>\n`;
        message += `<code>${phoneNumber}</code>\n\n`;
        
        // Цена и оплата
        message += `💰 <b>Вартість:</b>\n`;
        message += `Базова ціна: ${price} грн\n`;
        
        if (paymentMethod === 'ton') {
            message += `<b>💎 Оплата TON</b> (знижка -5%)\n`;
            message += `Знижка: -${discountAmount.toFixed(2)} грн\n`;
            message += `<b>До сплати: ${finalPrice.toFixed(2)} грн</b>\n`;
            message += `≈ <b>${priceTON} TON</b> (курс: ${tonRate.toFixed(2)} грн)\n\n`;
            
            if (tonTransaction && tonTransaction.account) {
                const wallet = tonTransaction.account.address;
                const shortWallet = wallet.slice(0, 8) + '...' + wallet.slice(-6);
                message += `🔐 <b>TON гаманець:</b>\n`;
                message += `<code>${shortWallet}</code>\n\n`;
            }
        } else {
            message += `💵 <b>Оплата при отриманні</b>\n`;
            message += `<b>До сплати: ${finalPrice} грн</b>\n\n`;
        }
        
        message += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
        
        // Данные клиента
        message += `👤 <b>Дані клієнта:</b>\n`;
        message += `${customer.lastName} ${customer.firstName}`;
        if (customer.middleName) {
            message += ` ${customer.middleName}`;
        }
        message += `\n📞 <code>${customer.phone}</code>\n\n`;
        
        // Доставка
        message += `📦 <b>Доставка Нова Пошта:</b>\n`;
        message += `🏙 Місто: ${delivery.city}\n`;
        message += `📍 Область: ${delivery.region}\n`;
        if (delivery.district) {
            message += `Район: ${delivery.district}\n`;
        }
        message += `🏢 Відділення:\n${delivery.warehouse}\n\n`;
        
        message += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
        
        // Footer
        message += `🆔 ID замовлення:\n<code>${orderId}</code>\n`;
        message += `🕐 ${new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kiev' })}`;

        // Отправка сообщения админу с inline кнопками
        const telegramResponse = await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
                chat_id: ADMIN_TELEGRAM_ID,
                text: message,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { 
                                text: '✅ Номер в наявності', 
                                callback_data: `confirm_${orderId}` 
                            }
                        ],
                        [
                            { 
                                text: '❌ Номера немає', 
                                callback_data: `reject_${orderId}` 
                            }
                        ]
                    ]
                }
            },
            { timeout: 10000 }
        );

        if (telegramResponse.data.ok) {
            console.log('Order notification sent to admin');
        } else {
            console.error('Failed to send Telegram notification:', telegramResponse.data);
        }

        res.json({ 
            success: true, 
            orderId,
            finalPrice,
            message: 'Замовлення успішно оформлено! Очікуйте підтвердження від менеджера.',
            paymentMethod,
            discount: discount > 0 ? `${discount}%` : null
        });

    } catch (error) {
        console.error('Order creation error:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            details: 'Failed to create order'
        });
    }
});

// Получить информацию о заказе
app.get('/api/order/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        
        const order = pendingOrders.get(orderId);
        
        if (!order) {
            return res.status(404).json({ 
                success: false, 
                error: 'Order not found' 
            });
        }

        res.json({ 
            success: true, 
            order 
        });

    } catch (error) {
        console.error('Error fetching order:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// ============ TELEGRAM WEBHOOK ============

app.post('/api/telegram-webhook', async (req, res) => {
    try {
        console.log('Telegram webhook received:', JSON.stringify(req.body, null, 2));

        const { message, callback_query } = req.body;

        // Обработка callback кнопок
        if (callback_query) {
            const callbackData = callback_query.data;
            const messageId = callback_query.message.message_id;
            const chatId = callback_query.message.chat.id;
            const originalText = callback_query.message.text;

            console.log('Callback query:', callbackData);

            // Подтверждение заказа
            if (callbackData.startsWith('confirm_')) {
                const orderId = callbackData.replace('confirm_', '');
                const order = pendingOrders.get(orderId);

                if (order) {
                    // Обновление статуса заказа
                    order.status = 'confirmed';
                    order.confirmedAt = new Date().toISOString();
                    pendingOrders.set(orderId, order);

                    // Обновление сообщения
                    const updatedText = originalText + '\n\n✅ <b>ПІДТВЕРДЖЕНО</b>\n' +
                        `Менеджер: @${callback_query.from.username || 'admin'}\n` +
                        `Час: ${new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kiev' })}`;

                    await axios.post(
                        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`,
                        {
                            chat_id: chatId,
                            message_id: messageId,
                            text: updatedText,
                            parse_mode: 'HTML'
                        }
                    );

                    // Ответ на callback
                    await axios.post(
                        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
                        {
                            callback_query_id: callback_query.id,
                            text: '✅ Замовлення підтверджено!',
                            show_alert: false
                        }
                    );

                    console.log(`Order ${orderId} confirmed`);

                    // TODO: Уведомление клиента (если есть chat_id)
                    // Можно добавить отправку уведомления клиенту через Telegram

                } else {
                    await axios.post(
                        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
                        {
                            callback_query_id: callback_query.id,
                            text: '❌ Замовлення не знайдено',
                            show_alert: true
                        }
                    );
                }
            }
            // Отклонение заказа
            else if (callbackData.startsWith('reject_')) {
                const orderId = callbackData.replace('reject_', '');
                const order = pendingOrders.get(orderId);

                if (order) {
                    // Обновление статуса заказа
                    order.status = 'rejected';
                    order.rejectedAt = new Date().toISOString();
                    pendingOrders.set(orderId, order);

                    // Обновление сообщения
                    const updatedText = originalText + '\n\n❌ <b>ВІДХИЛЕНО (Номера немає)</b>\n' +
                        `Менеджер: @${callback_query.from.username || 'admin'}\n` +
                        `Час: ${new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kiev' })}`;

                    await axios.post(
                        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`,
                        {
                            chat_id: chatId,
                            message_id: messageId,
                            text: updatedText,
                            parse_mode: 'HTML'
                        }
                    );

                    // Ответ на callback
                    await axios.post(
                        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
                        {
                            callback_query_id: callback_query.id,
                            text: '❌ Замовлення відхилено',
                            show_alert: false
                        }
                    );

                    console.log(`Order ${orderId} rejected`);

                    // TODO: Уведомление клиента (если есть chat_id)

                } else {
                    await axios.post(
                        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
                        {
                            callback_query_id: callback_query.id,
                            text: '❌ Замовлення не знайдено',
                            show_alert: true
                        }
                    );
                }
            }
        }

        // Обработка обычных сообщений (если нужно)
        if (message) {
            console.log('Message received from:', message.from.username || message.from.id);
            // Здесь можно добавить обработку команд и сообщений
        }

        res.json({ success: true });

    } catch (error) {
        console.error('Webhook error:', error.message);
        console.error('Error stack:', error.stack);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Установка webhook
app.post('/api/set-webhook', async (req, res) => {
    try {
        const webhookUrl = `https://ph-mp-api.vercel.app/api/telegram-webhook`;
        
        const response = await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`,
            {
                url: webhookUrl,
                allowed_updates: ['message', 'callback_query']
            }
        );

        console.log('Webhook set response:', response.data);

        res.json({ 
            success: true, 
            result: response.data,
            webhookUrl 
        });

    } catch (error) {
        console.error('Error setting webhook:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Получить информацию о webhook
app.get('/api/webhook-info', async (req, res) => {
    try {
        const response = await axios.get(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo`
        );

        res.json({ 
            success: true, 
            info: response.data.result 
        });

    } catch (error) {
        console.error('Error getting webhook info:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// ============ STATISTICS API ============

app.get('/api/stats', async (req, res) => {
    try {
        const orders = Array.from(pendingOrders.values());
        
        const stats = {
            totalOrders: orders.length,
            pendingOrders: orders.filter(o => o.status === 'pending').length,
            confirmedOrders: orders.filter(o => o.status === 'confirmed').length,
            rejectedOrders: orders.filter(o => o.status === 'rejected').length,
            tonPayments: orders.filter(o => o.paymentMethod === 'ton').length,
            cashPayments: orders.filter(o => o.paymentMethod === 'cash').length,
            totalRevenue: orders
                .filter(o => o.status === 'confirmed')
                .reduce((sum, o) => sum + o.finalPrice, 0),
            averageOrderValue: orders.length > 0 
                ? orders.reduce((sum, o) => sum + o.finalPrice, 0) / orders.length 
                : 0
        };

        res.json({ 
            success: true, 
            stats 
        });

    } catch (error) {
        console.error('Error fetching stats:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// ============ HEALTH CHECK ============

app.get('/api/health', (req, res) => {
    res.json({ 
        success: true, 
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        pendingOrders: pendingOrders.size,
        deliveryDataCache: deliveryData.size,
        environment: {
            nodeVersion: process.version,
            platform: process.platform
        }
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({ 
        success: true, 
        name: 'Phone Marketplace API',
        version: '2.0.0',
        features: [
            'Google Sheets Integration',
            'Nova Poshta API',
            'Telegram Bot Webhook',
            'TON Payment Support',
            'Order Management'
        ],
        endpoints: {
            phones: [
                'GET /api/phones - Get all phones',
                'GET /api/phones/:id - Get phone by ID',
                'POST /api/phones/search - Search phones'
            ],
            payment: [
                'GET /api/ton-rate - Get TON exchange rate'
            ],
            delivery: [
                'POST /api/np-cities - Search cities',
                'POST /api/np-warehouses - Get warehouses',
                'POST /api/delivery-data - Save delivery data',
                'GET /api/delivery-data/:userId - Get delivery data'
            ],
            orders: [
                'POST /api/order - Create order',
                'GET /api/order/:orderId - Get order info',
                'GET /api/stats - Get statistics'
            ],
            telegram: [
                'POST /api/telegram-webhook - Webhook endpoint',
                'POST /api/set-webhook - Set webhook',
                'GET /api/webhook-info - Get webhook info'
            ],
            system: [
                'GET /api/health - Health check',
                'GET / - API info'
            ]
        }
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ 
        success: false, 
        error: 'Internal server error',
        message: err.message 
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        success: false, 
        error: 'Endpoint not found',
        path: req.path,
        method: req.method
    });
});

// Start server
app.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log('📱 Phone Marketplace API v2.0.0');
    console.log('='.repeat(50));
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`👤 Admin Telegram ID: ${ADMIN_TELEGRAM_ID}`);
    console.log(`🔗 Webhook URL: https://ph-mp-api.vercel.app/api/telegram-webhook`);
    console.log(`💎 TON Payment: Enabled`);
    console.log('='.repeat(50));
});

module.exports = app;
