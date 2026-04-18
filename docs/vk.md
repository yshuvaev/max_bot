# Подключение VK как направления (destination)

Позволяет публиковать посты, фото и видео из Telegram на стену сообщества или профиля ВКонтакте.
Короткие вертикальные видео (≤ 60 сек) автоматически загружаются как **VK Клипы** (Reels).

---

## Требования

- Сообщество ВКонтакте (группа или публичная страница) или личный профиль
- VK API access token с правами `wall`, `video`, `photos`

---

## Шаг 1 — Создать VK приложение

1. Перейди на [vk.com/dev](https://vk.com/dev) → **Мои приложения → Создать приложение**.
2. Тип: **Standalone-приложение**.
3. Сохрани **ID приложения** (client_id).

---

## Шаг 2 — Получить Access Token

### Через браузер (самый простой способ)

Вставь в браузер (замени `CLIENT_ID` на ID своего приложения):

```
https://oauth.vk.com/authorize?client_id=CLIENT_ID&display=page&redirect_uri=https://oauth.vk.com/blank.html&scope=wall,video,photos,offline&response_type=token&v=5.199
```

После авторизации браузер перенаправит на URL вида:
```
https://oauth.vk.com/blank.html#access_token=vk1.a.XXXXXX&expires_in=0&user_id=12345
```

Скопируй значение `access_token`. Параметр `offline` в scope делает токен бессрочным.

### Для сообщества (community token)

1. В настройках сообщества → **Работа с API → Токены доступа → Создать токен**.
2. Выбери права: **Управление**, **Фотографии**, **Видеозаписи**.
3. Скопируй токен.

Community token предпочтительнее для автоматизации — он не зависит от конкретного пользователя.

---

## Шаг 3 — Узнать owner_id

**Для сообщества:** открой страницу сообщества, посмотри URL. Если `vk.com/club123456` → owner_id = **-123456** (отрицательный).
Или через API:
```bash
curl "https://api.vk.com/method/groups.getById?group_id=ИМЯ_ГРУППЫ&access_token=TOKEN&v=5.199"
# Поле "id" → owner_id будет -id
```

**Для личной стены:** owner_id = числовой ID профиля (положительный).
```bash
curl "https://api.vk.com/method/users.get?access_token=TOKEN&v=5.199"
# Поле "id"
```

---

## Шаг 4 — Настроить .env

```dotenv
VK_ACCESS_TOKEN=vk1.a.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## Шаг 5 — Добавить маршрут в routes.json

```jsonc
{
  "id": "tg_to_vk",
  "enabled": true,
  "source": {
    "network": "telegram",
    "chat_id": -1001234567890
  },
  "destinations": [
    {
      "network": "vk",
      "owner_id": -123456789,
      "access_token_env": "VK_ACCESS_TOKEN",
      "clips_max_duration_s": 60,
      "clips_for_vertical": true
    }
  ]
}
```

### Параметры

| Параметр | Тип | По умолчанию | Описание |
|---|---|---|---|
| `owner_id` | number | — | ID стены. Отрицательное = сообщество, положительное = профиль |
| `access_token_env` | string | — | Имя env-переменной с токеном (или `access_token` для inline) |
| `clips_max_duration_s` | number | `60` | Максимальная длительность для Клипа (секунды) |
| `clips_for_vertical` | boolean | `true` | Загружать как Клип только вертикальные видео (height > width) |

---

## Логика VK Клипов

Видео загружается как VK Клип (`is_reels=1`) если:
1. Длительность ≤ `clips_max_duration_s` (по умолчанию 60 сек)
2. Видео вертикальное: `height > width` (при `clips_for_vertical: true`)

Иначе загружается как обычное видео.

---

## Что пересылается

| Тип сообщения | Результат в VK |
|---|---|
| Только текст | Пост на стене |
| Фото + текст | Фото загружается, пост с вложением |
| Видео + текст | Видео/Клип загружается, пост с вложением |
| GIF/анимация | Видео с вложением |
| Аудио, файлы | Только текст (без вложения) |

---

## Ограничения

- Telegram Bot API: максимальный размер файла для скачивания — **20 МБ** (см. MTProto в README).
- VK API: максимальный размер видео — **256 МБ**, фото — **50 МБ**.
- Для публикации от имени сообщества токен должен быть community token или user token администратора.

---

## Проверка

```bash
# Проверить токен и получить info о стене
curl "https://api.vk.com/method/wall.get?owner_id=-ВАША_ГРУППА&count=1&access_token=VK_TOKEN&v=5.199"
```
