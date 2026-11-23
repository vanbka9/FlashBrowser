# Патч под PlantVisorPRO

Форк FlashBrowser, подогнанный под работу с PlantVisorPRO (`https://192.168.2.26/PlantVisorPRO/`).
Изменены два файла: `index.js` и `browser.html`.

## Проблема, которую решает патч

Страницы PlantVisorPRO подключают стили по фиксированному адресу:

```html
<link rel="stylesheet" href="stylesheet/plantVisor.css">
```

Сервер на этот адрес отвечает 404:

```
GET /PlantVisorPRO/stylesheet/plantVisor.css   → 404 (Tomcat 6.0.14, Apache-Coyote/1.1)
GET /PlantVisorPRO/stylesheet/keyboard.css     → 200 (тот же каталог, отдаётся)
GET /PlantVisorPRO/stylesheet/plantVisorFF.css → 200 (45 КБ, те же классы)
```

При этом рядом лежит рабочий `plantVisorFF.css` с теми же селекторами
(`itemPVPRO2`, `itemHeadPVPRO2`, `.bbk`, `.Menu_Head` и т.д.), а соседний
`keyboard.css` из того же каталога отдаётся нормально — то есть каталог и права
в порядке, отсутствует именно `plantVisor.css`.

Почему так — неизвестно: возможно, в этой сборке PlantVisor файла не было
изначально, возможно, его убрали при обновлении. Сервер отдаёт одинаковую
ссылку и для Firefox, и для Chrome (проверено подменой User-Agent), так что
это не браузерная ветка стилей.

Практический итог один: пока сервер не отдаёт `plantVisor.css`, страницы
(карточка устройства, таблицы параметров, «Активные тревоги», вкладки)
рендерятся без оформления — «голым текстом».
Проверено, что 404 не связан с кэшем браузера, User-Agent, заголовками,
версией HTTP или Flash: ответ приходит от самого приложения при любых запросах
(а вот TLS-версия важна для другого — см. следующий раздел).

## Почему FlashBrowser, а не обычный браузер

Сервер PlantVisorPRO — это старый Carel-прибор (Apache-Coyote/Tomcat 6.0.14),
и с точки зрения современного браузера он «небезопасен» дважды:

1. **Он умеет только TLS 1.0.** Проверено 2026-11-23:
   `curl` договаривается до `TLSv1 / AES128-SHA`, на TLS 1.2 сервер отвечает
   отказом, на TLS 1.3 — `alert handshake failure (40)`. Плюс сервер требует
   legacy renegotiation, которую OpenSSL 3 по умолчанию не разрешает.
2. **Сертификат самоподписанный** (`CN=Carel`, выпущен 2006, истекает 2056),
   выдан на себя же.

Что с этим делают обычные браузеры:

- **Firefox** с версии 78 отключает TLS 1.0/1.1 по умолчанию, а с 97 убрал
  возможность включить их из страницы ошибки. Чтобы зайти, нужно лезть в
  `about:config` и ставить `security.tls.version.min = 1`, плюс отдельно
  подтверждать исключение для самоподписанного сертификата.
- **Chrome** с версии 84 поддержку TLS 1.0/1.1 удалил и показывает
  предупреждение-заглушку вместо страницы.
- Заодно современные браузеры не поддерживают Flash, без которого карта и
  графики PlantVisor не работают.

**FlashBrowser** — это Electron 9, он же Chromium 83. В нём ещё:
- поддержан TLS 1.0 (удалён только в Chromium 84);
- плагин Flash (PepperFlash) идёт в комплекте;
- `--ignore-certificate-errors` снимает вопрос самоподписанного сертификата.

Поэтому на этом сервере он работает «из коробки», без правки настроек браузера.
Цена — старый движок, Rosetta на Apple Silicon и отсутствие обновлений
безопасности; это осознанный компромисс ради доступа к прибору.

**Важное следствие:** обновлять Electron выше 9 нельзя — в Chromium 84+ нет
TLS 1.0, и приложение вообще перестанет соединяться с сервером. Это относится
и к варианту «Electron 11» для нативного arm64 (см. `BUILD-M1.md` §6).

## Что делает патч

### 1. `index.js` — подстановка живого стиля

Константы в начале файла:

```js
const PLANTVISOR_ORIGIN     = 'https://192.168.2.26';
const PLANTVISOR_HOME_URL   = `${PLANTVISOR_ORIGIN}/PlantVisorPRO/`;
const PLANTVISOR_WORKING_CSS = `${PLANTVISOR_ORIGIN}/PlantVisorPRO/stylesheet/plantVisorFF.css`;
```

Обработчик `app.on('web-contents-created', ...)` ловит создание `<webview>`
и на события `did-finish-load`, `did-frame-finish-load`, `did-stop-loading`
выполняет в странице скрипт, который рекурсивно обходит все фреймы и добавляет
в каждый `<link rel="stylesheet" href=".../plantVisorFF.css" data-pvff="1">`.

Детали реализации:

- работает только на хосте PlantVisor (`location.origin`), чужие сайты не трогает;
- метка `data-pvff` не даёт вставить стиль дважды (события загрузки срабатывают несколько раз);
- обход рекурсивный, потому что PlantVisor — это frameset из ~10 вложенных фреймов;
- проверка `contents.getType() === 'webview'` отсекает саму оболочку браузера.

Почему не `webRequest.onBeforeRequest` с редиректом: в этой сборке Electron
`<webview>` работает в собственной сессии, и перехватчик, повешенный на сессию
главного окна, не видит его запросов (проверено — обработчик не вызывался).
`executeJavaScript` в контексте webview работает стабильно.

### 2. `index.js` + `browser.html` — домашняя страница

- `defaults.homepage = PLANTVISOR_HOME_URL` — для нового профиля;
- фолбэк в `browser.html` (ветка `else` после проверки `home`) — для профиля,
  созданного старой версией, где ключа `homepage` ещё нет.

Адрес — со завершающим слэшем: `/PlantVisorPRO/`, иначе сервер отдаёт лишний 302.

## Как запустить (проверено 2026-11-23)

Сборка .app под Apple Silicon — отдельная инструкция: [BUILD-M1.md](BUILD-M1.md).

Electron 9 не имеет сборки под arm64 macOS, поэтому ставим x64-бинарь — приложение
работает через Rosetta.

```bash
npm ci --legacy-peer-deps --arch=x64
```

`--legacy-peer-deps` нужен из-за конфликта: `@cliqz/adblocker-electron` требует
`electron > 11`, а в проекте `9.4.4`. `--arch=x64` — иначе установщик пытается
скачать несуществующий `electron-v9.4.4-darwin-arm64.zip`.

Если npm блокирует install-скрипты (сообщение `install-scripts ... not yet covered
by allowScripts`), бинарь Electron не встанет — докачиваем вручную:

```bash
cd node_modules/electron
npm_config_arch=x64 node install.js          # качает zip в ~/Library/Caches/electron
ZIP=$(find ~/Library/Caches/electron -name "electron-v9.4.4-darwin-x64.zip" | head -1)
rm -rf dist && mkdir dist && ditto -x -k "$ZIP" dist   # ditto сохраняет симлинки
printf 'Electron.app/Contents/MacOS/Electron' > path.txt  # без \n на конце!
```

`path.txt` — это путь к бинарю относительно `dist/`, а не архитектура. Если там
окажется `x64` или строка с переводом строки, Electron упадёт с
`spawn .../dist/x64 ENOENT`.

Запуск:

```bash
./node_modules/.bin/electron . --remote-debugging-port=9222
```

Флаг `--remote-debugging-port` не обязателен, но с ним можно смотреть страницу
через CDP (`http://127.0.0.1:9222/json/list`) — я так проверял, что стиль
подставился во все фреймы (`link[data-pvff]`).

## Когда патч можно удалить

Если сервер начнёт отдавать `stylesheet/plantVisor.css` (или ссылки в JSP
поправят на существующий файл), обходной путь можно удалить:

1. константы `PLANTVISOR_*` и блок `app.on('web-contents-created', ...)` в `index.js`;
2. `homepage` из `defaults` (если домашняя страница больше не нужна);
3. фолбэк-URL в `browser.html` (вернуть `https://search.flash.pm/`).
