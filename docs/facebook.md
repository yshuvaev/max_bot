# Подключение Facebook как направления (destination)

Позволяет пересылать сообщения из Telegram (или MAX) на Facebook-страницу.

---

## Требования

- Facebook-страница (Page), не личный профиль
- Facebook-приложение (app) на [developers.facebook.com](https://developers.facebook.com)
- Page Access Token с правами `pages_manage_posts`

---

## Шаг 1 — Создать Facebook App

1. Зайди на [developers.facebook.com/apps](https://developers.facebook.com/apps) → **Create App**.
2. Выбери тип **Business** (или **Other → Business**).
3. После создания перейди в **Add Products** и добавь **Facebook Login** и **Pages API**.

---

## Шаг 2 — Получить Page Access Token

### Быстро (для теста — токен истекает через ~2 часа)

1. Открой [Graph API Explorer](https://developers.facebook.com/tools/explorer/).
2. Выбери своё приложение в выпадающем меню сверху.
3. Нажми **Generate Access Token** и выдай права `pages_manage_posts`, `pages_read_engagement`.
4. Кликни **Get Token → Get Page Access Token** и выбери нужную страницу.
5. Скопируй токен.

### Постоянный токен (для продакшна)

Используй долгоживущий User Token, обменяй его на Page Token:

```bash
# 1. Получить долгоживущий user token (через Graph API Explorer или OAuth)
# 2. Обменять user token на page token:
curl "https://graph.facebook.com/v21.0/me/accounts?access_token=USER_TOKEN"
# В ответе найди нужную страницу → поле access_token — это постоянный Page Access Token
```

Подробнее: [документация Meta](https://developers.facebook.com/docs/pages/access-tokens).

---

## Шаг 3 — Узнать Page ID

Способ 1 — через Graph API:
```bash
curl "https://graph.facebook.com/v21.0/me/accounts?access_token=PAGE_ACCESS_TOKEN"
# Поле "id" рядом с названием страницы
```

Способ 2 — открой Facebook-страницу → About → Page transparency → Page ID (числовой).

---

## Шаг 4 — Настроить .env

```dotenv
FB_PAGE_ACCESS_TOKEN=ваш_токен_здесь
```

---

## Шаг 5 — Добавить маршрут в routes.json

```jsonc
{
  "routes": [
    {
      "id": "tg_to_facebook",
      "enabled": true,
      "source": {
        "network": "telegram",
        "chat_id": -1001234567890
      },
      "destinations": [
        {
          "network": "facebook",
          "page_id": "123456789012345",
          "access_token_env": "FB_PAGE_ACCESS_TOKEN"
        }
      ],
      "options": {
        "include_telegram_footer": true
      }
    }
  ]
}
```

Вместо `access_token_env` можно указать токен напрямую через `access_token` (менее безопасно):
```jsonc
{ "network": "facebook", "page_id": "...", "access_token": "EAAxxxxxx..." }
```

---

## Что пересылается

| Тип сообщения | Результат в Facebook |
|---|---|
| Текст | Пост в ленте страницы |
| Фото + текст | Публикация фото с подписью |
| Видео, аудио, файлы | Только текст (медиа не пересылается) |

Markdown-форматирование (жирный, ссылки и т.д.) автоматически конвертируется в plain text.

---

## Проверка

```bash
curl -X POST "https://graph.facebook.com/v21.0/PAGE_ID/feed" \
  -d "message=Тест&access_token=PAGE_ACCESS_TOKEN"
```

Если вернулся `{"id":"..."}` — токен и Page ID рабочие.
