#!/usr/bin/env node
// Сборка macOS-бандла FlashBrowser под Apple Silicon.
//
// Почему скрипт, а не CLI electron-packager:
//   CLI (node_modules/.bin/electron-packager) под Node 16 успешно собирает
//   приложение, но в самом конце падает с
//       Cannot read properties of undefined (reading 'info')
//   и кодом возврата 1 — уже ПОСЛЕ того, как .app записан на диск.
//   Тот же вызов через API проходит без ошибки и возвращает 0, поэтому
//   используем API: так сборку можно ставить в скрипты/CI и проверять код возврата.
//
// Запуск (обязательно Node 16, см. BUILD-M1.md):
//   npx -y node@16 scripts/build-m1.js
//
// Переменные окружения:
//   OUT      — куда класть результат (по умолчанию ../build рядом с репозиторием)
//   ARCH     — архитектура Electron (по умолчанию x64: у Electron 9 нет arm64 для macOS)

// Проверка версии Node выполняется ДО require('electron-packager').
// На Node 26 packager завершается с кодом 0, ничего не собрав (и даже не
// доходит до колбеков), поэтому единственный надёжный способ — не начинать.
// Рабочая версия — 16 (проверена сборка), её и требуем.
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor !== 16) {
  console.error(`Нужен Node 16, запущено ${process.versions.node}.`);
  console.error('Запуск: npx -y node@16 scripts/build-m1.js');
  process.exit(1);
}

const path = require('path');
const packager = require('electron-packager');

// Корень приложения — каталог уровнем выше scripts/, там лежит package.json и index.js.
const appDir = path.resolve(__dirname, '..');

// Куда складывать собранный .app. По умолчанию — соседняя папка build,
// чтобы артефакты не попадали в git.
const outDir = process.env.OUT || path.resolve(appDir, '..', 'build');

// Архитектура: Electron 9.4.4 не публикует darwin-arm64, поэтому x64 + Rosetta.
// Если когда-нибудь обновите Electron до 11+, сюда можно передать ARCH=arm64.
const arch = process.env.ARCH || 'x64';

packager({
  dir: appDir,               // что упаковываем (исходники приложения)
  name: 'FlashBrowser',      // имя бандла: FlashBrowser.app и бинарь внутри
  platform: 'darwin',        // целевая платформа
  arch: arch,                // архитектура Electron-бинарника
  out: outDir,               // каталог вывода
  overwrite: true,           // перезаписывать прошлую сборку
  icon: path.join(appDir, 'icon.icns'), // иконка приложения
  prune: true,               // выкинуть из node_modules лишние dev-зависимости
})
  .then((appPaths) => {
    // packager умеет завершиться «успешно», ничего не собрав (видели на Node 26).
    // Поэтому дополнительно проверяем, что результат действительно на диске.
    const fs = require('fs');
    const missing = appPaths.filter((appPath) => !fs.existsSync(appPath));
    if (missing.length) {
      console.error('Сборка ничего не создала:', missing.join(', '));
      console.error('Скорее всего неподходящая версия Node. Нужен Node 16:');
      console.error('  npx -y node@16 scripts/build-m1.js');
      process.exit(1);
    }

    // Контрольная проверка: внутри должен быть бинарник приложения.
    const binaries = appPaths
      .map((appPath) => path.join(appPath, 'FlashBrowser.app', 'Contents', 'MacOS', 'FlashBrowser'))
      .filter((bin) => !fs.existsSync(bin));
    if (binaries.length) {
      console.error('В бандле нет исполняемого файла:', binaries.join(', '));
      process.exit(1);
    }

    // appPaths — массив путей к собранным .app (для одной платформы/архитектуры — один).
    console.log('Готово:', appPaths.join(', '));
    if (arch === 'x64' && process.arch === 'arm64') {
      console.log('Собрано под x64 — на Apple Silicon запуск пойдёт через Rosetta 2.');
    }
  })
  .catch((error) => {
    // Печатаем полный стек: без него ошибки packager нечитаемы.
    console.error('Сборка не удалась:', error);
    process.exit(1);
  });
