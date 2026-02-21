# راهنمای دیپلوی پروژه IPTV Worker

این پروژه یک **Cloudflare Worker** برای پراکسی HLS/IPTV است که شامل پنل مدیریت و ذخیره‌سازی کانال‌ها در **Cloudflare KV** می‌شود.

## پیش‌نیازها

- حساب Cloudflare
- Node.js نسخه 18 یا بالاتر
- ابزار Wrangler (CLI رسمی Cloudflare)

```bash
npm install -g wrangler
```

## 1) لاگین به Cloudflare

```bash
wrangler login
```

بعد از اجرای دستور، مرورگر باز می‌شود و باید وارد حساب Cloudflare شوید.

## 2) ساخت KV Namespace

کد از یک KV با بایندینگ `CHANNELS_KV` استفاده می‌کند. ابتدا namespace بسازید:

```bash
wrangler kv namespace create CHANNELS_KV
```

خروجی این دستور یک `id` می‌دهد. آن را برای مرحله بعد نگه دارید.

> اگر محیط Preview هم می‌خواهید:

```bash
wrangler kv namespace create CHANNELS_KV --preview
```

## 3) ساخت فایل پیکربندی `wrangler.toml`

در ریشه پروژه فایل `wrangler.toml` بسازید (یا مقادیر آن را با پروژه خود هماهنگ کنید):

```toml
name = "iptv-worker"
main = "worker.js"
compatibility_date = "2024-01-01"

[[kv_namespaces]]
binding = "CHANNELS_KV"
id = "YOUR_KV_NAMESPACE_ID"
# preview_id = "YOUR_PREVIEW_KV_NAMESPACE_ID"

[vars]
PROTECT_MODE = "all"
ADMIN_USER = "admin"
ADMIN_PASS = "changeme"
```

### توضیح متغیرها

- `CHANNELS_KV`: ذخیره‌سازی کانال‌ها
- `PROTECT_MODE`:
  - `all`: کل مسیرها نیاز به Basic Auth دارند
  - `admin`: فقط مسیرهای مدیریتی (admin/api/channels/watch)
- `ADMIN_USER` و `ADMIN_PASS`: اطلاعات ورود Basic Auth

## 4) (پیشنهادی) تنظیم مقادیر حساس به‌صورت Secret

برای اینکه پسورد در فایل متنی نماند، بهتر است متغیرهای حساس را secret کنید:

```bash
wrangler secret put ADMIN_USER
wrangler secret put ADMIN_PASS
```

در این حالت می‌توانید `ADMIN_USER` و `ADMIN_PASS` را از `[vars]` حذف کنید.

## 5) اجرای محلی برای تست

```bash
wrangler dev
```

آدرس محلی (معمولاً `http://127.0.0.1:8787`) در ترمینال نمایش داده می‌شود.

## 6) دیپلوی روی Cloudflare

```bash
wrangler deploy
```

پس از دیپلوی، URL نهایی Worker نمایش داده می‌شود.

## مسیرهای مهم بعد از دیپلوی

- `/watch` : صفحه پخش
- `/channels` : لیست لینک کانال‌ها
- `/admin` : پنل مدیریت کانال‌ها
- `/api/channels` : API مدیریت کانال‌ها

## نکته‌های عملیاتی

1. در اولین اجرا اگر KV خالی باشد، چند کانال نمونه به‌صورت خودکار Seed می‌شود.
2. برای امنیت واقعی، حتماً:
   - `ADMIN_PASS` قوی انتخاب کنید.
   - در صورت نیاز `PROTECT_MODE = "all"` بگذارید.
3. اگر Stream مبدا فیلتر User-Agent/Referer دارد، این Worker به‌صورت پیش‌فرض هدرهای مناسب upstream ارسال می‌کند.

## عیب‌یابی سریع

- **401 Unauthorized**
  - یوزرنیم/پسورد Basic Auth را بررسی کنید.
  - مطمئن شوید secret/vars درست ست شده‌اند.

- **Channel not found**
  - کانال با ID داده‌شده در KV وجود ندارد.
  - از `/admin` یا `/api/channels` لیست را بررسی کنید.

- **Upstream Error (4xx/5xx)**
  - URL منبع را چک کنید.
  - دسترسی منبع به IP/Region کلادفلر ممکن است محدود شده باشد.

---

اگر خواستید، می‌توانم در قدم بعد یک `wrangler.toml` واقعی با نام پروژه، environmentهای جداگانه (`staging`/`production`) و Route اختصاصی دامنه هم برایتان آماده کنم.
