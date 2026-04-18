# Подключение YouTube как направления (destination)

Позволяет автоматически загружать видео из Telegram на YouTube-канал.
Вертикальные видео длиной ≤ 60 секунд публикуются как **YouTube Shorts** автоматически.

> Только видео пересылается. Текстовые сообщения и фото без видео пропускаются.

---

## Требования

- YouTube-канал, привязанный к Google-аккаунту
- Google Cloud Project с включённым **YouTube Data API v3**
- OAuth 2.0 Credentials (Client ID + Client Secret)
- Refresh Token (одноразовая авторизация)

---

## Шаг 1 — Google Cloud Project и API

1. Открой [console.cloud.google.com](https://console.cloud.google.com) → **Create Project**.
2. Перейди в **APIs & Services → Library**, найди **YouTube Data API v3** → **Enable**.
3. Перейди в **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
4. Тип приложения: **Desktop app** (или Web app).
5. Скопируй **Client ID** и **Client Secret**.

---

## Шаг 2 — Получить Refresh Token (одноразово)

Самый простой способ — через OAuth Playground:

1. Открой [OAuth Playground](https://developers.google.com/oauthplayground/).
2. Нажми шестерёнку (⚙) справа → включи **Use your own OAuth credentials** → введи Client ID и Client Secret.
3. В левом списке найди **YouTube Data API v3** → выбери:
   - `https://www.googleapis.com/auth/youtube.upload`
4. Нажми **Authorize APIs** → войди в Google-аккаунт → разреши доступ.
5. Нажми **Exchange authorization code for tokens** → скопируй **Refresh token**.

Refresh Token не истекает (если не отозвать вручную).

---

## Шаг 3 — Настроить .env

```dotenv
YOUTUBE_CLIENT_ID=123456789-xxxxxxxx.apps.googleusercontent.com
YOUTUBE_CLIENT_SECRET=GOCSPX-xxxxxx
YOUTUBE_REFRESH_TOKEN=1//0gxxxxxxxxxxxxxxxx
```

---

## Шаг 4 — Добавить маршрут в routes.json

```jsonc
{
  "id": "tg_to_youtube",
  "enabled": true,
  "source": {
    "network": "telegram",
    "chat_id": -1001234567890
  },
  "destinations": [
    {
      "network": "youtube",
      "client_id_env": "YOUTUBE_CLIENT_ID",
      "client_secret_env": "YOUTUBE_CLIENT_SECRET",
      "refresh_token_env": "YOUTUBE_REFRESH_TOKEN",
      "privacy_status": "public",
      "category_id": 22,
      "shorts_max_duration_s": 60,
      "shorts_for_vertical": true
    }
  ]
}
```

Если все три env-переменные называются стандартно (`YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`), поля `client_id_env`, `client_secret_env`, `refresh_token_env` можно опустить.

### Параметры

| Параметр | Тип | По умолчанию | Описание |
|---|---|---|---|
| `privacy_status` | string | `"public"` | `"public"` / `"unlisted"` / `"private"` |
| `category_id` | number | `22` | [YouTube category ID](https://developers.google.com/youtube/v3/docs/videoCategories/list) (22 = People & Blogs) |
| `shorts_max_duration_s` | number | `60` | Максимальная длительность видео для Shorts (секунды) |
| `shorts_for_vertical` | boolean | `true` | Публиковать как Shorts только вертикальные видео (height > width) |
| `client_id_env` | string | `"YOUTUBE_CLIENT_ID"` | Имя env-переменной с Client ID |
| `client_secret_env` | string | `"YOUTUBE_CLIENT_SECRET"` | Имя env-переменной с Client Secret |
| `refresh_token_env` | string | `"YOUTUBE_REFRESH_TOKEN"` | Имя env-переменной с Refresh Token |

---

## Логика Shorts

Видео автоматически публикуется как YouTube Shorts если выполняются оба условия:
1. Длительность ≤ `shorts_max_duration_s` (по умолчанию 60 сек)
2. Видео вертикальное: `height > width` (при `shorts_for_vertical: true`)

При определении как Shorts:
- К заголовку добавляется `#Shorts`
- Описание начинается с `#Shorts`

YouTube автоматически помещает такие видео в раздел Shorts.

---

## Что пересылается

| Тип сообщения | Результат на YouTube |
|---|---|
| Видео + текст | Загружается видео, текст — заголовок + описание |
| GIF/анимация | Загружается как видео |
| Только текст | Пропускается |
| Фото, аудио, файлы | Пропускается |

Заголовок = первая строка текста сообщения (макс. 100 символов, обрезка по слову).
Описание = полный текст (макс. 5000 символов, обрезка по предложению → переносу → пробелу).

---

## Ограничения

- Telegram Bot API ограничивает скачивание файлов до **20 МБ**. Видео > 20 МБ можно скачать через MTProto (см. README → Large video support).
- YouTube API имеет квоту **10,000 единиц/день**. Загрузка одного видео стоит 1600 единиц (~6 видео в день на один project). Для большего трафика запроси повышение квоты.

---

## Проверка

```bash
# Получить список каналов (проверить токен)
curl "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&access_token=ACCESS_TOKEN"
```

Access Token можно получить разово через OAuth Playground (шаг 2).
