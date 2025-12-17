// ==================== 1. ИМПОРТ БИБЛИОТЕК ====================
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { GoogleSpreadsheet } = require('google-spreadsheet');

// ==================== 2. НАСТРОЙКА КЛИЕНТОВ ====================
const bot = new TelegramBot(process.env.BOT_TOKEN);

// ==================== 3. ИНИЦИАЛИЗАЦИЯ GOOGLE SHEETS (v4.x) ====================
let doc; // Объявим как переменную в области видимости модуля

async function initializeGoogleSheets() {
  try {
    // Создаем новый экземпляр при каждом запросе
    doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
    
    await doc.useServiceAccountAuth({
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    });
    
    await doc.loadInfo();
    console.log(`✅ Google Sheets инициализирована: "${doc.title}"`);
    return true;
  } catch (error) {
    console.error('❌ Ошибка инициализации Google Sheets:', error.message);
    return false;
  }
}

// ==================== 3. ФУНКЦИЯ ДЛЯ ЛОГИРОВАНИЯ ====================
async function addLogToSheet(userName, userId, userMessage, botResponse) {
  try {
    if (!doc) {
      console.error('❌ Документ Google Sheets не инициализирован');
      return false;
    }
    console.log(`📝 Пытаюсь записать лог для ${userName}...`);
    
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

// Функция для добавления/обновления подписчика в отдельном листе (лист №2)
async function updateMailingList(chatId, userName, status = 'активен', unsubscribeDate = null) {
  try {
    if (!doc) {
      console.error('❌ Документ Google Sheets не инициализирован');
      return false;
    }
    
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

// ==================== 4. ОСНОВНОЙ ОБРАБОТЧИК VERCEL ====================
module.exports = async (req, res) => {
  console.log(`📨 Получен ${req.method} запрос`);
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  
  try {
    // Инициализируем Google Sheets при каждом запросе
    await initializeGoogleSheets();
    
    const update = req.body;
    await bot.processUpdate(update);
    
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    return res.status(200).json({ ok: false });
  }
};