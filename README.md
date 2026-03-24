# Cherkizovo Design Service

Сервис генерации макетов для соцсетей на основе Figma-шаблонов. Пользователь выбирает шаблон, заполняет текстовые поля, загружает фото или берёт его из фотобанка, при необходимости обрезает изображение и получает готовый PNG для скачивания. Отдельно есть административный контур для ручной синхронизации шаблонов из Figma в хранилище.

## Кратко о сервисе

Сервис объединяет frontend, API и рендеринг в одном приложении на Next.js. Рабочий сценарий разделён на две части:

- публичная часть: выбор шаблона, редактирование, генерация и скачивание результата;
- административная часть: загрузка актуальных snapshot-данных шаблонов из Figma в Backblaze B2.

Ключевая особенность текущей реализации: пользовательские страницы работают не напрямую с Figma, а в основном с уже сохранёнными snapshot-файлами и ассетами в B2. Это снижает зависимость публичного интерфейса от live-запросов к Figma.

## Основные возможности

- выбор шаблона на главной странице;
- загрузка списка шаблонов и signed preview URL из B2;
- открытие страницы конкретного шаблона по маршруту `/t/[id]`;
- подстановка текстовых полей, rich text и регулировка размера текста;
- загрузка локального изображения;
- выбор изображения из фотобанка;
- обрезка изображения перед генерацией;
- серверная проверка ограничений по длине текста перед генерацией;
- генерация итогового PNG сервером;
- получение signed URL на готовый результат и скачивание;
- административная синхронизация snapshot-данных из Figma;
- просмотр статуса синка и очистка runtime-кэша через admin API.

## Пользовательский сценарий

1. Пользователь открывает главную страницу `/`.
2. Приложение загружает список доступных шаблонов через `GET /api/templates`.
3. Пользователь выбирает карточку шаблона и переходит на `/t/<templateId>`.
4. Страница редактора загружает схему полей через `GET /api/templates/[id]/schema`.
5. Пользователь заполняет текстовые поля, для фото либо загружает локальный файл, либо открывает фотобанк.
6. При необходимости пользователь открывает режим crop и подтверждает обрезку.
7. Перед финальной генерацией редактор делает проверку через `POST /api/generate?validate=1`.
8. После успешной проверки редактор отправляет multipart-запрос на `POST /api/generate`.
9. Сервер формирует PNG, сохраняет его в B2 и возвращает `signedGetUrl`.
10. Пользователь видит результат в правом блоке превью и скачивает готовый файл.

## Стек технологий

- Next.js 15 App Router
- React 19
- TypeScript
- CSS через глобальные стили в [`app/globals.css`](/C:/Файлы%20с%20ноута/Университет/Диплом/Разработка%20сервиса/cherkizovo-design-service/cherkizovo-design-service/app/globals.css)
- `sharp` для серверной обработки изображений
- `react-easy-crop` для UI обрезки фото
- `opentype.js` для измерения текста и построения SVG-path текста при рендере
- AWS SDK S3 client для работы с S3-совместимым хранилищем Backblaze B2
- Figma REST API для admin sync и части служебных маршрутов
- Yandex Disk public API для фотобанка
- `next/font/local` и локальные файлы Gotham Pro из `assets/fonts/gothampro`

## Структура проекта

Ниже только те директории и файлы, которые реально важны для входа в проект.

- [`app/page.tsx`](/C:/Файлы%20с%20ноута/Университет/Диплом/Разработка%20сервиса/cherkizovo-design-service/cherkizovo-design-service/app/page.tsx)  
  Главная страница выбора шаблона.

- [`app/t/[id]/page.tsx`](/C:/Файлы%20с%20ноута/Университет/Диплом/Разработка%20сервиса/cherkizovo-design-service/cherkizovo-design-service/app/t/[id]/page.tsx)  
  Страница редактора шаблона: текст, фото, фотобанк, crop, превью, generate, download.

- [`app/admin/sync/page.tsx`](/C:/Файлы%20с%20ноута/Университет/Диплом/Разработка%20сервиса/cherkizovo-design-service/cherkizovo-design-service/app/admin/sync/page.tsx)  
  Админ-страница синхронизации. Открывается только с корректным `token` в query string.

- [`app/admin/sync/sync-client.tsx`](/C:/Файлы%20с%20ноута/Университет/Диплом/Разработка%20сервиса/cherkizovo-design-service/cherkizovo-design-service/app/admin/sync/sync-client.tsx)  
  UI для запуска полного sync, dry run, partial sync и просмотра статуса.

- [`app/api/templates/route.ts`](/C:/Файлы%20с%20ноута/Университет/Диплом/Разработка%20сервиса/cherkizovo-design-service/cherkizovo-design-service/app/api/templates/route.ts)  
  Возвращает список шаблонов из snapshot-данных и подписывает preview URL.

- [`app/api/templates/[id]/schema/route.ts`](/C:/Файлы%20с%20ноута/Университет/Диплом/Разработка%20сервиса/cherkizovo-design-service/cherkizovo-design-service/app/api/templates/[id]/schema/route.ts)  
  Возвращает поля шаблона, размеры frame, photo-поля и текстовые defaults.

- [`app/api/generate/route.ts`](/C:/Файлы%20с%20ноута/Университет/Диплом/Разработка%20сервиса/cherkizovo-design-service/cherkizovo-design-service/app/api/generate/route.ts)  
  Главный маршрут генерации. Валидирует текст, готовит фото, запускает рендер и сохраняет результат.

- [`app/api/photobank/*`](/C:/Файлы%20с%20ноута/Университет/Диплом/Разработка%20сервиса/cherkizovo-design-service/cherkizovo-design-service/app/api/photobank)  
  Маршруты фотобанка: browse, preview proxy, resolve download href.

- [`app/api/admin/*`](/C:/Файлы%20с%20ноута/Университет/Диплом/Разработка%20сервиса/cherkizovo-design-service/cherkizovo-design-service/app/api/admin)  
  Admin API: sync, status, cache.

- [`lib/env.ts`](/C:/Файлы%20с%20ноута/Университет/Диплом/Разработка%20сервиса/cherkizovo-design-service/cherkizovo-design-service/lib/env.ts)  
  Центральная точка чтения env-переменных и дефолтов.

- [`lib/s3.ts`](/C:/Файлы%20с%20ноута/Университет/Диплом/Разработка%20сервиса/cherkizovo-design-service/cherkizovo-design-service/lib/s3.ts)  
  Работа с B2 через S3 API, signed URL и in-memory кэш.

- [`lib/snapshotStore.ts`](/C:/Файлы%20с%20ноута/Университет/Диплом/Разработка%20сервиса/cherkizovo-design-service/cherkizovo-design-service/lib/snapshotStore.ts)  
  Ключи и чтение snapshot-файлов: templates, frames, schemas.

- [`lib/universalEngine.ts`](/C:/Файлы%20с%20ноута/Университет/Диплом/Разработка%20сервиса/cherkizovo-design-service/cherkizovo-design-service/lib/universalEngine.ts)  
  Основной серверный движок рендеринга по snapshot-дереву Figma.

- [`lib/schemaExtractor.ts`](/C:/Файлы%20с%20ноута/Университет/Диплом/Разработка%20сервиса/cherkizovo-design-service/cherkizovo-design-service/lib/schemaExtractor.ts)  
  Извлекает из frame поля вида `text*` и `photo*`.

- [`lib/photobank.ts`](/C:/Файлы%20с%20ноута/Университет/Диплом/Разработка%20сервиса/cherkizovo-design-service/cherkizovo-design-service/lib/photobank.ts)  
  Интеграция с публичным Yandex Disk.

- [`assets/fonts/gothampro`](/C:/Файлы%20с%20ноута/Университет/Диплом/Разработка%20сервиса/cherkizovo-design-service/cherkizovo-design-service/assets/fonts/gothampro)  
  Локальные шрифты Gotham Pro, используемые и в UI, и в серверном рендере.

- [`assets/icons`](/C:/Файлы%20с%20ноута/Университет/Диплом/Разработка%20сервиса/cherkizovo-design-service/cherkizovo-design-service/assets/icons)  
  SVG-иконки сервиса.

- [`assets/screens`](/C:/Файлы%20с%20ноута/Университет/Диплом/Разработка%20сервиса/cherkizovo-design-service/cherkizovo-design-service/assets/screens)  
  PNG-макеты экранов и состояний.

## Установка и локальный запуск

В `package.json` есть `pnpm`-специфичная секция, поэтому примеры ниже даны для `pnpm`.

1. Установить зависимости:

```bash
pnpm install
```

2. Создать `.env.local` на основе `.env.example`.

3. Заполнить как минимум обязательные переменные окружения.

4. Запустить dev-сервер:

```bash
pnpm dev
```

5. Открыть приложение в браузере, обычно это `http://localhost:3000`.

Для production-проверки:

```bash
pnpm build
pnpm start
```

Для линтинга:

```bash
pnpm lint
```

## Переменные окружения

Ниже перечислены переменные, которые реально читаются кодом.

### Обязательные для работы со storage

Без этих переменных не будут работать шаблоны, генерация и чтение snapshot-данных из B2.

| Переменная | Обязательность | Назначение |
| --- | --- | --- |
| `B2_BUCKET_NAME` | обязательно | Имя bucket в Backblaze B2 |
| `B2_S3_REGION` | обязательно | Регион S3-совместимого endpoint |
| `B2_S3_ENDPOINT` | обязательно | URL S3 endpoint для B2 |
| `B2_ACCESS_KEY_ID` | обязательно | Access key для B2 |
| `B2_SECRET_ACCESS_KEY` | обязательно | Secret key для B2 |

### Figma и snapshots

| Переменная | Обязательность | Назначение |
| --- | --- | --- |
| `FIGMA_FILE_KEY` | обязательно для списка шаблонов, схем, admin sync и генерации | Ключ Figma-файла, по которому строятся snapshots |
| `FIGMA_TOKEN` | обязателен для admin sync и прямых обращений к Figma | Токен доступа к Figma API |
| `USE_FIGMA_RENDER` | опционально | Включает legacy-ветку figma render для старого режима |
| `USE_UNIVERSAL_ENGINE` | опционально | Флаг universal engine; в текущем `POST /api/generate` universal engine фактически используется и по умолчанию, если переменная не задана |
| `FIGMA_TEMPLATES_TTL_SEC` | опционально, default `1800` | TTL кэша списка шаблонов |
| `FIGMA_SCHEMA_TTL_SEC` | опционально, default `7200` | TTL кэша схемы шаблона |
| `FIGMA_FILE_TTL_SEC` | опционально, default `1800` | Читается из env, используется как конфигурационный TTL |
| `FIGMA_CACHE_TTL_SEC` | опционально, default `900` | TTL Figma-related memory cache |
| `FIGMA_PREVIEW_SCALE` | опционально, default `0.25` | Параметр preview scale в env |
| `DEBUG_RENDER` | опционально | Включает debug payload рендера |

### Кэш и лимиты

| Переменная | Обязательность | Назначение |
| --- | --- | --- |
| `CACHE_ENABLED` | опционально, default `1` | Включает in-memory кэш JSON и бинарных объектов |
| `CACHE_JSON_TTL_SEC` | опционально, default `600` | TTL JSON-кэша |
| `CACHE_ASSET_TTL_SEC` | опционально, default `3600` | TTL buffer-кэша |
| `CACHE_JSON_MAX_ITEMS` | опционально, default `500` | Лимит JSON-элементов в кэше |
| `CACHE_ASSET_MAX_BYTES` | опционально, default `268435456` | Лимит суммарного размера asset-кэша |
| `CACHE_ASSET_MAX_ITEMS` | опционально, default `200` | Лимит asset-элементов |
| `CACHE_DEBUG` | опционально, default `0` | Включает debug для cache layer |
| `MAX_UPLOAD_MB` | опционально, default `10` | Лимит для `POST /api/upload` |
| `SIGNED_URL_EXPIRES_SEC` | опционально, default `900` | Время жизни signed GET URL |

### Администрирование

| Переменная | Обязательность | Назначение |
| --- | --- | --- |
| `ADMIN_SYNC_SECRET` | нужен для server-to-server admin API и cache API | Секрет для заголовка `x-admin-secret` |
| `ADMIN_UI_TOKEN` | нужен для страницы `/admin/sync` и admin API через query | Токен для доступа к admin UI и API через `?token=` |

### Фотобанк

| Переменная | Обязательность | Назначение |
| --- | --- | --- |
| `YADISK_PUBLIC_KEY` | обязательна для фотобанка | Публичная ссылка Yandex Disk, из которой читаются каталоги и изображения |

## Как работает генерация

Текущая генерация завязана на snapshot-данные в B2.

1. `POST /api/generate?validate=1` выполняет предварительную проверку текста.
2. `POST /api/generate` принимает:
   - `templateId`;
   - `fields`;
   - `textSizeAdjust`;
   - `richText`;
   - локальные файлы фото;
   - `photoRefs` для фотобанка;
   - `photoEdits` с координатами crop.
3. Сервер поднимает snapshot frame по ключу `snapshots/<FIGMA_FILE_KEY>/frames/...json`.
4. Для фото сервер:
   - либо берёт локальный файл из multipart;
   - либо скачивает изображение из фотобанка через Yandex Disk;
   - затем при необходимости применяет crop через `sharp`;
   - загружает подготовленное изображение в B2 в `uploads/<uuid>.<ext>`.
5. `renderUniversalTemplate()` из [`lib/universalEngine.ts`](/C:/Файлы%20с%20ноута/Университет/Диплом/Разработка%20сервиса/cherkizovo-design-service/cherkizovo-design-service/lib/universalEngine.ts) собирает итоговый PNG по snapshot-дереву, текстовым стилям, шрифтам Gotham Pro и ассетам.
6. Готовый PNG сохраняется в B2 в `renders/<uuid>.png`.
7. Ответ API возвращает `resultKey` и `signedGetUrl`.

Что важно:

- публичная генерация не зависит от live-запроса к Figma, если snapshots уже актуальны;
- ограничения по числу строк проверяются сервером;
- текст рендерится не системным HTML, а серверным рендером по данным snapshot и шрифтам;
- если отсутствуют snapshot-данные, генерация вернёт ошибку и попросит запустить admin sync.

## Страница администратора

### Маршрут и доступ

Админ-страница существует по маршруту:

```text
/admin/sync?token=<ADMIN_UI_TOKEN>
```

Проверка делается в [`app/admin/sync/page.tsx`](/C:/Файлы%20с%20ноута/Университет/Диплом/Разработка%20сервиса/cherkizovo-design-service/cherkizovo-design-service/app/admin/sync/page.tsx). Если `token` отсутствует или не совпадает с `ADMIN_UI_TOKEN`, страница отдаёт `404` через `notFound()`.

### Что умеет admin page

UI из [`app/admin/sync/sync-client.tsx`](/C:/Файлы%20с%20ноута/Университет/Диплом/Разработка%20сервиса/cherkizovo-design-service/cherkizovo-design-service/app/admin/sync/sync-client.tsx) умеет:

- запускать полный sync;
- запускать dry run без записи данных;
- запускать partial sync по `templateId`;
- вручную обновлять статус;
- автоматически опрашивать статус:
  - раз в 3 секунды во время работы sync;
  - раз в 60 секунд в остальное время;
  - сразу после возврата вкладки в фокус.

### Какие API использует админка

- `POST /api/admin/sync`
- `GET /api/admin/status`
- `GET /api/admin/cache`
- `POST /api/admin/cache`

### Авторизация admin API

`/api/admin/sync` и `/api/admin/status` принимают любой из двух вариантов:

- query-параметр `token`, совпадающий с `ADMIN_UI_TOKEN`;
- header `x-admin-secret`, совпадающий с `ADMIN_SYNC_SECRET`.

`/api/admin/cache` принимает только `x-admin-secret`.

### Что делает sync

`POST /api/admin/sync` в [`app/api/admin/sync/route.ts`](/C:/Файлы%20с%20ноута/Университет/Диплом/Разработка%20сервиса/cherkizovo-design-service/cherkizovo-design-service/app/api/admin/sync/route.ts):

- загружает Figma file по `FIGMA_FILE_KEY`;
- находит видимые `FRAME`, чьи имена начинаются с `TPL`;
- формирует список шаблонов;
- сохраняет snapshot списка шаблонов;
- пакетно запрашивает ноды frame;
- извлекает schema-поля по именам `text*` и `photo*`;
- экспортирует PNG-ассеты для видимых нод с именами:
  - `logo`
  - `logo_bg`
  - `sticker`
  - `marks`
- сохраняет:
  - templates snapshot,
  - frame snapshots,
  - schema snapshots,
  - exported asset PNG.

После успешного реального sync runtime-кэши очищаются автоматически.

### Ограничения и риски

- Параллельный sync блокируется lock-файлом на 15 минут.
- Dry run ничего не записывает.
- Partial sync пишет только выбранный шаблон и обновляет список шаблонов частично.
- Неправильный `FIGMA_FILE_KEY` или отсутствие доступа у `FIGMA_TOKEN` сломают sync.
- Токен admin UI передаётся в URL, поэтому им нельзя делиться без необходимости.
- `/api/admin/status` специально защищён от любых обращений к Figma через `runWithFigmaAccessBlocked()`. Он должен читать только сохранённое состояние sync.

## Работа с шаблонами

Источник шаблонов в админ-контуре: Figma file, указанный в `FIGMA_FILE_KEY`.

Что важно знать:

- шаблоном считается видимый `FRAME`, имя которого начинается с `TPL`;
- список шаблонов, схемы и frame-снимки после sync хранятся в B2 в `snapshots/<FIGMA_FILE_KEY>/...`;
- пользовательские маршруты `/api/templates` и `/api/templates/[id]/schema` читают именно snapshots из B2;
- поля формы строятся по именам нод:
  - `text*` -> текстовые поля;
  - `photo*` -> фото-поля;
- изменение имён этих нод в Figma меняет схему редактора;
- после изменений Figma нужно заново запускать admin sync.

Дополнительно:

- при runtime для manual assets есть fallback-поиск объектов в B2:
  - `assets/manual-assets/<safeFrameId>__sticker.png`
  - `assets/manual-assets/<safeFrameId>__marks.png`
  - fallback: `assets/manual-assets/<safeFrameId>.png`
- это актуально для нод `sticker` и `marks`.

## Работа с изображениями и фотобанком

### Локальные изображения

- UI редактора принимает `image/jpeg`, `image/png`, `image/webp`.
- В `POST /api/generate` multipart-путь использует жёсткий лимит `30MB` на файл.
- Отдельный `POST /api/upload` тоже существует и использует лимит `MAX_UPLOAD_MB`, но основной текущий editor flow отправляет фото напрямую в `POST /api/generate`.

### Фотобанк

Фотобанк реализован через публичный Yandex Disk:

- `GET /api/photobank/browse`
- `GET /api/photobank/preview`
- `POST /api/photobank/resolve`

Как это работает:

- каталог и файлы читаются из `YADISK_PUBLIC_KEY`;
- пользователю показывается список папок и изображений;
- превью отдаются через proxy-маршрут `/api/photobank/preview`;
- для генерации сервер сам получает прямой download href и скачивает исходник.

### Обрезка

- На клиенте используется `react-easy-crop`.
- В state хранится нормализованная область crop.
- На сервере `sharp` применяет crop и при необходимости подгоняет фото под размеры целевого photo-поля шаблона.

## Типичные проблемы и диагностика

### Не загружается список шаблонов

Проверьте:

- заполнен ли `FIGMA_FILE_KEY`;
- доступны ли B2 credentials;
- существует ли snapshot `templates.json` в B2;
- запускался ли `POST /api/admin/sync`;
- ответ `GET /api/templates?debug=1`;
- если шаблоны есть, но карточки пустые, возможно отсутствуют preview-объекты в B2.

### Не открывается страница шаблона

Проверьте:

- есть ли schema snapshot для нужного `templateId`;
- что возвращает `GET /api/templates/<id>/schema`;
- что `templateId` существует в snapshots после последнего sync.

### Не работает генерация

Проверьте:

- есть ли frame snapshot для шаблона;
- доступны ли шрифты Gotham Pro в `assets/fonts/gothampro`;
- не превышен ли лимит размера файла;
- подходит ли формат файла: JPEG, PNG, WEBP;
- не возвращает ли validate ошибку `Text too long`;
- не уходит ли crop за границы изображения;
- есть ли права записи в B2 для путей `uploads/` и `renders/`.

### Не работает фотобанк

Проверьте:

- задан ли `YADISK_PUBLIC_KEY`;
- доступна ли сама публичная ссылка Yandex Disk;
- ответы `GET /api/photobank/browse` и `GET /api/photobank/preview`.

### Не открывается admin page

Проверьте:

- задан ли `ADMIN_UI_TOKEN`;
- открыт ли маршрут именно как `/admin/sync?token=...`;
- совпадает ли токен полностью;
- помните, что при неверном токене страница отдаёт `404`, а не `403`.

### Не работает admin sync

Проверьте:

- `FIGMA_TOKEN`;
- `FIGMA_FILE_KEY`;
- есть ли у токена доступ к нужному Figma-файлу;
- не упёрлись ли в rate limit или timeout Figma API;
- не висит ли lock sync в storage;
- ответ `GET /api/admin/status`.

### Подозрение на stale cache

Проверьте:

- `GET /api/admin/cache` с `x-admin-secret`;
- при необходимости очистите кэш через `POST /api/admin/cache`;
- убедитесь, что `CACHE_ENABLED` настроен ожидаемо.

### Проблемы с preview

Важно: `POST /api/previews/sync` сейчас отключён и возвращает `410`. Если превью шаблонов отсутствуют в B2, обычный admin sync их не создаст. В этом случае список шаблонов загрузится, но карточки могут остаться без картинки.

## Проверка после запуска

- Открывается ли `/`.
- Возвращает ли `GET /api/health` статус `ok`.
- Загружается ли список шаблонов на главной странице.
- Открывается ли `/t/<templateId>`.
- Загружается ли схема полей шаблона.
- Работает ли загрузка локального фото.
- Открывается ли фотобанк и можно ли выбрать изображение.
- Работает ли crop.
- Проходит ли generate без ошибки.
- Появляется ли результат и работает ли скачивание.
- Открывается ли `/admin/sync?token=<ADMIN_UI_TOKEN>`.
- Возвращает ли `GET /api/admin/status` корректное состояние.

## Важные замечания для разработчика

- Не меняйте naming editable-нод в Figma без понимания последствий. Поля редактора жёстко завязаны на имена `text*` и `photo*`.
- Не меняйте формат snapshot-ключей и storage paths без миграции. На них завязаны список шаблонов, schema route, generation и admin sync.
- Не предполагайте, что публичный runtime ходит в Figma. Основной пользовательский поток читает snapshots из B2.
- Не ломайте Gotham Pro файлы и пути к ним. Они используются не только в UI, но и внутри серверного рендера.
- Осторожно меняйте `POST /api/generate`: там связаны validation, photobank, crop, rich text, upload и render pipeline.
- `ADMIN_UI_TOKEN` передаётся через URL. Это чувствительный токен, не вставляйте его в публичные ссылки и скриншоты.
- `ADMIN_SYNC_SECRET` нужен для server-to-server admin API и очистки кэша. Не подменяйте его UI-токеном без причины.
- Не рассчитывайте на `/api/previews/sync`: маршрут отключён.

## Полезные маршруты

- `GET /api/health` — простой healthcheck.
- `GET /api/templates` — список шаблонов.
- `GET /api/templates?debug=1` — debug по источнику и превью.
- `GET /api/templates/[id]/schema` — схема редактора.
- `GET /api/templates/[id]/schema?debug=1` — debug schema route.
- `POST /api/generate?validate=1` — предварительная проверка текста.
- `POST /api/generate` — финальная генерация.
- `GET /api/photobank/browse` — просмотр фотобанка.
- `GET /api/photobank/preview` — proxy превью фотобанка.
- `POST /api/admin/sync` — запуск sync.
- `GET /api/admin/status` — состояние sync.
- `GET /api/admin/cache` / `POST /api/admin/cache` — статистика и очистка runtime-кэша.
