# Подключение TikTok как направления (destination)

Позволяет публиковать видео в ленту TikTok и (при наличии доступа) в TikTok Stories.

---

## Требования

- TikTok-аккаунт (Creator или Business)
- Приложение на [developers.tiktok.com](https://developers.tiktok.com) с включённым **Content Posting API**
- Client Key и Client Secret от приложения
- Одноразовая авторизация через `npm run tiktok:auth`

---

## Шаг 1 — Создать TikTok Developer App

1. Зайди на [developers.tiktok.com](https://developers.tiktok.com) → **Manage apps → Create app**.
2. Заполни название, категорию, описание.
3. В разделе **Products** добавь **Login Kit** и **Content Posting API**.
4. В настройках **Login Kit** → **Redirect URI** добавь:
   ```
   http://localhost:8888/tiktok/callback
   ```
5. В разделе **Scopes** запроси доступ к:
   - `video.upload`
   - `video.publish`
6. Сохрани **Client Key** и **Client Secret**.

> TikTok проверяет приложения перед выдачей production-доступа.
> В sandbox-режиме можно тестировать без проверки, но публикации видны только тебе.

---

## Шаг 2 — Настроить .env

```dotenv
TIKTOK_CLIENT_KEY=xxxxxxxxxxxxxxxxxxxxxxxx
TIKTOK_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
```

---

## Шаг 3 — Авторизоваться (одноразово)

```bash
npm run tiktok:auth
```

Скрипт:
1. Выводит ссылку авторизации — открой в браузере
2. Войди в TikTok и разреши доступ
3. Браузер переадресует на `localhost:8888` — скрипт перехватит код автоматически
4. Обменяет код на токены и сохранит в `.tiktok_tokens.json`

После этого токены обновляются автоматически при каждой публикации.
Refresh token истекает через **60 дней** — если бот не публиковал за это время, нужно повторить `npm run tiktok:auth`.

---

## Шаг 4 — Добавить маршрут в routes.json

### Видео в ленту

```jsonc
{
  "id": "tg_to_tiktok_video",
  "enabled": true,
  "source": {
    "network": "telegram",
    "chat_id": -1001234567890
  },
  "destinations": [
    {
      "network": "tiktok",
      "post_type": "video",
      "privacy_level": "PUBLIC_TO_EVERYONE",
      "disable_duet": false,
      "disable_stitch": false,
      "disable_comment": false
    }
  ]
}
```

### Сториз (требует партнёрского доступа TikTok)

```jsonc
{
  "id": "tg_to_tiktok_story",
  "enabled": true,
  "source": {
    "network": "telegram",
    "chat_id": -1001234567890
  },
  "destinations": [
    {
      "network": "tiktok",
      "post_type": "story",
      "privacy_level": "PUBLIC_TO_EVERYONE"
    }
  ]
}
```

### Видео + сториз одновременно

```jsonc
{
  "id": "tg_to_tiktok_all",
  "source": { "network": "telegram", "chat_id": -1001234567890 },
  "destinations": [
    { "network": "tiktok", "post_type": "video", "privacy_level": "PUBLIC_TO_EVERYONE" },
    { "network": "tiktok", "post_type": "story", "privacy_level": "PUBLIC_TO_EVERYONE" }
  ]
}
```

---

## Параметры

| Параметр | Тип | По умолчанию | Описание |
|---|---|---|---|
| `post_type` | string | `"video"` | `"video"` (лента) или `"story"` (сториз) |
| `privacy_level` | string | `"PUBLIC_TO_EVERYONE"` | `"PUBLIC_TO_EVERYONE"` / `"MUTUAL_FOLLOW_FRIENDS"` / `"SELF_ONLY"` |
| `disable_duet` | boolean | `false` | Запретить Duet |
| `disable_stitch` | boolean | `false` | Запретить Stitch |
| `disable_comment` | boolean | `false` | Запретить комментарии |
| `client_key_env` | string | `"TIKTOK_CLIENT_KEY"` | Имя env-переменной с Client Key |
| `client_secret_env` | string | `"TIKTOK_CLIENT_SECRET"` | Имя env-переменной с Client Secret |
| `refresh_token_env` | string | `"TIKTOK_REFRESH_TOKEN"` | Fallback env-переменная (если нет `.tiktok_tokens.json`) |

---

## Что пересылается

| Тип сообщения | `post_type: "video"` | `post_type: "story"` |
|---|---|---|
| Видео + текст | Публикация в ленту | Видео-сториз |
| GIF/анимация | Публикация в ленту | Видео-сториз |
| Фото + текст | Пропускается | Фото-сториз |
| Только текст | Пропускается | Пропускается |

Заголовок = текст сообщения, обрезается до 150 символов по слову/предложению.

---

## Ограничения

- Telegram Bot API: максимальный размер файла — **20 МБ** (для больших видео используй MTProto).
- TikTok PULL_FROM_URL требует публично доступной ссылки — Telegram Bot API file URL соответствует этому требованию.
- **Stories API** доступен только партнёрам TikTok (требует отдельной заявки). При отсутствии доступа публикация story вернёт ошибку `403`.
- Refresh token истекает через 60 дней без использования. Бот автоматически обновляет его при каждой публикации и сохраняет в `.tiktok_tokens.json`.
- TikTok проверяет контент после загрузки — публикация может занять до 2 минут (бот ждёт подтверждения `PUBLISH_COMPLETE`).

---

## Проверка подключения

После `npm run tiktok:auth` проверь `.tiktok_tokens.json`:
```bash
cat .tiktok_tokens.json
```

Должен содержать `access_token`, `refresh_token`, `scope`.
