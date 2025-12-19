// ==================== 1. ИМПОРТ БИБЛИОТЕК ====================
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { GoogleSpreadsheet } = require('google-spreadsheet');

// ==================== 2. НАСТРОЙКА БОТА ====================
const bot = new TelegramBot(process.env.BOT_TOKEN);

// ==================== 3. ИНИЦИАЛИЗАЦИЯ GOOGLE SHEETS ====================
let doc = null;
let sheet = null;
let mailingSheet = null;

async function initializeGoogleSheets() {
  try {
    // 1. Создаем документ
    doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
    
    // 2. Аутентифицируемся
    await doc.useServiceAccountAuth({
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    });
    
    // 3. Загружаем информацию
    await doc.loadInfo();
    console.log(`✅ Google Sheets: "${doc.title}"`);
    
    // 4. Получаем основной лист
    sheet = doc.sheetsByIndex[0];
    console.log(`✅ Основной лист: "${sheet.title}"`);
    
    // 5. Проверяем/создаем лист для подписчиков
    if (doc.sheetsByIndex.length < 2) {
      mailingSheet = await doc.addSheet({
        title: 'Подписчики',
        headerValues: ['Chat ID', 'Имя', 'Дата подписки', 'Статус', 'Дата отписки']
      });
      console.log('✅ Создан лист "Подписчики"');
    } else {
      mailingSheet = doc.sheetsByIndex[1];
      console.log(`✅ Лист подписчиков: "${mailingSheet.title}"`);
    }
    
    return true;
  } catch (error) {
    console.error('❌ Ошибка Google Sheets:', error.message);
    return false;
  }
}

// ==================== 4. ФУНКЦИИ РАБОТЫ С ТАБЛИЦЕЙ ====================
async function addLogToSheet(userName, userId, userMessage, botResponse) {
  try {
    if (!sheet) {
      console.error('❌ Лист не инициализирован');
      return false;
    }
    
    console.log(`📝 Запись лога для ${userName}...`);
    
    await sheet.addRow({
      Timestamp: new Date().toISOString(),
      'Chat ID': userId,
      'User Name': userName || `User_${userId}`,
      'User Message': userMessage || '(не текстовое сообщение)',
      'Bot Response': botResponse || '(нет ответа)',
    });
    
    console.log('✅ Лог записан!');
    return true;
  } catch (error) {
    console.error('❌ Ошибка записи лога:', error.message);
    return false;
  }
}

async function updateMailingList(chatId, userName, status = 'активен', unsubscribeDate = null) {
  try {
    if (!mailingSheet) {
      console.error('❌ Лист подписчиков не инициализирован');
      return false;
    }
    
    // Получаем все строки
    const rows = await mailingSheet.getRows();
    
    // Ищем пользователя
    let existingRow = null;
    for (const row of rows) {
      if (row['Chat ID'] == chatId) {
        existingRow = row;
        break;
      }
    }
    
    if (existingRow) {
      // Обновляем существующую запись
      existingRow['Имя'] = userName;
      existingRow['Статус'] = status;
      if (unsubscribeDate) {
        existingRow['Дата отписки'] = unsubscribeDate;
      } else if (status === 'активен') {
        existingRow['Дата отписки'] = '';
      }
      await existingRow.save();
      console.log(`✅ Статус ${userName} обновлен на "${status}"`);
    } else {
      // Добавляем новую запись
      if (status === 'активен') {
        await mailingSheet.addRow({
          'Chat ID': chatId,
          'Имя': userName,
          'Дата подписки': new Date().toISOString(),
          'Статус': status,
          'Дата отписки': ''
        });
        console.log(`✅ ${userName} добавлен в список рассылки`);
      }
    }
    
    return true;
  } catch (error) {
    console.error('❌ Ошибка работы со списком рассылки:', error.message);
    return false;
  }
}

async function removeFromMailingList(chatId, userName) {
  try {
    const unsubscribeDate = new Date().toISOString();
    const success = await updateMailingList(chatId, userName, 'отказ', unsubscribeDate);
    
    if (success) {
      console.log(`✅ ${userName} отписан от рассылки`);
      return true;
    }
    return false;
  } catch (error) {
    console.error('❌ Ошибка в removeFromMailingList:', error.message);
    return false;
  }
}

// ==================== 5. ОБРАБОТЧИКИ СОБЫТИЙ БОТА ====================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userName = msg.from.first_name || 'Пользователь';
  
  console.log(`🚀 /start: chatId=${chatId}, userName=${userName}`);
  
  const welcomeText = `Привет, ${userName}!\n\nЭтот бот предназначен для отправки важных уведомлений и информации. Для того чтобы начать получать сообщения, пожалуйста, дайте свое согласие на рассылку.`;
  
  const consentKeyboard = {
    inline_keyboard: [[{
      text: '✅ Я соглашаюсь на получение рассылки',
      callback_data: 'consent_given'
    }]]
  };
  
  try {
    console.log(`📤 Пытаюсь отправить сообщение в ${chatId}...`);
    
    const result = await bot.sendMessage(chatId, welcomeText, {
      reply_markup: consentKeyboard,
      parse_mode: 'HTML'
    });
    
    console.log(`✅ Основное сообщение отправлено, ID: ${result.message_id}`);
    
    // Логируем
    if (sheet) {
      await addLogToSheet(userName, chatId, '/start', 'Отправлено приветствие с кнопкой согласия');
    }
  } catch (error) {
    console.error('❌ Ошибка отправки сообщения:', error.message);
    console.error('Детали ошибки:', error);
  }
});

bot.onText(/\/unsubscribe/, async (msg) => {
  const chatId = msg.chat.id;
  const userName = msg.from.first_name || 'Пользователь';
  
  try {
    const unsubscribed = await removeFromMailingList(chatId, userName);
    
    let responseText;
    if (unsubscribed) {
      responseText = `${userName}, вы отписались от рассылки.\n\n✅ Ваш статус изменен на "отказ".\n\nЧтобы снова подписаться, используйте команду /start.`;
    } else {
      responseText = `${userName}, вы не найдены в списке подписчиков.\n\nЕсли хотите подписаться, используйте команду /start.`;
    }
    
    await bot.sendMessage(chatId, responseText);
    
    if (sheet) {
      await addLogToSheet(
        userName, 
        chatId, 
        '/unsubscribe', 
        unsubscribed ? 'Пользователь отписался от рассылки' : 'Попытка отписки, пользователь не найден'
      );
    }
  } catch (error) {
    console.error('Ошибка в обработке /unsubscribe:', error.message);
  }
});

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  
  const chatId = msg.chat.id;
  const userName = msg.from.first_name || `User_${msg.from.id}`;
  const userMessage = msg.text;
  
  try {
    const botResponse = `Эхо: ${userMessage}`;
    await bot.sendMessage(chatId, botResponse);
    
    if (sheet) {
      await addLogToSheet(userName, chatId, userMessage, botResponse);
    }
  } catch (error) {
    console.error('Ошибка в обработке сообщения:', error.message);
  }
});

bot.on('callback_query', async (callbackQuery) => {
  console.log(`🔘 Callback получен: ${callbackQuery.data} для chatId: ${callbackQuery.message.chat.id}`);
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const user = callbackQuery.from;
  const userName = user.first_name || `User_${user.id}`;
  const data = callbackQuery.data;
  
  try {
    if (data === 'consent_given') {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: 'Спасибо! Ваше согласие сохранено.',
        show_alert: false
      });
      
      const confirmedText = `Отлично, ${userName}!\n\n✅ Ваше согласие на получение рассылки сохранено.\n\nТеперь вы будете получать важные уведомления. Если захотите отписаться, используйте команду /unsubscribe.`;
      
      await bot.editMessageText(confirmedText, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] }
      });
      
      if (sheet) {
        await addLogToSheet(userName, chatId, 'Нажатие кнопки согласия', 'Пользователь дал согласие на рассылку');
        await updateMailingList(chatId, userName, 'активен');
      }
    }
  } catch (error) {
    console.error('Ошибка в обработке callback_query:', error.message);
  }
});

// ==================== 6. ЗАПУСК СЕРВЕРА ДЛЯ WEBHOOK НА RENDER ====================
const PORT = process.env.PORT || 3000;
const express = require('express');
const app = express();
app.use(express.json());

// 1. Инициализируем Google Sheets при запуске сервера
// Это важно для скорости первого ответа после "сна"
let sheetsInitialized = false;
initializeGoogleSheets().then(success => {
    sheetsInitialized = success;
    console.log(success ? '✅ Google Sheets готов к работе' : '⚠️ Google Sheets не инициализирован');
});

// 2. Обрабатываем все POST-запросы от Telegram
app.post('/', async (req, res) => {
    console.log('📨 Получен запрос от Telegram');
    
    // Отвечаем Telegram как можно быстрее!
    res.status(200).send('OK');
    
    // Обрабатываем обновление в фоне
    try {
        if (!sheetsInitialized) {
            console.log('⏳ Инициализация Google Sheets по запросу...');
            sheetsInitialized = await initializeGoogleSheets();
        }
        await bot.processUpdate(req.body);
    } catch (error) {
        console.error('❌ Ошибка обработки обновления:', error.message);
    }
});

// 3. Обязательная проверка здоровья для Render (Health Check)
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 4. Запускаем сервер
const server = app.listen(PORT, '0.0.0.0', async () => {
    console.log(`✅ Сервер запущен на порту ${PORT}`);
    
    // 5. Устанавливаем вебхук после запуска сервера
    const webhookUrl = `https://${process.env.RENDER_SERVICE_NAME}.onrender.com/`; // См. пункт 2 ниже
    try {
        await bot.setWebHook(webhookUrl);
        console.log(`🌐 Вебхук установлен на: ${webhookUrl}`);
    } catch (error) {
        console.error('❌ Не удалось установить вебхук:', error);
    }
});

// ==================== 7. SELF-PING (для поддержания активности) ====================
function startSelfPing() {
  // Используем публичный URL Render. Он доступен в переменной окружения.
  const selfUrl = process.env.RENDER_EXTERNAL_URL || `https://telegram-bot-logs.onrender.com`;
  
  // Пингуем сами себя каждые 4 минуты (меньше 15-минутного лимита сна на Render)
  setInterval(() => {
    console.log('🔄 Выполняю self-ping...');
    // Используем встроенный модуль 'https' для отправки запроса
    require('https').get(`${selfUrl}/health`, (res) => {
      console.log(`✅ Self-ping успешен. Статус: ${res.statusCode}`);
    }).on('error', (err) => {
      console.error(`❌ Ошибка self-ping: ${err.message}`);
    });
  }, 4 * 60 * 1000); // Интервал: 4 минуты
}

// Запускаем self-ping только в продакшн-режиме
if (process.env.NODE_ENV === 'production') {
  startSelfPing();
}