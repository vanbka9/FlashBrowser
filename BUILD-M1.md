# Сборка под Apple Silicon (M1/M2/M3)

Инструкция по сборке macOS-бандла FlashBrowser на Apple Silicon. Все проблемы,
перечисленные ниже, реально встретились при сборке — с симптомами, причинами и
рабочими обходами.

## Коротко

```bash
npm ci --legacy-peer-deps --arch=x64      # 1. зависимости (x64!)
# 2. если npm заблокировал install-скрипты — доставить Electron вручную (§2.3)
npx -y node@16 scripts/build-m1.js        # 3. сборка под Node 16
# результат: ../build/FlashBrowser-darwin-x64/FlashBrowser.app
```

## 1. Почему x64 и Rosetta

Собрать нативное arm64-приложение с поддержкой Flash невозможно по двум причинам:

1. **Electron 9.4.4 не публикует darwin-arm64.** Установщик получает 404 на
   `electron-v9.4.4-darwin-arm64.zip`. Apple Silicon поддерживается начиная с Electron 11.
2. **Adobe не выпускала arm64-версию Flash Player.** `PepperFlashPlayer.plugin` —
   x86_64, и Chromium загружает его в plugin-процесс своей архитектуры. arm64-браузер
   не сможет загрузить x86_64-плагин даже в Electron 11+.

Поэтому собираем x64-сборку, которая работает на Apple Silicon через Rosetta 2:

```bash
softwareupdate --install-rosetta --agree-to-license   # один раз
```

## 2. Установка зависимостей: что ломается

### 2.1. Конфликт peer-зависимостей (ERESOLVE)

```
npm error While resolving: @cliqz/adblocker-electron@1.23.0
npm error Found: electron@9.4.4
npm error Could not resolve dependency: peer electron@">11"
```

`@cliqz/adblocker-electron` требует Electron > 11, а в проекте зафиксирован 9.4.4.
Блокировщик в `index.js` закомментирован, поэтому конфликт безопасен.

**Решение:** ставить с `--legacy-peer-deps`.

### 2.2. Несуществующий arm64-архив Electron

Без явной архитектуры установщик Electron пытается скачать сборку под текущую
машину (arm64) и получает 404:

```
HTTPError: Response code 404 (Not Found) for
https://github.com/electron/electron/releases/download/v9.4.4/electron-v9.4.4-darwin-arm64.zip
```

**Решение:** `--arch=x64` в `npm ci` (npm прокидывает `npm_config_arch` в
install-скрипт Electron).

### 2.3. npm блокирует install-скрипты

Симптом в конце установки:

```
npm warn install-scripts 3 packages have install scripts not yet covered by allowScripts:
npm warn install-scripts   electron@9.4.4 (postinstall: node install.js)
```

Скрипт Electron не выполняется → бинарь не скачивается/не распаковывается.
Типичный признак: `node_modules/electron/dist` весит 160–200 КБ вместо ~169 МБ
(лежит только `Contents/MacOS/Electron`, без `Frameworks`).

**Решение A:** разрешить скрипт и переустановить:

```bash
npm install-scripts approve electron
npm ci --legacy-peer-deps --arch=x64
```

**Решение B (если A недоступен):** доставить бинарь вручную.

```bash
cd node_modules/electron
npm_config_arch=x64 node install.js
# скрипт может завершиться с кодом 0, но распаковать не всё — проверяем размер:
du -sh dist

# если dist неполный — распаковываем zip сами (ditto сохраняет симлинки):
ZIP=$(find ~/Library/Caches/electron -name "electron-v9.4.4-darwin-x64.zip" | head -1)
rm -rf dist && mkdir dist && ditto -x -k "$ZIP" dist

# путь к бинарю относительно dist/, БЕЗ перевода строки в конце:
printf 'Electron.app/Contents/MacOS/Electron' > path.txt
```

Две ловушки этого шага:

- `node install.js` возвращает 0 даже когда распаковка оборвалась — проверять `du -sh dist` (≈169M);
- `path.txt` — это **путь к бинарю**, а не архитектура. Если записать `x64` или
  строку с `\n`, запуск упадёт с `spawn .../dist/x64 ENOENT`.

### 2.4. Node 26 для сборки не подходит

`electron-packager@15` под Node 26 отрабатывает «успешно» (код 0), но не создаёт
ни одного файла: распаковка шаблона Electron обрывается, а ошибка не всплывает.
В `package.json` указано `engines: node >=12.14 <16`, но на практике сборка
проверена на **Node 16** (`npx -y node@16`) — на Node 26 packager молча ничего
не создаёт. Используйте 16-ю версию.

**Решение:** запускать сборку под Node 16, не устанавливая nvm:

```bash
npx -y node@16 scripts/build-m1.js
```

### 2.5. CLI electron-packager падает в самом конце

Под Node 16 CLI собирает приложение, но затем:

```
electron-packager Renaming Electron to FlashBrowser ...
electron-packager Moving .../FlashBrowser-darwin-x64 to ...
Cannot read properties of undefined (reading 'info')
```

Код возврата 1, **но `.app` уже собран и работоспособен**. Ошибка возникает в
финальном шаге `move` (гонка в старом `extract-zip`/`fs-extra`), а не в сборке.
Через API этого не происходит, поэтому в репозитории есть `scripts/build-m1.js`:
он вызывает packager напрямую и завершается с кодом 0.

Если всё же нужен именно CLI — ошибку можно игнорировать, предварительно
проверив, что `FlashBrowser.app` появился.

### 2.6. `--arch=arm64` ничего не собирает

```
WARNING: Official darwin/arm64 support only exists in Electron >= 11.0.0-beta.1
```

После этого предупреждения команда завершается **с кодом 0 и без единого файла**
на выходе. Это не успех: для Electron 9 arm64-бинаря не существует (см. §1).

## 3. Сборка

```bash
npx -y node@16 scripts/build-m1.js
```

Скрипт `scripts/build-m1.js`:

- вызывает `electron-packager` через API (чистый код возврата, см. §2.5);
- кладёт результат в `../build/FlashBrowser-darwin-x64` (можно переопределить `OUT=/путь`);
- архитектура по умолчанию `x64` (можно переопределить `ARCH=...` для будущих версий Electron).

Эквивалентная команда без скрипта (на свой страх и риск, см. §2.5):

```bash
npx -y node@16 node_modules/electron-packager/bin/electron-packager.js \
  . FlashBrowser --platform=darwin --arch=x64 --out=../build --overwrite --icon=icon.icns
```

## 4. Проверка результата

```bash
APP=../build/FlashBrowser-darwin-x64/FlashBrowser.app

# 1. архитектура — должна быть x86_64
file "$APP/Contents/MacOS/FlashBrowser"

# 2. патч под PlantVisor внутри бандла на месте (должно быть 2)
grep -c "data-pvff" "$APP/Contents/Resources/app/index.js"

# 3. дымовой запуск с отладочным портом
"$APP/Contents/MacOS/FlashBrowser" --remote-debugging-port=9223 &
sleep 10
curl -s http://127.0.0.1:9223/json/list
# в списке целей должен быть webview с https://192.168.2.26/PlantVisorPRO/
```

## 5. Запуск на Apple Silicon

- Первый запуск — через Rosetta 2 (ставится один раз, см. §1).
- Если бандл передавали архивом/скачиванием, macOS может повесить карантин:

  ```bash
  xattr -dr com.apple.quarantine FlashBrowser.app
  ```

- Профили: запуск из исходников (`electron .`) и собранный `.app` используют разные
  каталоги настроек (`~/Library/Application Support/FlashBrowser` против
  `~/Library/Application Support/Flash Browser`) — это нормально и не конфликтует
  с установленной версией.

## 6. Если нужен настоящий arm64

Только без Flash — вариантов два:

1. **Ruffle** (эмулятор Flash на WebAssembly) вместо PPAPI-плагина: тогда браузер
   может быть нативным arm64. Требует проверки совместимости роликов PlantVisor.

   Проверка 2026-11-23 (Ruffle 0.8, инъекция в живую страницу через CDP):

   - **график `grafico.swf` отрисовывается полностью** — кривые, ось дат, кнопки
     «Quick choice/Search/Customize», данные подтягиваются;
   - **карта (44 отдельных `.swf`) тоже работает**, но только при трёх условиях:
     1. `preferredRenderer: "canvas"` в конфиге Ruffle — на дефолтном WebGL
        десяток плееров исчерпывает GL-контексты, Chromium уходит в SwiftShader
        и GPU-процесс упирается в 95–100% CPU (с canvas — 4–5%);
     2. URL ролика брать из `element.src`, а не из `getAttribute('src')`:
        у страниц PlantVisor есть `<base href>`, и ручной `new URL(src, location.href)`
        даёт неверный путь (404 → Ruffle показывает заглушку);
     3. создавать плееры по очереди (`setTimeout` 100–150 мс), а не циклом:
        синхронная замена 44 штук вешает renderer на минуту и больше.

   Итоговые замеры (карта, 44 виджета):

   | Состояние | GPU-процесс | Renderer |
   |---|---|---|
   | нативно Flash (44 PPAPI) | 2–4% | ~0% |
   | 44 плеера Ruffle, WebGL | 95–100% | — |
   | 44 плеера Ruffle, canvas | ~36% | ~57% |
   | 1 плеер Ruffle (график) | ~5–8% | — |

   То есть Ruffle для карты работает, но заметно дороже Flash по CPU — нужен
   запас по производительности и, желательно, ленивая инициализация.

   Что осталось проверить: клики по виджетам (ExternalInterface — карта
   интерактивная) и загрузку Ruffle до парсинга страницы в каждом фрейме
   (в Electron: `preload` + `nodeIntegrationInSubFrames: true`).

2. **Electron 11** (Chromium 87, Flash ещё поддерживается, arm64-сборки есть) —
   не подходит по двум причинам:
   - arm64-версии Flash-плагина не существует, x86_64-плагин в arm64-браузер не
     загрузится;
   - в Chromium 84+ **удалена поддержка TLS 1.0**, а сервер PlantVisorPRO умеет
     только TLS 1.0 (см. `PATCH_NOTES.md`, раздел «Почему FlashBrowser»).
     То есть после обновления приложение вообще перестанет соединяться с прибором.

   Вывод: Electron 9 (Chromium 83) — последняя версия, которая одновременно
   поддерживает TLS 1.0 и Flash, поэтому «просто обновить Electron» нельзя.

## 7. Итоговые ограничения

- Бандл получается x86_64 (~257 МБ) и работает через Rosetta 2.
- Каждый шаг установки стоит проверять: часть инструментов старых версий
  завершается с кодом 0, не выполнив работу (§2.3, §2.4, §2.6).
