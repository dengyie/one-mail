import time
import requests

from .config import Config


def upload_emails(config: Config, emails: list[dict], max_retries: int = 5) -> dict:
    url = f"{config.worker_base_url}/admin/unified/ingest"
    headers = {"x-admin-auth": config.admin_token, "Content-Type": "application/json"}
    delay = 1.0
    last = None
    for attempt in range(max_retries):
        try:
            r = requests.post(url, json={"emails": emails}, headers=headers, timeout=30)
            if r.status_code == 200:
                return r.json()
            last = f"HTTP {r.status_code}: {r.text[:200]}"
        except Exception as e:  # 网络错误
            last = str(e)
        if attempt < max_retries - 1:
            time.sleep(delay)
            delay = min(delay * 2, 30)
    raise RuntimeError(f"upload failed after {max_retries} attempts: {last}")