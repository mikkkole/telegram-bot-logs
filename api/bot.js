// ==================== 1. ИМПОРТ БИБЛИОТЕК ====================
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// ==================== 2. НАСТРОЙКА КЛИЕНТОВ ====================
const bot = new TelegramBot(process.env.BOT_TOKEN);

// 🔑 Очистка приватного ключа: замена \\n → \n и удаление лишних символов
const cleanPrivateKey = process.env.GOOGLE_PRIVATE_KEY
  .replace(/\\n/g, '\n')
  .trim();

// 🛡️ Создание JWT-клиента для авторизации (требуется в v5.0.2)
const jwtClient = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: cleanPrivateKey,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'], // ← без пробелов!
});

// 📊 Инициализация Google Таблицы с передачей JWT-клиента
const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, jwtClient);

// ==================== 3. ФУНКЦИЯ ДЛЯ ЛОГИРОВАНИЯ ====================
async function addLogToSheet(userName, userId, userMessage, botResponse) {
  try {
    console.log(`📝 Пытаюсь записать лог для ${userName}...`);
    
    // 1. Загружаем информацию о документе (если ещё не загружена)
    await doc.loadInfo();
    console.log(`✅ Таблица "${doc.title}" загружена`);
    
    // 2. Получаем первый лист
    const sheet = doc.sheetsByIndex[0];
    console.log(`✅ Лист "${sheet.title}" получен`);
    
    // 3. Добавляем строку
    const rowData = {
      Timestamp: new Date().toISOString(),
      'Chat ID': userId,
      'User Name': userName || `User_${userId}`,
      'User Message': userMessage || '(не текстовое сообщение)',
      'Bot Response': botResponse || '(нет ответа)',
    };
    
    await sheet.addRow(rowData);
    console.log('✅ Лог успешно записан в Google Таблицу!');
    return true;
    
  } catch (error) {
    console.error('❌ Ошибка при записи лога:');
    console.error('Сообщение:', error.message);
    
    if (error.response) {
      console.error('HTTP статус:', error.response.status);
      console.error('Тело ошибки:', error.response.data);
    }
    
    return false;
  }
}

// Функция для добавления подписчика в отдельный лист (лист №2)
async function addToMailingList(chatId, userName) {
  try {
    // Загружаем информацию о документе
    await doc.loadInfo();
    
    // Получаем второй лист (индекс 1) или создаем его
    let mailingSheet;
    if (doc.sheetCount < 2) {
      mailingSheet = await doc.addSheet({ 
        title: 'Подписчики',
        headerValues: ['Chat ID', 'Имя', 'Дата подписки', 'Статус']
      });
    } else {
      mailingSheet = doc.sheetsByIndex[1];
    }
    
    // Добавляем запись о подписчике
    await mailingSheet.addRow({
      'Chat ID': chatId,
      'Имя': userName,
      'Дата подписки': new Date().toISOString(),
      'Статус': 'активен'
    });
    
    console.log(`✅ ${userName} добавлен в список рассылки`);
  } catch (error) {
    console.error('❌ Ошибка при добавлении в список рассылки:', error.message);
  }
}

// Функция для добавления/обновления подписчика в отдельном листе (лист №2)
async function updateMailingList(chatId, userName, status = 'активен', unsubscribeDate = null) {
  try {
    // Загружаем информацию о документе
    await doc.loadInfo();
    
    // Получаем или создаем лист "Подписчики"
    let mailingSheet;
    if (doc.sheetCount < 2) {
      mailingSheet = await doc.addSheet({ 
        title: 'Подписчики',
        headerValues: ['Chat ID', 'Имя', 'Дата подписки', 'Статус', 'Дата отписки']
      });
      console.log('✅ Создан новый лист "Подписчики"');
    } else {
      mailingSheet = doc.sheetsByIndex[1];
    }
    
    // Загружаем все строки для поиска существующего пользователя
    await mailingSheet.loadCells();
    const rows = await mailingSheet.getRows();
    
    // Ищем пользователя по Chat ID
    let existingRow = null;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].get('Chat ID') == chatId) {
        existingRow = rows[i];
        break;
      }
    }
    
    if (existingRow) {
      // Обновляем существующую запись
      existingRow.set('Имя', userName);
      existingRow.set('Статус', status);
      if (unsubscribeDate) {
        existingRow.set('Дата отписки', unsubscribeDate);
      } else if (status === 'активен') {
        existingRow.set('Дата отписки', '');
      }
      await existingRow.save();
      console.log(`✅ Статус пользователя ${userName} обновлен на "${status}"`);
    } else {
      // Добавляем новую запись (только для активных подписок)
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
    console.error('❌ Ошибка при работе со списком рассылки:', error.message);
    return false;
  }
}

// Функция для отписки от рассылки (меняем статус на "отказ")
async function removeFromMailingList(chatId, userName) {
  try {
    const unsubscribeDate = new Date().toISOString();
    const success = await updateMailingList(chatId, userName, 'отказ', unsubscribeDate);
    
    if (success) {
      console.log(`✅ ${userName} отписан от рассылки`);
      return true;
    } else {
      console.log(`❌ Не удалось обновить статус для ${userName}`);
      return false;
    }
  } catch (error) {
    console.error('❌ Ошибка в removeFromMailingList:', error.message);
    return false;
  }
}

// ==================== 4. ПРОВЕРКА ПОДКЛЮЧЕНИЯ ПРИ ЗАПУСКЕ ====================
async function initializeBot() {
  try {
    console.log('🔧 Проверяю подключение к Google Таблице...');
    
    await doc.loadInfo();
    console.log(`✅ Подключение успешно! Таблица: "${doc.title}"`);
    
    const sheet = doc.sheetsByIndex[0];
    console.log(`✅ Рабочий лист: "${sheet.title}"`);
    console.log(`✅ Размеры: ${sheet.rowCount} строк, ${sheet.columnCount} столбцов`);
    
    return true;
  } catch (error) {
    console.error('❌ Не удалось подключиться к Google Таблице:');
    console.error('Ошибка:', error.message);
    
    if (error.message.includes('invalid_grant') || error.message.includes('Invalid credentials')) {
      console.error('\n🔑 ВОЗМОЖНЫЕ ПРИЧИНЫ:');
      console.error('1. Неверный формат приватного ключа в .env');
      console.error('2. Сервисный аккаунт не имеет доступа к таблице');
      console.error('3. Sheets API не включён в Google Cloud');
      console.error('\n📋 РЕКОМЕНДАЦИИ:');
      console.error('- Убедитесь, что ключ в .env в одной строке с \\n');
      console.error('- Поделитесь таблицей с email сервисного аккаунта');
      console.error('- Включите Google Sheets API в Google Cloud Console');
    }
    
    return false;
  }
}

// ==================== 5. ОБРАБОТКА СООБЩЕНИЙ ====================
// Обработчик команды /start с кнопкой согласия
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userName = msg.from.first_name || 'Пользователь';
  
  // Текст приветствия
  const welcomeText = `Привет, ${userName}!\n\nЭтот бот предназначен для отправки важных уведомлений и информации. Для того чтобы начать получать сообщения, пожалуйста, дайте свое согласие на рассылку.`;
  
  // Создаем inline-клавиатуру с кнопкой
  const consentKeyboard = {
    inline_keyboard: [
      [
        {
          text: '✅ Я соглашаюсь на получение рассылки',
          callback_data: 'consent_given' // Этот идентификатор придет при нажатии
        }
      ]
    ]
  };
  
  try {
    // Отправляем сообщение с кнопкой
    await bot.sendMessage(chatId, welcomeText, {
      reply_markup: consentKeyboard,
      parse_mode: 'HTML'
    });
    
    // Логируем отправку приветственного сообщения
    await addLogToSheet(userName, chatId, '/start', 'Отправлено приветствие с кнопкой согласия');
  } catch (error) {
    console.error('Ошибка в обработке /start:', error.message);
  }
});

// Обработчик команды отписки /unsubscribe
bot.onText(/\/unsubscribe/, async (msg) => {
  const chatId = msg.chat.id;
  const userName = msg.from.first_name || 'Пользователь';
  
  try {
    // 1. Пытаемся обновить статус в списке рассылки
    const unsubscribed = await removeFromMailingList(chatId, userName);
    
    // 2. Формируем ответ в зависимости от результата
    let responseText;
    if (unsubscribed) {
      responseText = `${userName}, вы отписались от рассылки.\n\n✅ Ваш статус изменен на "отказ".\n\nЧтобы снова подписаться, используйте команду /start.`;
    } else {
      responseText = `${userName}, вы не найдены в списке подписчиков.\n\nЕсли хотите подписаться, используйте команду /start.`;
    }
    
    // 3. Отправляем сообщение пользователю
    await bot.sendMessage(chatId, responseText);
    
    // 4. Логируем действие
    await addLogToSheet(
      userName, 
      chatId, 
      '/unsubscribe', 
      unsubscribed ? 'Пользователь отписался от рассылки' : 'Попытка отписки, пользователь не найден в списке'
    );
    
  } catch (error) {
    console.error('Ошибка в обработке /unsubscribe:', error.message);
    // Даже если что-то пошло не так, отвечаем пользователю
    try {
      await bot.sendMessage(chatId, 'Произошла ошибка при обработке запроса. Пожалуйста, попробуйте позже.');
    } catch (sendError) {
      console.error('Не удалось отправить сообщение об ошибке:', sendError.message);
    }
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
    await addLogToSheet(userName, chatId, userMessage, botResponse);
  } catch (error) {
    console.error('Ошибка в обработке сообщения:', error.message);
    try {
      await bot.sendMessage(chatId, 'Произошла ошибка при обработке сообщения.');
    } catch (sendError) {
      console.error('Не удалось отправить сообщение об ошибке:', sendError.message);
    }
  }
});

// Обработка нажатий на inline-кнопки (кнопки согласия)
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const user = callbackQuery.from;
  const userName = user.first_name || `User_${user.id}`;
  const data = callbackQuery.data; // Здесь будет 'consent_given'
  
  try {
    // Проверяем, какая кнопка была нажата
    if (data === 'consent_given') {
      // 1. Подтверждаем получение callback (убирает "часики" на кнопке)
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: 'Спасибо! Ваше согласие сохранено.',
        show_alert: false
      });
      
      // 2. Обновляем сообщение, убирая кнопку и показывая подтверждение
      const confirmedText = `Отлично, ${userName}!\n\n✅ Ваше согласие на получение рассылки сохранено.\n\nТеперь вы будете получать важные уведомления. Если захотите отписаться, используйте команду /unsubscribe.`;
      
      await bot.editMessageText(confirmedText, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] } // Убираем клавиатуру
      });
      
      // 3. Логируем факт получения согласия В ОТДЕЛЬНЫЙ ЛИСТ ИЛИ БАЗУ
      // Это критически важные данные, которые нельзя терять
      await addLogToSheet(userName, chatId, 'Нажатие кнопки согласия', 'Пользователь дал согласие на рассылку');
      
      // 4. Здесь можно сохранить chatId в отдельный список рассылки
      // Например, в отдельный лист Google Таблицы или базу данных
      await updateMailingList(chatId, userName, 'активен');
    }
  } catch (error) {
    console.error('Ошибка в обработке callback_query:', error.message);
  }
});

// ЭКСПОРТ функции-обработчика для Vercel
module.exports = async (req, res) => {
  // 1. Проверяем, что запрос от Telegram (необязательно, но рекомендуется)
  // if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  
  try {
    // 2. Парсим тело запроса (обновление от Telegram)
    const update = req.body;
    
    // 3. Передаем обновление боту на обработку
    await bot.processUpdate(update);
    
    // 4. Отвечаем Telegram, что всё OK
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Ошибка в обработке запроса:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};