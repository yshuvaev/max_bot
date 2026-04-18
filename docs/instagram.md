# Подключение Instagram как направления (destination)

Позволяет пересылать фото и видео из Telegram на Instagram Business/Creator аккаунт.

> **Важно:** Instagram Graph API не поддерживает публикацию текстовых постов без медиа.
> Сообщения без фото или видео будут пропущены (бридж залогирует предупреждение).

---

## Требования

- Instagram **Business** или **Creator** аккаунт
- Facebook-страница, привязанная к Instagram-аккаунту
- Facebook App с продуктом **Instagram Graph API**
- Page Access Token с правами `instagram_basic`, `instagram_content_publish`

---

## Шаг 1 — Привязать Instagram к Facebook-странице

1. Открой настройки своей Facebook-страницы → **Linked accounts** → **Instagram**.
2. Войди в Instagram-аккаунт и подтверди привязку.

---

## Шаг 2 — Создать Facebook App и получить токен

Следуй шагам 1–2 из [facebook.md](./facebook.md), но при запросе прав добавь:
- `instagram_basic`
- `instagram_content_publish`
- `pages_manage_posts`
- `pages_read_engagement`

Тот же токен работает и для Facebook, и для Instagram — можно использовать одну переменную `FB_PAGE_ACCESS_TOKEN`.

---

## Шаг 3 — Узнать Instagram User ID

```bash
# PAGE_ID — числовой ID Facebook-страницы (не Instagram)
curl "https://graph.facebook.com/v21.0/PAGE_ID?fields=instagram_business_account&access_token=PAGE_ACCESS_TOKEN"
```

Ответ:
```json
{
  "instagram_business_account": { "id": "17841234567890123" },
  "id": "123456789012345"
}
```

`instagram_business_account.id` — это `ig_user_id` для маршрута.

---

## Шаг 4 — Настроить .env

```dotenv
FB_PAGE_ACCESS_TOKEN=ваш_токен_здесь
```

(Тот же токен, что и для Facebook.)

---

## Шаг 5 — Добавить маршрут в routes.json

```jsonc
{
  "routes": [
    {
      "id": "tg_to_instagram",
      "enabled": true,
      "source": {
        "network": "telegram",
        "chat_id": -1001234567890
      },
      "destinations": [
        {
          "network": "instagram",
          "ig_user_id": "17841234567890123",
          "access_token_env": "FB_PAGE_ACCESS_TOKEN"
        }
      ],
      "options": {
        "include_telegram_footer": false
      }
    }
  ]
}
```

### Одновременно в Facebook и Instagram

```jsonc
{
  "id": "tg_to_meta",
  "source": { "network": "telegram", "chat_id": -1001234567890 },
  "destinations": [
    { "network": "facebook", "page_id": "123456789012345", "access_token_env": "FB_PAGE_ACCESS_TOKEN" },
    { "network": "instagram", "ig_user_id": "17841234567890123", "access_token_env": "FB_PAGE_ACCESS_TOKEN" }
  ]
}
```

---

## Что пересылается

| Тип сообщения | Результат в Instagram |
|---|---|
| Фото + текст | Публикация в ленте с подписью |
| Видео + текст | Reel с подписью |
| Только текст | **Пропускается** (IG не поддерживает текст без медиа) |
| Аудио, файлы | Пропускается |

---

## Ограничения Instagram Graph API

- Фото должно быть доступно по публичному URL (Telegram Bot API обеспечивает это для файлов ≤ 20 МБ)
- Видео > 20 МБ не пересылается (ограничение Telegram Bot API; MTProto-fallback для Instagram не реализован)
- Один аккаунт может публиковать не более 50 постов в сутки
- Карусели (несколько фото в одном посте) пока не поддерживаются бриджем

---

## Проверка

```bash
# Проверить подключение IG аккаунта
curl "https://graph.facebook.com/v21.0/IG_USER_ID?fields=username,name&access_token=PAGE_ACCESS_TOKEN"
```
