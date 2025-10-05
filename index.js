import dotenv from "dotenv";
dotenv.config();

import TelegramBot from "node-telegram-bot-api";
import express from "express";
import moment from "moment-timezone";
import fs from "fs";
import path from "path";

// ====== Налаштування ======
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TIMEZONE = process.env.TIMEZONE || "Europe/Kiev";
const TASKS_FILE = path.join(process.cwd(), "tasks.json");
const USERS_FILE = path.join(process.cwd(), "userIds.json");

// ====== Ініціалізація бота ======
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ====== Завантаження користувачів ======
let userIds = {};
try {
  if (fs.existsSync(USERS_FILE)) {
    userIds = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  }
} catch (err) {
  console.error("Помилка завантаження users:", err);
  userIds = {};
}

// ====== Система задач ======
let tasks = [];
let nextTaskId = 1;

// ====== Утиліти ======
function chunkButtons(buttons, n = 2) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += n) {
    rows.push(buttons.slice(i, i + n));
  }
  return rows;
}

function safeSendMessage(chatId, text, options = {}) {
  return bot.sendMessage(chatId, text, options).catch(err => {
    if (err.response && err.response.statusCode === 429) {
      const retryAfter = err.response.parameters?.retry_after || 5;
      console.log(`⏳ Telegram flood. Retry after ${retryAfter} sec`);
      setTimeout(() => safeSendMessage(chatId, text, options), retryAfter * 1000);
    } else {
      console.error("Помилка відправки:", err);
      throw err;
    }
  });
}

function sendToUserOrGroup(userId, chatId, text, options = {}) {
  return safeSendMessage(userId, text, options).catch(() => {
    if (chatId) {
      return safeSendMessage(chatId, text, options);
    }
    throw new Error("Не вдалось відправити повідомлення");
  });
}

// ====== Збереження та завантаження даних ======
function loadTasks() {
  try {
    if (fs.existsSync(TASKS_FILE)) {
      const data = fs.readFileSync(TASKS_FILE, "utf8");
      tasks = JSON.parse(data);
      nextTaskId = tasks.length > 0 ? Math.max(...tasks.map(t => t.id)) + 1 : 1;
    }
  } catch (err) {
    console.error("Помилка завантаження tasks:", err);
    tasks = [];
    nextTaskId = 1;
  }
}

function saveTasks() {
  try {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
  } catch (err) {
    console.error("Помилка збереження tasks:", err);
  }
}

function saveUsers() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(userIds, null, 2));
  } catch (err) {
    console.error("Помилка збереження users:", err);
  }
}

loadTasks();
const createInputKeyboard = () => {
  return {
    keyboard: [
      [{ text: "/help" }, { text: "/tasks" }],
      [{ text: "/tasks_status" }, { text: "/hide" }],
      [{ text: "/keyboard" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
};
// ====== Обробка /start ======
// bot.onText(/\/start/, (msg) => {
//   const chatId = msg.chat.id;
//   const username = msg.from.username;

//   if (!username) {
//     return bot.sendMessage(chatId, "❌ Бот потребує username для коректної роботи. Будь ласка, встановіть username в налаштуваннях Telegram.");
//   }

//   if (!userIds[username]) {
//     userIds[username] = chatId;
//     saveUsers();
//   }

//   bot.sendMessage(chatId, `Привіт, ${msg.from.first_name}! Бот активований ✅\n\nВикористовуй /help для інструкції.`);
// });
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username;
    if (!username) {
      return bot.sendMessage(chatId, "❌ Бот потребує username для коректної роботи. Будь ласка, встановіть username в налаштуваннях Telegram.");
    }

    if (!userIds[username]) {
      userIds[username] = chatId;
      saveUsers();
    }

    bot.sendMessage(chatId, `Привіт, ${msg.from.first_name}! Бот активований ✅\n\nВикористовуй /help для інструкції. Та, щоб приховати клавіатуру використовуйте команду /hide`);
  
});

// ====== Обробка помилок ======
bot.on("polling_error", (err) => {
  console.error("Помилка polling:", err.code, err.response?.body || err);
});

// ====== Обробка повідомлень ======
bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const userId = msg.from.id;
  const isPrivate = msg.chat.type === 'private';
  
  if (!text || text.startsWith('/')) return;

  // Обробка кастомного нагадування
  const waitingCustomRemindTask = tasks.find(t => t.waitingCustomRemind === userId);
  if (waitingCustomRemindTask) {
    const hours = parseFloat(text.replace(',', '.'));
    if (isNaN(hours) || hours <= 0) {
      return bot.sendMessage(chatId, "❌ Введіть правильне число годин (наприклад: 1.5 або 2).");
    }

    waitingCustomRemindTask.reminderMinutes = hours * 60;
    delete waitingCustomRemindTask.waitingCustomRemind;
    saveTasks();

    return bot.sendMessage(chatId, `⏰ Нагадування для задачі #${waitingCustomRemindTask.id} встановлено на ${hours} год. до дедлайну.`);
  }

  // Обробка зміни дедлайну виконавцем (з причиною)
  const waitingDeadlineChangeTask = tasks.find(t => t.waitingDeadlineChange === userId);
  if (waitingDeadlineChangeTask) {
    const newDeadlineMatch = text.match(/^(\d{2}\.\d{2})\s+(\d{2}:\d{2})$/);
    if (!newDeadlineMatch) {
      return bot.sendMessage(chatId, "❌ Формат неправильний. Використовуйте DD.MM HH:mm (наприклад: 25.12 14:30)");
    }

    const year = new Date().getFullYear();
    const fullDateStr = `${newDeadlineMatch[1]}.${year} ${newDeadlineMatch[2]}`;
    const newDeadline = moment.tz(fullDateStr, "DD.MM.YYYY HH:mm", TIMEZONE).toDate();

    if (newDeadline.toString() === 'Invalid Date') {
      return bot.sendMessage(chatId, "❌ Неправильна дата. Перевірте формат DD.MM HH:mm");
    }

    // Зберігаємо пропозицію зміни дедлайну
    waitingDeadlineChangeTask.pendingDeadlineChange = {
      newDeadline: newDeadline,
      reason: null,
      proposedBy: userId,
      proposedByName: msg.from.username || msg.from.first_name
    };
    delete waitingDeadlineChangeTask.waitingDeadlineChange;
    saveTasks();

    return bot.sendMessage(chatId, "📝 Тепер введіть причину зміни дедлайну:");
  }

  // Обробка причини зміни дедлайну
  const waitingReasonTask = tasks.find(t => t.pendingDeadlineChange && t.pendingDeadlineChange.reason === null && t.pendingDeadlineChange.proposedBy === userId);
  if (waitingReasonTask) {
    waitingReasonTask.pendingDeadlineChange.reason = text;
    saveTasks();

    const deadlineStr = moment(waitingReasonTask.pendingDeadlineChange.newDeadline).tz(TIMEZONE).format("DD.MM, HH:mm");
    
    // Повідомлення виконавцю
    bot.sendMessage(chatId, "✅ Пропозицію зміни дедлайну надіслано постановнику задачі. Він може підтвердити або відхилити зміну через бота.");

    // Повідомлення постановнику
    const notificationText = `🔄 Виконавець ${waitingReasonTask.pendingDeadlineChange.proposedByName} запропонував змінити дедлайн задачі #${waitingReasonTask.id} "${waitingReasonTask.title}"\n\nНовий дедлайн: ${deadlineStr}\nПричина: ${text}`;

    const authorButtons = [
      [
        { 
          text: "✅ Підтвердити", 
          callback_data: `confirm_deadline_${waitingReasonTask.id}` 
        },
        { 
          text: "❌ Відхилити", 
          callback_data: `reject_deadline_${waitingReasonTask.id}` 
        }
      ]
    ];

    // Відправляємо постановнику
    if (waitingReasonTask.authorId) {
      safeSendMessage(
        waitingReasonTask.authorId, 
        notificationText,
        { reply_markup: { inline_keyboard: authorButtons } }
      ).catch(() => {
        // Якщо не вдалось відправити приватно, відправляємо в групу
        if (waitingReasonTask.chatId) {
          safeSendMessage(
            waitingReasonTask.chatId, 
            notificationText,
            { reply_markup: { inline_keyboard: authorButtons } }
          );
        }
      });
    } else if (waitingReasonTask.chatId) {
      // Якщо немає authorId, відправляємо в групу
      safeSendMessage(
        waitingReasonTask.chatId, 
        notificationText,
        { reply_markup: { inline_keyboard: authorButtons } }
      );
    }

    return;
  }

  // Обробка зміни дедлайну постановником
  const waitingDeadlineTask = tasks.find(t => t.waitingDeadlineChange === userId);
  if (waitingDeadlineTask) {
    const newDeadlineMatch = text.match(/^(\d{2}\.\d{2})\s+(\d{2}:\d{2})$/);
    if (!newDeadlineMatch) {
      return bot.sendMessage(chatId, "❌ Формат неправильний. Використовуйте DD.MM HH:mm (наприклад: 25.12 14:30)");
    }

    const year = new Date().getFullYear();
    const fullDateStr = `${newDeadlineMatch[1]}.${year} ${newDeadlineMatch[2]}`;
    const newDeadline = moment.tz(fullDateStr, "DD.MM.YYYY HH:mm", TIMEZONE).toDate();

    if (newDeadline.toString() === 'Invalid Date') {
      return bot.sendMessage(chatId, "❌ Неправильна дата. Перевірте формат DD.MM HH:mm");
    }

    waitingDeadlineTask.deadline = newDeadline;
    delete waitingDeadlineTask.waitingDeadlineChange;
    saveTasks();

    const deadlineStr = moment(newDeadline).tz(TIMEZONE).format("DD.MM, HH:mm");
    const notificationText = `⚡ Дедлайн задачі #${waitingDeadlineTask.id} змінено на ${deadlineStr}`;

    // Повідомлення виконавцю (якщо він є)
    if (waitingDeadlineTask.takenById && userId !== waitingDeadlineTask.takenById) {
      sendToUserOrGroup(waitingDeadlineTask.takenById, waitingDeadlineTask.chatId, notificationText);
    }

    return bot.sendMessage(chatId, `✅ Дедлайн оновлено: ${deadlineStr}`);
  }

  // Обробка нових задач (в групі та приватно)
  if (!text.startsWith("$") && !text.startsWith("#") && !text.startsWith("!")) return;

  const taskRegex = /^(.*)\s+(\d{2}\.\d{2})\s+(\d{2}:\d{2})$/;
  const match = text.match(taskRegex);

  let title = text;
  let deadline = null;
  
  if (match) {
    title = match[1].trim();
    const dayMonth = match[2];
    const time = match[3];
    const year = new Date().getFullYear();
    const fullDateStr = `${dayMonth}.${year} ${time}`;
    deadline = moment.tz(fullDateStr, "DD.MM.YYYY HH:mm", TIMEZONE).toDate();
    
    if (deadline.toString() === 'Invalid Date') {
      return bot.sendMessage(chatId, "❌ Неправильний формат дати. Використовуйте DD.MM HH:mm");
    }
  } else {
    deadline = moment().tz(TIMEZONE).hour(18).minute(0).second(0).toDate();
  }

  // Визначення категорії та пріоритету
  const symbol = text[0];
  let category = "Звичайна", priority = "низький";
  if (symbol === "$") { category = "Термінова"; priority = "високий"; }
  else if (symbol === "#") { category = "Звичайна"; priority = "середній"; }
  else if (symbol === "!") { category = "Опціональна"; priority = "низький"; }

  // Пошук виконавця
  let mentionedUsername = null;
  const usernameMatch = text.match(/@(\w+)/);
  if (usernameMatch) mentionedUsername = usernameMatch[1];

  // Створення задачі
  const task = {
    id: nextTaskId++,
    title: title.replace(/^[$#!]\s*/, "").replace(/@\w+/g, "").trim(),
    authorName: msg.from.username || msg.from.first_name,
    authorId: msg.from.id,
    status: "Нове",
    chatId: isPrivate ? null : chatId,
    createdAt: Date.now(),
    deadline,
    reminded: false,
    category,
    priority,
    takenByName: null,
    takenById: null,
    mentionedUsername,
    remindedNotTaken: false,
    reminderMinutes: null,
    sentReminders: [],
    waitingCustomRemind: null,
    waitingDeadlineChange: null,
    pendingDeadlineChange: null,
    isPrivate: isPrivate
  };
  
  tasks.push(task);
  saveTasks();

  const deadlineStr = moment(deadline).tz(TIMEZONE).format("DD.MM, HH:mm");
  const responsibleId = mentionedUsername ? userIds[mentionedUsername] : null;

  if (isPrivate) {
    // Обробка приватних задач
    if (mentionedUsername && responsibleId) {
      // Приватне повідомлення виконавцю
      const privateButtons = [
        [
          { text: "🏃 Взяти", callback_data: `take_${task.id}` },
          { text: "✅ Виконати", callback_data: `done_${task.id}` }
        ],
        [
          { text: "❌ Відхилити", callback_data: `reject_${task.id}` },
          { text: "⏰ Нагадування", callback_data: `customRemind_${task.id}` }
        ],
        [
          { text: "✏️ Змінити дедлайн", callback_data: `changeDeadline_${task.id}` }
        ]
      ];

      safeSendMessage(
        responsibleId,
        `📌 Вам надали завдання #${task.id} від ${task.authorName}:\n"${task.title}"\nКатегорія: ${task.category}\nПріоритет: ${task.priority}\nДедлайн: ${deadlineStr}`,
        { reply_markup: { inline_keyboard: privateButtons } }
      ).then(() => {
        // Повідомлення постановнику
        const authorButtons = [
          [
            { text: "🗑️ Видалити", callback_data: `delete_${task.id}` },
            { text: "✏️ Змінити дедлайн", callback_data: `changeDeadline_${task.id}` }
          ]
        ];
        
        bot.sendMessage(
          chatId,
          `✅ Задача #${task.id} відправлена @${mentionedUsername}\n📝 "${task.title}"`,
          { reply_markup: { inline_keyboard: authorButtons } }
        );
      }).catch(() => {
        bot.sendMessage(chatId, `❌ Користувач @${mentionedUsername} не зареєстрований у боті`);
        // Видаляємо задачу, якщо не вдалося відправити
        tasks = tasks.filter(t => t.id !== task.id);
        saveTasks();
      });
    } else if (mentionedUsername && !responsibleId) {
      // Виконавець не зареєстрований
      bot.sendMessage(chatId, `❌ Користувач @${mentionedUsername} не зареєстрований у боті`);
      tasks = tasks.filter(t => t.id !== task.id);
      saveTasks();
    } else {
      // Задача без виконавця в приватному чаті
      const buttons = [
        [
          { text: "🗑️ Видалити", callback_data: `delete_${task.id}` },
          { text: "✏️ Змінити дедлайн", callback_data: `changeDeadline_${task.id}` }
        ]
      ];
      
      bot.sendMessage(
        chatId,
        `✅ Задача #${task.id} створена!\n"${task.title}"\nКатегорія: ${task.category}\nПріоритет: ${task.priority}\nДедлайн: ${deadlineStr}`,
        { reply_markup: { inline_keyboard: buttons } }
      );
    }
  } else {
    // Обробка задач у групі
    const allGroupButtons = [
      { text: "🏃 Взяти", callback_data: `take_${task.id}` },
      { text: "✅ Виконати", callback_data: `done_${task.id}` },
      { text: "❌ Відхилити", callback_data: `reject_${task.id}` },
      { text: "🗑️ Видалити", callback_data: `delete_${task.id}` },
      { text: "✏️ Змінити дедлайн", callback_data: `changeDeadline_${task.id}` }
    ];
    if (responsibleId) {
      // Приватне повідомлення виконавцю
      const privateButtons = [
        [
          { text: "🏃 Взяти", callback_data: `take_${task.id}` },
          { text: "✅ Виконати", callback_data: `done_${task.id}` }
        ],
        [
          { text: "❌ Відхилити", callback_data: `reject_${task.id}` },
          { text: "⏰ Нагадування", callback_data: `customRemind_${task.id}` }
        ],
        [
          { text: "✏️ Змінити дедлайн", callback_data: `changeDeadline_${task.id}` }
        ]
      ];

      safeSendMessage(
        responsibleId,
        `📌 Вам надали завдання #${task.id} від ${task.authorName}:\n"${task.title}"\nКатегорія: ${task.category}\nПріоритет: ${task.priority}\nДедлайн: ${deadlineStr}`,
        { reply_markup: { inline_keyboard: privateButtons } }
      ).catch(() => {
        console.log(`Не вдалось надіслати @${mentionedUsername}, він ще не запустив бота`);
      });

      // Повідомлення в групу
      const groupButtons = [
        [
          { text: "🗑️ Видалити", callback_data: `delete_${task.id}` },
          { text: "✏️ Змінити дедлайн", callback_data: `changeDeadline_${task.id}` }
        ]
      ];
      
      bot.sendMessage(
        chatId,
        `✅ Задача #${task.id} створена для @${mentionedUsername}\n📝 "${task.title}"`,
        { reply_markup: { inline_keyboard: groupButtons } }
      );
    } else {
      // Задача без підтвердженого виконавця
      let messageText = `✅ Задача #${task.id} створена!\n"${task.title}"\nКатегорія: ${task.category}\nПріоритет: ${task.priority}\nДедлайн: ${deadlineStr}`;

      if (mentionedUsername) {
        messageText += `\n\n⚠️ @${mentionedUsername} ще не запустив бота`;
      }

      bot.sendMessage(
        chatId, 
        messageText, 
        { reply_markup: { inline_keyboard: chunkButtons(allGroupButtons, 2) } }
      );
    }
  }
});

// ====== Inline кнопки ======
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = query.from.id;
  const data = query.data;
  
  console.log('🔔 Callback received:', data);
  console.log('📋 All tasks:', tasks.map(t => ({ id: t.id, title: t.title })));

  try {
    // Спочатку обробляємо спеціальні callback без taskId
    if (data === "stats_7days") {
      // Обробка статистики
      const chatId = query.message.chat.id;
      const isPrivate = query.message.chat.type === 'private';
      
      let userTasks;
      if (isPrivate) {
        userTasks = tasks.filter(t => 
          t.authorId === query.from.id || 
          t.takenById === query.from.id || 
          (t.mentionedUsername && userIds[t.mentionedUsername] === query.from.id)
        );
      } else {
        userTasks = tasks.filter(t => t.chatId === chatId);
      }

      const sevenDaysAgo = moment().subtract(7, 'days').valueOf();
      const lastWeekTasks = userTasks.filter(t => t.createdAt >= sevenDaysAgo);

      const incomplete = lastWeekTasks.filter(t => t.status !== "Виконано ✅" && t.status !== "Відхилено ❌");
      const completed = lastWeekTasks.filter(t => t.status === "Виконано ✅");
      const rejected = lastWeekTasks.filter(t => t.status === "Відхилено ❌");

      let text = "📈 *Статистика за останні 7 днів:*\n\n";
      text += "📌 *Активні:* " + incomplete.length + "\n";
      text += "✅ *Виконані:* " + completed.length + "\n";
      text += "❌ *Відхилені:* " + rejected.length + "\n\n";

      if (completed.length > 0) {
        text += "🎯 *Останні виконані:*\n";
        const recentCompleted = completed.slice(-5).reverse();
        recentCompleted.forEach(task => {
          const completedDate = moment(task.completedAt).tz(TIMEZONE).format("DD.MM HH:mm");
          text += `#${task.id} - ${task.title} (${completedDate})\n`;
        });
      }

      await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
      return bot.answerCallbackQuery(query.id, { text: "📊 Статистика завантажена" });
    }

    // Обробка callback з taskId
    const parts = data.split('_');
    console.log('Parts:', parts);
    
    let action, taskId;

    // Визначаємо action та taskId в залежності від кількості частин
    if (parts.length === 2) {
      // Прості дії: take_18, done_18, delete_18, etc.
      action = parts[0];
      taskId = parseInt(parts[1]);
    } else if (parts.length === 3) {
      // Складні дії: confirm_deadline_18, reject_deadline_18
      action = parts[0] + '_' + parts[1]; // "confirm_deadline", "reject_deadline"
      taskId = parseInt(parts[2]);
    } else {
      console.log('❌ Invalid callback format:', data);
      return bot.answerCallbackQuery(query.id, { 
        text: "❌ Помилка формату запиту",
        show_alert: true 
      });
    }
    
    console.log('🔄 Action:', action, 'Task ID:', taskId);

    if (isNaN(taskId)) {
      console.log('❌ Invalid taskId from parts:', parts);
      return bot.answerCallbackQuery(query.id, { 
        text: "❌ Помилка: ID задачі не знайдено",
        show_alert: true 
      });
    }

    const task = tasks.find(t => t.id === taskId);
    
    if (!task) {
      console.log('❌ Task not found, ID:', taskId);
      console.log('📋 Available task IDs:', tasks.map(t => t.id));
      return bot.answerCallbackQuery(query.id, { 
        text: `❌ Задача #${taskId} не знайдена`,
        show_alert: true 
      });
    }

    console.log('✅ Task found:', task.id, task.title);

    // Обробка дій
    switch (action) {
      case "take":
        if (task.status === "Виконано ✅") {
          return bot.answerCallbackQuery(query.id, { text: "❌ Задача вже виконана", show_alert: true });
        }

        task.status = "Взявся 🏃";
        task.takenByName = query.from.username || query.from.first_name;
        task.takenById = userId;
        saveTasks();

        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: messageId }
        ).catch(() => console.log("Не вдалось оновити markup"));

        await bot.sendMessage(chatId, `🔹 Задача #${task.id} взята ${task.takenByName}`);

        if (task.authorId && task.authorId !== userId) {
          sendToUserOrGroup(
            task.authorId,
            task.chatId,
            `🔹 Задача #${task.id} "${task.title}" взята ${task.takenByName}`
          );
        }
        break;

      case "customRemind":
        task.waitingCustomRemind = userId;
        saveTasks();
        await bot.sendMessage(userId, `Введіть кількість годин для нагадування про задачу #${task.id}:`);
        break;

      case "changeDeadline":
        task.waitingDeadlineChange = userId;
        saveTasks();
        await bot.sendMessage(userId, `Введіть новий дедлайн для задачі #${task.id} (DD.MM HH:mm):`);
        break;

      case "done":
        task.status = "Виконано ✅";
        task.completedAt = Date.now();
        saveTasks();

        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: messageId }
        ).catch(() => console.log("Не вдалось оновити markup"));

        await bot.sendMessage(chatId, `✅ Задача #${task.id} виконана!`);

        if (task.authorId && task.authorId !== userId) {
          sendToUserOrGroup(
            task.authorId,
            task.chatId,
            `✅ Задача #${task.id} "${task.title}" виконана ${task.takenByName || query.from.first_name}`
          );
        }
        break;

      case "reject":
        if (task.status === "Виконано ✅") {
          return bot.answerCallbackQuery(query.id, { text: "❌ Задача вже виконана", show_alert: true });
        }

        task.status = "Відхилено ❌";
        task.rejectedBy = query.from.username || query.from.first_name;
        task.rejectedById = userId;
        saveTasks();

        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: messageId }
        ).catch(() => console.log("Не вдалось оновити markup"));

        const rejectMessage = `❌ Задача #${task.id} відхилена ${task.rejectedBy}`;
        await bot.sendMessage(chatId, rejectMessage);

        if (task.authorId && task.authorId !== userId) {
          sendToUserOrGroup(
            task.authorId,
            task.chatId,
            `❌ Задача #${task.id} "${task.title}" відхилена ${task.rejectedBy}`
          );
        }
        break;

      case "delete":
        if (userId !== task.authorId) {
          return bot.answerCallbackQuery(query.id, {
            text: "⛔ Лише постановник може видаляти задачу!",
            show_alert: true
          });
        }

        tasks = tasks.filter(t => t.id !== task.id);
        saveTasks();

        await bot.deleteMessage(chatId, messageId).catch(() => console.log("Не вдалось видалити повідомлення"));
        await bot.sendMessage(chatId, `🗑️ Задача #${task.id} видалена`);

        if (task.takenById && task.takenById !== userId) {
          sendToUserOrGroup(
            task.takenById,
            task.chatId,
            `🗑️ Задача #${task.id} "${task.title}" видалена автором`
          );
        }
        break;

      case "confirm_deadline":
        console.log('🔄 Confirm deadline for task:', task.id);
        if (userId !== task.authorId) {
          return bot.answerCallbackQuery(query.id, {
            text: "⛔ Лише постановник може підтверджувати зміну дедлайну!",
            show_alert: true
          });
        }

        if (!task.pendingDeadlineChange) {
          return bot.answerCallbackQuery(query.id, {
            text: "❌ Пропозиція зміни дедлайну не знайдена",
            show_alert: true
          });
        }

        // Застосовуємо новий дедлайн
        const oldDeadlineStr = moment(task.deadline).tz(TIMEZONE).format("DD.MM, HH:mm");
        task.deadline = task.pendingDeadlineChange.newDeadline;
        const newDeadlineStr = moment(task.deadline).tz(TIMEZONE).format("DD.MM, HH:mm");
        
        // Очищаємо відправлені нагадування
        task.sentReminders = [];
        
        // Повідомлення виконавцю
        const executorMessage = `✅ Постановник підтвердив зміну дедлайну задачі #${task.id} "${task.title}"\n\n🕒 Старий дедлайн: ${oldDeadlineStr}\n🕒 Новий дедлайн: ${newDeadlineStr}`;
        
        sendToUserOrGroup(
          task.pendingDeadlineChange.proposedBy,
          task.chatId,
          executorMessage
        );

        // Повідомлення постановнику
        const authorMessage = `✅ Ви підтвердили зміну дедлайну задачі #${task.id}\n\n🕒 Новий дедлайн: ${newDeadlineStr}\n👤 Запропоновано: ${task.pendingDeadlineChange.proposedByName}\n📝 Причина: ${task.pendingDeadlineChange.reason}`;

        // Оновлюємо повідомлення
        await bot.editMessageText(
          authorMessage,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown"
          }
        ).catch(() => {
          bot.sendMessage(chatId, authorMessage);
        });

        // Видаляємо пропозицію
        task.pendingDeadlineChange = null;
        saveTasks();
        
        await bot.answerCallbackQuery(query.id, { text: "✅ Дедлайн підтверджено" });
        break;

      case "reject_deadline":
        console.log('🔄 Reject deadline for task:', task.id);
        if (userId !== task.authorId) {
          return bot.answerCallbackQuery(query.id, {
            text: "⛔ Лише постановник може відхиляти зміну дедлайну!",
            show_alert: true
          });
        }

        if (!task.pendingDeadlineChange) {
          return bot.answerCallbackQuery(query.id, {
            text: "❌ Пропозиція зміни дедлайну не знайдена",
            show_alert: true
          });
        }

        const currentDeadlineStr = moment(task.deadline).tz(TIMEZONE).format("DD.MM, HH:mm");
        
        // Повідомлення виконавцю
        const rejectExecutorMessage = `❌ Постановник відхилив зміну дедлайну задачі #${task.id} "${task.title}"\n\n🕒 Дедлайн залишається: ${currentDeadlineStr}`;
        
        sendToUserOrGroup(
          task.pendingDeadlineChange.proposedBy,
          task.chatId,
          rejectExecutorMessage
        );

        // Повідомлення постановника
        const rejectAuthorMessage = `❌ Ви відхилили зміну дедлайну для задачі #${task.id}\n\n👤 Запропоновано: ${task.pendingDeadlineChange.proposedByName}\n📝 Причина: ${task.pendingDeadlineChange.reason}`;

        // Оновлюємо повідомлення
        await bot.editMessageText(
          rejectAuthorMessage,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown"
          }
        ).catch(() => {
          bot.sendMessage(chatId, rejectAuthorMessage);
        });

        // Видаляємо пропозицію
        task.pendingDeadlineChange = null;
        saveTasks();
        
        await bot.answerCallbackQuery(query.id, { text: "❌ Дедлайн відхилено" });
        break;

      default:
        console.log('❌ Unknown action:', action);
        await bot.answerCallbackQuery(query.id, { text: "❌ Невідома дія" });
        break;
    }

  } catch (error) {
    console.error("❌ Помилка обробки callback:", error);
    await bot.answerCallbackQuery(query.id, { text: "❌ Помилка обробки запиту" });
  }
});
// ====== Команди ======
// ... (команди /take, /done, /reject, /delete, /deadline залишаються без змін)
bot.onText(/\/take (\d+)/, (msg, match) => {
  const task = tasks.find(t => t.id === parseInt(match[1]));
  if (!task) return bot.sendMessage(msg.chat.id, `❌ Задача #${match[1]} не знайдена`);
  
  if (task.status === "Виконано ✅") {
    return bot.sendMessage(msg.chat.id, "❌ Задача вже виконана");
  }
  
  task.status = "Взявся 🏃";
  task.takenByName = msg.from.username || msg.from.first_name;
  task.takenById = msg.from.id;
  saveTasks();
  
  bot.sendMessage(msg.chat.id, `🔹 Задача #${task.id} взята ${task.takenByName}`);
  
  if (task.authorId && task.authorId !== msg.from.id) {
    safeSendMessage(
      task.authorId,
      `🔹 Задача #${task.id} "${task.title}" взята ${task.takenByName}`
    ).catch(() => console.log("Не вдалось повідомити автора"));
  }
});

bot.onText(/\/done (\d+)/, (msg, match) => {
  const task = tasks.find(t => t.id === parseInt(match[1]));
  if (!task) return bot.sendMessage(msg.chat.id, `❌ Задача #${match[1]} не знайдена`);
  
  task.status = "Виконано ✅";
  saveTasks();
  bot.sendMessage(msg.chat.id, `✅ Задача #${task.id} виконана!`);
  
  if (task.authorId && task.authorId !== msg.from.id) {
    safeSendMessage(
      task.authorId,
      `✅ Задача #${task.id} "${task.title}" виконана ${task.takenByName || msg.from.first_name}`
    ).catch(() => console.log("Не вдалось повідомити автора"));
  }
});

bot.onText(/\/delete (\d+)/, (msg, match) => {
  const task = tasks.find(t => t.id === parseInt(match[1]));
  if (!task) return bot.sendMessage(msg.chat.id, `❌ Задача #${match[1]} не знайдена`);

  if (msg.from.id !== task.authorId) {
    return bot.sendMessage(msg.chat.id, "⛔ Лише постановник може видаляти цю задачу!");
  }

  tasks = tasks.filter(t => t.id !== task.id);
  saveTasks();
  bot.sendMessage(msg.chat.id, `🗑️ Задача #${task.id} видалена`);
  
  if (task.takenById && task.takenById !== msg.from.id) {
    safeSendMessage(task.takenById, `🗑️ Задача #${task.id} "${task.title}" видалена автором`)
      .catch(() => console.log("Не вдалось повідомити виконавця"));
  }
});
// ====== Команда для зміни дедлайну через текст ======
bot.onText(/\/deadline (\d+) (\d{2}\.\d{2}) (\d{2}:\d{2}) (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name;

  const taskId = parseInt(match[1]);
  const task = tasks.find(t => t.id === taskId);
  if (!task) return bot.sendMessage(chatId, `❌ Задача #${taskId} не знайдена`);

  const year = new Date().getFullYear();
  const fullDateStr = `${match[2]}.${year} ${match[3]}`;
  const newDeadline = moment.tz(fullDateStr, "DD.MM.YYYY HH:mm", TIMEZONE).toDate();

  if (newDeadline.toString() === "Invalid Date") {
    return bot.sendMessage(chatId, "❌ Неправильна дата. Використовуйте формат DD.MM HH:mm");
  }

  const reason = match[4].trim();
  if (!reason) return bot.sendMessage(chatId, "❌ Вкажіть причину зміни дедлайну");

  // Зберігаємо пропозицію зміни дедлайну
  task.pendingDeadlineChange = {
    newDeadline,
    proposedBy: userId,
    proposedByName: username,
    reason
  };
  saveTasks();

  const newDeadlineStr = moment(newDeadline).tz(TIMEZONE).format("DD.MM, HH:mm");

  // Повідомлення постановнику з кнопками підтвердити / відхилити
  const text = `⚡ Пропозиція зміни дедлайну задачі #${task.id} "${task.title}"\n\n` +
               `🕒 Новий дедлайн: ${newDeadlineStr}\n` +
               `👤 Запропоновано: ${username}\n` +
               `📝 Причина: ${reason}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ Підтвердити", callback_data: `confirm_deadline_${task.id}` },
        { text: "❌ Відхилити", callback_data: `reject_deadline_${task.id}` }
      ]
    ]
  };

  // Надсилаємо постановнику (якщо виконавець і постановник різні)
  if (task.authorId && task.authorId !== userId) {
    safeSendMessage(task.authorId, text, { reply_markup: keyboard }).catch(() => console.log("Не вдалось надіслати постановнику"));
  }

  // Підтвердження для виконавця
  bot.sendMessage(chatId, `✅ Пропозиція зміни дедлайну задачі #${task.id} на ${newDeadlineStr} надіслана постановнику`);
});


bot.onText(/\/tasks$/, (msg) => {
  const chatId = msg.chat.id;
  const isPrivate = msg.chat.type === 'private';
  
  let userTasks;
  if (isPrivate) {
    userTasks = tasks.filter(t => 
      t.authorId === msg.from.id || 
      t.takenById === msg.from.id || 
      (t.mentionedUsername && userIds[t.mentionedUsername] === msg.from.id)
    );
  } else {
    userTasks = tasks.filter(t => t.chatId === chatId);
  }
  
  if (userTasks.length === 0) return bot.sendMessage(chatId, "📭 Задач поки немає");

  const activeTasks = userTasks.filter(t => t.status !== "Виконано ✅" && t.status !== "Відхилено ❌");
  if (activeTasks.length === 0) return bot.sendMessage(chatId, "✅ Всі задачі виконані!");

  activeTasks.forEach(task => {
    const deadlineStr = task.deadline ? moment(task.deadline).tz(TIMEZONE).format("DD.MM, HH:mm") : "не вказано";
    const responsible = task.takenByName || (task.mentionedUsername ? `@${task.mentionedUsername}` : "не призначено");

    const buttons = [
      { text: "🏃 Взяти", callback_data: `take_${task.id}` },
      { text: "✅ Виконати", callback_data: `done_${task.id}` },
      { text: "❌ Відхилити", callback_data: `reject_${task.id}` },
      { text: "🗑️ Видалити", callback_data: `delete_${task.id}` },
      { text: "✏️ Змінити дедлайн", callback_data: `changeDeadline_${task.id}` }
    ];

    bot.sendMessage(
      chatId,
      `#${task.id} - ${task.title}\nСтатус: ${task.status}\nВідповідальний: ${responsible}\nДедлайн: ${deadlineStr}`,
      { reply_markup: { inline_keyboard: chunkButtons(buttons, 3) } }
    );
  });
});

bot.onText(/\/tasks_status/, (msg) => {
  const chatId = msg.chat.id;
  const isPrivate = msg.chat.type === 'private';
  
  let userTasks;
  if (isPrivate) {
    userTasks = tasks.filter(t => 
      t.authorId === msg.from.id || 
      t.takenById === msg.from.id || 
      (t.mentionedUsername && userIds[t.mentionedUsername] === msg.from.id)
    );
  } else {
    userTasks = tasks.filter(t => t.chatId === chatId);
  }
  
  if (userTasks.length === 0) return bot.sendMessage(chatId, "📭 Задач поки немає");

  const oneMonthAgo = moment().subtract(1, 'month').valueOf();
  const lastMonthTasks = userTasks.filter(t => t.createdAt >= oneMonthAgo);

  const incomplete = lastMonthTasks.filter(t => t.status !== "Виконано ✅" && t.status !== "Відхилено ❌");
  const completed = lastMonthTasks.filter(t => t.status === "Виконано ✅");
  const rejected = lastMonthTasks.filter(t => t.status === "Відхилено ❌");

  let text = "📊 *Статус задач (останній місяць):*\n\n";
  text += "📌 *Активні:*\n";
  text += incomplete.length === 0 ? "_немає_\n" : 
    incomplete.map(t => `#${t.id} - ${t.title} (${t.status})`).join('\n');
  
  text += "\n\n✅ *Виконані:*\n";
  text += completed.length === 0 ? "_немає_\n" : 
    completed.map(t => `#${t.id} - ${t.title}`).join('\n');

  text += "\n\n❌ *Відхилені:*\n";
  text += rejected.length === 0 ? "_немає_\n" : 
    rejected.map(t => `#${t.id} - ${t.title}`).join('\n');

  const buttons = [
    [{ text: "📈 Статистика за 7 днів", callback_data: "stats_7days" }]
  ];

  bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
});
bot.onText(/\/hide/, (msg) => {
  bot.sendMessage(msg.chat.id, "⌨️ Клавіатура прихована. Щоб повернути, використовуйте /keyboard", { 
    reply_markup: { remove_keyboard: true } 
  });
});
bot.onText(/\/keyboard/, (msg) => {
  bot.sendMessage(msg.chat.id, "⌨️ Клавіатура активована! Використовуйте кнопки для швидкого доступу до команд.", { 
    reply_markup: createInputKeyboard() 
  });
});
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, `📝 Інструкція:

Створення задач:
$ Задача 25.12 14:30 @username - термінова
# Задача 25.12 14:30 @username - звичайна
! Задача 25.12 14:30 @username - опціональна

Команди:
/take N - взяти задачу
/done N - завершити задачу  
/delete N - видалити задачу
/reject N - відхилити задачу
/deadline N DD.MM HH:mm [причина] - змінити дедлайн задачі (необов'язково вказувати причину)
/confirm_deadline N - підтвердити зміну дедлайну
/reject_deadline N - відхилити зміну дедлайну
/tasks - список активних задач
/tasks_status - статус всіх задач
/keyboard - активувати клавіатуру
/hide - приховати клавіатуру

Приклад зміни дедлайну:
/deadline 18 05.10 15:30 Термінова зміна через уточнення вимог

❗ Попередження:
• Команди /take, /done, /delete, /reject, /deadline відразу відправляються боту при виборі з меню Telegram і тому немає на звичайній клавіатурі під полем вводу. Для виконання цих команд потрібно ще додавати номер задачі N.
• Якщо працюєте у групах і користувач не зареєстрований у боті, повідомлення з завданням надсилається в групу.  
• Якщо виконавець натиснув "Взяти задачу", інлайн-кнопки зникають.  
  Для взаємодії з завданням використовуйте /tasks або введіть команду вручну.

Кнопки:
🏃 - взяти задачу
✅ - виконати задачу
❌ - відхилити задачу
🗑️ - видалити задачу
✏️ - змінити дедлайн
⏰ - налаштувати нагадування

🆕 Нові функції:
• Задачі можна створювати в приватному чаті з ботом
• Виконавець може запропонувати зміну дедлайну
• Додана кнопка "Відхилити" для відмови від задачі
• Щоденні звіти надсилаються у групу о 18:00 (якщо задачі групові) або постановнику, якщо задачі приватні
• Термінові задачі ($) - щоденні нагадування о 9:30 та 10:30
• Статистика за останні 7 днів

📌 Нагадування за пріоритетом:

🔴 Високий пріоритет ($)
* За 4 дні (96 годин)
* За 3 дні (72 години)
* За 24 години
* За 12 годин
* За 6 годин
* За 2 години
* За 1 годину

🟡 Середній пріоритет (#)
* За 2 доби (48 годин)
* За 24 години
* За 12 годин
* За 6 годин
* За 2 години

🟢 Низький пріоритет (!)
* За 1 добу (24 години)
* За 4–5 годин
`);
});


// ====== Нагадування ======
// ====== Покращена система нагадувань ======
// setInterval(() => {
//   const now = moment().tz(TIMEZONE);

//   tasks.forEach(task => {
//     // Пропускаємо виконані/відхилені задачі або задачі без дедлайну
//     if (!task.deadline || task.status === "Виконано ✅" || task.status === "Відхилено ❌") return;

//     const diffMinutes = moment(task.deadline).diff(now, "minutes");
//     if (diffMinutes <= 0) return;

//     const diffHours = diffMinutes / 60;
//     const diffDays = diffHours / 24;
    
//     task.sentReminders = task.sentReminders || [];

//     // Функція для відправки нагадування
//     const sendReminder = (timeText, reminderKey) => {
//       if (task.sentReminders.includes(reminderKey)) return;

//       const text = `⏰ Нагадування! Задача #${task.id} "${task.title}"\nДедлайн через ${timeText}`;
//       let buttons = [];
//       if (task.takenById) {
//         buttons = [[{ text: "✅ Виконано", callback_data: `done_${task.id}` }]];
//       } else {
//         buttons = [[
//           { text: "🏃 Взяти", callback_data: `take_${task.id}` },
//           { text: "✅ Виконано", callback_data: `done_${task.id}` }
//         ]];
//       }

//       let sent = false;

//       // 1️⃣ Спочатку відправляємо виконавцю (якщо взяв задачу)
//       if (task.takenById) {
//         safeSendMessage(task.takenById, text, { reply_markup: { inline_keyboard: buttons } })
//           .then(() => sent = true)
//           .catch(() => {});
//       }
//       // 2️⃣ Якщо призначений через username
//       else if (task.mentionedUsername) {
//         const mentionedId = userIds[task.mentionedUsername];
//         if (mentionedId) {
//           safeSendMessage(mentionedId, text, { reply_markup: { inline_keyboard: buttons } })
//             .then(() => sent = true)
//             .catch(() => {});
//         }
//       }

//       // 3️⃣ Fallback у групу або автору (для приватних задач)
//       setTimeout(() => {
//         if (!sent) {
//           if (task.chatId && !task.isPrivate) {
//             safeSendMessage(task.chatId, text, { reply_markup: { inline_keyboard: buttons } });
//           } else if (task.isPrivate && task.authorId) {
//             safeSendMessage(task.authorId, text, { reply_markup: { inline_keyboard: buttons } });
//           }
//         }
//       }, 500);

//       task.sentReminders.push(reminderKey);
//     };

//     // 📌 Термінова задача ($) - високий пріоритет
//     if (task.priority === "високий") {
//       // За 4 дні (96 годин)
//       if (diffHours <= 96 && diffHours > 95) {
//         sendReminder("4 дні", "4days");
//       }
//       // За 3 дні (72 години)
//       if (diffHours <= 72 && diffHours > 71) {
//         sendReminder("3 дні", "3days");
//       }
//       // За 24 години
//       if (diffHours <= 24 && diffHours > 23) {
//         sendReminder("24 години", "24h");
//       }
//       // За 12 годин
//       if (diffHours <= 12 && diffHours > 11) {
//         sendReminder("12 годин", "12h");
//       }
//       // За 6 годин
//       if (diffHours <= 6 && diffHours > 5) {
//         sendReminder("6 годин", "6h");
//       }
//       // За 2 години
//       if (diffHours <= 2 && diffHours > 1) {
//         sendReminder("2 години", "2h");
//       }
//       // За 1 годину
//       if (diffHours <= 1 && diffHours > 0.5) {
//         sendReminder("1 годину", "1h");
//       }
//     }

//     // 📌 Звичайна задача (#) - середній пріоритет
//     else if (task.priority === "середній") {
//       // За 2 доби (48 годин)
//       if (diffHours <= 48 && diffHours > 47) {
//         sendReminder("2 доби", "2days");
//       }
//       // За 24 години
//       if (diffHours <= 24 && diffHours > 23) {
//         sendReminder("24 години", "24h");
//       }
//       // За 12 годин
//       if (diffHours <= 12 && diffHours > 11) {
//         sendReminder("12 годин", "12h");
//       }
//       // За 6 годин
//       if (diffHours <= 6 && diffHours > 5) {
//         sendReminder("6 годин", "6h");
//       }
//       // За 2 години
//       if (diffHours <= 2 && diffHours > 1) {
//         sendReminder("2 години", "2h");
//       }
//     }

//     // 📌 Опціональна задача (!) - низький пріоритет
//     else if (task.priority === "низький") {
//       // За 1 добу (24 години)
//       if (diffHours <= 24 && diffHours > 23) {
//         sendReminder("1 добу", "24h");
//       }
//       // За 4-5 годин
//       if (diffHours <= 5 && diffHours > 4) {
//         sendReminder("4-5 годин", "4-5h");
//       }
//     }

//     // Нагадування про невзяті задачі (через певний час після створення)
//     if (!task.takenById && !task.remindedNotTaken) {
//       const hoursSinceCreation = (now - moment(task.createdAt)) / (1000 * 60 * 60);
//       const maxWait = { високий: 2, середній: 3, низький: 4 }[task.priority] || 3;

//       if (hoursSinceCreation >= maxWait) {
//         const text = `⚠️ Задача #${task.id} "${task.title}" ще не взята!\nПризначена: ${task.mentionedUsername ? `@${task.mentionedUsername}` : 'не призначено'}`;

//         if (task.chatId && !task.isPrivate) {
//           safeSendMessage(task.chatId, text);
//         } else if (task.isPrivate && task.authorId) {
//           safeSendMessage(task.authorId, text);
//         }

//         task.remindedNotTaken = true;
//       }
//     }
//   });

//   saveTasks();
// }, 60 * 1000); // Перевірка щохвилини
// ====== Покращена система нагадувань з повідомленнями для постановника ======
setInterval(() => {
  const now = moment().tz(TIMEZONE);

  tasks.forEach(task => {
    // Пропускаємо виконані/відхілені задачі або задачі без дедлайну
    if (!task.deadline || task.status === "Виконано ✅" || task.status === "Відхилено ❌") return;

    const diffMinutes = moment(task.deadline).diff(now, "minutes");
    if (diffMinutes <= 0) return;

    const diffHours = diffMinutes / 60;
    const diffDays = diffHours / 24;
    
    task.sentReminders = task.sentReminders || [];

    // Функція для відправки нагадування
    const sendReminder = (timeText, reminderKey) => {
      if (task.sentReminders.includes(reminderKey)) return;

      const text = `⏰ Нагадування! Задача #${task.id} "${task.title}"\nДедлайн через ${timeText}`;
      let buttons = [];
      if (task.takenById) {
        buttons = [[{ text: "✅ Виконано", callback_data: `done_${task.id}` }]];
      } else {
        buttons = [[
          { text: "🏃 Взяти", callback_data: `take_${task.id}` },
          { text: "✅ Виконано", callback_data: `done_${task.id}` }
        ]];
      }

      let sent = false;
      let executorName = null;

      // 1️⃣ Спочатку відправляємо виконавцю (якщо взяв задачу)
      if (task.takenById) {
        executorName = task.takenByName || "виконавець";
        safeSendMessage(task.takenById, text, { reply_markup: { inline_keyboard: buttons } })
          .then(() => sent = true)
          .catch(() => {});
      }
      // 2️⃣ Якщо призначений через username
      else if (task.mentionedUsername) {
        executorName = `@${task.mentionedUsername}`;
        const mentionedId = userIds[task.mentionedUsername];
        if (mentionedId) {
          safeSendMessage(mentionedId, text, { reply_markup: { inline_keyboard: buttons } })
            .then(() => sent = true)
            .catch(() => {});
        }
      }

      // 3️⃣ Fallback у групу або автору (для приватних задач)
      setTimeout(() => {
        if (!sent) {
          if (task.chatId && !task.isPrivate) {
            safeSendMessage(task.chatId, text, { reply_markup: { inline_keyboard: buttons } });
          } else if (task.isPrivate && task.authorId) {
            safeSendMessage(task.authorId, text, { reply_markup: { inline_keyboard: buttons } });
          }
        }

        // 📬 Повідомлення постановнику про відправлене нагадування
        if (task.authorId && executorName) {
          const authorNotification = `📬 Нагадування відправлено ${executorName} про задачу #${task.id} "${task.title}"\n⏰ До дедлайну залишилось: ${timeText}`;
          
          safeSendMessage(task.authorId, authorNotification)
            .catch(() => console.log(`Не вдалось повідомити автора про нагадування для задачі #${task.id}`));
        }
      }, 500);

      task.sentReminders.push(reminderKey);
    };

    // 📌 Термінова задача ($) - високий пріоритет
    if (task.priority === "високий") {
      if (diffHours <= 96 && diffHours > 95) {
        sendReminder("4 дні", "4days");
      }
      if (diffHours <= 72 && diffHours > 71) {
        sendReminder("3 дні", "3days");
      }
      if (diffHours <= 24 && diffHours > 23) {
        sendReminder("24 години", "24h");
      }
      if (diffHours <= 12 && diffHours > 11) {
        sendReminder("12 годин", "12h");
      }
      if (diffHours <= 6 && diffHours > 5) {
        sendReminder("6 годин", "6h");
      }
      if (diffHours <= 2 && diffHours > 1) {
        sendReminder("2 години", "2h");
      }
      if (diffHours <= 1 && diffHours > 0.5) {
        sendReminder("1 годину", "1h");
      }
    }

    // 📌 Звичайна задача (#) - середній пріоритет
    else if (task.priority === "середній") {
      if (diffHours <= 48 && diffHours > 47) {
        sendReminder("2 доби", "2days");
      }
      if (diffHours <= 24 && diffHours > 23) {
        sendReminder("24 години", "24h");
      }
      if (diffHours <= 12 && diffHours > 11) {
        sendReminder("12 годин", "12h");
      }
      if (diffHours <= 6 && diffHours > 5) {
        sendReminder("6 годин", "6h");
      }
      if (diffHours <= 2 && diffHours > 1) {
        sendReminder("2 години", "2h");
      }
    }

    // 📌 Опціональна задача (!) - низький пріоритет
    else if (task.priority === "низький") {
      if (diffHours <= 24 && diffHours > 23) {
        sendReminder("1 добу", "24h");
      }
      if (diffHours <= 5 && diffHours > 4) {
        sendReminder("4-5 годин", "4-5h");
      }
    }

    // Нагадування про невзяті задачі (через певний час після створення)
    if (!task.takenById && !task.remindedNotTaken) {
      const hoursSinceCreation = (now - moment(task.createdAt)) / (1000 * 60 * 60);
      const maxWait = { високий: 2, середній: 3, низький: 4 }[task.priority] || 3;

      if (hoursSinceCreation >= maxWait) {
        const text = `⚠️ Задача #${task.id} "${task.title}" ще не взята!\nПризначена: ${task.mentionedUsername ? `@${task.mentionedUsername}` : 'не призначено'}`;

        if (task.chatId && !task.isPrivate) {
          safeSendMessage(task.chatId, text);
        } else if (task.isPrivate && task.authorId) {
          safeSendMessage(task.authorId, text);
        }

        task.remindedNotTaken = true;
      }
    }
  });

  saveTasks();
}, 60 * 1000); // Перевірка щохвилини

// ====== Щоденні нагадування для термінових задач ($) ======
setInterval(() => {
  const now = moment().tz(TIMEZONE);
  
  // О 9:30 - кількість не взятих термінових задач КОЖНОМУ ВИКОНАВЦЮ
  if (now.hour() === 9 && now.minute() === 30) {
    const urgentTasks = tasks.filter(t => 
      t.priority === "високий" && 
      t.status !== "Виконано ✅" && 
      t.status !== "Відхилено ❌"
    );

    // Групуємо по виконавцям (userIds)
    const userUrgentTasks = {};
    urgentTasks.forEach(task => {
      let executorId = null;
      
      // Спочатку перевіряємо взяті задачі
      if (task.takenById) {
        executorId = task.takenById;
      } 
      // Потім перевіряємо призначені задачі (якщо виконавець зареєстрований)
      else if (task.mentionedUsername && userIds[task.mentionedUsername]) {
        executorId = userIds[task.mentionedUsername];
      }
      
      if (executorId) {
        if (!userUrgentTasks[executorId]) {
          userUrgentTasks[executorId] = [];
        }
        userUrgentTasks[executorId].push(task);
      }
    });

    // Відправляємо ПЕРСОНАЛЬНЕ сповіщення кожному виконавцю
    Object.entries(userUrgentTasks).forEach(([executorId, executorTasks]) => {
      const notTakenCount = executorTasks.filter(t => !t.takenById).length;
      const inProgressCount = executorTasks.filter(t => t.takenById).length;
      
      let text = `🔴 *Ранкове нагадування про термінові задачі*\n\n`;
      
      if (notTakenCount > 0) {
        text += `⚠️ У вас ${notTakenCount} не взятих термінових задач:\n`;
        executorTasks.filter(t => !t.takenById).forEach(task => {
          const deadlineStr = moment(task.deadline).tz(TIMEZONE).format("DD.MM HH:mm");
          text += `▫️ #${task.id} - "${task.title}" (до ${deadlineStr})\n`;
        });
        text += `\n`;
      }
      
      if (inProgressCount > 0) {
        text += `🟡 У вас ${inProgressCount} термінових задач в роботі:\n`;
        executorTasks.filter(t => t.takenById).forEach(task => {
          const deadlineStr = moment(task.deadline).tz(TIMEZONE).format("DD.MM HH:mm");
          text += `▫️ #${task.id} - "${task.title}" (до ${deadlineStr})\n`;
        });
      }

      // Відправляємо ПРИВАТНО виконавцю
      safeSendMessage(executorId, text, { parse_mode: "Markdown" })
        .catch(() => {
          // Якщо не вдалось відправити приватно, відправляємо в групу (якщо задача групова)
          const groupTasks = executorTasks.filter(t => t.chatId);
          if (groupTasks.length > 0) {
            const firstTask = groupTasks[0];
            safeSendMessage(firstTask.chatId, `@${executorTasks[0].mentionedUsername} ${text}`, { parse_mode: "Markdown" });
          }
        });
        // --- Ось сюди вставляємо сповіщення для автора ---
        executorTasks.forEach(task => {
          if (task.authorId) {
            const timeStr = now.format("HH:mm");
            const authorText = `⏰ Нагадка про задачу #${task.id} "${task.title}" надіслана ${task.takenById ? "взятому виконавцю" : "призначеному"} @${task.mentionedUsername || ''} о ${timeStr}`;
            safeSendMessage(task.authorId, authorText).catch(() => {});
          }
        });
    });

    // Сповіщення для НЕПРИЗНАЧЕНИХ термінових задач (в групах)
    const unassignedUrgentTasks = urgentTasks.filter(t => 
      !t.takenById && 
      !t.mentionedUsername && 
      t.chatId
    );
    
    if (unassignedUrgentTasks.length > 0) {
      const tasksByChat = {};
      unassignedUrgentTasks.forEach(task => {
        if (!tasksByChat[task.chatId]) {
          tasksByChat[task.chatId] = [];
        }
        tasksByChat[task.chatId].push(task);
      });

      Object.entries(tasksByChat).forEach(([chatId, chatTasks]) => {
        let text = `🔴 *Ранкове нагадування*\n\n`;
        text += `⚠️ У групі ${chatTasks.length} термінових задач без виконавця:\n`;
        chatTasks.forEach(task => {
          const deadlineStr = moment(task.deadline).tz(TIMEZONE).format("DD.MM HH:mm");
          text += `▫️ #${task.id} - "${task.title}" (до ${deadlineStr})\n`;
        });
        safeSendMessage(chatId, text, { parse_mode: "Markdown" });
      });
    }
  }

  // О 10:30 - детальний список невиконаних термінових задач КОЖНОМУ ВИКОНАВЦЮ
  if (now.hour() === 10 && now.minute() === 30) {
    const urgentTasks = tasks.filter(t => 
      t.priority === "високий" && 
      t.status !== "Виконано ✅" && 
      t.status !== "Відхилено ❌"
    );

    // Групуємо по виконавцям (userIds)
    const userUrgentTasks = {};
    urgentTasks.forEach(task => {
      let executorId = null;
      
      if (task.takenById) {
        executorId = task.takenById;
      } else if (task.mentionedUsername && userIds[task.mentionedUsername]) {
        executorId = userIds[task.mentionedUsername];
      }
      
      if (executorId) {
        if (!userUrgentTasks[executorId]) {
          userUrgentTasks[executorId] = [];
        }
        userUrgentTasks[executorId].push(task);
      }
    });

    // Відправляємо ПЕРСОНАЛЬНИЙ детальний список кожному виконавцю
    Object.entries(userUrgentTasks).forEach(([executorId, executorTasks]) => {
      let text = `📋 *Детальний список ваших термінових задач:*\n\n`;
      
      executorTasks.forEach(task => {
        const deadlineStr = moment(task.deadline).tz(TIMEZONE).format("DD.MM HH:mm");
        const status = task.takenById ? "🟡 В роботі" : "🔴 Не взята";
        const timeLeft = moment(task.deadline).fromNow();
        
        text += `#${task.id} - ${task.title}\n`;
        text += `   ${status}\n`;
        text += `   Дедлайн: ${deadlineStr} (${timeLeft})\n`;
        
        if (!task.takenById) {
          text += `   [Взяти задачу](/take_${task.id})\n`;
        } else {
          text += `   [Завершити](/done_${task.id})\n`;
        }
        text += `\n`;
      });

      // Додаємо кнопки для швидких дій
      const buttons = executorTasks.slice(0, 5).map(task => [
        { 
          text: `✅ #${task.id}`, 
          callback_data: `done_${task.id}` 
        },
        { 
          text: `🏃 #${task.id}`, 
          callback_data: `take_${task.id}` 
        }
      ]);

      // Відправляємо ПРИВАТНО виконавцю
      safeSendMessage(executorId, text, { 
        parse_mode: "Markdown",
        reply_markup: buttons.length > 0 ? { inline_keyboard: buttons } : undefined
      }).catch(() => {
        // Якщо не вдалось відправити приватно, відправляємо в групу
        const groupTasks = executorTasks.filter(t => t.chatId);
        if (groupTasks.length > 0) {
          const firstTask = groupTasks[0];
          const mentionedUser = firstTask.mentionedUsername ? `@${firstTask.mentionedUsername} ` : '';
          safeSendMessage(firstTask.chatId, `${mentionedUser}${text}`, { 
            parse_mode: "Markdown",
            reply_markup: buttons.length > 0 ? { inline_keyboard: buttons } : undefined
          });
        }
      });
      // --- Ось сюди вставляємо сповіщення для автора ---
      executorTasks.forEach(task => {
        if (task.authorId) {
          const timeStr = now.format("HH:mm");
          const authorText = `⏰ Нагадка про задачу #${task.id} "${task.title}" надіслана ${task.takenById ? "взятому виконавцю" : "призначеному"} @${task.mentionedUsername || ''} о ${timeStr}`;
          safeSendMessage(task.authorId, authorText).catch(() => {});
        }
      });
    });

    // Сповіщення для авторів про їхні непризначені термінові задачі
    const authorUrgentTasks = {};
    urgentTasks.forEach(task => {
      if (!task.takenById && !task.mentionedUsername && task.authorId) {
        if (!authorUrgentTasks[task.authorId]) {
          authorUrgentTasks[task.authorId] = [];
        }
        authorUrgentTasks[task.authorId].push(task);
      }
    });

    Object.entries(authorUrgentTasks).forEach(([authorId, authorTasks]) => {
      let text = `📋 *Ваші термінові задачі без виконавця:*\n\n`;
      authorTasks.forEach(task => {
        const deadlineStr = moment(task.deadline).tz(TIMEZONE).format("DD.MM HH:mm");
        const timeLeft = moment(task.deadline).fromNow();
        text += `#${task.id} - ${task.title}\n`;
        text += `   Дедлайн: ${deadlineStr} (${timeLeft})\n\n`;
      });

      safeSendMessage(authorId, text, { parse_mode: "Markdown" })
        .catch(() => {
          // Якщо не вдалось відправити автору, відправляємо в групу
          const groupTask = authorTasks.find(t => t.chatId);
          if (groupTask) {
            safeSendMessage(groupTask.chatId, text, { parse_mode: "Markdown" });
          }
        });
    });
  }
}, 60 * 1000);

// let lastDailyReport = null;
// // ====== Щоденний звіт о 18:00 (ТІЛЬКИ В ГРУПУ) ======
// setInterval(() => {
//   const now = moment().tz(TIMEZONE);
//   const today = now.format("YYYY-MM-DD");
  
//   if (now.hour() === 18 && now.minute() === 0 && lastDailyReport !== today) {
//     lastDailyReport = today;

//     // Групуємо задачі по chatId (групам) - тільки групові задачі
//     const tasksByChat = {};
//     tasks.forEach(task => {
//       if (task.chatId && !task.isPrivate) { // Тільки групові задачі
//         if (!tasksByChat[task.chatId]) {
//           tasksByChat[task.chatId] = [];
//         }
//         tasksByChat[task.chatId].push(task);
//       }
//     });

//     // Для кожної групи формуємо звіт
//     Object.entries(tasksByChat).forEach(([chatId, chatTasks]) => {
//       const oneMonthAgo = moment().subtract(1, 'month').valueOf();
//       const lastMonthTasks = chatTasks.filter(t => t.createdAt >= oneMonthAgo);

//       const activeTasks = lastMonthTasks.filter(t => t.status !== "Виконано ✅" && t.status !== "Відхилено ❌");
//       const completedToday = lastMonthTasks.filter(t => {
//         if (t.status !== "Виконано ✅" || !t.completedAt) return false;
//         const completedDate = moment(t.completedAt).tz(TIMEZONE);
//         return completedDate.isSame(now, "day");
//       });
      
//       if (activeTasks.length === 0 && completedToday.length === 0) return;

//       let text = "📊 *Щоденний звіт (останній місяць):*\n\n";
      
//       text += "📌 *Невиконані задачі:*\n";
//       if (activeTasks.length === 0) {
//         text += "_немає_\n";
//       } else {
//         activeTasks.forEach(task => {
//           const deadlineStr = task.deadline ? moment(task.deadline).tz(TIMEZONE).format("DD.MM HH:mm") : "не вказано";
//           const responsible = task.takenByName || (task.mentionedUsername ? `@${task.mentionedUsername}` : "не призначено");
//           text += `#${task.id} - ${task.title}\n   Відповідальний: ${responsible}\n   Дедлайн: ${deadlineStr}\n\n`;
//         });
//       }
      
//       text += "✅ *Виконані сьогодні:*\n";
//       if (completedToday.length === 0) {
//         text += "_немає_\n";
//       } else {
//         completedToday.forEach(task => {
//           const responsible = task.takenByName || task.authorName;
//           text += `#${task.id} - ${task.title} (${responsible})\n`;
//         });
//       }

//       const buttons = [
//         [{ text: "📈 Статистика за 7 днів", callback_data: "stats_7days" }]
//       ];

//       safeSendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } })
//         .catch(() => console.log(`Не вдалось надіслати звіт у чат ${chatId}`));
//     });
//   }
// }, 60 * 1000);
let lastDailyReport = null;
// ====== 📅 Щоденний звіт о 18:00 ======
setInterval(() => {
  const now = moment().tz(TIMEZONE);
  const today = now.format("YYYY-MM-DD");

  if (now.hour() === 12 && now.minute() === 43 && lastDailyReport !== today) {
    lastDailyReport = today;

    // --- 1️⃣ Групові задачі (йде у чат) ---
    const tasksByChat = {};
    tasks.forEach(task => {
      if (task.chatId && !task.isPrivate) {
        if (!tasksByChat[task.chatId]) tasksByChat[task.chatId] = [];
        tasksByChat[task.chatId].push(task);
      }
    });

    Object.entries(tasksByChat).forEach(([chatId, chatTasks]) => {
      const completedToday = chatTasks.filter(t =>
        t.status === "Виконано ✅" &&
        t.completedAt &&
        moment(t.completedAt).tz(TIMEZONE).isSame(now, "day")
      );

      const rejectedToday = chatTasks.filter(t =>
        t.status === "Відхилено ❌" &&
        t.updatedAt &&
        moment(t.updatedAt).tz(TIMEZONE).isSame(now, "day")
      );

      const inProgress = chatTasks.filter(t =>
        t.status === "В роботі 🚧" || t.status === "Взято 🧑‍💻"
      );

      const notTaken = chatTasks.filter(t => t.status === "Нове 🆕");

      if (
        completedToday.length === 0 &&
        rejectedToday.length === 0 &&
        inProgress.length === 0 &&
        notTaken.length === 0
      ) return;

      let text = "📊 *Щоденний звіт за сьогодні:*\n\n";

      text += "✅ *Виконані сьогодні:*\n";
      text += completedToday.length
        ? completedToday.map(t => `#${t.id} - ${t.title} (${t.takenByName || "невідомо"})`).join("\n") + "\n\n"
        : "_немає_\n\n";

      text += "🚫 *Відхилені сьогодні:*\n";
      text += rejectedToday.length
        ? rejectedToday.map(t => `#${t.id} - ${t.title}`).join("\n") + "\n\n"
        : "_немає_\n\n";

      text += "🕐 *У роботі:*\n";
      text += inProgress.length
        ? inProgress.map(t => {
            const deadline = t.deadline ? moment(t.deadline).tz(TIMEZONE).format("DD.MM HH:mm") : "не вказано";
            return `#${t.id} - ${t.title}\n   Відповідальний: ${t.takenByName || "невідомо"}\n   Дедлайн: ${deadline}`;
          }).join("\n\n") + "\n\n"
        : "_немає_\n\n";

      text += "🆕 *Не взяті:*\n";
      text += notTaken.length
        ? notTaken.map(t => `#${t.id} - ${t.title}`).join("\n") + "\n\n"
        : "_немає_\n\n";

      safeSendMessage(chatId, text, { parse_mode: "Markdown" })
        .catch(() => console.log(`Не вдалось надіслати звіт у чат ${chatId}`));
    });

    // --- 2️⃣ Приватні задачі (йде постановникам) ---
    const privateTasks = tasks.filter(t => t.isPrivate && t.authorId);
    const tasksByAuthor = {};

    privateTasks.forEach(task => {
      if (!tasksByAuthor[task.authorId]) tasksByAuthor[task.authorId] = [];
      tasksByAuthor[task.authorId].push(task);
    });

    Object.entries(tasksByAuthor).forEach(([authorId, authorTasks]) => {
      const completedToday = authorTasks.filter(t =>
        t.status === "Виконано ✅" &&
        t.completedAt &&
        moment(t.completedAt).tz(TIMEZONE).isSame(now, "day")
      );

      const rejectedToday = authorTasks.filter(t =>
        t.status === "Відхилено ❌" &&
        t.updatedAt &&
        moment(t.updatedAt).tz(TIMEZONE).isSame(now, "day")
      );

      const inProgress = authorTasks.filter(t =>
        t.status === "В роботі 🚧" || t.status === "Взято 🧑‍💻"
      );

      const notTaken = authorTasks.filter(t => t.status === "Нове 🆕");

      if (
        completedToday.length === 0 &&
        rejectedToday.length === 0 &&
        inProgress.length === 0 &&
        notTaken.length === 0
      ) return;

      let text = "📋 *Ваш щоденний звіт за сьогодні:*\n\n";

      text += "✅ *Виконані сьогодні:*\n";
      text += completedToday.length
        ? completedToday.map(t => `#${t.id} - ${t.title}`).join("\n") + "\n\n"
        : "_немає_\n\n";

      text += "🚫 *Відхилені сьогодні:*\n";
      text += rejectedToday.length
        ? rejectedToday.map(t => `#${t.id} - ${t.title}`).join("\n") + "\n\n"
        : "_немає_\n\n";

      text += "🕐 *У роботі:*\n";
      text += inProgress.length
        ? inProgress.map(t => {
            const deadline = t.deadline ? moment(t.deadline).tz(TIMEZONE).format("DD.MM HH:mm") : "не вказано";
            return `#${t.id} - ${t.title}\n   Виконавець: ${t.takenByName || "невідомо"}\n   Дедлайн: ${deadline}`;
          }).join("\n\n") + "\n\n"
        : "_немає_\n\n";

      text += "🆕 *Не взяті:*\n";
      text += notTaken.length
        ? notTaken.map(t => `#${t.id} - ${t.title}`).join("\n") + "\n\n"
        : "_немає_\n\n";

      safeSendMessage(authorId, text, { parse_mode: "Markdown" })
        .catch(() => console.log(`Не вдалось надіслати звіт постановнику ${authorId}`));
    });
  }
}, 60 * 1000);

// ====== Веб-сервер ======
const app = express();
app.get("/", (req, res) => res.send("Бот працює!"));
app.listen(process.env.PORT || 3000, () => console.log("Сервер запущено"));

console.log("🤖 Бот запущено");