'use strict';
// Задать или сменить пароль администратора панели. Пароль вводится с клавиатуры
// и на экран не выводится; в файл попадает только его хеш.
//
//   node server/control/set-admin.js

const readline = require('readline');
const { saveAdmin, adminFile, MIN_LENGTH } = require('./auth');

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Вводимые знаки не показываем
    rl._writeToOutput = (text) => { if (text.includes(question)) process.stdout.write(question); };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

(async () => {
  if (!process.stdin.isTTY) {
    console.error('Пароль вводится с клавиатуры: запустите команду в терминале (по ssh — с ключом -t).');
    process.exit(1);
  }
  const first = await ask(`Новый пароль администратора (не короче ${MIN_LENGTH} знаков): `);
  const second = await ask('Ещё раз: ');
  if (first !== second) {
    console.error('Пароли не совпали. Ничего не изменено.');
    process.exit(1);
  }
  try {
    console.log(`Пароль задан. Хеш записан в ${saveAdmin(first)}`);
  } catch (err) {
    console.error(`${err.message} Файл ${adminFile()} не изменён.`);
    process.exit(1);
  }
})();
