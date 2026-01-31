// Telegram Bot для обработки заказов
// bot.js

const TelegramBot = require('node-telegram-bot-api');

// Токен бота из переменных окружения
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;

// Создаём бота
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Хранилище активных заказов (в продакшене использовать БД)
const activeOrders = new Map();

// ========================================
// ФУНКЦИИ ОТПРАВКИ СООБЩЕНИЙ
// ========================================

// Отправка заказа админу с кнопками
async function sendOrderToAdmin(orderData) {
    const { orderId, phones, totalUah, totalTon, username, userId } = orderData;
    
    const phonesList = phones.map(p => 
        `${p.number} - ${p.price.toLocaleString('uk-UA')} грн.`
    ).join('\n');

    const message = `🛒 Нове замовлення!

📱 Номер:
${phonesList}

💰 Загальна сума: ${totalUah.toLocaleString('uk-UA')} грн.
💎 У TON: ${totalTon} TON

👤 Замовник: @${username || 'невідомий'} (ID: ${userId})`;

    const keyboard = {
        inline_keyboard: [
            [
                { text: '✅ В наявності', callback_data: `available_${orderId}` },
                { text: '❌ Номера немає', callback_data: `unavailable_${orderId}` }
            ]
        ]
    };

    // Сохраняем заказ
    activeOrders.set(orderId, orderData);

    await bot.sendMessage(ADMIN_ID, message, {
        reply_markup: keyboard,
        parse_mode: 'HTML'
    });
}

// Отправка подтверждения клиенту
async function sendOrderConfirmation(userId, phones, totalUah, totalTon) {
    const phonesList = phones.map(p => 
        `${p.number} - ${p.price.toLocaleString('uk-UA')} грн.`
    ).join('\n');

    const totalUahWithDiscount = Math.round(totalUah * 0.95);

    const message = `🛒 Ваше замовлення

📱 Номер:
${phonesList}

💰 Загальна сума: ${totalUah.toLocaleString('uk-UA')} грн.
або
💎 з додатковою знижкою (-5%) у TON: ${totalTon} TON (приблизно ${totalUahWithDiscount.toLocaleString('uk-UA')} грн.)

👤 Замовник: @${username || 'невідомий'}

Зачекайте, будь ласка, відповіді менеджера,
перевіряємо наявність номерів на ваше замовлення...`;

    await bot.sendMessage(userId, message);
}

// ========================================
// ОБРАБОТЧИК CALLBACK КНОПОК
// ========================================

bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;

    try {
        // Парсим callback data
        const [action, orderId] = data.split('_');
        const order = activeOrders.get(orderId);

        if (!order) {
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: 'Замовлення не знайдено',
                show_alert: true
            });
            return;
        }

        // ========================================
        // АДМИН НАЖАЛ "В НАЯВНОСТІ"
        // ========================================
        if (action === 'available') {
            // Обновляем сообщение админу
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                chat_id: chatId,
                message_id: messageId
            });
            
            await bot.sendMessage(chatId, '✅ Відправлено запит клієнту на заповнення даних');

            // Отправляем клиенту форму для заполнения
            const phonesList = order.phones.map(p => p.number).join(', ');
            
            const formMessage = `✅ Номер ${phonesList} в наявності!

Повідомте, будь ласка, дані для відправки Новою поштою:

Заповніть дані у форматі:
Телефон: [ваш телефон]
Прізвище: [ваше прізвище]
Ім'я: [ваше ім'я]
Місто: [ваше місто]
Область: [ваша область]
Район: [ваш район]
Склад НП №: [номер складу]

Або натисніть кнопку нижче для введення даних:`;

            const formKeyboard = {
                inline_keyboard: [
                    [{ text: '📝 Заповнити дані', callback_data: `fill_form_${orderId}` }]
                ]
            };

            await bot.sendMessage(order.userId, formMessage, {
                reply_markup: formKeyboard
            });

            await bot.answerCallbackQuery(callbackQuery.id);
        }

        // ========================================
        // АДМИН НАЖАЛ "НОМЕРА НЕМАЄ"
        // ========================================
        else if (action === 'unavailable') {
            // Обновляем сообщение админу
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                chat_id: chatId,
                message_id: messageId
            });
            
            await bot.sendMessage(chatId, '❌ Відправлено повідомлення клієнту про відсутність номера');

            // Отправляем клиенту сообщение
            const message = `❌ Номер зараз недоступний, з вами зв'яжеться менеджер для уточнення інформації`;

            await bot.sendMessage(order.userId, message);

            // Удаляем заказ из активных
            activeOrders.delete(orderId);

            await bot.answerCallbackQuery(callbackQuery.id);
        }

        // ========================================
        // КЛИЕНТ НАЖАЛ "ЗАПОВНИТИ ДАНІ"
        // ========================================
        else if (action === 'fill' && data.includes('form')) {
            // Запрашиваем у клиента данные
            await bot.sendMessage(order.userId, 
                '📝 Введіть дані для відправки у форматі:\n\n' +
                'Телефон:\n' +
                'Прізвище:\n' +
                'Ім\'я:\n' +
                'Місто:\n' +
                'Область:\n' +
                'Район:\n' +
                'Склад НП №:\n\n' +
                'Вставте текст і заповніть після кожного двокрапки'
            );

            // Сохраняем состояние ожидания данных
            order.waitingForData = true;
            activeOrders.set(orderId, order);

            await bot.answerCallbackQuery(callbackQuery.id);
        }

        // ========================================
        // КЛИЕНТ ВЫБРАЛ СПОСОБ ОПЛАТЫ
        // ========================================
        else if (action === 'payment') {
            const paymentType = data.split('_')[2]; // cash_on_delivery или ton

            if (paymentType === 'cash') {
                // Оплата при получении
                await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                    chat_id: order.userId,
                    message_id: messageId
                });

                // Отправляем данные админу
                const deliveryData = order.deliveryData || {};
                const adminMessage = `📦 Замовлення підтверджено (Оплата при отриманні)

📱 Номер: ${order.phones.map(p => p.number).join(', ')}
💰 Сума: ${order.totalUah.toLocaleString('uk-UA')} грн.

👤 Замовник: @${order.username} (ID: ${order.userId})

📮 Дані для відправки:
${Object.entries(deliveryData).map(([key, value]) => `${key}: ${value}`).join('\n')}`;

                await bot.sendMessage(ADMIN_ID, adminMessage);

                // Отправляем клиенту подтверждение
                await bot.sendMessage(order.userId, 
                    '✅ Ваше замовлення прийняте.\n\n' +
                    'З вами можуть додатково зв\'язатися для уточнення даних, що відсутні (невірні)'
                );

                activeOrders.delete(orderId);
            } 
            else if (paymentType === 'ton') {
                // Оплата TON (следующий этап)
                await bot.sendMessage(order.userId, 
                    '💎 Оплата через TON буде доступна найближчим часом.\n\n' +
                    'Будь ласка, оберіть "Оплата при отриманні" або зачекайте додаткових інструкцій.'
                );
            }

            await bot.answerCallbackQuery(callbackQuery.id);
        }

    } catch (error) {
        console.error('Помилка обробки callback:', error);
        await bot.answerCallbackQuery(callbackQuery.id, {
            text: 'Виникла помилка',
            show_alert: true
        });
    }
});

// ========================================
// ОБРАБОТЧИК ТЕКСТОВЫХ СООБЩЕНИЙ (для форм)
// ========================================

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Игнорируем команды
    if (text && text.startsWith('/')) return;

    // Ищем активный заказ пользователя, ожидающий данных
    let userOrder = null;
    let userOrderId = null;

    for (const [orderId, order] of activeOrders.entries()) {
        if (order.userId === chatId && order.waitingForData) {
            userOrder = order;
            userOrderId = orderId;
            break;
        }
    }

    if (userOrder && text) {
        // Парсим данные из сообщения
        const lines = text.split('\n').filter(line => line.trim());
        const deliveryData = {};

        lines.forEach(line => {
            const [key, ...valueParts] = line.split(':');
            if (key && valueParts.length > 0) {
                deliveryData[key.trim()] = valueParts.join(':').trim();
            }
        });

        // Сохраняем данные
        userOrder.deliveryData = deliveryData;
        userOrder.waitingForData = false;
        activeOrders.set(userOrderId, userOrder);

        // Показываем клиенту кнопки выбора оплаты
        const phonesList = userOrder.phones.map(p => p.number).join(', ');
        const totalTonWithDiscount = Math.round((userOrder.totalUah * 0.95) / userOrder.tonRate);

        const paymentMessage = `✅ Дані збережено!

📱 Номер: ${phonesList}
💰 Сума: ${userOrder.totalUah.toLocaleString('uk-UA')} грн.

Виберіть спосіб оплати:`;

        const paymentKeyboard = {
            inline_keyboard: [
                [
                    { text: '💵 Оплата при отриманні', callback_data: `payment_${userOrderId}_cash` }
                ],
                [
                    { text: `💎 Оплатити в TON -5% (${totalTonWithDiscount} TON)`, callback_data: `payment_${userOrderId}_ton` }
                ]
            ]
        };

        await bot.sendMessage(chatId, paymentMessage, {
            reply_markup: paymentKeyboard
        });
    }
});

// ========================================
// КОМАНДЫ БОТА
// ========================================

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 
        '🛒 Вітаємо в магазині красивих номерів!\n\n' +
        'Для замовлення номера скористайтеся нашим каталогом у Mini App.'
    );
});

// ========================================
// ЭКСПОРТ ФУНКЦИЙ
// ========================================

module.exports = {
    sendOrderToAdmin,
    sendOrderConfirmation,
    bot
};

console.log('🤖 Telegram Bot запущено');
