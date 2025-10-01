
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
      throw err; // Повертаємо помилку для catch
    }
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

// ====== Обробка /start ======
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

  bot.sendMessage(chatId, `Привіт, ${msg.from.first_name}! Бот активований ✅\n\nВикористовуй /help для інструкції.`);
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

  // Обробка зміни дедлайну
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
      safeSendMessage(waitingDeadlineTask.takenById, notificationText)
        .catch(() => console.log("Не вдалось надіслати виконавцю"));
    }

    return bot.sendMessage(chatId, `✅ Дедлайн оновлено: ${deadlineStr}`);
  }

  // Обробка нових задач
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
    chatId,
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
    waitingDeadlineChange: null
  };
  
  tasks.push(task);
  saveTasks();

  const deadlineStr = moment(deadline).tz(TIMEZONE).format("DD.MM, HH:mm");
  const responsibleId = mentionedUsername ? userIds[mentionedUsername] : null;

  // Кнопки для інтерфейсу
  const allGroupButtons = [
    { text: "🏃 Взяти", callback_data: `take_${task.id}` },
    { text: "✅ Виконати", callback_data: `done_${task.id}` },
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
        { text: "⏰ Налаштувати нагадування", callback_data: `customRemind_${task.id}` }
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
});

// ====== Inline кнопки ======
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = query.from.id;
  const [action, taskId] = query.data.split('_');
  const task = tasks.find(t => t.id === parseInt(taskId));
  
  if (!task) {
    return bot.answerCallbackQuery(query.id, { text: "❌ Задача не знайдена" });
  }

  try {
    switch (action) {
      case "take":
        if (task.status === "Виконано ✅") {
          return bot.answerCallbackQuery(query.id, { text: "❌ Задача вже виконана", show_alert: true });
        }

        task.status = "Взявся 🏃";
        task.takenByName = query.from.username || query.from.first_name;
        task.takenById = userId;
        saveTasks();

        // Оновлюємо повідомлення
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: messageId }
        ).catch(() => console.log("Не вдалось оновити markup"));

        bot.sendMessage(
          chatId,
          `🔹 Задача #${task.id} взята ${task.takenByName}`
        );

        // Повідомлення автору
        if (task.authorId && task.authorId !== userId) {
          safeSendMessage(
            task.authorId,
            `🔹 Задача #${task.id} "${task.title}" взята ${task.takenByName}`
          ).catch(() => console.log("Не вдалось повідомити автора"));
        }
        break;

      case "customRemind":
        task.waitingCustomRemind = userId;
        saveTasks();
        bot.sendMessage(userId, `Введіть кількість годин для нагадування про задачу #${task.id}:`);
        break;

      case "changeDeadline":
        if (userId !== task.authorId) {
          return bot.answerCallbackQuery(query.id, {
            text: "⛔ Лише постановник може змінювати дедлайн!",
            show_alert: true
          });
        }

        task.waitingDeadlineChange = userId;
        saveTasks();
        bot.sendMessage(userId, `Введіть новий дедлайн для задачі #${task.id} (DD.MM HH:mm):`);
        break;

      case "done":
        task.status = "Виконано ✅";
        saveTasks();

        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: messageId }
        ).catch(() => console.log("Не вдалось оновити markup"));

        bot.sendMessage(chatId, `✅ Задача #${task.id} виконана!`);

        if (task.authorId && task.authorId !== userId) {
          safeSendMessage(
            task.authorId,
            `✅ Задача #${task.id} "${task.title}" виконана ${task.takenByName || query.from.first_name}`
          ).catch(() => console.log("Не вдалось повідомити автора"));
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
        bot.sendMessage(chatId, `🗑️ Задача #${task.id} видалена`);

        if (task.takenById && task.takenById !== userId) {
          safeSendMessage(task.takenById, `🗑️ Задача #${task.id} "${task.title}" видалена автором`)
            .catch(() => console.log("Не вдалось повідомити виконавця"));
        }
        break;
    }

    bot.answerCallbackQuery(query.id);
  } catch (error) {
    console.error("Помилка обробки callback:", error);
    bot.answerCallbackQuery(query.id, { text: "❌ Помилка обробки запиту" });
  }
});

// ====== Команди ======
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

bot.onText(/\/tasks$/, (msg) => {
  const chatId = msg.chat.id;
  if (tasks.length === 0) return bot.sendMessage(chatId, "📭 Задач поки немає");

  const activeTasks = tasks.filter(t => t.status !== "Виконано ✅" && t.chatId === chatId);
  if (activeTasks.length === 0) return bot.sendMessage(chatId, "✅ Всі задачі виконані!");

  activeTasks.forEach(task => {
    const deadlineStr = task.deadline ? moment(task.deadline).tz(TIMEZONE).format("DD.MM, HH:mm") : "не вказано";
    const responsible = task.takenByName || (task.mentionedUsername ? `@${task.mentionedUsername}` : "не призначено");

    const buttons = [
      { text: "🏃 Взяти", callback_data: `take_${task.id}` },
      { text: "✅ Виконати", callback_data: `done_${task.id}` },
      { text: "🗑️ Видалити", callback_data: `delete_${task.id}` },
      { text: "✏️ Змінити дедлайн", callback_data: `changeDeadline_${task.id}` }
    ];

    bot.sendMessage(
      chatId,
      `#${task.id} - ${task.title}\nСтатус: ${task.status}\nВідповідальний: ${responsible}\nДедлайн: ${deadlineStr}`,
      { reply_markup: { inline_keyboard: chunkButtons(buttons, 2) } }
    );
  });
});

bot.onText(/\/tasks_status/, (msg) => {
  const chatId = msg.chat.id;
  if (tasks.length === 0) return bot.sendMessage(chatId, "📭 Задач поки немає");

  const incomplete = tasks.filter(t => t.status !== "Виконано ✅" && t.chatId === chatId);
  const completed = tasks.filter(t => t.status === "Виконано ✅" && t.chatId === chatId);

  let text = "📊 *Статус задач:*\n\n";
  text += "📌 *Активні:*\n";
  text += incomplete.length === 0 ? "_немає_\n" : 
    incomplete.map(t => `#${t.id} - ${t.title} (${t.status})`).join('\n');
  
  text += "\n\n✅ *Виконані:*\n";
  text += completed.length === 0 ? "_немає_\n" : 
    completed.map(t => `#${t.id} - ${t.title}`).join('\n');

  bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, `📝 Інструкція:
  
Створення задач:
$ Задача 25.12 14:30 @username - термінова (4 год.)
# Задача 25.12 14:30 @username - звичайна (2 год.)
! Задача 25.12 14:30 @username - опціональна (1 год.)

Команди:
/take N - взяти задачу
/done N - завершити задачу  
/delete N - видалити задачу
/tasks - список активних задач
/tasks_status - статус всіх задач

Кнопки:
🏃 - взяти задачу
✅ - виконати задачу
🗑️ - видалити задачу
✏️ - змінити дедлайн
⏰ - налаштувати нагадування`);
});

// ====== Нагадування ======
// ====== Нагадування ======
// setInterval(() => {
//   const now = moment().tz(TIMEZONE);

//   tasks.forEach(task => {
//     if (!task.deadline || task.status === "Виконано ✅") return;

//     const diffMinutes = moment(task.deadline).diff(now, "minutes");
//     if (diffMinutes <= 0) return; // Дедлайн вже пройшов

//     const diffHours = Math.ceil(diffMinutes / 60);
//     task.sentReminders = task.sentReminders || [];

//     // Нагадування виконавцю щогодини (якщо залишилось 4 год і менше)
//     const defaultRemindHours = { високий: 4, середній: 2, низький: 1 }[task.priority] || 1;
//     const customRemindHours = task.reminderMinutes ? task.reminderMinutes / 60 : null;
//     const maxRemindHours = customRemindHours || defaultRemindHours;

//     if (diffHours <= maxRemindHours && diffHours > 0 && !task.sentReminders.includes(diffHours)) {
//       if (task.takenById) {
//         // Виконавець взяв задачу - надсилаємо йому
//         const text = `⏰ Нагадування! Задача #${task.id} "${task.title}"\nДедлайн через ${diffHours} год.`;
//         const buttons = [[{ text: "✅ Виконано", callback_data: `done_${task.id}` }]];
        
//         safeSendMessage(task.takenById, text, { reply_markup: { inline_keyboard: buttons } })
//           .catch(() => {
//             // Якщо виконавець недоступний - надсилаємо в групу
//             safeSendMessage(task.chatId, text);
//           });
        
//         task.sentReminders.push(diffHours);
//       } else if (task.mentionedUsername) {
//         // Задачу призначили, але не взяли - надсилаємо призначеному
//         const mentionedId = userIds[task.mentionedUsername];
//         if (mentionedId) {
//           const text = `⏰ Нагадування! Задача #${task.id} "${task.title}"\nДедлайн через ${diffHours} год.\n\n⚠️ Не забудьте взяти задачу!`;
//           const buttons = [[
//             { text: "🏃 Взяти", callback_data: `take_${task.id}` },
//             { text: "✅ Виконано", callback_data: `done_${task.id}` }
//           ]];
          
//           safeSendMessage(mentionedId, text, { reply_markup: { inline_keyboard: buttons } })
//             .catch(() => {
//               // Якщо призначений недоступний - надсилаємо в групу
//               safeSendMessage(task.chatId, text);
//             });
//         } else {
//           // Призначений ще не запустив бота - надсилаємо в групу
//           const text = `⏰ Задача #${task.id} "${task.title}"\nДедлайн через ${diffHours} год.\n⚠️ @${task.mentionedUsername} ще не взяв задачу!`;
//           safeSendMessage(task.chatId, text);
//         }
        
//         task.sentReminders.push(diffHours);
//       }
//       // Якщо задача без призначеного - нагадування не надсилаємо
//     }

//     // Нагадування про невзяті задачі (для автора)
//     if (!task.takenById && !task.remindedNotTaken) {
//       const hoursSinceCreation = (now - moment(task.createdAt)) / (1000 * 60 * 60);
//       const maxWait = { високий: 2, середній: 3, низький: 4 }[task.priority] || 3;
      
//       if (hoursSinceCreation >= maxWait) {
//         const text = `⚠️ Задача #${task.id} "${task.title}" ще не взята!\nПризначена: ${task.mentionedUsername ? `@${task.mentionedUsername}` : 'не призначено'}`;
        
//         // Надсилаємо автору
//         safeSendMessage(task.authorId, text)
//           .catch(() => {
//             // Якщо автор недоступний - надсилаємо в групу
//             safeSendMessage(task.chatId, text);
//           });
        
//         task.remindedNotTaken = true;
//       }
//     }
//   });

//   saveTasks();
// }, 60 * 1000);
setInterval(() => {
  const now = moment().tz(TIMEZONE);

  tasks.forEach(task => {
    if (!task.deadline || task.status === "Виконано ✅") return;

    const diffMinutes = moment(task.deadline).diff(now, "minutes");
    if (diffMinutes <= 0) return;

    const diffHours = Math.ceil(diffMinutes / 60);
    task.sentReminders = task.sentReminders || [];

    // Визначаємо максимальну кількість годин для нагадувань
    const defaultRemindHours = { високий: 4, середній: 2, низький: 1 }[task.priority] || 1;
    const maxRemindHours = task.reminderMinutes ? Math.ceil(task.reminderMinutes / 60) : defaultRemindHours;

    // Нагадування щогодини
    if (diffHours <= maxRemindHours && diffHours > 0 && !task.sentReminders.includes(diffHours)) {
      if (task.takenById) {
        const text = `⏰ Нагадування! Задача #${task.id} "${task.title}"\nДедлайн через ${diffHours} год.`;
        const buttons = [[{ text: "✅ Виконано", callback_data: `done_${task.id}` }]];
        
        safeSendMessage(task.takenById, text, { reply_markup: { inline_keyboard: buttons } })
          .catch(() => {
            safeSendMessage(task.chatId, text);
          });
        
        task.sentReminders.push(diffHours);
      } else if (task.mentionedUsername) {
        const mentionedId = userIds[task.mentionedUsername];
        if (mentionedId) {
          const text = `⏰ Нагадування! Задача #${task.id} "${task.title}"\nДедлайн через ${diffHours} год.\n\n⚠️ Не забудьте взяти задачу!`;
          const buttons = [[
            { text: "🏃 Взяти", callback_data: `take_${task.id}` },
            { text: "✅ Виконано", callback_data: `done_${task.id}` }
          ]];
          
          safeSendMessage(mentionedId, text, { reply_markup: { inline_keyboard: buttons } })
            .catch(() => {
              safeSendMessage(task.chatId, text);
            });
        } else {
          const text = `⏰ Задача #${task.id} "${task.title}"\nДедлайн через ${diffHours} год.\n⚠️ @${task.mentionedUsername} ще не взяв задачу!`;
          safeSendMessage(task.chatId, text);
        }
        
        task.sentReminders.push(diffHours);
      }
    }

    // Нагадування про невзяті задачі
    if (!task.takenById && !task.remindedNotTaken) {
      const hoursSinceCreation = (now - moment(task.createdAt)) / (1000 * 60 * 60);
      const maxWait = { високий: 2, середній: 3, низький: 4 }[task.priority] || 3;
      
      if (hoursSinceCreation >= maxWait) {
        const text = `⚠️ Задача #${task.id} "${task.title}" ще не взята!\nПризначена: ${task.mentionedUsername ? `@${task.mentionedUsername}` : 'не призначено'}`;
        
        safeSendMessage(task.authorId, text)
          .catch(() => {
            safeSendMessage(task.chatId, text);
          });
        
        task.remindedNotTaken = true;
      }
    }
  });

  saveTasks();
}, 60 * 1000);

let lastDailyReport = null;
// ✅ ВИПРАВЛЕННЯ 3: Щоденний звіт о 18:00

// варіант 2
// setInterval(() => {
//   const now = moment().tz(TIMEZONE);
//   const today = now.format("YYYY-MM-DD");
  
//   // Перевіряємо, чи саме 18:00
//   if (now.hour() === 18 && now.minute() === 0 && lastDailyReport !== today) {
//     lastDailyReport = today;

//     const activeTasks = tasks.filter(t => t.status !== "Виконано ✅");
//     const completedTasks = tasks.filter(t => 
//       {
//         if (t.status !== "Виконано ✅") return false;
//         if (!t.completedAt) return false;
//         const completedDate = moment(t.completedAt).tz(TIMEZONE);
//         return completedDate.isSame(now, "day");
//         }
//     );
    
//     if (activeTasks.length === 0 && completedTasks.length === 0) return;

//     let text = "📊 *Щоденний звіт:*\n\n";
    
//     // Активні задачі
//     text += "📌 *Невиконані задачі:*\n";
//     if (activeTasks.length === 0) {
//       text += "_немає_\n";
//     } else {
//       activeTasks.forEach(task => {
//         const deadlineStr = task.deadline ? moment(task.deadline).tz(TIMEZONE).format("DD.MM HH:mm") : "не вказано";
//         const responsible = task.takenByName || (task.mentionedUsername ? `@${task.mentionedUsername}` : "не призначено");
//         text += `#${task.id} - ${task.title}\n   Відповідальний: ${responsible}\n   Дедлайн: ${deadlineStr}\n\n`;
//       });
//     }
    
//     // Виконані задачі
//     text += "✅ *Виконані сьогодні:*\n";
//     if (completedTasks.length === 0) {
//       text += "_немає_\n";
//     } else {
//       completedTasks.forEach(task => {
//         const responsible = task.takenByName || task.authorName;
//         text += `#${task.id} - ${task.title} (${responsible})\n`;
//       });
//     }

//     // Надсилаємо всім користувачам
//     // Object.values(userIds).forEach(uid => {
//     //   safeSendMessage(uid, text, { parse_mode: "Markdown" })
//     //     .catch(() => console.log(`Не вдалось надіслати звіт користувачу ${uid}`));
//     // });
//     // Перевіряємо, чи всі користувачі зареєстровані
//     const allUsersRegistered = Object.keys(userIds).length > 0;
//     let hasUnregisteredUsers = false;
    
//     // Перевіряємо наявність незареєстрованих користувачів
//     const allUsernames = new Set();
//     tasks.forEach(task => {
//       if (task.authorName && task.authorName.startsWith('@') === false) {
//         allUsernames.add(task.authorName);
//       }
//       if (task.takenByName && task.takenByName.startsWith('@') === false) {
//         allUsernames.add(task.takenByName);
//       }
//       if (task.mentionedUsername) {
//         allUsernames.add(task.mentionedUsername);
//       }
//     });

//     // Перевіряємо чи є хтось незареєстрований
//     allUsernames.forEach(username => {
//       if (!userIds[username]) {
//         hasUnregisteredUsers = true;
//       }
//     });

//     // Відправляємо звіт
//     if (hasUnregisteredUsers) {
//       // Якщо є незареєстровані - відправляємо в групу
//       const groupChatIds = new Set();
//       tasks.forEach(task => {
//         if (task.chatId) groupChatIds.add(task.chatId);
//       });
      
//       groupChatIds.forEach(chatId => {
//         safeSendMessage(chatId, text, { parse_mode: "Markdown" })
//           .catch(() => console.log(`Не вдалось надіслати звіт у чат ${chatId}`));
//       });
//     } else {
//       // Всі зареєстровані - відправляємо приватно
//       Object.values(userIds).forEach(uid => {
//         safeSendMessage(uid, text, { parse_mode: "Markdown" })
//           .catch(() => console.log(`Не вдалось надіслати звіт користувачу ${uid}`));
//       });
//     }
//   }
// }, 60 * 1000);
setInterval(() => {
  const now = moment().tz(TIMEZONE);
  const today = now.format("YYYY-MM-DD");
  
  if (now.hour() === 18 && now.minute() === 0 && lastDailyReport !== today) {
    lastDailyReport = today;

    // Групуємо задачі по chatId (групам)
    const tasksByChat = {};
    tasks.forEach(task => {
      if (!tasksByChat[task.chatId]) {
        tasksByChat[task.chatId] = [];
      }
      tasksByChat[task.chatId].push(task);
    });

    // Для кожної групи формуємо звіт
    Object.entries(tasksByChat).forEach(([chatId, chatTasks]) => {
      const activeTasks = chatTasks.filter(t => t.status !== "Виконано ✅");
      const completedToday = chatTasks.filter(t => {
        if (t.status !== "Виконано ✅" || !t.completedAt) return false;
        const completedDate = moment(t.completedAt).tz(TIMEZONE);
        return completedDate.isSame(now, "day");
      });
      
      if (activeTasks.length === 0 && completedToday.length === 0) return;

      let text = "📊 *Щоденний звіт:*\n\n";
      
      text += "📌 *Невиконані задачі:*\n";
      if (activeTasks.length === 0) {
        text += "_немає_\n";
      } else {
        activeTasks.forEach(task => {
          const deadlineStr = task.deadline ? moment(task.deadline).tz(TIMEZONE).format("DD.MM HH:mm") : "не вказано";
          const responsible = task.takenByName || (task.mentionedUsername ? `@${task.mentionedUsername}` : "не призначено");
          text += `#${task.id} - ${task.title}\n   Відповідальний: ${responsible}\n   Дедлайн: ${deadlineStr}\n\n`;
        });
      }
      
      text += "✅ *Виконані сьогодні:*\n";
      if (completedToday.length === 0) {
        text += "_немає_\n";
      } else {
        completedToday.forEach(task => {
          const responsible = task.takenByName || task.authorName;
          text += `#${task.id} - ${task.title} (${responsible})\n`;
        });
      }

      // Збираємо користувачів, які мають отримати звіт з цієї групи
      const usersInThisChat = new Set();
      
      chatTasks.forEach(task => {
        // Додаємо автора
        if (task.authorName) usersInThisChat.add(task.authorName);
        // Додаємо виконавця
        if (task.takenByName) usersInThisChat.add(task.takenByName);
        // Додаємо призначеного
        if (task.mentionedUsername) usersInThisChat.add(task.mentionedUsername);
      });

      // Перевіряємо, чи всі користувачі зареєстровані
      let hasUnregisteredUsers = false;
      usersInThisChat.forEach(username => {
        if (!userIds[username]) {
          hasUnregisteredUsers = true;
        }
      });

      if (hasUnregisteredUsers) {
        // Якщо є незареєстровані - відправляємо в групу
        safeSendMessage(chatId, text, { parse_mode: "Markdown" })
          .catch(() => console.log(`Не вдалось надіслати звіт у чат ${chatId}`));
      } else {
        // Всі зареєстровані - відправляємо приватно кожному учаснику
        usersInThisChat.forEach(username => {
          const userId = userIds[username];
          if (userId) {
            safeSendMessage(userId, text, { parse_mode: "Markdown" })
              .catch(() => console.log(`Не вдалось надіслати звіт користувачу ${username}`));
          }
        });
      }
    });
  }
}, 60 * 1000);

// ====== Веб-сервер ======
const app = express();
app.get("/", (req, res) => res.send("Бот працює!"));
app.listen(process.env.PORT || 3000, () => console.log("Сервер запущено"));

console.log("🤖 Бот запущено");