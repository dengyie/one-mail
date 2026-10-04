# Send Email API

## Send Email via HTTP API

There are two HTTP API endpoints for sending emails:

| Endpoint | Authentication | Use Case |
|----------|---------------|----------|
| `/api/send_mail` | `Authorization: Bearer <address_JWT>` header | Internal calls, requires cookie / header auth |
| `/external/api/send_mail` | `token` field in request body | External system integration, no header auth needed |

::: tip What is "Address JWT"?
The Address JWT is the `jwt` field returned when creating an email address via `/api/new_address` or `/admin/new_address`.
You can view it in the "Password" menu in the frontend UI. It is **NOT** the `JWT_SECRET` environment variable, nor the admin password.
:::

### Method 1: Header Authentication (`/api/send_mail`)

```python
send_body = {
    "from_name": "Sender Name",
    "to_name": "Recipient Name",
    "to_mail": "Recipient Address",
    "subject": "Email Subject",
    "is_html": False,  # Set whether it's HTML based on content
    "content": "<Email content: html or text>",
}

res = requests.post(
    "https://your_worker_domain/api/send_mail",
    json=send_body, headers={
        "Authorization": f"Bearer {address_JWT}",
        # "x-custom-auth": "<your_website_password>", # If private site password is enabled
        "Content-Type": "application/json"
    }
)
```

### Method 2: Body Token Authentication (`/external/api/send_mail`)

Suitable for external system calls, place the Address JWT in the `token` field of the request body:

```python
send_body = {
    "token": "<address_JWT>",
    "from_name": "Sender Name",
    "to_name": "Recipient Name",
    "to_mail": "Recipient Address",
    "subject": "Email Subject",
    "is_html": False,  # Set whether it's HTML based on content
    "content": "<Email content: html or text>",
}
res = requests.post(
    "https://your_worker_domain/external/api/send_mail",
    json=send_body, headers={
        # "x-custom-auth": "<your_website_password>", # If private site password is enabled
        "Content-Type": "application/json"
    }
)
```

## Client source header and sendbox filters

The web send workbench sends `x-one-mail-client: web`. The SMTP proxy sends `x-one-mail-client: smtp-proxy`. Any other value is ignored.

| Endpoint | Default `source` |
|----------|------------------|
| `POST /api/send_mail` + `web` | `user_ui` |
| `POST /api/send_mail` (no valid header) | `user_api` |
| `POST /external/api/send_mail` (no valid header) | `external_api` |
| `POST /external/api/send_mail` + `smtp-proxy` | `smtp_proxy` |

`GET /api/sendbox` and `GET /admin/sendbox` accept:

- `source`: comma-separated whitelist (`user_ui,user_api,external_api,smtp_proxy,admin,admin_binding,system_otp,unknown`)
- `q`: search subject or recipient, max 80 chars; `%` `_` `\` or control characters return empty results
- `from` / `to`: time range (epoch seconds or ISO)

Each row still includes `id,address,raw,created_at`, plus parsed `source`, `channel`, `to_mail`, `subject`, and `provider_message_id`. Older rows without `source` are shown as `unknown`. A successful Resend send stores `data.id` as `provider_message_id`.

Admin unknown deliveries (provider 503, reservation stuck at `dispatch_state=unknown`):

- `GET /admin/send_mail/unknown`: list unconfirmed outbound reservations
- `POST /admin/send_mail/unknown/:id/resolve`: body `{ "outcome": "sent" | "rejected" }`. `sent` keeps quota; `rejected` releases the reservation and refunds quota

## Send Email via SMTP

Please first refer to [Configure SMTP Proxy](/en/guide/feature/config-smtp-proxy.html).

This is a `python` example using the `smtplib` library to send emails.

`JWT Token Password`: This is the email login password, which can be viewed in the password menu in the UI interface.

```python
import smtplib

from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart


with smtplib.SMTP('localhost', 8025) as smtp:
    smtp.login("jwt", "Enter your JWT token password here")
    message = MIMEMultipart()
    message['From'] = "Me <me@mangoqwq.cc.cd>"
    message['To'] = "Admin <admin@mangoqwq.cc.cd>"
    message['Subject'] = "Test Subject"
    message.attach(MIMEText("Test Content", 'html'))
    smtp.sendmail("me@mangoqwq.cc.cd", "admin@mangoqwq.cc.cd", message.as_string())
```
