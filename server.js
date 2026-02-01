const express = require('express');
const axios = require('axios');
const cors = require('cors');

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

// Временное хранилище заказов
const pendingOrders = new Map();
const deliveryData = new Map();

console.log('Starting Phone Marketplace API...');
console.log('Admin ID:', ADMIN_TELEGRAM_ID);

// ============ HEALTH CHECK ============
app.get('/api/health', (req, res) => {
    res.json({ 
        success: true, 
        status: 'OK',
        timestamp: new Date().toISOString(),
        version: '2.0.1'
    });
});

// ============ ROOT ============
app.get('/', (req, res) => {
    res.json({ 
        success: true, 
        name: 'Phone Marketplace API',
        version: '2.0.1',
        status: 'running'
    });
});

// ============ GOOGLE SHEETS API ============
app.get('/api/phones', async (req, res) => {
    try {
        const url = `https://sheets.googleapis.com/v4/spreadsheets/1EsQmEX8U8uqr3r3AhE8XTmKmpY6bIGWEvzNxbuVThEo/values/work!D2:E?key=${GOOGLE_API_KEY}`;
        
        const response = await axios.get(url, { timeout: 10000 });
        
        const rows = response.data.values || [];
        
        const phones = rows
            .map((row, index) => {
                if (!row[0] || !row[1]) return null;
                return {
                    id: index + 1,
                    number: row[0].toString().trim(),
                    price: parseFloat(row[1])
                };
            })
            .filter(phone => phone !== null && !isNaN(phone.price));

        res.json({ 
            success: true, 
            phones, 
            total: phones.length 
        });

    } catch (error) {
        console.error('Error fetching phones:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// ============ TON RATE ============
app.get('/api/ton-rate', async (req, res) => {
    try {
        const response = await axios.get(
            'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=uah',
            { timeout: 5000 }
        );
        
        const rate = response.data['the-open-network']?.uah || 300;

        res.json({ 
            success: true, 
            rate 
        });

    } catch (error) {
        console.error('Error fetching TON rate:', error.message);
        res.json({ 
            success: false, 
            rate: 300,
            fallback: true
        });
    }
});

// ============ NOVA POSHTA ============
app.post('/api/np-cities', async (req, res) => {
    try {
        const { query } = req.body;
        
        if (!query || query.length < 2) {
            return res.json({ success: false, cities: [] });
        }

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
                Present: city.Present,
                Area: city.Area,
                Region: city.Region
            }));
            res.json({ success: true, cities });
        } else {
            res.json({ success: false, cities: [] });
        }

    } catch (error) {
        console.error('Error fetching cities:', error.message);
        res.status(500).json({ success: false, cities: [], error: error.message });
    }
});

app.post('/api/np-warehouses', async (req, res) => {
    try {
        const { cityRef } = req.body;
        
        if (!cityRef) {
            return res.status(400).json({ success: false, warehouses: [] });
        }

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
                Number: w.Number
            }));
            res.json({ success: true, warehouses });
        } else {
            res.json({ success: false, warehouses: [] });
        }

    } catch (error) {
        console.error('Error fetching warehouses:', error.message);
        res.status(500).json({ success: false, warehouses: [], error: error.message });
    }
});

// ============ ORDER ============
app.post('/api/order', async (req, res) => {
    try {
        const { 
            phoneId, 
            phoneNumber, 
            price, 
            customer, 
            delivery, 
            paymentMethod,
            tonTransaction 
        } = req.body;

        console.log('Creating order:', { phoneNumber, price, paymentMethod });

        // Валидация
        if (!phoneNumber || !price || !customer || !delivery || !paymentMethod) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing required fields' 
            });
        }

        // Генерация ID
        const orderId = `ORDER_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        
        // Расчет цены
        let finalPrice = price;
        let discount = 0;
        
        if (paymentMethod === 'ton') {
            discount = 5;
            finalPrice = price * 0.95;
        }

        // Получение курса TON
        let tonRate = 300;
        let priceTON = 0;
        
        try {
            const rateResponse = await axios.get(
                'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=uah',
                { timeout: 3000 }
            );
            tonRate = rateResponse.data['the-open-network']?.uah || 300;
            priceTON = (finalPrice / tonRate).toFixed(2);
        } catch (e) {
            console.log('Using fallback TON rate');
        }

        // Сохранение заказа
        pendingOrders.set(orderId, {
            orderId,
            phoneId,
            phoneNumber,
            price,
            finalPrice,
            discount,
            customer,
            delivery,
            paymentMethod,
            tonTransaction,
            tonRate: paymentMethod === 'ton' ? tonRate : null,
            priceTON: paymentMethod === 'ton' ? priceTON : null,
            status: 'pending',
            createdAt: new Date().toISOString()
        });

        // Формирование сообщения
        let message = `🆕 <b>НОВЕ ЗАМОВЛЕННЯ!</b>\n\n`;
        message += `📱 <b>Номер:</b> <code>${phoneNumber}</code>\n\n`;
        
        message += `💰 <b>Вартість:</b>\n`;
        message += `Базова ціна: ${price} грн\n`;
        
        if (paymentMethod === 'ton') {
            message += `<b>💎 Оплата TON</b> (-5%)\n`;
            message += `<b>До сплати: ${finalPrice.toFixed(2)} грн</b>\n`;
            message += `≈ <b>${priceTON} TON</b>\n\n`;
            
            if (tonTransaction && tonTransaction.account) {
                const wallet = tonTransaction.account.address;
                const shortWallet = wallet.slice(0, 8) + '...' + wallet.slice(-6);
                message += `🔐 <b>Гаманець:</b> <code>${shortWallet}</code>\n\n`;
            }
        } else {
            message += `💵 <b>Оплата при отриманні</b>\n`;
            message += `<b>До сплати: ${finalPrice} грн</b>\n\n`;
        }
        
        message += `👤 <b>Клієнт:</b>\n`;
        message += `${customer.lastName} ${customer.firstName}`;
        if (customer.middleName) message += ` ${customer.middleName}`;
        message += `\n📞 <code>${customer.phone}</code>\n\n`;
        
        message += `📦 <b>Доставка:</b>\n`;
        message += `🏙 ${delivery.city}\n`;
        message += `📍 ${delivery.region}\n`;
        if (delivery.district) message += `${delivery.district}\n`;
        message += `🏢 ${delivery.warehouse}\n\n`;
        
        message += `🆔 <code>${orderId}</code>\n`;
        message += `🕐 ${new Date().toLocaleString('uk-UA')}`;

        // Отправка в Telegram
        try {
            await axios.post(
                `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
                {
                    chat_id: ADMIN_TELEGRAM_ID,
                    text: message,
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '✅ В наявності', callback_data: `confirm_${orderId}` },
                                { text: '❌ Немає', callback_data: `reject_${orderId}` }
                            ]
                        ]
                    }
                },
                { timeout: 10000 }
            );
            console.log('Order notification sent');
        } catch (telegramError) {
            console.error('Telegram error:', telegramError.message);
        }

        res.json({ 
            success: true, 
            orderId,
            finalPrice,
            message: 'Замовлення оформлено!'
        });

    } catch (error) {
        console.error('Order error:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// ============ TELEGRAM WEBHOOK ============
app.post('/api/telegram-webhook', async (req, res) => {
    try {
        const { callback_query } = req.body;

        if (callback_query) {
            const callbackData = callback_query.data;
            const messageId = callback_query.message.message_id;
            const chatId = callback_query.message.chat.id;
            const originalText = callback_query.message.text;

            if (callbackData.startsWith('confirm_')) {
                const orderId = callbackData.replace('confirm_', '');
                const order = pendingOrders.get(orderId);

                if (order) {
                    order.status = 'confirmed';
                    pendingOrders.set(orderId, order);

                    await axios.post(
                        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`,
                        {
                            chat_id: chatId,
                            message_id: messageId,
                            text: originalText + '\n\n✅ <b>ПІДТВЕРДЖЕНО</b>',
                            parse_mode: 'HTML'
                        }
                    );

                    await axios.post(
                        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
                        {
                            callback_query_id: callback_query.id,
                            text: '✅ Підтверджено'
                        }
                    );
                }
            } else if (callbackData.startsWith('reject_')) {
                const orderId = callbackData.replace('reject_', '');
                const order = pendingOrders.get(orderId);

                if (order) {
                    order.status = 'rejected';
                    pendingOrders.set(orderId, order);

                    await axios.post(
                        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`,
                        {
                            chat_id: chatId,
                            message_id: messageId,
                            text: originalText + '\n\n❌ <b>ВІДХИЛЕНО</b>',
                            parse_mode: 'HTML'
                        }
                    );

                    await axios.post(
                        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
                        {
                            callback_query_id: callback_query.id,
                            text: '❌ Відхилено'
                        }
                    );
                }
            }
        }

        res.json({ success: true });

    } catch (error) {
        console.error('Webhook error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({ 
        success: false, 
        error: 'Internal server error' 
    });
});

// Start server
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}

module.exports = app;
